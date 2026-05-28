# LLD: Routing Executor Hardening and Multi-Intent Integration

**Feature Specs**:

- `docs/features/multi-agent-orchestration.md`
- `docs/features/multi-agent-session-management.md`
- `docs/features/nlu.md`

**HLDs**:

- `docs/specs/multi-agent-orchestration.hld.md`
- `docs/specs/multi-agent-session-management.hld.md`
- `docs/specs/nlu.hld.md`

**Test Specs**:

- `docs/testing/multi-agent-orchestration.md`
- `docs/testing/multi-agent-session-management.md`
- `docs/testing/nlu.md`

**Status**: DONE
**Date**: 2026-03-31

**Implementation Status**:

- Phase 1 — `d5bd6f13f` — sanitize child routing authority
- Phase 2 — `fa42dfae6` — centralize agent activation
- Phase 3a — `01485b222` — additive async fan-out contract
- Phase 3b — `19116dc44` — async fan-out execution
- Phase 4 — `9b4dd1bcd` — canonicalize multi-intent
- Phase 5 — `92f62414b` — close targeted regressions and align runtime docs

Post-implementation note:

- This plan shipped with focused runtime/execution verification per phase.
- The deterministic hardening regressions and targeted package builds were run during implementation; this post-implementation sync updates the artifact statuses and coverage inventory to match that shipped scope.

---

## 1. Problem Statement

`RoutingExecutor` currently owns too many responsibilities at once:

- routing capability derivation
- agent activation and child-session bootstrapping
- local and remote handoff/delegate execution
- synchronous and asynchronous fan-out
- multi-intent strategy resolution
- parent/child return handling
- trace emission and partial infra logging

That concentration has produced a set of correctness and architecture problems that all sit on the same execution seam:

1. Mixed local + remote async fan-out is internally inconsistent and currently broken.
2. Child execution contexts inherit stale routing state from the parent session.
3. Agent activation rewires only part of the execution surface, so tool calling and auth-profile propagation are inconsistent across handoff, delegate, and fan-out.
4. Multi-intent has two incompatible execution models:
   - classifier-driven short-circuit fan-out
   - `handleMultiIntent()` guided dispatch that does not reliably target or execute the same plan
5. Documentation still describes behavior that the runtime no longer exposes as the canonical path.

The design goal is not a large rewrite. The goal is a surgical, slice-by-slice hardening plan that:

- fixes the broken execution paths first
- reduces hidden mutable state
- extracts reusable orchestration helpers from `routing-executor.ts`
- gives multi-intent one canonical routing model
- adds regression coverage at unit, integration, and E2E layers
- improves traceability and structured logging without leaking auth material

---

## 2. Assumptions and Constraints

| ID  | Assumption / Constraint                                                                             | Why                                                                |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| A-1 | No DSL syntax change in the first implementation wave                                               | The current feature specs are stable; the defects are runtime-side |
| A-2 | Per-target routing tools (`handoff_to_X`, `delegate_to_X`) remain the canonical LLM tool surface    | Prompt builder and tests already enforce this                      |
| A-3 | The legacy `__fan_out__` path remains compatibility-only until all cached/older tool lists are gone | Reduces migration risk while allowing doc cleanup                  |
| A-4 | Existing orchestration and NLU feature specs are the source of truth over stale architecture prose  | The runtime currently diverges from some doc sections              |
| A-5 | Bug-fix slices must be independently shippable, buildable, and testable                             | User requested surgical execution                                  |
| A-6 | No tenant/project/user isolation rules are relaxed as part of this work                             | This is hardening work, not scope expansion                        |

---

## 3. Design Decisions

| #    | Decision                                                                                                                                           | Rationale                                                                                                                          | Alternatives Rejected                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| D-1  | Keep `RoutingExecutor` as the public orchestration facade, but extract state derivation and child-activation helpers into dedicated modules        | Preserves call sites while reducing complexity                                                                                     | Big-bang rewrite into a new orchestration engine                               |
| D-2  | Replace session-scoped mutable handoff authority with active-IR-derived routing capabilities                                                       | Eliminates stale `handoffReturnInfo` as an authority source                                                                        | Continue rebuilding mutable maps opportunistically                             |
| D-3  | Introduce one `AgentActivationContext` path for handoff, delegate, and fan-out children                                                            | LLM wiring, tool wiring, auth propagation, and trace metadata must stay in sync                                                    | Keep separate ad hoc activation logic in each path                             |
| D-4  | Model async fan-out explicitly with branch records and separate continuation types for branch callbacks vs parent resumption                       | Fixes the current resumption mismatch and makes barrier state observable                                                           | Continue overloading `fan_out_branch` for both branch and parent continuations |
| D-5  | Canonicalize multi-intent around a `ResolvedMultiIntentPlan` that preserves the executable target (`agent` or `flow_step`) plus human metadata     | Current code collapses executable targets to category/intent strings in some paths, and flow uses step targets rather than agents  | Keep `handleMultiIntent()` returning partially executable `fanOutTasks`        |
| D-6  | Keep per-target routing tools as the canonical LLM tool surface, but shadow batched supervisor routing behind a runtime flag for the first release | Aligns prompt-builder with orchestration semantics while avoiding an immediate behavior shift for all supervisor turns             | Reintroduce generic `__fan_out__` as the primary prompt surface                |
| D-7  | Wire auth-profile helpers into the hot path through the shared activation layer, but first adapt them behind a runtime-shaped auth context         | The existing helpers are conceptually useful, but their current `UserToken[]`-style inputs do not match runtime session/auth state | Continue duplicating auth logic in handoff/delegate/fan-out                    |
| D-8  | Keep `RoutingExecutor.handleMultiIntent()` as a compatibility facade that delegates to the new router during migration                             | Safer migration for existing callers in reasoning and flow paths                                                                   | Rewire all callers directly in one step                                        |
| D-9  | Async fan-out failure policy is partial-results-with-errors with one server-side parent synthesis; no automatic branch retries in wave one         | Matches the existing sync `FanOutResult` contract and avoids introducing new failure semantics during hardening                    | Strict fail-fast or implicit branch retries                                    |
| D-10 | Continuation ownership must be explicit: escalation stays on its dedicated resolution path; fan-out changes only fan-out continuations             | Prevents Phase 3 from accidentally mixing unrelated async boundaries                                                               | Broad refactor of every suspension type in one wave                            |
| D-11 | Update docs only after behavior is stabilized and covered by tests                                                                                 | Prevents the docs from getting ahead of runtime reality again                                                                      | Documentation-first without executable coverage                                |

---

### Continuation Ownership Map

| Continuation Type       | Producer / Use Case                       | Resume Owner / Path                                              | Plan Impact                        |
| ----------------------- | ----------------------------------------- | ---------------------------------------------------------------- | ---------------------------------- |
| `tool_result`           | Async tool execution                      | `ResumptionService.resume()`                                     | unchanged                          |
| `remote_handoff_result` | Remote A2A handoff/delegate return        | `ResumptionService.resume()`                                     | unchanged                          |
| `fan_out_branch`        | Legacy fan-out branch continuation        | `ResumptionService.resume()` legacy-compat path only             | deprecated producer after Phase 3b |
| `fan_out_remote_branch` | New remote fan-out branch callback        | `ResumptionService.resume()`                                     | new                                |
| `fan_out_parent_resume` | New parent fan-out aggregation resume     | `ResumptionService.resume()`                                     | new                                |
| `human_input`           | Human input / approval pause              | `ResumptionService.resume()`                                     | unchanged                          |
| `escalation`            | Escalated session waiting on human action | `EscalationResolutionHandler` via `POST /:id/escalation/resolve` | docs/boundary clarification only   |
| `human_agent_transfer`  | Reserved/dormant continuation type        | no active production resume path today                           | boundary clarification only        |

Boundary note:

- Phase 3 only changes fan-out continuations.
- Escalation resolution remains on its separate HTTP-driven resolution path.
- `human_agent_transfer` is not actively produced by the current runtime and is out of scope for this hardening wave.

## 4. Issue Deep Dives

### I-1. Async Fan-Out Lifecycle Is Broken

#### Conversation Example

User message:

`"Check my billing status and also track my shipment."`

Runtime shape:

- `Billing_Agent` is local
- `Shipping_Agent` is remote via A2A
- the classifier or supervisor decides the work should fan out in parallel

Expected behavior:

1. The runtime creates a branch for each task.
2. The local branch executes immediately.
3. The remote branch suspends and resumes later through the callback path.
4. The parent receives one aggregated result when the barrier completes.

Current behavior:

1. The local async branch builds a synthetic child session id but never registers a child session.
2. `executeMessage()` fails with `Session not found`.
3. The remote parent continuation is created with the same continuation type used for branch callbacks.
4. When the barrier completes, parent resumption is misrouted back through branch-completion logic instead of a parent-aggregation path.
5. Remote branches also do not create their own child thread record, so thread metadata and traceability are incomplete.

#### Current Code

Hot-path files:

- `apps/runtime/src/services/execution/routing-executor.ts`
- `apps/runtime/src/services/execution/resumption-service.ts`
- `packages/execution/src/fan-out-barrier.ts`
- `packages/execution/src/types.ts`

Current defects:

- `handleAsyncFanOut()` creates threads for local branches but does not create/register child sessions before calling `executeMessage()`.
- remote branch suspensions and the parent suspension both use `continuation.type = 'fan_out_branch'`.
- `resumeParentAfterFanOut()` resumes the parent with payload type `fan_out_branch_result`, but the dispatcher routes by suspension continuation type, not payload type.
- remote branches do not have an explicit branch thread record.

#### Resolution

Create an explicit async fan-out subsystem under `apps/runtime/src/services/execution/fanout/`:

- `async-fanout-coordinator.ts`
- `fanout-branch-state.ts`
- `fanout-trace.ts`

New execution model:

1. `handleFanOut()` remains the public entry point.
2. It builds a `FanOutExecutionContext` with one `BranchExecutionRecord` per branch.
3. Every agent branch, local or remote, gets:
   - `branchId`
   - `targetAgent`
   - `threadIndex`
   - `branchType: 'local_agent' | 'remote_agent' | 'tool'`
   - `status: 'pending' | 'executing' | 'completed' | 'failed' | 'timed_out'`
   - `childSessionId` for local branches
4. Local branches use the same child-activation helper as sync fan-out.
5. Remote branches create a waiting child thread before dispatch so topology and traces are preserved.
6. Add new continuation types in `packages/execution/src/types.ts`:
   - `fan_out_remote_branch`
   - `fan_out_parent_resume`
7. `ResumptionService` dispatches these separately:
   - branch callback -> `resumeFanOutRemoteBranch()`
   - parent resume -> `resumeFanOutParent()`
8. `resumeFanOutParent()` collects barrier results, formats them into the parent response contract, emits parent resume traces, and deletes the barrier exactly once.

Continuation compatibility rule:

- keep `fan_out_branch` as a read-only legacy compatibility type until old persisted suspensions age out
- do not emit new `fan_out_branch` suspensions from the hardening path

#### Concurrency Contract

Barrier completion must be idempotent per branch, not just atomic per write:

1. `completeBranch()` keys results by `branchId`, not only `branchAgent`.
2. A Redis Lua script atomically:
   - no-ops if the barrier is closed/cancelled/expired
   - no-ops if the branch is already terminal
   - stores the branch result/status
   - increments terminal branch count exactly once
   - flips a `parentResumeReady` marker exactly once when all branches are terminal
3. Parent resumption acquires the parent session lock before delivery; if the lock is unavailable, the parent suspension claim is released for retry.
4. Late remote callbacks after timeout/cancel are recorded as ignored late-arrivals and must not reopen the barrier or increment counts again.

#### Failure Policy

- Async fan-out aligns with the existing sync `FanOutResult` contract: partial results plus branch error metadata.
- The parent resumes when every branch reaches a terminal state or when the barrier timeout closes outstanding branches as `timed_out`.
- The merged response is synthesized server-side; clients do not merge branch payloads themselves.
- Automatic branch retry is explicitly out of scope for this wave.

#### Traceability and Logging

Add trace events:

- `fan_out_async_started`
- `fan_out_branch_registered`
- `fan_out_branch_dispatched`
- `fan_out_branch_callback_received`
- `fan_out_barrier_progress`
- `fan_out_parent_suspended`
- `fan_out_parent_resumed`

Required structured log fields:

- `sessionId`
- `executionId`
- `barrierId`
- `branchId`
- `targetAgent`
- `threadIndex`
- `continuationType`

Never log:

- tokens
- auth headers
- callback secrets
- raw remote auth config

#### Tests

New unit/integration/E2E coverage:

- `apps/runtime/src/__tests__/routing/async-fanout-coordinator.test.ts`
- `apps/runtime/src/__tests__/routing/async-fanout-resumption.test.ts`
- `apps/runtime/src/__tests__/multi-agent-fanout-barrier.integration.test.ts`
- `apps/runtime/src/__tests__/multi-agent-fanout-recovery.e2e.test.ts`
- `apps/runtime/src/__tests__/orchestration-fanout-bounded.e2e.test.ts`

---

### I-2. Child Execution Context Inherits Stale Routing Authority

#### Conversation Example

Conversation:

1. User: `"I need help logging in and then paying my bill."`
2. `Account_Router` hands off to `Auth_Agent`.
3. `Auth_Agent` has no declared handoffs of its own.
4. Later, during child execution, the model attempts to hand off directly to `Billing_Agent`.

Expected behavior:

- `Auth_Agent` should be blocked because it is not configured for handoffs.

Current behavior:

- the child session can inherit the parent session's `handoffReturnInfo`
- validation sees a non-empty map and treats the child as handoff-capable
- the child may be allowed to target agents it never declared

#### Current Code

Hot-path files:

- `packages/execution/src/child-session.ts`
- `apps/runtime/src/services/execution/prompt-builder.ts`
- `apps/runtime/src/services/execution/routing-executor.ts`
- `packages/compiler/src/platform/constructs/executors/handoff-executor.ts`

Current defects:

- `createChildSession()` shallow-copies the parent session, including control-plane fields that should not survive into child execution.
- prompt building mutates `session.handoffReturnInfo` as a side effect.
- some routing paths rebuild `handoffReturnInfo`, but the "no handoffs" path returns early without clearing it.
- handoff validation treats a non-empty session map as evidence of authorization.

#### Resolution

Create a pure routing-capability resolver:

- `apps/runtime/src/services/execution/routing-capabilities.ts`

Core API:

```ts
interface ActiveRoutingCapabilities {
  handoffTargets: Map<string, { returnExpected: boolean }>;
  delegateTargets: Set<string>;
}

function resolveActiveRoutingCapabilities(
  agentIR: AgentIR | null | undefined,
): ActiveRoutingCapabilities;
```

Behavior changes:

1. `prompt-builder.ts` stops mutating execution state.
2. `handleHandoff()`, `checkHandoffConditions()`, and `HandoffExecutor` use active-IR-derived capabilities as the source of truth.
3. `createChildSession()` is split into purpose-built factories instead of boolean flag combinations:
   - `createChildSessionForHandoff()`
   - `createChildSessionForDelegate()`
   - `createChildSessionForFanOut()`
4. Child session factories explicitly clear:
   - `handoffReturnInfo`
   - `intentQueue`
   - child-inappropriate waiting state from the parent
5. `handoffReturnInfo` stops being mutable authority. If retained, it is exposed only as a derived debug/read model.
6. `returnExpected` remains on the thread, where it belongs.

#### Traceability and Logging

Add trace events:

- `routing_capabilities_resolved`
- `handoff_authority_denied`

Add structured debug logs when a handoff is rejected because the active IR has no target match. Do not log user content beyond the existing trace/debug envelope.

#### Tests

New coverage:

- `packages/execution/src/__tests__/child-session.test.ts` additions for control-plane sanitization
- `apps/runtime/src/__tests__/routing/prompt-builder.test.ts` additions for the read-only contract
- `apps/runtime/src/__tests__/routing/routing-capabilities.test.ts`
- `apps/runtime/src/__tests__/routing/routing-conditions.test.ts` additions for "no handoffs clears stale authority"
- `apps/runtime/src/__tests__/sessions/session-security.test.ts` additions for stale target rejection
- `apps/runtime/src/__tests__/e2e/child-routing-authority.e2e.test.ts`

---

### I-3. Agent Activation Rewires Only Part Of The Execution Surface

#### Conversation Example

Conversation:

1. User: `"Please verify my account and then look up my latest invoice."`
2. `Supervisor_Agent` hands off to `Billing_Agent`.
3. `Billing_Agent` uses `lookup_customer` and `get_invoice`.
4. `Supervisor_Agent` also has a tool named `lookup_customer`, but it resolves through a different auth profile.

Expected behavior:

- once `Billing_Agent` becomes active, both the LLM client and the tool executor should be scoped to `Billing_Agent`
- per-user tokens and project-scoped auth profiles should resolve for the child agent

Current behavior:

- local handoff/delegate rewires the LLM client
- tool executor rewiring is inconsistent and may keep the parent's active-agent precedence
- auth-profile helper modules exist but are not wired into the runtime hot path

#### Current Code

Hot-path files:

- `apps/runtime/src/services/execution/routing-executor.ts`
- `apps/runtime/src/services/execution/llm-wiring.ts`
- `apps/runtime/src/services/execution/auth-profile-handoff.ts`
- `apps/runtime/src/services/execution/auth-profile-delegate.ts`
- `apps/runtime/src/services/execution/auth-profile-fanout.ts`

Current defects:

- handoff and delegate update top-level session agent fields and call `wireLLMClient()` only
- sync fan-out contains custom logic for tool executor wiring that does not apply to handoff/delegate
- auth-profile helper modules are effectively orphaned; the runtime does not use them to shape child execution
- the "preserve inherited toolExecutor" optimization in fan-out favors test convenience over active-agent correctness

#### Resolution

Create one shared activation helper:

- `apps/runtime/src/services/execution/agent-activation-context.ts`

Core API:

```ts
interface ActivationAuthContext {
  tenantId?: string;
  projectId?: string;
  userId?: string;
  authToken?: string;
  callerContext?: CallerContext;
  delegatedBy?: string[];
  branchCredentialCache?: Map<string, unknown>;
}

interface ActivateAgentExecutionParams {
  session: RuntimeSession;
  targetAgentName: string;
  targetIR: AgentIR;
  targetThread: AgentThread;
  authMode: 'handoff' | 'delegate' | 'fan_out';
  childSessionId?: string;
  authContext?: ActivationAuthContext;
}

async function activateAgentExecutionContext(params: ActivateAgentExecutionParams): Promise<void>;
```

Responsibilities:

1. update top-level session/thread pointers consistently
2. apply project runtime config to the target IR
3. wire LLM client
4. wire tool executor using the active agent, tenant, project, user, and auth token
5. normalize runtime session auth state into `ActivationAuthContext`
6. adapt auth-profile helper modules to the runtime auth shape:
   - handoff preflight validates compiled auth requirements using runtime/user/project context instead of raw `UserToken[]`
   - delegate auth context chains `delegatedBy` while preserving the originating user
   - fan-out auth context allocates per-branch credential caches
7. integrate the adapted helpers into the activation/orchestration path without redesigning the wider auth-profile resolver stack
8. emit one shared `agent_activation` trace event

Tool-executor policy:

- always rewire on agent activation
- if callers need custom wrappers/interceptors, wrap the newly wired executor instead of skipping rewiring
- pass the parent's `authToken` unless the path explicitly requires a different child token contract

#### Traceability and Logging

Add trace events:

- `agent_activation_started`
- `agent_activation_completed`
- `tool_executor_rewired`
- `auth_profile_context_built`
- `auth_profile_requirements_blocked`

Structured log fields:

- `sessionId`
- `fromAgent`
- `toAgent`
- `authMode`
- `tenantId`
- `projectId`
- `userId`

Never log:

- raw auth profile ids if they encode secrets
- tokens
- certificate material

#### Tests

New or expanded coverage:

- `apps/runtime/src/__tests__/execution/agent-activation-context.test.ts`
- `apps/runtime/src/__tests__/auth/auth-profile-propagation.test.ts` updated to use production helpers
- `apps/runtime/src/__tests__/llm-wiring.test.ts` additions for handoff/delegate rewiring
- `apps/runtime/src/__tests__/routing/routing-remote-handoff.test.ts`
- `apps/runtime/src/__tests__/fan-out.test.ts` updated to assert rewired child executors instead of inherited stale executors

---

### I-4. Multi-Intent Has Two Incompatible Execution Models

#### Conversation Example

Conversation:

`"Check my bill and track my shipment."`

Expected behavior:

- if both intents clearly target different supervisor children, the runtime should build one parallel plan and execute it
- if only one is strong enough, the runtime should queue or disambiguate according to configured strategy
- the same target mapping should be used whether the plan came from the classifier or from the LLM

Current behavior:

- high-confidence multi-intent short-circuit in the pipeline directly fans out and merges
- guided multi-intent goes through `bridgeToMultiIntentResult()` and `handleMultiIntent()`
- that bridge can convert classifier targets into category strings
- `handleParallelIntents()` then treats those category strings as agent names
- the reasoning path does not execute the returned `fanOutTasks`

User-visible symptom:

- one request gets answered and the second is silently ignored
- or the plan targets a non-agent string like `product_search`
- or the model is guided, but the runtime never executes the intended fan-out

#### Current Code

Hot-path files:

- `apps/runtime/src/services/pipeline/index.ts`
- `apps/runtime/src/services/pipeline/intent-bridge.ts`
- `apps/runtime/src/services/pipeline/tiered-resolver.ts`
- `apps/runtime/src/services/execution/reasoning-executor.ts`
- `apps/runtime/src/services/execution/routing-executor.ts`
- `apps/runtime/src/services/execution/flow-step-executor.ts`

Current defects:

- classifier output already contains `target` agent names
- `bridgeToMultiIntentResult()` sometimes collapses that target into an intent/category string
- `handleParallelIntents()` returns partially executable data instead of a fully resolved runtime plan
- prompt-builder says the canonical routing surface is per-agent tools, but architecture docs still describe generic `__fan_out__`

#### Resolution

Create a canonical multi-intent router:

- `apps/runtime/src/services/execution/multi-intent/multi-intent-router.ts`
- `apps/runtime/src/services/execution/multi-intent/multi-intent-types.ts`

Core types:

```ts
interface MultiIntentTarget {
  kind: 'agent' | 'flow_step';
  ref: string;
  label: string;
}

interface DetectedIntent {
  target: MultiIntentTarget | null;
  category: string | null;
  summary: string;
  confidence: number;
  source: 'pipeline' | 'reasoning' | 'flow';
}

interface ResolvedMultiIntentPlan {
  strategy: 'primary_queue' | 'sequential' | 'parallel' | 'disambiguate';
  primary: DetectedIntent;
  alternatives: DetectedIntent[];
  fanOutTasks?: FanOutTask[];
  queueEntries?: IntentQueueEntry[];
  disambiguationMessage?: string;
}
```

Behavior changes:

1. Preserve the executable target as the execution key at all times.
   - classifier/LLM routing uses `target.kind = 'agent'`
   - flow ON_INPUT routing uses `target.kind = 'flow_step'`
2. Keep `category` and summary as metadata for prompts, traces, queue UX, and analytics.
3. Replace `bridgeToMultiIntentResult()` with a target-preserving bridge or add a new bridge used by runtime execution.
4. `reasoning-executor.ts` uses the new router for both:
   - classifier-driven short-circuit parallel fan-out
   - guided multi-intent
5. `flow-step-executor.ts` keeps its existing ON_INPUT detection in wave one, but adapts matched step names into `DetectedIntent` records before delegating planning to the shared router.
6. `parallel` on supervisor with agent targets directly executes `handleFanOut()` and merge, rather than returning inert `fanOutTasks`.
7. `parallel` with flow-step targets is downgraded by strategy resolution because flow execution remains single-threaded.
8. `primary_queue` and `sequential` queue target-aware entries, not bare category strings.
9. `disambiguate` uses human-readable labels but stores the chosen executable target explicitly.
10. `RoutingExecutor.handleMultiIntent()` remains as a thin facade over the new router during migration so existing callers do not need a big-bang rewrite.

#### LLM Tool Surface Decision

Canonical behavior after hardening:

- per-target tools remain primary
- multiple `handoff_to_X` tool calls emitted in the same LLM turn are batched into one fan-out plan when the active agent is a supervisor and the targets are independent
- supervisor parallel routing batching is shadowed behind a runtime flag for the first release; the initial implementation also supports the existing parallel-call-to-`__fan_out__` normalization path
- `__fan_out__` remains a legacy compatibility fallback only

This preserves the better prompt ergonomics of per-target tools without giving up parallel orchestration semantics.

#### Traceability and Logging

Add trace events:

- `multi_intent_plan_built`
- `multi_intent_parallel_executed`
- `multi_intent_queue_seeded`
- `multi_intent_disambiguation_requested`
- `multi_intent_target_resolved`

Structured logs:

- `sessionId`
- `agentName`
- `strategy`
- `targets`
- `relationship`
- `source: 'pipeline' | 'reasoning' | 'flow'`

#### Tests

New or expanded coverage:

- `apps/runtime/src/__tests__/routing/multi-intent-router.test.ts`
- `apps/runtime/src/__tests__/routing/multi-intent-integration.test.ts`
- `apps/runtime/src/__tests__/routing/multi-intent-executor-integration.test.ts`
- `apps/runtime/src/__tests__/execution/reasoning-pipeline-bridge.test.ts`
- `apps/runtime/src/__tests__/orchestration-multi-intent.e2e.test.ts`
- `apps/runtime/src/__tests__/e2e/nlu-multi-intent-e2e.test.ts`

---

### I-5. Spec And Implementation Drift Hide The Real Runtime Contract

#### Conversation Example

Example author expectation from docs:

```abl
HANDOFF:
  - TO: External_Service_Agent
    WHEN: needs_external == true
    remote:
      service_url: "https://other-service.example.com"
      auth_header: "Bearer {{service_token}}"
```

Expected by the author:

- the remote schema in docs matches the runtime
- the multi-intent docs match the actual tool surface the supervisor sees

Current reality:

- the IR/runtime uses `remote.endpoint` and structured auth fields
- prompt builder intentionally does not generate generic `__fan_out__`
- several docs still describe generic `__fan_out__` as if it were primary

#### Current Code

Docs and runtime now drift in these places:

- `docs/architecture/llm-calls-and-tool-schemas.md`
- `docs/reference/ABL_SPEC.md`
- `apps/runtime/src/services/execution/prompt-builder.ts`
- `packages/compiler/src/platform/ir/schema.ts`

#### Resolution

Documentation becomes a dedicated final slice after runtime behavior is stabilized:

1. Update architecture docs to state that per-target routing tools are canonical.
2. Document `__fan_out__` as legacy-compat only.
3. Align remote handoff examples with `RemoteAgentLocation`.
4. Update orchestration and NLU testing docs to reflect the actual new test inventory and coverage status.

This slice is intentionally last because the goal is to document a proven runtime contract, not a transitional state.

#### Tests

Doc/test inventory closure only. No runtime behavior should change in this slice.

---

## 5. Target Module Boundaries

| Module                                | Responsibility                                                                                  | Depends On                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `routing-executor.ts`                 | Public orchestration facade and sequencing                                                      | all modules below                                              |
| `routing-capabilities.ts`             | Pure derivation of active handoff/delegate capabilities from IR                                 | `@abl/compiler` IR types                                       |
| `agent-activation-context.ts`         | Switch active agent, sync session pointers, wire LLM/tool executors, integrate auth propagation | `llm-wiring.ts`, auth-profile helpers                          |
| `fanout/async-fanout-coordinator.ts`  | Build branch records, dispatch local/remote branches, create parent suspension                  | `@agent-platform/execution`, A2A, resumption service contracts |
| `fanout/fanout-branch-state.ts`       | Branch ids, thread indexes, child session ids, barrier metadata                                 | runtime session/thread types                                   |
| `multi-intent/multi-intent-router.ts` | Build and optionally execute an execution-target-preserving multi-intent plan                   | `intent-queue.ts`, `routing-capabilities.ts`, `handleFanOut()` |
| `multi-intent/multi-intent-types.ts`  | Shared types for detected intents, executable targets, plans, and queue labels                  | no runtime deps                                                |
| `auth-profile-handoff.ts`             | Pre-transfer auth requirement checks                                                            | auth profile resolver inputs                                   |
| `auth-profile-delegate.ts`            | Delegate auth-chain construction                                                                | activation context                                             |
| `auth-profile-fanout.ts`              | Per-branch auth context creation                                                                | activation context                                             |

Guiding rule:

- extracted modules should be pure where possible
- side-effecting orchestration stays behind one facade
- prompt building must not mutate runtime authority state
- `fanout/` and `multi-intent/` are intentional subdirectories because each concern now spans multiple cohesive files; shared activation/routing helpers remain flat

---

## 6. File-Level Change Map

### New Files

| File                                                                      | Purpose                                                    | Risk   |
| ------------------------------------------------------------------------- | ---------------------------------------------------------- | ------ |
| `apps/runtime/src/services/execution/routing-capabilities.ts`             | Active-IR-derived handoff/delegate capability resolver     | Low    |
| `apps/runtime/src/services/execution/agent-activation-context.ts`         | Shared activation/wiring path for child agents             | Medium |
| `apps/runtime/src/services/execution/fanout/async-fanout-coordinator.ts`  | Async fan-out orchestration and suspension creation        | High   |
| `apps/runtime/src/services/execution/fanout/fanout-branch-state.ts`       | Branch record types/helpers                                | Medium |
| `apps/runtime/src/services/execution/multi-intent/multi-intent-router.ts` | Canonical execution-target-preserving multi-intent planner | High   |
| `apps/runtime/src/services/execution/multi-intent/multi-intent-types.ts`  | Shared multi-intent target/types                           | Low    |
| `apps/runtime/src/__tests__/routing/routing-capabilities.test.ts`         | Unit coverage for capability resolver                      | Low    |
| `apps/runtime/src/__tests__/execution/agent-activation-context.test.ts`   | Unit coverage for activation logic                         | Medium |
| `apps/runtime/src/__tests__/routing/async-fanout-coordinator.test.ts`     | Unit coverage for async fan-out                            | High   |
| `apps/runtime/src/__tests__/routing/multi-intent-router.test.ts`          | Unit coverage for plan building                            | Medium |
| `apps/runtime/src/__tests__/e2e/child-routing-authority.e2e.test.ts`      | E2E coverage for stale routing authority rejection         | Medium |

### Modified Files

| File                                                           | Change Description                                                                               | Risk   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------ |
| `apps/runtime/src/services/execution/routing-executor.ts`      | Shrink orchestration logic into helper calls, fix async fan-out and multi-intent execution paths | High   |
| `apps/runtime/src/services/execution/reasoning-executor.ts`    | Use canonical multi-intent router and batched routing tool plan                                  | High   |
| `apps/runtime/src/services/execution/flow-step-executor.ts`    | Reuse canonical multi-intent router via flow-target adapter for ON_INPUT multi-intent            | Medium |
| `apps/runtime/src/services/execution/prompt-builder.ts`        | Stop mutating session routing authority state and enforce read-only contract                     | Medium |
| `apps/runtime/src/services/execution/llm-wiring.ts`            | Support explicit active-agent tool rewiring and wrapper-friendly rebinding                       | Medium |
| `apps/runtime/src/services/execution/resumption-service.ts`    | Add explicit parent/branch fan-out continuation handlers                                         | High   |
| `packages/execution/src/child-session.ts`                      | Introduce purpose-built child-session factories and sanitization rules                           | Medium |
| `packages/execution/src/types.ts`                              | Add explicit async fan-out continuation types and compatibility notes                            | Medium |
| `packages/execution/src/fan-out-barrier.ts`                    | Define idempotent branch-completion and parent-resume contract                                   | Medium |
| `apps/runtime/src/services/execution/auth-profile-handoff.ts`  | Adapt to runtime auth context and integrate into production activation path                      | Medium |
| `apps/runtime/src/services/execution/auth-profile-delegate.ts` | Adapt to runtime auth context and integrate into production activation path                      | Medium |
| `apps/runtime/src/services/execution/auth-profile-fanout.ts`   | Adapt to runtime auth context and integrate into production activation path                      | Medium |
| `apps/runtime/src/__tests__/routing/prompt-builder.test.ts`    | Add read-only prompt-builder contract coverage                                                   | Low    |
| `docs/architecture/llm-calls-and-tool-schemas.md`              | Align tool-surface docs with runtime reality                                                     | Low    |
| `docs/reference/ABL_SPEC.md`                                   | Align remote handoff examples and runtime notes                                                  | Low    |
| `docs/testing/*.md`                                            | Update inventories and coverage matrices after implementation                                    | Low    |

---

## 7. Implementation Phases

### Phase 1: Remove Stale Routing Authority And Sanitize Child Sessions

**Goal**: Make the active agent's IR the only authority for handoff/delegate permissions and stop leaking parent routing state into child sessions.

**Tasks**:

1. Add `routing-capabilities.ts`.
2. Refactor `handleHandoff()` and `checkHandoffConditions()` to derive allowed targets from the active IR.
3. Refactor prompt builder so it no longer mutates `session.handoffReturnInfo`.
4. Replace generic child-session mutation flags with purpose-built child-session factories.
5. Add focused unit tests for stale authority rejection plus a prompt-builder read-only contract test.
6. Add one HTTP-level E2E proving a child agent cannot use inherited handoff authority.

**Files Touched**:

- `apps/runtime/src/services/execution/routing-capabilities.ts`
- `apps/runtime/src/services/execution/routing-executor.ts`
- `apps/runtime/src/services/execution/prompt-builder.ts`
- `packages/execution/src/child-session.ts`
- `apps/runtime/src/__tests__/routing/routing-conditions.test.ts`
- `apps/runtime/src/__tests__/routing/prompt-builder.test.ts`
- `packages/execution/src/__tests__/child-session.test.ts`
- `apps/runtime/src/__tests__/e2e/child-routing-authority.e2e.test.ts`

**Exit Criteria**:

- [x] A child session created from a supervisor no longer inherits handoff authority unless the child IR declares it
- [x] Prompt building is side-effect free with respect to routing authority
- [x] Child-session creation uses purpose-built sanitized factories, not ad hoc flag combinations
- [x] One HTTP-level E2E proves a child agent cannot hand off to an undeclared target
- [x] `pnpm --filter @agent-platform/execution build` succeeds
- [x] `pnpm --filter @agent-platform/runtime build` succeeds
- [x] New routing-capability and child-session tests pass

**Test Strategy**:

- Unit:
  - routing capability derivation
  - child-session sanitization
  - prompt-builder read-only contract
  - stale handoff rejection
- Integration:
  - existing session threading tests with new stale-state assertions
- E2E:
  - child cannot reuse inherited handoff authority through the public API

**Rollback**:

- Revert helper extraction and restore old capability derivation
- Keep tests that prove the stale-state bug for future reattempt

---

### Phase 2: Centralize Agent Activation, Tool Wiring, And Auth Propagation

**Goal**: Make handoff, delegate, and fan-out children all switch agent context through the same activation path.

**Tasks**:

1. Add `agent-activation-context.ts`.
2. Move child-agent session pointer sync and LLM/tool wiring into the helper.
3. Introduce `ActivationAuthContext` and adapt auth-profile helpers to the runtime session/auth shape before wiring them in.
4. Remove the "inherit stale parent executor" behavior from production paths.
5. Add tests for duplicate tool names and child-agent auth/profile resolution.

**Files Touched**:

- `apps/runtime/src/services/execution/agent-activation-context.ts`
- `apps/runtime/src/services/execution/routing-executor.ts`
- `apps/runtime/src/services/execution/llm-wiring.ts`
- `apps/runtime/src/services/execution/auth-profile-handoff.ts`
- `apps/runtime/src/services/execution/auth-profile-delegate.ts`
- `apps/runtime/src/services/execution/auth-profile-fanout.ts`
- `apps/runtime/src/__tests__/execution/agent-activation-context.test.ts`
- `apps/runtime/src/__tests__/llm-wiring.test.ts`
- `apps/runtime/src/__tests__/auth/auth-profile-propagation.test.ts`

**Exit Criteria**:

- [x] Local handoff rewires both LLM and tool executor for the target agent
- [x] Local delegate rewires both LLM and tool executor for the target agent
- [x] Fan-out children use branch-specific tool wiring with user/tenant/project context intact
- [x] Auth-profile helper modules are referenced from production orchestration code through the activation auth adapter
- [x] `pnpm --filter @agent-platform/runtime build` succeeds
- [x] All activation/wiring/auth propagation tests pass

**Test Strategy**:

- Unit:
  - activation helper state sync
  - tool-executor rewiring
  - runtime auth adapter + auth context builders
- Integration:
  - handoff/delegate execution with duplicate tool names
  - auth-profile-aware tool execution in child paths

**Rollback**:

- Keep the activation helper file but restore old call sites one by one
- Leave auth helper modules in place for later reintegration

---

### Phase 3a: Additive Async Fan-Out State And Continuation Contract

**Goal**: Land the new branch-state and continuation contract additively before changing behavior.

**Tasks**:

1. Add `fanout/async-fanout-coordinator.ts` and `fanout/fanout-branch-state.ts`.
2. Define `BranchExecutionRecord` with explicit terminal status tracking.
3. Add additive continuation types in `packages/execution`:
   - `fan_out_remote_branch`
   - `fan_out_parent_resume`
4. Preserve `fan_out_branch` as a legacy compatibility type, but stop using it from new producers.
5. Update `packages/execution/src/fan-out-barrier.ts` to define idempotent `completeBranch(branchId, result)` semantics and late-callback behavior.
6. Add unit tests for duplicate completion no-op behavior and continuation ownership mapping.

**Files Touched**:

- `apps/runtime/src/services/execution/fanout/async-fanout-coordinator.ts`
- `apps/runtime/src/services/execution/fanout/fanout-branch-state.ts`
- `packages/execution/src/types.ts`
- `packages/execution/src/fan-out-barrier.ts`
- `apps/runtime/src/__tests__/routing/async-fanout-coordinator.test.ts`
- `apps/runtime/src/__tests__/routing/async-fanout-resumption.test.ts`

**Exit Criteria**:

- [x] New fan-out continuation types exist without breaking existing suspension deserialization
- [x] Branch records expose terminal status transitions
- [x] Barrier completion contract is explicitly idempotent per branch
- [x] `pnpm --filter @agent-platform/execution build` succeeds
- [x] Additive async fan-out unit tests pass

**Test Strategy**:

- Unit:
  - branch status transitions
  - duplicate branch completion no-op
  - continuation ownership compatibility

**Rollback**:

- Remove additive types/files before routing call sites are rewired

---

### Phase 3b: Switch Async Fan-Out Execution To The New Contract

**Goal**: Make mixed local/remote fan-out executable, resumable, and traceable on top of the additive contract.

**Tasks**:

1. Wire `routing-executor.ts` to create/register local child sessions before async local execution.
2. Create waiting child thread records for remote branches before dispatch.
3. Refactor `ResumptionService` to separate remote branch resumption from parent aggregation.
4. Make the Redis barrier implementation idempotent in practice and single-fire parent resume.
5. Acquire the parent session lock before parent delivery and treat late callbacks after close as no-op trace events.
6. Align async branch failure handling with sync fan-out partial-results-with-errors behavior.
7. Add barrier progress traces, timeout coverage, and recovery tests.

**Files Touched**:

- `apps/runtime/src/services/execution/fanout/async-fanout-coordinator.ts`
- `apps/runtime/src/services/execution/fanout/fanout-branch-state.ts`
- `apps/runtime/src/services/execution/routing-executor.ts`
- `apps/runtime/src/services/execution/resumption-service.ts`
- `packages/execution/src/types.ts`
- `packages/execution/src/fan-out-barrier.ts`
- `packages/execution/src/redis-fan-out-barrier.ts`
- `apps/runtime/src/__tests__/routing/async-fanout-coordinator.test.ts`
- `apps/runtime/src/__tests__/routing/async-fanout-resumption.test.ts`

**Exit Criteria**:

- [x] A mixed local+remote fan-out no longer throws `Session not found`
- [x] Parent resumption is handled by a dedicated parent continuation type
- [x] Remote branches create traceable thread records before dispatch
- [x] Barrier completion triggers exactly one parent resume even under duplicate/near-simultaneous completions
- [x] Late callbacks after timeout/cancel do not reopen the barrier
- [x] Partial failures/timeouts are surfaced in the merged parent result
- [x] `pnpm --filter @agent-platform/execution build` succeeds
- [x] `pnpm --filter @agent-platform/runtime build` succeeds
- [x] Async fan-out unit and integration tests pass

**Test Strategy**:

- Unit:
  - local branch registration
  - remote branch suspension creation
  - parent continuation dispatch
- Integration:
  - Redis barrier duplicate completion race
  - parent lock contention during resume
  - timeout, partial-failure, and late-callback behavior
- E2E:
  - multi-agent fan-out recovery

**Rollback**:

- Preserve the new branch-state model behind the old public `handleFanOut()` signature
- Temporarily disable async fan-out v2 path if a production issue appears

---

### Phase 4: Canonicalize Multi-Intent Planning And Execution

**Goal**: Give classifier-driven, guided, and flow ON_INPUT multi-intent one execution-target-preserving plan.

**Tasks**:

1. Add `multi-intent/multi-intent-types.ts` and `multi-intent/multi-intent-router.ts`.
2. Preserve executable targets through the pipeline bridge and queue entries.
3. Refactor `reasoning-executor.ts` guided path to execute a real plan instead of returning inert `fanOutTasks`.
4. Refactor `flow-step-executor.ts` to adapt ON_INPUT branch matches into the shared multi-intent plan model.
5. Keep `RoutingExecutor.handleMultiIntent()` as a thin facade over the new router while callers migrate.
6. Batch multiple `handoff_to_X` tool calls from one LLM turn into one fan-out plan when eligible.
7. Keep supervisor batching behind a runtime flag for the first release.
8. Keep `__fan_out__` as compatibility fallback only.

**Files Touched**:

- `apps/runtime/src/services/execution/multi-intent/multi-intent-types.ts`
- `apps/runtime/src/services/execution/multi-intent/multi-intent-router.ts`
- `apps/runtime/src/services/pipeline/intent-bridge.ts`
- `apps/runtime/src/services/execution/reasoning-executor.ts`
- `apps/runtime/src/services/execution/flow-step-executor.ts`
- `apps/runtime/src/services/execution/routing-executor.ts`
- `apps/runtime/src/__tests__/routing/multi-intent-router.test.ts`
- `apps/runtime/src/__tests__/routing/multi-intent-integration.test.ts`
- `apps/runtime/src/__tests__/routing/multi-intent-executor-integration.test.ts`
- `apps/runtime/src/__tests__/execution/reasoning-pipeline-bridge.test.ts`

**Exit Criteria**:

- [x] `parallel` strategy uses executable targets, not category strings
- [x] guided multi-intent in reasoning mode executes the same plan model as short-circuit fan-out
- [x] flow ON_INPUT multi-intent feeds the same plan model without replacing its detector in wave one
- [x] queue/sequential/disambiguate store target-aware entries
- [x] batched `handoff_to_X` tool calls can form one parallel plan for supervisors when the rollout flag is enabled
- [x] `pnpm --filter @agent-platform/runtime build` succeeds
- [x] Multi-intent unit/integration suites pass

**Test Strategy**:

- Unit:
  - detected intent -> resolved plan
  - queue label vs executable-target preservation
  - flow-target adaptation
  - batched routing tool collation
- Integration:
  - reasoning path guided multi-intent
  - flow ON_INPUT multi-intent
  - classifier short-circuit and guided parity
- E2E:
  - supervisor multi-intent fan-out through WS/HTTP

**Rollback**:

- Keep `handleMultiIntent()` façade and route it back to prior behavior if needed while preserving the new types

---

### Phase 5: Regression Closure, Trace Contract, And Documentation Alignment

**Goal**: Finish the hardening work with end-to-end coverage and updated runtime contracts.

**Tasks**:

1. Add missing orchestration E2Es and NLU multi-intent E2Es.
2. Update testing guides with actual file inventory and status.
3. Update architecture docs for per-target routing tools and legacy `__fan_out__`.
4. Align remote handoff docs with runtime schema.
5. Run focused runtime/execution package regression after targeted package builds.

**Files Touched**:

- `docs/testing/multi-agent-orchestration.md`
- `docs/testing/multi-agent-session-management.md`
- `docs/testing/nlu.md`
- `docs/architecture/llm-calls-and-tool-schemas.md`
- `docs/reference/ABL_SPEC.md`
- new E2E test files under `apps/runtime/src/__tests__/`

**Exit Criteria**:

- [x] Targeted orchestration E2Es exist for async fan-out, multi-intent, and parent resume
- [x] Test inventories no longer list these critical scenarios as planned-only
- [x] Architecture docs match prompt-builder/runtime behavior
- [x] `pnpm --filter @agent-platform/execution build` succeeds
- [x] `pnpm --filter @agent-platform/runtime build` succeeds
- [x] Focused `@agent-platform/runtime` regression suites succeed
- [x] Focused `@agent-platform/execution` regression suites succeed

**Test Strategy**:

- Full package regression after targeted slice suites are green
- E2E scenarios cover both orchestration and NLU-triggered multi-intent

**Rollback**:

- Runtime behavior is already stabilized by prior phases
- This phase is mostly additive docs/tests and is low-risk

---

## 8. Wiring Checklist

- [x] `RoutingExecutor` calls new capability resolver instead of reading mutable handoff authority
- [x] `RoutingExecutor` uses the new activation helper for handoff, delegate, and fan-out children
- [x] `ResumptionService` handles new fan-out continuation types
- [x] `packages/execution/src/index.ts` exports any new async fan-out types if needed
- [x] `reasoning-executor.ts` and `flow-step-executor.ts` both call the canonical multi-intent router or its `RoutingExecutor` facade
- [x] prompt builder is pure and no longer mutates routing authority state
- [x] auth-profile helper modules are referenced from production orchestration paths
- [x] escalation/human-transfer continuation boundaries are documented and unchanged unless explicitly implemented
- [x] test index docs are updated after implementation

---

## 9. Cross-Phase Concerns

### Traceability

Every slice must add or preserve trace events for the execution path it changes. Do not replace traces with logs.

Minimum required trace outcomes by subsystem:

- handoff/delegate activation
- tool-executor rewiring
- async fan-out branch registration and parent resumption
- multi-intent plan creation and execution strategy
- auth-profile gating/propagation

### Logging

Use `createLogger(...)` consistently and keep logs infra-focused:

- failures
- unexpected state
- branch counts
- continuation mismatches
- auth gating summaries

Do not log:

- secrets
- tokens
- certs
- callback secrets
- raw user content beyond existing safe logging conventions

### Auth Profile Support

Hard requirements:

- child execution always receives the originating tenant/project/user context
- personal token resolution is preserved across handoff/delegate/fan-out
- branch auth caches are isolated in fan-out
- auth-profile helpers are not test-only utilities
- Phase 2 adapts helper inputs to runtime auth state; it does not redesign the wider auth-profile resolver stack

### Tool Calling Support

Hard requirements:

- tool resolution must follow the active agent after every activation
- duplicate tool names must prefer the active agent
- routing tool batching must not break legacy single-tool turns
- supervisor parallel routing batching is gated for the first release
- legacy `__fan_out__` support remains until cached tool lists are safely expired

### Performance

This hardening should not materially regress happy-path latency:

- capability resolution must stay pure/in-memory
- activation helper should reuse existing wiring primitives
- async fan-out adds bookkeeping but removes retries/failures from broken paths
- multi-intent planner should be pure and cheap; heavy work remains in classifier, fan-out, and merge

### No Data Migration

This plan does not require Mongo or Redis schema migrations. It changes runtime coordination behavior and documentation, not persisted data models. New continuation variants are additive, and legacy `fan_out_branch` remains readable during the transition window.

---

## 10. Regression Matrix

| Area                                        | Unit | Integration | E2E                        |
| ------------------------------------------- | ---- | ----------- | -------------------------- |
| Child session sanitization                  | yes  | yes         | yes                        |
| Handoff authority derivation                | yes  | yes         | yes                        |
| Tool executor rewiring                      | yes  | yes         | yes                        |
| Auth-profile propagation                    | yes  | yes         | yes                        |
| Prompt-builder read-only contract           | yes  | yes         | no                         |
| Async fan-out local branch registration     | yes  | yes         | yes                        |
| Async fan-out remote branch resumption      | yes  | yes         | yes                        |
| Barrier parent resume semantics             | yes  | yes         | yes                        |
| Barrier race / duplicate completion         | yes  | yes         | optional in first E2E wave |
| Multi-intent executable-target preservation | yes  | yes         | yes                        |
| Multi-intent guided path execution          | yes  | yes         | yes                        |
| Flow-target multi-intent adaptation         | yes  | yes         | yes                        |
| Batched routing tool calls                  | yes  | yes         | gated in first E2E wave    |
| Doc/tool surface parity                     | no   | no          | no                         |

---

## 11. Acceptance Criteria

- [x] Async fan-out works for local-only, remote-only, and mixed local+remote plans
- [x] Parent resume after async fan-out is explicit, traceable, and single-shot
- [x] Async fan-out barrier completion is idempotent per branch and safe under duplicate or near-simultaneous callbacks
- [x] Child execution cannot inherit unauthorized handoff authority from the parent
- [x] Active-agent tool execution is correct for handoff, delegate, and fan-out children
- [x] Auth-profile propagation helpers are wired into production orchestration paths
- [x] Multi-intent uses one canonical execution-target-preserving plan model across pipeline, reasoning, and flow execution
- [x] Flow ON_INPUT multi-intent converges at the planner layer without replacing its detector in wave one
- [x] Missing orchestration and NLU multi-intent E2E gaps are closed for the hardening scenarios
- [x] Documentation matches the actual runtime contract
- [x] Focused runtime/execution package builds and regressions succeeded for the shipped hardening slices

---

## 12. Recommended Execution Order

1. Phase 1 first because it removes hidden mutable state without changing the public orchestration API.
2. Phase 2 second because activation/wiring correctness is a prerequisite for fan-out and multi-intent confidence.
3. Phase 3a third because additive continuation/state scaffolding creates a low-risk checkpoint before behavior changes.
4. Phase 3b fourth because async fan-out is currently broken and needs the new contract wired end-to-end.
5. Phase 4 fifth because multi-intent should be rebuilt on top of the corrected fan-out and activation model.
6. Phase 5 last because docs and E2E inventories should describe the stabilized behavior, not the transitional state.

---

## 13. Decisions From Review

1. Batched `handoff_to_X` supervisor routing is shadowed behind a runtime flag for the first release.
2. Async fan-out parent resumption synthesizes server-side; clients do not merge branch payloads.
3. Mutable `session.handoffReturnInfo` assignment paths are removed. If retained, the field is derived/debug-only.

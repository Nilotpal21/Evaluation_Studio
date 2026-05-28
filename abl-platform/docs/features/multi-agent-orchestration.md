# Feature: Multi-Agent Orchestration

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: STABLE
**Feature Area(s)**: `agent lifecycle`, `integrations`, `observability`, `governance`
**Package(s)**: `apps/runtime`, `packages/compiler`, `packages/execution`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/multi-agent-orchestration.md](../testing/multi-agent-orchestration.md)
**Last Updated**: 2026-04-15

---

## 1. Introduction / Overview

### Problem Statement

Runtime agents need a consistent way to switch work between specialist agents, delegate bounded subtasks, fan work out in parallel, and return results without scattering control-flow logic across ad hoc tools and session mutations. Without a shared orchestration layer, agent-to-agent coordination becomes hard to author, hard to debug, and difficult to trace or govern.

### Goal Statement

Multi-Agent Orchestration translates compiled ABL coordination rules into deterministic runtime control flow so local handoff, delegation, fan-out, completion, and return-to-parent behavior all happen through one consistent execution surface with explicit tracing and policy checks.

### Summary

Multi-Agent Orchestration is the runtime coordination layer that turns compiled ABL coordination rules into agent-to-agent execution. It decides when an agent should hand work to another agent, delegate a bounded sub-task, fan work out in parallel, mark itself complete, or return control to a parent agent.

The feature is still centered on `RoutingExecutor`, but the highest-risk seams now run through extracted helpers instead of ad hoc session mutation. Active routing authority is derived from IR in `routing-capabilities.ts`, child-agent switching runs through `agent-activation-context.ts`, async callback/resume fan-out is coordinated through `fanout/`, and classifier/reasoning/flow multi-intent now converge on `multi-intent/`. The runtime still does not own A2A transport or human-agent delivery directly; it plugs those subsystems into one orchestration surface with a shared trace contract.

The key architectural boundary is that orchestration is about decisioning and execution flow, not storage. The session/thread container that holds agent activations is documented separately in [multi-agent-session-management.md](multi-agent-session-management.md). Remote protocol behavior lives in [a2a-integration.md](a2a-integration.md), and human handoff delivery lives in [agent-transfer.md](agent-transfer.md).

### Key Capabilities

- **Local handoff**: Switch control to another local agent with optional `RETURN: true`, thread creation/resume, and history strategy
- **Delegation**: Invoke a child agent as a subroutine with `INPUT`, `RETURNS`, `USE_RESULT`, and `ON_FAILURE` semantics
- **Fan-out / gather**: Dispatch agent and tool work in parallel with bounded concurrency via `CountingSemaphore`
- **Completion decisioning**: Evaluate completion rules (`CompletionDetector`) and return-to-parent behavior
- **Multi-intent dispatch**: Apply `primary_queue`, `disambiguate`, `parallel`, `sequential`, or `auto` routing strategies via `resolveStrategy()`
- **History and context transfer**: Apply `PASS`, `SUMMARY`, and history strategy rules (`none`, `summary_only`, `full`, `last_n`) before child execution
- **Guardrail-aware routing**: Evaluate handoff guardrails (including LLM-eval Tier 3) and session policy before transfer
- **Decision tracing**: Emit orchestration-specific trace events at verbosity-aware levels for switches, returns, fan-out branches, and conditions

---

## 2. Scope

### Goals

- Provide one runtime decisioning surface for local handoff, delegation, fan-out, completion, and return-to-parent flows through `RoutingExecutor`.
- Keep orchestration rules close to agent source by compiling ABL `COORDINATION:` blocks into Agent IR (`CoordinationConfig`).
- Make multi-agent routing observable through explicit trace events (`handoff`, `agent_switch`, `delegate_start`, `delegate_complete`, `fan_out_start`, `fan_out_complete`, `completion_check`, `return_to_parent`, `decision`).
- Enforce safety invariants: self-handoff rejection, cycle detection via `handoffStack`, max delegate depth (`MAX_DELEGATE_DEPTH = 10`), and concurrent fan-out guard via `_activeFanOutSessions`.

### Non-Goals (Out of Scope)

- Remote transport protocol behavior; remote execution details live in [a2a-integration.md](a2a-integration.md) and are consumed via `@agent-platform/a2a` package exports (`sendTask`, `sendTaskAsync`, `createA2AClient`).
- Underlying session/thread storage model; that lives in [multi-agent-session-management.md](multi-agent-session-management.md) and is accessed through helper functions (`getActiveThread`, `createThread`, `syncThreadToSession`, `tryThreadReturn`).
- Human-agent delivery channels; human escalation delivery lives in [agent-transfer.md](agent-transfer.md) and is accessed through `@agent-platform/agent-transfer`.

---

## 3. User Stories

1. As an **agent author**, I want to declare `HANDOFF`, `DELEGATE`, `COMPLETION`, and multi-intent rules in ABL so that specialist agents can collaborate without custom routing code.
2. As a **runtime operator**, I want orchestration decisions traced and guardrail-aware so that I can debug why control moved between agents and audit policy compliance.
3. As a **platform engineer**, I want fan-out and return-to-parent behavior to be bounded and deterministic so that multi-agent execution remains stable under load.
4. As an **agent author**, I want to specify `CONTEXT: { PASS: [...], SUMMARY: "...", HISTORY: full|last_n|summary_only|none }` on handoffs so that child agents receive the right amount of parent context.
5. As a **supervisor agent**, I want multi-intent dispatch to automatically fan out independent intents to sub-agents in parallel so that users get faster responses for multi-part requests.

---

## 4. Functional Requirements

1. **FR-1**: The system must interpret compiled coordination rules from Agent IR (`CoordinationConfig.handoffs`, `.delegates`, `.escalation`) and execute local handoff, delegation, fan-out, completion, and return-to-parent flows through `RoutingExecutor`.
2. **FR-2**: The system must support context passing (`PASS` fields, `SUMMARY` interpolation), history strategy handling (`none`, `summary_only`, `full`, `last_n`), and return mapping (`ON_RETURN.map`) between parent and child execution paths.
3. **FR-3**: The system must enforce guardrails (handoff-kind guardrails via `GuardrailPipeline`), session policy (via `getSessionPolicy`), cycle detection (via `handoffStack` and `delegateStack`), self-handoff rejection, max delegate depth (`MAX_DELEGATE_DEPTH = 10`), and timeout behavior before or during orchestration actions.
4. **FR-4**: The system must support multi-intent dispatch strategies (`primary_queue`, `disambiguate`, `parallel`, `sequential`, `auto`) resolved via `resolveStrategy()` based on agent execution type (`supervisor`, `scripted`, `reasoning`) and intent relationship (`independent`, `dependent`, `ambiguous`).
5. **FR-5**: The system must emit traceable decision and lifecycle events (`handoff`, `agent_switch`, `thread_resume`, `thread_return`, `handoff_timeout`, `delegate_start`, `delegate_complete`, `fan_out_start`, `fan_out_task_start`, `fan_out_complete`, `completion_check`, `return_to_parent`, `decision`) at verbosity-aware levels defined in `trace-helpers.ts`.
6. **FR-6**: The system must bound fan-out concurrency per pod via `CountingSemaphore` (configurable via `RuntimeExecutorConfig.maxConcurrentFanOutCalls`, default 10) and prevent concurrent fan-out from the same session via `_activeFanOutSessions` guard.
7. **FR-7**: The system must support remote handoff and delegation via A2A protocol (`sendTask`, `sendTaskAsync`), including SSRF validation (`assertUrlSafeForSSRF`), agent card caching (`AgentCardCache`), and outbound auth configuration.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                      |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------------ |
| Project lifecycle          | SECONDARY    | Project runtime config and coordination defaults influence orchestration behavior.         |
| Agent lifecycle            | PRIMARY      | Controls when active execution moves between agents and when child work runs.              |
| Customer experience        | SECONDARY    | End users experience the results indirectly through faster routing and specialist handoff. |
| Integrations / channels    | SECONDARY    | A2A and human escalation branches plug into this orchestration surface.                    |
| Observability / tracing    | PRIMARY      | Decision traces and thread lifecycle events are core to the feature.                       |
| Governance / controls      | SECONDARY    | Guardrail and session-policy checks influence transfer decisions.                          |
| Enterprise / compliance    | SECONDARY    | Deterministic routing and traceability matter for enterprise debugging and auditability.   |
| Admin / operator workflows | SECONDARY    | Operators inspect orchestration through session and trace tooling rather than a console.   |

### Related Feature Integration Matrix

| Related Feature                                                     | Relationship Type | Why It Matters                                                                    | Key Touchpoints                          | Current State                                            |
| ------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| [Multi-Agent Session Management](multi-agent-session-management.md) | shares data       | Orchestration mutates the thread/session container but does not own its storage.  | thread creation, resume, return, sync    | Active execution state is persisted through session APIs |
| [A2A Integration](a2a-integration.md)                               | extends           | Remote branches use A2A as the transport for non-local orchestration paths.       | remote handoff / delegate targets        | Integrated, protocol-specific coverage is separate       |
| [Agent Transfer](agent-transfer.md)                                 | extends           | Human escalation is one orchestration outcome, but delivery is handled elsewhere. | escalation routing, human handoff output | Integrated through the broader coordination surface      |
| [Guardrails](guardrails.md)                                         | depends on        | Handoff guardrails are evaluated via `GuardrailPipeline` before context transfer. | handoff-kind guardrail evaluation        | Integrated; LLM-eval tier supported                      |
| [Memory & Session Management](memory-sessions.md)                   | shares data       | Memory hooks fire around handoff/delegate/fan-out via `memory-integration.ts`.    | recall on agent enter, remember on exit  | Integrated via `executeRecallForAgentEvent`              |

---

## 6. Design Considerations (Optional)

- Decisioning is kept separate from storage so orchestration focuses on control flow while the session model stays reusable.
- Studio surfaces this feature mostly through observability and debugging (Observatory SpanTree, DebugTabs) rather than a dedicated orchestration console.
- The system favors explicit child execution plans, return stacks (`threadStack`), and trace events over implicit nested recursion.
- Remote handoff auto-registration from DSL config allows agents to declare remote targets inline without separate registry setup.

---

## 7. Technical Considerations (Optional)

- `RoutingExecutor` remains the orchestration facade, but active routing authority now comes from `routing-capabilities.ts` instead of mutable session state, and prompt building no longer mutates handoff authority.
- `agent-activation-context.ts` is the shared activation seam for handoff, delegate, and fan-out children. It keeps LLM wiring, tool wiring, auth propagation, and activation traces aligned.
- Async fan-out now uses explicit branch-state and continuation contracts in `fanout/` plus `packages/execution/src/fan-out-barrier.ts` / `redis-fan-out-barrier.ts`, which makes mixed local+remote callback/resume observable and idempotent.
- Multi-intent routing now preserves executable targets through `multi-intent/multi-intent-router.ts` and `multi-intent/multi-intent-types.ts`, so pipeline, reasoning, and flow execution share the same plan shape.
- Auth-profile helpers (`auth-profile-handoff.ts`, `auth-profile-delegate.ts`, `auth-profile-fanout.ts`) are production-path utilities, but they are invoked through the shared activation auth adapter rather than by ad hoc child-session wiring.
- Remote and human branches are intentionally delegated to `@agent-platform/a2a` and `@agent-platform/agent-transfer` so orchestration remains the decision surface, not the transport layer.
- The `HandoffExecutor`, `DelegateExecutor`, and `CompletionDetector` from `@abl/compiler` are still used for validation and condition evaluation, keeping rule evaluation logic in the compiler package.
- Intent queue (`intent-queue.ts`) still stores deferred intents for `primary_queue` and `sequential` strategies, but queue entries now preserve both display labels and executable targets.

---

## 8. How to Consume

### Studio UI

- Author `HANDOFF`, `DELEGATE`, `ESCALATION`, and `COMPLETION` blocks in the ABL editor
- Inspect orchestration decisions in Observatory trace views (`handoff`, `agent_switch`, `delegate_*`, `fan_out_*`, `thread_*`, `decision`)
- Use session detail views to confirm which agent is currently active through the `activeAgent` state

### API (Runtime)

There is no standalone orchestration endpoint. Coordination is triggered during normal session execution when the runtime processes a message and the active agent emits routing tools.

| Method | Path                                           | Purpose                                                                   |
| ------ | ---------------------------------------------- | ------------------------------------------------------------------------- |
| POST   | `/api/v1/chat/agent`                           | Execute an agent-backed chat turn; orchestration happens inside execution |
| GET    | `/api/projects/:projectId/sessions/:id`        | Inspect resulting session state after switches, fan-out, or completion    |
| GET    | `/api/projects/:projectId/sessions/:id/traces` | Inspect orchestration trace events and fan-out progress                   |
| WS     | `/ws`                                          | Stream orchestration events and response chunks in real time              |

### API (Studio)

| Method | Path                                           | Purpose                                            |
| ------ | ---------------------------------------------- | -------------------------------------------------- |
| GET    | `/api/projects/:projectId/sessions/:id/traces` | Fetch orchestration traces for debugging and audit |

### Admin Portal

There is no admin-only orchestration console. Coordination behavior is driven by agent source, project runtime config, and related subsystem configuration such as A2A connections and agent-transfer settings.

### Channel Integration

| Channel                  | Orchestration Support | Notes                                                                 |
| ------------------------ | --------------------- | --------------------------------------------------------------------- |
| Digital (REST / WS)      | Full                  | Core handoff, delegation, fan-out, and completion flows               |
| Voice                    | Full                  | Same orchestration engine, with voice-specific prompt and tool gating |
| A2A outbound / inbound   | Integrated            | Remote branches use the A2A feature surface                           |
| Human escalation routing | Integrated            | Human delivery uses the Agent Transfer feature surface                |

---

## 9. Data Model

### Coordination IR

Multi-agent orchestration does not introduce its own MongoDB collection. Its primary configuration surface is compiled Agent IR.

```text
CoordinationConfig (packages/compiler/src/platform/ir/schema.ts)
  handoffs: HandoffConfig[]
  delegates: DelegateConfig[]
  escalation?: EscalationConfig

HandoffConfig
  to: string
  when: string
  context: {
    pass: ResolvedPassField[]        // { name, type, description? }
    summary: string
    grant_memory?: string[]
    history?: HistoryStrategy         // 'none' | 'summary_only' | 'full' | { last_n: number }
  }
  return: boolean
  on_return?: string | HandoffReturnMapping   // { action?, map? }
  remote?: RemoteAgentLocation
  timeout?: string
  on_timeout?: string
  async?: boolean
  asyncTimeout?: number

DelegateConfig
  agent: string
  when: string
  purpose: string
  input: Record<string, string>
  returns: Record<string, string>
  use_result: string
  timeout?: string
  on_failure: 'continue' | 'escalate' | 'respond'
  failure_message?: string
  remote?: RemoteAgentLocation

EscalationConfig
  triggers: EscalationTrigger[]       // { when, reason, priority, tags? }
  context_for_human: string[]
  on_human_complete: OnHumanComplete[] // { condition, action }
  routing?: EscalationRouting          // { connection, queue?, skills?, priority? }

CompletionConfig (separate IR section)
  conditions: CompletionCondition[]    // { when, respond?, voice_config?, actions?, store? }

RoutingConfig (supervisor-specific)
  rules: RoutingRule[]                 // { to, when, description, priority, return? }
```

### Runtime Session Thread Model

```text
AgentThread (apps/runtime/src/services/execution/types.ts)
  agentName: string
  agentIR: AgentIR | null
  conversationHistory: Array<{ role, content }>
  state: RuntimeState
  data: SessionDataStore               // { values, gatheredKeys }
  status: 'active' | 'waiting' | 'completed' | 'escalated' | 'suspended' | 'human_agent'
  handoffFrom?: string
  handoffContext?: Record<string, unknown>
  returnExpected: boolean
  handoffStartedAt?: number
  handoffTimeoutMs?: number
  handoffTimeoutAction?: string

RuntimeSession (orchestration-relevant fields)
  threads: AgentThread[]
  activeThreadIndex: number
  threadStack: number[]                // indices for return-type handoffs
  handoffStack: string[]               // cycle detection
  delegateStack: string[]              // delegate depth/cycle detection
  handoffReturnInfo?: Record<string, boolean> // derived/debug-only; not an authority source
  intentQueue?: IntentQueue
  _pinnedIntent?: string
```

### Key Relationships

- The compiler emits `CoordinationConfig` into Agent IR in `packages/compiler`
- `RoutingExecutor` interprets that config against the active `RuntimeSession`
- Runtime session/thread state is stored separately ([multi-agent-session-management.md](multi-agent-session-management.md))
- Remote execution branches use the A2A package ([a2a-integration.md](a2a-integration.md))
- Human escalation delivery uses `@agent-platform/agent-transfer` ([agent-transfer.md](agent-transfer.md))

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                      | Purpose                                                                                                 |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/execution/routing-executor.ts`                 | Public orchestration facade for handoff, delegate, fan-out, escalation, completion, and returns         |
| `apps/runtime/src/services/execution/agent-activation-context.ts`         | Canonical child-agent activation seam for LLM/tool wiring, auth propagation, and traces                 |
| `apps/runtime/src/services/execution/routing-capabilities.ts`             | Pure IR-derived routing authority resolver                                                              |
| `apps/runtime/src/services/execution/fanout/async-fanout-coordinator.ts`  | Async fan-out branch and parent-resume contract builder                                                 |
| `apps/runtime/src/services/execution/fanout/fanout-branch-state.ts`       | Branch execution records and terminal status transitions                                                |
| `apps/runtime/src/services/execution/fanout/fanout-results.ts`            | Async branch-result aggregation and thread result storage                                               |
| `apps/runtime/src/services/execution/multi-intent/multi-intent-router.ts` | Canonical multi-intent plan builder and dispatcher helpers                                              |
| `apps/runtime/src/services/execution/multi-intent/multi-intent-types.ts`  | Target-preserving multi-intent types and config resolution                                              |
| `apps/runtime/src/services/execution/types.ts`                            | Shared runtime types: `RuntimeSession`, `AgentThread`, `FanOutTask`, `ExecutorContext`                  |
| `packages/compiler/src/platform/ir/schema.ts`                             | IR schema: `CoordinationConfig`, `HandoffConfig`, `DelegateConfig`, `CompletionConfig`, `RoutingConfig` |
| `packages/execution/src/child-session.ts`                                 | Purpose-built child-session factories for handoff, delegate, and fan-out                                |
| `packages/execution/src/fan-out-barrier.ts`                               | Fan-out barrier contract and idempotent completion semantics                                            |
| `packages/execution/src/redis-fan-out-barrier.ts`                         | Redis-backed barrier implementation with duplicate-completion protection                                |

### Orchestration Sub-Modules

| File                                                           | Purpose                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `apps/runtime/src/services/execution/auth-profile-handoff.ts`  | Builds handoff auth context through the shared activation adapter                    |
| `apps/runtime/src/services/execution/auth-profile-delegate.ts` | Extends delegate auth chains across nested child execution                           |
| `apps/runtime/src/services/execution/auth-profile-fanout.ts`   | Creates per-branch auth context and isolated credential caches for fan-out           |
| `apps/runtime/src/services/execution/multi-intent-strategy.ts` | Resolves effective multi-intent strategy by agent type and relationship              |
| `apps/runtime/src/services/execution/intent-queue.ts`          | Stores deferred intents for queued or sequential follow-up handling                  |
| `apps/runtime/src/services/execution/trace-helpers.ts`         | Emits decision traces with verbosity-aware payloads (minimal/standard/verbose/debug) |
| `apps/runtime/src/services/execution/memory-integration.ts`    | Triggers memory lifecycle hooks around handoff, delegate, and fan-out execution      |
| `apps/runtime/src/services/execution/session-policy.ts`        | Loads session policy for guardrail and coordination defaults                         |

### Routes / Handlers

| File                                    | Purpose                                                  |
| --------------------------------------- | -------------------------------------------------------- |
| `apps/runtime/src/routes/chat.ts`       | Main REST entry point that triggers orchestration        |
| `apps/runtime/src/routes/sessions.ts`   | Session detail and session message routes                |
| `apps/runtime/src/websocket/handler.ts` | WebSocket execution path with orchestration trace output |

### UI Components

| File                                                   | Purpose                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| `apps/studio/src/components/observatory/SpanTree.tsx`  | Renders orchestration spans and event hierarchies           |
| `apps/studio/src/components/observatory/DebugTabs.tsx` | Surfaces decision traces and debug detail for route changes |

### Tests

| File                                                                                 | Type        | Coverage Focus                                                                           |
| ------------------------------------------------------------------------------------ | ----------- | ---------------------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/routing/routing-capabilities.test.ts`                    | unit        | IR-derived handoff/delegate authority                                                    |
| `apps/runtime/src/__tests__/execution/agent-activation-context.test.ts`              | unit        | Child activation, auth propagation, LLM/tool rewiring                                    |
| `apps/runtime/src/__tests__/routing/async-fanout-coordinator.test.ts`                | unit        | Branch registration and continuation contract                                            |
| `apps/runtime/src/__tests__/routing/async-fanout-execution.test.ts`                  | integration | Mixed local + remote async fan-out execution                                             |
| `apps/runtime/src/__tests__/routing/async-fanout-resumption.test.ts`                 | integration | Parent resume, duplicate callbacks, timeout behavior                                     |
| `apps/runtime/src/__tests__/routing/multi-intent-router.test.ts`                     | unit        | Canonical multi-intent plan creation and target preservation                             |
| `apps/runtime/src/__tests__/routing/multi-intent-integration.test.ts`                | integration | Shared multi-intent planning and queue semantics                                         |
| `apps/runtime/src/__tests__/routing/multi-intent-executor-integration.test.ts`       | integration | Reasoning/flow/router execution parity                                                   |
| `apps/runtime/src/__tests__/routing/multi-intent-dispatch-wiring.test.ts`            | unit        | Multi-intent dispatch wiring and target resolution                                       |
| `apps/runtime/src/__tests__/routing/multi-intent-strategy.test.ts`                   | unit        | Strategy resolution by agent type and intent relationship                                |
| `apps/runtime/src/__tests__/execution/reasoning-pipeline-bridge.test.ts`             | integration | Guided pipeline signals feeding shared multi-intent execution                            |
| `apps/runtime/src/__tests__/execution/reasoning-pipeline-contract.test.ts`           | integration | Reasoning pipeline contract validation                                                   |
| `apps/runtime/src/__tests__/execution/thread-resume-integration.test.ts`             | integration | Full round-trip resume of a previously waiting child                                     |
| `apps/runtime/src/__tests__/execution/thread-resume.test.ts`                         | unit        | Return-to-parent tool and resume helpers                                                 |
| `apps/runtime/src/__tests__/execution/reasoning-gather-handoff.test.ts`              | integration | Reasoning + gather + handoff flow                                                        |
| `apps/runtime/src/__tests__/execution/handoff-resume-intent.test.ts`                 | integration | Handoff resume with intent context                                                       |
| `apps/runtime/src/__tests__/execution/handoff-return-propagation-regression.test.ts` | unit        | Return propagation regression guard                                                      |
| `apps/runtime/src/__tests__/execution/project-config-handoff.test.ts`                | integration | Project config influence on handoff behavior                                             |
| `apps/runtime/src/__tests__/execution/scripted-mode-handoff-fix.unit.test.ts`        | unit        | Scripted-mode handoff edge case fix                                                      |
| `apps/runtime/src/__tests__/execution/runtime-completion.test.ts`                    | unit        | Runtime completion detection                                                             |
| `apps/runtime/src/__tests__/routing/routing-delegate-failures.test.ts`               | unit        | Delegate guards, timeout, mapping, and `ON_FAILURE` paths                                |
| `apps/runtime/src/__tests__/routing/delegate-field-hints.test.ts`                    | unit        | Delegate field hint resolution                                                           |
| `apps/runtime/src/__tests__/routing/delegate-safety.test.ts`                         | unit        | Delegate safety invariants and depth guards                                              |
| `apps/runtime/src/__tests__/routing/routing-fanout-failures.test.ts`                 | unit        | Fan-out cleanup, dedupe, timeouts, and concurrent guard                                  |
| `apps/runtime/src/__tests__/routing/fan-out-bug-fixes.test.ts`                       | unit        | Fan-out bug-fix regression guards                                                        |
| `apps/runtime/src/__tests__/routing/fan-out-parallel.test.ts`                        | unit        | Parallel fan-out dispatch and result aggregation                                         |
| `apps/runtime/src/__tests__/fan-out.test.ts`                                         | unit        | Core fan-out mechanics                                                                   |
| `apps/runtime/src/__tests__/routing/routing-conditions.test.ts`                      | unit        | Handoff and completion condition evaluation                                              |
| `apps/runtime/src/__tests__/routing/routing-executor-unit.test.ts`                   | unit        | Helper coverage for timeout parsing, mapping, and completion                             |
| `apps/runtime/src/__tests__/routing/routing-executor-helpers.test.ts`                | unit        | Routing executor helper functions                                                        |
| `apps/runtime/src/__tests__/routing/routing-executor-metadata-propagation.test.ts`   | unit        | Metadata propagation across handoff boundaries                                           |
| `apps/runtime/src/__tests__/routing/routing-executor-multi-intent.test.ts`           | unit        | Multi-intent config precedence and routing facade behavior                               |
| `apps/runtime/src/__tests__/routing/routing-remote-handoff.test.ts`                  | unit        | Remote handoff target resolution and dispatch                                            |
| `apps/runtime/src/__tests__/execution/guardrails/handoff-rails.test.ts`              | unit        | Handoff guardrail evaluation pipeline                                                    |
| `apps/runtime/src/services/execution/__tests__/handoff-guardrail-llmeval.test.ts`    | unit        | Guardrail block/mutate/fail-open for LLM-eval tier                                       |
| `apps/runtime/src/__tests__/on-input-multi-intent-invariant.test.ts`                 | unit        | On-input multi-intent invariant checks                                                   |
| `apps/runtime/src/__tests__/pipeline-routing-resolver.test.ts`                       | unit        | Pipeline routing resolver                                                                |
| `apps/runtime/src/__tests__/execution/pre-refactor/completion-conditions.test.ts`    | unit        | Completion condition evaluation (pre-refactor)                                           |
| `apps/runtime/src/__tests__/execution/pre-refactor/completion-delegation.test.ts`    | unit        | Completion delegation flow (pre-refactor)                                                |
| `apps/runtime/src/__tests__/execution/pre-refactor/completion-detection.test.ts`     | unit        | Completion detection logic (pre-refactor)                                                |
| `apps/runtime/src/__tests__/execution/pre-refactor/handoff-delegate-fanout.test.ts`  | unit        | Handoff + delegate + fan-out combined paths (pre-refactor)                               |
| `apps/runtime/src/__tests__/execution/pre-refactor/handoff-delegation.test.ts`       | unit        | Handoff to delegation flow (pre-refactor)                                                |
| `packages/execution/src/__tests__/child-session.test.ts`                             | unit        | Child-session factories for handoff, delegate, fan-out                                   |
| `packages/execution/src/__tests__/fan-out-barrier-contract.test.ts`                  | unit        | Fan-out barrier contract and idempotent completion                                       |
| `packages/execution/src/__tests__/in-memory-fan-out-barrier.test.ts`                 | unit        | In-memory barrier implementation                                                         |
| `packages/execution/src/__tests__/redis-fan-out-barrier.test.ts`                     | unit        | Redis barrier with duplicate-completion protection                                       |
| `apps/runtime/src/__tests__/multi-agent-orchestration.e2e.test.ts`                   | e2e         | Full orchestration E2E: handoff/return/PASS/MAP, thread mgmt, fan-out, delegation chains |
| `apps/runtime/src/__tests__/e2e/child-routing-authority.e2e.test.ts`                 | e2e         | Child agents cannot reuse inherited handoff authority                                    |
| `apps/runtime/src/__tests__/e2e/routing-phase5.e2e.test.ts`                          | e2e         | `RETURN:true` round-trip, guided parallel multi-intent, mixed async fan-out              |
| `apps/runtime/src/__tests__/traveldesk-supervisor-ws-flow.e2e.test.ts`               | e2e         | Real-provider supervisor routing flow (env-gated)                                        |

---

## 11. Configuration

### Environment Variables

| Variable | Default | Description                                                                                                                                                                        |
| -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N/A      | N/A     | No dedicated env mapping exists for orchestration-only knobs; effective controls are in-code constants and `RuntimeExecutorConfig` fields with code defaults of `10` and `30 days` |

### Runtime Configuration

- `RuntimeExecutorConfig.maxConcurrentFanOutCalls` — caps fan-out concurrency per pod (default: 10, via `DEFAULT_MAX_CONCURRENT_FAN_OUT_CALLS`)
- `RuntimeExecutorConfig.timeoutMs` — supplies default delegate and child execution timeouts
- `RuntimeExecutorConfig.maxAsyncTimeoutSec` — caps suspended remote orchestration duration
- `project_runtime_config.multi_intent` — controls platform and project defaults for multi-intent routing
- `project_runtime_config.pipeline.intentBridge` — guides classifier-to-router thresholding for programmatic vs guided multi-intent behavior
- `coordination_defaults.defaultHistoryStrategy` — project-level fallback when a handoff has no explicit history strategy
- `MULTI_INTENT_PLATFORM_DEFAULTS` — platform-level defaults: `{ enabled: true, strategy: 'primary_queue', max_intents: 3, confidence_threshold: 0.6, queue_max_age_ms: 600_000 }`
- `features.allowParallelToolCalls` + `features.batchSupervisorRoutingToolCalls` — jointly gate collation of multiple supervisor routing tool calls into one batched fan-out plan

### DSL / Agent IR / Schema

```yaml
AGENT supervisor
  COORDINATION:
    HANDOFF:
      TO: billing_agent
      WHEN: intent == "billing"
      CONTEXT:
        PASS: [customer_id, issue_summary]
        SUMMARY: "Billing issue for {{customer_id}}"
        HISTORY: full
      RETURN: true
      ON_RETURN:
        MAP:
          resolution: billing_resolution

    DELEGATE:
      AGENT: account_lookup
      PURPOSE: "Fetch account status"
      INPUT:
        account_id: customer_id
      RETURNS:
        status: account_status
      USE_RESULT: lookup_result
      TIMEOUT: 10s
      ON_FAILURE: continue

  COMPLETION:
    CONDITIONS:
      - WHEN: issue_resolved == true
        RESPOND: "Resolved."
```

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| Project isolation | Project runtime config and session state remain scoped to the active project during orchestration.    |
| Tenant isolation  | Session and related execution state remain tenant-scoped even when work moves across child threads.   |
| User isolation    | User and caller context remain attached to the active session so child execution does not leak scope. |

### Security & Compliance

- Handoff and delegate cycle detection (`handoffStack`, `delegateStack`) and max depth (`MAX_DELEGATE_DEPTH = 10`) protect against runaway recursion and control-flow abuse.
- Auth context is forwarded through child execution chains via `agent-activation-context.ts` plus the auth-profile helpers, instead of each path reconstructing credentials ad hoc.
- Guardrail and session-policy checks can block or mutate handoff context before transfer (fail-open on guardrail errors to avoid blocking legitimate handoffs).
- SSRF validation via `assertUrlSafeForSSRF` on remote agent endpoint registration.
- Agent card caching (`AgentCardCache`) has 5-minute TTL and max 100 entries.

### Performance & Scalability

- Fan-out execution is bounded by a pod-level `CountingSemaphore` (default capacity: 10).
- Concurrent fan-out guard (`_activeFanOutSessions`) prevents overlapping fan-out from the same parent session.
- Child execution is isolated into explicit `ExecutionPlan` units rather than ad-hoc recursion.
- Project-level config is cached on the session (`_projectRuntimeConfig`) and reapplied across IR switches.
- Orchestration is stateless apart from the runtime session it mutates.
- `ExecutionCoordinator` supports serial, preemptive, and parallel concurrency strategies per session.

### Reliability & Failure Modes

- Delegate timeout stops the parent wait path, but detached child work may continue until downstream systems honor cancellation (`GAP-004`).
- Self-handoff rejection and cycle detection prevent infinite loops.
- Fan-out cleanup is exercised in dedicated unit suites (finally-block cleanup, guard release, child state pruning).
- Remote and human branches rely on subsystem-specific health and failure handling once orchestration dispatches them.
- `ON_FAILURE` strategies (`continue`, `escalate`, `respond`) provide explicit recovery paths for delegation failures.

### Observability

- Decision traces record why a route or completion action was chosen via `emitDecisionEvent` in `trace-helpers.ts`.
- Agent switch and thread lifecycle events make multi-agent flows reconstructable in Observatory.
- Trace verbosity levels (minimal/standard/verbose/debug) control event volume.
- Related remote or human events are emitted by the A2A and Agent Transfer subsystems.

### Data Lifecycle

- Orchestration-specific state is persisted through the shared runtime session container rather than a dedicated collection.
- Return stacks (`threadStack`), thread status, and context mappings live only as long as the parent session requires them.
- Intent queue entries are subject to `queue_max_age_ms` (default: 600,000 ms / 10 minutes) TTL.

---

## 13. Remaining Follow-Ups

1. Expand the live orchestration matrix beyond the hardening regressions
   1.1 Add deterministic HTTP E2Es for `primary_queue`, `sequential`, and `disambiguate` multi-intent strategies.
   1.2 Add a dedicated history-strategy HTTP E2E covering `full`, `last_n`, and `summary_only`.
   1.3 Keep the environment-gated TravelDesk flow as a provider smoke test, not the sole supervisor live path.
2. Tighten cancellation and error semantics
   2.1 Revisit detached child cancellation semantics after delegate timeout.
   2.2 Add explicit live coverage for `ON_FAILURE: escalate` and `ON_FAILURE: respond`.
   2.3 Validate SSRF protection for dynamically-registered remote agent endpoints under public-API tests.
3. Continue simplifying the orchestration surface
   3.1 Extract additional `RoutingExecutor` seams only after the current hardening slices remain green.
   3.2 Keep trace and doc inventories aligned with the shipped routing tool surface and callback contract.
   3.3 Document fan-out capacity tuning (semaphore capacity, concurrent guard behavior) for operators.

---

## 14. Success Metrics

| Metric                                 | Baseline                 | Target                                                    | How Measured                                               |
| -------------------------------------- | ------------------------ | --------------------------------------------------------- | ---------------------------------------------------------- |
| Local handoff / return regression rate | Covered in focused tests | Zero critical regressions across handoff/resume suites    | Runtime orchestration test suite and incident review       |
| Fan-out cleanup reliability            | Covered in unit tests    | No orphaned cleanup regressions in focused fan-out suites | `routing-fanout-failures` and related integration coverage |
| Decision trace completeness            | Existing trace events    | All major control-flow modes traceable in Observatory     | Trace event inventory and debugging workflows              |
| Multi-intent E2E coverage              | 0 live scenarios         | 1+ live scenario per strategy                             | E2E test suite pass rate                                   |
| Cycle / depth protection coverage      | Unit tests only          | E2E scenarios verifying rejection                         | Integration and E2E test results                           |

---

## 15. Open Questions

1. Should `primary_queue`, `sequential`, and `disambiguate` each get their own deterministic HTTP E2E instead of remaining unit/integration-only?
2. How aggressively should detached child work be cancelled after delegate timeout or parent resume?
3. Should history-strategy variants be promoted from integration coverage into explicit live orchestration scenarios?
4. Should the remaining `RoutingExecutor` seams be extracted now that activation, async fan-out, and multi-intent planning have dedicated modules?
5. Should fan-out capacity (`maxConcurrentFanOutCalls`) be configurable at the project level rather than just the pod level?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                   | Severity | Status    |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- |
| GAP-001 | Guided `parallel` multi-intent now has deterministic HTTP E2E, but `primary_queue`, `sequential`, and `disambiguate` still lack live coverage | Medium   | Partial   |
| GAP-002 | Async fan-out callback/resume now has deterministic HTTP E2E, but provider-backed and barrier-race E2E coverage is still limited              | Medium   | Mitigated |
| GAP-003 | Some history-strategy combinations are validated in integration tests rather than live provider runs                                          | Low      | Open      |
| GAP-004 | Delegate timeout stops the parent wait path, but detached child work may continue until downstream systems honor cancellation                 | Medium   | Open      |
| GAP-005 | `RoutingExecutor` still remains large even after activation, fan-out, and multi-intent extraction                                             | Low      | Mitigated |
| GAP-006 | Fan-out capacity is pod-level only; no project-level override exists                                                                          | Low      | Open      |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                           | Coverage Type    | Status     | Test File / Note                                                                                     |
| --- | ------------------------------------------------------------------ | ---------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| 1   | Child session cannot inherit undeclared handoff authority          | e2e              | PASS       | `child-routing-authority.e2e.test.ts`                                                                |
| 2   | `RETURN:true` handoff round-trip through public HTTP               | e2e              | PASS       | `routing-phase5.e2e.test.ts`                                                                         |
| 3   | Full orchestration E2E (handoff/return/PASS/MAP, threads, fan-out) | e2e              | PASS       | `multi-agent-orchestration.e2e.test.ts`                                                              |
| 4   | Return-to-parent and thread reuse                                  | integration      | PASS       | `execution/thread-resume-integration.test.ts`                                                        |
| 5   | Reasoning + gather + handoff flow                                  | integration      | PASS       | `execution/reasoning-gather-handoff.test.ts`                                                         |
| 6   | Delegate guards, timeout, mapping, `ON_FAILURE`                    | unit             | PASS       | `routing/routing-delegate-failures.test.ts`, `routing/delegate-safety.test.ts`                       |
| 7   | Async fan-out branch registration and result aggregation           | unit/integration | PASS       | `routing/async-fanout-*.test.ts`                                                                     |
| 8   | Fan-out cleanup, dedupe, timeouts, concurrent guard                | unit             | PASS       | `routing/routing-fanout-failures.test.ts`, `routing/fan-out-bug-fixes.test.ts`                       |
| 9   | Helper coverage (parsing, mapping, formatting)                     | unit             | PASS       | `routing/routing-executor-unit.test.ts`, `routing/routing-executor-helpers.test.ts`                  |
| 10  | Multi-intent config precedence and routing facade behavior         | unit             | PASS       | `routing/routing-executor-multi-intent.test.ts`                                                      |
| 11  | Canonical multi-intent plan resolution and target preservation     | unit/integration | PASS       | `routing/multi-intent-router.test.ts`, `routing/multi-intent-*.test.ts`                              |
| 12  | Guided parallel multi-intent through public HTTP                   | e2e              | PARTIAL    | `routing-phase5.e2e.test.ts`, GAP-001                                                                |
| 13  | Async fan-out mixed local + remote callback/resume via public HTTP | e2e              | PASS       | `routing-phase5.e2e.test.ts`                                                                         |
| 14  | History strategy variants live E2E                                 | e2e              | NOT TESTED | GAP-003                                                                                              |
| 15  | Handoff guardrail pipeline (block/mutate/fail-open)                | unit             | PASS       | `execution/guardrails/handoff-rails.test.ts`, `handoff-guardrail-llmeval.test.ts`                    |
| 16  | Metadata propagation across handoff boundaries                     | unit             | PASS       | `routing/routing-executor-metadata-propagation.test.ts`                                              |
| 17  | Remote handoff target resolution                                   | unit             | PASS       | `routing/routing-remote-handoff.test.ts`                                                             |
| 18  | Child-session factories and fan-out barriers (packages/execution)  | unit             | PASS       | `packages/execution/src/__tests__/child-session.test.ts`, `fan-out-barrier-contract.test.ts`, et al. |
| 19  | Handoff resume with intent and return propagation                  | integration      | PASS       | `execution/handoff-resume-intent.test.ts`, `handoff-return-propagation-regression.test.ts`           |
| 20  | Completion detection and delegation flow                           | unit             | PASS       | `execution/runtime-completion.test.ts`, `execution/pre-refactor/completion-*.test.ts`                |

### Testing Notes

The orchestration surface has substantial coverage: 4 E2E suites (3 deterministic, 1 env-gated), 10+ integration tests, and 30+ unit tests across `apps/runtime` and `packages/execution`. The `multi-agent-orchestration.e2e.test.ts` suite covers the full orchestration lifecycle (handoff/return/PASS/MAP, thread management, fan-out, delegation chains) in both scripted-deterministic and live-LLM tiers. `routing-phase5.e2e.test.ts` covers `RETURN:true` round-trip, guided parallel multi-intent, and mixed async fan-out callback/resume via public HTTP. The remaining live gaps are breadth gaps, not "zero E2E" gaps: more multi-intent strategies, history strategies, and provider-backed barrier/race scenarios still need explicit coverage. The existing TravelDesk supervisor E2E test remains useful as an environment-gated smoke path.

> Full testing details: [docs/testing/multi-agent-orchestration.md](../testing/multi-agent-orchestration.md)

---

## 18. References

- Related features: [multi-agent-session-management.md](multi-agent-session-management.md), [a2a-integration.md](a2a-integration.md), [agent-transfer.md](agent-transfer.md), [guardrails.md](guardrails.md)
- Feature family overview: [agent-transfer-orchestration.md](agent-transfer-orchestration.md)
- Existing HLD for E2E test suite: `docs/specs/multi-agent-orchestration-e2e.hld.md`
- Feature inventory reference: `docs/feature-matrix.md`
- Compiler IR schema: `packages/compiler/src/platform/ir/schema.ts`

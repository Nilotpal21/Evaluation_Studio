# Multi-Agent Orchestration — High-Level Design

**Feature**: Multi-Agent Orchestration
**Status**: APPROVED
**Last Updated**: 2026-04-01
**Feature Spec**: [docs/features/multi-agent-orchestration.md](../features/multi-agent-orchestration.md)
**Test Spec**: [docs/testing/multi-agent-orchestration.md](../testing/multi-agent-orchestration.md)

---

## 1. Problem Statement

Runtime agents need a unified coordination surface that translates compiled ABL coordination rules into deterministic control flow for handoff, delegation, fan-out, completion, and return-to-parent behavior. Without this, agent-to-agent interaction becomes ad hoc — scattered across tools, session mutations, and custom routing logic — making it impossible to trace, govern, or debug consistently.

The coordination layer must be:

- **Declarative**: Agent authors write `COORDINATION:` blocks in ABL; the compiler produces `CoordinationConfig` IR that the runtime interprets.
- **Bounded**: Fan-out has semaphore-limited concurrency; delegates have max depth; handoffs have cycle detection.
- **Observable**: Every routing decision emits verbosity-aware trace events reconstructable in Observatory.
- **Policy-aware**: Guardrails and session policies can block or modify coordination actions before they execute.

### Post-Implementation Notes (2026-04-01)

- `RoutingExecutor` remains the orchestration facade, but the hardening wave extracted key seams into `routing-capabilities.ts`, `agent-activation-context.ts`, `fanout/`, and `multi-intent/`.
- The canonical routing tool surface is per-target `handoff_to_X` / `delegate_to_X`. Legacy generic fan-out tooling remains compatibility-only.
- Async fan-out now distinguishes remote branch callbacks from parent aggregation with dedicated continuation types and explicit branch records.
- Deterministic public-HTTP regressions now cover child-routing-authority sanitization, `RETURN:true` handoff round-trips, guided multi-intent parallel execution, and mixed local+remote async fan-out callback/resume.

---

## 2. Alternatives Considered

### Alternative A: Distributed Event-Driven Orchestration (Saga Pattern)

**Description**: Each agent runs as an independent service. Coordination happens via events on a message bus (Redis Streams / BullMQ). A saga orchestrator tracks state transitions and compensating actions.

**Pros**:

- Natural horizontal scaling — each agent is an independent worker
- Fault isolation — one agent crash doesn't affect others
- Well-understood distributed systems pattern

**Cons**:

- High complexity — saga state machine, compensating transactions, event ordering
- Latency overhead — event serialization/deserialization per hop
- Debugging difficulty — distributed traces across multiple services
- Overkill — ABL agents run in-process; they share the same runtime pod

**Effort**: L (large)

### Alternative B: In-Process Coordinator with Thread Model (CHOSEN)

**Description**: A single `RoutingExecutor` interprets compiled IR coordination rules in-process. Agent activations are modeled as threads within a session (not separate sessions). Fan-out uses `InProcessExecutionRuntime` with `CountingSemaphore` for bounded concurrency. Remote agents are dispatched via A2A but controlled from the same coordinator.

**Pros**:

- Low latency — no inter-process serialization for local agents
- Simple debugging — single execution context, all threads visible in one session
- Natural fit — ABL agents compile to IR that runs in-process
- Deterministic ordering — thread stack provides explicit return paths

**Cons**:

- Pod-local concurrency limit for fan-out
- `RoutingExecutor` is still large and benefits from continued seam extraction
- Remote agent dispatch still requires async handling (addressed by A2A integration)

**Effort**: M (medium) — already implemented

### Alternative C: Graph-Based Workflow Engine

**Description**: Model multi-agent coordination as a directed graph (DAG). Each node is an agent activation. Edges encode handoff/delegate/fan-out transitions. A workflow engine traverses the graph, scheduling agent executions.

**Pros**:

- Visual representation — graph maps naturally to Studio topology view
- Static analysis — cycle detection at compile time, not runtime
- Standardized — resembles BullMQ Flows / Temporal workflow patterns

**Cons**:

- Over-abstraction — simple A -> B handoffs don't need graph infrastructure
- Dynamic routing (LLM-decided handoffs) doesn't fit static graph edges
- Would require rearchitecting the existing thread model

**Effort**: L (large)

### Recommendation

**Alternative B** (In-Process Coordinator) is the chosen and implemented approach. It provides the lowest latency for the common case (local agents in the same pod), keeps debugging simple (all threads in one session), and naturally fits the ABL compile-then-execute model. The main trade-off — large `RoutingExecutor` file size — is a code organization concern, not an architectural limitation, and can be addressed incrementally through module extraction.

---

## 3. Architecture

### System Context Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      ABL Platform                            │
│                                                              │
│  ┌──────────┐    ┌──────────────┐    ┌──────────────────┐   │
│  │  Studio   │───▶│   Compiler   │───▶│   Agent IR       │   │
│  │  (ABL     │    │  (packages/  │    │ CoordinationConfig│   │
│  │   Editor) │    │   compiler)  │    │ CompletionConfig  │   │
│  └──────────┘    └──────────────┘    │ RoutingConfig     │   │
│                                       └────────┬─────────┘   │
│                                                │              │
│  ┌──────────┐    ┌──────────────┐    ┌────────▼─────────┐   │
│  │  Client   │───▶│   Runtime    │───▶│ RoutingExecutor  │   │
│  │ (REST/WS) │    │ (apps/      │    │ (Coordination    │   │
│  │           │◀───│  runtime)    │◀───│  Engine)         │   │
│  └──────────┘    └──────────────┘    └────────┬─────────┘   │
│                                                │              │
│                     ┌──────────────────────────┼──────┐      │
│                     │                          │      │      │
│              ┌──────▼──────┐  ┌────────▼──────┐│     │      │
│              │ A2A Client  │  │ Agent Transfer ││     │      │
│              │ (Remote     │  │ (Human         ││     │      │
│              │  Agents)    │  │  Escalation)   ││     │      │
│              └─────────────┘  └────────────────┘│     │      │
│                                                  │     │      │
│              ┌──────────────┐  ┌────────────────▼┐    │      │
│              │  Guardrail   │  │ InProcess       │    │      │
│              │  Pipeline    │  │ ExecutionRuntime │    │      │
│              │  (Policy)    │  │ (Fan-out)        │    │      │
│              └──────────────┘  └──────────────────┘    │      │
│                                                        │      │
└────────────────────────────────────────────────────────┘      │
```

### Component Diagram

```
RoutingExecutor (routing-executor.ts)
├── handleHandoff()
│   ├── validate: HandoffExecutor.validate()
│   ├── context: extractSessionMetadata() + PASS fields + SUMMARY
│   ├── guardrails: GuardrailPipeline.execute(kind: 'handoff')
│   ├── remote: handleRemoteHandoff() → A2A sendTask/sendTaskAsync
│   └── local: createThread() → executeMessage() → tryThreadReturn()
├── handleDelegate()
│   ├── validate: DelegateExecutor (cycle, depth, WHEN guard)
│   ├── context: INPUT mapping → child session
│   ├── execute: createChildSession() → executeMessage()
│   └── result: RETURNS mapping → parent data store
├── handleFanOut()
│   ├── guard: _activeFanOutSessions (concurrent check)
│   ├── plan: ExecutionPlan with ExecutionUnit[] (agent/tool branches)
│   ├── execute: InProcessExecutionRuntime.execute() + CountingSemaphore
│   └── aggregate: merge results, handle partial failures
├── handleEscalation()
│   ├── validate: priority, reason length
│   ├── route: EscalationRouting config → Agent Transfer
│   └── emit: escalation trace event
├── handleComplete()
│   ├── evaluate: CompletionDetector.check()
│   ├── return: tryThreadReturn() if child
│   └── emit: completion_check, return_to_parent
└── handleMultiIntent()
    ├── facade: delegates to multi-intent/multi-intent-router.ts
    ├── resolve: target-preserving ResolvedMultiIntentPlan
    ├── dispatch: primary_queue | disambiguate | parallel | sequential
    └── queue: enqueueIntents() for deferred processing

Sub-Modules:
├── routing-capabilities.ts         — active IR-derived handoff/delegate authority
├── agent-activation-context.ts     — shared child-agent activation seam
├── fanout/async-fanout-coordinator.ts — async branch + parent resume contract
├── fanout/fanout-branch-state.ts   — branch records and status transitions
├── fanout/fanout-results.ts        — async result aggregation and thread storage
├── multi-intent/multi-intent-router.ts — canonical multi-intent planning
├── multi-intent-strategy.ts        — resolveStrategy() pure function
├── intent-queue.ts                 — IntentQueue storage and drain
├── auth-profile-handoff.ts         — Auth context forwarding (handoff) via activation
├── auth-profile-delegate.ts        — Auth context forwarding (delegate) via activation
├── auth-profile-fanout.ts          — Auth context forwarding (fan-out) via activation
├── trace-helpers.ts                — emitDecisionEvent() verbosity-aware
├── memory-integration.ts           — Memory hooks around orchestration
└── session-policy.ts               — Session-level policy loading
```

### Data Flow: Local Handoff with RETURN

```
1. Client sends POST /api/v1/chat/agent with message
2. ExecutionCoordinator.submit() → executeMessage()
3. Active agent (supervisor) processes message
4. LLM decides to call a per-target routing tool such as `handoff_to_specialist`
5. RoutingExecutor.handleHandoff() invoked:
   a. Validate: self-handoff? cycle? registry? HandoffExecutor.validate()
   b. Build context: extractSessionMetadata() + PASS fields + SUMMARY
   c. Guardrail check: GuardrailPipeline.execute(kind: 'handoff')
   d. If RETURN: true → parent thread.status = 'waiting', push to threadStack
   e. Check for existing waiting thread for target → resume or create new
   f. Wire LLM client for target agent
   g. Apply history strategy (none/full/last_n/summary_only)
   h. executeMessage() on child thread → agent processes
6. Child completes (CompletionDetector or explicit return)
7. tryThreadReturn() → pop threadStack → parent thread.status = 'active'
8. ON_RETURN mapping applied → parent data updated
9. syncThreadToSession() → session fields updated
10. Trace events emitted: handoff, agent_switch, thread_return, completion_check
11. Response streamed to client via onChunk callback
```

### Sequence Diagram: Fan-Out

```
Client        ExecutionCoordinator    RoutingExecutor    InProcessRuntime    Semaphore
  │                  │                      │                   │                │
  ├─POST message────▶│                      │                   │                │
  │                  ├─executeMessage()─────▶│                   │                │
  │                  │                      │                   │                │
  │                  │   handleFanOut()      │                   │                │
  │                  │◀─────────────────────│                   │                │
  │                  │                      │                   │                │
  │                  │ _activeFanOutSessions │                   │                │
  │                  │ guard check           │                   │                │
  │                  │                      ├─build plan────────▶│                │
  │                  │                      │                   │                │
  │                  │                      │                   ├─acquire(n)────▶│
  │                  │                      │                   │◀──────────────┤
  │                  │                      │                   │                │
  │                  │                      │    execute branch 1│                │
  │                  │                      │    execute branch 2│ (concurrent)   │
  │                  │                      │    (branch 3 waits)│                │
  │                  │                      │                   │                │
  │                  │                      │    branch 1 done   │                │
  │                  │                      │                   ├─release(1)────▶│
  │                  │                      │    branch 3 starts │◀──────────────┤
  │                  │                      │                   │                │
  │                  │                      │◀──all done────────┤                │
  │                  │                      │                   │                │
  │                  │   aggregate results   │                   │                │
  │                  │   release guard       │                   │                │
  │                  │   emit fan_out_complete│                  │                │
  │◀─response────────┤                      │                   │                │
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

#### 1. Tenant Isolation

Every orchestration action operates within a tenant-scoped session. The `RuntimeSession` carries `tenantId` set at session creation. Child threads inherit the parent session's `tenantId`. Remote handoff via A2A does not share tenant context across runtime boundaries — each remote agent resolves its own tenant context. Session lookup for orchestration state always includes `tenantId` in the query.

#### 2. Data Access Pattern

Orchestration does **not** introduce its own data store. It operates on in-memory `RuntimeSession` and `AgentThread` objects that are persisted by the session service. The pattern is:

- Read: `getActiveThread(session)`, `session.threads[i]`, `session.handoffStack`
- Write: Direct mutation of session fields (threads array, threadStack, data.values)
- Persist: Session service schedules persistence after execution completes

No repository layer exists for orchestration — it is purely an in-memory execution concern. The `packages/execution` package provides `InProcessExecutionRuntime` and `CountingSemaphore` as pure runtime primitives.

#### 3. API Contract

Orchestration has no standalone API endpoints. It is triggered during message execution through the existing chat and session APIs:

```
POST /api/v1/chat/agent → { sessionId, response, traceEvents? }
GET  /api/projects/:projectId/sessions/:id → { success, data: { session } }
GET  /api/projects/:projectId/sessions/:id/traces → { success, data: { traces } }
WS   /ws → streaming events including orchestration trace events
```

Error envelope: `{ success: false, error: { code, message } }`

Internal RoutingExecutor methods return `{ success: boolean; response?: string; error?: string }`.

#### 4. Security Surface

- **SSRF prevention**: `assertUrlSafeForSSRF()` validates remote agent endpoints before registration.
- **Cycle detection**: `handoffStack` prevents infinite handoff loops; `delegateStack` + `MAX_DELEGATE_DEPTH` prevents infinite delegation.
- **Auth forwarding**: `agent-activation-context.ts` is the shared seam for auth propagation, with dedicated helpers for handoff, delegate, and fan-out context building.
- **Guardrail enforcement**: `GuardrailPipeline.execute(kind: 'handoff')` can block or modify context before transfer. Fail-open on guardrail errors.
- **Input validation**: Handoff targets validated against active IR-derived routing capabilities and `agentRegistry`. Self-handoff explicitly rejected.

### Behavioral Concerns

#### 5. Error Model

| Error Scenario           | Handling                                                                | User Experience                                           |
| ------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| Target agent not found   | Return `{ success: false, error: "Agent not found" }`                   | Agent receives tool call failure, retries or informs user |
| Self-handoff             | Return `{ success: false, error: "Cannot hand off to yourself" }`       | Agent receives clear rejection                            |
| Cycle detection          | Return `{ success: false, error: "Handoff cycle detected: A → B → A" }` | Agent receives cycle path                                 |
| Max delegate depth       | Return `{ success: false, error: "Max delegation depth exceeded" }`     | Agent receives depth error                                |
| Guardrail blocks handoff | Return `{ success: false, error: "<violation message>" }`               | Agent cannot transfer, must handle differently            |
| Delegate timeout         | Parent wait severed, `ON_FAILURE` action executed                       | Depends on `ON_FAILURE`: continue/escalate/respond        |
| Fan-out partial failure  | Aggregate result includes failures                                      | Response may be partial                                   |
| Guardrail pipeline error | Fail-open — handoff proceeds with warning                               | Handoff succeeds (safety net)                             |

#### 6. Failure Modes

- **Network partition (remote handoff)**: A2A `sendTask`/`sendTaskAsync` timeout. Parent thread remains `waiting` until timeout action triggers.
- **LLM timeout (child execution)**: Child execution bounded by `RuntimeExecutorConfig.timeoutMs`. On timeout, delegate `ON_FAILURE` or handoff `on_timeout` action triggers.
- **Concurrent fan-out collision**: `_activeFanOutSessions` guard rejects with error. Client retries.
- **Session persistence failure**: Orchestration completes in-memory but persistence fails. Next session load sees stale state. Recovery: re-execute the turn.
- **Guardrail service down**: Fail-open design — handoffs proceed without guardrail evaluation. Warning emitted.

#### 7. Idempotency

- Handoff and delegate are **not idempotent** — they create threads and mutate session state. Deduplication is handled at the `ExecutionCoordinator` level via `ExecutionDedup`.
- Fan-out tasks include deduplication logic (repeated targets merged).
- Remote A2A tasks use `taskId` for at-most-once delivery.

#### 8. Observability

All orchestration actions emit trace events via `emitDecisionEvent()` in `trace-helpers.ts`:

| Level    | Events                                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------- |
| minimal  | `error`, `escalation`, `completion_check`, `warning`                                                        |
| standard | `handoff`, `delegate_start`, `delegate_complete`, `thread_return`, `agent_switch`, `fan_out_start/complete` |
| verbose  | `decision` (with kind, outcome, condition, matched)                                                         |
| debug    | Full LLM prompts/responses during child execution                                                           |

Events are renderable in Observatory SpanTree and DebugTabs.

### Operational Concerns

#### 9. Performance Budget

| Operation               | Target Latency   | Notes                                                             |
| ----------------------- | ---------------- | ----------------------------------------------------------------- |
| Local handoff           | < 50ms overhead  | Thread creation + context transfer (excludes child LLM call)      |
| Delegate                | < 50ms overhead  | Child session creation + INPUT mapping (excludes child execution) |
| Fan-out (3 branches)    | < 100ms overhead | Plan creation + semaphore acquire (excludes branch execution)     |
| Guardrail check         | < 200ms          | Depends on guardrail tier (T1 < 10ms, T2 < 100ms, T3 < 200ms)     |
| Multi-intent resolution | < 5ms            | Pure function — `resolveStrategy()`                               |
| Context extraction      | < 1ms            | `extractSessionMetadata()` — in-memory filtering                  |

Fan-out semaphore capacity: default 10, configurable via `RuntimeExecutorConfig.maxConcurrentFanOutCalls`.

#### 10. Migration Path

No data migration is required. The hardening wave shipped incrementally in six commits (`d5bd6f13f`, `fa42dfae6`, `01485b222`, `19116dc44`, `9b4dd1bcd`, `92f62414b`) without changing persisted MongoDB or Redis schemas.

Further `RoutingExecutor` decomposition remains a refactoring concern, not a migration. The current module boundaries (`routing-capabilities`, `agent-activation-context`, `fanout/`, `multi-intent/`) are the intended strangler seams for any future extraction.

#### 11. Rollback Plan

No rollback needed — this is the existing production system.

For future changes to orchestration behavior:

- Feature flags can gate new coordination strategies (e.g., new multi-intent strategies)
- Session-level `_projectRuntimeConfig` can override coordination defaults per project
- Compiler version pinning ensures IR format stability

#### 12. Test Strategy

| Type        | Count                         | Coverage Focus                                                                                  |
| ----------- | ----------------------------- | ----------------------------------------------------------------------------------------------- |
| Unit        | 7+ test files                 | Capability resolution, strategy resolution, guardrails, parsing, mapping, branch-state handling |
| Integration | 6+ test files                 | Thread resume, activation, async fan-out execution/resumption, multi-intent parity              |
| E2E         | 2 deterministic + 1 env-gated | Child-session authority, routing hardening regressions, real-provider supervisor smoke          |
| Planned E2E | Remaining targeted slices     | Additional multi-intent strategies, history strategies, provider-backed fan-out race coverage   |

Target: Keep the shipped deterministic hardening regressions green, then expand breadth coverage for the remaining strategy/history/provider-specific gaps.

---

## 5. Data Model

### Coordination IR (No New Collections)

Orchestration uses compiled Agent IR, not a dedicated MongoDB collection.

**Source**: `packages/compiler/src/platform/ir/schema.ts`

```typescript
interface CoordinationConfig {
  delegates: DelegateConfig[];
  handoffs: HandoffConfig[];
  escalation?: EscalationConfig;
}

interface HandoffConfig {
  to: string;
  when: string;
  context: {
    pass: ResolvedPassField[];
    summary: string;
    grant_memory?: string[];
    history?: HistoryStrategy;
  };
  return: boolean;
  on_return?: string | HandoffReturnMapping;
  remote?: RemoteAgentLocation;
  timeout?: string;
  on_timeout?: string;
  async?: boolean;
  asyncTimeout?: number;
}

interface DelegateConfig {
  agent: string;
  when: string;
  purpose: string;
  input: Record<string, string>;
  returns: Record<string, string>;
  use_result: string;
  timeout?: string;
  on_failure: 'continue' | 'escalate' | 'respond';
  failure_message?: string;
  remote?: RemoteAgentLocation;
}
```

### Runtime State (In-Memory, Persisted via Session Service)

```typescript
interface RuntimeSession {
  threads: AgentThread[];
  activeThreadIndex: number;
  threadStack: number[];
  handoffStack: string[];
  delegateStack: string[];
  handoffReturnInfo?: Record<string, boolean>; // derived/debug-only; not an authority source
  intentQueue?: IntentQueue;
}

interface AgentThread {
  agentName: string;
  status: 'active' | 'waiting' | 'completed' | 'escalated' | 'suspended' | 'human_agent';
  handoffFrom?: string;
  handoffContext?: Record<string, unknown>;
  returnExpected: boolean;
  handoffStartedAt?: number;
  handoffTimeoutMs?: number;
  handoffTimeoutAction?: string;
}
```

---

## 6. API Design

### No New Endpoints

Orchestration is triggered through existing endpoints:

| Method | Path                                           | Auth                       | Orchestration Role                                    |
| ------ | ---------------------------------------------- | -------------------------- | ----------------------------------------------------- |
| POST   | `/api/v1/chat/agent`                           | `requireProjectPermission` | Entry point — triggers orchestration during execution |
| GET    | `/api/projects/:projectId/sessions/:id`        | `requireProjectPermission` | Inspect thread state after orchestration              |
| GET    | `/api/projects/:projectId/sessions/:id/traces` | `requireProjectPermission` | Inspect orchestration traces and fan-out progress     |
| WS     | `/ws`                                          | WebSocket auth             | Stream orchestration trace events in real-time        |

### Internal API (RoutingExecutor)

```typescript
class RoutingExecutor {
  handleHandoff(session, input, onChunk?, onTraceEvent?): Promise<{ success; response?; error? }>;
  handleDelegate(session, delegateConfig, onChunk?, onTraceEvent?): Promise<SubTaskResult>;
  handleFanOut(session, tasks, onChunk?, onTraceEvent?): Promise<FanOutResult>;
  handleEscalation(session, input, onTraceEvent?): Promise<{ success; response?; error? }>;
  handleComplete(session, input?, onTraceEvent?): Promise<{ success; response?; error? }>;
  handleMultiIntent(session, intents, agentType, config): Promise<MultiIntentDispatchResult>;
}
```

### Error Responses

All internal methods return `{ success: false, error: "<message>" }`. These are translated to the standard error envelope at the HTTP boundary: `{ success: false, error: { code: "ORCHESTRATION_ERROR", message: "<detail>" } }`.

---

## 7. Cross-Cutting Concerns

### Audit Logging

Orchestration actions are captured via trace events (not a separate audit log). The `handoff`, `delegate_start`, `delegate_complete`, `escalation`, and `decision` events provide an audit trail of who routed where and why. These events are persisted by the `TraceStore` and accessible via Observatory.

### Rate Limiting

Fan-out is rate-limited by the `CountingSemaphore` (default capacity: 10) and the `_activeFanOutSessions` concurrent guard. No per-tenant or per-project rate limiting exists for orchestration actions specifically — this is handled at the HTTP endpoint level by the existing rate limiting middleware.

### Caching

- `AgentCardCache` caches A2A agent cards (5-minute TTL, max 100 entries) for remote handoff capability inspection.
- `_projectRuntimeConfig` is cached on the session and reapplied after IR switches.
- Agent IR is cached in the `agentRegistry` (loaded at session initialization, not refetched per handoff).

### Encryption

- Auth context forwarded through handoff/delegate/fan-out chains is in-memory only (no at-rest encryption needed for ephemeral session state).
- Remote A2A calls use outbound auth config (`OutboundAuthConfig`) which may include bearer tokens or API keys — these flow through the existing credential resolution pipeline.

---

## 8. Dependencies

### Upstream (This Feature Depends On)

| Dependency                                                                                     | Risk   | Notes                                                                   |
| ---------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------- |
| `@abl/compiler` (HandoffExecutor, DelegateExecutor, CompletionDetector)                        | Low    | Stable — validation and condition evaluation                            |
| `@agent-platform/execution` (InProcessExecutionRuntime, CountingSemaphore, createChildSession) | Low    | Stable — fan-out and child session primitives                           |
| `@agent-platform/a2a` (sendTask, sendTaskAsync, AgentCardCache)                                | Medium | Remote handoff depends on A2A protocol stability                        |
| `@agent-platform/agent-transfer` (escalation routing)                                          | Medium | Human escalation depends on transfer adapter availability               |
| GuardrailPipeline                                                                              | Low    | Fail-open design — guardrail unavailability doesn't block orchestration |
| Session Service                                                                                | Low    | Session persistence — orchestration works in-memory regardless          |

### Downstream (Depends on This Feature)

| Dependent              | Impact | Notes                                                                        |
| ---------------------- | ------ | ---------------------------------------------------------------------------- |
| Observatory / SpanTree | Low    | Renders orchestration trace events — format changes would require UI updates |
| Studio Session Detail  | Low    | Displays thread state — field additions are backward-compatible              |
| A2A Integration        | Medium | Remote handoff/delegate dispatched through RoutingExecutor                   |
| Agent Transfer         | Medium | Human escalation dispatched through RoutingExecutor                          |

---

## 9. Open Questions & Decisions Needed

1. **RoutingExecutor decomposition**: The hardest seams are now extracted, but the facade is still large. Decision: Defer further decomposition until the hardening regressions stay green over time.
2. **Fan-out capacity per project**: Currently pod-level only. Should projects be able to override? Decision: Defer — current default (10) is sufficient.
3. **Detached child cancellation**: After delegate timeout, child work may continue. How aggressively to cancel? Decision: Document as GAP-004 — requires downstream cancellation protocol.
4. **Async fan-out barrier E2E**: Should this be a dedicated test or part of the general fan-out E2E? Decision: Dedicated — barrier semantics are complex enough to warrant isolation.

---

## 10. References

- Feature Spec: [docs/features/multi-agent-orchestration.md](../features/multi-agent-orchestration.md)
- Test Spec: [docs/testing/multi-agent-orchestration.md](../testing/multi-agent-orchestration.md)
- E2E HLD: [docs/specs/multi-agent-orchestration-e2e.hld.md](./multi-agent-orchestration-e2e.hld.md)
- Related Features: [a2a-integration.md](../features/a2a-integration.md), [agent-transfer.md](../features/agent-transfer.md), [multi-agent-session-management.md](../features/multi-agent-session-management.md)
- Compiler IR Schema: `packages/compiler/src/platform/ir/schema.ts`
- RoutingExecutor: `apps/runtime/src/services/execution/routing-executor.ts`

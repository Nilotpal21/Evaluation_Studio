# Execution Model Redesign — Design Document

**Date:** 2026-02-28
**Status:** Approved
**Scope:** Parallel fan-out, execution context isolation, streaming, Restate seam, tracing

---

## Problem

The runtime's agent execution model uses a shared mutable `RuntimeSession` object. Before executing a child agent (fan-out, delegate, handoff), the caller overwrites session top-level fields (`agentName`, `agentIR`, `conversationHistory`, `data`, `llmClient`, `currentFlowStep`) and then calls `executeMessage(session.id, ...)`. This coupling means:

1. **Fan-out is sequential** — only one agent can occupy the session at a time (`routing-executor.ts:955`, serial `for` loop).
2. **No cancellation** — no AbortSignal support in execution paths; timeouts use `Promise.race` hacks.
3. **No structured streaming** — callers get raw `onChunk(text)` and `onTraceEvent(event)` callbacks with no execution identity, making parallel progress reporting impossible.
4. **No Restate seam** — execution logic is tightly coupled to in-process function calls; no boundary exists for plugging in a durable execution runtime.
5. **No execution-level observability** — trace events lack execution hierarchy; no way to correlate LLM calls and tool calls to a specific agent invocation within a fan-out.

## Requirements

1. **Parallel fan-out** with independent failure domains (`Promise.allSettled`), no crash recovery (in-process).
2. **Progress streaming** — lifecycle events + thought/reasoning streaming, labeled by agent, delivered via existing WebSocket/SSE transports.
3. **Project-level execution mode** — `in-process` (default) or `durable` (Restate, future).
4. **Clean Restate seam** — interface boundary where Restate plugs in without changing executor logic.
5. **Execution-level tracing** — each agent invocation gets a unique `executionId` with parent-child linking.
6. **Cancellation** — per-child `AbortSignal` with timeout; parent can cancel all children.
7. **Scaling guards** — per-fan-out LLM concurrency semaphore to prevent one fan-out from starving other sessions.

## Non-Requirements

- Crash recovery for in-process execution (user retries on pod failure).
- Actual Restate implementation (only the interface/seam).
- Actual thought/reasoning token streaming (type defined, implementation deferred to Phase 2).
- Async tool callbacks / human-in-the-loop (suspension seam defined, not implemented).

---

## Architecture

### Core Concepts

Three new first-class concepts replace the current pattern of mutating session top-level fields:

#### SessionContext

Wraps `RuntimeSession` with a controlled interface. Provides read-only access to shared session state and controlled write access for thread management.

```typescript
interface SessionContext {
  // Identity (immutable after creation)
  readonly sessionId: string;
  readonly tenantId: string;
  readonly projectId?: string;
  readonly userId?: string;
  readonly callerContext?: CallerContext;
  readonly channelType?: string;
  readonly deploymentContext?: DeploymentContext;

  // Compilation (immutable after creation)
  readonly compilationOutput: CompilationOutput;
  readonly agentRegistry: Readonly<Record<string, AgentRegistryEntry>>;

  // Thread management (mutable, synchronized)
  readonly threads: AgentThread[];
  readonly activeThreadIndex: number;
  readonly threadStack: number[];
  createThread(
    agentName: string,
    ir: AgentIR,
    options?: ThreadOptions,
  ): { thread: AgentThread; index: number };

  // Shared resources (per-session lifecycle)
  readonly toolExecutor: ToolExecutor;
  readonly factStore?: FactStore;

  // Persistence
  persist(): Promise<void>;
}
```

#### ExecutionContext

Everything needed to execute a single agent invocation. Created per-execution, discarded after. This is the primary interface executors work with — not `RuntimeSession`.

```typescript
interface ExecutionContext {
  // Execution identity
  readonly executionId: string;
  readonly parentExecutionId?: string;

  // Session (read-only access to shared state)
  readonly session: SessionContext;

  // Thread (this execution's mutable agent state)
  readonly thread: AgentThread;
  readonly threadIndex: number;

  // Per-execution resources
  readonly llmClient: SessionLLMClient;

  // Event emission
  readonly eventBus: ExecutionEventBus;

  // Cancellation
  readonly signal: AbortSignal;

  // Configuration
  readonly config: ExecutionConfig;

  // Suspension (undefined for in-process, implemented for Restate)
  readonly suspend?: (reason: SuspensionReason) => Promise<ResumeData>;

  // Flags
  readonly suppressPersist: boolean;
}

interface ExecutionConfig {
  timeoutMs: number;
  maxIterations: number;
  traceVerbosity: 'minimal' | 'standard' | 'verbose' | 'debug';
  executionMode: 'in-process' | 'durable';
  maxConcurrentLLMCalls?: number; // per fan-out, default 3
  maxConcurrentToolCalls?: number; // per fan-out, default 5
}
```

#### ExecutionEventBus

Sits between executors and transports. All progress, tracing, and streaming flows through this single channel.

```typescript
interface ExecutionEventBus {
  emit(event: ExecutionEvent): void;
  subscribe(sessionId: string, listener: (event: ExecutionEvent) => void): Unsubscribe;
  getEvents(executionId: string): ExecutionEvent[];
  getChildEvents(parentExecutionId: string): ExecutionEvent[];
}
```

### Execution Event Protocol

```typescript
interface ExecutionEvent {
  sessionId: string;
  executionId: string;
  parentExecutionId?: string;
  agent: string;
  type: ExecutionEventType;
  data: Record<string, unknown>;
  timestamp: number;
}

type ExecutionEventType =
  // Lifecycle
  | 'execution.started'
  | 'execution.completed'
  | 'execution.failed'
  | 'execution.cancelled'
  | 'execution.suspended' // future (Restate)
  | 'execution.resumed' // future (Restate)

  // Fan-out orchestration
  | 'fanout.started'
  | 'fanout.completed'
  | 'fanout.partial'

  // Reasoning
  | 'reasoning.thinking' // text delta (existing onChunk)
  | 'reasoning.thought' // chain-of-thought tokens (Phase 2)
  | 'reasoning.iteration'

  // Tools
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'

  // Extraction & constraints
  | 'extraction.completed'
  | 'constraint.checked'

  // Agent routing
  | 'handoff.started'
  | 'handoff.completed'
  | 'delegate.started'
  | 'delegate.completed'
  | 'escalation.triggered';
```

### Execution Runtime Interface

Pluggable backend for executing agent work. Project-level config selects which implementation.

```typescript
interface ExecutionRuntime {
  execute(plan: ExecutionPlan, ctx: ExecutionContext): Promise<ExecutionResult[]>;
}

interface ExecutionPlan {
  type: 'parallel' | 'sequential' | 'single';
  units: ExecutionUnit[];
  timeout: number;
  onPartialFailure: 'continue' | 'cancel-remaining' | 'fail-all';
}

interface ExecutionUnit {
  agentName: string;
  agentIR: AgentIR;
  message: string;
  context?: Record<string, unknown>;
  timeout: number;
}
```

**Two implementations (only in-process built now):**

| Aspect         | InProcessExecutionRuntime | RestateExecutionRuntime (future) |
| -------------- | ------------------------- | -------------------------------- |
| Parallelism    | `Promise.allSettled`      | Restate parallel activities      |
| Crash recovery | None                      | Journal replay                   |
| Events         | Direct callback           | Redis Pub/Sub relay              |
| Cancellation   | `AbortController`         | Restate cancel                   |
| Suspension     | Not supported             | Awakeables                       |

### Pattern Mapping

| Pattern                | ExecutionPlan                              | onPartialFailure     |
| ---------------------- | ------------------------------------------ | -------------------- |
| Fan-out (3 agents)     | `{ type: 'parallel', units: [A, B, C] }`   | `'continue'`         |
| Delegate               | `{ type: 'single', units: [target] }`      | `'fail-all'`         |
| Handoff (no return)    | `{ type: 'single', units: [target] }`      | `'fail-all'`         |
| Sequential pipeline    | `{ type: 'sequential', units: [A, B, C] }` | `'fail-all'`         |
| Race (first responder) | `{ type: 'parallel', units: [...] }`       | `'cancel-remaining'` |

---

## Thread Isolation

### Current Problem

`handleFanOut` (and handoff/delegate) mutates session top-level fields before calling `executeMessage`:

```typescript
// Current code (routing-executor.ts:984-989)
session.agentName = task.target;
session.agentIR = targetInfo.ir;
session.conversationHistory = childThread.conversationHistory;
session.state = childThread.state;
session.data = childThread.data;
session.currentFlowStep = childThread.currentFlowStep;
```

This makes only one agent executable at a time.

### Solution

Add `llmClient` to `AgentThread`. Create per-child `ExecutionContext` instances that point to the child's thread. Executors read agent state from `ctx.thread`, not from session top-level fields.

```typescript
// AgentThread gains:
interface AgentThread {
  // ... existing fields ...
  llmClient?: SessionLLMClient; // NEW — per-thread LLM client
}
```

The `createChildSession` helper creates a lightweight session clone for each child, with mutable fields pointing to the child's thread:

```typescript
function createChildSession(parentSession: RuntimeSession, threadIndex: number): RuntimeSession {
  const thread = parentSession.threads[threadIndex];
  return {
    ...parentSession,
    agentName: thread.agentName,
    agentIR: thread.agentIR,
    conversationHistory: thread.conversationHistory,
    state: thread.state,
    data: thread.data,
    currentFlowStep: thread.currentFlowStep,
    activeThreadIndex: threadIndex,
    llmClient: thread.llmClient,
    isComplete: false,
    isEscalated: false,
  };
}
```

This preserves backward compatibility: `buildSystemPrompt`, `buildTools`, and all executor code that reads session top-level fields continues working unchanged because the child session's top-level fields point to the correct thread data.

### Persistence During Fan-Out

- Child executions set `suppressPersist: true` — no `debouncedPersist` calls during child execution.
- Parent's `handleFanOut` does a single `persist()` after all children complete and results are merged.
- Since we chose no crash recovery, this is correct: if the pod dies mid-fan-out, the caller retries.

### Thread Safety for Nested Operations

If a fan-out child triggers a handoff (creating a new thread), it operates on the child session's thread state. Since Node.js is single-threaded, synchronous operations like `session.threads.push()` are safe between `await` points. Thread creation (`createThread`) is synchronous.

---

## Streaming Architecture

### Transport Mapping

| Transport | How events are delivered                                  |
| --------- | --------------------------------------------------------- |
| WebSocket | `ServerMessages.executionEvent(event)` — new message type |
| SSE       | `event: execution\ndata: {json}\n\n` — new SSE event type |
| REST      | Events accumulated, returned as `{ response, events[] }`  |

### Existing Callback Migration

| Current                        | New                                                             |
| ------------------------------ | --------------------------------------------------------------- |
| `onChunk(text)`                | `eventBus.emit({ type: 'reasoning.thinking', data: { text } })` |
| `onTraceEvent({ type, data })` | `eventBus.emit({ type: 'trace', data: { traceEvent } })`        |

WebSocket/SSE handlers subscribe to the event bus and translate events to wire format. The `onChunk` and `onTraceEvent` parameters become thin wrappers that emit to the bus, preserving backward compatibility for callers that still pass callbacks directly.

### Client Rendering

Events carry `executionId` + `agent`, enabling the UI to build parallel progress views:

```
┌─────────────────────────────────────────┐
│ Supervisor: "Let me check all three..." │
├─────────────────────────────────────────┤
│ ✓ Flight_Agent    ⟳ searching...       │
│ ✓ Hotel_Agent     ✓ found 3 options     │
│ ✓ Car_Agent       ✗ timed out           │
├─────────────────────────────────────────┤
│ Synthesizing results...                 │
└─────────────────────────────────────────┘
```

---

## Cancellation

Each execution gets an `AbortController`. Fan-out parent holds refs to all children's controllers.

```
Parent AbortController
    ├── Child A AbortController (linked to parent + per-child timeout)
    ├── Child B AbortController (linked to parent + per-child timeout)
    └── Child C AbortController (linked to parent + per-child timeout)
```

- **Per-child timeout**: `AbortSignal.timeout(timeoutMs)` on each child's controller.
- **Parent cancel**: Aborting parent cancels all children (session escalation during fan-out, WebSocket disconnect).
- **`cancel-remaining` strategy**: When first child fails, abort siblings.
- **LLM calls**: Pass `signal` to HTTP fetch / provider calls for mid-request cancellation.

---

## Scaling

### LLM Concurrency

Fan-out multiplies concurrent LLM calls. Two layers of protection:

```
Global LLM Queue (10 concurrent, existing)
  └── Per-fan-out semaphore (maxConcurrentLLMCalls, default 3)
       ├── Child A: LLM call
       ├── Child B: LLM call
       └── Child C: waiting for permit
```

The per-fan-out semaphore prevents one fan-out from consuming all global permits.

### Memory

Per-child overhead: ~5-6KB (AgentThread + SessionLLMClient config). For 10 concurrent children: ~60KB. Negligible.

### Redis

No additional Redis operations during in-process fan-out. Children work in-memory. Single persist after completion.

### Tenant Rate Limiting

Existing per-tenant rate limiter on the LLM provider path applies regardless of fan-out. No change needed.

---

## Tracing & Observability

### Execution Spans

Each `ExecutionContext` maps to a trace span:

```
Session span
  └── Fan-out span (parent execution)
       ├── Flight_Agent span (child execution)
       │    ├── LLM call span
       │    ├── Tool call span
       │    └── LLM call span (iteration 2)
       ├── Hotel_Agent span (child execution)
       └── Car_Agent span (failed, timed out)
```

### Correlation

Every event and trace carries:

```typescript
{
  sessionId, executionId, parentExecutionId,
  traceId, spanId, tenantId, agentName,
}
```

### TraceEvent Extension

Existing `TraceEvent` gains optional execution fields (additive, backward compatible):

```typescript
interface TraceEvent {
  // Existing (unchanged)
  type: string;
  data: Record<string, unknown>;
  sessionId: string;
  agentName: string;
  timestamp: number;
  durationMs?: number;

  // New (optional)
  executionId?: string;
  parentExecutionId?: string;
}
```

### Metrics

| Metric                         | Type      | Labels                       |
| ------------------------------ | --------- | ---------------------------- |
| `execution.duration_ms`        | histogram | `agent`, `type`, `status`    |
| `execution.fanout.parallelism` | histogram | `agent`                      |
| `execution.fanout.child_count` | counter   | `status`                     |
| `execution.llm_calls`          | counter   | `agent`, `provider`, `model` |
| `execution.tool_calls`         | counter   | `agent`, `tool`, `status`    |
| `execution.cancellation`       | counter   | `agent`, `reason`            |

---

## Restate Integration Seam

The design creates boundaries where Restate plugs in without changing executor logic.

### What Restate needs from us (when built)

1. **Agent execution as HTTP endpoint** — Restate calls our runtime to execute a single agent: `POST /api/v1/agents/:name/execute`. Similar to existing A2A pattern.
2. **Event relay** — Restate handler emits events to Redis Pub/Sub; `ExecutionEventBus` subscribes and delivers to WebSocket/SSE clients.
3. **Callback endpoint** — For awakeables: `POST /api/v1/executions/:executionId/callback` resolves the Restate awakeable.
4. **Session state access** — Restate handlers use our existing Redis session store. One source of truth for session state.

### Suspension Interface

```typescript
type SuspensionReason =
  | { type: 'async_tool'; toolName: string; callbackId: string; timeout: number }
  | { type: 'human_approval'; prompt: string; timeout: number }
  | { type: 'remote_handoff'; target: string; correlationId: string };

interface ResumeData {
  type: string;
  payload: unknown;
}
```

In-process: `ExecutionContext.suspend` is `undefined`. Async tools not supported.
Restate: `suspend` maps to an awakeable. Handler hibernates, resumes on callback.

### Project-Level Config

```typescript
// Project config (DB-backed)
{
  "executionMode": "in-process" | "durable",
  "durableRuntime": {
    "provider": "restate",
    "endpoint": "http://restate:8080",
    "options": { ... }
  }
}
```

---

## Package Layout

```
packages/
  execution/                          ← NEW PACKAGE
    src/
      types.ts                        ← ExecutionContext, ExecutionPlan, ExecutionUnit,
                                        ExecutionEvent, SessionContext, SuspensionReason
      event-bus.ts                    ← ExecutionEventBus interface + InMemoryEventBus
      execution-runtime.ts            ← ExecutionRuntime interface
      in-process-runtime.ts           ← InProcessExecutionRuntime
      semaphore.ts                    ← Counting semaphore for LLM concurrency
      child-session.ts                ← createChildSession, createExecutionContext helpers
      index.ts                        ← re-exports

apps/runtime/src/
  services/execution/
    routing-executor.ts               ← MODIFIED: handleFanOut uses ExecutionRuntime
    reasoning-executor.ts             ← MODIFIED: emit events to eventBus
    runtime-executor.ts               ← MODIFIED: create ExecutionContext, wire eventBus
    flow-step-executor.ts             ← MODIFIED: accept ExecutionContext for event emission
    types.ts                          ← MODIFIED: AgentThread gains llmClient field
  services/session/
    session-context.ts                ← NEW: SessionContext wrapper over RuntimeSession
  routes/
    websocket/handler.ts              ← MODIFIED: subscribe to eventBus
    chat.ts                           ← MODIFIED: subscribe to eventBus for SSE
```

---

## Phasing

| Component                       | Phase 1 (Now)                      | Phase 2                         | Phase 3                 |
| ------------------------------- | ---------------------------------- | ------------------------------- | ----------------------- |
| `ExecutionContext` type         | Define, wire through executors     | —                               | —                       |
| `SessionContext` wrapper        | Define, wrap RuntimeSession        | —                               | —                       |
| `ExecutionEventBus`             | InMemoryEventBus                   | Redis Pub/Sub variant           | —                       |
| `ExecutionRuntime` interface    | Define + InProcessExecutionRuntime | RestateExecutionRuntime         | —                       |
| Parallel fan-out                | `Promise.allSettled`               | Restate parallel activities     | —                       |
| `ExecutionEvent` protocol       | All event types defined            | —                               | —                       |
| WebSocket/SSE streaming         | Lifecycle events streamed          | —                               | —                       |
| Thought streaming               | Type defined, not emitted          | Emit reasoning tokens           | —                       |
| AbortSignal cancellation        | Per-child timeout                  | Parent cancel, cancel-remaining | —                       |
| LLM concurrency semaphore       | Per-fan-out semaphore              | —                               | —                       |
| Tracing                         | executionId on TraceEvent          | OpenTelemetry spans             | —                       |
| Metrics                         | execution.duration_ms              | Full metric set                 | —                       |
| Suspend/resume                  | Interface defined (undefined)      | —                               | Restate awakeables      |
| Delegate via ExecutionRuntime   | —                                  | Migrate delegate                | —                       |
| Handoff via ExecutionRuntime    | —                                  | Migrate handoff                 | —                       |
| Remote A2A via ExecutionRuntime | —                                  | —                               | Restate durable handoff |
| Async tool callbacks            | —                                  | —                               | Restate awakeables      |
| Project-level config            | `executionMode` field in types     | DB schema + UI                  | —                       |

---

## Risks & Mitigations

| Risk                                                                                     | Severity | Mitigation                                                                                                |
| ---------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| Executors directly mutating `session.*` instead of using `ctx.thread`                    | High     | Convention + code review. Refactor to `SessionContext` (controlled interface) reduces surface.            |
| MCP tool clients not thread-safe for concurrent fan-out calls                            | Medium   | Verify MCP client concurrency. Create per-child clone if needed.                                          |
| Thought streaming requires provider-specific changes (Anthropic extended_thinking, etc.) | Medium   | Defer to Phase 2. Type defined now, implementation later.                                                 |
| `session.threads.push()` during nested handoffs from parallel children                   | Low      | Node.js single-threaded — synchronous push is safe between await points.                                  |
| Multiple fan-out children calling REMEMBER/RECALL concurrently                           | Low      | MongoDB atomic operations. Last write wins. Acceptable for different agents processing different intents. |
| Per-fan-out semaphore adds latency to LLM calls                                          | Low      | Only applies when semaphore is saturated. Default limit (3) is generous for typical fan-outs.             |

---

## End-to-End Flow

```
User message via WebSocket
    │
    ▼
WebSocket Handler
    │ subscribe to eventBus for this session
    │
    ▼
RuntimeExecutor.executeMessage(sessionId, message)
    │ create ExecutionContext for parent (supervisor)
    │
    ▼
ReasoningExecutor.execute(executionCtx)
    │ eventBus.emit({ type: 'execution.started', agent: 'Supervisor' })
    │
    ├── LLM call → response includes fan_out tool call
    │   eventBus.emit({ type: 'reasoning.thinking', data: { text } })
    │
    ▼
RoutingExecutor.handleFanOut(session, tasks, executionCtx)
    │ eventBus.emit({ type: 'fanout.started', data: { tasks } })
    │
    ├── Build ExecutionPlan { type: 'parallel', units: [A, B, C] }
    │
    ├── executionRuntime.execute(plan, parentCtx)
    │   │
    │   ├── Create child ExecutionContext per unit
    │   │   ├── Own executionId, llmClient, AbortController
    │   │   ├── Shared toolExecutor, factStore, eventBus
    │   │   └── suppressPersist: true
    │   │
    │   ├── Promise.allSettled([
    │   │     executeAgent(childCtxA),  → lifecycle + tool events
    │   │     executeAgent(childCtxB),  → lifecycle + tool events
    │   │     executeAgent(childCtxC),  → lifecycle + tool events
    │   │   ])
    │   │
    │   └── Return ExecutionResult[]
    │
    ├── Merge results to parent thread
    │   ├── _last_fan_out, _fan_out_result_* in parent data
    │   ├── Results in parent conversationHistory
    │   └── Child threads marked completed
    │
    ├── eventBus.emit({ type: 'fanout.completed', data: { results } })
    │
    ▼
ReasoningExecutor continues (tool result, don't break loop)
    │
    ├── LLM synthesizes unified response
    │   eventBus.emit({ type: 'reasoning.thinking', data: { text } })
    │
    ▼
Return ExecutionResult to caller
    │ eventBus.emit({ type: 'execution.completed', agent: 'Supervisor' })
    │ persist session (single call)
    │
    ▼
WebSocket Handler
    │ send response_end
    │ unsubscribe from eventBus
```

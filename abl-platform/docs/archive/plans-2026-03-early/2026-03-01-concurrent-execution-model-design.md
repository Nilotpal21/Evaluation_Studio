# Concurrent Execution Model — Design Document

**Date:** 2026-03-01
**Status:** Approved
**Scope:** Per-session message queuing, configurable concurrency strategies, execution lifecycle, deduplication, Restate seam integration
**Builds on:** [Execution Model Redesign](./2026-02-28-execution-model-redesign-design.md) (parallel fan-out, child session isolation, ExecutionRuntime interface)

---

## Problem

When two messages arrive for the same session concurrently, both hit `RuntimeExecutor.executeMessage()` simultaneously. They read/write the same `RuntimeSession` — `conversationHistory`, `currentFlowStep`, `data.values`, thread state. Result: lost conversation turns, corrupt flow state, silent data corruption.

**Current state:**

- SDK WebSocket handler always uses `enqueueLLMRequest` → acquires per-session lock → safe
- Debug WebSocket handler has a **direct path** that bypasses the lock entirely → unsafe
- HTTP chat route has no lock → unsafe
- No message queuing — messages execute inline on arrival
- No execution lifecycle tracking — no way to know if a message is pending, running, or completed
- No deduplication — client retries cause duplicate processing

**Impact:** Under concurrent message load, the following corruption occurs silently:

1. Lost conversation turns (one response overwrites the other in conversationHistory)
2. Broken flow state (currentFlowStep jumps unpredictably)
3. Gathered data corruption (fields mixed between concurrent paths)
4. Thread stack corruption (handoff/delegate interleaving)

---

## Requirements

1. **Concurrent message safety** — two messages for the same session must never corrupt shared state
2. **Configurable per agent** — serial (default), preemptive (cancel on new), parallel (concurrent)
3. **Execution lifecycle tracking** — every message has a tracked lifecycle (queued → running → completed/failed/cancelled/preempted)
4. **Queue depth feedback** — clients receive structured events for queue position and rejection
5. **Message deduplication** — prevent duplicate processing from retries/double-clicks
6. **Single entry point** — all callers (WebSocket, HTTP, test) go through one coordinator
7. **Cross-pod safe** — Redis-backed queue and lock for distributed deployment
8. **Restate seam** — interface boundary where durable execution can plug in later
9. **Backward compatible** — existing agents work unchanged (serial is the default)

## Non-Requirements

- MongoDB persistence for executions (Phase 1 uses Redis + ClickHouse)
- Actual Restate implementation (only the interface/seam)
- Studio UI changes for execution timeline (separate sprint)
- SDK client library updates (documented protocol, client updates separate)

---

## Architecture

### Core Concept: Execution

A single concept representing the full lifecycle of processing one user message — from queue entry through agent execution to response delivery. Merges the previous "Run" and "ExecutionContext" into one object.

```typescript
interface Execution {
  executionId: string; // "exec-{uuid}"
  parentExecutionId?: string; // For fan-out children
  sessionId: string;
  tenantId: string;

  // Input
  message: string;
  attachmentIds?: string[];
  agentName: string;

  // Lifecycle
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'preempted';
  queuedAt: number;
  startedAt?: number;
  completedAt?: number;

  // Output (populated on completion)
  response?: string;
  tokenUsage?: { input: number; output: number };
  durationMs?: number;
  error?: { code: string; message: string };
  gatheredData?: Record<string, unknown>;

  // Runtime context (populated when status transitions to 'running')
  thread?: AgentThread; // This execution's mutable agent state
  llmClient?: SessionLLMClient; // Per-execution LLM client
  signal?: AbortSignal; // Cancellation
  config?: ExecutionConfig; // Timeout, max iterations, trace verbosity

  // Suspension seam (undefined for in-process, Restate future)
  suspend?: (reason: SuspensionReason) => Promise<ResumeData>;
}
```

**Design decision: Single concept.** No confusion between "run" and "execution". Queue entry, execution lifecycle, and result are all one object. Runtime fields are optional — populated when transitioning from `queued` to `running`. Redis stores only serializable fields; runtime fields exist in-memory during execution. For fan-out children, status starts at `running` (never `queued`).

### ExecutionQueue

Per-session FIFO queue of pending executions.

```typescript
interface ExecutionQueue {
  enqueue(sessionId: string, execution: Execution): Promise<void>;
  dequeue(sessionId: string): Promise<Execution | null>;
  peek(sessionId: string): Promise<Execution | null>;
  length(sessionId: string): Promise<number>;
  cancelAll(sessionId: string): Promise<Execution[]>;
  getActive(sessionId: string): Promise<Execution | null>;
}
```

**Two implementations:**

- `RedisExecutionQueue` — RPUSH/LPOP on `exec:queue:{sessionId}`, HSET on `exec:active:{sessionId}`. Cross-pod safe.
- `InMemoryExecutionQueue` — `Map<sessionId, Execution[]>`. For testing and local dev.

**Design decision: Redis-backed.** Cross-pod consistency is required for distributed deployment. Already a dependency. In-memory fallback for tests.

### ExecutionCoordinator

Single entry point for all message processing. Reads agent concurrency strategy from IR, manages queue, lock, dedup, and lifecycle.

```typescript
interface ExecutionCoordinator {
  submit(sessionId: string, message: string, options?: SubmitOptions): Promise<Execution>;
  cancel(executionId: string): Promise<boolean>;
  cancelSession(sessionId: string): Promise<void>;
  getStatus(executionId: string): Promise<Execution | null>;
}

interface SubmitOptions {
  attachmentIds?: string[];
  onChunk?: (chunk: string) => void;
  onTraceEvent?: (event: TraceEvent) => void;
  callerContext?: TenantContextData;
}
```

All callers (WebSocket handlers, HTTP chat, test harnesses) go through `submit()`. No direct `executeMessage()` calls anymore.

---

## Concurrency Strategies

Agent IR gains a new optional field:

```typescript
// In AgentIR.execution
execution: {
  mode: 'scripted' | 'reasoning';
  concurrency?: 'serial' | 'preemptive' | 'parallel';  // default: 'serial'
  max_queue_depth?: number;                              // default: 10
  max_concurrent_messages?: number;                      // for parallel mode, default: 3
}
```

**ABL DSL syntax:**

```yaml
EXECUTION:
  MODE: reasoning
  CONCURRENCY: serial
  # CONCURRENCY: preemptive
  # CONCURRENCY: parallel
```

### Serial (default)

Messages are processed one at a time per session, in arrival order.

```
Message 1 arrives → Execution 1 (status: running)
Message 2 arrives → Execution 2 (status: queued, position 1)
                     ... Execution 1 completes ...
                     Execution 2 transitions to running
```

- Lock acquired before execution, released after.
- Queued messages wait with exponential backoff on lock acquisition.
- Queue depth limit: configurable (default 10). Messages beyond the limit receive structured rejection.
- Client receives `execution.queued` event so UI can show "processing previous message..."

### Preemptive

New message cancels the running execution and starts immediately.

```
Message 1 arrives → Execution 1 (status: running)
Message 2 arrives → Execution 1 cancelled (AbortSignal)
                     Execution 2 (status: running)
```

- New message triggers `AbortController.abort()` on the active execution.
- Cancelled execution's partial conversation history is preserved (up to the last complete turn).
- LLM streaming stops mid-response. Client receives `execution.cancelled` followed by `execution.started`.
- No queue — at most one active execution. Preemption scope: active only (not queued).

### Parallel

Messages execute concurrently on isolated threads.

```
Message 1 arrives → Execution 1 (status: running, thread 1)
Message 2 arrives → Execution 2 (status: running, thread 2)
                     Both execute concurrently
```

- Each execution gets an isolated thread via `createChildSession` from `packages/execution`.
- Conversation history merged in arrival order after completion.
- Suitable for stateless agents (Q&A bots, search, classification).
- Concurrency limit: `execution.max_concurrent_messages` (default 3).
- Compiler emits warning if used with scripted mode or agents with GATHER steps.

---

## Queue Depth Feedback

### Queued Event

```typescript
{
  type: 'execution_queued',
  executionId: 'exec-abc123',
  position: 2,
  estimatedWaitMs: 15000,
  queueDepth: 3,
}
```

`estimatedWaitMs` computed from rolling average of recent execution durations (stored in Redis: `exec:avg:{sessionId}`, 60s TTL).

### Rejection Event

```typescript
{
  type: 'execution_rejected',
  reason: 'queue_full',
  message: 'Agent is currently processing multiple messages. Please wait.',
  queueDepth: 10,
  retryAfterMs: 5000,
}
```

For HTTP chat routes, queue-full maps to HTTP 429 with the same payload as response body.

---

## Message Deduplication

Prevents duplicate processing from client retries, network glitches, or double-clicks.

**Algorithm:**

1. On `submit()`, compute SHA-256 of `sessionId + message + JSON.stringify(attachmentIds)`.
2. `SET exec:dedup:{hash} {executionId} NX PX 5000` in Redis.
3. If SET returns null (key existed) → duplicate. Return existing execution.
4. If SET succeeds → proceed with enqueue.

**Design decisions:**

- 5-second window: short enough to allow intentional repeats ("yes" → "yes"), long enough for retries.
- Content-hash based, not client-ID based. Clients don't need to generate unique IDs.
- Transparent to client: existing execution is returned, client can subscribe to its events.

**Future consideration:** Client-supplied `idempotency_key` for explicit dedup control in SDK v2.

---

## Integration Points

### WebSocket Handler Changes

Both `handler.ts` and `sdk-handler.ts` replace direct `executeMessage()` calls:

```typescript
// BEFORE (handler.ts — handleSendMessage)
const result = await executor.executeMessage(sessionId, text, onChunk, onTraceEvent);

// AFTER
const execution = await coordinator.submit(sessionId, text, {
  attachmentIds,
  onChunk,
  onTraceEvent,
  callerContext: clientState.tenantContext,
});
```

`submit()` is async and resolves when the execution completes (not when queued). Preserves current behavior. `execution.queued` event is sent as a side effect during the wait.

### SDK Handler Simplification

The existing `enqueueLLMRequest` path is replaced entirely by `ExecutionCoordinator.submit()`. The coordinator handles locking internally, eliminating separate `enqueueLLMRequest` / `acquireSessionLock` code.

### HTTP Chat Route Changes

```typescript
const execution = await coordinator.submit(sessionId, message, { ...options });
res.json({
  executionId: execution.executionId,
  response: execution.response,
  status: execution.status,
});
```

### RuntimeExecutor Changes

`executeMessage()` becomes internal — only `ExecutionCoordinator` calls it.

```typescript
class RuntimeExecutor {
  /** @internal — called only by ExecutionCoordinator */
  executeMessage(
    sessionId: string,
    userMessage: string,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: TraceEvent) => void,
    options?: ExecuteMessageOptions,
  ): Promise<ExecutionResult>;
}
```

No changes to `executeMessage` signature or internals in Phase 1. Coordinator wraps it with queue + lock + lifecycle management.

### enqueueLLMRequest Deprecation

The `enqueueLLMRequest` function in `llm-queue.ts` and its session lock acquisition become redundant. BullMQ global queue remains for LLM concurrency control (backpressure). Per-session ordering moves to the coordinator.

---

## Persistence & Observability

### Active Execution State (Redis)

```
exec:active:{sessionId}    → JSON(Execution)        # Current running execution
exec:queue:{sessionId}     → LIST[JSON(Execution)]   # Pending queue (RPUSH/LPOP)
exec:dedup:{hash}          → executionId             # Dedup window (5s TTL)
exec:avg:{sessionId}       → float                   # Rolling avg execution time (60s TTL)
run:lock:{sessionId}       → lockOwner               # Existing session lock (reused)
```

**TTLs:**

- `exec:active:*` — 5 minutes (safety: stale active record expires if pod dies)
- `exec:queue:*` — 10 minutes (queued messages shouldn't sit forever)
- `exec:dedup:*` — 5 seconds
- `exec:avg:*` — 60 seconds

### Completed Execution Archive (ClickHouse)

On completion, execution is archived as trace events:

```typescript
{ type: 'execution.started', data: { executionId, sessionId, agentName, message } }
{ type: 'execution.completed', data: { executionId, status, durationMs, tokenUsage } }
{ type: 'execution.failed', data: { executionId, error: { code, message } } }
{ type: 'execution.cancelled', data: { executionId, reason } }
```

These flow through the existing `TraceStore` (ClickHouse backend).

**Design decision: No MongoDB in Phase 1.** Executions are high-volume, append-only, time-series data — ClickHouse's sweet spot. MongoDB adds another write per message in the hot path.

### Metrics

| Metric                    | Type      | Labels                                |
| ------------------------- | --------- | ------------------------------------- |
| `execution_queue_depth`   | gauge     | `session`, `tenant`                   |
| `execution_queue_wait_ms` | histogram | `agent`, `tenant`                     |
| `execution_duration_ms`   | histogram | `agent`, `status`, `concurrency_mode` |
| `execution_dedup_count`   | counter   | `tenant`                              |
| `execution_preempt_count` | counter   | `agent`, `tenant`                     |
| `execution_reject_count`  | counter   | `agent`, `tenant`, `reason`           |

---

## Client-Side Protocol Changes

### Server → Client Events (new)

```typescript
interface ExecutionQueuedEvent {
  type: 'execution_queued';
  executionId: string;
  position: number;
  estimatedWaitMs?: number;
}

interface ExecutionStartedEvent {
  type: 'execution_started';
  executionId: string;
  agentName: string;
}

interface ExecutionCancelledEvent {
  type: 'execution_cancelled';
  executionId: string;
  reason: 'preempted' | 'timeout' | 'client_cancel';
}

interface ExecutionRejectedEvent {
  type: 'execution_rejected';
  reason: 'queue_full';
  message: string;
  queueDepth: number;
  retryAfterMs: number;
}
```

### Client → Server Events (new)

```typescript
interface CancelExecutionMessage {
  type: 'cancel_execution';
  executionId?: string; // If omitted, cancel active execution
}
```

### Studio UI Changes (future — separate sprint)

1. **Queue indicator**: On `execution_queued`, show "Processing previous message... (position N)"
2. **Cancel button**: "Stop generating" sends `cancel_execution`. Automatic for preemptive agents.
3. **Preempted state**: On `execution_cancelled` with reason `preempted`, truncate streaming response and mark "(cancelled)"
4. **Fan-out progress**: With `executionId` on all events, render parallel agent progress visualization

### SDK Client Changes (future — separate sprint)

- Handle new event types
- Expose `cancel()` method
- Expose `onQueued` callback
- Client-side dedup defense in depth (warn on duplicate messages within window)

---

## Design Decisions Summary

| Decision                  | Choice                              | Rationale                                                  |
| ------------------------- | ----------------------------------- | ---------------------------------------------------------- |
| Run vs Execution          | **Merged into Execution**           | Single concept = less cognitive overhead                   |
| Queue backend             | **Redis (RPUSH/LPOP)**              | Cross-pod consistency. Already a dependency.               |
| Persistence               | **Redis (hot) + ClickHouse (cold)** | Executions are high-volume time-series → ClickHouse        |
| Concurrency config        | **Agent IR field**                  | `execution.concurrency`. Compile-time, not runtime toggle. |
| Default concurrency       | **Serial**                          | Safest. No behavior change for existing agents.            |
| Queue depth limit         | **10 (configurable via IR)**        | Prevents unbounded growth. Structured rejection.           |
| Dedup strategy            | **Content hash + 5s Redis TTL**     | Catches retries, transparent to client.                    |
| Lock mechanism            | **Existing Redis SET NX**           | Reuse `SessionService.acquireLock()`.                      |
| executeMessage visibility | **Internal (coordinator-only)**     | Single entry point. No bypass.                             |
| enqueueLLMRequest         | **Deprecated**                      | Coordinator replaces it. BullMQ global queue remains.      |
| Client feedback           | **Structured events**               | Not HTTP status codes. Rich context.                       |
| Preemption scope          | **Active only**                     | New message cancels running, not queued.                   |
| Parallel isolation        | **createChildSession**              | Reuses packages/execution pattern.                         |
| Estimated wait time       | **Rolling average**                 | Good enough for UI feedback. Not precise.                  |

---

## Future Considerations

| Item                                   | When                                 | What                                                                                                                                                                                                |
| -------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MongoDB `executions` collection**    | Billing/retry/admin dashboard sprint | Mongoose model mirroring Execution interface. Write to MongoDB in parallel with ClickHouse. Needed for: transactional billing ledger, execution retry from original input, admin dashboard queries. |
| **Client idempotency_key**             | SDK v2                               | Client-supplied dedup key instead of content hash                                                                                                                                                   |
| **Execution replay/retry**             | After MongoDB migration              | Re-execute failed execution with original input from MongoDB                                                                                                                                        |
| **Rate limiting per concurrency mode** | If parallel mode abused              | Per-agent rate limits on concurrent executions                                                                                                                                                      |
| **Restate integration**                | Phase 3                              | `RestateExecutionCoordinator` wraps submissions in durable workflows. Maps to Restate virtual object per session. Queue and lock managed by Restate's built-in ordering.                            |
| **Studio execution timeline**          | UI sprint                            | Visual timeline of executions per session with status, duration, token cost. Fan-out children shown as nested spans.                                                                                |
| **Execution cost attribution**         | Billing sprint                       | Per-execution token cost → tenant billing ledger. Requires MongoDB for transactional writes.                                                                                                        |
| **Queue priority**                     | If needed                            | Priority queue (system > user) for preemptive agents                                                                                                                                                |
| **Execution webhooks**                 | Integration sprint                   | Notify external systems on execution lifecycle events (started, completed, failed)                                                                                                                  |
| **Long-running execution health**      | Monitoring sprint                    | Heartbeat mechanism for executions running >30s. Detect stuck executions. Alert on execution duration anomalies.                                                                                    |

---

## Package Layout (see Implementation Plan below for file details)

```
packages/
  execution/                          ← EXISTING (extend)
    src/
      types.ts                        ← Add: Execution, ExecutionQueue, ExecutionCoordinator interfaces
      in-process-runtime.ts           ← EXISTING (no change)
      child-session.ts                ← EXISTING (no change)
      semaphore.ts                    ← EXISTING (no change)
      execution-queue.ts              ← NEW: ExecutionQueue interface + InMemoryExecutionQueue
      index.ts                        ← Update exports

apps/runtime/src/
  services/
    execution/
      execution-coordinator.ts        ← NEW: ExecutionCoordinator implementation
      redis-execution-queue.ts        ← NEW: RedisExecutionQueue implementation
      execution-dedup.ts              ← NEW: Deduplication service
      routing-executor.ts             ← MODIFIED: minor (execution events)
    runtime-executor.ts               ← MODIFIED: executeMessage becomes @internal
    llm/
      llm-queue.ts                    ← MODIFIED: deprecate enqueueLLMRequest
  websocket/
    handler.ts                        ← MODIFIED: use coordinator.submit()
    sdk-handler.ts                    ← MODIFIED: use coordinator.submit()
  routes/
    chat.ts                           ← MODIFIED: use coordinator.submit()

packages/compiler/src/
  ir/types.ts                         ← MODIFIED: add concurrency field to execution
  compiler.ts                         ← MODIFIED: parse CONCURRENCY from DSL
```

---

## End-to-End Flow

```
User message via WebSocket
    │
    ▼
WebSocket Handler
    │ coordinator.submit(sessionId, message, options)
    │
    ▼
ExecutionCoordinator.submit()
    │
    ├── Dedup check (Redis SET NX)
    │   └── If duplicate → return existing Execution
    │
    ├── Create Execution (status: 'queued')
    │
    ├── Read concurrency strategy from agent IR
    │   ├── serial    → enqueue, acquire lock, wait turn
    │   ├── preemptive → cancel active, acquire lock
    │   └── parallel  → acquire semaphore permit
    │
    ├── Transition to 'running'
    │   ├── Set exec:active:{sessionId} in Redis
    │   ├── Emit execution.started trace event
    │   └── Send execution_started to client
    │
    ├── RuntimeExecutor.executeMessage(sessionId, message)
    │   ├── LLM inference (streaming chunks to client)
    │   ├── Tool calls, flow steps, constraints
    │   └── Return ExecutionResult
    │
    ├── Transition to 'completed' (or 'failed')
    │   ├── Clear exec:active:{sessionId}
    │   ├── Update exec:avg:{sessionId}
    │   ├── Emit execution.completed trace event
    │   ├── Archive to ClickHouse
    │   └── Dequeue next (if serial mode)
    │
    └── Return Execution to caller
         │
         ▼
    WebSocket Handler
         │ send responseEnd
```

## Implementation Plan

**Goal:** Add per-session message queuing, configurable concurrency strategies (serial/preemptive/parallel), execution lifecycle tracking, and message deduplication to prevent concurrent message corruption.

**Architecture:** Extend `packages/execution/` with `Execution` and `ExecutionQueue` types. Implement `ExecutionCoordinator` in `apps/runtime/src/services/execution/` as the single entry point for all message processing. Wire into all three callers (debug WS handler, SDK WS handler, HTTP chat route). Redis-backed queue + ClickHouse trace archive.

**Tech Stack:** TypeScript, Vitest (pool: forks), Redis (RPUSH/LPOP, SET NX PX), pnpm workspace, AbortController/AbortSignal (Node.js native)

The implementation is organized into 14 tasks with ~51 tests and ~1,060 lines of production code + tests. Full task-by-task breakdown is in the implementation plan (previously `2026-03-01-concurrent-execution-model-plan.md`).

---

### Task Summary

| Task | Component                   | Tests | Estimated Lines   |
| ---- | --------------------------- | ----- | ----------------- |
| 1    | Execution type + factory    | 3     | ~80               |
| 2    | ExecutionQueue + InMemory   | 5     | ~120              |
| 3    | Dedup service               | 6     | ~100              |
| 4    | IR concurrency fields       | 4     | ~10               |
| 5    | ExecutionCoordinator (core) | 6     | ~250              |
| 6    | WS lifecycle events         | 5     | ~50               |
| 7    | Wire handler.ts             | 3     | ~30 (net change)  |
| 8    | Wire sdk-handler.ts         | 3     | ~30 (net change)  |
| 9    | Wire chat.ts                | 2     | ~20 (net change)  |
| 10   | Singleton wiring            | 0     | ~30               |
| 11   | RedisExecutionQueue         | 5     | ~100              |
| 12   | Trace events                | 4     | ~40               |
| 13   | E2E integration tests       | 5     | ~200 (tests only) |
| 14   | Build/test/verify           | 0     | 0                 |

### Task 1: Add Execution Type to `packages/execution`

**Files:** Modify `packages/execution/src/types.ts`, `packages/execution/src/index.ts`. Create `packages/execution/src/__tests__/execution-types.test.ts`.

Add `ExecutionStatus` type, `Execution` interface, `CreateExecutionInput` interface, and `createExecution()` factory function to `types.ts`. The factory generates `exec-{uuid}` IDs, sets status to `queued`, and records `queuedAt` timestamp. Export all types and the factory from `index.ts`.

### Task 2: Add ExecutionQueue Interface and InMemoryExecutionQueue

**Files:** Create `packages/execution/src/execution-queue.ts`, test file.

Define `ExecutionQueue` interface with `enqueue`, `dequeue`, `peek`, `length`, `cancelAll`, `getActive`, `setActive`, `clearActive` methods. Implement `InMemoryExecutionQueue` using `Map<string, Execution[]>` for queues and `Map<string, Execution>` for active tracking. Per-session isolation via sessionId keys.

### Task 3: Add Execution Deduplication Service

**Files:** Create `apps/runtime/src/services/execution/execution-dedup.ts`, test file.

Define `DedupStore` interface with `get`/`set` methods. Implement `InMemoryDedupStore` with TTL-based expiry. `ExecutionDedup` class computes SHA-256 hash of `sessionId + message + attachmentIds`, uses `DedupStore` to check/record with configurable TTL (default 5s).

### Task 4: Add `concurrency` Field to Agent IR

**Files:** Modify `packages/compiler/src/platform/ir/schema.ts`.

Add to `ExecutionConfig`: `concurrency?: 'serial' | 'preemptive' | 'parallel'`, `max_queue_depth?: number`, `max_concurrent_messages?: number`.

### Task 5: Implement ExecutionCoordinator

**Files:** Create `apps/runtime/src/services/execution/execution-coordinator.ts`, test file.

Core orchestrator (~250 lines) implementing `submit()`, `cancel()`, `cancelSession()`, `getStatus()`. Reads concurrency strategy from agent IR. Serial: lock + FIFO queue. Preemptive: AbortController cancellation of active execution. Parallel: semaphore-gated concurrent execution. Lifecycle transitions: queued -> running -> completed/failed/cancelled/preempted.

### Task 6: Add Execution Lifecycle Events to WebSocket Protocol

**Files:** Modify `apps/runtime/src/websocket/events.ts`, `apps/runtime/src/types/index.ts`.

Add `ServerMessages.executionQueued()`, `.executionStarted()`, `.executionCancelled()`, `.executionRejected()`. Add `cancel_execution` to `parseClientMessage` and `ClientMessage` type union.

### Task 7: Wire ExecutionCoordinator into WebSocket Handler

**Files:** Modify `apps/runtime/src/websocket/handler.ts`.

Replace `executor.executeMessage()` call in `handleSendMessage` with `coordinator.submit()`. Add `cancel_execution` case to message handler switch.

### Task 8: Wire ExecutionCoordinator into SDK Handler

**Files:** Modify `apps/runtime/src/websocket/sdk-handler.ts`.

Replace `enqueueLLMRequest` call path with `coordinator.submit()`. The coordinator handles locking internally, eliminating separate lock acquisition code.

### Task 9: Wire ExecutionCoordinator into HTTP Chat Route

**Files:** Modify `apps/runtime/src/routes/chat.ts`.

Replace direct `executeMessage` with `coordinator.submit()`. Map `QueueFullError` to HTTP 429 with structured response body.

### Task 10: Coordinator Initialization and Singleton Wiring

**Files:** Modify `apps/runtime/src/server.ts`.

Create coordinator singleton after RuntimeExecutor, pass to all handler factories. Use `RedisExecutionQueue` when Redis is available, `InMemoryExecutionQueue` otherwise.

### Task 11: RedisExecutionQueue Implementation

**Files:** Create `apps/runtime/src/services/execution/redis-execution-queue.ts`.

Redis operations: `RPUSH`/`LPOP`/`LINDEX`/`LLEN`/`LRANGE`+`DEL` for queue, `SET`/`GET`/`DEL` with TTL for active tracking. Queue TTL 10 min, active TTL 5 min. Also add `RedisDedupStore` using `SET NX PX`.

### Task 12: Execution Trace Events (ClickHouse Archive)

Emit `execution.started`, `execution.completed`, `execution.failed`, `execution.cancelled` trace events through existing `TraceStore` -> ClickHouse pipeline on lifecycle transitions.

### Task 13: Integration Test — Full E2E Concurrent Messages

Test suites for: serial mode (5 concurrent FIFO), preemptive mode (rapid fire), parallel mode (3 concurrent), dedup (double click), cross-session isolation.

### Task 14: Build, Test Full Suite, Verify

Full `pnpm build`, full test suite across runtime/execution/compiler, type check, regression verification.

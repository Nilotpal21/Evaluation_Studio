# Execution Model Redesign — Round 2 Review

**Date:** 2026-02-28
**Scope:** Second review of the 16 fixes applied in Round 1, examining correctness, scale, race conditions, logging, and traceability.
**Review areas:** Correctness of each fix, scale/concurrency safety, race conditions, logging completeness, trace event coverage.

---

## Status Summary

Round 1 applied 16 fixes (C1-C3, C5-C7, I1-I6, I8-I11). Round 2 found 19 new issues in those fixes, cross-reviewed for accuracy. 14 confirmed real, 2 partially accurate, 1 false positive, 2 minor.

| Issue | Severity  | Category     | Verified            | Status                                          |
| ----- | --------- | ------------ | ------------------- | ----------------------------------------------- |
| R1    | Critical  | Scale        | Confirmed (97)      | FIXED — config wired, default raised to 10      |
| R2    | Critical  | Race         | Confirmed (95)      | FIXED — `.catch()` on detached promise          |
| R3    | Critical  | Traceability | Confirmed (98)      | FIXED — storageKey uses parentSessionId         |
| R4    | Critical  | Traceability | Confirmed (93)      | FIXED — fanOutTraceEvent wrapper for all events |
| R5    | Important | Race         | Partially (62)      | FIXED — object refs replace index tracking      |
| R6    | Critical  | Correctness  | Confirmed (97)      | FIXED — cleanup in finally block                |
| R7    | Critical  | Correctness  | Confirmed (98)      | FIXED — typed abortHandler closure              |
| R8    | Important | Traceability | Confirmed (97)      | FIXED — 5 types added to TraceEventType         |
| R9    | Important | Traceability | Confirmed (90)      | FIXED — semaphore wait time tracked             |
| R10   | Important | Traceability | Confirmed (97)      | FIXED — startTime after acquire()               |
| R11   | Important | Traceability | Confirmed (88)      | FIXED — totalDurationMs in fan_out_complete     |
| R12   | Important | Traceability | Confirmed (87)      | FIXED — channel/identityTier in fan_out_start   |
| R13   | Important | Traceability | Confirmed (95)      | FIXED — trace event before early return         |
| R14   | Important | Logging      | Confirmed (87)      | FIXED — debug logs on both paths                |
| R15   | Important | Logging      | Confirmed (88)      | FIXED — thread pruning debug log                |
| R16   | Important | Testing      | Confirmed (90)      | FIXED — executionId + durationMs assertions     |
| R17   | Important | Testing      | Confirmed (97)      | FIXED — order-independent callMessages check    |
| R18   | Important | Clarity      | Partially (72)      | FIXED — documentation comment added             |
| R19   | Retracted | Race         | False positive (30) | N/A — no change needed                          |

---

## Critical Issues

### R1: Singleton semaphore shared across all sessions — cross-session head-of-line blocking

**Files:** `apps/runtime/src/services/execution/routing-executor.ts:88-92`

**Description:** `fanOutSemaphore` is an instance field on `RoutingExecutor` with a hardcoded capacity of 3. `RoutingExecutor` is constructed once inside `RuntimeExecutor`'s constructor, and `RuntimeExecutor` is a process-wide singleton (`getRuntimeExecutor()`). This means the semaphore with capacity 3 is shared across every session on the pod simultaneously.

If 10 sessions each trigger a fan-out with 3 targets at the same time, all 30 `executeUnit` calls queue against the same 3 slots. Sessions that arrive first monopolize the semaphore; all other sessions stall until those LLM calls finish. A slow LLM call on session A directly delays session B's fan-out.

Additionally, `DEFAULT_MAX_CONCURRENT_FAN_OUT_CALLS = 3` is a hardcoded magic number, violating CLAUDE.md: "No inline numeric literals for limits, timeouts, iteration caps, or token counts."

```typescript
// routing-executor.ts:88-92
const DEFAULT_MAX_CONCURRENT_FAN_OUT_CALLS = 3;

export class RoutingExecutor {
  private executionRuntime = new InProcessExecutionRuntime();
  private fanOutSemaphore = new CountingSemaphore(DEFAULT_MAX_CONCURRENT_FAN_OUT_CALLS);
```

**Impact:**

- **Cross-session starvation:** Under load, sessions compete for 3 global slots. A pod with 100 concurrent sessions can only run 3 LLM calls at a time across all fan-outs.
- **Magic number:** Capacity not configurable via `RuntimeExecutorConfig` or `ExecutionConfig.maxConcurrentLLMCalls` (which already exists but is never wired).

**Resolution:** Read capacity from `ctx.config.maxConcurrentFanOutCalls` (or fall back to `DEFAULT_MAX_CONCURRENT_FAN_OUT_CALLS`). Add `maxConcurrentFanOutCalls` to `RuntimeExecutorConfig`. The capacity should be a pod-level throttle (e.g., 20-50), not a per-session limit of 3.

```typescript
constructor(private ctx: ExecutorContext, private llmWiring: LLMWiringService) {
  const capacity = ctx.config.maxConcurrentFanOutCalls ?? DEFAULT_MAX_CONCURRENT_FAN_OUT_CALLS;
  this.fanOutSemaphore = new CountingSemaphore(capacity);
}
```

---

### R2: Detached `executeMessage` promise after `Promise.race` abort — unhandled rejection risk

**Files:** `apps/runtime/src/services/execution/routing-executor.ts:1088-1134`

**Description:** When `abortPromise` wins the `Promise.race` (timeout fires), the `executeMessage` promise is still in-flight. Control enters the `catch` block, then the `finally` block cleans up: releases the semaphore, unmarks executing, and deletes the child session from the sessions map. But the detached `executeMessage` continues executing asynchronously with no `.catch()` handler — any error it throws becomes an unhandled rejection. It also continues mutating `childThread` state (which has already been pruned from `session.threads`), and may call `debouncedPersist` on a session that no longer exists in the map.

```typescript
const result = await Promise.race([
  this.ctx.executeMessage(childSessionId, unit.message, undefined, childTraceEvent),
  abortPromise, // ← if this wins, executeMessage is detached with no .catch()
]);
```

**Impact:**

- **Unhandled rejection:** If the detached `executeMessage` throws after cleanup, Node.js emits an `unhandledRejection` event which can crash the process.
- **Stale mutations:** Detached execution writes to `childThread.status`, `data`, etc. after the thread has been pruned.
- **Sessions map confusion:** `executeMessage` may try to read `sessions.get(childSessionId)` on a subsequent async tick and find `undefined`.

**Resolution:** Capture the raw promise and attach a `.catch()` handler before racing:

```typescript
const executePromise = this.ctx.executeMessage(
  childSessionId,
  unit.message,
  undefined,
  childTraceEvent,
);
// Prevent unhandled rejection if we win the race via abort
executePromise.catch((err) => {
  log.warn('Detached fan-out child execution failed after abort', {
    executionId,
    target: unit.agentName,
    error: err instanceof Error ? err.message : String(err),
  });
});
const result = await Promise.race([executePromise, abortPromise]);
```

---

### R3: C6 fix incomplete — child trace events still stored under ephemeral sessionId in TraceStore

**Files:** `apps/runtime/src/services/runtime-executor.ts:1029-1048`

**Description:** The C5/C6 fix added a `childTraceEvent` wrapper (routing-executor.ts:1003-1014) that injects `executionId` and `parentSessionId` into event `data`. However, inside `executeMessage`, `createCentralizedTraceHandler` is called at line 1141 with the first argument being `sessionId` — which for a child session is the ephemeral `childSessionId`. The `TraceStore.addEvent(sessionId, traceEvent)` at line 1048 then stores all child-emitted events (LLM calls, tool calls, decisions) under the child's ephemeral key.

After fan-out completes, the child session is deleted from the sessions map. The trace events remain in the TraceStore under a key that no API or Observatory query will ever request. The `parentSessionId` field is in the event `data`, but the storage key is still wrong.

```typescript
// runtime-executor.ts:1029-1048 — called from executeMessage(childSessionId, ...)
private createCentralizedTraceHandler(
  sessionId: string,       // ← this is childSessionId for fan-out children
  tenantId, agentName, projectId,
  originalOnTraceEvent,
) {
  return (event) => {
    const traceEvent = { id: crypto.randomUUID(), sessionId, ... };
    getTraceStore().addEvent(sessionId, traceEvent);  // ← stored under unreachable key
    // ...
  };
}
```

**Impact:**

- **Lost traces:** All child-agent trace events (LLM calls, tool calls, decisions) are invisible to Observatory and the trace API. An operator querying "show me all LLM calls for session X" will see zero child events.
- **Memory waste:** Trace events accumulate under keys that are never queried or garbage-collected.

**Resolution:** The `childTraceEvent` wrapper should override the session context to store under the parent session ID. Two options:

Option A: Pass `parentSessionId` through the event data and have `createCentralizedTraceHandler` check for it:

```typescript
// In createCentralizedTraceHandler:
const storageKey = (event.data?.parentSessionId as string) || sessionId;
getTraceStore().addEvent(storageKey, traceEvent);
```

Option B: Have `handleFanOut` pass the parent session ID as the `sessionId` parameter when calling `executeMessage` for children (requires `executeMessage` to accept a trace-session-ID override).

Option A is simpler and self-contained.

---

### R4: Coordinator events bypass `childTraceEvent` wrapper — asymmetric `parentSessionId` injection

**Files:** `apps/runtime/src/services/execution/routing-executor.ts:1026-1035, 1165-1175, 1228-1237`

**Description:** The `childTraceEvent` wrapper injects both `executionId` and `parentSessionId` into child-emitted events. However, the four coordinator-level events (`fan_out_start`, `fan_out_task_start`, `fan_out_task_complete`, `fan_out_complete`) call `onTraceEvent` directly — not `childTraceEvent`. These events manually include `executionId` but omit `parentSessionId`. This creates an asymmetry: child events have both fields, coordinator events have only `executionId`.

Additionally, `fan_out_task_start` is emitted at line 1026 before `childSessionId` is computed at line 1041, so it cannot include `childSessionId` for cross-correlation.

```typescript
// Line 1026 — calls onTraceEvent directly (not childTraceEvent)
onTraceEvent?.({
  type: 'fan_out_task_start',
  data: {
    executionId,
    index: executableTasks.findIndex((t) => t.target === unit.agentName),
    target: unit.agentName,
    intent: unit.message,
    agentName: currentThread.agentName,
    // Missing: parentSessionId, childSessionId
  },
});
```

**Impact:**

- **Inconsistent correlation:** An operator cannot use `parentSessionId` as a universal correlation key across all events — it's only on child events.
- **No child-to-task linking:** `fan_out_task_start` has no `childSessionId`, so there's no way to link it to downstream child trace events.

**Resolution:**

1. Compute `childSessionId` before `fan_out_task_start` (the formula is deterministic: `${session.id}__fanout__${executionId}__${unit.agentName}`).
2. Add `parentSessionId: session.id` and `childSessionId` to all coordinator events.
3. Alternatively, route coordinator events through `childTraceEvent` wrapper too (it just adds fields and forwards).

---

### R5: Index-based `childThread` lookup fragile under concurrent handoffs (RECLASSIFIED: Important)

**Files:** `apps/runtime/src/services/execution/routing-executor.ts:988-1000, 1022, 1217-1226`

**Description:** `childThreadIndices` maps `agentName → session.threads.length - 1` at thread creation time. During parallel execution, `executeUnit` reads `session.threads[childIndex]` at line 1022.

**Note:** Re-entrant fan-out (a child agent triggering another fan-out) is blocked by the `_fan_out_child: true` guard. However, concurrent handoffs from the parent session (outside the fan-out) or delegate operations within children could still call `createThread(session, ...)` on the parent session, shifting indices. The `createChildSession` threads clone (I2 fix) prevents child-triggered `createThread` from affecting the parent's array, but any concurrent operation on the parent session itself could mutate `session.threads`.

The thread pruning step (line 1219) also uses these indices to filter: `session.threads.filter((_, i) => !childIndicesSet.has(i))`. Stale indices could prune the wrong threads.

```typescript
// Line 988-1000: indices captured at creation time
childThreadIndices.set(task.target, session.threads.length - 1);

// Line 1022: index used during parallel execution (may be stale)
const childThread = session.threads[childIndex];

// Line 1219: indices used for pruning (may be stale)
session.threads = session.threads.filter((_, i) => !childIndicesSet.has(i));
```

**Impact:**

- **Data corruption:** Under concurrent parent-session mutations, reads the wrong thread or prunes wrong threads.
- Object references are inherently stable and eliminate this class of bug entirely.

**Resolution:** Store thread object references instead of indices (also remove line 1153 `savedActiveIndex` restoration — see Correction 4):

```typescript
const childThreadRefs = new Map<string, AgentThread>();
for (const task of executableTasks) {
  createThread(session, task.target, targetInfo.ir, { ... });
  childThreadRefs.set(task.target, session.threads[session.threads.length - 1]);
}

// In executeUnit:
const childThread = childThreadRefs.get(unit.agentName)!;

// In pruning:
const childThreadSet = new Set(childThreadRefs.values());
session.threads = session.threads.filter((t) => !childThreadSet.has(t));
```

Also update `activeThreadIndex` re-resolution to use reference-based lookup:

```typescript
const parentThreadRef = currentThread; // captured before fan-out
const newIndex = session.threads.indexOf(parentThreadRef);
if (newIndex >= 0) session.activeThreadIndex = newIndex;
```

---

### R6: I4 fix incomplete — abort listener not removed on error path

**Files:** `apps/runtime/src/services/execution/routing-executor.ts:1098-1124`

**Description:** The I4 fix removes the abort listener after a successful `Promise.race` (lines 1098-1101), but the `catch` block (lines 1115-1124) does not include the same cleanup. When `executeMessage` throws a non-abort error (e.g., LLM failure), the handler stays registered on the `signal` until the signal object is GC'd.

```typescript
try {
  const result = await Promise.race([...]);
  // (I4) Remove abort listener on success — PRESENT
  if ((onAbort as any).__handler) {
    (onAbort as any).__signal.removeEventListener('abort', (onAbort as any).__handler);
  }
  // ...
} catch (error) {
  // (I4) Remove abort listener on error — MISSING
  childThread.status = 'completed';
  // ...
}
```

**Impact:**

- **Listener accumulation:** Each child that errors (non-abort) leaves a dangling listener on the shared `AbortController.signal`. The listener holds closure references to `Error` objects and the `unit`.

**Resolution:** Move listener cleanup to the `finally` block so it runs on all paths:

```typescript
} finally {
  // Remove abort listener on all paths (success, error, timeout)
  if (abortHandler) {
    signal.removeEventListener('abort', abortHandler);
  }
  this.fanOutSemaphore.release();
  // ...
}
```

---

### R7: `any`-cast pattern for abort handler storage violates no-`any` rule

**Files:** `apps/runtime/src/services/execution/routing-executor.ts:1073-1101`

**Description:** The abort handler reference is stored on a function object using `(onAbort as any).__handler` and `(onAbort as any).__signal`. This violates CLAUDE.md: "No `any` where structured types exist." The pattern is unnecessary — a simple closure variable achieves the same result with type safety.

```typescript
const onAbort = () => {};
const abortPromise = new Promise<never>((_, reject) => {
  // ...
  (onAbort as any).__handler = handler; // ← any cast
  (onAbort as any).__signal = signal; // ← any cast
});
// ...
if ((onAbort as any).__handler) {
  // ← any cast
  (onAbort as any).__signal.removeEventListener('abort', (onAbort as any).__handler);
}
```

**Impact:**

- **Type safety bypass:** 5 `any` casts in a critical code path.
- **Fragile:** Property names are untyped strings — typo would silently break cleanup.
- **Code smell:** Storing state on a function object as properties.

**Resolution:** Replace with a typed closure variable:

```typescript
let abortHandler: (() => void) | undefined;

const abortPromise = new Promise<never>((_, reject) => {
  if (signal.aborted) {
    reject(new Error(`...`));
    return;
  }
  abortHandler = () => reject(new Error(`Fan-out to ${unit.agentName} timed out`));
  signal.addEventListener('abort', abortHandler, { once: true });
});

// In finally block:
if (abortHandler) signal.removeEventListener('abort', abortHandler);
```

---

## Important Issues

### R8: `TraceEventType` union missing fan-out event types

**Files:** `apps/runtime/src/types/index.ts:44-80`

**Description:** The `TraceEventType` union has 37 members but does not include `fan_out_start`, `fan_out_task_start`, `fan_out_task_complete`, or `fan_out_complete`. In `createCentralizedTraceHandler`, `event.type` is cast with `as TraceEventType` (line 1041), which silently accepts invalid strings at runtime. If ClickHouse schema validates the `type` column, fan-out events could be dropped or cause insertion errors.

**Resolution:** Add the four fan-out types to `TraceEventType`:

```typescript
// Fan-out coordination events
| 'fan_out_start'
| 'fan_out_task_start'
| 'fan_out_task_complete'
| 'fan_out_complete'
```

---

### R9: Semaphore wait time invisible in traces

**Files:** `apps/runtime/src/services/execution/routing-executor.ts:1068-1069`

**Description:** `await this.fanOutSemaphore.acquire()` can block for seconds when all slots are taken. No trace event or log captures this wait. An operator cannot distinguish "child was slow because LLM was slow" from "child waited 15 seconds for a semaphore slot."

**Resolution:** Capture semaphore wait time and include in `durationMs` breakdown:

```typescript
const semaphoreWaitStart = Date.now();
await this.fanOutSemaphore.acquire();
const semaphoreWaitMs = Date.now() - semaphoreWaitStart;
if (semaphoreWaitMs > 100) {
  log.debug('Fan-out semaphore acquired after wait', {
    executionId,
    target: unit.agentName,
    semaphoreWaitMs,
  });
}
```

---

### R10: `fan_out_task_start` emitted before semaphore acquire — `durationMs` inflated

**Files:** `apps/runtime/src/services/execution/routing-executor.ts:1024-1069`

**Description:** `startTime = Date.now()` at line 1024 and `fan_out_task_start` at line 1026 both fire before `acquire()` at line 1069. The `durationMs` in `fan_out_task_complete` (computed as `Date.now() - startTime`) includes semaphore queue time, silently inflating the apparent task execution time.

**Resolution:** Move `startTime` capture and `fan_out_task_start` emission to after `acquire()`:

```typescript
await this.fanOutSemaphore.acquire();
const startTime = Date.now();
onTraceEvent?.({ type: 'fan_out_task_start', data: { ... } });
```

---

### R11: `fan_out_complete` missing `totalDurationMs`

**Files:** `apps/runtime/src/services/execution/routing-executor.ts:1228-1237`

**Description:** The `fan_out_complete` event includes task counts and failure counts, but no overall duration. Per CLAUDE.md: "every store operation, LLM call, and tool execution records duration."

**Resolution:** Capture `fanOutStartTime = Date.now()` after `createExecutionId()` at line 936, include `totalDurationMs: Date.now() - fanOutStartTime` in `fan_out_complete`.

---

### R12: `callerContext` absent from fan-out trace events

**Files:** `apps/runtime/src/services/execution/routing-executor.ts:965-1237`

**Description:** Per CLAUDE.md: "Trace events include caller identity (`tenantId`, `identityTier`, `channel`). No anonymous tool calls in production." All four coordinator-level events omit `callerContext`. `createCentralizedTraceHandler` injects `tenantId` into child events, but `identityTier` and `channel` are absent everywhere.

**Resolution:** Add `channel` and `identityTier` from `session.callerContext` to the `fan_out_start` event. Other events inherit via the `childTraceEvent` wrapper if it's used consistently (see R4).

---

### R13: Early-return on all-invalid tasks emits no trace event

**Files:** `apps/runtime/src/services/execution/routing-executor.ts:958-960`

**Description:** When all tasks reference unknown agents, `handleFanOut` returns early at line 958 before the `fan_out_start` event at line 965. An operator sees a fan-out tool call in the LLM trace but zero fan-out lifecycle events.

**Resolution:** Emit a `fan_out_start` event (or `fan_out_aborted`) before the early return:

```typescript
if (executableTasks.length === 0) {
  onTraceEvent?.({
    type: 'fan_out_start',
    data: {
      executionId,
      taskCount: 0,
      targets: [],
      agentName: currentThread.agentName,
      abortReason: 'all_tasks_invalid',
    },
  });
  return { success: false, results, failedCount: results.length };
}
```

---

### R14: `debouncedPersist` skip and `cancelPendingPersist` are silent

**Files:** `apps/runtime/src/services/runtime-executor.ts:1567-1618`

**Description:** When `debouncedPersist` skips a `__fanout__` session, it returns silently. When `cancelPendingPersist` cancels a timer, there is no log. These paths are correct but invisible — impossible to verify in production that the guards are working.

**Resolution:** Add `log.debug` on both paths:

```typescript
// debouncedPersist:
if (session.id.includes('__fanout__')) {
  log.debug('Skipping persist for ephemeral fan-out session', { sessionId: session.id });
  return;
}

// cancelPendingPersist:
if (timer) {
  log.debug('Cancelled pending persist for fan-out child', { sessionId });
  clearTimeout(timer);
  this.persistDebounceTimers.delete(sessionId);
}
```

---

### R15: Thread pruning untraceable

**Files:** `apps/runtime/src/services/execution/routing-executor.ts:1217-1226`

**Description:** Thread pruning modifies `session.threads` silently — no log or trace event records how many threads were removed or the new thread count.

**Resolution:** Add a debug log:

```typescript
const prunedCount = childIndicesSet.size;
session.threads = session.threads.filter((_, i) => !childIndicesSet.has(i));
log.debug('Pruned fan-out child threads', {
  executionId,
  prunedCount,
  remainingThreadCount: session.threads.length,
});
```

---

### R16: Tests don't verify `executionId` consistency or timeout trace events

**Files:** `apps/runtime/src/__tests__/fan-out.test.ts:600-660`

**Description:** Trace event tests verify ordering and counts but do not verify:

- `executionId` is present and consistent across all events from the same fan-out
- `parentSessionId` is injected by the `childTraceEvent` wrapper
- Timeout scenarios emit trace events with error status
- `durationMs` is present in `fan_out_task_complete` events

**Resolution:** Add targeted assertions:

```typescript
const executionId = startEvent.data.executionId;
expect(executionId).toBeDefined();
expect(typeof executionId).toBe('string');
events.forEach((e) => expect(e.data.executionId).toBe(executionId));
```

Add a separate test for trace events on timeout path.

---

### R17: Remaining position-based test assertion

**Files:** `apps/runtime/src/__tests__/fan-out.test.ts:561-562`

**Description:** The "passes intent as executeMessage input" test still uses `mock.mock.calls[0][1]` and `mock.mock.calls[1][1]` by index, assuming Flight_Agent is always called first.

```typescript
expect(mock.mock.calls[0][1]).toBe('Change my flight to Paris');
expect(mock.mock.calls[1][1]).toBe('Book a hotel in London');
```

**Resolution:** Use order-independent assertions:

```typescript
const callMessages = mock.mock.calls.map((c: any[]) => c[1]);
expect(callMessages).toContain('Change my flight to Paris');
expect(callMessages).toContain('Book a hotel in London');
```

---

### R18: `isRecursive` flag dual-purpose — undocumented implicit contract

**Files:** `apps/runtime/src/services/runtime-executor.ts:1115, 1130-1132`, `apps/runtime/src/services/execution/routing-executor.ts:1064`

**Description:** `markExecuting(childSessionId)` causes `executeMessage` to treat the fan-out child as a "recursive" call (`isRecursive = true`), which correctly suppresses stale checks and double-marking. But this is an undocumented side-effect reuse of a flag designed for handoff recursion.

The behavior is correct — `executeMessage` doesn't re-add to `_executingSessions`, and the `finally` in routing-executor owns the lifecycle. But the intent is invisible. A future developer changing the order of `markExecuting` relative to `executeMessage` could silently break the contract.

**Resolution:** Add explicit documentation comment at line 1064:

```typescript
// markExecuting BEFORE executeMessage so:
// 1. The stale session reaper cannot evict the child between sessions.set and executeMessage
// 2. executeMessage sees isRecursive=true, which correctly suppresses stale checks and
//    double-marking. routing-executor.ts's finally block (unmarkExecuting) is the sole
//    owner of the _executingSessions lifecycle for child sessions.
this.ctx.markExecuting(childSessionId);
```

---

### R18: `isRecursive` flag dual-purpose — undocumented implicit contract (RECLASSIFIED: Clarity issue)

**Cross-review verdict:** Partially accurate (confidence 72). This is a documentation/clarity issue, not a race condition. The behavior is correct by design — `markExecuting` before `executeMessage` causes `isRecursive = true`, which correctly suppresses stale checks. The risk is purely about future developer confusion, not runtime bugs.

**Resolution:** Add explicit documentation comment at line 1064 (unchanged).

---

### R19: `markExecuting`/`sessions.set` before `acquire()` — orphaned on exception (RETRACTED)

**Cross-review verdict:** False positive (confidence 30). `Map.set()` and `Set.add()` in JavaScript cannot throw under normal conditions. V8 heap exhaustion doesn't manifest as thrown exceptions from these operations — it crashes the entire process. The stated risk ("Map or Set has an OOM") is not a realistic failure mode in Node.js.

The proposed code reordering (moving `markExecuting`/`sessions.set` after `acquire()`) is still marginally better code organization, but the motivating scenario is not real. **No code change required.**

---

## Cross-Review Corrections

The following corrections were identified by cross-reviewing the issues and resolutions against the actual source code.

### Correction 1: R1 resolution prerequisite — `RuntimeExecutorConfig` must be updated

The R1 resolution proposes `ctx.config.maxConcurrentFanOutCalls` but `RuntimeExecutorConfig` (types.ts:157-161) only has `anthropicApiKey`, `model`, and `timeoutMs`. The fix must first add `maxConcurrentFanOutCalls?: number` to the interface.

### Correction 2: R3 Option A is incomplete — ClickHouse storage and `traceEvent.sessionId` also need fixing

Option A fixes `getTraceStore().addEvent(storageKey, ...)` (in-memory) but leaves:

1. `traceEvent.sessionId` set to the ephemeral child ID — event payload is inconsistent with storage key
2. `store.appendEvent(sessionId, ...)` at line 1057 — ClickHouse events remain unqueryable

The full fix requires:

```typescript
const storageKey = (event.data?.parentSessionId as string) || sessionId;
const traceEvent: TraceEventWithId = {
  id: crypto.randomUUID(),
  sessionId: storageKey,           // ← use parent ID as canonical session
  type: event.type as TraceEventType,
  timestamp: new Date(),
  data: { ...event.data, tenantId, childSessionId: sessionId }, // preserve child ID in data
  agentName: (event.data?.agentName as string) || agentName,
};
getTraceStore().addEvent(storageKey, traceEvent);
// ... in ClickHouse block:
store.appendEvent(storageKey, { ... });  // ← same key
```

### Correction 3: R5 re-entrant fan-out scenario is blocked by `_fan_out_child` guard

The R5 description states "if a child agent triggers another fan-out (re-entrant)..." but this path is explicitly blocked by the `_fan_out_child: true` marker in initialData (routing-executor.ts:996), which the fan-out handler checks before allowing nested fan-outs. Tests confirm: "blocks fan-out from within a fan-out child thread (via \_fan_out_child marker)".

The index-based lookup is still fragile for concurrent handoffs on the same parent session during a fan-out, so the object-reference fix is still good practice. **Severity reclassified from Critical to Important.**

### Correction 4: R5 resolution must remove line 1153 (`savedActiveIndex` restoration)

Line 1153 (`session.activeThreadIndex = savedActiveIndex`) runs before pruning. After pruning removes child threads, the saved numeric index may point to a wrong thread if children were inserted before the parent thread's position. The R5 reference-based resolution replaces the `find-by-name` at line 1223, but must also remove line 1153 — otherwise both assignments coexist, with line 1153 setting a potentially stale index immediately overwritten by the reference-based approach.

### Correction 5: R6 and R7 must be applied together

R6 moves listener cleanup to `finally`. R7 replaces `(onAbort as any).__handler` with a typed `abortHandler` variable. Applying R6 without R7 puts `any`-cast code in `finally`. Applying R7 without R6 only cleans up on success. Both must be applied atomically.

### Correction 6: R13 depends on R8

R13's early-return trace event uses `type: 'fan_out_start'`. Until R8 adds this to `TraceEventType`, the string is silently cast. R8 must be applied first.

### Correction 7: R15 logging must use R5's variable names

If R5 changes from index-based `childIndicesSet` to reference-based `childThreadSet`, R15's logging (`childIndicesSet.size`) must be updated to `childThreadSet.size`.

### Correction 8: R2 detached-promise stale mutations are benign post-pruning

The R2 description states "cleanup races with live execution" and "detached execution writes to `childThread.status`... after the thread has been pruned." These mutations are to an orphaned object no longer referenced by `session.threads` — they do not corrupt live state. The `debouncedPersist` guard (`__fanout__` check at runtime-executor.ts:1571) also prevents any Redis writes from the detached execution. The `.catch()` fix is still necessary to prevent unhandled rejections, but the stale-mutation concern is benign.

### Correction 9: R8 should also include `attachment_preprocess`

Line 1188 of `runtime-executor.ts` emits `type: 'attachment_preprocess'` which is also absent from `TraceEventType`. The R8 fix should include this type as well.

---

## Implementation Dependencies

The following dependency graph shows the order in which fixes must be applied:

```
R8 (TraceEventType) ← R13 (early-return event)
R7 (typed abort handler) + R6 (finally cleanup) ← must be atomic
R5 (reference-based threads) ← R15 (pruning log uses R5 vars)
R1 (config capacity) ← requires types.ts update first
R3 (trace storage key) ← must also fix ClickHouse + traceEvent.sessionId
```

### Recommended Implementation Order

**Batch 1 — Type/config foundations:**

1. R8: Add fan-out types + `attachment_preprocess` to `TraceEventType`
2. R1: Add `maxConcurrentFanOutCalls` to `RuntimeExecutorConfig`, wire into semaphore

**Batch 2 — Core correctness (must be atomic):** 3. R6+R7: Replace `any`-cast abort handler with typed closure, move cleanup to `finally` 4. R2: Attach `.catch()` to detached `executeMessage` promise 5. R5: Replace index-based thread tracking with object references (includes removing line 1153)

**Batch 3 — Traceability:** 6. R3: Fix trace storage key in `createCentralizedTraceHandler` (in-memory + ClickHouse + sessionId) 7. R4: Route coordinator events through `childTraceEvent` wrapper, compute `childSessionId` before events 8. R10: Move `startTime` + `fan_out_task_start` after `acquire()` 9. R11: Add `totalDurationMs` to `fan_out_complete` 10. R12: Add `callerContext` to `fan_out_start` 11. R13: Add trace event before early-return (depends on R8)

**Batch 4 — Logging and testing:** 12. R9: Log semaphore wait time 13. R14: Add debug logs for `debouncedPersist` skip and `cancelPendingPersist` 14. R15: Add debug log for thread pruning (uses R5 variable names) 15. R16: Add `executionId` consistency and timeout trace event tests 16. R17: Fix remaining position-based test assertion 17. R18: Add documentation comment for `isRecursive` contract

---

## Deferred Issues (From Round 1)

### C4: Shared toolExecutor instance — STILL DEFERRED

Requires verification of `ToolBindingExecutor` statefulness before implementing. If stateless, document; if stateful, wire per-child in `handleFanOut`.

### I7: compilationOutput is supervisor's — STILL DEFERRED

Acceptable Phase 1 shortcut. No code change needed unless compilation becomes per-agent.

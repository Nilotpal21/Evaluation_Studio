# Execution Model Redesign — Post-Implementation Review Issues

**Date:** 2026-02-28
**Scope:** Review of the Phase 1 execution model redesign (`packages/execution/`, `handleFanOut` refactoring in `routing-executor.ts`, and supporting changes across 15+ files).
**Review areas:** Spec compliance, race conditions, performance/scale, context propagation.

**Status:** 16 of 18 issues fixed. All 5073 runtime tests pass. 42 fan-out tests pass.

| Issue | Status   | Notes                                                                              |
| ----- | -------- | ---------------------------------------------------------------------------------- |
| C1    | FIXED    | Semaphore gates `executeMessage` (default concurrency 3)                           |
| C2    | FIXED    | `debouncedPersist` skips `__fanout__` sessions + `cancelPendingPersist` in finally |
| C3    | FIXED    | Child session ID includes `executionId` for uniqueness                             |
| C4    | DEFERRED | Needs verification of `ToolBindingExecutor` statefulness                           |
| C5    | FIXED    | `onTraceEvent` wrapper injects `executionId` + `parentSessionId`                   |
| C6    | FIXED    | Child trace events stored under parent session ID                                  |
| C7    | FIXED    | `Promise.allSettled` in `InProcessExecutionRuntime`                                |
| I1    | FIXED    | Completed child threads pruned after fan-out                                       |
| I2    | FIXED    | `threads` array cloned in `createChildSession`                                     |
| I3    | FIXED    | Manual `AbortController` + `clearTimeout` replaces `AbortSignal.timeout()`         |
| I4    | FIXED    | Abort listener removed on success path                                             |
| I5    | FIXED    | `markExecuting`/`unmarkExecuting` around child session lifecycle                   |
| I6    | FIXED    | `handoffReturnInfo` cleared on child sessions                                      |
| I7    | DEFERRED | Acceptable Phase 1 shortcut — all agents share compilation                         |
| I8    | FIXED    | `pendingContentBlocks` cleared on child sessions                                   |
| I9    | FIXED    | Single `syncThreadToSession` after all result processing                           |
| I10   | FIXED    | Dead `childSessionIds` variable removed                                            |
| I11   | FIXED    | Position-based test assertions replaced with `find`-based                          |

---

## Critical Issues

### C1: CountingSemaphore not wired into handleFanOut — FIXED

**Files:** `apps/runtime/src/services/execution/routing-executor.ts` (handleFanOut executeUnit closure)

**Description:** The `CountingSemaphore` class exists in `packages/execution/`, is exported, tested, and even referenced in `ExecutionConfig.maxConcurrentLLMCalls`. However, `handleFanOut`'s `executeUnit` closure calls `executeMessage` with no semaphore gate. All N fan-out children fire their LLM calls simultaneously with zero throttling.

**Impact:**

- **Rate limiting:** A 10-agent fan-out fires 10 concurrent LLM API calls. At scale (100 sessions × 5 agents = 500 concurrent calls), this exhausts provider rate limits for the entire pod, causing 429 errors for all sessions.
- **Memory:** Each LLM response stream is buffered concurrently (~50KB per stream × 500 = 25MB of stream buffers).
- **Downstream load:** Tool calls from parallel children also fire concurrently, hitting external APIs with no backpressure.

**Fix:** Add a per-executor semaphore (default concurrency 3) and acquire/release around `executeMessage` in the `executeUnit` closure.

---

### C2: debouncedPersist fires for ephemeral `__fanout__` child sessions — FIXED

**Files:** `apps/runtime/src/services/runtime-executor.ts` (debouncedPersist, lines ~1365-1366), `apps/runtime/src/services/execution/routing-executor.ts` (executeUnit finally block)

**Description:** When `executeMessage` runs for a child session, it calls `debouncedPersist(session)` on the child. The child session has a synthetic ID (`${parentId}__fanout__${agentName}`). After a 300ms debounce, `saveSessionSnapshot` persists this ephemeral session to Redis under the synthetic key. The `finally` block in `executeUnit` deletes the child from the in-memory map but does not cancel the pending debounce timer.

**Impact:**

- **Redis pollution:** Ghost sessions accumulate under `sess:{tenantId}:parentId__fanout__agentX` keys. These are never cleaned up by the normal session lifecycle — only the 30-minute TTL expiry removes them.
- **Wasted I/O:** Each fan-out child triggers a Redis write that is pure waste (the data is immediately stale).
- **Rehydration confusion:** On pod restart, `rehydrateSession` could encounter these ghost sessions and attempt to rebuild them.

**Fix:** Mark child sessions as ephemeral (`isEphemeral: true`) and skip `debouncedPersist` for ephemeral sessions. Also cancel any pending debounce timer in the `finally` cleanup.

---

### C3: Session map key collision on re-entrant fan-out — FIXED

**Files:** `apps/runtime/src/services/execution/routing-executor.ts` (lines ~1025-1026)

**Description:** The child session ID is deterministic: `${session.id}__fanout__${agentName}`. If two concurrent `handleFanOut` calls run against the same parent session targeting the same child agent (e.g., user sends a second message while the first fan-out is still running), the second call's `sessions.set(childSessionId, childSession)` silently overwrites the first. The first child's `executeMessage` may then read the second child's session on its next `await` yield. The `finally` cleanup from one call deletes the other's entry.

**Impact:**

- **Data corruption:** Interleaved session state between two fan-out invocations.
- **Silent failure:** No error is raised — the overwrite happens silently.

**Fix:** Include `executionId` in the child session key: `${session.id}__fanout__${executionId}__${agentName}`. Since `executionId` is a UUID, this is globally unique per fan-out invocation.

---

### C4: All fan-out children share a single toolExecutor instance — DEFERRED

**Files:** `packages/execution/src/child-session.ts` (spread copies reference), `apps/runtime/src/services/execution/routing-executor.ts` (no per-child toolExecutor wiring)

**Description:** `createChildSession` does `...parentSession`, copying the `toolExecutor` reference. All N children in a fan-out reference the exact same `ToolBindingExecutor` object. The fan-out runs children concurrently. If `ToolBindingExecutor` holds any mutable state (proxy resolver state, request tracking, cooldowns), concurrent `.execute()` calls race on that shared state. Additionally, the `toolExecutor` was wired with the parent supervisor's `sessionContext.sessionId`, so tool audit logs and SSRF checks reference the wrong session.

**Impact:**

- **Data race:** Concurrent tool calls from parallel children could corrupt shared executor state.
- **Audit trail:** Tool call audit logs attribute all child tool calls to the parent supervisor session, not the child.
- **Security:** SSRF checks may use stale session context.

**Fix:** Wire a fresh `toolExecutor` per child session in `handleFanOut`, or verify and document that `ToolBindingExecutor` is fully stateless under concurrent use.

---

### C5: executionId not propagated into child-emitted trace events — FIXED

**Files:** `apps/runtime/src/services/execution/routing-executor.ts` (onTraceEvent passed to executeMessage), `apps/runtime/src/services/runtime-executor.ts` (createCentralizedTraceHandler)

**Description:** The coordinator-level events (`fan_out_start`, `fan_out_task_start`, `fan_out_task_complete`, `fan_out_complete`) correctly include `executionId` in their `data`. However, all trace events emitted from inside the child's `executeMessage` call (LLM calls, tool calls, decisions, handoffs) go through `createCentralizedTraceHandler`, which does NOT inject `executionId`. The `TraceEvent` type has `executionId` and `parentExecutionId` fields, but they are never populated in child events.

**Impact:**

- **Observability gap:** ClickHouse and Observatory cannot correlate inner child traces (LLM calls, tool executions) to their parent fan-out context. The `executionId` field exists in the schema but is always `undefined` for child events.
- **Debugging:** When diagnosing a fan-out failure, there's no way to query "show me all LLM calls from fan-out execution X."

**Fix:** Wrap `onTraceEvent` for each child to inject `executionId` into every event's `data` before forwarding to the parent callback.

---

### C6: Child trace events stored under unreachable session key — FIXED

**Files:** `apps/runtime/src/services/runtime-executor.ts` (createCentralizedTraceHandler, TraceStore.addEvent)

**Description:** Inside `executeMessage`, `createCentralizedTraceHandler` stores events in the in-memory `TraceStore` keyed by `sessionId`. For fan-out children, this is the synthetic `__fanout__` ID. After fan-out completes, the child session is deleted from the sessions map, but its trace events remain in the TraceStore under the synthetic key. There is no API to query traces by `__fanout__` ID — Observatory always queries by the parent session ID.

**Impact:**

- **Lost traces:** All child-agent trace events (LLM calls, tool calls, decisions) are invisible to Observatory and the trace API.
- **Memory waste:** Trace events accumulate in memory under keys that are never queried.

**Fix:** Use the parent session ID (not the child's synthetic ID) when storing child trace events, with `executionId` for differentiation. Or aggregate child traces into the parent's trace entry after fan-out completes.

---

### C7: Promise.all used instead of Promise.allSettled — FIXED

**Files:** `packages/execution/src/in-process-runtime.ts` (line 101)

**Description:** The `executeParallel` method uses `Promise.all(promises)`. The plan, design doc, docstring, and architecture section all specify `Promise.allSettled`. Currently safe because each promise in the array has its own `.catch()` handler that converts rejections to `ExecutionUnitResult` objects — so no promise can reject. However, this is a latent correctness risk: if a future refactor removes the `.catch()` wrapper, `Promise.all` would reject on the first failure and drop all sibling results.

**Impact:**

- **Latent correctness risk:** Future code changes could silently break partial-failure semantics.
- **Spec divergence:** The implementation contradicts the plan and design doc.

**Fix:** Change to `Promise.allSettled` and map settled results to `ExecutionUnitResult[]`.

---

## Important Issues

### I1: Threads array grows unbounded — FIXED

**Files:** `apps/runtime/src/services/execution/types.ts` (createThread pushes to session.threads), `apps/runtime/src/services/execution/routing-executor.ts` (no pruning after fan-out)

**Description:** Every `createThread()` call pushes to `session.threads`. After `handleFanOut` completes, all child threads remain with `status: 'completed'`. After K fan-outs × N agents, the array has `1 + K*N` entries. Each thread holds `conversationHistory`, `state`, `data`, and `agentIR`.

**Impact:**

- **Memory growth:** Long-lived sessions with repeated fan-outs accumulate hundreds of dead thread objects, each with full conversation histories.
- **Redis serialization cost:** `serializeThreads` serializes ALL threads on every `saveSessionSnapshot`, growing the Redis payload linearly.
- **CLAUDE.md violation:** "No append-only collections without cleanup."

**Fix:** After fan-out results are merged into the parent thread, prune completed child threads from `session.threads`.

---

### I2: Shared threads array reference across concurrent children — FIXED

**Files:** `packages/execution/src/child-session.ts` (spread copies reference, not array), `apps/runtime/src/services/execution/types.ts` (syncThreadToSession)

**Description:** `createChildSession` does `{ ...parentSession }` which copies the `threads` array reference (not a clone). All child sessions and the parent share the same array. If any child triggers `createThread` (nested handoff), it pushes to the shared array, shifting indices. `syncThreadToSession` from one child can interleave with another child's reads across `await` boundaries.

**Impact:**

- **Index instability:** `childThreadIndices` computed before parallel execution may become stale if any child pushes new threads.
- **State interleaving:** Thread status mutations from one child are visible to all siblings via the shared reference.

**Fix:** Clone the `threads` array in `createChildSession`: `threads: [...parentSession.threads]`.

---

### I3: AbortSignal.timeout() timer not cleaned up — FIXED

**Files:** `apps/runtime/src/services/execution/routing-executor.ts` (line ~1104)

**Description:** `AbortSignal.timeout(timeoutMs * 2)` creates an internal timer that runs for up to 60s (with default 30s timeout). After all children complete successfully, the timer continues running until it fires. Node.js `AbortSignal.timeout()` does not support cancellation.

**Impact:**

- **Timer overhead:** 100 concurrent fan-outs = 100 outstanding timers for up to 60s each.
- **Process exit delay:** In tests or short-lived processes, outstanding timers prevent clean shutdown.

**Fix:** Replace with manual `AbortController` + `setTimeout` + `clearTimeout` in `finally`.

---

### I4: Abort listener not removed on success path — FIXED

**Files:** `apps/runtime/src/services/execution/routing-executor.ts` (abortPromise in executeUnit)

**Description:** The `abortPromise` registers an `abort` listener on `signal`. If `executeMessage` wins the `Promise.race`, the listener stays attached (despite `{ once: true }`) until the signal object is GC'd. With many fan-outs, listeners accumulate on the shared `AbortSignal.timeout` object.

**Impact:**

- **Listener accumulation:** Each successful child leaves a dangling listener. With 100 fan-outs × 5 children = 500 dangling listeners on `AbortSignal.timeout` objects.
- **Minor memory pressure:** Closures captured by listeners hold references to `unit` and `Error` objects.

**Fix:** Store the listener reference and remove it explicitly on the success path. Or restructure to use `signal.throwIfAborted()` instead of a race.

---

### I5: Child sessions bypass \_executingSessions reaper guard — FIXED

**Files:** `apps/runtime/src/services/runtime-executor.ts` (\_executingSessions, stale session reaper)

**Description:** Child session IDs are never added to `_executingSessions` before `executeMessage` runs. The stale session reaper checks `_executingSessions.has(id)` before evicting. Between `sessions.set(childSessionId, childSession)` and `executeMessage`'s internal `_executingSessions.add(childSessionId)`, there's a window where the reaper could evict the child.

**Impact:**

- **Mid-execution eviction:** Under load, if the reaper fires during this window, it deletes the child session from the map, causing `executeMessage` to throw "Session not found."

**Fix:** Add child IDs to `_executingSessions` before calling `executeMessage`, remove in `finally`.

---

### I6: handoffReturnInfo inherited by child sessions — FIXED

**Files:** `packages/execution/src/child-session.ts` (spread), `apps/runtime/src/services/execution/routing-executor.ts` (handleHandoff validation)

**Description:** `createChildSession` spreads `...parentSession`, copying `handoffReturnInfo`. This gives child agents the supervisor's full routing authority. A child agent can hand off to any target the supervisor can reach, even if the child's own IR has no routing rules.

**Impact:**

- **Privilege escalation:** Fan-out children inherit routing permissions they shouldn't have.
- **Unexpected handoffs:** A child agent intended for a narrow task could redirect the conversation to unrelated agents.

**Fix:** Clear `handoffReturnInfo` on child sessions: `childSession.handoffReturnInfo = undefined`.

---

### I7: compilationOutput is the supervisor's, not the child agent's — DEFERRED

**Files:** `packages/execution/src/child-session.ts` (spread copies parent's compilationOutput)

**Description:** Child sessions inherit `compilationOutput` from the parent supervisor. This contains the compiled IR for all agents in the project. In practice, all agents compile together so the child agent's IR is present. But semantically, the child session claims to have the supervisor's compilation while running a different agent.

**Impact:**

- **Fragile correctness:** If compilation is ever scoped per-agent (Phase 3 multi-deployment), this breaks.
- **Tool wiring:** `wireToolExecutor` reads `compilationOutput.agents` — currently works because all agents are in the same compilation, but conceptually wrong.

**Fix:** Document this as an acceptable shortcut for Phase 1. No code change needed unless compilation becomes per-agent.

---

### I8: pendingContentBlocks inherited by child sessions — FIXED

**Files:** `packages/execution/src/child-session.ts` (spread copies all parent fields)

**Description:** If the parent session has pending multimodal content blocks (e.g., an image attachment), all N fan-out children inherit them via spread. Each child's first LLM call includes the parent's attachments, multiplying token usage by N.

**Impact:**

- **Token waste:** N children × image tokens = N× cost for a single attachment.
- **Incorrect behavior:** Child agents receive content blocks intended for the parent.

**Fix:** Clear `pendingContentBlocks` on child sessions in `createChildSession`.

---

### I9: Double syncThreadToSession call — FIXED

**Files:** `apps/runtime/src/services/execution/routing-executor.ts` (lines ~1109 and ~1170)

**Description:** `syncThreadToSession` is called twice: once after restoring `activeThreadIndex`, and again after all result processing. The first call is partially redundant because the data/conversationHistory references are the same objects that are mutated between the two calls.

**Impact:**

- **Structural fragility:** Two sync points with mutations between them obscure the data flow. A future edit between the two calls could produce inconsistent state.

**Fix:** Remove the first `syncThreadToSession`, keep only the final one after all result processing.

---

### I10: Dead childSessionIds variable — FIXED

**Files:** `apps/runtime/src/services/execution/routing-executor.ts` (lines ~985 and ~1027)

**Description:** `const childSessionIds: string[] = []` is declared and populated with `push()` but never read anywhere. The `finally` block uses the closure-scoped `childSessionId` directly for cleanup.

**Impact:**

- **Dead code:** Violates CLAUDE.md: "Delete fields that are written but never read."

**Fix:** Delete both the declaration and the `push()` call.

---

### I11: Position-based test assertions assume execution order — FIXED

**Files:** `apps/runtime/src/__tests__/fan-out.test.ts` (lines ~330-340, ~362-367)

**Description:** Tests assert `result.results[0]` and `result.results[1]` by array position, assuming Flight_Agent always executes before Hotel_Agent. With parallel execution, the counter increment order depends on microtask scheduling — deterministic today but not a contract.

**Impact:**

- **Test fragility:** Any change to async scheduling (e.g., real `wireLLMClient` call) could break these tests.

**Fix:** Use `results.find(r => r.target === '...')` instead of position-based indexing.

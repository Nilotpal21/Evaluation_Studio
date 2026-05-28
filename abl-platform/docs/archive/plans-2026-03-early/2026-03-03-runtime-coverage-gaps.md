# Runtime Execution Path Coverage Gaps — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the coverage gaps in runtime-executor.ts (22% → 60%+), routing-executor.ts (24% → 55%+), and flow-step-executor.ts (40% → 65%+) by adding targeted unit test suites for the uncovered branches identified in the static review.

**Architecture:** Each phase targets one executor file. Tests use Vitest with dependency injection (no `vi.mock()` at module level), manual mock factories, and `vi.fn()` for call tracking. All tests are pure unit tests — no DB, no HTTP, no external services.

**Tech Stack:** Vitest, vi.fn(), vi.useFakeTimers(), manual mock factories following existing patterns in `routing-executor-unit.test.ts` and `flow-step-helpers.test.ts`.

---

## Phase 1 — Runtime Lifecycle Suite (runtime-executor.ts)

### Task 1: Stale Reaper Tests

**Files:**

- Create: `apps/runtime/src/__tests__/runtime-lifecycle.test.ts`
- Read: `apps/runtime/src/services/runtime-executor.ts:280-430`

**Context:**
The `RuntimeExecutor` class has a stale session reaper (`_doReap()`) that runs on a 5-minute interval. It checks three conditions: inactivity threshold (30 min), absolute max-age, and memory ceiling (10k sessions). Sessions in `_executingSessions` are protected from eviction. Before eviction, it calls `saveSessionSnapshot()` (fire-and-forget) and releases quota slots.

The class also has `startStaleReaper()` (idempotent timer init), `reapStaleSessions()` (concurrency guard via `_reapInProgress` flag), and `stopStaleReaper()`.

**Step 1: Write the test file with reaper tests**

Create `apps/runtime/src/__tests__/runtime-lifecycle.test.ts` with tests:

```typescript
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// We test RuntimeExecutor methods by creating an instance and manipulating
// its internal Maps directly. The constructor is the public API.
// Import the class and any types needed.

describe('RuntimeExecutor — Stale Session Reaper', () => {
  // Use fake timers for setInterval/setTimeout
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('startStaleReaper is idempotent — second call does not create second timer', ...);
  test('reapStaleSessions guards against concurrent reaps via _reapInProgress', ...);
  test('_reapInProgress flag resets even if _doReap throws', ...);
  test('stale threshold evicts sessions inactive > 30 minutes', ...);
  test('maxAgeSeconds evicts sessions older than absolute lifetime', ...);
  test('actively executing sessions are protected from eviction', ...);
  test('memory ceiling eviction removes oldest sessions when > MAX_IN_MEMORY_SESSIONS', ...);
  test('saveSessionSnapshot failure during reap logs warning and continues cleanup', ...);
  test('releaseSessionSlot called for tenant-scoped evicted sessions', ...);
  test('debounce timers cleared for evicted sessions', ...);
  test('stopStaleReaper clears the interval timer', ...);
});
```

**Mocking approach:** Create a `RuntimeExecutor` instance, then use `(executor as any).sessions` to inject mock session objects. Spy on `saveSessionSnapshot` and `releaseSessionSlot` via `vi.spyOn()`. Use `vi.advanceTimersByTime()` to trigger the interval.

**Step 2: Run tests to verify they fail**

Run: `pnpm --filter @agent-platform/runtime test -- "runtime-lifecycle" 2>&1 | tail -20`
Expected: FAIL — tests reference unimplemented mocks or logic paths not yet wired.

**Step 3: Implement the tests with proper mocking**

Flesh out each test case with proper assertions. Key patterns:

- Inject sessions into `(executor as any).sessions` Map
- Set `session.lastActivityAt` to past timestamps for stale detection
- Add session IDs to `(executor as any)._executingSessions` for protection tests
- Mock `saveSessionSnapshot` to resolve or reject
- Verify `sessions.delete()` was called for evicted sessions

**Step 4: Run tests to verify they pass**

Run: `pnpm --filter @agent-platform/runtime test -- "runtime-lifecycle" 2>&1 | tail -20`
Expected: All stale reaper tests PASS.

**Step 5: Commit**

```bash
git add apps/runtime/src/__tests__/runtime-lifecycle.test.ts
git commit -m "[ABLP-2] test(runtime): add stale session reaper lifecycle tests"
```

---

### Task 2: Quota Claim/Release Tests

**Files:**

- Modify: `apps/runtime/src/__tests__/runtime-lifecycle.test.ts`
- Read: `apps/runtime/src/services/runtime-executor.ts:480-560`

**Context:**
`checkSessionQuota()` dynamically imports `rate-limiter.js`, calls `getTenantRateLimits()` and `claimSessionSlot()`. It has 5 branches: no tenant (dev mode bypass), unlimited sessions (-1), successful claim, claim failure (returns -1 → throws TOO_MANY_REQUESTS), and import/call error (fail-open). `releaseSessionSlot()` has 3 branches: no sessionId (early return), successful release, release error (logs warning).

**Step 1: Add quota tests to the lifecycle file**

```typescript
describe('RuntimeExecutor — Session Quota', () => {
  test('checkSessionQuota bypasses check when no tenantId (dev mode)', ...);
  test('checkSessionQuota bypasses check when concurrentSessions is -1 (unlimited)', ...);
  test('checkSessionQuota succeeds when slot claim returns valid ID', ...);
  test('checkSessionQuota throws TOO_MANY_REQUESTS when slot claim returns -1', ...);
  test('checkSessionQuota fails open when rate limiter import errors', ...);
  test('checkSessionQuota uses provided sessionId instead of generating UUID', ...);
  test('releaseSessionSlot is a no-op when sessionId is undefined', ...);
  test('releaseSessionSlot calls release and succeeds silently', ...);
  test('releaseSessionSlot logs warning on release error without rethrowing', ...);
});
```

**Mocking approach:** The methods dynamically import `rate-limiter.js`. Use `vi.mock()` at the test-file level to mock that specific module, or create the executor and spy on the method. Since existing tests avoid module-level mocks, prefer calling the public methods and injecting dependencies.

**Step 2: Run and verify pass**

Run: `pnpm --filter @agent-platform/runtime test -- "runtime-lifecycle" 2>&1 | tail -20`
Expected: All quota tests PASS.

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/runtime-lifecycle.test.ts
git commit -m "[ABLP-2] test(runtime): add session quota claim/release tests"
```

---

### Task 3: Stale Refresh, Rehydrate, and Version Conflict Tests

**Files:**

- Modify: `apps/runtime/src/__tests__/runtime-lifecycle.test.ts`
- Read: `apps/runtime/src/services/runtime-executor.ts:1050-1120,1850-1960,2180-2290`

**Context:**
`checkAndRefreshIfStale()` compares local `storeVersion` against store's version. If store is newer, it calls `rehydrateSession()`. Fails open on errors. `saveSessionSnapshot()` loads existing data from store, updates mutable fields, strips `env` namespace, calls `svc.saveSession()` with optimistic concurrency. Returns `false` on version conflict (logs warning). `persistSessionToService()` creates initial session record, strips env, serializes threads, caches agent IRs.

**Step 1: Add stale-refresh and persistence tests**

```typescript
describe('RuntimeExecutor — Stale Refresh & Rehydration', () => {
  test('checkAndRefreshIfStale returns null when store version is null', ...);
  test('checkAndRefreshIfStale returns null when store version <= local version', ...);
  test('checkAndRefreshIfStale rehydrates when store version > local version', ...);
  test('checkAndRefreshIfStale fails open on store read error', ...);
});

describe('RuntimeExecutor — Session Persistence', () => {
  test('saveSessionSnapshot calls persistSessionToService when session not in store', ...);
  test('saveSessionSnapshot updates mutable fields on existing session', ...);
  test('saveSessionSnapshot strips env namespace from data values', ...);
  test('saveSessionSnapshot increments storeVersion on successful save', ...);
  test('saveSessionSnapshot logs warning on version conflict (save returns false)', ...);
  test('saveSessionSnapshot catches and logs errors without rethrowing', ...);
  test('persistSessionToService creates session with all required fields', ...);
  test('persistSessionToService strips env from initialContext', ...);
  test('persistSessionToService serializes threads if present', ...);
  test('persistSessionToService caches agent IRs in registry', ...);
});
```

**Step 2: Run and verify pass**

Run: `pnpm --filter @agent-platform/runtime test -- "runtime-lifecycle" 2>&1 | tail -20`
Expected: All persistence tests PASS.

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/runtime-lifecycle.test.ts
git commit -m "[ABLP-2] test(runtime): add stale-refresh and session persistence tests"
```

---

### Task 4: Debounced/Immediate Persist Tests

**Files:**

- Modify: `apps/runtime/src/__tests__/runtime-lifecycle.test.ts`
- Read: `apps/runtime/src/services/runtime-executor.ts:1700-1780`

**Context:**
`debouncedPersist()` checks the session channel. HTTP/API channels trigger immediate persist. WebSocket/other channels use `setTimeout` debounce (default 300ms). Rapid calls reschedule the timer. Timer cleanup removes from `persistDebounceTimers` map.

**Step 1: Add debounce persist tests**

```typescript
describe('RuntimeExecutor — Debounced Persistence', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('HTTP channel triggers immediate saveSessionSnapshot', ...);
  test('API channel triggers immediate saveSessionSnapshot', ...);
  test('WebSocket channel debounces with default 300ms delay', ...);
  test('rapid calls reschedule timer (only last one fires)', ...);
  test('timer removed from map after firing', ...);
  test('persist error in timer callback is logged', ...);
  test('custom delayMs is respected', ...);
  test('session without channel defaults to debounced persist', ...);
});
```

**Step 2: Run and verify pass**

Run: `pnpm --filter @agent-platform/runtime test -- "runtime-lifecycle" 2>&1 | tail -20`
Expected: All debounce tests PASS.

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/runtime-lifecycle.test.ts
git commit -m "[ABLP-2] test(runtime): add debounced/immediate persist tests"
```

---

## Phase 2 — Routing Coordination Failure Suites (routing-executor.ts)

### Task 5: Remote Handoff Timeout and Failure Tests

**Files:**

- Create: `apps/runtime/src/__tests__/routing-remote-handoff.test.ts`
- Read: `apps/runtime/src/services/execution/routing-executor.ts:640-870`

**Context:**
`handleRemoteHandoff()` calls A2A `sendTask()` with a `Promise.race` timeout. On timeout, it restores the parent thread from `threadStack`. On failure, it also restores the parent. Auth headers are forwarded. Three result types: task completed (return data), task input-required (multi-turn), task failed (error).

The class constructor takes `ctx: ExecutorContext` and `llmWiring: LLMWiringService`. Most helper functions like `getActiveThread`, `createThread`, `syncThreadToSession` are importable standalone.

**Step 1: Write remote handoff failure tests**

```typescript
describe('RoutingExecutor — Remote Handoff', () => {
  test('timeout fires when sendTask exceeds remoteTimeoutMs', ...);
  test('parent thread restored from threadStack after timeout', ...);
  test('completed task with returnExpected merges data to parent', ...);
  test('input-required task keeps remote thread active', ...);
  test('failed task restores parent and returns error', ...);
  test('exception in sendTask restores parent and returns error', ...);
  test('auth token forwarded in A2A headers', ...);
  test('history strategy none sends empty conversation', ...);
  test('history strategy full sends complete conversation', ...);
});
```

**Mocking approach:** Create RoutingExecutor with mock ExecutorContext. Mock `sendTask` to resolve/reject/delay. Mock `createA2AClient` to return stub. Use `vi.useFakeTimers()` for timeout tests.

**Step 2: Run and verify pass**

Run: `pnpm --filter @agent-platform/runtime test -- "routing-remote-handoff" 2>&1 | tail -20`
Expected: All remote handoff tests PASS.

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/routing-remote-handoff.test.ts
git commit -m "[ABLP-2] test(runtime): add remote handoff timeout and failure tests"
```

---

### Task 6: Delegate ON_FAILURE Variant Tests

**Files:**

- Create: `apps/runtime/src/__tests__/routing-delegate-failures.test.ts`
- Read: `apps/runtime/src/services/execution/routing-executor.ts:870-1180`

**Context:**
`executeDelegate()` uses AbortController + Promise.race for timeout. On timeout, shared references are severed. ON_FAILURE has three variants: `'respond'` (output failure_message, push to conversation), `'escalate'` (set isEscalated, store reason), `'continue'` (return error, no side effects). WHEN condition gating, self-delegation guard, cycle detection, depth limit (10).

**Step 1: Write delegate failure tests**

```typescript
describe('RoutingExecutor — Delegate Failures', () => {
  test('WHEN condition false returns error with constraint_check trace', ...);
  test('self-delegation returns error', ...);
  test('cycle detection (A→B→A) returns error with stack trace', ...);
  test('depth limit exceeded (>10) returns error', ...);
  test('timeout severs shared references to prevent parent corruption', ...);
  test('ON_FAILURE respond: outputs failure_message and pushes to conversation', ...);
  test('ON_FAILURE escalate: sets isEscalated and escalationReason', ...);
  test('ON_FAILURE continue: returns error without side effects', ...);
  test('INPUT mapping resolves dot-paths from context', ...);
  test('INPUT mapping logs warning for undefined paths', ...);
  test('RETURNS mapping transforms result fields back to session', ...);
  test('delegateStack popped after timeout', ...);
  test('activeThreadIndex restored to parent after delegate completes', ...);
});
```

**Step 2: Run and verify pass**

Run: `pnpm --filter @agent-platform/runtime test -- "routing-delegate-failures" 2>&1 | tail -20`
Expected: All delegate failure tests PASS.

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/routing-delegate-failures.test.ts
git commit -m "[ABLP-2] test(runtime): add delegate ON_FAILURE variant and timeout tests"
```

---

### Task 7: Fan-Out Partial Failure and Cleanup Tests

**Files:**

- Create: `apps/runtime/src/__tests__/routing-fanout-failures.test.ts`
- Read: `apps/runtime/src/services/execution/routing-executor.ts:1260-1920`

**Context:**
`handleFanOut()` has a concurrent guard (`_activeFanOutSessions`), deduplicates tasks, separates tool vs agent tasks, and runs them in parallel with `Promise.allSettled`. Child session cleanup always runs in `finally`. Parent thread re-resolution uses object reference first, then falls back to name-based lookup.

**Step 1: Write fan-out failure and cleanup tests**

```typescript
describe('RoutingExecutor — Fan-Out', () => {
  test('concurrent guard prevents overlapping fan-out from same session', ...);
  test('concurrent guard released in finally even on error', ...);
  test('all-invalid tasks emit abort trace and return early', ...);
  test('tool task execution error produces per-task error in results', ...);
  test('agent task timeout produces per-task error with severed refs', ...);
  test('child threads pruned from session.threads in finally block', ...);
  test('parent activeThreadIndex re-resolved via object reference', ...);
  test('parent activeThreadIndex fallback to name-based lookup', ...);
  test('result stored in _last_fan_out and _fan_out_result_{target}', ...);
  test('deduplication merges intent strings with semicolon separator', ...);
  test('tool tasks routed to toolExecutor, agent tasks to executionRuntime', ...);
});
```

**Step 2: Run and verify pass**

Run: `pnpm --filter @agent-platform/runtime test -- "routing-fanout-failures" 2>&1 | tail -20`
Expected: All fan-out tests PASS.

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/routing-fanout-failures.test.ts
git commit -m "[ABLP-2] test(runtime): add fan-out partial failure and cleanup tests"
```

---

### Task 8: Completion/Handoff Condition Tests

**Files:**

- Create: `apps/runtime/src/__tests__/routing-conditions.test.ts`
- Read: `apps/runtime/src/services/execution/routing-executor.ts:1919-2110`

**Context:**
`checkCompletionConditions()` iterates IR completion conditions, evaluates WHEN expressions, emits `completion_check` trace for each (even mismatches), and auto-completes on match with STORE support. `checkHandoffConditions()` rebuilds `handoffReturnInfo` from current IR (prevents stale info), evaluates handoff WHEN conditions, extracts PASS fields, and calls `handleHandoff()` on match.

**Step 1: Write condition evaluation tests**

```typescript
describe('RoutingExecutor — Completion Conditions', () => {
  test('evaluates all conditions and emits trace for each', ...);
  test('first matching condition triggers auto-complete', ...);
  test('STORE key persists context value on completion', ...);
  test('tryThreadReturn restores parent thread on completion', ...);
  test('no matching conditions returns null', ...);
  test('trace includes source, currentStep, nextStep from callContext', ...);
});

describe('RoutingExecutor — Handoff Conditions', () => {
  test('handoffReturnInfo rebuilt from current IR on every call', ...);
  test('conditions without WHEN are skipped', ...);
  test('first matching WHEN triggers auto-handoff', ...);
  test('PASS fields extracted from context into handoff input', ...);
  test('no matching conditions returns null', ...);
  test('trace includes agent, target, condition, result, context', ...);
});
```

**Step 2: Run and verify pass**

Run: `pnpm --filter @agent-platform/runtime test -- "routing-conditions" 2>&1 | tail -20`
Expected: All condition tests PASS.

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/routing-conditions.test.ts
git commit -m "[ABLP-2] test(runtime): add completion/handoff condition evaluation tests"
```

---

## Phase 3 — Flow-Step Branch Suites (flow-step-executor.ts)

### Task 9: Constraint Mini-Collect Tests

**Files:**

- Create: `apps/runtime/src/__tests__/flow-constraint-minicollect.test.ts`
- Read: `apps/runtime/src/services/execution/flow-step-executor.ts:490-590`

**Context:**
`handleConstraintControlFlow()` maps constraint violations to three directives: `collect_field` (sets constraintCollectState with fields and thenAction), `goto_step` (increments backtrackCounts), `retry_step` (returns retry action). `executeMiniCollect()` extracts entities for constraint-requested fields via LLM, merges into session, clears constraintCollectState, re-evaluates constraint, and returns one of three outcomes: `'continue'`, `'retry'`, or `'escalate'`.

**Step 1: Write constraint mini-collect tests**

```typescript
describe('FlowStepExecutor — Constraint Mini-Collect', () => {
  describe('handleConstraintControlFlow', () => {
    test('collect_field sets constraintCollectState with fields and thenAction', ...);
    test('goto_step increments backtrackCounts for target step', ...);
    test('retry_step returns retry action with optional respond', ...);
    test('unknown directive type returns null', ...);
  });

  describe('executeMiniCollect', () => {
    test('extracts entities and merges into session', ...);
    test('clears constraintCollectState after extraction', ...);
    test('returns continue when constraint passes with continue thenAction', ...);
    test('returns retry when constraint passes with retry thenAction', ...);
    test('returns escalate when constraint still fails after collection', ...);
    test('constraint re-evaluation uses checkConstraints()', ...);
  });
});
```

**Step 2: Run and verify pass**

Run: `pnpm --filter @agent-platform/runtime test -- "flow-constraint-minicollect" 2>&1 | tail -20`
Expected: All constraint tests PASS.

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/flow-constraint-minicollect.test.ts
git commit -m "[ABLP-2] test(runtime): add constraint mini-collect branch tests"
```

---

### Task 10: Correction Fallback Chain Tests

**Files:**

- Create: `apps/runtime/src/__tests__/flow-correction-chain.test.ts`
- Read: `apps/runtime/src/services/execution/flow-step-executor.ts:590-680,2385-2504`

**Context:**
Correction detection is a three-tier fallback: regex (`detectCorrection()`) → sidecar NLU (`sidecarClient.detectCorrection()` with AbortController timeout) → LLM (`detectCorrectionWithLLM()`). Field validation checks if detected field is `CORRECTION_FIELD_UNKNOWN` or not in declared gather schema. If from regex/sidecar, defers to LLM. If LLM also returns undeclared field, logs warning and skips. Strategy mode (`'auto'`, `'regex'`, `'ml'`, `'sidecar'`, `'llm'`) controls which methods are enabled.

**Step 1: Write correction chain tests**

```typescript
describe('FlowStepExecutor — Correction Fallback Chain', () => {
  test('regex match returns correction without falling through', ...);
  test('regex miss + sidecar match returns correction', ...);
  test('regex + sidecar miss + LLM match returns correction', ...);
  test('all three methods miss returns no correction', ...);
  test('sidecar timeout falls back to LLM gracefully', ...);
  test('CORRECTION_FIELD_UNKNOWN from regex defers to LLM fallback', ...);
  test('undeclared field from sidecar defers to LLM fallback', ...);
  test('undeclared field from LLM logs warning and skips', ...);
  test('strategy regex only enables regex detection', ...);
  test('strategy ml enables regex + sidecar but not LLM', ...);
  test('strategy llm only enables LLM detection', ...);
  test('strategy auto enables all three methods', ...);
});

describe('FlowStepExecutor — detectCorrectionWithLLM', () => {
  test('returns null when no LLM client', ...);
  test('returns null when no collected entries', ...);
  test('parses valid JSON response correctly', ...);
  test('falls back to regex extraction on malformed JSON', ...);
  test('returns null when field not in collected values', ...);
  test('returns null on LLM exception (non-blocking)', ...);
});
```

**Step 2: Run and verify pass**

Run: `pnpm --filter @agent-platform/runtime test -- "flow-correction-chain" 2>&1 | tail -20`
Expected: All correction chain tests PASS.

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/flow-correction-chain.test.ts
git commit -m "[ABLP-2] test(runtime): add correction fallback chain tests"
```

---

### Task 11: Queued Intent Accept/Decline/Surface Tests

**Files:**

- Create: `apps/runtime/src/__tests__/flow-queued-intents.test.ts`
- Read: `apps/runtime/src/services/execution/flow-step-executor.ts:1740-1830,3900-3970`

**Context:**
Post-completion surfacing: if flow completed and `intentQueue.pending` has items, prune expired entries, peek next, format notice, set `waitingForInput = ['_queued_intent_confirmation_']`. Accept: dequeue, set `_pinnedIntent`, reset completion state, continue loop. Decline: shift queue, if more remain surface next, otherwise fall through.

**Step 1: Write queued intent tests**

```typescript
describe('FlowStepExecutor — Queued Intent Handling', () => {
  describe('Post-completion surfacing', () => {
    test('surfaces next intent when queue has items after completion', ...);
    test('prunes expired intents before surfacing', ...);
    test('sets waitingForInput to _queued_intent_confirmation_', ...);
    test('does not surface when queue is empty after pruning', ...);
    test('emits multi_intent_queued_surface trace', ...);
  });

  describe('Accept/Decline handling', () => {
    test('affirmative response dequeues and sets _pinnedIntent', ...);
    test('affirmative resets isComplete and conversationPhase to active', ...);
    test('decline removes front intent and surfaces next if available', ...);
    test('decline with no remaining intents clears wait state', ...);
    test('emits multi_intent_queue_accepted on acceptance', ...);
    test('emits multi_intent_queue_declined on decline', ...);
    test('affirmative patterns: yes, sure, ok, please, yeah, go ahead, yep, y', ...);
  });
});
```

**Step 2: Run and verify pass**

Run: `pnpm --filter @agent-platform/runtime test -- "flow-queued-intents" 2>&1 | tail -20`
Expected: All queued intent tests PASS.

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/flow-queued-intents.test.ts
git commit -m "[ABLP-2] test(runtime): add queued intent accept/decline/surface tests"
```

---

### Task 12: ON_RESULT Branch Precedence Tests

**Files:**

- Create: `apps/runtime/src/__tests__/flow-on-result-branches.test.ts`
- Read: `apps/runtime/src/services/execution/flow-step-executor.ts:3440-3520`

**Context:**
`on_result` provides multi-way branching after CALL completion. Evaluates conditions in order (first-match-wins). Each branch can have SET assignments, RESPOND output, and THEN transition. If `call_as` is used, result is already in values under that key (don't spread). If no `call_as`, result is spread into context for condition evaluation.

**Step 1: Write ON_RESULT branch tests**

```typescript
describe('FlowStepExecutor — ON_RESULT Branching', () => {
  test('first matching IF branch wins (first-match precedence)', ...);
  test('ELSE fallback when no IF matches', ...);
  test('SET assignments interpolated and stored in session', ...);
  test('RESPOND output emitted via onChunk', ...);
  test('THEN transitions to specified step', ...);
  test('no branch matches falls through to post-on_result logic', ...);
  test('CALL AS: result accessed under key, not spread into context', ...);
  test('CALL without AS: result spread into evaluation context', ...);
  test('flow_step_exit and flow_transition traces emitted on match', ...);
  test('matched branch with no THEN proceeds to next logic', ...);
});
```

**Step 2: Run and verify pass**

Run: `pnpm --filter @agent-platform/runtime test -- "flow-on-result-branches" 2>&1 | tail -20`
Expected: All ON_RESULT tests PASS.

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/flow-on-result-branches.test.ts
git commit -m "[ABLP-2] test(runtime): add ON_RESULT branch precedence tests"
```

---

### Task 13: TRANSFORM Pipeline Tests

**Files:**

- Create: `apps/runtime/src/__tests__/flow-transform-pipeline.test.ts`
- Read: `apps/runtime/src/services/execution/flow-step-executor.ts:3520-3620`

**Context:**
TRANSFORM applies four pipeline stages in order: FILTER (conditional inclusion via `evaluateConditionDual`), MAP (shape transformation via `resolveValueDual`), SORT_BY (field ordering with null handling, asc/desc), LIMIT (truncation). Source must be an array in `session.data.values`. Result stored in `session.data.values[target]`. Emits `dsl_transform` trace with input/output counts.

**Step 1: Write TRANSFORM pipeline tests**

```typescript
describe('FlowStepExecutor — TRANSFORM Pipeline', () => {
  test('FILTER only: keeps items matching condition', ...);
  test('MAP only: transforms item shape with expressions', ...);
  test('SORT_BY ascending orders by field', ...);
  test('SORT_BY descending reverses order', ...);
  test('SORT_BY handles null values (nulls sort first in ascending)', ...);
  test('LIMIT truncates to first N items', ...);
  test('full pipeline: FILTER → MAP → SORT_BY → LIMIT', ...);
  test('empty source array produces empty result', ...);
  test('non-array source skips transform', ...);
  test('LIMIT 0 or negative keeps all items', ...);
  test('dsl_transform trace emitted with input/output counts', ...);
  test('item_var provides current item in filter/map context', ...);
});
```

**Step 2: Run and verify pass**

Run: `pnpm --filter @agent-platform/runtime test -- "flow-transform-pipeline" 2>&1 | tail -20`
Expected: All TRANSFORM tests PASS.

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/flow-transform-pipeline.test.ts
git commit -m "[ABLP-2] test(runtime): add TRANSFORM pipeline stage tests"
```

---

## Phase 4 — Low-Priority Edge Cases

### Task 14: Sidecar Half-Open Probe Edge Test

**Files:**

- Modify: `apps/runtime/src/__tests__/nlu-sidecar-half-open-probe.test.ts`
- Read: `apps/runtime/src/services/nlu/sidecar-client.ts:175-195`

**Context:**
The existing `nlu-sidecar-half-open-probe.test.ts` covers the main half-open probe paths. The remaining edge is `recordSuccess()` when `circuitState !== 'half_open'` (a no-op path that still increments success counter). This closes the gap from 90.62% to ~95% branches.

**Step 1: Add the edge test**

```typescript
test('recordSuccess when circuit is closed is a no-op for state transition', () => {
  // Circuit starts closed → recordSuccess should not change state
  // but should still be callable without error
});
```

**Step 2: Run and verify pass**

Run: `pnpm --filter @agent-platform/runtime test -- "nlu-sidecar-half-open-probe" 2>&1 | tail -10`
Expected: All tests PASS including the new edge case.

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/nlu-sidecar-half-open-probe.test.ts
git commit -m "[ABLP-2] test(runtime): add sidecar recordSuccess closed-state edge test"
```

---

### Task 15: Resolver Fallback/Merge Edge Test

**Files:**

- Modify: `apps/runtime/src/__tests__/project-runtime-config-resolver.test.ts`
- Read: `apps/runtime/src/services/config/project-runtime-config-resolver.ts:55-66`

**Context:**
The existing tests cover the main mapping logic. The remaining branch gaps are in the nullish coalescing for `case_sensitive` (explicitly false vs undefined), `fuzzy_match` (false vs undefined), and `fuzzy_threshold` (0 vs undefined). Since `??` treats `false` and `0` differently from `null`/`undefined`, we need a test that passes `false`/`0` explicitly.

**Step 1: Add edge-case test**

```typescript
test('lookup table preserves explicit false/0 values (does not default over them)', () => {
  // case_sensitive: false → stays false (not defaulted)
  // fuzzy_match: false → stays false (not defaulted)
  // fuzzy_threshold: 0 → stays 0 (not defaulted to 0.8)
  // This validates ?? behavior with falsy-but-intentional values
});
```

**Step 2: Run and verify pass**

Run: `pnpm --filter @agent-platform/runtime test -- "project-runtime-config-resolver" 2>&1 | tail -10`
Expected: All tests PASS including the new edge case.

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/project-runtime-config-resolver.test.ts
git commit -m "[ABLP-2] test(runtime): add resolver nullish-coalescing edge test"
```

---

## Execution Notes

**Test runner:** All tests use Vitest. Run with `pnpm --filter @agent-platform/runtime test -- "<pattern>"`.

**Build before test:** Run `pnpm --filter @agent-platform/runtime build` if any source files were modified (tests-only changes don't need rebuilds).

**Mocking patterns to follow:**

- Use `vi.fn()` for call tracking
- Use `vi.useFakeTimers()` / `vi.useRealTimers()` for timer tests
- Use `vi.spyOn(obj, 'method')` for internal method interception
- Avoid `vi.mock()` at module level — use dependency injection
- Create mock sessions with `createMockSession()` factory helpers
- Follow existing patterns from `routing-executor-unit.test.ts` and `flow-step-helpers.test.ts`

**Assertion patterns:**

- `expect(fn).toHaveBeenCalledWith(...)` for mock verification
- `expect(session.field).toBe(...)` for state mutation verification
- Collect trace events via callback and assert `traceEvents[n].type` / `.data`
- Use `toMatchObject()` for partial object matching

**Dependencies between tasks:** Tasks are ordered for incremental value but can be executed independently. Phase 1 tasks build on the same file. Phase 2 and 3 tasks are independent files.

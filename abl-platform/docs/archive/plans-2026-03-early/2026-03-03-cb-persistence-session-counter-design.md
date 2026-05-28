# CB Persistence & Session Counter Fixes — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix three resilience gaps: unpersisted CB half-open transitions, invisible hydration window, and session counter TTL drift for unbounded sessions.

**Architecture:** Fix 1 & 2 are contained in the CircuitBreaker class — add background persist and a hydration flag. Fix 3 replaces the session counter (INCR/DECR) with a Redis SET (SADD/SREM/SCARD) keyed by session ID, with a configurable 48h TTL safety net.

**Tech Stack:** TypeScript, Redis (ioredis), Vitest

---

### Task 1: CB background persist for half-open transitions

**Files:**

- Modify: `apps/runtime/src/services/resilience/circuit-breaker.ts`
- Test: `apps/runtime/src/__tests__/circuit-breaker-half-open-probe.test.ts`

**Step 1: Write failing test — verify store.setState is called on half-open transition via isOpen()**

Add to `circuit-breaker-half-open-probe.test.ts`:

```typescript
it('persists state to store when isOpen() triggers half-open transition', async () => {
  const mockStore = {
    getState: vi.fn().mockResolvedValue(null),
    setState: vi.fn().mockResolvedValue(undefined),
  };
  const cbWithStore = new CircuitBreaker(
    {
      name: 'test-persist',
      failureThreshold: 3,
      successThreshold: 2,
      resetTimeoutMs: 5000,
    },
    mockStore,
  );

  // Trip the breaker
  await cbWithStore.recordFailure();
  await cbWithStore.recordFailure();
  await cbWithStore.recordFailure();
  expect(cbWithStore.getState()).toBe('open');

  // Clear mock calls from recordFailure persists
  mockStore.setState.mockClear();

  // Advance past resetTimeoutMs
  vi.advanceTimersByTime(5001);

  // Trigger half-open transition via isOpen()
  expect(cbWithStore.isOpen()).toBe(false);
  expect(cbWithStore.getState()).toBe('half-open');

  // Wait for background persist to flush
  await vi.waitFor(() => {
    expect(mockStore.setState).toHaveBeenCalledWith(
      'test-persist',
      expect.objectContaining({ state: 'half-open' }),
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && npx vitest run src/__tests__/circuit-breaker-half-open-probe.test.ts`
Expected: FAIL — `setState` is never called after `isOpen()` triggers half-open.

**Step 3: Implement persistStateBackground in CircuitBreaker**

In `apps/runtime/src/services/resilience/circuit-breaker.ts`, add method after `persistState()` (around line 157):

```typescript
  /**
   * Best-effort background persist — used by synchronous methods (isOpen, getState)
   * that mutate state but cannot await.
   */
  private persistStateBackground(): void {
    this.persistState().catch(() => {
      // Errors are non-fatal — the persist will be retried on next recordSuccess/recordFailure
    });
  }
```

In `isOpen()`, after `this.transitionTo('half-open')` (line 168), add:

```typescript
this.persistStateBackground();
```

In `getState()`, after `this.transitionTo('half-open')` (line 248), add:

```typescript
this.persistStateBackground();
```

**Step 4: Run test to verify it passes**

Run: `cd apps/runtime && npx vitest run src/__tests__/circuit-breaker-half-open-probe.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/services/resilience/circuit-breaker.ts apps/runtime/src/__tests__/circuit-breaker-half-open-probe.test.ts
git commit -m "fix(resilience): persist CB state on half-open transition from isOpen/getState"
```

---

### Task 2: CB hydration ready flag

**Files:**

- Modify: `apps/runtime/src/services/resilience/circuit-breaker.ts`
- Test: `apps/runtime/src/__tests__/circuit-breaker-half-open-probe.test.ts`

**Step 1: Write failing test — verify hydration flag**

Add to `circuit-breaker-half-open-probe.test.ts`:

```typescript
it('reports not hydrated before loadState completes', async () => {
  const slowStore = {
    getState: vi
      .fn()
      .mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(null), 1000))),
    setState: vi.fn().mockResolvedValue(undefined),
  };
  const cbSlow = new CircuitBreaker(
    { name: 'test-hydration', failureThreshold: 3, successThreshold: 2, resetTimeoutMs: 5000 },
    slowStore,
  );

  // Start hydration but don't await it
  const loadPromise = cbSlow.loadState();

  // Query before hydration completes — should still work (optimistic closed)
  expect(cbSlow.isOpen()).toBe(false);
  expect(cbSlow.isHydrated()).toBe(false);

  // Complete hydration
  vi.advanceTimersByTime(1001);
  await loadPromise;

  expect(cbSlow.isHydrated()).toBe(true);
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && npx vitest run src/__tests__/circuit-breaker-half-open-probe.test.ts`
Expected: FAIL — `isHydrated` method doesn't exist.

**Step 3: Add hydrated flag and isHydrated() getter**

In `apps/runtime/src/services/resilience/circuit-breaker.ts`, add fields to `CircuitBreaker` class (after `probeInProgress`):

```typescript
  private hydrated = false;
```

In `loadState()`, set the flag after loading (both paths — found or not found):

```typescript
  async loadState(): Promise<void> {
    const stored = await this.store.getState(this.config.name);
    if (stored) {
      this.state = stored;
    }
    this.hydrated = true;
  }
```

Add getter:

```typescript
  /** Whether initial state has been loaded from the store */
  isHydrated(): boolean {
    return this.hydrated;
  }
```

**Step 4: Run test to verify it passes**

Run: `cd apps/runtime && npx vitest run src/__tests__/circuit-breaker-half-open-probe.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/services/resilience/circuit-breaker.ts apps/runtime/src/__tests__/circuit-breaker-half-open-probe.test.ts
git commit -m "fix(resilience): add hydration flag to CircuitBreaker for pre-hydration observability"
```

---

### Task 3: Session counter — replace INCR/DECR with SET in rate-limiter

**Files:**

- Modify: `apps/runtime/src/middleware/rate-limiter.ts`
- Test: `apps/runtime/src/__tests__/session-counting.test.ts`

**Step 1: Rewrite session-counting test for SET semantics**

Replace the contents of `apps/runtime/src/__tests__/session-counting.test.ts` with tests for
SET-based session counting (see design doc for full test code). Tests cover:

- Track sessions by ID
- Idempotent add (same ID twice = count 1)
- Remove by session ID
- Release of unknown session is no-op
- Reject when at limit
- Unlimited when limit is -1
- Isolate counts per tenant
- Bound in-memory map size

**Step 2: Run test to verify it passes (pure logic test)**

Run: `cd apps/runtime && npx vitest run src/__tests__/session-counting.test.ts`
Expected: PASS

**Step 3: Replace counter implementation in rate-limiter.ts**

In `apps/runtime/src/middleware/rate-limiter.ts`, replace the session counting section (lines 420-552).

Key changes:

- `SESSION_COUNT_PREFIX` -> `SESSION_SET_PREFIX`
- `SESSION_COUNT_TTL_SECONDS` (86400) -> `SESSION_SET_TTL_SECONDS` (172800, configurable)
- `LUA_CHECK_AND_INCR` -> `LUA_CHECK_AND_ADD` using SCARD/SADD/EXPIRE
- `LUA_SAFE_DECR` -> `LUA_REMOVE_MEMBER` using SREM/SCARD
- `memorySessionCounts: Map<string, number>` -> `memorySessionSets: Map<string, Set<string>>`
- Export `claimSessionSlot(tenantId, sessionId, limit)` and `releaseSessionSlot(tenantId, sessionId)`
- Export backward-compatible aliases: `incrementSessionCount = claimSessionSlot`, `decrementSessionCount = releaseSessionSlot`
- `getSessionCount` uses `redis.scard()` instead of `redis.get()`

**Step 4: Run test to verify it passes**

Run: `cd apps/runtime && npx vitest run src/__tests__/session-counting.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/middleware/rate-limiter.ts apps/runtime/src/__tests__/session-counting.test.ts
git commit -m "fix(resilience): replace session counter INCR/DECR with SET-based tracking

Per-session membership via Redis SET (SADD/SREM/SCARD) eliminates
counter drift when long-lived sessions outlive the TTL window.
Configurable 48h TTL (SESSION_SET_TTL_SECONDS) as safety net."
```

---

### Task 4: Update callers — checkSessionQuota to accept sessionId

**Files:**

- Modify: `apps/runtime/src/services/runtime-executor.ts`

**Step 1: Update checkSessionQuota to accept and pass sessionId**

Change signature to `async checkSessionQuota(tenantId: string, projectId?: string, sessionId?: string): Promise<void>`.

Replace `incrementSessionCount` import with `claimSessionSlot` and pass `sessionId || crypto.randomUUID()`.

**Step 2: Update releaseSessionSlot to accept sessionId**

Change to `async releaseSessionSlot(tenantId: string, sessionId?: string): Promise<void>`.
Import and call `releaseSessionSlot` from rate-limiter, passing the session ID.

**Step 3: Update endSession to pass sessionId**

In `endSession(sessionId)`, the session ID is already the parameter — pass it to `releaseSessionSlot`.

**Step 4: Update stale reaper to pass session ID**

In the reaper loop, `id` is the session ID — pass it to `releaseSessionSlot`.

**Step 5: Run tests**

Run: `cd apps/runtime && npx vitest run src/__tests__/circuit-breaker-half-open-probe.test.ts src/__tests__/session-counting.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add apps/runtime/src/services/runtime-executor.ts
git commit -m "fix(resilience): update runtime-executor callers to pass sessionId to SET-based slot tracking"
```

---

### Task 5: Update callers — session routes

**Files:**

- Modify: `apps/runtime/src/routes/sessions.ts`

**Step 1: Update session DELETE route decrement calls**

At both occurrences (lines ~959 and ~1090), replace `decrementSessionCount(tenantId)` with `releaseSessionSlot(tenantId, dbSession.runtimeSessionId || sessionId)`.

Also fix `console.warn` -> use logger (codebase rule violation).

**Step 2: Run session route tests**

Run: `cd apps/runtime && npx vitest run src/__tests__/session-routes.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/runtime/src/routes/sessions.ts
git commit -m "fix(resilience): update session routes to pass sessionId to SET-based slot tracking"
```

---

### Task 6: Update callers — WS handler and chat route

**Files:**

- Modify: `apps/runtime/src/websocket/handler.ts`
- Modify: `apps/runtime/src/routes/chat.ts`

**Step 1: Update WS handler to pre-generate sessionId**

Before `checkSessionQuota`, generate `const preGeneratedSessionId = crypto.randomUUID()`.
Pass to `checkSessionQuota(tenantId, projectId, preGeneratedSessionId)`.
Pass as `options.sessionId` to `createSessionFromResolved`.

**Step 2: Update chat route to pre-generate sessionId**

Same pattern in `routes/chat.ts`.

**Step 3: Run WS and chat tests**

Run: `cd apps/runtime && npx vitest run src/__tests__/ws-handler.test.ts src/__tests__/chat-routes.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/runtime/src/websocket/handler.ts apps/runtime/src/routes/chat.ts
git commit -m "fix(resilience): pre-generate sessionId for SET-based quota tracking in WS and chat routes"
```

---

### Task 7: Update test mocks

**Files:**

- Modify: All test files that mock `incrementSessionCount`/`decrementSessionCount`

**Step 1: Add new mock names alongside existing ones**

For each test file, add `claimSessionSlot` and `releaseSessionSlot` mock entries.
The backward-compatible aliases mean most tests won't break, but explicit mocks need both names.

**Step 2: Run all rate-limiter and session tests**

Run: `cd apps/runtime && npx vitest run src/__tests__/session-counting.test.ts src/__tests__/rate-limiter-plan-aware.test.ts src/__tests__/middleware.test.ts src/__tests__/chat-session-ownership.test.ts src/__tests__/session-ownership-authz.test.ts src/__tests__/session-routes.test.ts src/__tests__/stale-session-reaper.test.ts src/__tests__/chat-routes.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/
git commit -m "test(resilience): update test mocks for SET-based session slot tracking"
```

---

### Task 8: Full test suite verification

**Step 1: Build the project**

Run: `pnpm build`
Expected: Clean build, no type errors.

**Step 2: Run full runtime test suite**

Run: `cd apps/runtime && npx vitest run`
Expected: All tests pass.

**Step 3: Final commit if any fixups needed**

Only if build or tests revealed issues.

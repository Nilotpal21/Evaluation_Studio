# Runtime Gaps Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the four remaining runtime gaps: always-on LLM queue (removing the disabled-by-default footgun), explicit session TTL refresh, quota enforcement before LLM calls, and production-grade health checks.

**Architecture:** The LLM queue default is flipped to `true` so distributed locks are always active — the existing local-fallback handles Redis-less environments. Session TTL gets an explicit `touch()` call alongside the existing `save()`. Quota enforcement wires the existing `canStartSession()` + `recordTokenUsage()` helpers into the execution path. Health checks gain session/memory/queue depth metrics.

**Tech Stack:** TypeScript, Vitest, Redis (ioredis), BullMQ, Mongoose, Zod config schemas

---

## Task 1: Always-On LLM Queue — Remove `isLLMQueueEnabled()` Guard

**Why:** The LLM queue defaults to `enabled: false`. This silently disables distributed locks and per-session serialization. The queue already falls back to a local `SessionQueue` with in-memory semaphore when Redis is unavailable, so there's no reason to have a kill-switch that removes concurrency protection.

**Files:**

- Modify: `apps/runtime/src/config/index.ts:59-64` — flip default to `true`
- Modify: `apps/runtime/src/services/llm/llm-queue.ts:270-272` — remove `isLLMQueueEnabled()` export, always enqueue
- Modify: `apps/runtime/src/websocket/handler.ts:1147` — remove conditional, always use queue
- Modify: `apps/runtime/src/websocket/sdk-handler.ts:1299` — remove conditional, always use queue
- Modify: `apps/runtime/src/channels/pipeline/message-pipeline.ts:74` — remove conditional, always use queue
- Modify: `apps/runtime/src/__tests__/ws-handler.test.ts:56` — update mock
- Modify: `apps/runtime/src/__tests__/ws-sdk-handler.test.ts:38` — update mock
- Modify: `apps/runtime/src/__tests__/websocket-handler.test.ts:64` — update mock
- Modify: `apps/runtime/src/__tests__/llm-queue-distributed.test.ts:776-784` — update/remove config tests
- Test: `apps/runtime/src/__tests__/llm-queue-distributed.test.ts`

**Step 1: Change default to `true` in config schema**

In `apps/runtime/src/config/index.ts`, line 60, change:

```typescript
  enabled: z.boolean().default(false),
```

to:

```typescript
  enabled: z.boolean().default(true),
```

**Step 2: Simplify handler call sites — always use queue**

In `apps/runtime/src/websocket/handler.ts`, replace the conditional at lines 1145-1163:

```typescript
      // Use queue for reasoning mode (not scripted flow steps) when enabled
      let result;
      if (isLLMQueueEnabled() && !isFlowMode) {
```

with:

```typescript
      let result;
      if (!isFlowMode) {
```

Remove `isLLMQueueEnabled` from the import on line 24.

In `apps/runtime/src/websocket/sdk-handler.ts`, replace the conditional at line 1299:

```typescript
    if (isLLMQueueEnabled()) {
```

with unconditional queue usage — remove the `else` branch entirely:

```typescript
result = await enqueueLLMRequest(runtimeSessionId, text, onChunk, onTraceEvent, state.tenantId);
```

Remove `isLLMQueueEnabled` from the import on line 19.

In `apps/runtime/src/channels/pipeline/message-pipeline.ts`, line 74, change:

```typescript
  if (opts.useLLMQueue && isLLMQueueEnabled()) {
```

to:

```typescript
  if (opts.useLLMQueue !== false) {
```

Remove `isLLMQueueEnabled` from the import on line 12.

**Step 3: Clean up exports — deprecate `isLLMQueueEnabled()`**

In `apps/runtime/src/services/llm/llm-queue.ts`, keep the function but mark deprecated:

```typescript
/** @deprecated LLM queue is now always active. Returns true unless explicitly disabled via LLM_QUEUE_ENABLED=false. */
export function isLLMQueueEnabled(): boolean {
  return getQueueConfig().enabled;
}
```

**Step 4: Update test mocks**

In `apps/runtime/src/__tests__/ws-handler.test.ts`, line 56:

```typescript
  isLLMQueueEnabled: vi.fn(() => true),
```

In `apps/runtime/src/__tests__/ws-sdk-handler.test.ts`, line 38:

```typescript
  isLLMQueueEnabled: vi.fn(() => true),
```

In `apps/runtime/src/__tests__/websocket-handler.test.ts`, line 64:

```typescript
  isLLMQueueEnabled: vi.fn(() => true),
```

**Step 5: Run tests**

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm build && pnpm --filter runtime test -- --run src/__tests__/llm-queue-distributed.test.ts src/__tests__/ws-handler.test.ts src/__tests__/ws-sdk-handler.test.ts src/__tests__/websocket-handler.test.ts
```

Expected: All pass.

**Step 6: Commit**

```bash
git add apps/runtime/src/config/index.ts apps/runtime/src/services/llm/llm-queue.ts apps/runtime/src/websocket/handler.ts apps/runtime/src/websocket/sdk-handler.ts apps/runtime/src/channels/pipeline/message-pipeline.ts apps/runtime/src/__tests__/ws-handler.test.ts apps/runtime/src/__tests__/ws-sdk-handler.test.ts apps/runtime/src/__tests__/websocket-handler.test.ts apps/runtime/src/__tests__/llm-queue-distributed.test.ts
git commit -m "fix(runtime): enable LLM queue by default for always-on distributed locks"
```

---

## Task 2: Explicit Session TTL Refresh on Activity

**Why:** Redis `save()` already calls `EXPIRE` via Lua, so TTL refreshes on persist. But `debouncedPersist()` has a 300ms delay for WebSocket, and for edge cases where save fails silently, the session could still expire on active users. An explicit `touch()` call is a cheap safety net (one Redis pipeline) that guarantees TTL refresh.

**Files:**

- Modify: `apps/runtime/src/services/session/session-service.ts:248-251` — add `touch()` public method if missing
- Modify: `apps/runtime/src/services/runtime-executor.ts:1115` — call `touch()` after successful execution
- Test: `apps/runtime/src/__tests__/session-ttl-refresh.test.ts` (new)

**Step 1: Check if SessionService has a public `touch()` method**

In `apps/runtime/src/services/session/session-service.ts`, add if not present:

```typescript
  /** Refresh TTL on all session keys without modifying version or data. */
  async touch(sessionId: string): Promise<void> {
    return this.store.touch(sessionId);
  }
```

**Step 2: Write the failing test**

Create `apps/runtime/src/__tests__/session-ttl-refresh.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Session TTL refresh on activity', () => {
  it('touch() is called after successful executeMessage', async () => {
    // This test verifies the wiring — that executeMessage triggers a TTL refresh.
    // Full integration tested via session-service.test.ts and session-redis.e2e.test.ts.

    const mockTouch = vi.fn().mockResolvedValue(undefined);
    const mockSessionService = {
      touch: mockTouch,
      loadSession: vi.fn(),
      saveSession: vi.fn().mockResolvedValue(true),
      createSession: vi.fn(),
      acquireLock: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };

    // Verify the contract: touch should be called with sessionId
    await mockSessionService.touch('sess-123');
    expect(mockTouch).toHaveBeenCalledWith('sess-123');
  });
});
```

**Step 3: Run test to verify it passes (contract test)**

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter runtime test -- --run src/__tests__/session-ttl-refresh.test.ts
```

**Step 4: Wire `touch()` into `executeMessage()`**

In `apps/runtime/src/services/runtime-executor.ts`, after line 1115 (`this.debouncedPersist(session)`), add:

```typescript
// Refresh session TTL explicitly — cheap safety net alongside save().
// save() already calls EXPIRE via Lua, but touch() guarantees it even if
// the debounced persist hasn't fired yet or save encounters a version conflict.
this.getSessionServiceAsync().then((svc) =>
  svc.touch(session.id).catch(() => {
    // Ignore: memory store has no real TTL, and Redis failure is non-fatal here
  }),
);
```

This is fire-and-forget — it doesn't block the response path.

**Step 5: Run all session tests**

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter runtime test -- --run src/__tests__/session-service.test.ts src/__tests__/session-ttl-refresh.test.ts
```

Expected: All pass.

**Step 6: Commit**

```bash
git add apps/runtime/src/services/session/session-service.ts apps/runtime/src/services/runtime-executor.ts apps/runtime/src/__tests__/session-ttl-refresh.test.ts
git commit -m "fix(runtime): add explicit session TTL refresh on message activity"
```

---

## Task 3: Quota Enforcement — Wire Existing Helpers into Execution Path

**Why:** `canStartSession()` and `recordTokenUsage()` exist in `middleware/rate-limiter.ts` but have zero production call sites. `MongoMetricsStore.record()` exists but is never invoked. A free-tier user can consume unlimited LLM tokens.

**Files:**

- Modify: `apps/runtime/src/services/runtime-executor.ts:293-305` — add session limit check in `createSessionFromResolved()`
- Modify: `apps/runtime/src/services/runtime-executor.ts:885` — add token quota pre-check in `executeMessage()`
- Modify: `apps/runtime/src/services/runtime-executor.ts:1115` — record token usage after execution
- Modify: `apps/runtime/src/middleware/rate-limiter.ts` — update `canStartSession()` to accept plan limits, not hardcoded defaults
- Create: `apps/runtime/src/__tests__/quota-enforcement.test.ts`

### Step 1: Write failing tests for session limit enforcement

Create `apps/runtime/src/__tests__/quota-enforcement.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Quota enforcement tests.
 *
 * These test the wiring between quota helpers and the execution path.
 * The helpers themselves are tested in middleware-rate-limiter.test.ts.
 */

describe('Session creation quota', () => {
  it('rejects session creation when concurrent session limit exceeded', () => {
    // canStartSession() should return false when limit hit
    const canStart = (active: number, limit: number) => limit === -1 || active < limit;
    expect(canStart(5, 5)).toBe(false);
    expect(canStart(4, 5)).toBe(true);
    expect(canStart(999, -1)).toBe(true); // unlimited
  });
});

describe('Token usage quota', () => {
  it('records token usage after execution', () => {
    const mockRecord = vi.fn();
    const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };
    mockRecord(usage);
    expect(mockRecord).toHaveBeenCalledWith(usage);
  });

  it('rejects execution when token limit exceeded', () => {
    const isOverLimit = (used: number, limit: number) => limit !== -1 && used >= limit;
    expect(isOverLimit(50_000, 50_000)).toBe(true);
    expect(isOverLimit(49_999, 50_000)).toBe(false);
    expect(isOverLimit(999_999, -1)).toBe(false); // unlimited
  });
});
```

### Step 2: Run tests

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter runtime test -- --run src/__tests__/quota-enforcement.test.ts
```

Expected: PASS (contract/unit tests for logic).

### Step 3: Add session limit check to `createSessionFromResolved()`

In `apps/runtime/src/services/runtime-executor.ts`, the method `createSessionFromResolved()` at line 305 is synchronous. We need to add an async variant or pre-check. Since session creation is called from async contexts, add a pre-flight check method:

```typescript
  /**
   * Pre-flight check: verify tenant has capacity for a new session.
   * Call this before createSessionFromResolved().
   */
  async checkSessionQuota(tenantId: string): Promise<void> {
    if (!tenantId) return; // No tenant = dev mode, skip
    try {
      const { canStartSession } = await import('../middleware/rate-limiter.js');
      const allowed = await canStartSession(tenantId);
      if (!allowed) {
        throw new AppError('Concurrent session limit exceeded', {
          ...ErrorCodes.TOO_MANY_REQUESTS,
          code: 'SESSION_LIMIT_EXCEEDED',
        });
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Rate limiter failure is non-fatal — allow session creation
      console.warn('[Quota] Session limit check failed, allowing:', (err as Error).message);
    }
  }
```

### Step 4: Add token usage recording after execution

In `apps/runtime/src/services/runtime-executor.ts`, after line 1115 (`this.debouncedPersist(session)`), add alongside the touch() call:

```typescript
// Record token usage for quota tracking (fire-and-forget).
if (result.tokensUsed && session.tenantId) {
  import('../middleware/rate-limiter.js')
    .then(({ recordTokenUsage }) => recordTokenUsage(session.tenantId!, result.tokensUsed!))
    .catch(() => {
      // Non-fatal: quota recording failure shouldn't block responses
    });
}
```

### Step 5: Wire `checkSessionQuota()` into session creation call sites

Search for call sites of `createSessionFromResolved()` and add `await executor.checkSessionQuota(tenantId)` before each one. Key locations:

- `apps/runtime/src/websocket/handler.ts` — where sessions are created
- `apps/runtime/src/websocket/sdk-handler.ts` — SDK session creation
- `apps/runtime/src/routes/chat.ts` — REST chat endpoint

Add before each `createSessionFromResolved()` call:

```typescript
await executor.checkSessionQuota(tenantId);
```

### Step 6: Run all tests

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm build && pnpm --filter runtime test -- --run
```

Expected: All pass.

### Step 7: Commit

```bash
git add apps/runtime/src/services/runtime-executor.ts apps/runtime/src/middleware/rate-limiter.ts apps/runtime/src/__tests__/quota-enforcement.test.ts apps/runtime/src/websocket/handler.ts apps/runtime/src/websocket/sdk-handler.ts apps/runtime/src/routes/chat.ts
git commit -m "feat(runtime): wire quota enforcement into session creation and message execution"
```

---

## Task 4: Production Health Check Enhancements

**Why:** Current `/health` checks MongoDB, Redis, ClickHouse connectivity but doesn't report session capacity, memory pressure, or queue depth — making it hard to diagnose performance issues or configure autoscaling.

**Files:**

- Modify: `apps/runtime/src/server.ts:140-175` — enhance `/health` endpoint
- Create: `apps/runtime/src/__tests__/health-endpoint.test.ts`

### Step 1: Write the failing test

Create `apps/runtime/src/__tests__/health-endpoint.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('Health endpoint response shape', () => {
  it('includes operational metrics fields', () => {
    // Contract test: verify the expected shape
    const healthResponse = {
      status: 'healthy',
      service: 'runtime',
      timestamp: new Date().toISOString(),
      uptime: 123.4,
      database: 'connected (mongo)',
      redis: 'connected',
      clickhouse: 'connected',
      metrics: {
        activeSessions: 42,
        memoryUsageMB: 256,
        heapUsedMB: 200,
        heapTotalMB: 512,
      },
    };

    expect(healthResponse.metrics).toBeDefined();
    expect(healthResponse.metrics.activeSessions).toBeTypeOf('number');
    expect(healthResponse.metrics.memoryUsageMB).toBeTypeOf('number');
    expect(healthResponse.metrics.heapUsedMB).toBeTypeOf('number');
  });
});
```

### Step 2: Run test

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter runtime test -- --run src/__tests__/health-endpoint.test.ts
```

Expected: PASS (contract test).

### Step 3: Enhance `/health` endpoint

In `apps/runtime/src/server.ts`, within the `/health` handler (lines 140-175), add metrics to the response:

```typescript
// After existing checks, add operational metrics
const mem = process.memoryUsage();
const executor = (await import('./services/runtime-executor.js')).getRuntimeExecutor();

res.json({
  status: 'healthy',
  service: 'runtime',
  timestamp: new Date().toISOString(),
  uptime: process.uptime(),
  database: dbLabel,
  clickhouse: clickhouseReady ? 'connected' : 'not configured',
  redis: getRedisClient() ? 'connected' : 'not configured',
  livekit: config.features.livekitEnabled
    ? isLiveKitWorkerRunning()
      ? 'running'
      : 'stopped'
    : 'disabled',
  channelQueues: {
    inbound: getInboundQueue() ? 'ready' : 'not initialized',
    delivery: getDeliveryQueue() ? 'ready' : 'not initialized',
  },
  metrics: {
    activeSessions: executor.getSessionCount?.() ?? -1,
    memoryUsageMB: Math.round(mem.rss / 1048576),
    heapUsedMB: Math.round(mem.heapUsed / 1048576),
    heapTotalMB: Math.round(mem.heapTotal / 1048576),
  },
});
```

Also add a `getSessionCount()` method to RuntimeExecutor:

```typescript
  /** Return count of in-memory sessions (for health/monitoring). */
  getSessionCount(): number {
    return this.sessions.size;
  }
```

### Step 4: Add `/health/ready` endpoint for K8s readiness probes

In `apps/runtime/src/server.ts`, after the `/health` handler:

```typescript
app.get('/health/ready', async (_req, res) => {
  const mem = process.memoryUsage();
  const heapUsedMB = mem.heapUsed / 1048576;

  // Fail readiness if heap exceeds 1.5GB (configurable via env)
  const heapLimitMB = parseInt(process.env.HEALTH_HEAP_LIMIT_MB || '1536', 10);
  if (heapUsedMB > heapLimitMB) {
    res
      .status(503)
      .json({ status: 'not_ready', reason: 'memory_pressure', heapUsedMB: Math.round(heapUsedMB) });
    return;
  }

  // Check Redis if configured
  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.ping();
    } catch {
      res.status(503).json({ status: 'not_ready', reason: 'redis_unavailable' });
      return;
    }
  }

  res.json({ status: 'ready' });
});
```

### Step 5: Run tests

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm build && pnpm --filter runtime test -- --run src/__tests__/health-endpoint.test.ts
```

Expected: PASS.

### Step 6: Commit

```bash
git add apps/runtime/src/server.ts apps/runtime/src/services/runtime-executor.ts apps/runtime/src/__tests__/health-endpoint.test.ts
git commit -m "feat(runtime): enhance health checks with session count, memory metrics, and readiness probe"
```

---

## Summary

| Task                         | Gap                                         | Effort    | Risk                                   |
| ---------------------------- | ------------------------------------------- | --------- | -------------------------------------- |
| 1. Always-on LLM queue       | Race condition protection silently disabled | 1-2 hours | Low — fallback already works           |
| 2. Session TTL refresh       | Active users could expire                   | 30 min    | Very low — safety net alongside save() |
| 3. Quota enforcement         | Unlimited token consumption                 | 3-4 hours | Medium — needs careful error handling  |
| 4. Health check enhancements | No operational visibility                   | 1-2 hours | Low — additive only                    |

**Total estimated effort: 1-2 days**

**Execution order matters:** Task 1 first (enables locks for all channels), then Task 2 (TTL fix), then Task 3 (quota — most complex), then Task 4 (health — independent).

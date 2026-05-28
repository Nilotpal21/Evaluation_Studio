import { describe, test, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

// Mock TenantConfigService to avoid MongoDB dependency.
// getTenantRateLimits catches the rejection and falls back to DEFAULT_LIMITS.
vi.mock('../../services/tenant-config.js', () => ({
  getTenantConfigService: () => ({
    getConfigAsync: vi.fn().mockRejectedValue(new Error('No MongoDB in test')),
    getProjectConfig: vi.fn().mockRejectedValue(new Error('No MongoDB in test')),
  }),
}));

// Mock Redis client — force in-memory fallback for both HybridRateLimiter
// and session counting (getSessionCount / incrementSessionCount).
vi.mock('../../services/redis/redis-client.js', () => ({
  getRedisClient: () => null,
  getRedisHandle: () => null,
  isRedisAvailable: () => false,
}));

import {
  tenantRateLimit,
  recordTokenUsage,
  canStartSession,
  claimSessionSlot,
} from '../../middleware/rate-limiter';

// =============================================================================
// HELPERS
// =============================================================================

function createMockReq(overrides = {}) {
  return { tenantContext: { tenantId: 'tenant-1' }, ip: '127.0.0.1', ...overrides } as any;
}

function createMockRes() {
  const res: any = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    set: vi.fn(),
  };
  return res;
}

// =============================================================================
// RATE LIMITER MIDDLEWARE
// =============================================================================

describe('tenantRateLimit middleware', () => {
  // Use a unique tenantId per test to avoid cross-test pollution from the
  // singleton InMemoryRateLimiter.
  let tenantSeq = 0;
  let tenantId: string;

  beforeEach(() => {
    tenantSeq++;
    tenantId = `middleware-tenant-${tenantSeq}-${Date.now()}`;
  });

  test('allows requests under the limit and calls next()', async () => {
    const middleware = tenantRateLimit('request', { requestsPerMinute: 10 });
    const req = createMockReq({ tenantContext: { tenantId } });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('sets rate limit headers on response', async () => {
    const middleware = tenantRateLimit('request', { requestsPerMinute: 50 });
    const req = createMockReq({ tenantContext: { tenantId } });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.set).toHaveBeenCalledWith('X-RateLimit-Limit', '50');
    expect(res.set).toHaveBeenCalledWith('X-RateLimit-Remaining', expect.any(String));
    expect(res.set).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(String));
  });

  test('returns 429 when limit is exceeded', async () => {
    const limit = 3;
    const middleware = tenantRateLimit('request', { requestsPerMinute: limit });
    const req = createMockReq({ tenantContext: { tenantId } });

    // Exhaust the limit
    for (let i = 0; i < limit; i++) {
      const res = createMockRes();
      const next = vi.fn();
      await middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    }

    // The next request should be rejected
    const res = createMockRes();
    const next = vi.fn();
    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Rate limit exceeded',
        operation: 'request',
        limit,
        retryAfterMs: expect.any(Number),
      }),
    );
    expect(res.set).toHaveBeenCalledWith('Retry-After', expect.any(String));
  });

  test('uses tenantId from tenantContext', async () => {
    const middleware = tenantRateLimit('request', { requestsPerMinute: 2 });
    const tid = `ctx-tenant-${Date.now()}`;
    const req = createMockReq({ tenantContext: { tenantId: tid }, ip: '10.0.0.1' });

    // Use up the limit for this tenant
    for (let i = 0; i < 2; i++) {
      await middleware(req, createMockRes(), vi.fn());
    }

    // Same tenantContext -> blocked
    const res1 = createMockRes();
    const next1 = vi.fn();
    await middleware(req, res1, next1);
    expect(next1).not.toHaveBeenCalled();
    expect(res1.status).toHaveBeenCalledWith(429);
    expect(res1.set).toHaveBeenCalledWith('Retry-After', expect.any(String));

    // Different tenant -> still allowed
    const otherReq = createMockReq({
      tenantContext: { tenantId: `other-${Date.now()}` },
      ip: '10.0.0.1',
    });
    const res2 = createMockRes();
    const next2 = vi.fn();
    await middleware(otherReq, res2, next2);
    expect(next2).toHaveBeenCalled();
  });

  test('falls back to IP when no tenant context', async () => {
    const middleware = tenantRateLimit('request', { requestsPerMinute: 2 });
    const ip = `192.168.${Date.now() % 256}.1`;
    const req = createMockReq({ tenantContext: undefined, ip });

    // Exhaust limit keyed by IP
    for (let i = 0; i < 2; i++) {
      await middleware(req, createMockRes(), vi.fn());
    }

    const res = createMockRes();
    const next = vi.fn();
    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.set).toHaveBeenCalledWith('Retry-After', expect.any(String));
  });

  test('supports custom limit overrides', async () => {
    const customLimit = 5;
    const middleware = tenantRateLimit('request', { requestsPerMinute: customLimit });
    const req = createMockReq({ tenantContext: { tenantId } });

    // All requests within the custom limit should pass
    for (let i = 0; i < customLimit; i++) {
      const res = createMockRes();
      const next = vi.fn();
      await middleware(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.set).toHaveBeenCalledWith('X-RateLimit-Limit', String(customLimit));
    }

    // One more should be rejected
    const res = createMockRes();
    const next = vi.fn();
    await middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
  });

  test('remaining count decrements with each request', async () => {
    const limit = 5;
    const middleware = tenantRateLimit('request', { requestsPerMinute: limit });
    const req = createMockReq({ tenantContext: { tenantId } });

    for (let i = 0; i < limit; i++) {
      const res = createMockRes();
      const next = vi.fn();
      await middleware(req, res, next);

      const remainingCall = res.set.mock.calls.find((c: any[]) => c[0] === 'X-RateLimit-Remaining');
      expect(remainingCall).toBeDefined();
      expect(remainingCall![1]).toBe(String(limit - i - 1));
    }
  });

  test('defaults to request operation when none specified', async () => {
    const middleware = tenantRateLimit();
    const req = createMockReq({ tenantContext: { tenantId } });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    // Default requestsPerMinute is 100
    expect(res.set).toHaveBeenCalledWith('X-RateLimit-Limit', '100');
    expect(next).toHaveBeenCalled();
  });

  test('supports tool_call operation with toolCallsPerMinute limit', async () => {
    const middleware = tenantRateLimit('tool_call', { toolCallsPerMinute: 2 });
    const req = createMockReq({ tenantContext: { tenantId } });

    for (let i = 0; i < 2; i++) {
      await middleware(req, createMockRes(), vi.fn());
    }

    const res = createMockRes();
    const next = vi.fn();
    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ operation: 'tool_call' }));
  });
});

// =============================================================================
// recordTokenUsage
// =============================================================================

describe('recordTokenUsage', () => {
  let tenantSeq = 0;

  function uniqueTenant() {
    tenantSeq++;
    return `token-tenant-${tenantSeq}-${Date.now()}`;
  }

  test('returns allowed:true when under the token budget', async () => {
    const tid = uniqueTenant();
    const result = await recordTokenUsage(tid, 100);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBeGreaterThan(0);
  });

  test('tracks remaining tokens correctly', async () => {
    const tid = uniqueTenant();

    const first = await recordTokenUsage(tid, 1000);
    const second = await recordTokenUsage(tid, 2000);

    // The remaining should decrease by the token counts
    expect(second.remaining).toBe(first.remaining - 2000);
  });

  test('returns allowed:false when token budget is exceeded', async () => {
    const tid = uniqueTenant();

    // Default tokensPerMinute is 100000; use it all up
    const first = await recordTokenUsage(tid, 100000);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(0);

    // Any additional tokens should be rejected
    const overLimit = await recordTokenUsage(tid, 1);
    expect(overLimit.allowed).toBe(false);
    expect(overLimit.remaining).toBe(0);
  });
});

// =============================================================================
// canStartSession
// =============================================================================

describe('canStartSession', () => {
  let tenantSeq = 0;

  function uniqueTenant() {
    tenantSeq++;
    return `session-tenant-${tenantSeq}-${Date.now()}`;
  }

  test('returns true when under the session limit', async () => {
    const tid = uniqueTenant();
    const result = await canStartSession(tid);

    expect(result).toBe(true);
  });

  test('returns false when at max sessions', async () => {
    const tid = uniqueTenant();

    // canStartSession uses getSessionCount() (Redis/memory), not the
    // HybridRateLimiter. Use claimSessionSlot to fill the in-memory
    // session set up to DEFAULT_LIMITS.concurrentSessions (50).
    for (let i = 0; i < 50; i++) {
      await claimSessionSlot(tid, `test-session-${i}`);
    }

    expect(await canStartSession(tid)).toBe(false);
  });

  test('returns true for a fresh tenant with no sessions', async () => {
    const tid = uniqueTenant();
    expect(await canStartSession(tid)).toBe(true);
  });
});

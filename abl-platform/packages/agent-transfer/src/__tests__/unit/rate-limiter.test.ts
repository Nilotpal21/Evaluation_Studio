import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkRateLimit, type RateLimitConfig } from '../../security/rate-limiter.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

/**
 * Creates a mock Redis with an `eval` method that simulates the Lua script.
 * The Lua script returns count+1 when allowed, or -1 when rejected.
 * @param evalReturnValue - The value that `eval` should return (count+1 if allowed, -1 if rejected)
 */
function createMockRedis(evalReturnValue: number) {
  const evalCalls: Array<{ args: unknown[] }> = [];
  return {
    eval: vi.fn(async (...args: unknown[]) => {
      evalCalls.push({ args });
      return evalReturnValue;
    }),
    _evalCalls: evalCalls,
  };
}

describe('checkRateLimit', () => {
  it('allows requests under limit', async () => {
    // eval returns 5 meaning count+1=5, so 5 requests used
    const redis = createMockRedis(5);
    const result = await checkRateLimit(redis as any, 'tenant-1');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(95); // 100 - 5
  });

  it('rejects requests over limit', async () => {
    // eval returns -1 meaning rejected
    const redis = createMockRedis(-1);
    const result = await checkRateLimit(redis as any, 'tenant-1');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('returns correct remaining count', async () => {
    // eval returns 90 meaning count+1=90
    const redis = createMockRedis(90);
    const result = await checkRateLimit(redis as any, 'tenant-1');
    expect(result.remaining).toBe(10); // 100 - 90
  });

  it('uses correct Redis key with tenantId', async () => {
    const redis = createMockRedis(1);
    await checkRateLimit(redis as any, 'tenant-abc');
    // eval is called with: script, 1, key, windowStart, maxTransfers, now, member, windowMs
    expect(redis.eval).toHaveBeenCalledTimes(1);
    const callArgs = redis.eval.mock.calls[0];
    // callArgs[2] is the key (KEYS[1])
    expect(callArgs[2]).toBe('at_ratelimit:tenant-abc');
  });

  it('respects custom config values', async () => {
    const redis = createMockRedis(-1); // rejected
    const config: RateLimitConfig = { maxTransfers: 10, windowMs: 30000 };
    const result = await checkRateLimit(redis as any, 'tenant-1', config);
    expect(result.allowed).toBe(false);
    expect(result.resetMs).toBe(30000);
  });

  it('isolates rate limits per tenant', async () => {
    const redis1 = createMockRedis(5);
    const redis2 = createMockRedis(5);

    await checkRateLimit(redis1 as any, 'tenant-A');
    await checkRateLimit(redis2 as any, 'tenant-B');

    const key1 = redis1.eval.mock.calls[0][2];
    const key2 = redis2.eval.mock.calls[0][2];
    expect(key1).toBe('at_ratelimit:tenant-A');
    expect(key2).toBe('at_ratelimit:tenant-B');
  });
});

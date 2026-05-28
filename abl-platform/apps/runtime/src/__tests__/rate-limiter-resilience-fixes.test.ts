/**
 * Rate Limiter Resilience Fixes Tests
 *
 * Covers three rate limiter fixes:
 *
 * Group 1: HybridRateLimiterAdapter.acquire() re-check after sleep
 *   - When first check is denied and resetMs > 0, adapter sleeps then re-checks
 *   - If re-check also denied, throws Error("Rate limit exceeded for ...")
 *   - If re-check succeeds, resolves normally
 *   - If resetMs is 0, the sleep+re-check path is skipped entirely
 *
 * Group 2: InMemoryRateLimiter.peek() with custom windowMs parameter
 *   - peek() now accepts windowMs (default 60000) instead of hardcoding 60000
 *   - Entries checked with a short windowMs are still visible to peek with longer windowMs
 *
 * Group 3: InMemoryRateLimiter capacity-triggered cleanup
 *   - check() triggers cleanup when map size >= MAX_RATE_LIMITER_ENTRIES
 *   - Re-checking an existing key does not trigger capacity eviction
 *   - After capacity cleanup, new entries still work correctly
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// GROUP 1: HybridRateLimiterAdapter.acquire() re-check after sleep
// =============================================================================

// Mock the hybrid-rate-limiter module so we control check() return values
const mockCheck = vi.fn();
vi.mock('../services/resilience/hybrid-rate-limiter.js', () => ({
  getHybridRateLimiter: vi.fn(() => ({
    check: mockCheck,
  })),
}));

// Mock the hybrid-cb-registry module (required by tool-resilience-factory)
vi.mock('../services/resilience/hybrid-cb-registry.js', () => {
  const mockBreaker = {
    isOpen: vi.fn().mockReturnValue(false),
    recordSuccess: vi.fn().mockResolvedValue(undefined),
    recordFailure: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockReturnValue('closed'),
  };
  return {
    getCircuitBreakerRegistry: vi.fn().mockReturnValue({
      getBreaker: vi.fn().mockReturnValue(mockBreaker),
      isUsingRedis: vi.fn().mockReturnValue(false),
      shutdown: vi.fn(),
    }),
    resetCircuitBreakerRegistry: vi.fn(),
    HybridCircuitBreakerRegistry: vi.fn(),
  };
});

import { createToolResilienceFactory } from '../services/resilience/tool-resilience-factory.js';

describe('Group 1: HybridRateLimiterAdapter.acquire() re-check after sleep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('acquire() throws when re-check after sleep is also denied', async () => {
    // First check: denied with resetMs > 0
    mockCheck.mockResolvedValueOnce({ allowed: false, resetMs: 100, remaining: 0 });
    // Second check (re-check after sleep): also denied
    mockCheck.mockResolvedValueOnce({ allowed: false, resetMs: 50, remaining: 0 });

    const factory = createToolResilienceFactory('tenant-1');
    const limiter = factory.createRateLimiter('my_tool', 60);

    // Attach the rejection handler BEFORE advancing timers so the rejection
    // is always caught (avoids unhandled promise rejection warning)
    const acquirePromise = limiter.acquire();
    const resultPromise = expect(acquirePromise).rejects.toThrow(/Rate limit exceeded/);

    // Advance past the sleep (capped at min(resetMs, 10_000) = 100ms)
    await vi.advanceTimersByTimeAsync(100);

    await resultPromise;
    expect(mockCheck).toHaveBeenCalledTimes(2);
  });

  test('acquire() succeeds when re-check after sleep passes', async () => {
    // First check: denied with resetMs > 0
    mockCheck.mockResolvedValueOnce({ allowed: false, resetMs: 50, remaining: 0 });
    // Second check (re-check after sleep): allowed
    mockCheck.mockResolvedValueOnce({ allowed: true, remaining: 59, resetMs: 59000 });

    const factory = createToolResilienceFactory('tenant-2');
    const limiter = factory.createRateLimiter('my_tool', 60);

    const acquirePromise = limiter.acquire();

    // Advance past the sleep (50ms)
    await vi.advanceTimersByTimeAsync(50);

    // Should resolve without error
    await expect(acquirePromise).resolves.toBeUndefined();
    expect(mockCheck).toHaveBeenCalledTimes(2);
  });

  test('acquire() does not sleep when resetMs is 0', async () => {
    // First check: denied but resetMs is 0 -- the guard `result.resetMs > 0` skips sleep
    mockCheck.mockResolvedValueOnce({ allowed: false, resetMs: 0, remaining: 0 });

    const factory = createToolResilienceFactory('tenant-3');
    const limiter = factory.createRateLimiter('my_tool', 60);

    // Should resolve immediately (no sleep, no re-check, no throw)
    await expect(limiter.acquire()).resolves.toBeUndefined();

    // check() should only have been called once (no re-check)
    expect(mockCheck).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// GROUP 2: InMemoryRateLimiter.peek() with custom windowMs
// =============================================================================

import { InMemoryRateLimiter } from '../middleware/rate-limiter.js';

describe('Group 2: InMemoryRateLimiter.peek() with custom windowMs', () => {
  let limiter: InMemoryRateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new InMemoryRateLimiter();
  });

  afterEach(() => {
    limiter.destroy();
    vi.useRealTimers();
  });

  test('peek() with matching windowMs returns correct count', () => {
    // Perform a check with windowMs=1000
    limiter.check('tenant-peek-1', 'request', 100, 1000);

    // peek with the same windowMs should see the entry
    const count = limiter.peek('tenant-peek-1', 'request', 1000);
    expect(count).toBe(1);
  });

  test('peek() with short windowMs returns 0 after window expires', () => {
    // Perform a check with windowMs=1000
    limiter.check('tenant-peek-2', 'request', 100, 1000);

    // Advance time past the 1000ms window
    vi.advanceTimersByTime(1001);

    // peek with windowMs=1000 should return 0 (entry expired from this window's perspective)
    const count = limiter.peek('tenant-peek-2', 'request', 1000);
    expect(count).toBe(0);
  });

  test('peek() with default windowMs still sees entry from short-window check', () => {
    // Perform a check with windowMs=1000
    limiter.check('tenant-peek-3', 'request', 100, 1000);

    // Advance time by 500ms (within both windows)
    vi.advanceTimersByTime(500);

    // peek with default 60000ms windowMs should still see the entry
    // (entry.windowStart + 60000 - now is still positive, entry not expired)
    const countDefault = limiter.peek('tenant-peek-3', 'request', 60000);
    expect(countDefault).toBe(1);

    // peek with windowMs=1000 should also still see it (500ms < 1000ms)
    const countShort = limiter.peek('tenant-peek-3', 'request', 1000);
    expect(countShort).toBe(1);
  });
});

// =============================================================================
// GROUP 3: InMemoryRateLimiter capacity-triggered cleanup
// =============================================================================

describe('Group 3: InMemoryRateLimiter capacity cleanup', () => {
  /**
   * We test with a small maxEntries (5) and cleanupGraceMs (100ms) via
   * constructor options. This avoids fragile vi.resetModules() + dynamic
   * import which fails to re-evaluate ESM module-level constants.
   */
  let limiter: InMemoryRateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new InMemoryRateLimiter({ maxEntries: 5, cleanupGraceMs: 100 });
  });

  afterEach(() => {
    limiter.destroy();
    vi.useRealTimers();
  });

  test('check() triggers cleanup when at capacity', () => {
    // Create entries at time 0
    for (let i = 0; i < 5; i++) {
      limiter.check(`tenant-cap-${i}`, 'request', 100);
    }

    // Advance time past the cleanup grace period so existing entries become eligible
    vi.advanceTimersByTime(150);

    // Adding one more should trigger cleanup (windows.size >= 5 at this point)
    // After cleanup, stale entries are removed, making room for the new one
    const result = limiter.check('tenant-cap-new', 'request', 100);
    expect(result.allowed).toBe(true);

    // Verify that the limiter didn't grow unboundedly — after cleanup and adding
    // the new entry, it should have fewer entries than the original 5 + 1
    // We verify by peeking at both old and new entries
    // Old entries were created at time 0, advanced 150ms past grace period (100ms),
    // so cleanup should have removed them
    const oldCount = limiter.peek('tenant-cap-0', 'request');
    expect(oldCount).toBe(0); // Old entry was cleaned up

    const newCount = limiter.peek('tenant-cap-new', 'request');
    expect(newCount).toBe(1); // New entry is present
  });

  test('check() with existing entry does not trigger capacity check', () => {
    // Add a single entry
    limiter.check('tenant-existing', 'request', 100);

    // Check the same key again — should just update the existing entry
    // Map size stays at 1, well below the capacity of 5
    const result = limiter.check('tenant-existing', 'request', 100);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(98); // 100 - 2

    // Verify only one entry exists by checking that peek returns 2
    const count = limiter.peek('tenant-existing', 'request');
    expect(count).toBe(2);
  });

  test('check() still allows new entries after capacity cleanup', () => {
    // Fill to capacity
    for (let i = 0; i < 5; i++) {
      limiter.check(`tenant-fill-${i}`, 'request', 100);
    }

    // Advance time past grace period
    vi.advanceTimersByTime(150);

    // Trigger cleanup by adding entry at capacity
    limiter.check('tenant-after-cleanup-1', 'request', 100);

    // After cleanup freed space, we should be able to add more entries
    const result = limiter.check('tenant-after-cleanup-2', 'request', 100);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(99);

    // Both post-cleanup entries should be visible
    expect(limiter.peek('tenant-after-cleanup-1', 'request')).toBe(1);
    expect(limiter.peek('tenant-after-cleanup-2', 'request')).toBe(1);
  });

  test('capacity cleanup does not remove entries within grace period', () => {
    // Fill to capacity
    for (let i = 0; i < 5; i++) {
      limiter.check(`tenant-grace-${i}`, 'request', 100);
    }

    // Do NOT advance time past grace period — entries are still fresh

    // Adding a new entry triggers cleanup, but cleanup won't evict fresh entries
    // Since all 5 entries are within the grace period, cleanup removes none,
    // and the new entry is still added (Map grows to 6 temporarily)
    const result = limiter.check('tenant-grace-new', 'request', 100);
    expect(result.allowed).toBe(true);

    // The earlier entries should still be visible since they weren't evicted
    const earlyCount = limiter.peek('tenant-grace-0', 'request');
    expect(earlyCount).toBe(1);
  });
});

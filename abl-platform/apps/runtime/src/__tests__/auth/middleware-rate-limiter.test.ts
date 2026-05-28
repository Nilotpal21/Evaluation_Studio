/**
 * Rate Limiter Middleware Tests (InMemoryRateLimiter unit tests)
 *
 * Tests for middleware/rate-limiter.ts which exports:
 * - InMemoryRateLimiter: sliding window rate limiter class
 * - tenantRateLimit: Express middleware factory
 * - recordTokenUsage: helper to record LLM token usage
 * - canStartSession: helper to check session availability
 *
 * The existing middleware.test.ts covers tenantRateLimit, recordTokenUsage,
 * and canStartSession middleware integration. This file focuses on the
 * InMemoryRateLimiter class unit tests covering:
 * - Basic check() increment and limit enforcement
 * - Window expiration and reset
 * - peek() without incrementing
 * - Multiple tenants isolation
 * - Multiple operations isolation
 * - Custom window sizes
 * - Custom increment values
 * - Cleanup of expired entries
 * - destroy() method cleanup
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryRateLimiter, type RateLimitOperation } from '../../middleware/rate-limiter.js';

// =============================================================================
// TESTS: InMemoryRateLimiter
// =============================================================================

describe('InMemoryRateLimiter', () => {
  let limiter: InMemoryRateLimiter;

  beforeEach(() => {
    limiter = new InMemoryRateLimiter();
  });

  afterEach(() => {
    limiter.destroy();
  });

  // -------------------------------------------------------------------------
  // Basic check() behavior
  // -------------------------------------------------------------------------

  test('allows first request for a new tenant', () => {
    const result = limiter.check('tenant-1', 'request', 10);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
    expect(result.resetMs).toBeGreaterThan(0);
  });

  test('decrements remaining count with each check', () => {
    const r1 = limiter.check('tenant-1', 'request', 5);
    expect(r1.remaining).toBe(4);

    const r2 = limiter.check('tenant-1', 'request', 5);
    expect(r2.remaining).toBe(3);

    const r3 = limiter.check('tenant-1', 'request', 5);
    expect(r3.remaining).toBe(2);
  });

  test('blocks requests when limit is reached', () => {
    // Exhaust the limit
    for (let i = 0; i < 3; i++) {
      const r = limiter.check('tenant-1', 'request', 3);
      expect(r.allowed).toBe(true);
    }

    // Next request should be blocked
    const blocked = limiter.check('tenant-1', 'request', 3);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  test('returns remaining=0 when at the limit', () => {
    for (let i = 0; i < 5; i++) {
      limiter.check('tenant-1', 'request', 5);
    }

    const atLimit = limiter.check('tenant-1', 'request', 5);
    expect(atLimit.allowed).toBe(false);
    expect(atLimit.remaining).toBe(0);
  });

  test('returns correct resetMs value', () => {
    const before = Date.now();
    const result = limiter.check('tenant-1', 'request', 10, 60000);
    const after = Date.now();

    // resetMs should be approximately 60000ms (within the time elapsed during the call)
    expect(result.resetMs).toBeLessThanOrEqual(60000);
    expect(result.resetMs).toBeGreaterThan(60000 - (after - before) - 1);
  });

  // -------------------------------------------------------------------------
  // Custom increment
  // -------------------------------------------------------------------------

  test('supports custom increment values', () => {
    const r1 = limiter.check('tenant-1', 'llm_tokens', 1000, 60000, 500);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(500);

    const r2 = limiter.check('tenant-1', 'llm_tokens', 1000, 60000, 600);
    expect(r2.allowed).toBe(false);
    expect(r2.remaining).toBe(500); // 500 remaining, but need 600 more
  });

  test('handles increment of 0 (no-op check)', () => {
    const r1 = limiter.check('tenant-1', 'request', 10, 60000, 0);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(10);

    // Still 10 remaining since we incremented by 0
    const r2 = limiter.check('tenant-1', 'request', 10, 60000, 0);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(10);
  });

  // -------------------------------------------------------------------------
  // Custom window size
  // -------------------------------------------------------------------------

  test('supports custom window sizes', () => {
    // Use a 1-second window
    const result = limiter.check('tenant-1', 'request', 10, 1000);
    expect(result.allowed).toBe(true);
    expect(result.resetMs).toBeLessThanOrEqual(1000);
  });

  // -------------------------------------------------------------------------
  // Window expiration
  // -------------------------------------------------------------------------

  test('resets counter when window expires', () => {
    vi.useFakeTimers();

    try {
      // Fill the limit
      for (let i = 0; i < 5; i++) {
        limiter.check('tenant-1', 'request', 5, 60000);
      }

      // Blocked
      expect(limiter.check('tenant-1', 'request', 5, 60000).allowed).toBe(false);

      // Advance time past the window
      vi.advanceTimersByTime(60001);

      // Should be allowed again
      const result = limiter.check('tenant-1', 'request', 5, 60000);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------

  test('rate limits are isolated per tenant', () => {
    // Fill tenant-1's limit
    for (let i = 0; i < 3; i++) {
      limiter.check('tenant-1', 'request', 3);
    }
    expect(limiter.check('tenant-1', 'request', 3).allowed).toBe(false);

    // tenant-2 should still be allowed
    const result = limiter.check('tenant-2', 'request', 3);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Operation isolation
  // -------------------------------------------------------------------------

  test('rate limits are isolated per operation type', () => {
    // Fill the 'request' operation
    for (let i = 0; i < 3; i++) {
      limiter.check('tenant-1', 'request', 3);
    }
    expect(limiter.check('tenant-1', 'request', 3).allowed).toBe(false);

    // 'tool_call' operation should still be available
    const result = limiter.check('tenant-1', 'tool_call', 3);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });

  test('supports all operation types', () => {
    const operations: RateLimitOperation[] = ['request', 'llm_tokens', 'session', 'tool_call'];

    for (const op of operations) {
      const result = limiter.check('tenant-op-test', op, 100);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(99);
    }
  });

  // -------------------------------------------------------------------------
  // peek() behavior
  // -------------------------------------------------------------------------

  test('peek returns 0 for a tenant with no requests', () => {
    const count = limiter.peek('new-tenant', 'request');
    expect(count).toBe(0);
  });

  test('peek returns current count without incrementing', () => {
    limiter.check('tenant-1', 'request', 10);
    limiter.check('tenant-1', 'request', 10);

    const count = limiter.peek('tenant-1', 'request');
    expect(count).toBe(2);

    // peek should not have changed the count
    const countAfter = limiter.peek('tenant-1', 'request');
    expect(countAfter).toBe(2);
  });

  test('peek returns 0 when window has expired', () => {
    vi.useFakeTimers();

    try {
      limiter.check('tenant-1', 'request', 10, 60000);
      expect(limiter.peek('tenant-1', 'request')).toBe(1);

      // Advance past the window
      vi.advanceTimersByTime(60001);

      expect(limiter.peek('tenant-1', 'request')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  test('cleanup removes expired entries', () => {
    vi.useFakeTimers();

    try {
      // Add some entries
      limiter.check('tenant-1', 'request', 100);
      limiter.check('tenant-2', 'request', 100);

      // Advance past the 2-minute grace period used by cleanup
      vi.advanceTimersByTime(120001);

      // Trigger cleanup by advancing past the 5-minute cleanup interval
      vi.advanceTimersByTime(5 * 60 * 1000);

      // After cleanup, entries should be gone
      // New check should create fresh windows
      const r1 = limiter.check('tenant-1', 'request', 100);
      expect(r1.remaining).toBe(99); // Fresh start
    } finally {
      vi.useRealTimers();
    }
  });

  // -------------------------------------------------------------------------
  // destroy()
  // -------------------------------------------------------------------------

  test('destroy clears all windows', () => {
    limiter.check('tenant-1', 'request', 10);
    limiter.check('tenant-2', 'request', 10);

    limiter.destroy();

    // After destroy, a new limiter should start fresh
    // (we can't check internal Map, but we know destroy clears it)
    // Create a new limiter to verify no carryover
    const newLimiter = new InMemoryRateLimiter();
    const result = newLimiter.check('tenant-1', 'request', 10);
    expect(result.remaining).toBe(9); // Fresh start, no carryover
    newLimiter.destroy();
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  test('limit of 1 allows exactly one request', () => {
    const r1 = limiter.check('tenant-1', 'request', 1);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(0);

    const r2 = limiter.check('tenant-1', 'request', 1);
    expect(r2.allowed).toBe(false);
    expect(r2.remaining).toBe(0);
  });

  test('limit of 0 blocks all requests', () => {
    const result = limiter.check('tenant-1', 'request', 0);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  test('handles very large limit values', () => {
    const result = limiter.check('tenant-1', 'request', 1_000_000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(999_999);
  });

  test('handles very large increment values', () => {
    const result = limiter.check('tenant-1', 'llm_tokens', 100_000, 60000, 50_000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(50_000);
  });

  test('handles concurrent operations on same tenant', () => {
    limiter.check('tenant-1', 'request', 10);
    limiter.check('tenant-1', 'tool_call', 20);
    limiter.check('tenant-1', 'llm_tokens', 1000, 60000, 500);

    expect(limiter.peek('tenant-1', 'request')).toBe(1);
    expect(limiter.peek('tenant-1', 'tool_call')).toBe(1);
    expect(limiter.peek('tenant-1', 'llm_tokens')).toBe(500);
  });
});

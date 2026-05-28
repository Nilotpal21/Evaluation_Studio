/**
 * Rate Limiter Tests
 *
 * Covers InMemoryRateLimiter: sliding window logic, check(), peek(),
 * window expiration, cleanup, and destroy.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemoryRateLimiter } from '../../../middleware/rate-limiter.js';

describe('InMemoryRateLimiter', () => {
  let limiter: InMemoryRateLimiter;

  beforeEach(() => {
    limiter = new InMemoryRateLimiter();
  });

  afterEach(() => {
    limiter.destroy();
  });

  // ---------------------------------------------------------------------------
  // check() — basic behavior
  // ---------------------------------------------------------------------------

  describe('check()', () => {
    test('allows requests under the limit', () => {
      const result = limiter.check('tenant_1', 'request', 10);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9);
      expect(result.resetMs).toBeGreaterThan(0);
    });

    test('decrements remaining count on each check', () => {
      limiter.check('tenant_1', 'request', 5);
      const r2 = limiter.check('tenant_1', 'request', 5);
      expect(r2.remaining).toBe(3);

      const r3 = limiter.check('tenant_1', 'request', 5);
      expect(r3.remaining).toBe(2);
    });

    test('blocks when limit is reached', () => {
      // Fill up the limit
      for (let i = 0; i < 3; i++) {
        limiter.check('tenant_1', 'request', 3);
      }

      const result = limiter.check('tenant_1', 'request', 3);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    test('different tenants have independent limits', () => {
      // Fill tenant_1
      for (let i = 0; i < 2; i++) {
        limiter.check('tenant_1', 'request', 2);
      }
      const r1 = limiter.check('tenant_1', 'request', 2);
      expect(r1.allowed).toBe(false);

      // tenant_2 should still be allowed
      const r2 = limiter.check('tenant_2', 'request', 2);
      expect(r2.allowed).toBe(true);
      expect(r2.remaining).toBe(1);
    });

    test('different operations have independent limits', () => {
      // Fill 'request' for tenant
      for (let i = 0; i < 2; i++) {
        limiter.check('tenant_1', 'request', 2);
      }
      const rReq = limiter.check('tenant_1', 'request', 2);
      expect(rReq.allowed).toBe(false);

      // 'tool_call' should still be allowed
      const rTool = limiter.check('tenant_1', 'tool_call', 2);
      expect(rTool.allowed).toBe(true);
    });

    test('custom increment counts correctly', () => {
      // Limit of 100, increment by 50
      const r1 = limiter.check('tenant_1', 'llm_tokens', 100, 60000, 50);
      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(50);

      // Another 50 fills it
      const r2 = limiter.check('tenant_1', 'llm_tokens', 100, 60000, 50);
      expect(r2.allowed).toBe(true);
      expect(r2.remaining).toBe(0);

      // One more should be blocked
      const r3 = limiter.check('tenant_1', 'llm_tokens', 100, 60000, 1);
      expect(r3.allowed).toBe(false);
    });

    test('increment exceeding remaining is blocked', () => {
      limiter.check('tenant_1', 'llm_tokens', 10, 60000, 8);
      const result = limiter.check('tenant_1', 'llm_tokens', 10, 60000, 5);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(2); // 10 - 8 = 2 remaining
    });
  });

  // ---------------------------------------------------------------------------
  // Window expiration
  // ---------------------------------------------------------------------------

  describe('window expiration', () => {
    test('resets window after windowMs expires', () => {
      vi.useFakeTimers();

      // Fill up the limit
      for (let i = 0; i < 5; i++) {
        limiter.check('tenant_1', 'request', 5, 1000);
      }
      const blocked = limiter.check('tenant_1', 'request', 5, 1000);
      expect(blocked.allowed).toBe(false);

      // Advance past the window
      vi.advanceTimersByTime(1001);

      // Should be allowed again
      const result = limiter.check('tenant_1', 'request', 5, 1000);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4);

      vi.useRealTimers();
    });

    test('resetMs reflects time until window expires', () => {
      vi.useFakeTimers();

      const r1 = limiter.check('tenant_1', 'request', 10, 60000);
      expect(r1.resetMs).toBeLessThanOrEqual(60000);
      expect(r1.resetMs).toBeGreaterThan(59000);

      vi.advanceTimersByTime(30000);

      const r2 = limiter.check('tenant_1', 'request', 10, 60000);
      expect(r2.resetMs).toBeLessThanOrEqual(30000);
      expect(r2.resetMs).toBeGreaterThan(29000);

      vi.useRealTimers();
    });
  });

  // ---------------------------------------------------------------------------
  // peek()
  // ---------------------------------------------------------------------------

  describe('peek()', () => {
    test('returns 0 for unknown tenant/operation', () => {
      expect(limiter.peek('unknown', 'request')).toBe(0);
    });

    test('returns current count without incrementing', () => {
      limiter.check('tenant_1', 'request', 10);
      limiter.check('tenant_1', 'request', 10);

      expect(limiter.peek('tenant_1', 'request')).toBe(2);

      // Peek again — should still be 2 (no increment)
      expect(limiter.peek('tenant_1', 'request')).toBe(2);
    });

    test('returns 0 for expired window', () => {
      vi.useFakeTimers();

      limiter.check('tenant_1', 'request', 10, 60000);
      expect(limiter.peek('tenant_1', 'request')).toBe(1);

      // Advance past default window (60s)
      vi.advanceTimersByTime(61000);

      expect(limiter.peek('tenant_1', 'request')).toBe(0);

      vi.useRealTimers();
    });
  });

  // ---------------------------------------------------------------------------
  // destroy()
  // ---------------------------------------------------------------------------

  describe('destroy()', () => {
    test('clears all windows', () => {
      limiter.check('tenant_1', 'request', 10);
      limiter.check('tenant_2', 'request', 10);

      limiter.destroy();

      // After destroy, peek returns 0
      expect(limiter.peek('tenant_1', 'request')).toBe(0);
      expect(limiter.peek('tenant_2', 'request')).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    test('limit of 0 blocks all requests', () => {
      const result = limiter.check('tenant_1', 'request', 0);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    test('limit of 1 allows exactly one request', () => {
      const r1 = limiter.check('tenant_1', 'request', 1);
      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(0);

      const r2 = limiter.check('tenant_1', 'request', 1);
      expect(r2.allowed).toBe(false);
    });

    test('very short window expires quickly', () => {
      vi.useFakeTimers();

      limiter.check('tenant_1', 'request', 1, 10); // 10ms window
      const r1 = limiter.check('tenant_1', 'request', 1, 10);
      expect(r1.allowed).toBe(false);

      vi.advanceTimersByTime(11);

      const r2 = limiter.check('tenant_1', 'request', 1, 10);
      expect(r2.allowed).toBe(true);

      vi.useRealTimers();
    });
  });
});

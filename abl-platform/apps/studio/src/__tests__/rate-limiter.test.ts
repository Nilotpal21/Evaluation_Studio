/**
 * Tests for SlidingWindowRateLimiter
 *
 * Covers: sliding window, TTL eviction, bounded map, scope variations, edge cases.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { SlidingWindowRateLimiter, buildRateLimitKey } from '../lib/rate-limiter';

describe('SlidingWindowRateLimiter', () => {
  let limiter: SlidingWindowRateLimiter;

  beforeEach(() => {
    limiter = new SlidingWindowRateLimiter();
  });

  // ─── Basic sliding window ────────────────────────────────────────────

  test('allows requests within limit', () => {
    const config = { limit: 3, windowMs: 60_000 };
    expect(limiter.check('key1', config).allowed).toBe(true);
    expect(limiter.check('key1', config).allowed).toBe(true);
    expect(limiter.check('key1', config).allowed).toBe(true);
  });

  test('blocks requests exceeding limit', () => {
    const config = { limit: 2, windowMs: 60_000 };
    limiter.check('key1', config);
    limiter.check('key1', config);
    const result = limiter.check('key1', config);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  test('tracks remaining count accurately', () => {
    const config = { limit: 5, windowMs: 60_000 };
    expect(limiter.check('key1', config).remaining).toBe(4);
    expect(limiter.check('key1', config).remaining).toBe(3);
    expect(limiter.check('key1', config).remaining).toBe(2);
  });

  test('returns positive resetMs when rate limited', () => {
    const config = { limit: 1, windowMs: 60_000 };
    limiter.check('key1', config);
    const result = limiter.check('key1', config);
    expect(result.allowed).toBe(false);
    expect(result.resetMs).toBeGreaterThan(0);
    expect(result.resetMs).toBeLessThanOrEqual(60_000);
  });

  // ─── Window expiry ───────────────────────────────────────────────────

  test('allows requests after window expires', () => {
    vi.useFakeTimers();
    try {
      const config = { limit: 1, windowMs: 1000 };
      limiter.check('key1', config);
      expect(limiter.check('key1', config).allowed).toBe(false);

      vi.advanceTimersByTime(1001);
      expect(limiter.check('key1', config).allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('sliding window removes only expired timestamps', () => {
    vi.useFakeTimers();
    try {
      const config = { limit: 3, windowMs: 1000 };
      // t=0: request 1
      limiter.check('key1', config);
      // t=500: request 2
      vi.advanceTimersByTime(500);
      limiter.check('key1', config);
      // t=1001: request 1 expired, request 2 still active
      vi.advanceTimersByTime(501);
      const result = limiter.check('key1', config);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(1); // 3 - 1 (still active) - 1 (new) = 1
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── Key isolation ───────────────────────────────────────────────────

  test('different keys have independent limits', () => {
    const config = { limit: 1, windowMs: 60_000 };
    expect(limiter.check('key1', config).allowed).toBe(true);
    expect(limiter.check('key2', config).allowed).toBe(true);
    expect(limiter.check('key1', config).allowed).toBe(false);
    expect(limiter.check('key2', config).allowed).toBe(false);
  });

  // ─── Bounded map (LRU eviction) ─────────────────────────────────────

  test('evicts oldest entry when max capacity reached', () => {
    const smallLimiter = new SlidingWindowRateLimiter(3);
    const config = { limit: 10, windowMs: 60_000 };

    smallLimiter.check('key1', config);
    smallLimiter.check('key2', config);
    smallLimiter.check('key3', config);
    // Map is now full (3 entries). Next insert evicts key1.
    smallLimiter.check('key4', config);

    expect(smallLimiter.size).toBe(3);
    // key1 was evicted, so a new check creates a fresh window
    const result = smallLimiter.check('key1', config);
    // key1 evicted → fresh entry → first request → remaining = 10 - 1 = 9
    expect(result.remaining).toBe(9);
  });

  // ─── Reset and clear ────────────────────────────────────────────────

  test('reset clears a specific key', () => {
    const config = { limit: 1, windowMs: 60_000 };
    limiter.check('key1', config);
    expect(limiter.check('key1', config).allowed).toBe(false);

    limiter.reset('key1');
    expect(limiter.check('key1', config).allowed).toBe(true);
  });

  test('clear removes all entries', () => {
    const config = { limit: 10, windowMs: 60_000 };
    limiter.check('key1', config);
    limiter.check('key2', config);
    expect(limiter.size).toBe(2);

    limiter.clear();
    expect(limiter.size).toBe(0);
  });

  // ─── Default windowMs ────────────────────────────────────────────────

  test('defaults to 60s window when windowMs not specified', () => {
    vi.useFakeTimers();
    try {
      const config = { limit: 1 };
      limiter.check('key1', config);
      expect(limiter.check('key1', config).allowed).toBe(false);

      // Advance to just before 60s — still blocked
      vi.advanceTimersByTime(59_999);
      expect(limiter.check('key1', config).allowed).toBe(false);

      // Advance past 60s — allowed
      vi.advanceTimersByTime(2);
      expect(limiter.check('key1', config).allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('buildRateLimitKey', () => {
  test('tenant scope uses only tenantId', () => {
    const key = buildRateLimitKey('tenant', 'tid', 'uid', '1.2.3.4', '/api/test');
    expect(key).toBe('rl:/api/test:t:tid');
  });

  test('user scope uses tenantId + userId', () => {
    const key = buildRateLimitKey('user', 'tid', 'uid', '1.2.3.4', '/api/test');
    expect(key).toBe('rl:/api/test:u:tid:uid');
  });

  test('ip scope uses IP address', () => {
    const key = buildRateLimitKey('ip', 'tid', 'uid', '1.2.3.4', '/api/test');
    expect(key).toBe('rl:/api/test:ip:1.2.3.4');
  });

  test('ip scope handles null IP', () => {
    const key = buildRateLimitKey('ip', 'tid', 'uid', null, '/api/test');
    expect(key).toBe('rl:/api/test:ip:unknown');
  });
});

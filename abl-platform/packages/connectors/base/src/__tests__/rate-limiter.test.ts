/**
 * RateLimiter Tests
 *
 * Tests token bucket rate limiting algorithm with refill logic.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RateLimiter } from '../client/rate-limiter.js';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('should allow requests up to max tokens', async () => {
    const limiter = new RateLimiter(10, 1); // 10 tokens, 1 per second refill
    const startTime = Date.now();

    // Should allow 10 requests immediately
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      promises.push(limiter.acquire());
    }

    await Promise.all(promises);
    const endTime = Date.now();

    // All 10 should complete immediately (within 100ms tolerance)
    expect(endTime - startTime).toBeLessThan(100);
  });

  it('should block when tokens exhausted and refill over time', async () => {
    const limiter = new RateLimiter(5, 2); // 5 tokens, 2 per second refill

    // Consume all 5 tokens
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
    }

    // Next request should block until refill
    const acquirePromise = limiter.acquire();
    vi.advanceTimersByTime(500); // Advance 0.5 seconds = 1 token refilled
    await acquirePromise;

    // Should have consumed the refilled token
    expect(limiter.getAvailableTokens()).toBeLessThan(1);
  });

  it('should handle concurrent requests correctly', async () => {
    const limiter = new RateLimiter(3, 1); // 3 tokens, 1 per second

    // Fire 5 concurrent requests
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(limiter.acquire());
    }

    // First 3 should complete immediately
    vi.advanceTimersByTime(0);

    // Advance time to refill 2 more tokens
    vi.advanceTimersByTime(2000);

    await Promise.all(promises);

    // All should have completed
    expect(promises).toHaveLength(5);
  });

  it('should respect custom token cost', async () => {
    const limiter = new RateLimiter(10, 1);

    // Acquire 5 tokens at once
    await limiter.acquire(5);
    expect(limiter.getAvailableTokens()).toBe(5);

    // Acquire 3 more
    await limiter.acquire(3);
    expect(limiter.getAvailableTokens()).toBe(2);
  });

  it('should refill tokens up to max capacity', async () => {
    const limiter = new RateLimiter(10, 5); // 10 max, 5 per second

    // Consume 8 tokens
    await limiter.acquire(8);
    expect(limiter.getAvailableTokens()).toBe(2);

    // Wait 3 seconds = 15 tokens would refill, but capped at 10 max
    vi.advanceTimersByTime(3000);

    // Should be back to max (10), not 2 + 15 = 17
    expect(limiter.getAvailableTokens()).toBe(10);
  });

  it('should handle fractional refill rates correctly', async () => {
    const limiter = new RateLimiter(100, 0.5); // 0.5 tokens per second = 1 token per 2 seconds

    // Consume all tokens
    await limiter.acquire(100);
    expect(limiter.getAvailableTokens()).toBe(0);

    // Wait 2 seconds = 1 token refilled
    vi.advanceTimersByTime(2000);
    expect(limiter.getAvailableTokens()).toBeCloseTo(1, 1);

    // Wait 4 more seconds = 2 more tokens refilled
    vi.advanceTimersByTime(4000);
    expect(limiter.getAvailableTokens()).toBeCloseTo(3, 1);
  });

  it('should block until enough tokens are available for high-cost request', async () => {
    const limiter = new RateLimiter(10, 2); // 10 max, 2 per second

    // Consume 9 tokens
    await limiter.acquire(9);
    expect(limiter.getAvailableTokens()).toBe(1);

    // Request 5 tokens (need to wait for 4 more to refill)
    const acquirePromise = limiter.acquire(5);

    // Should block until 2 seconds pass (4 tokens refilled)
    vi.advanceTimersByTime(2000);
    await acquirePromise;

    // Should have consumed 5 tokens from (1 existing + 4 refilled = 5)
    expect(limiter.getAvailableTokens()).toBeCloseTo(0, 1);
  });

  it('should handle zero initial tokens', async () => {
    const limiter = new RateLimiter(10, 5);

    // Consume all tokens
    await limiter.acquire(10);
    expect(limiter.getAvailableTokens()).toBe(0);

    // Should refill from zero
    vi.advanceTimersByTime(1000);
    expect(limiter.getAvailableTokens()).toBeCloseTo(5, 1);
  });
});

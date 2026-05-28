import { describe, it, expect, beforeEach } from 'vitest';
import { UploadRateLimiter } from '../upload-rate-limiter.js';

describe('UploadRateLimiter', () => {
  let limiter: UploadRateLimiter;

  beforeEach(() => {
    limiter = new UploadRateLimiter({
      maxUploadsPerWindow: 5,
      windowSeconds: 60,
    });
  });

  describe('allows requests under the limit', () => {
    it('returns allowed: true for requests within the limit', async () => {
      const result = await limiter.consume('tenant-a');

      expect(result.allowed).toBe(true);
      expect(result.remainingPoints).toBe(4);
      expect(result.limit).toBe(5);
      expect(result.retryAfterMs).toBeUndefined();
    });

    it('allows multiple requests up to the configured limit', async () => {
      for (let i = 0; i < 5; i++) {
        const result = await limiter.consume('tenant-b');
        expect(result.allowed).toBe(true);
        expect(result.remainingPoints).toBe(4 - i);
      }
    });
  });

  describe('returns 429 info when rate exceeded', () => {
    it('returns allowed: false with retryAfterMs when limit is exhausted', async () => {
      // Exhaust the limit
      for (let i = 0; i < 5; i++) {
        await limiter.consume('tenant-c');
      }

      const result = await limiter.consume('tenant-c');

      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBeTypeOf('number');
      expect(result.retryAfterMs).toBeGreaterThan(0);
      expect(result.remainingPoints).toBe(0);
      expect(result.limit).toBe(5);
    });
  });

  describe('per-tenant isolation', () => {
    it('limits are independent per tenant', async () => {
      // Exhaust tenant-d's limit
      for (let i = 0; i < 5; i++) {
        await limiter.consume('tenant-d');
      }

      // tenant-d should be rate limited
      const resultD = await limiter.consume('tenant-d');
      expect(resultD.allowed).toBe(false);

      // tenant-e should still have full capacity
      const resultE = await limiter.consume('tenant-e');
      expect(resultE.allowed).toBe(true);
      expect(resultE.remainingPoints).toBe(4);
    });
  });

  describe('respects configurable limits', () => {
    it('uses a custom maxUploadsPerWindow', async () => {
      const strictLimiter = new UploadRateLimiter({
        maxUploadsPerWindow: 2,
        windowSeconds: 60,
      });

      const first = await strictLimiter.consume('tenant-f');
      expect(first.allowed).toBe(true);
      expect(first.remainingPoints).toBe(1);

      const second = await strictLimiter.consume('tenant-f');
      expect(second.allowed).toBe(true);
      expect(second.remainingPoints).toBe(0);

      const third = await strictLimiter.consume('tenant-f');
      expect(third.allowed).toBe(false);
      expect(third.retryAfterMs).toBeGreaterThan(0);
    });

    it('uses a custom windowSeconds', async () => {
      const shortWindowLimiter = new UploadRateLimiter({
        maxUploadsPerWindow: 1,
        windowSeconds: 1,
      });

      const first = await shortWindowLimiter.consume('tenant-g');
      expect(first.allowed).toBe(true);

      const second = await shortWindowLimiter.consume('tenant-g');
      expect(second.allowed).toBe(false);
      // retryAfterMs should be at most 1000ms (1 second window)
      expect(second.retryAfterMs).toBeLessThanOrEqual(1000);
    });
  });
});

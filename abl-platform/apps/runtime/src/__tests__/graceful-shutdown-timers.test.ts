/**
 * Graceful Shutdown — Recovery Timer Tests
 *
 * Verifies that HybridRateLimiter and HybridCBRegistry correctly clear
 * their 30-second recovery timers on shutdown. Without this, the timers
 * keep the process alive and burn CPU after graceful shutdown.
 *
 * Unit-level tests — no Redis or MongoDB required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared before importing modules under test
// ---------------------------------------------------------------------------

// Track whether Redis is "available" — toggled per test
let mockRedisAvailable = false;
let mockRedisClient: object | null = null;

vi.mock('../services/redis/redis-client.js', () => ({
  getRedisClient: () => mockRedisClient,
  getRedisHandle: () => ({
    client: mockRedisClient,
    isReady: () => true,
    duplicate: () => (mockRedisClient.duplicate ? mockRedisClient.duplicate() : mockRedisClient),
    disconnect: async () => {},
  }),
  isRedisAvailable: () => mockRedisAvailable,
}));

// Mock RedisRateLimiter — must be a class (used with `new`)
vi.mock('../services/resilience/redis-rate-limiter.js', () => {
  class MockRedisRateLimiter {
    check = vi.fn();
    peek = vi.fn();
  }
  return { RedisRateLimiter: MockRedisRateLimiter };
});

// Mock RedisCircuitBreakerStoreAdapter — must be a class (used with `new`)
vi.mock('../services/resilience/redis-cb-store-adapter.js', () => {
  class MockRedisCircuitBreakerStoreAdapter {
    getState = vi.fn().mockResolvedValue(null);
    setState = vi.fn().mockResolvedValue(undefined);
  }
  return { RedisCircuitBreakerStoreAdapter: MockRedisCircuitBreakerStoreAdapter };
});

// Mock tenant CB config — not relevant to shutdown tests
vi.mock('../services/resilience/tenant-cb-config.js', () => ({
  getTenantCBConfig: vi.fn().mockReturnValue(null),
}));

// Mock OTEL metrics — not relevant to shutdown tests
vi.mock('../observability/metrics.js', () => ({
  setCircuitBreakerState: vi.fn(),
  recordRateLimiterFallback: vi.fn(),
}));

// Import after mocks
import {
  HybridRateLimiter,
  getHybridRateLimiter,
  resetHybridRateLimiter,
} from '../services/resilience/hybrid-rate-limiter.js';
import {
  HybridCircuitBreakerRegistry,
  getCircuitBreakerRegistry,
  resetCircuitBreakerRegistry,
} from '../services/resilience/hybrid-cb-registry.js';

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Graceful shutdown clears recovery timers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Default: Redis unavailable — triggers recovery timer
    mockRedisAvailable = false;
    mockRedisClient = null;
    // Reset singletons from prior tests
    resetHybridRateLimiter();
    resetCircuitBreakerRegistry();
  });

  afterEach(() => {
    resetHybridRateLimiter();
    resetCircuitBreakerRegistry();
    vi.useRealTimers();
  });

  // --- HybridRateLimiter -------------------------------------------------

  describe('HybridRateLimiter', () => {
    it('shutdown() clears recovery timer so no more recovery attempts fire', () => {
      // Redis unavailable -> constructor starts recovery timer
      const limiter = new HybridRateLimiter();
      expect(limiter.isUsingRedis()).toBe(false);

      // Simulate Redis coming back
      mockRedisAvailable = true;
      mockRedisClient = { ping: vi.fn() };

      // Shutdown BEFORE the timer fires
      limiter.shutdown();

      // Advance past several recovery intervals — no recovery should happen
      vi.advanceTimersByTime(120_000);

      // Still not using Redis because the timer was cleared before it could fire
      expect(limiter.isUsingRedis()).toBe(false);
    });

    it('shutdown() is safe to call multiple times', () => {
      const limiter = new HybridRateLimiter();

      // Call shutdown twice — no errors
      expect(() => {
        limiter.shutdown();
        limiter.shutdown();
      }).not.toThrow();
    });

    it('shutdown() is safe when no recovery timer was started (Redis available)', () => {
      // Redis available -> no recovery timer started
      mockRedisAvailable = true;
      mockRedisClient = { ping: vi.fn() };

      const limiter = new HybridRateLimiter();
      expect(limiter.isUsingRedis()).toBe(true);

      // Shutdown without a recovery timer running
      expect(() => limiter.shutdown()).not.toThrow();
    });

    it('recovery timer fires correctly before shutdown is called', () => {
      const limiter = new HybridRateLimiter();
      expect(limiter.isUsingRedis()).toBe(false);

      // Simulate Redis coming back
      mockRedisAvailable = true;
      mockRedisClient = { ping: vi.fn() };

      // Advance past the 30s interval — recovery should trigger
      vi.advanceTimersByTime(30_000);

      expect(limiter.isUsingRedis()).toBe(true);

      // Now shutdown is clean — timer was already stopped by recovery
      expect(() => limiter.shutdown()).not.toThrow();
    });
  });

  // --- HybridCircuitBreakerRegistry --------------------------------------

  describe('HybridCircuitBreakerRegistry', () => {
    it('shutdown() clears recovery timer so no more recovery attempts fire', () => {
      // Redis unavailable -> constructor starts recovery timer
      const registry = new HybridCircuitBreakerRegistry();
      expect(registry.isUsingRedis()).toBe(false);

      // Simulate Redis coming back
      mockRedisAvailable = true;
      mockRedisClient = { ping: vi.fn() };

      // Shutdown BEFORE the timer fires
      registry.shutdown();

      // Advance past several recovery intervals — no recovery should happen
      vi.advanceTimersByTime(120_000);

      // Still not using Redis because the timer was cleared before it could fire
      expect(registry.isUsingRedis()).toBe(false);
    });

    it('shutdown() is safe to call multiple times', () => {
      const registry = new HybridCircuitBreakerRegistry();

      expect(() => {
        registry.shutdown();
        registry.shutdown();
      }).not.toThrow();
    });

    it('shutdown() is safe when no recovery timer was started (Redis available)', () => {
      mockRedisAvailable = true;
      mockRedisClient = { ping: vi.fn() };

      const registry = new HybridCircuitBreakerRegistry();
      expect(registry.isUsingRedis()).toBe(true);

      expect(() => registry.shutdown()).not.toThrow();
    });

    it('recovery timer fires correctly before shutdown is called', () => {
      const registry = new HybridCircuitBreakerRegistry();
      expect(registry.isUsingRedis()).toBe(false);

      // Simulate Redis coming back
      mockRedisAvailable = true;
      mockRedisClient = { ping: vi.fn() };

      // Advance past the 30s interval
      vi.advanceTimersByTime(30_000);

      expect(registry.isUsingRedis()).toBe(true);

      expect(() => registry.shutdown()).not.toThrow();
    });
  });

  // --- Singleton reset functions ------------------------------------------

  describe('Singleton reset functions', () => {
    it('resetHybridRateLimiter() destroys old instance and creates fresh on next get', () => {
      // Force singleton creation
      const limiter1 = getHybridRateLimiter();
      expect(limiter1).toBeInstanceOf(HybridRateLimiter);

      // Reset destroys the singleton
      resetHybridRateLimiter();

      // Next call creates a NEW instance (not the same object)
      const limiter2 = getHybridRateLimiter();
      expect(limiter2).toBeInstanceOf(HybridRateLimiter);
      expect(limiter2).not.toBe(limiter1);
    });

    it('resetHybridRateLimiter() is safe to call when no singleton exists', () => {
      // No singleton created yet — reset should not throw
      expect(() => resetHybridRateLimiter()).not.toThrow();
    });

    it('resetCircuitBreakerRegistry() destroys old instance and creates fresh on next get', () => {
      const registry1 = getCircuitBreakerRegistry();
      expect(registry1).toBeInstanceOf(HybridCircuitBreakerRegistry);

      resetCircuitBreakerRegistry();

      const registry2 = getCircuitBreakerRegistry();
      expect(registry2).toBeInstanceOf(HybridCircuitBreakerRegistry);
      expect(registry2).not.toBe(registry1);
    });

    it('resetCircuitBreakerRegistry() is safe to call when no singleton exists', () => {
      expect(() => resetCircuitBreakerRegistry()).not.toThrow();
    });
  });
});

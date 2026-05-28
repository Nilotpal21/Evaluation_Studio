/**
 * RedisCircuitBreaker Tests
 *
 * Tests the core circuit breaker state machine using a mock Redis.
 * Covers: state transitions, atomic operations, concurrent access,
 * force reset, metrics, and event emission.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// `runLuaScript` is the only @agent-platform/redis API the breaker calls; route
// it back into the per-test mock's emulators via a module-level ref. `hashTag`
// and `scanKeys` keep their real implementations.
let mockRedisRef: { evalScript: (n: string, k: string[], a: string[]) => Promise<unknown> } | null =
  null;
vi.mock('@agent-platform/redis', async () => {
  const actual =
    await vi.importActual<typeof import('@agent-platform/redis')>('@agent-platform/redis');
  return {
    ...actual,
    runLuaScript: async (
      _client: unknown,
      script: { name: string; numberOfKeys: number },
      keys: string[],
      args: ReadonlyArray<string | number>,
    ) => {
      if (!mockRedisRef) throw new Error('mockRedisRef not set');
      return mockRedisRef.evalScript(script.name, keys, args.map(String));
    },
  };
});

import { RedisCircuitBreaker } from '../redis-circuit-breaker.js';
import { CircuitOpenError, type BreakerState, type CircuitBreakerConfig } from '../types.js';
import { createMockRedis, type MockRedis } from './helpers/mock-redis.js';

// Fast config for testing (short windows and timeouts)
const TEST_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  successThreshold: 2,
  resetTimeout: 1000, // 1s
  monitorWindow: 5000, // 5s
  halfOpenMaxConcurrent: 1,
  failureRateThreshold: 50,
  minimumRequestCount: 4,
};

describe('RedisCircuitBreaker', () => {
  let redis: MockRedis;
  let breaker: RedisCircuitBreaker;
  let timeOffset = 0;
  let realDateNow: () => number;

  beforeEach(() => {
    timeOffset = 0;
    realDateNow = Date.now;
    // Make Date.now() advance-able for tests
    vi.spyOn(Date, 'now').mockImplementation(() => realDateNow.call(Date) + timeOffset);
    redis = createMockRedis();
    mockRedisRef = redis;
    breaker = new RedisCircuitBreaker(redis as any, 'tenant', TEST_CONFIG);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function advanceTime(ms: number) {
    timeOffset += ms;
    redis.advanceTime(ms);
  }

  // ── CLOSED State ─────────────────────────────────────────

  describe('CLOSED state', () => {
    it('should execute successfully when circuit is closed', async () => {
      const result = await breaker.execute('test-key', async () => 'hello');
      expect(result).toBe('hello');
    });

    it('should propagate function errors without opening circuit (below threshold)', async () => {
      // 1 failure is below threshold of 3
      await expect(
        breaker.execute('test-key', async () => {
          throw new Error('service down');
        }),
      ).rejects.toThrow('service down');

      // Circuit should still be closed
      const state = await breaker.getState('test-key');
      expect(state).toBe('CLOSED');
    });

    it('should open circuit after reaching failure threshold', async () => {
      const failingFn = async () => {
        throw new Error('fail');
      };

      // Cause 3 failures (= threshold)
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute('test-key', failingFn)).rejects.toThrow('fail');
      }

      // Circuit should now be OPEN
      const state = await breaker.getState('test-key');
      expect(state).toBe('OPEN');
    });

    it('should open circuit based on failure rate threshold', async () => {
      // With minimumRequestCount=4 and failureRateThreshold=50%:
      // 2 successes + 2 failures = 50% failure rate -> should open

      await breaker.execute('test-key', async () => 'ok');
      await breaker.execute('test-key', async () => 'ok');

      await expect(
        breaker.execute('test-key', async () => {
          throw new Error('fail');
        }),
      ).rejects.toThrow();

      await expect(
        breaker.execute('test-key', async () => {
          throw new Error('fail');
        }),
      ).rejects.toThrow();

      const state = await breaker.getState('test-key');
      expect(state).toBe('OPEN');
    });

    it('should not count failures outside the monitoring window', async () => {
      const failingFn = async () => {
        throw new Error('fail');
      };

      // 2 failures
      await expect(breaker.execute('test-key', failingFn)).rejects.toThrow();
      await expect(breaker.execute('test-key', failingFn)).rejects.toThrow();

      // Simulate time passing beyond the window
      advanceTime(TEST_CONFIG.monitorWindow + 1);

      // 1 more failure (should not trigger since previous 2 are outside window)
      await expect(breaker.execute('test-key', failingFn)).rejects.toThrow();

      const state = await breaker.getState('test-key');
      expect(state).toBe('CLOSED');
    });
  });

  // ── OPEN State ───────────────────────────────────────────

  describe('OPEN state', () => {
    beforeEach(async () => {
      // Open the circuit
      const failingFn = async () => {
        throw new Error('fail');
      };
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute('test-key', failingFn)).rejects.toThrow('fail');
      }
    });

    it('should reject requests immediately when open', async () => {
      await expect(breaker.execute('test-key', async () => 'should not run')).rejects.toThrow(
        CircuitOpenError,
      );
    });

    it('should include retryAfterMs in CircuitOpenError', async () => {
      try {
        await breaker.execute('test-key', async () => 'nope');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CircuitOpenError);
        const coe = error as CircuitOpenError;
        expect(coe.level).toBe('tenant');
        expect(coe.key).toBe('test-key');
        expect(coe.retryAfterMs).toBeGreaterThan(0);
        expect(coe.retryAfterMs).toBeLessThanOrEqual(TEST_CONFIG.resetTimeout);
      }
    });

    it('should not execute the function when circuit is open', async () => {
      const fn = vi.fn(async () => 'result');

      await expect(breaker.execute('test-key', fn)).rejects.toThrow(CircuitOpenError);
      expect(fn).not.toHaveBeenCalled();
    });

    it('should transition to HALF_OPEN after reset timeout', async () => {
      // Advance past the reset timeout
      advanceTime(TEST_CONFIG.resetTimeout + 1);

      // checkState should now return HALF_OPEN and allow execution
      const result = await breaker.checkState('test-key');
      expect(result.state).toBe('HALF_OPEN');
      expect(result.canExecute).toBe(true);
    });
  });

  // ── HALF_OPEN State ──────────────────────────────────────

  describe('HALF_OPEN state', () => {
    beforeEach(async () => {
      // Open the circuit
      const failingFn = async () => {
        throw new Error('fail');
      };
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute('test-key', failingFn)).rejects.toThrow('fail');
      }
      // Advance to HALF_OPEN
      advanceTime(TEST_CONFIG.resetTimeout + 1);
    });

    it('should allow limited requests through', async () => {
      // First request should succeed (halfOpenMaxConcurrent = 1)
      const result = await breaker.execute('test-key', async () => 'probe');
      expect(result).toBe('probe');
    });

    it('should close circuit after enough successes', async () => {
      // Need 2 successes (successThreshold)
      await breaker.execute('test-key', async () => 'ok');
      await breaker.execute('test-key', async () => 'ok');

      const state = await breaker.getState('test-key');
      expect(state).toBe('CLOSED');
    });

    it('should reopen circuit on failure in HALF_OPEN', async () => {
      await breaker.forceReset('test-key', 'HALF_OPEN');

      await expect(
        breaker.execute('test-key', async () => {
          throw new Error('still broken');
        }),
      ).rejects.toThrow('still broken');

      const state = await breaker.getState('test-key');
      expect(state).toBe('OPEN');
    });
  });

  describe('HALF_OPEN probe failures', () => {
    it('should immediately reopen and clear probe state after a failed fresh HALF_OPEN probe', async () => {
      await breaker.forceReset('test-key', 'HALF_OPEN');

      await expect(
        breaker.execute('test-key', async () => {
          throw new Error('probe failed');
        }),
      ).rejects.toThrow('probe failed');

      const state = await breaker.getState('test-key');
      expect(state).toBe('OPEN');

      const metrics = await breaker.getMetrics('test-key');
      expect(metrics.failureCount).toBe(1);
      expect(metrics.successCount).toBe(0);
      expect(metrics.totalCount).toBe(1);
      expect(metrics.halfOpenCount).toBe(0);
    });

    it('should clear stale monitoring window data when forcing HALF_OPEN', async () => {
      await breaker.execute('test-key', async () => 'ok');
      await expect(
        breaker.execute('test-key', async () => {
          throw new Error('fail');
        }),
      ).rejects.toThrow('fail');

      const beforeReset = await breaker.getMetrics('test-key');
      expect(beforeReset.failureCount).toBe(1);
      expect(beforeReset.successCount).toBe(1);

      await breaker.forceReset('test-key', 'HALF_OPEN');

      const metrics = await breaker.getMetrics('test-key');
      expect(metrics.state).toBe('HALF_OPEN');
      expect(metrics.failureCount).toBe(0);
      expect(metrics.successCount).toBe(0);
      expect(metrics.totalCount).toBe(0);
      expect(metrics.halfOpenCount).toBe(0);
    });
  });

  // ── Force Reset ──────────────────────────────────────────

  describe('forceReset', () => {
    it('should force circuit to CLOSED', async () => {
      // Open it
      const failingFn = async () => {
        throw new Error('fail');
      };
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute('test-key', failingFn)).rejects.toThrow();
      }

      expect(await breaker.getState('test-key')).toBe('OPEN');

      // Force close
      const result = await breaker.forceReset('test-key', 'CLOSED');
      expect(result.state).toBe('CLOSED');
      expect(result.action).toBe('forced');

      // Should work again
      const value = await breaker.execute('test-key', async () => 'recovered');
      expect(value).toBe('recovered');
    });

    it('should force circuit to OPEN', async () => {
      // Force open a healthy circuit
      const result = await breaker.forceReset('test-key', 'OPEN');
      expect(result.state).toBe('OPEN');

      // Should reject
      await expect(breaker.execute('test-key', async () => 'nope')).rejects.toThrow(
        CircuitOpenError,
      );
    });

    it('should force circuit to HALF_OPEN', async () => {
      const result = await breaker.forceReset('test-key', 'HALF_OPEN');
      expect(result.state).toBe('HALF_OPEN');
    });
  });

  // ── Metrics ──────────────────────────────────────────────

  describe('getMetrics', () => {
    it('should return zero metrics for new key', async () => {
      const metrics = await breaker.getMetrics('new-key');
      expect(metrics.state).toBe('CLOSED');
      expect(metrics.failureCount).toBe(0);
      expect(metrics.successCount).toBe(0);
      expect(metrics.totalCount).toBe(0);
      expect(metrics.failureRate).toBe(0);
      expect(metrics.openedAt).toBeNull();
      expect(metrics.halfOpenCount).toBe(0);
    });

    it('should reflect failures and successes', async () => {
      await breaker.execute('test-key', async () => 'ok');
      await expect(
        breaker.execute('test-key', async () => {
          throw new Error('fail');
        }),
      ).rejects.toThrow();

      const metrics = await breaker.getMetrics('test-key');
      expect(metrics.failureCount).toBe(1);
      expect(metrics.successCount).toBe(1);
      expect(metrics.totalCount).toBe(2);
      expect(metrics.failureRate).toBe(50);
    });
  });

  // ── Events ───────────────────────────────────────────────

  describe('event emission', () => {
    it('should emit events on state changes', async () => {
      const events: any[] = [];
      breaker.onEvent((event) => events.push(event));

      const failingFn = async () => {
        throw new Error('fail');
      };

      // Cause 3 failures to open
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute('test-key', failingFn)).rejects.toThrow();
      }

      // Should have execution events + state change event
      const stateChanges = events.filter((e) => e.from && e.to);
      expect(stateChanges.length).toBeGreaterThanOrEqual(1);

      const openEvent = stateChanges.find((e) => e.to === 'OPEN');
      expect(openEvent).toBeDefined();
      expect(openEvent.level).toBe('tenant');
      expect(openEvent.key).toBe('test-key');
    });

    it('should emit rejected events when circuit is open', async () => {
      const events: any[] = [];
      breaker.onEvent((event) => events.push(event));

      // Open it
      const failingFn = async () => {
        throw new Error('fail');
      };
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute('test-key', failingFn)).rejects.toThrow('fail');
      }

      events.length = 0; // Clear previous events

      // Try to execute (should reject)
      await expect(breaker.execute('test-key', async () => 'nope')).rejects.toThrow(
        CircuitOpenError,
      );

      const rejected = events.find((e) => e.action === 'rejected');
      expect(rejected).toBeDefined();
      expect(rejected.state).toBe('OPEN');
    });

    it('should allow unsubscribing from events', async () => {
      const events: any[] = [];
      const unsub = breaker.onEvent((event) => events.push(event));

      await breaker.execute('test-key', async () => 'ok');
      expect(events.length).toBeGreaterThan(0);

      const count = events.length;
      unsub();

      await breaker.execute('test-key', async () => 'ok');
      expect(events.length).toBe(count); // No new events
    });
  });

  // ── Key Isolation ────────────────────────────────────────

  describe('key isolation', () => {
    it('should maintain separate state per key', async () => {
      const failingFn = async () => {
        throw new Error('fail');
      };

      // Open circuit for key-a
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute('key-a', failingFn)).rejects.toThrow('fail');
      }

      // key-a should be OPEN
      expect(await breaker.getState('key-a')).toBe('OPEN');

      // key-b should still be CLOSED
      expect(await breaker.getState('key-b')).toBe('CLOSED');

      // key-b should work fine
      const result = await breaker.execute('key-b', async () => 'independent');
      expect(result).toBe('independent');
    });
  });
});

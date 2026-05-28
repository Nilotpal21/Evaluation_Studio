/**
 * Circuit Breaker State Machine Tests
 *
 * Comprehensive unit tests for the core CircuitBreaker class and
 * CircuitBreakerRegistry from services/resilience/circuit-breaker.ts.
 *
 * Tests the three-state machine (closed -> open -> half-open -> closed),
 * event emission, state persistence, and registry behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CircuitBreaker,
  CircuitBreakerRegistry,
  InMemoryCircuitBreakerStore,
} from '../../services/resilience/circuit-breaker.js';
import type {
  CircuitBreakerStore,
  CircuitBreakerEvent,
} from '../../services/resilience/circuit-breaker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a breaker with low thresholds for fast testing */
function createBreaker(
  overrides: Partial<{
    failureThreshold: number;
    successThreshold: number;
    resetTimeoutMs: number;
    windowMs: number;
    name: string;
  }> = {},
  store?: CircuitBreakerStore,
): CircuitBreaker {
  return new CircuitBreaker(
    {
      name: overrides.name ?? 'test-breaker',
      failureThreshold: overrides.failureThreshold ?? 3,
      successThreshold: overrides.successThreshold ?? 2,
      resetTimeoutMs: overrides.resetTimeoutMs ?? 5000,
      windowMs: overrides.windowMs ?? 60_000,
    },
    store,
  );
}

/** Record N failures on a breaker */
async function failN(breaker: CircuitBreaker, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await breaker.recordFailure();
  }
}

/** Record N successes on a breaker */
async function succeedN(breaker: CircuitBreaker, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await breaker.recordSuccess();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CircuitBreaker state machine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // State transitions
  // -----------------------------------------------------------------------
  describe('state transitions', () => {
    it('starts in closed state and isOpen() returns false', () => {
      const breaker = createBreaker();

      expect(breaker.getState()).toBe('closed');
      expect(breaker.isOpen()).toBe(false);
    });

    it('transitions to open after failureThreshold failures', async () => {
      const breaker = createBreaker({ failureThreshold: 3 });

      // Two failures -- still closed
      await failN(breaker, 2);
      expect(breaker.getState()).toBe('closed');
      expect(breaker.isOpen()).toBe(false);

      // Third failure triggers open
      await breaker.recordFailure();
      expect(breaker.getState()).toBe('open');
      expect(breaker.isOpen()).toBe(true);
    });

    it('transitions from open to half-open after resetTimeoutMs elapses', async () => {
      const breaker = createBreaker({ failureThreshold: 3, resetTimeoutMs: 5000 });

      await failN(breaker, 3);
      expect(breaker.getState()).toBe('open');
      expect(breaker.isOpen()).toBe(true);

      // Advance time just past the reset timeout
      vi.advanceTimersByTime(5001);

      // isOpen() should detect the elapsed timeout and transition to half-open
      expect(breaker.isOpen()).toBe(false);
      expect(breaker.getState()).toBe('half-open');
    });

    it('transitions from half-open back to open on a single failure', async () => {
      const breaker = createBreaker({ failureThreshold: 3, resetTimeoutMs: 5000 });

      // Drive to half-open
      await failN(breaker, 3);
      vi.advanceTimersByTime(5001);
      breaker.isOpen(); // trigger transition
      expect(breaker.getState()).toBe('half-open');

      // One failure in half-open sends it back to open
      await breaker.recordFailure();
      expect(breaker.getState()).toBe('open');
      expect(breaker.isOpen()).toBe(true);
    });

    it('stays in half-open when successes are fewer than successThreshold', async () => {
      const breaker = createBreaker({
        failureThreshold: 3,
        successThreshold: 3,
        resetTimeoutMs: 5000,
      });

      // Drive to half-open
      await failN(breaker, 3);
      vi.advanceTimersByTime(5001);
      breaker.isOpen();
      expect(breaker.getState()).toBe('half-open');

      // Record 2 successes (threshold is 3) -- should stay half-open
      await succeedN(breaker, 2);
      expect(breaker.getState()).toBe('half-open');
    });

    it('transitions from half-open to closed after successThreshold consecutive successes', async () => {
      const breaker = createBreaker({
        failureThreshold: 3,
        successThreshold: 2,
        resetTimeoutMs: 5000,
      });

      // Drive to half-open
      await failN(breaker, 3);
      vi.advanceTimersByTime(5001);
      breaker.isOpen();
      expect(breaker.getState()).toBe('half-open');

      // Meet the success threshold
      await succeedN(breaker, 2);
      expect(breaker.getState()).toBe('closed');

      // Verify failures reset to 0 on close
      const snapshot = breaker.getSnapshot();
      expect(snapshot.failures).toBe(0);
      expect(snapshot.consecutiveSuccesses).toBe(0);
    });

    it('getState() triggers open to half-open transition as a side effect', async () => {
      const breaker = createBreaker({ failureThreshold: 3, resetTimeoutMs: 5000 });

      await failN(breaker, 3);
      expect(breaker.getState()).toBe('open');

      vi.advanceTimersByTime(5001);

      // getState() should transition to half-open (same side effect as isOpen)
      expect(breaker.getState()).toBe('half-open');
    });

    it('recordSuccess() in closed state decrements failure count but not below 0', async () => {
      const breaker = createBreaker({ failureThreshold: 5 });

      // Start with 0 failures, record a success
      await breaker.recordSuccess();
      expect(breaker.getSnapshot().failures).toBe(0); // Cannot go below 0

      // Now add 2 failures, then a success should decrement to 1
      await failN(breaker, 2);
      expect(breaker.getSnapshot().failures).toBe(2);

      await breaker.recordSuccess();
      expect(breaker.getSnapshot().failures).toBe(1);

      await breaker.recordSuccess();
      expect(breaker.getSnapshot().failures).toBe(0);

      // Another success should not go below 0
      await breaker.recordSuccess();
      expect(breaker.getSnapshot().failures).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Event emission
  // -----------------------------------------------------------------------
  describe('event emission', () => {
    it('emits circuit_opened when transitioning from closed to open', async () => {
      const breaker = createBreaker({ failureThreshold: 3 });
      const events: CircuitBreakerEvent[] = [];
      breaker.onStateChange((event) => events.push(event));

      await failN(breaker, 3);

      const openEvent = events.find((e) => e.type === 'circuit_opened');
      expect(openEvent).toBeDefined();
      expect(openEvent!.breakerName).toBe('test-breaker');
      expect(openEvent!.metadata).toEqual(expect.objectContaining({ previousState: 'closed' }));
    });

    it('emits circuit_half_open when transitioning from open to half-open', async () => {
      const breaker = createBreaker({ failureThreshold: 3, resetTimeoutMs: 5000 });
      const events: CircuitBreakerEvent[] = [];
      breaker.onStateChange((event) => events.push(event));

      await failN(breaker, 3);
      vi.advanceTimersByTime(5001);
      breaker.isOpen(); // trigger transition

      const halfOpenEvent = events.find((e) => e.type === 'circuit_half_open');
      expect(halfOpenEvent).toBeDefined();
      expect(halfOpenEvent!.breakerName).toBe('test-breaker');
      expect(halfOpenEvent!.metadata).toEqual(expect.objectContaining({ previousState: 'open' }));
    });

    it('emits circuit_closed when transitioning from half-open to closed after recovery', async () => {
      const breaker = createBreaker({
        failureThreshold: 3,
        successThreshold: 2,
        resetTimeoutMs: 5000,
      });
      const events: CircuitBreakerEvent[] = [];
      breaker.onStateChange((event) => events.push(event));

      // Drive to half-open
      await failN(breaker, 3);
      vi.advanceTimersByTime(5001);
      breaker.isOpen();

      // Recover
      await succeedN(breaker, 2);

      const closedEvent = events.find((e) => e.type === 'circuit_closed');
      expect(closedEvent).toBeDefined();
      expect(closedEvent!.breakerName).toBe('test-breaker');
      expect(closedEvent!.metadata).toEqual(
        expect.objectContaining({ previousState: 'half-open', failures: 0 }),
      );
    });

    it('emits probe_failure when a failure occurs in half-open state', async () => {
      const breaker = createBreaker({ failureThreshold: 3, resetTimeoutMs: 5000 });
      const events: CircuitBreakerEvent[] = [];
      breaker.onStateChange((event) => events.push(event));

      // Drive to half-open
      await failN(breaker, 3);
      vi.advanceTimersByTime(5001);
      breaker.isOpen();

      // Fail in half-open
      const testError = new Error('probe failed');
      await breaker.recordFailure(testError);

      const probeEvent = events.find((e) => e.type === 'probe_failure');
      expect(probeEvent).toBeDefined();
      expect(probeEvent!.breakerName).toBe('test-breaker');
      expect(probeEvent!.metadata).toEqual(expect.objectContaining({ error: 'probe failed' }));
    });
  });

  // -----------------------------------------------------------------------
  // State persistence
  // -----------------------------------------------------------------------
  describe('state persistence', () => {
    it('loadState() hydrates breaker from store', async () => {
      const store = new InMemoryCircuitBreakerStore();

      // Pre-populate the store with an open state
      await store.setState('persisted-breaker', {
        state: 'open',
        failures: 5,
        successes: 0,
        lastFailureTime: Date.now() - 1000,
        lastStateChange: Date.now() - 1000,
        consecutiveSuccesses: 0,
      });

      const breaker = createBreaker({ name: 'persisted-breaker' }, store);

      // Before loadState, breaker is in initial closed state
      expect(breaker.getState()).toBe('closed');

      await breaker.loadState();

      // After loadState, breaker reflects stored state
      expect(breaker.getSnapshot().state).toBe('open');
      expect(breaker.getSnapshot().failures).toBe(5);
      expect(breaker.isOpen()).toBe(true);
    });

    it('loadState() with store rejection keeps breaker in initial closed state', async () => {
      const store: CircuitBreakerStore = {
        getState: vi.fn().mockRejectedValue(new Error('store unavailable')),
        setState: vi.fn().mockResolvedValue(undefined),
      };

      const breaker = createBreaker({ name: 'failing-store' }, store);

      // loadState should reject since the store rejects
      await expect(breaker.loadState()).rejects.toThrow('store unavailable');

      // Breaker should remain in initial state
      expect(breaker.getState()).toBe('closed');
      expect(breaker.isOpen()).toBe(false);
    });

    it('persists state to store after recordSuccess() and recordFailure()', async () => {
      const store: CircuitBreakerStore = {
        getState: vi.fn().mockResolvedValue(null),
        setState: vi.fn().mockResolvedValue(undefined),
      };

      const breaker = createBreaker({ name: 'persist-test', failureThreshold: 5 }, store);

      await breaker.recordFailure();
      expect(store.setState).toHaveBeenCalledTimes(1);
      expect(store.setState).toHaveBeenCalledWith(
        'persist-test',
        expect.objectContaining({ failures: 1, state: 'closed' }),
      );

      await breaker.recordSuccess();
      expect(store.setState).toHaveBeenCalledTimes(2);
      // Failure count decremented from 1 to 0 by recordSuccess in closed state
      expect(store.setState).toHaveBeenCalledWith(
        'persist-test',
        expect.objectContaining({ failures: 0, state: 'closed' }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Reset
  // -----------------------------------------------------------------------
  describe('reset', () => {
    it('reset() returns breaker to closed state with failures=0', async () => {
      const breaker = createBreaker({ failureThreshold: 3, resetTimeoutMs: 5000 });

      // Drive to open state
      await failN(breaker, 3);
      expect(breaker.getState()).toBe('open');
      expect(breaker.getSnapshot().failures).toBeGreaterThanOrEqual(3);

      // Reset
      await breaker.reset();

      expect(breaker.getState()).toBe('closed');
      expect(breaker.isOpen()).toBe(false);
      expect(breaker.getSnapshot().failures).toBe(0);
      expect(breaker.getSnapshot().successes).toBe(0);
      expect(breaker.getSnapshot().consecutiveSuccesses).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// CircuitBreakerRegistry
// ---------------------------------------------------------------------------

describe('CircuitBreakerRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('getBreaker() returns the same instance for the same name on second call', () => {
    const store = new InMemoryCircuitBreakerStore();
    const registry = new CircuitBreakerRegistry(store);

    const first = registry.getBreaker({ name: 'api-breaker' });
    const second = registry.getBreaker({ name: 'api-breaker' });

    expect(first).toBe(second); // exact same reference
  });

  it('getBreaker() creates breaker backed by the registry store', async () => {
    const store: CircuitBreakerStore = {
      getState: vi.fn().mockResolvedValue(null),
      setState: vi.fn().mockResolvedValue(undefined),
    };
    const registry = new CircuitBreakerRegistry(store);

    const breaker = registry.getBreaker({ name: 'store-check' });

    // Recording a failure should persist through the registry's store
    await breaker.recordFailure();
    expect(store.setState).toHaveBeenCalledWith(
      'store-check',
      expect.objectContaining({ state: 'closed', failures: 1 }),
    );
  });

  it('getBreaker() when store.getState rejects -- breaker still created successfully', async () => {
    const store: CircuitBreakerStore = {
      getState: vi.fn().mockRejectedValue(new Error('Redis down')),
      setState: vi.fn().mockResolvedValue(undefined),
    };
    const registry = new CircuitBreakerRegistry(store);

    // Should not throw during creation
    const breaker = registry.getBreaker({ name: 'resilient-breaker' });
    expect(breaker).toBeDefined();
    expect(breaker.getState()).toBe('closed');

    // Even if loadState fails, the breaker should still work
    await breaker.recordFailure();
    expect(breaker.getSnapshot().failures).toBe(1);
  });

  it('onAnyStateChange() receives events from all breakers', async () => {
    const store = new InMemoryCircuitBreakerStore();
    const registry = new CircuitBreakerRegistry(store);

    const events: CircuitBreakerEvent[] = [];
    registry.onAnyStateChange((event) => events.push(event));

    // Create two breakers after registering the global listener
    const breakerA = registry.getBreaker({
      name: 'breaker-a',
      failureThreshold: 2,
    });
    const breakerB = registry.getBreaker({
      name: 'breaker-b',
      failureThreshold: 2,
    });

    // Trip breaker A
    await failN(breakerA, 2);
    // Trip breaker B
    await failN(breakerB, 2);

    const openedEvents = events.filter((e) => e.type === 'circuit_opened');
    expect(openedEvents).toHaveLength(2);

    const breakerNames = openedEvents.map((e) => e.breakerName).sort();
    expect(breakerNames).toEqual(['breaker-a', 'breaker-b']);
  });

  it('onAnyStateChange() also receives events from breakers created before the listener', async () => {
    const store = new InMemoryCircuitBreakerStore();
    const registry = new CircuitBreakerRegistry(store);

    // Create breaker BEFORE registering global listener
    const breaker = registry.getBreaker({
      name: 'pre-existing',
      failureThreshold: 2,
    });

    const events: CircuitBreakerEvent[] = [];
    registry.onAnyStateChange((event) => events.push(event));

    // Trip the pre-existing breaker
    await failN(breaker, 2);

    const openedEvent = events.find((e) => e.type === 'circuit_opened');
    expect(openedEvent).toBeDefined();
    expect(openedEvent!.breakerName).toBe('pre-existing');
  });
});

/**
 * Circuit Breaker Half-Open Probe Tests
 *
 * Verifies the probeInProgress flag ensures only one request passes through
 * during the half-open state in the reusable CircuitBreaker.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker } from '../../services/resilience/circuit-breaker.js';

describe('CircuitBreaker half-open probe guard', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers();
    cb = new CircuitBreaker({
      name: 'test-probe',
      failureThreshold: 3,
      successThreshold: 2,
      resetTimeoutMs: 5000,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Helper: trip the circuit breaker by recording enough failures to open it.
   */
  async function tripBreaker(): Promise<void> {
    await cb.recordFailure();
    await cb.recordFailure();
    await cb.recordFailure();
    expect(cb.getState()).toBe('open');
  }

  it('allows exactly one request when transitioning open -> half-open', async () => {
    await tripBreaker();

    // Advance past the resetTimeoutMs so the breaker can transition to half-open
    vi.advanceTimersByTime(5001);

    // First call: should transition to half-open and allow the probe
    const firstAllowed = !cb.isOpen();
    expect(firstAllowed).toBe(true);
    expect(cb.getState()).toBe('half-open');

    // Second call: probe is in progress, should be blocked
    const secondAllowed = !cb.isOpen();
    expect(secondAllowed).toBe(false);
  });

  it('blocks second concurrent request when probe is in progress', async () => {
    await tripBreaker();

    vi.advanceTimersByTime(5001);

    // First: allowed
    expect(cb.isOpen()).toBe(false);

    // Second, third: blocked while probe in progress
    expect(cb.isOpen()).toBe(true);
    expect(cb.isOpen()).toBe(true);
  });

  it('clears probeInProgress on recordSuccess and allows next probe', async () => {
    await tripBreaker();
    vi.advanceTimersByTime(5001);

    // First probe allowed
    expect(cb.isOpen()).toBe(false);
    expect(cb.getState()).toBe('half-open');

    // Record success for the probe
    await cb.recordSuccess();

    // successThreshold is 2, so one success keeps us in half-open
    expect(cb.getState()).toBe('half-open');

    // Since probeInProgress was cleared, the next isOpen() should allow another request
    expect(cb.isOpen()).toBe(false);

    // Record second success to close the circuit
    await cb.recordSuccess();
    expect(cb.getState()).toBe('closed');

    // Closed circuit allows all requests
    expect(cb.isOpen()).toBe(false);
    expect(cb.isOpen()).toBe(false);
  });

  it('clears probeInProgress on recordFailure and blocks until next timeout', async () => {
    await tripBreaker();
    vi.advanceTimersByTime(5001);

    // First probe allowed
    expect(cb.isOpen()).toBe(false);
    expect(cb.getState()).toBe('half-open');

    // Probe fails
    await cb.recordFailure();

    // Should transition back to open
    expect(cb.getState()).toBe('open');

    // Requests should be blocked
    expect(cb.isOpen()).toBe(true);

    // Advance time again past resetTimeoutMs
    vi.advanceTimersByTime(5001);

    // Now a new probe should be allowed
    expect(cb.isOpen()).toBe(false);
    expect(cb.getState()).toBe('half-open');
  });

  it('reset() clears the probe flag', async () => {
    await tripBreaker();
    vi.advanceTimersByTime(5001);

    // Start probe
    expect(cb.isOpen()).toBe(false);
    expect(cb.getState()).toBe('half-open');

    // Probe is in progress, second request blocked
    expect(cb.isOpen()).toBe(true);

    // Force reset
    await cb.reset();
    expect(cb.getState()).toBe('closed');

    // After reset, requests should flow freely
    expect(cb.isOpen()).toBe(false);

    // Trip the breaker again to test that the flag was cleared
    await cb.recordFailure();
    await cb.recordFailure();
    await cb.recordFailure();
    expect(cb.getState()).toBe('open');

    vi.advanceTimersByTime(5001);

    // A new probe should be allowed (flag was cleared by reset)
    expect(cb.isOpen()).toBe(false);
    expect(cb.getState()).toBe('half-open');
  });

  it('reports not hydrated before loadState completes', async () => {
    const slowStore = {
      getState: vi
        .fn()
        .mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(null), 1000))),
      setState: vi.fn().mockResolvedValue(undefined),
    };
    const cbSlow = new CircuitBreaker(
      { name: 'test-hydration', failureThreshold: 3, successThreshold: 2, resetTimeoutMs: 5000 },
      slowStore,
    );

    // Start hydration but don't await it
    const loadPromise = cbSlow.loadState();

    // Query before hydration completes — should still work (optimistic closed)
    expect(cbSlow.isOpen()).toBe(false);
    expect(cbSlow.isHydrated()).toBe(false);

    // Complete hydration
    vi.advanceTimersByTime(1001);
    await loadPromise;

    expect(cbSlow.isHydrated()).toBe(true);
  });

  it('persists state to store when isOpen() triggers half-open transition', async () => {
    const mockStore = {
      getState: vi.fn().mockResolvedValue(null),
      setState: vi.fn().mockResolvedValue(undefined),
    };
    const cbWithStore = new CircuitBreaker(
      {
        name: 'test-persist',
        failureThreshold: 3,
        successThreshold: 2,
        resetTimeoutMs: 5000,
      },
      mockStore,
    );

    // Trip the breaker
    await cbWithStore.recordFailure();
    await cbWithStore.recordFailure();
    await cbWithStore.recordFailure();
    expect(cbWithStore.getState()).toBe('open');

    // Clear mock calls from recordFailure persists
    mockStore.setState.mockClear();

    // Advance past resetTimeoutMs
    vi.advanceTimersByTime(5001);

    // Trigger half-open transition via isOpen()
    expect(cbWithStore.isOpen()).toBe(false);
    expect(cbWithStore.getState()).toBe('half-open');

    // Wait for background persist to flush
    await vi.waitFor(() => {
      expect(mockStore.setState).toHaveBeenCalledWith(
        'test-persist',
        expect.objectContaining({ state: 'half-open' }),
      );
    });
  });
});

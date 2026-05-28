/**
 * HTTP Resilience CircuitBreaker Half-Open Probe Tests
 *
 * Verifies the probeInProgress flag in the lightweight CircuitBreaker from
 * http-resilience.ts ensures only one request passes through during half-open.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker } from '../http-resilience.js';

describe('CircuitBreaker (http-resilience) half-open probe guard', () => {
  let cb: CircuitBreaker;
  const THRESHOLD = 3;
  const RESET_MS = 5000;

  beforeEach(() => {
    vi.useFakeTimers();
    cb = new CircuitBreaker(THRESHOLD, RESET_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Helper: trip the circuit breaker open by recording `threshold` failures.
   */
  function tripBreaker(): void {
    for (let i = 0; i < THRESHOLD; i++) {
      cb.recordFailure();
    }
    expect(cb.getState()).toBe('open');
  }

  it('allows one request in half-open, blocks concurrent', () => {
    tripBreaker();

    // Advance past resetMs so half-open transition can occur
    vi.advanceTimersByTime(RESET_MS + 1);

    // First isOpen() triggers open -> half-open transition and allows the probe
    expect(cb.isOpen()).toBe(false);
    expect(cb.getState()).toBe('half-open');

    // Second call: probe is in progress, should be blocked
    expect(cb.isOpen()).toBe(true);

    // Third call: still blocked
    expect(cb.isOpen()).toBe(true);
  });

  it('recordSuccess clears flag and transitions to closed state', () => {
    tripBreaker();
    vi.advanceTimersByTime(RESET_MS + 1);

    // Allow probe
    expect(cb.isOpen()).toBe(false);

    // Probe succeeds
    cb.recordSuccess();

    // Circuit should be closed
    expect(cb.getState()).toBe('closed');

    // All subsequent requests should pass
    expect(cb.isOpen()).toBe(false);
    expect(cb.isOpen()).toBe(false);
  });

  it('recordFailure clears flag and transitions to open state', () => {
    tripBreaker();
    vi.advanceTimersByTime(RESET_MS + 1);

    // Allow probe
    expect(cb.isOpen()).toBe(false);
    expect(cb.getState()).toBe('half-open');

    // Probe fails
    cb.recordFailure();

    // Circuit should go back to open
    expect(cb.getState()).toBe('open');

    // Requests should be blocked
    expect(cb.isOpen()).toBe(true);

    // Advance time again — new probe should be allowed
    vi.advanceTimersByTime(RESET_MS + 1);
    expect(cb.isOpen()).toBe(false);
    expect(cb.getState()).toBe('half-open');
  });
});

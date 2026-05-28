/**
 * Tests for pipeline circuit breaker.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  isPipelineCircuitOpen,
  recordPipelineSuccess,
  recordPipelineFailure,
  resetPipelineCircuit,
  _clearAllBreakers,
} from '../services/pipeline/circuit-breaker.js';

beforeEach(() => {
  _clearAllBreakers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('pipeline circuit breaker', () => {
  it('starts closed', () => {
    expect(isPipelineCircuitOpen('tenant-1')).toBe(false);
  });

  it('stays closed after 1-2 failures', () => {
    recordPipelineFailure('tenant-1');
    expect(isPipelineCircuitOpen('tenant-1')).toBe(false);
    recordPipelineFailure('tenant-1');
    expect(isPipelineCircuitOpen('tenant-1')).toBe(false);
  });

  it('opens after 3 consecutive failures', () => {
    recordPipelineFailure('tenant-1');
    recordPipelineFailure('tenant-1');
    recordPipelineFailure('tenant-1');
    expect(isPipelineCircuitOpen('tenant-1')).toBe(true);
  });

  it('success resets failure counter', () => {
    recordPipelineFailure('tenant-1');
    recordPipelineFailure('tenant-1');
    recordPipelineSuccess('tenant-1');
    recordPipelineFailure('tenant-1');
    recordPipelineFailure('tenant-1');
    // Only 2 consecutive failures after reset, not 3
    expect(isPipelineCircuitOpen('tenant-1')).toBe(false);
  });

  it('tenants are isolated', () => {
    recordPipelineFailure('tenant-1');
    recordPipelineFailure('tenant-1');
    recordPipelineFailure('tenant-1');
    expect(isPipelineCircuitOpen('tenant-1')).toBe(true);
    expect(isPipelineCircuitOpen('tenant-2')).toBe(false);
  });

  it('resets to half-open after timeout', () => {
    recordPipelineFailure('tenant-1');
    recordPipelineFailure('tenant-1');
    recordPipelineFailure('tenant-1');
    expect(isPipelineCircuitOpen('tenant-1')).toBe(true);

    // Fast-forward past reset timeout (60s)
    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);

    expect(isPipelineCircuitOpen('tenant-1')).toBe(false); // half-open, allows probe

    vi.useRealTimers();
  });

  it('re-opens on single failure after half-open', () => {
    recordPipelineFailure('tenant-1');
    recordPipelineFailure('tenant-1');
    recordPipelineFailure('tenant-1');

    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);

    // Half-open probe
    expect(isPipelineCircuitOpen('tenant-1')).toBe(false);

    // Probe fails → re-opens immediately (threshold - 1 + 1 = threshold)
    recordPipelineFailure('tenant-1');
    expect(isPipelineCircuitOpen('tenant-1')).toBe(true);

    vi.useRealTimers();
  });

  it('closes after successful probe in half-open', () => {
    recordPipelineFailure('tenant-1');
    recordPipelineFailure('tenant-1');
    recordPipelineFailure('tenant-1');

    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);

    // Half-open probe
    expect(isPipelineCircuitOpen('tenant-1')).toBe(false);

    // Probe succeeds → fully closed
    recordPipelineSuccess('tenant-1');
    expect(isPipelineCircuitOpen('tenant-1')).toBe(false);

    // Needs full 3 failures again to re-open
    recordPipelineFailure('tenant-1');
    recordPipelineFailure('tenant-1');
    expect(isPipelineCircuitOpen('tenant-1')).toBe(false);

    vi.useRealTimers();
  });

  it('resetPipelineCircuit clears state', () => {
    recordPipelineFailure('tenant-1');
    recordPipelineFailure('tenant-1');
    recordPipelineFailure('tenant-1');
    expect(isPipelineCircuitOpen('tenant-1')).toBe(true);

    resetPipelineCircuit('tenant-1');
    expect(isPipelineCircuitOpen('tenant-1')).toBe(false);
  });
});

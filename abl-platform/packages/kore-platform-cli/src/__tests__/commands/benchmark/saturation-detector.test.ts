/**
 * Saturation Detector Tests
 *
 * Pure logic tests — no mocks needed.
 */

import { describe, it, expect } from 'vitest';
import { detectSaturation } from '../../../commands/benchmark/saturation-detector.js';
import type { SaturationInput } from '../../../commands/benchmark/saturation-detector.js';

function makeInput(overrides: Partial<SaturationInput> = {}): SaturationInput {
  return {
    errorRate: 0,
    baselineP95Ms: 50,
    currentP95Ms: 60,
    cpuPeakPercent: null,
    wsUpgradeRefused: 0,
    wsTimeoutSpike: false,
    rps: 200,
    maxVUs: 50,
    ...overrides,
  };
}

describe('detectSaturation', () => {
  it('should return not saturated when all signals are healthy', () => {
    const result = detectSaturation(makeInput());

    expect(result.saturated).toBe(false);
    expect(result.trigger).toBe('none');
    expect(result.maxRpsPerPod).toBe(200);
    expect(result.maxConcurrentPerPod).toBe(50);
  });

  // Priority 1: error-rate
  it('should detect error-rate saturation at >1%', () => {
    const result = detectSaturation(makeInput({ errorRate: 0.02 }));

    expect(result.saturated).toBe(true);
    expect(result.trigger).toBe('error-rate');
  });

  it('should not trigger error-rate at exactly 1%', () => {
    const result = detectSaturation(makeInput({ errorRate: 0.01 }));

    expect(result.saturated).toBe(false);
  });

  // Priority 2: latency
  it('should detect latency saturation when p95 > 2x baseline', () => {
    const result = detectSaturation(makeInput({ baselineP95Ms: 50, currentP95Ms: 110 }));

    expect(result.saturated).toBe(true);
    expect(result.trigger).toBe('latency');
  });

  it('should not trigger latency at exactly 2x baseline', () => {
    const result = detectSaturation(makeInput({ baselineP95Ms: 50, currentP95Ms: 100 }));

    expect(result.saturated).toBe(false);
  });

  it('should not trigger latency when baseline is 0', () => {
    const result = detectSaturation(makeInput({ baselineP95Ms: 0, currentP95Ms: 500 }));

    expect(result.saturated).toBe(false);
  });

  // Priority 3: CPU
  it('should detect CPU saturation at >85%', () => {
    const result = detectSaturation(makeInput({ cpuPeakPercent: 90 }));

    expect(result.saturated).toBe(true);
    expect(result.trigger).toBe('cpu');
  });

  it('should not trigger CPU at exactly 85%', () => {
    const result = detectSaturation(makeInput({ cpuPeakPercent: 85 }));

    expect(result.saturated).toBe(false);
  });

  it('should not trigger CPU when cpuPeakPercent is null', () => {
    const result = detectSaturation(makeInput({ cpuPeakPercent: null }));

    expect(result.saturated).toBe(false);
  });

  // Priority 4: connections
  it('should detect connection saturation on WS upgrade refused', () => {
    const result = detectSaturation(makeInput({ wsUpgradeRefused: 5 }));

    expect(result.saturated).toBe(true);
    expect(result.trigger).toBe('connections');
  });

  it('should detect connection saturation on WS timeout spike', () => {
    const result = detectSaturation(makeInput({ wsTimeoutSpike: true }));

    expect(result.saturated).toBe(true);
    expect(result.trigger).toBe('connections');
  });

  // Priority ordering
  it('should prioritize error-rate over latency', () => {
    const result = detectSaturation(
      makeInput({
        errorRate: 0.05,
        baselineP95Ms: 50,
        currentP95Ms: 200,
      }),
    );

    expect(result.trigger).toBe('error-rate');
  });

  it('should prioritize latency over CPU', () => {
    const result = detectSaturation(
      makeInput({
        baselineP95Ms: 50,
        currentP95Ms: 200,
        cpuPeakPercent: 95,
      }),
    );

    expect(result.trigger).toBe('latency');
  });

  it('should prioritize CPU over connections', () => {
    const result = detectSaturation(
      makeInput({
        cpuPeakPercent: 95,
        wsUpgradeRefused: 10,
      }),
    );

    expect(result.trigger).toBe('cpu');
  });

  it('should return rps and maxVUs in all results', () => {
    const result = detectSaturation(makeInput({ rps: 500, maxVUs: 100 }));

    expect(result.maxRpsPerPod).toBe(500);
    expect(result.maxConcurrentPerPod).toBe(100);
  });
});

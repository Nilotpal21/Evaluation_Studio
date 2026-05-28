/**
 * Saturation Detector for Benchmark Orchestrator
 *
 * Multi-signal saturation detection with priority ordering:
 * error-rate > latency > cpu > connections
 */

import type { SaturationTrigger } from '@agent-platform/sizing-calculator';

/** Thresholds for saturation detection. */
const ERROR_RATE_THRESHOLD = 0.01; // 1%
const LATENCY_MULTIPLIER_THRESHOLD = 2.0; // p95 > 2x baseline
const CPU_PEAK_THRESHOLD = 85; // 85%

export interface SaturationInput {
  errorRate: number;
  baselineP95Ms: number;
  currentP95Ms: number;
  cpuPeakPercent: number | null;
  wsUpgradeRefused: number;
  wsTimeoutSpike: boolean;
  rps: number;
  maxVUs: number;
}

export interface SaturationResult {
  saturated: boolean;
  trigger: SaturationTrigger | 'none';
  maxRpsPerPod: number;
  maxConcurrentPerPod: number;
}

/**
 * Detect saturation from multiple signals.
 *
 * Priority order: error-rate > latency > cpu > connections.
 * Returns the highest-priority trigger that fired.
 */
export function detectSaturation(input: SaturationInput): SaturationResult {
  // Priority 1: Error rate
  if (input.errorRate > ERROR_RATE_THRESHOLD) {
    return {
      saturated: true,
      trigger: 'error-rate',
      maxRpsPerPod: input.rps,
      maxConcurrentPerPod: input.maxVUs,
    };
  }

  // Priority 2: Latency degradation
  if (
    input.baselineP95Ms > 0 &&
    input.currentP95Ms > input.baselineP95Ms * LATENCY_MULTIPLIER_THRESHOLD
  ) {
    return {
      saturated: true,
      trigger: 'latency',
      maxRpsPerPod: input.rps,
      maxConcurrentPerPod: input.maxVUs,
    };
  }

  // Priority 3: CPU saturation
  if (input.cpuPeakPercent !== null && input.cpuPeakPercent > CPU_PEAK_THRESHOLD) {
    return {
      saturated: true,
      trigger: 'cpu',
      maxRpsPerPod: input.rps,
      maxConcurrentPerPod: input.maxVUs,
    };
  }

  // Priority 4: WebSocket connection issues
  if (input.wsUpgradeRefused > 0 || input.wsTimeoutSpike) {
    return {
      saturated: true,
      trigger: 'connections',
      maxRpsPerPod: input.rps,
      maxConcurrentPerPod: input.maxVUs,
    };
  }

  // No saturation detected
  return {
    saturated: false,
    trigger: 'none',
    maxRpsPerPod: input.rps,
    maxConcurrentPerPod: input.maxVUs,
  };
}

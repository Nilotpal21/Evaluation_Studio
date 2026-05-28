/**
 * Saturation Finder — Adaptive binary search to discover the VU tipping point.
 *
 * Algorithm:
 * 1. Exponential growth: start at `startVUs`, double each run until unhealthy.
 * 2. Binary refinement: narrow between last-healthy and first-unhealthy VUs.
 * 3. Stop after `maxRuns` total runs or when the search band is ≤ step size.
 *
 * Health criteria (must ALL pass):
 * - error_rate < 1%
 * - p95 < 2000ms
 * - no OOM kills (if infra metrics available)
 */

export interface SaturationFindConfig {
  /** Starting VU count for the first run. */
  startVUs: number;
  /** Maximum number of test runs allowed. Default 5. */
  maxRuns: number;
  /** Duration per run in minutes. */
  durationMinutes: number;
  /** Minimum VU step to stop binary search. */
  minStep: number;
}

export interface RunScenario {
  name: string;
  requests: number | string;
  errorRate: number;
  throughput: string;
  latency: {
    avgMs: number;
    medianMs: number;
    p90Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
  };
}

export interface RunInfra {
  cpuPeak: string;
  cpuAvg: string;
  memoryPeak: string;
  memoryAvg: string;
  podRestarts: number;
  oomKills: number;
  observedRps: number | string;
}

export interface RunResult {
  runIndex: number;
  vus: number;
  healthy: boolean;
  errorRate: number;
  p95Ms: number;
  p99Ms: number;
  avgMs: number;
  throughputRps: number;
  totalRequests: number;
  oomKills: number;
  trigger: string;
  /** ISO timestamp of when this run started. */
  startedAt: string;
  /** Duration in seconds. */
  durationSec: number;
  /** Per-scenario breakdown (if available). */
  scenarios?: RunScenario[];
  /** Infrastructure metrics for the tested service (if available). */
  infra?: RunInfra;
  /** LLM metrics extracted from SSE complete events (if available). */
  llm?: RunLLMMetrics;
  /** WebSocket metrics (connect latency, timeouts, message latency). */
  ws?: RunWSMetrics;
}

export interface RunLLMMetrics {
  /** Server-reported LLM latency from SSE complete event (avg ms). */
  avgMs: number;
  /** p95 LLM latency (ms). */
  p95Ms: number;
  /** Median LLM latency (ms). */
  medianMs: number;
  /** Max LLM latency (ms). */
  maxMs: number;
  /** Total input tokens consumed. */
  inputTokens: number;
  /** Total output tokens consumed. */
  outputTokens: number;
}

export interface RunWSMetrics {
  /** Total WebSocket connection attempts. */
  totalConnections: number;
  /** Connection errors. */
  connectionErrors: number;
  /** Connection timeouts. */
  connectionTimeouts: number;
  /** Connect latency distribution. */
  connectLatency: {
    avgMs: number;
    medianMs: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
  };
  /** Per-message latency (multi-turn). */
  messageLatency?: {
    avgMs: number;
    medianMs: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
  };
  /** Total multi-turn conversations. */
  messageRequests?: number;
}

export interface SaturationFindResult {
  runs: RunResult[];
  /** The highest healthy VU count found, or null if even startVUs was unhealthy. */
  tippingPointVUs: number | null;
  /** The lowest unhealthy VU count found, or null if never saturated. */
  firstUnhealthyVUs: number | null;
  /** Whether the algorithm converged within maxRuns. */
  converged: boolean;
  /** Algorithm phase when finished: 'growth' or 'refinement'. */
  phase: 'growth' | 'refinement';
  /** Total wall-clock seconds across all runs. */
  totalDurationSec: number;
}

const ERROR_RATE_THRESHOLD = 0.01; // 1%
const P95_THRESHOLD_MS = 2000; // 2 seconds

/**
 * Evaluate whether a run's metrics indicate a healthy service.
 */
export function evaluateHealth(metrics: { errorRate: number; p95Ms: number; oomKills?: number }): {
  healthy: boolean;
  trigger: string;
} {
  if (metrics.errorRate > ERROR_RATE_THRESHOLD) {
    return { healthy: false, trigger: `error_rate=${(metrics.errorRate * 100).toFixed(1)}% > 1%` };
  }
  if (metrics.p95Ms > P95_THRESHOLD_MS) {
    return { healthy: false, trigger: `p95=${metrics.p95Ms.toFixed(0)}ms > 2000ms` };
  }
  if (metrics.oomKills && metrics.oomKills > 0) {
    return { healthy: false, trigger: `oom_kills=${metrics.oomKills}` };
  }
  return { healthy: true, trigger: 'none' };
}

/**
 * Compute the next VU count using adaptive binary search.
 *
 * Phase 1 (growth): double VUs each run until unhealthy.
 * Phase 2 (refinement): binary search between lastHealthy and firstUnhealthy.
 */
export function computeNextVUs(
  runs: RunResult[],
  config: SaturationFindConfig,
): { vus: number; phase: 'growth' | 'refinement'; done: boolean } {
  if (runs.length === 0) {
    return { vus: config.startVUs, phase: 'growth', done: false };
  }

  const lastRun = runs[runs.length - 1];

  // Find bounds
  const healthyVUs = runs.filter((r) => r.healthy).map((r) => r.vus);
  const unhealthyVUs = runs.filter((r) => !r.healthy).map((r) => r.vus);

  const maxHealthy = healthyVUs.length > 0 ? Math.max(...healthyVUs) : null;
  const minUnhealthy = unhealthyVUs.length > 0 ? Math.min(...unhealthyVUs) : null;

  // Phase 1: Growth — keep doubling if still healthy
  if (minUnhealthy === null) {
    // Never unhealthy yet — double
    const nextVUs = lastRun.vus * 2;
    return { vus: nextVUs, phase: 'growth', done: false };
  }

  // If the very first run was unhealthy, try half
  if (maxHealthy === null) {
    const nextVUs = Math.max(Math.floor(minUnhealthy / 2), config.minStep);
    if (nextVUs >= minUnhealthy) {
      return { vus: nextVUs, phase: 'refinement', done: true };
    }
    return { vus: nextVUs, phase: 'refinement', done: false };
  }

  // Phase 2: Refinement — binary search between maxHealthy and minUnhealthy
  const mid = Math.floor((maxHealthy + minUnhealthy) / 2);
  const band = minUnhealthy - maxHealthy;

  // Converged if band is small enough or mid equals one of the bounds
  if (band <= config.minStep || mid === maxHealthy || mid === minUnhealthy) {
    return { vus: mid, phase: 'refinement', done: true };
  }

  return { vus: mid, phase: 'refinement', done: false };
}

/**
 * Build the final result from all runs.
 */
export function buildFindResult(
  runs: RunResult[],
  config: SaturationFindConfig,
): SaturationFindResult {
  const healthyRuns = runs.filter((r) => r.healthy);
  const unhealthyRuns = runs.filter((r) => !r.healthy);

  const tippingPointVUs =
    healthyRuns.length > 0 ? Math.max(...healthyRuns.map((r) => r.vus)) : null;
  const firstUnhealthyVUs =
    unhealthyRuns.length > 0 ? Math.min(...unhealthyRuns.map((r) => r.vus)) : null;

  // Check convergence: have both bounds and the band is small
  let converged = false;
  if (tippingPointVUs !== null && firstUnhealthyVUs !== null) {
    converged = firstUnhealthyVUs - tippingPointVUs <= config.minStep;
  }

  const totalDurationSec = runs.reduce((sum, r) => sum + r.durationSec, 0);
  const lastNext = computeNextVUs(runs, config);

  return {
    runs,
    tippingPointVUs,
    firstUnhealthyVUs,
    converged: converged || lastNext.done,
    phase: lastNext.phase,
    totalDurationSec,
  };
}

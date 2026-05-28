/**
 * Shared saturation utilities for k6 ramp-to-saturation benchmarks.
 *
 * Used by all scripts in benchmarks/saturation/ to ensure consistent
 * ramp patterns, scenario weighting, and saturation detection.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A k6 ramping-vus stage */
export interface RampStage {
  duration: string;
  target: number;
}

/** Metrics snapshot used for saturation detection */
export interface SaturationMetrics {
  /** Current error rate (0-1 scale, e.g., 0.01 = 1%) */
  errorRate: number;
  /** Current p95 latency in ms */
  p95Ms: number;
  /** Baseline p95 latency in ms (from warm-up phase) */
  baselineP95Ms: number;
  /** CPU utilization percent (0-100) — from Coroot, may be null */
  cpuPercent: number | null;
  /** Whether connection pool is exhausted (from k6 connection errors) */
  connectionsExhausted: boolean;
}

/** Result of saturation detection */
export interface SaturationResult {
  saturated: boolean;
  trigger: 'error-rate' | 'latency' | 'cpu' | 'connections' | null;
  details: string;
}

/** Map of scenario name → exec function name */
export interface ScenarioExecMap {
  [scenarioName: string]: string;
}

// ---------------------------------------------------------------------------
// Constants — Saturation Thresholds
// ---------------------------------------------------------------------------

/** Error rate threshold: >1% signals saturation */
const ERROR_RATE_THRESHOLD = 0.01;

/** Latency multiplier: p95 > 2x baseline signals saturation */
const LATENCY_MULTIPLIER_THRESHOLD = 2.0;

/** CPU threshold: >85% signals saturation */
const CPU_THRESHOLD_PERCENT = 85;

// ---------------------------------------------------------------------------
// createRampStages
// ---------------------------------------------------------------------------

/**
 * Generate ramping-vus stages for a saturation test.
 *
 * The ramp follows this pattern:
 *   1. Warm-up:  0 → 10% of max over 15% of duration
 *   2. Ramp:     10% → 80% of max over 45% of duration
 *   3. Push:     80% → 100% of max over 25% of duration
 *   4. Cool-down: 100% → 0 over 15% of duration
 */
export function createRampStages(maxVUs: number, durationMinutes = 20): RampStage[] {
  const warmupTarget = Math.max(1, Math.round(maxVUs * 0.1));
  const rampTarget = Math.round(maxVUs * 0.8);

  const warmupMin = Math.round(durationMinutes * 0.15);
  const rampMin = Math.round(durationMinutes * 0.45);
  const pushMin = Math.round(durationMinutes * 0.25);
  const cooldownMin = Math.max(1, durationMinutes - warmupMin - rampMin - pushMin);

  return [
    { duration: `${warmupMin}m`, target: warmupTarget },
    { duration: `${rampMin}m`, target: rampTarget },
    { duration: `${pushMin}m`, target: maxVUs },
    { duration: `${cooldownMin}m`, target: 0 },
  ];
}

// ---------------------------------------------------------------------------
// detectSaturation
// ---------------------------------------------------------------------------

/**
 * Multi-signal saturation detection.
 *
 * Returns saturated=true if ANY of these conditions is met:
 *   1. Error rate > 1%
 *   2. p95 latency > 2x baseline
 *   3. CPU utilization > 85%
 *   4. Connection pool exhausted
 */
export function detectSaturation(metrics: SaturationMetrics): SaturationResult {
  if (metrics.errorRate > ERROR_RATE_THRESHOLD) {
    return {
      saturated: true,
      trigger: 'error-rate',
      details: `Error rate ${(metrics.errorRate * 100).toFixed(2)}% exceeds ${ERROR_RATE_THRESHOLD * 100}% threshold`,
    };
  }

  if (
    metrics.baselineP95Ms > 0 &&
    metrics.p95Ms > metrics.baselineP95Ms * LATENCY_MULTIPLIER_THRESHOLD
  ) {
    return {
      saturated: true,
      trigger: 'latency',
      details: `p95 ${metrics.p95Ms}ms exceeds ${LATENCY_MULTIPLIER_THRESHOLD}x baseline (${metrics.baselineP95Ms}ms)`,
    };
  }

  if (metrics.cpuPercent !== null && metrics.cpuPercent > CPU_THRESHOLD_PERCENT) {
    return {
      saturated: true,
      trigger: 'cpu',
      details: `CPU ${metrics.cpuPercent.toFixed(1)}% exceeds ${CPU_THRESHOLD_PERCENT}% threshold`,
    };
  }

  if (metrics.connectionsExhausted) {
    return {
      saturated: true,
      trigger: 'connections',
      details: 'Connection pool exhausted — new connections being refused',
    };
  }

  return { saturated: false, trigger: null, details: 'Within normal parameters' };
}

// ---------------------------------------------------------------------------
// SCENARIO_WEIGHTS
// ---------------------------------------------------------------------------

/**
 * Default scenario weights per service, from design spec Section 8.
 * Weights must sum to 1.0 for each service.
 */
export const SCENARIO_WEIGHTS: Record<string, Record<string, number>> = {
  runtime: {
    single_turn: 0.5,
    multi_turn: 0.25,
    tool_calling: 0.15,
    concurrent: 0.1,
  },
  'search-ai': {
    kb_operations: 0.4,
    document_ops: 0.4,
    crawl_submit: 0.2,
  },
  'bge-m3': {
    single_embed: 0.3,
    batch_embed: 0.4,
    concurrent_embed: 0.3,
  },
  'search-ai-runtime': {
    doc_listing: 0.2,
    chunk_reads: 0.3,
    kb_reads: 0.2,
    concurrent: 0.3,
  },
  opensearch: {
    documentIndex: 0.2,
    vectorSearchK5: 0.4,
    vectorSearchK50: 0.2,
    hybridSearch: 0.2,
  },
  mongodb: {
    conversationCrud: 0.4,
    messageInserts: 0.35,
    aggregationQueries: 0.25,
  },
  redis: {
    getSet: 0.4,
    sessionState: 0.35,
    bullmqEnqueueDequeue: 0.25,
  },
  clickhouse: {
    bulkTraceInsert: 0.4,
    timeRangeQuery: 0.35,
    aggregationQuery: 0.25,
  },
  qdrant: {
    pointUpsert: 0.15,
    searchK5: 0.35,
    searchK10: 0.2,
    searchK50: 0.1,
    filteredSearch: 0.2,
  },
  studio: {
    page_load: 0.4,
    api_crud: 0.35,
    concurrent_developers: 0.25,
  },
  docling: {
    pdf_small: 0.4,
    pdf_large: 0.2,
    image_ocr: 0.25,
    table_extraction: 0.15,
  },
  preprocessing: {
    query_preprocess: 0.4,
    entity_extraction: 0.25,
    batch_preprocess: 0.15,
    sustained_load: 0.2,
  },
  neo4j: {
    batchNodeCreation: 0.2,
    singleHopTraversal: 0.35,
    threeHopTraversal: 0.3,
    fiveHopTraversal: 0.15,
  },
  restate: {
    threeStepWorkflow: 0.35,
    tenStepWorkflow: 0.25,
    sleepWorkflow: 0.15,
    retryWorkflow: 0.25,
  },
  crawler: {
    single_batch: 0.35,
    crawl_status: 0.3,
    concurrent_batches: 0.35,
  },
  'workflow-engine': {
    simple_workflow: 0.45,
    branching_workflow: 0.3,
    external_api_workflow: 0.25,
  },
};

// ---------------------------------------------------------------------------
// buildBlendedScenarios
// ---------------------------------------------------------------------------

/**
 * Generate k6 scenario config with weighted VU distribution.
 *
 * Each scenario gets a share of the total VUs proportional to its weight.
 * All scenarios run the same ramp stages concurrently.
 */
export function buildBlendedScenarios(
  service: string,
  maxVUs: number,
  scenarioExecMap: ScenarioExecMap,
  durationMinutes = 20,
  weights?: Record<string, number>,
): Record<string, Record<string, unknown>> {
  const serviceWeights = weights || SCENARIO_WEIGHTS[service];
  if (!serviceWeights) {
    throw new Error(`No scenario weights defined for service: ${service}`);
  }

  const scenarios: Record<string, Record<string, unknown>> = {};
  const scenarioNames = Object.keys(serviceWeights);

  for (const name of scenarioNames) {
    const weight = serviceWeights[name];
    const execFn = scenarioExecMap[name];
    if (!execFn) {
      throw new Error(`No exec function mapped for scenario: ${name}`);
    }

    const scenarioMaxVUs = Math.max(1, Math.round(maxVUs * weight));
    const stages = createRampStages(scenarioMaxVUs, durationMinutes);

    scenarios[name] = {
      executor: 'ramping-vus',
      startVUs: 0,
      stages,
      exec: execFn,
      tags: { scenario: name, service },
    };
  }

  return scenarios;
}

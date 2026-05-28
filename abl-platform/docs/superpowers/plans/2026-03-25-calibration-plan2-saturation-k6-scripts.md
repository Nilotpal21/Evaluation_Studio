# Calibration Pipeline — Plan 2: Saturation k6 Scripts + Shared Lib

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create shared saturation utilities in `benchmarks/lib/saturation-utils.ts` and k6 saturation scripts for the three highest-priority services (runtime, search-ai, bge-m3). These scripts use `ramping-vus` stages to ramp load until saturation is detected, enabling the CLI orchestrator (Plan 4) to determine per-pod capacity ceilings.

**Architecture:** Saturation scripts differ from the existing per-service benchmarks in `benchmarks/services/` in two ways: (1) they use a continuous ramp from 1 VU to a configurable max over a longer duration, and (2) they distribute VUs across scenarios using weighted blended workloads that reflect production traffic patterns. The shared `saturation-utils.ts` library provides stage generation, scenario building, and saturation signal detection so that all saturation scripts follow the same pattern.

**Tech Stack:** k6 (native TypeScript), `@types/k6`, existing `benchmarks/lib/` shared modules

**Spec:** `docs/superpowers/specs/2026-03-24-benchmark-sizing-calibration-design.md` — Sections 8 (Benchmark Orchestration Flow), 13 (Service Configuration)

**Plan series:** This is Plan 2 of 6. It depends on Plan 1 types and feeds into Plan 4 (CLI Benchmark Orchestrator).

| Plan         | Subsystem                                      | Status |
| ------------ | ---------------------------------------------- | ------ |
| 1            | Data Model + Traffic Model + Sizing Calculator | Done   |
| **2 (this)** | Saturation k6 Scripts + Shared Lib             | —      |
| 3            | Coroot Metrics Collector                       | —      |
| 4            | CLI Benchmark Orchestrator                     | —      |
| 5            | Report Generation                              | —      |
| 6            | Shell Script Updates (service groups)          | —      |

---

## File Structure

### New Files

| File                                 | Responsibility                                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `benchmarks/lib/saturation-utils.ts` | Shared saturation utilities: `createRampStages`, `detectSaturation`, `SCENARIO_WEIGHTS`, `buildBlendedScenarios` |
| `benchmarks/saturation/runtime.ts`   | Runtime saturation script: single_turn, multi_turn, tool_calling, concurrent                                     |
| `benchmarks/saturation/search-ai.ts` | SearchAI saturation script: kb_operations, document_ops, crawl_submit                                            |
| `benchmarks/saturation/bge-m3.ts`    | BGE-M3 saturation script: single_embed, batch_embed, concurrent_embed                                            |

### Modified Files

None — all new files.

### Dependencies on Plan 1

The saturation scripts produce k6 JSON summary output that the CLI orchestrator (Plan 4) parses into `ServiceCapacity` types defined in Plan 1. The scripts themselves do not import from `packages/sizing-calculator/` — they are pure k6 scripts. The `SCENARIO_WEIGHTS` constant in `saturation-utils.ts` mirrors the weights from the design spec Section 8.

---

## Task 1: Shared Saturation Utilities — `benchmarks/lib/saturation-utils.ts`

**Files:**

- Create: `benchmarks/lib/saturation-utils.ts`

This is the foundation for all saturation scripts. It exports four things:

1. `createRampStages(maxVUs, durationMinutes)` — generates `ramping-vus` stages array
2. `detectSaturation(metrics)` — multi-signal saturation detection
3. `SCENARIO_WEIGHTS` — per-service scenario weight maps from the design spec
4. `buildBlendedScenarios(service, maxVUs, weights, durationMinutes, scenarioExecMap)` — generates k6 scenario config with weighted VU distribution

- [ ] **Step 1: Create the saturation-utils.ts file**

Create `benchmarks/lib/saturation-utils.ts` with all four exports.

```typescript
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
 *
 * @param maxVUs - Maximum VU count to ramp to
 * @param durationMinutes - Total test duration in minutes (default: 20)
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
 *
 * The earliest trigger wins — it determines the saturation cause.
 */
export function detectSaturation(metrics: SaturationMetrics): SaturationResult {
  // Signal 1: Error rate
  if (metrics.errorRate > ERROR_RATE_THRESHOLD) {
    return {
      saturated: true,
      trigger: 'error-rate',
      details: `Error rate ${(metrics.errorRate * 100).toFixed(2)}% exceeds ${ERROR_RATE_THRESHOLD * 100}% threshold`,
    };
  }

  // Signal 2: Latency degradation
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

  // Signal 3: CPU saturation
  if (metrics.cpuPercent !== null && metrics.cpuPercent > CPU_THRESHOLD_PERCENT) {
    return {
      saturated: true,
      trigger: 'cpu',
      details: `CPU ${metrics.cpuPercent.toFixed(1)}% exceeds ${CPU_THRESHOLD_PERCENT}% threshold`,
    };
  }

  // Signal 4: Connection exhaustion
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
 * Used by buildBlendedScenarios() to distribute VUs proportionally.
 */
export const SCENARIO_WEIGHTS: Record<string, Record<string, number>> = {
  runtime: {
    single_turn: 0.5,
    multi_turn: 0.25,
    tool_calling: 0.15,
    concurrent: 0.1, // maps to the `wsConnectionRamp` exec function in benchmarks/services/runtime.ts
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
 *
 * @param service - Service name (key into SCENARIO_WEIGHTS)
 * @param maxVUs - Maximum total VUs across all scenarios
 * @param scenarioExecMap - Map of scenario name → exported exec function name
 * @param durationMinutes - Total test duration in minutes (default: 20)
 * @param weights - Optional weight overrides (defaults to SCENARIO_WEIGHTS[service])
 * @returns k6 scenarios config object
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

    // Allocate VUs proportionally, minimum 1
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
```

Expected file location: `benchmarks/lib/saturation-utils.ts`

- [ ] **Step 1b: Add companion unit test file**

`createRampStages`, `detectSaturation`, and `buildBlendedScenarios` are pure functions with no k6 runtime dependencies, making them straightforward to unit test. Create `benchmarks/lib/__tests__/saturation-utils.test.ts` covering: stage generation edge cases (maxVUs=1, very short durations), all four saturation signals, weight distribution rounding, and the error path when a service has no weights defined.

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd benchmarks && npx tsc --noEmit
```

Expected: SUCCESS — no type errors. k6 types are available via `@types/k6`, and this file uses no k6 imports (pure utility functions).

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write benchmarks/lib/saturation-utils.ts
git add benchmarks/lib/saturation-utils.ts
git commit -m "[ABLP-2] feat(benchmarks): add shared saturation utilities library"
```

---

## Task 2: Runtime Saturation Script — `benchmarks/saturation/runtime.ts`

**Files:**

- Create: `benchmarks/saturation/runtime.ts`

This script exercises runtime across 4 scenarios with weighted VU distribution using ramping-vus stages. It follows the same import patterns as `benchmarks/services/runtime.ts` but replaces constant-vus with ramp-to-saturation stages.

**Scenarios:**

| Scenario       | Weight | Exec Function      | What It Tests                        |
| -------------- | ------ | ------------------ | ------------------------------------ |
| `single_turn`  | 50%    | `singleTurn`       | SSE chat POST, single user message   |
| `multi_turn`   | 25%    | `multiTurn`        | WebSocket 5-message conversation     |
| `tool_calling` | 15%    | `toolCalling`      | Agent with 3 tool call round-trips   |
| `concurrent`   | 10%    | `wsConnectionRamp` | WebSocket connection open/close ramp |

- [ ] **Step 1: Create the saturation directory**

```bash
mkdir -p benchmarks/saturation
```

- [ ] **Step 2: Write the runtime saturation script**

Create `benchmarks/saturation/runtime.ts`. Key differences from `benchmarks/services/runtime.ts`:

1. Imports `buildBlendedScenarios`, `createRampStages`, `SCENARIO_WEIGHTS` from `../lib/saturation-utils.ts`
2. Uses `buildBlendedScenarios('runtime', MAX_VUS, scenarioExecMap, DURATION_MINUTES)` to generate the `options.scenarios` object
3. `MAX_VUS` defaults to `200` (overridable via `__ENV.MAX_VUS`)
4. `DURATION_MINUTES` defaults to `20` (overridable via `__ENV.DURATION_MINUTES`)
5. Adds a `concurrent` scenario (not present in the services benchmark) that tests pure WebSocket connection throughput without message exchange
6. Uses `cloud` config block for Grafana Cloud k6 compatibility with `name: 'runtime-saturation'`
7. Thresholds use the same SLAs as `benchmarks/services/runtime.ts` for consistency
8. Setup function performs the same health check and auth flow

The four exported scenario functions (`singleTurn`, `multiTurn`, `toolCalling`, `wsConnectionRamp`) reuse the same logic as the services benchmark. The only changes are:

- Shorter sleep intervals to increase pressure during saturation ramp
- `wsConnectionRamp` is a new function that opens a WebSocket, verifies connection, then closes — measuring pure connection overhead

```typescript
/**
 * Runtime Saturation Benchmark — Ramp-to-Saturation
 *
 * Blended workload with weighted VU distribution:
 *   single_turn (50%), multi_turn (25%), tool_calling (15%), concurrent (10%)
 *
 * Ramps from 1 VU to MAX_VUS over DURATION_MINUTES to find the saturation point.
 *
 * Run:
 *   k6 run benchmarks/saturation/runtime.ts \
 *     -e RUNTIME_URL=http://runtime:3112 \
 *     -e MAX_VUS=200 \
 *     -e DURATION_MINUTES=20
 */

import http from 'k6/http';
import { check, sleep, fail } from 'k6';
import { Options } from 'k6/options';
import ws from 'k6/ws';
import { Trend, Counter, Rate } from 'k6/metrics';
import { config } from '../lib/config.ts';
import { getAuthToken, getRefreshToken, makeAuthHeaders, ensureFreshAuth } from '../lib/auth.ts';
import {
  agentTurnLatency,
  toolCallLatency,
  ttft,
  successRate,
  errorCount,
} from '../lib/metrics.ts';
import { buildBlendedScenarios, SCENARIO_WEIGHTS } from '../lib/saturation-utils.ts';

// --- env-configurable parameters ---
const MAX_VUS = parseInt(__ENV.MAX_VUS || '200', 10);
const DURATION_MINUTES = parseInt(__ENV.DURATION_MINUTES || '20', 10);

// ... (constants, custom metrics, scenario functions follow the same pattern
//      as benchmarks/services/runtime.ts — see Step 2 body below)
```

The full file should include:

1. **Constants section** — same as `benchmarks/services/runtime.ts` (`AGENT_PATH`, `MULTI_TURN_MESSAGE_COUNT`, `TOOL_CALL_COUNT`, timeouts)
2. **Custom metrics section** — same Trend/Counter/Rate declarations
3. **Options section** — uses `buildBlendedScenarios()`:

```typescript
const SCENARIO_EXEC_MAP = {
  single_turn: 'singleTurn',
  multi_turn: 'multiTurn',
  tool_calling: 'toolCalling',
  concurrent: 'wsConnectionRamp', // scenario key matches spec; exec function matches services/runtime.ts
};

export const options: Options = {
  scenarios: buildBlendedScenarios(
    'runtime',
    MAX_VUS,
    SCENARIO_EXEC_MAP,
    DURATION_MINUTES,
  ) as Options['scenarios'],
  thresholds: {
    runtime_single_turn_latency_ms: ['p(95)<2000', 'p(99)<5000'],
    runtime_multi_turn_per_message_ms: ['p(95)<3000'],
    runtime_tool_calling_total_ms: ['p(95)<10000'],
    http_req_failed: ['rate<0.05'],
    runtime_sse_success_rate: ['rate>0.95'],
    runtime_ws_timeouts: ['count<20'],
  },
  cloud: {
    projectID: __ENV.K6_CLOUD_PROJECT_ID || undefined,
    name: 'runtime-saturation',
    tags: {
      service: 'runtime',
      type: 'saturation',
      tier: __ENV.TIER || 'm',
      env: __ENV.ENV || 'staging',
    },
  },
};
```

4. **Setup function** — same as services benchmark (health check + auth)
5. **singleTurn function** — same as services benchmark, `sleep(0.3)` instead of `sleep(1)`
6. **multiTurn function** — same as services benchmark, `sleep(0.3)` between turns
7. **toolCalling function** — same as services benchmark, `sleep(0.3)` instead of `sleep(1)`
8. **wsConnectionRamp function** (NEW) — opens WebSocket, waits for `open` event, measures connect latency, sends a single ping, closes. This measures pure connection throughput without full conversation overhead:

```typescript
export function wsConnectionRamp(data: SetupData): void {
  ensureFreshAuth(data);
  const currentToken = data.token;
  const wsUrl = data.wsUrl;

  const connectStart = Date.now();
  const response = ws.connect(
    wsUrl,
    {
      headers: {
        'Sec-WebSocket-Protocol': `${WEB_DEBUG_WS_AUTH_PROTOCOL}, ${currentToken}`,
      },
    },
    function (socket) {
      socket.setTimeout(function () {
        wsTimeouts.add(1);
        socket.close();
      }, WS_CONNECT_TIMEOUT_MS);

      socket.on('open', function () {
        wsConnectLatency.add(Date.now() - connectStart);
        successRate.add(1);
        // Brief hold to simulate real connection lifecycle
        sleep(0.5);
        socket.close();
      });

      socket.on('error', function () {
        errorCount.add(1);
        successRate.add(0);
      });
    },
  );

  check(response, {
    'concurrent: WebSocket connected': (r) => r && r.status === 101,
  });

  sleep(0.2);
}
```

9. **sendNextMessage helper** — same as services benchmark

- [ ] **Step 3: Verify script syntax with k6 inspect**

```bash
cd benchmarks && npx tsc --noEmit
```

Expected: SUCCESS — TypeScript compilation passes. Full k6 validation requires `k6 inspect` but TypeScript checking catches import and type errors.

> Note: `k6 inspect benchmarks/saturation/runtime.ts` can also be used if k6 v1.6+ is installed locally. It validates the script is loadable without executing it.

- [ ] **Step 4: Format and commit**

```bash
npx prettier --write benchmarks/saturation/runtime.ts
git add benchmarks/saturation/runtime.ts
git commit -m "[ABLP-2] feat(benchmarks): add runtime saturation k6 script with blended workload"
```

---

## Task 3: Search AI Saturation Script — `benchmarks/saturation/search-ai.ts`

**Files:**

- Create: `benchmarks/saturation/search-ai.ts`

Follows the same pattern as the runtime saturation script. Uses `buildBlendedScenarios('search-ai', ...)` for weighted VU distribution.

**Scenarios:**

| Scenario        | Weight | Exec Function  | What It Tests                           |
| --------------- | ------ | -------------- | --------------------------------------- |
| `kb_operations` | 40%    | `kbOperations` | List KBs, list sources, upload document |
| `document_ops`  | 40%    | `documentOps`  | List documents, get details + chunks    |
| `crawl_submit`  | 20%    | `crawlSubmit`  | Submit web crawl job, poll status       |

- [ ] **Step 1: Write the search-ai saturation script**

Create `benchmarks/saturation/search-ai.ts`. Key structure:

1. Imports from `../lib/config.ts`, `../lib/auth.ts`, `../lib/metrics.ts`, `../lib/saturation-utils.ts`
2. `MAX_VUS` defaults to `150` (search-ai is lighter weight than runtime)
3. `DURATION_MINUTES` defaults to `20`
4. Setup function resolves `indexId` and `sourceId` from the environment or discovers them from the API (same logic as `benchmarks/services/search-ai.ts`)
5. Three exported scenario functions reuse the same API call patterns as `benchmarks/services/search-ai.ts`:
   - `kbOperations` — list KBs, list sources, upload a small document
   - `documentOps` — list documents, get document details + chunks
   - `crawlSubmit` — submit a web crawl batch job
6. Sleep intervals reduced to `sleep(0.3)` for saturation pressure
7. Uses `freshHeaders(data)` for all requests (auto-refreshing auth)
8. Uses `apiPath()` for ingress/direct mode compatibility

```typescript
const SCENARIO_EXEC_MAP = {
  kb_operations: 'kbOperations',
  document_ops: 'documentOps',
  crawl_submit: 'crawlSubmit',
};

export const options: Options = {
  scenarios: buildBlendedScenarios(
    'search-ai',
    MAX_VUS,
    SCENARIO_EXEC_MAP,
    DURATION_MINUTES,
  ) as Options['scenarios'],
  thresholds: {
    'http_req_duration{scenario:kb_operations}': ['p(95)<2000', 'p(99)<5000'],
    'http_req_duration{scenario:document_ops}': ['p(95)<2000', 'p(99)<5000'],
    'http_req_duration{scenario:crawl_submit}': ['p(95)<15000'],
    http_req_failed: ['rate<0.05'],
    abl_success_rate: ['rate>0.90'],
  },
  cloud: {
    projectID: __ENV.K6_CLOUD_PROJECT_ID || undefined,
    name: 'search-ai-saturation',
    tags: {
      service: 'search-ai',
      type: 'saturation',
      tier: __ENV.TIER || 'm',
      env: __ENV.ENV || 'staging',
    },
  },
};
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd benchmarks && npx tsc --noEmit
```

Expected: SUCCESS

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write benchmarks/saturation/search-ai.ts
git add benchmarks/saturation/search-ai.ts
git commit -m "[ABLP-2] feat(benchmarks): add search-ai saturation k6 script with blended workload"
```

---

## Task 4: BGE-M3 Saturation Script — `benchmarks/saturation/bge-m3.ts`

**Files:**

- Create: `benchmarks/saturation/bge-m3.ts`

Follows the same pattern. Uses `buildBlendedScenarios('bge-m3', ...)` for weighted VU distribution.

**Scenarios:**

| Scenario           | Weight | Exec Function     | What It Tests                         |
| ------------------ | ------ | ----------------- | ------------------------------------- |
| `single_embed`     | 30%    | `singleEmbed`     | POST /v1/embeddings with single doc   |
| `batch_embed`      | 40%    | `batchEmbed`      | POST /v1/embeddings with batch 16-128 |
| `concurrent_embed` | 30%    | `concurrentEmbed` | Batch=32 under ramping concurrency    |

- [ ] **Step 1: Write the bge-m3 saturation script**

Create `benchmarks/saturation/bge-m3.ts`. Key structure:

1. Imports from `../lib/config.ts`, `../lib/auth.ts`, `../lib/metrics.ts`, `../lib/saturation-utils.ts`
2. `MAX_VUS` defaults to `120` (embedding service is GPU-bound, saturates earlier)
3. `DURATION_MINUTES` defaults to `20`
4. Reuses the `SharedArray` sample documents pattern from `benchmarks/services/bge-m3.ts`
5. Setup verifies health and embedding dimension (same as services benchmark)
6. Three exported scenario functions reuse the same embedding logic:
   - `singleEmbed` — single document embedding, validates dimension
   - `batchEmbed` — cycles through batch sizes 16/32/64/128
   - `concurrentEmbed` — batch=32 with concurrent VUs
7. Sleep intervals reduced to `sleep(0.2)` for saturation pressure
8. BGE-M3 does not require auth headers (no JWT needed), so the setup is simpler

```typescript
const SCENARIO_EXEC_MAP = {
  single_embed: 'singleEmbed',
  batch_embed: 'batchEmbed',
  concurrent_embed: 'concurrentEmbed',
};

export const options: Options = {
  scenarios: buildBlendedScenarios(
    'bge-m3',
    MAX_VUS,
    SCENARIO_EXEC_MAP,
    DURATION_MINUTES,
  ) as Options['scenarios'],
  thresholds: {
    bge_m3_single_embed_latency_ms: ['p(95)<500', 'p(99)<1000'],
    bge_m3_batch_16_latency_ms: ['p(95)<2000'],
    bge_m3_batch_32_latency_ms: ['p(95)<4000'],
    bge_m3_batch_64_latency_ms: ['p(95)<8000'],
    bge_m3_batch_128_latency_ms: ['p(95)<16000'],
    bge_m3_per_doc_latency_ms: ['p(95)<100'],
    bge_m3_docs_per_second: ['avg>10'],
    bge_m3_dimension_correct: ['rate>0.99'],
    http_req_failed: ['rate<0.05'],
  },
  cloud: {
    projectID: __ENV.K6_CLOUD_PROJECT_ID || undefined,
    name: 'bge-m3-saturation',
    tags: {
      service: 'bge-m3',
      type: 'saturation',
      tier: __ENV.TIER || 'm',
      env: __ENV.ENV || 'staging',
    },
  },
};
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd benchmarks && npx tsc --noEmit
```

Expected: SUCCESS

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write benchmarks/saturation/bge-m3.ts
git add benchmarks/saturation/bge-m3.ts
git commit -m "[ABLP-2] feat(benchmarks): add bge-m3 saturation k6 script with blended workload"
```

---

## Task 5: Final Typecheck and Validation

**Files:** All files created in Tasks 1-4.

- [ ] **Step 1: Run full typecheck across benchmarks/**

```bash
cd benchmarks && npx tsc --noEmit
```

Expected: SUCCESS — all saturation scripts and shared utils compile without errors.

- [ ] **Step 2: Verify file structure**

```bash
ls -la benchmarks/lib/saturation-utils.ts
ls -la benchmarks/saturation/runtime.ts
ls -la benchmarks/saturation/search-ai.ts
ls -la benchmarks/saturation/bge-m3.ts
```

Expected: All four files exist.

- [ ] **Step 3: Verify script structure with grep**

Check that each saturation script exports the required functions:

```bash
grep -n "^export function" benchmarks/saturation/runtime.ts
# Expected: setup, singleTurn, multiTurn, toolCalling, wsConnectionRamp

grep -n "^export function" benchmarks/saturation/search-ai.ts
# Expected: setup, kbOperations, documentOps, crawlSubmit

grep -n "^export function" benchmarks/saturation/bge-m3.ts
# Expected: setup, singleEmbed, batchEmbed, concurrentEmbed
```

- [ ] **Step 4: Verify saturation-utils exports**

```bash
grep -n "^export" benchmarks/lib/saturation-utils.ts
# Expected: createRampStages, detectSaturation, SCENARIO_WEIGHTS, buildBlendedScenarios
# Plus type exports: RampStage, SaturationMetrics, SaturationResult, ScenarioExecMap
```

---

## Template for Remaining Services

Plan 4 (CLI Benchmark Orchestrator) will generate saturation scripts for the remaining services. Each new script follows this template pattern:

```typescript
/**
 * <ServiceName> Saturation Benchmark — Ramp-to-Saturation
 *
 * Blended workload: <list scenarios with weights>
 *
 * Run:
 *   k6 run benchmarks/saturation/<service>.ts \
 *     -e <SERVICE_URL>=<url> \
 *     -e MAX_VUS=<default> \
 *     -e DURATION_MINUTES=20
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Options } from 'k6/options';
import { Trend, Counter, Rate } from 'k6/metrics';
import { config } from '../lib/config.ts';
import {
  getAuthToken,
  getRefreshToken,
  makeAuthHeaders,
  ensureFreshAuth,
  freshHeaders,
} from '../lib/auth.ts';
import { successRate, errorCount } from '../lib/metrics.ts';
import { buildBlendedScenarios } from '../lib/saturation-utils.ts';

// --- Env-configurable parameters ---
const MAX_VUS = parseInt(__ENV.MAX_VUS || '<default>', 10);
const DURATION_MINUTES = parseInt(__ENV.DURATION_MINUTES || '20', 10);

// --- Custom metrics ---
// Declare service-specific Trend/Counter/Rate metrics here

// --- Scenario exec map ---
const SCENARIO_EXEC_MAP: Record<string, string> = {
  // scenario_name: 'exportedFunctionName',
};

// --- Options ---
export const options: Options = {
  scenarios: buildBlendedScenarios(
    '<service>',
    MAX_VUS,
    SCENARIO_EXEC_MAP,
    DURATION_MINUTES,
  ) as Options['scenarios'],
  thresholds: {
    // Service-specific thresholds
    http_req_failed: ['rate<0.05'],
  },
  cloud: {
    projectID: __ENV.K6_CLOUD_PROJECT_ID || undefined,
    name: '<service>-saturation',
    tags: {
      service: '<service>',
      type: 'saturation',
      tier: __ENV.TIER || 'm',
      env: __ENV.ENV || 'staging',
    },
  },
};

// --- Setup ---
interface SetupData {
  token: string;
  refreshToken: string;
  headers: Record<string, string>;
  // ... service-specific setup fields
}

export function setup(): SetupData {
  const token = getAuthToken();
  const refreshToken = getRefreshToken();
  const headers = makeAuthHeaders(token, refreshToken);
  // Health check, discover resources, etc.
  return { token, refreshToken, headers /* ... */ };
}

// --- Scenario functions ---
// export function scenarioName(data: SetupData): void { ... }
// Each function calls ensureFreshAuth(data), makes HTTP requests,
// records metrics, uses sleep(0.2-0.5) for saturation pressure.
```

**Default MAX_VUS by service category:**

| Category     | Services                                              | Default MAX_VUS | Rationale                            |
| ------------ | ----------------------------------------------------- | --------------- | ------------------------------------ |
| App services | runtime, search-ai, search-ai-runtime, studio         | 150-200         | HTTP services with moderate compute  |
| Compute      | bge-m3, docling, preprocessing                        | 80-120          | GPU/CPU-bound, saturate earlier      |
| Data stores  | mongodb, redis, clickhouse, opensearch, qdrant, neo4j | 200-300         | Connection-oriented, higher capacity |
| Infra        | restate, workflow-engine, crawler                     | 100-150         | Depends on workload type             |

---

## Plan 4 Integration Points

**JSON summary output:** k6 produces JSON summary data that the CLI orchestrator (Plan 4) consumes to determine per-pod capacity ceilings. There are two mechanisms:

1. **`--summary-export` flag** — Plan 4 spawns k6 with `--summary-export /tmp/k6-saturation-<service>-<timestamp>.json`, which writes the end-of-test summary as a JSON file. This is the primary integration path.
2. **`handleSummary()` export** — Each saturation script can optionally export a `handleSummary(data)` function that returns `{ '/tmp/k6-saturation-<service>-<timestamp>.json': JSON.stringify(data) }`. This provides an in-script fallback if the CLI flag is not passed.

**Output path convention:** `/tmp/k6-saturation-<service>-<timestamp>.json` where `<service>` matches the service key (e.g., `runtime`, `search-ai`, `bge-m3`) and `<timestamp>` is ISO 8601 compact format (e.g., `20260325T143000Z`). Plan 4 discovers these files by glob pattern when collecting results.

---

## Exit Criteria

All of the following must be true before this plan is considered complete:

1. `benchmarks/lib/saturation-utils.ts` exists and exports `createRampStages`, `detectSaturation`, `SCENARIO_WEIGHTS`, `buildBlendedScenarios`
2. `benchmarks/saturation/runtime.ts` exists with 4 exported scenario functions + setup
3. `benchmarks/saturation/search-ai.ts` exists with 3 exported scenario functions + setup
4. `benchmarks/saturation/bge-m3.ts` exists with 3 exported scenario functions + setup
5. `cd benchmarks && npx tsc --noEmit` passes with zero errors
6. All files are formatted with prettier
7. Each task has its own commit with `[ABLP-2]` prefix

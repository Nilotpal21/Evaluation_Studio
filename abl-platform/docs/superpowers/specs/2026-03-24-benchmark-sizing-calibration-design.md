# Benchmark → Sizing Calculator Calibration Pipeline

**Date:** 2026-03-24
**Status:** Draft
**Driver:** Replace hardcoded sizing assumptions with measured per-pod capacity from k6 benchmarks + Coroot observability

---

## Table of Contents

1. [Problem](#1-problem)
2. [Solution Overview](#2-solution-overview)
3. [Architecture](#3-architecture)
4. [Data Model — CalibrationProfile](#4-data-model--calibrationprofile)
5. [Traffic Model](#5-traffic-model)
6. [Bootstrap Setup — Pre-Benchmark Environment](#6-bootstrap-setup--pre-benchmark-environment)
7. [k6 Execution Modes — Cloud vs Local](#7-k6-execution-modes--cloud-vs-local)
8. [Benchmark Orchestration Flow](#8-benchmark-orchestration-flow)
9. [Coroot Metrics Collection](#9-coroot-metrics-collection)
10. [Sizing Calculator Changes](#10-sizing-calculator-changes)
11. [CLI Commands](#11-cli-commands)
12. [Report Generation](#12-report-generation)
13. [Service Configuration](#13-service-configuration)
14. [New Files and Package Changes](#14-new-files-and-package-changes)
15. [Prerequisites and Configuration](#15-prerequisites-and-configuration)
16. [Usage Guide](#16-usage-guide)
17. [Design Decisions](#17-design-decisions)

---

## 1. Problem

The sizing calculator (`packages/sizing-calculator/`) produces Kubernetes cluster topologies and Helm values for production deployments. Today, all per-service resource specs (CPU, memory, replicas) are **hardcoded constants** derived from design-doc estimates:

```typescript
// constants.ts — guesses, not measurements
runtime: {
  M: { cpu: '2', memory: '4Gi', replicas: 3, maxReplicas: 6, nodePool: 'general' },
}
```

And `service-sizer.ts` uses hardcoded thresholds to decide when to scale:

```typescript
// "runtime can handle 5000 concurrent conversations at tier M" — unvalidated
const thresholds: Record<Tier, number> = { S: 500, M: 5000, L: 100000, XL: 500000 };
```

Nobody has validated whether 3 runtime pods with 2 CPU can actually handle 5,000 concurrent conversations. The k6 benchmark suite (`benchmarks/`) exists and runs against real services, but its results are never fed back into the sizing calculator.

**This is what the saturation test solves.** By ramping load against a single pod until it saturates, we measure the actual per-pod capacity ceiling — the maximum RPS one pod can handle before errors spike, latency degrades, or CPU exhausts. That measured ceiling directly determines how many pods are needed for any given traffic level:

```
Example: Saturation test finds 1 runtime pod (2 CPU, 4Gi) handles 180 RPS before degradation.
Customer needs 500 concurrent conversations → 500 RPS required.
Replicas needed = ceil(500 / 180 × 1.2) = 4 pods (not the hardcoded 3).
```

Without saturation testing, the sizing calculator outputs unvalidated guesses. With it, every replica count and resource spec is backed by a measurement from the actual platform under real load.

The load testing design doc (`docs/superpowers/specs/2026-03-17-abl-load-testing-design.md`) describes this feedback loop as a Phase 4 / Week 11 deliverable:

- Week 5: "Per-service throughput ceiling table (feeds the sizing calculator)"
- Week 11: "Export per-service throughput ceilings from Prometheus into `kore-platform-cli sizing calculate` input format. Replace assumed values with measured values."
- Customer runbook: "Feed benchmark results into sizing calculator → topology recommendation + Helm values generated in one flow"

This design implements that feedback loop.

---

## 2. Solution Overview

**The core idea: saturation testing determines pods required to handle the traffic.**

Scale each service down to 1 pod and ramp load until the pod saturates (errors spike, latency degrades, or CPU exhausts). The RPS at saturation is the per-pod capacity ceiling. Given a customer's expected traffic, the number of pods follows directly:

```
replicas needed = expected workload RPS / measured max RPS per pod × (1 + headroom)
```

This replaces every hardcoded replica count and resource spec in the sizing calculator with values backed by real measurements. The saturation test answers the fundamental question: "how many pods of each service do we actually need for this workload?"

The pipeline:

```
┌──────────────────┐    questionnaire     ┌──────────────────┐    helm values    ┌─────────────┐
│   Sizing         │ ───────────────────► │ Cluster Topology │ ────────────────► │  Provision   │
│  Calculator      │                      │ + Helm Values    │                   │  K8s Cluster │
└───────▲──────────┘                      └──────────────────┘                   └──────┬───────┘
        │                                                                               │
        │ calibrate with                                                                │ deploy
        │ measured values                                                               ▼
┌───────┴──────────┐                                                           ┌────────────────┐
│  Calibration     │◄──── combine ────┐                                        │ k6 Saturation  │
│  Profile (JSON)  │                  │                                        │ Benchmarks     │
└──────────────────┘    ┌─────────────┴───────────┐                            └───┬────────┬───┘
                        │                         │                                │        │
                  ┌─────┴──────┐          ┌───────┴────────┐                      │        │
                  │ k6 Results │          │ Coroot Metrics  │                      │        │
                  │ (RPS,      │          │ (CPU, memory,   │◄─────────────────────┘        │
                  │ latency,   │          │ connections,    │  eBPF auto-collects           │
                  │ errors)    │          │ disk, per-pod)  │  during load test             │
                  └────────────┘          └────────────────┘                                │
                        ▲                                                                   │
                        └───────────────────────────────────────────────────────────────────┘
                                  k6 exports JSON summaries
```

---

## 3. Architecture

**CLI-orchestrated pipeline.** The `kore-platform-cli sizing` command family gains new subcommands that orchestrate the full flow: scale-down → run k6 → query Coroot MCP → combine → calibrate → report → restore replicas.

**Key architectural decisions:**

- Each step is a discrete CLI command — can re-run or skip steps
- CalibrationProfile is a portable JSON file, versionable in git
- Sizing calculator accepts calibration as an optional parameter — backward compatible
- Service URLs resolved from existing `benchmarks/config/cloud.env` + `benchmarks/lib/config.ts`
- Coroot metrics collected via MCP tools (no Prometheus required; future `--prometheus-url` flag)

---

## 4. Data Model — CalibrationProfile

The central artifact that flows between benchmark collection and the sizing calculator.

```typescript
interface CalibrationProfile {
  version: '1.0';
  tier: Tier; // Tier the benchmark was run at (S/M/L/XL)
  timestamp: string; // ISO 8601
  environment: string; // e.g., "staging-eks", "customer-aks"

  services: Record<string, ServiceCapacity>;
  dataStores: Record<string, DataStoreCapacity>;
}

interface ServiceCapacity {
  // What was provisioned for 1 pod during the test
  provisioned: { cpu: string; memory: string };

  // Blended saturation point (weighted mix of all scenarios)
  // This is what the sizing calculator uses for replica computation.
  // Multi-signal: error rate > 1% OR p95 > 2x baseline OR CPU > 85% OR connections exhausted
  saturation: {
    trigger: 'error-rate' | 'latency' | 'cpu' | 'connections'; // which signal fired first
    maxRpsPerPod: number; // requests/sec at saturation (blended workload)
    maxConcurrentPerPod: number; // concurrent connections at saturation
  };

  // WebSocket connection capacity (services that use long-lived WS connections)
  // Only populated for services with WebSocket endpoints (runtime, etc.)
  // Null for HTTP-only services.
  websocket: WebSocketCapacity | null;

  // Per-scenario breakdown — individual saturation ceilings
  // Used in reports to identify bottleneck scenarios.
  // The sizing calculator uses the blended `saturation.maxRpsPerPod` above.
  scenarios: Record<string, ScenarioCapacity>;

  // Coroot-measured resource usage at saturation
  measured: {
    cpuPeak: string; // e.g., "1.82" (cores)
    cpuAvg: string;
    memoryPeak: string; // e.g., "3.2Gi"
    memoryAvg: string;
    podRestarts: number;
    oomKills: number;
  };

  // k6 latency at saturation (blended across all scenarios)
  latency: {
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    minMs: number;
    maxMs: number;
    baselineP95Ms: number; // p95 at low load (first 10% of ramp)
  };

  // URL and access info
  testedUrl: string; // actual URL used during the test
  testedViaIngress: boolean; // true if URL came from cloud.env INGRESS_BASE
}

/**
 * WebSocket connection capacity for services with long-lived connections.
 *
 * HTTP RPS measures throughput (requests completed per second).
 * WebSocket connections measure capacity (how many long-lived connections
 * one pod can hold simultaneously). Both dimensions matter for sizing:
 *
 *   - RPS determines replicas for request throughput
 *   - Max connections determines replicas for concurrent users
 *   - The HIGHER replica count wins (whichever is the bottleneck)
 *
 * The runtime has 5 WebSocket server instances with per-pod limits:
 *   /ws             — Internal/Studio debug (default 10,000)
 *   /ws/sdk         — Embedded SDK widget   (default 50,000, MAX_SDK_CLIENTS)
 *   /voice/media    — Twilio audio streams  (default 10,000, MAX_MEDIA_SESSIONS)
 *   /ws/audiocodes  — AudioCodes voice      (default 10,000)
 *   /ws/korevg      — KorevG voice          (default 500, MAX_KOREVG_SESSIONS)
 *
 * Config-level WS_MAX_CONNECTIONS defaults to 1,000.
 */
interface WebSocketCapacity {
  // Per-endpoint connection saturation results
  endpoints: Record<string, WebSocketEndpointCapacity>;

  // Aggregate: total concurrent WS connections pod held before degradation
  maxTotalConnectionsPerPod: number;

  // Connection lifecycle metrics
  connectLatency: {
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    minMs: number;
    maxMs: number;
  };

  // Connection stability under load
  connectionErrors: number; // upgrade failures (non-101 responses)
  connectionTimeouts: number; // connections that timed out during test
  unexpectedDisconnects: number; // server-initiated closes under load
  heartbeatFailures: number; // missed pong responses (30s heartbeat interval)

  // Memory per connection (from Coroot: total memory / active connections)
  estimatedMemoryPerConnection: string; // e.g., "2.5MB"
}

interface WebSocketEndpointCapacity {
  path: string; // e.g., "/ws", "/ws/sdk"
  configuredMax: number; // WS_MAX_CONNECTIONS or hardcoded limit for this endpoint
  measuredMax: number; // actual connections held before failures
  saturationSignal: string; // what failed: "upgrade_refused", "timeout", "oom", "cpu"

  // Per-message latency within active connections
  messageLatency: {
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  };
}

interface ScenarioCapacity {
  name: string; // e.g., "single_turn", "multi_turn", "tool_calling"
  weight: number; // traffic weight in blended test (e.g., 0.50 = 50% of traffic)
  maxRpsPerPod: number; // per-scenario saturation ceiling (HTTP scenarios)
  maxConcurrentConnections?: number; // per-scenario connection ceiling (WS scenarios)
  trigger: 'error-rate' | 'latency' | 'cpu' | 'connections'; // which signal fired first
  latency: {
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    minMs: number;
    maxMs: number;
    baselineP95Ms: number;
  };
}

interface DataStoreCapacity {
  provisioned: { cpu: string; memory: string; storage: string };

  latency: {
    queryP50Ms: number;
    queryP95Ms: number;
    queryP99Ms: number;
    queryMinMs: number;
    queryMaxMs: number;
    writeP50Ms: number;
    writeP95Ms: number;
    writeP99Ms: number;
    writeMinMs: number;
    writeMaxMs: number;
  };

  connections: {
    used: number;
    max: number;
    utilizationPercent: number;
  };

  resources: {
    cpuPeak: string;
    cpuAvg: string;
    memoryPeak: string;
    memoryAvg: string;
    diskUsageGB: number;
    diskGrowthRateGBPerDay: number;
  };

  // Store-specific metrics (varies by type)
  // MongoDB: { wiredTigerCacheHitRatio, replicationLagMs, globalLockQueue, slowQueryCount, ... }
  // Redis: { keyspaceHitRatio, blockedClients, fragmentationRatio, evictionRate, ... }
  // ClickHouse: { activePartsCount, rejectedInserts, mergeRate, concurrentQueries, ... }
  // OpenSearch: { jvmHeapPercent, gcPauseDurationMs, circuitBreakerTrips, threadPoolRejections, ... }
  // Qdrant: { vectorCount, walSize, optimizerStatus, segmentCount, ... }
  // Neo4j: { pageCacheHitRatio, activeTxCount, boltConnections, gcPauseTimeMs, ... }
  storeSpecific: Record<string, number | string | boolean | null>;

  dataSource: 'coroot-native' | 'coroot-tcp' | 'prometheus' | 'unavailable';
}
```

---

## 5. Traffic Model

The sizing calculator converts questionnaire workload inputs to expected peak RPS per service. Real traffic is bursty, not uniform — sizing must target the peak window.

### Standard Enterprise Traffic Distribution

```
8-hour business day:
├── Peak window:   2 hours → 40% of daily traffic (20% per hour)
├── Normal window: 6 hours → 60% of daily traffic (10% per hour)
└── Off-hours:    16 hours → ~0% (maintenance, batch jobs only)

Peak-to-average ratio: 20% / 12.5% = 1.6x
```

This is hardcoded as the standard enterprise default (not exposed in the questionnaire):

```typescript
const ENTERPRISE_TRAFFIC = {
  businessDayHours: 8,
  peakWindowHours: 2,
  peakTrafficPercent: 0.4,
  normalWindowHours: 6,
  normalTrafficPercent: 0.6,
} as const;

function peakRps(dailyVolume: number): number {
  const peakHourVolume =
    (dailyVolume * ENTERPRISE_TRAFFIC.peakTrafficPercent) / ENTERPRISE_TRAFFIC.peakWindowHours;
  return peakHourVolume / 3600;
}
```

### RPS Priority — Concurrent Fields Win

When the questionnaire provides both concurrent and daily volume fields, **concurrent values take priority** — they represent the user's known peak load. Daily volumes are converted to peak RPS via the traffic model only as a fallback.

```typescript
function expectedRps(service: string, q: Questionnaire): number {
  switch (service) {
    case 'runtime': {
      // Concurrent conversations = direct peak signal (takes priority)
      if (q.agents.concurrentConversations > 0) {
        return q.agents.concurrentConversations;
      }
      // Fallback: derive from daily messages via traffic model
      return peakRps(q.agents.messagesPerDay) * q.agents.toolCallsPerConversation;
    }
    case 'search-ai-runtime': {
      return peakRps(q.knowledgeBase.vectorSearchQueriesPerDay);
    }
    case 'search-ai': {
      if (q.knowledgeBase.ingestionFrequency === 'real-time') {
        return peakRps(q.knowledgeBase.totalDocuments);
      }
      // Batch ingestion: spread over off-peak 16h window
      return q.knowledgeBase.totalDocuments / (16 * 3600);
    }
    case 'bge-m3': {
      return (
        expectedRps('search-ai', q) * 10 + // ~10 chunks per doc
        expectedRps('search-ai-runtime', q)
      );
    }
    case 'workflow-engine': {
      // No concurrentExecutions field in schema — derive from daily volume
      return peakRps(q.workflows.executionsPerDay) * q.workflows.avgStepsPerWorkflow;
    }
    // ... other services
  }
}
```

### Sizing Formula

```
replicas = max(
  MIN_REPLICAS[tier],                                    // never below tier minimum for HA
  ceil(expectedRps / calibration.maxRpsPerPod × 1.2)     // 20% headroom
)
```

---

## 6. Bootstrap Setup — Pre-Benchmark Environment

Before running any benchmark (saturation or regular load tests), the benchmark environment must be bootstrapped. The bootstrap creates all required entities (tenant, project, agents, KB, mock LLM) on the target cluster.

### Bootstrap Orchestrator

The bootstrap runs as a single k6 script with 1 VU and 1 iteration (`benchmarks/setup/bootstrap.ts`):

```
k6 run benchmarks/setup/bootstrap.ts
│
├── Step 1: Bootstrap Tenant
│   ├── Authenticate (AUTH_TOKEN → refresh → dev-login fallback)
│   ├── Reuse existing project (PROJECT_ID from cloud.env)
│   └── Or create new "benchmark-project"
│
├── Step 2: Bootstrap Agent
│   ├── Create "benchmark_agent" with DSL via Studio API
│   ├── Handle 409 conflicts (agent exists in another project)
│   └── Save DSL content via PUT /api/agents/:name/content
│
├── Step 2b: Bootstrap Multi-Agent
│   ├── Create supervisor agent
│   └── Create child agents for multi-agent orchestration scenarios
│
├── Step 2c: Bootstrap Mock LLM (only if MOCK_LLM=true)
│   ├── Create TenantModel with provider "mock"
│   ├── Create credential + link to TenantModel
│   └── Configure each benchmark agent → mock-model
│
├── Step 3: Bootstrap Knowledge Base
│   ├── Create KB via SearchAI API
│   ├── Upload 3 sample documents (small/medium/large)
│   └── Trigger ingestion job + poll for completion
│
├── Step 4: Verify Indexes
│   └── Check OpenSearch + Qdrant indexes exist
│
└── Step 5: Seed Conversations
    └── Create pre-seeded conversations for multi-turn benchmarks
```

### Prerequisites

| Prerequisite           | Source                                      | Notes                                                 |
| ---------------------- | ------------------------------------------- | ----------------------------------------------------- |
| k6 installed           | `brew install k6` or [k6.io](https://k6.io) | v1.6+ required for native TypeScript                  |
| `cloud.env` configured | `benchmarks/config/cloud.env`               | Copy from `cloud.env.example`                         |
| AUTH_TOKEN (JWT)       | Studio UI → DevTools → Network              | 15-min TTL; REFRESH_TOKEN enables auto-refresh        |
| TENANT_ID + PROJECT_ID | Studio UI or created by bootstrap           | Bootstrap reuses if set, creates if not               |
| Service URLs           | cloud.env overrides or config.ts defaults   | Public ingress or private localhost                   |
| MOCK_LLM=true          | cloud.env                                   | Requires `ENABLE_MOCK_LLM=true` on Runtime deployment |

### cloud.env Configuration

The `benchmarks/config/cloud.env` file is the single source for all benchmark configuration:

```bash
# Grafana k6 Cloud (required for cloud execution mode)
K6_CLOUD_TOKEN=<your-api-token>
K6_CLOUD_PROJECT_ID=<your-project-id>

# Target environment
STAGING_URL=https://agents-staging.kore.ai/
INGRESS_BASE=https://agents-staging.kore.ai/
STUDIO_URL=https://agents-staging.kore.ai/
RUNTIME_URL=https://agents-staging.kore.ai/api
SEARCH_AI_URL=https://agents-staging.kore.ai/api/search-ai
SEARCH_AI_RUNTIME_URL=https://agents-staging.kore.ai/api/search-ai-runtime

# Auth
AUTH_TOKEN=<jwt-access-token>
REFRESH_TOKEN=<refresh-token>

# Tenant/Project
TENANT_ID=<tenant-uuid>
PROJECT_ID=<project-uuid>

# Benchmark options
TIER=s                          # s, m, l, xl
MOCK_LLM=true                   # Use mock LLM (no real API calls)
LOAD_TEST_KEY=benchmark-bypass  # Rate limit bypass (non-production)
HEALTH_CHECK=false              # Skip health checks
```

### Authentication Flow

The auth system (`benchmarks/lib/auth.ts`) handles long-running test suites where JWT tokens expire:

```
Priority: AUTH_TOKEN env → refresh token → dev-login fallback

1. AUTH_TOKEN provided and valid?  → use it
2. AUTH_TOKEN expired + REFRESH_TOKEN? → POST /api/auth/refresh (3 retries with backoff)
3. Refresh token rotated in Set-Cookie header → capture new refresh token
4. All refresh attempts fail? → fall back to dev-login endpoint
5. ensureFreshAuth() called per-request in VU code → proactive refresh before expiry
```

Token refresh is built into every scenario function via `ensureFreshAuth(data)` / `freshHeaders(data)`, supporting test suites that run for hours.

### Running Bootstrap

**Local execution (recommended for bootstrap):**

```bash
# Source env vars and run
cd benchmarks
source ../benchmarks/config/cloud.env  # or: set -a; source config/cloud.env; set +a
k6 run setup/bootstrap.ts
```

**Via cloud-run.sh (runs locally when extra args provided):**

```bash
./benchmarks/scripts/cloud-run.sh benchmarks/setup/bootstrap.ts --vus 1 --iterations 1
```

**Via Grafana Cloud k6:**

```bash
# Bootstrap always runs with --vus 1 --iterations 1 (set in script options)
# Cloud execution is mainly useful for audit trail on k6 Cloud dashboard
K6_CLOUD_TOKEN=<token> k6 cloud run benchmarks/setup/bootstrap.ts
```

### Idempotency

All bootstrap modules are idempotent — safe to re-run:

- **Tenant/Project**: Reuses existing if TENANT_ID/PROJECT_ID are set
- **Agent**: Checks for existing agent by name; handles 409 conflicts
- **Mock Model**: Lists existing TenantModels; reuses if mock-model exists
- **KB**: Checks for existing KB; reuses if found
- **Credentials**: Handles 409 (already exists) by looking up existing credential

### Bootstrap for Saturation Benchmarks

The saturation benchmark pipeline requires the same bootstrap, plus additional saturation-specific validation:

```bash
# 1. Run standard bootstrap
k6 run benchmarks/setup/bootstrap.ts

# 2. Verify bootstrap results before saturation tests
#    (saturation scripts validate in their setup() function)
#    - Agent exists and responds
#    - KB exists with indexed documents
#    - Mock LLM configured (if MOCK_LLM=true)
```

The saturation k6 scripts (`benchmarks/saturation/*.ts`) include their own `setup()` function that validates the bootstrap state before starting the ramp. If validation fails, the script exits early with a clear error.

---

## 7. k6 Execution Modes — Cloud vs Local

The benchmark suite supports two execution modes. Both modes use the same k6 scripts — the scripts contain `cloud` options blocks for k6 Cloud integration.

### Mode Comparison

| Aspect                  | Local (`k6 run`)                         | Grafana Cloud (`k6 cloud run`)                      |
| ----------------------- | ---------------------------------------- | --------------------------------------------------- |
| **Load generated from** | Developer machine / CI runner            | Grafana Cloud load zones (global)                   |
| **Dashboard**           | Terminal output + JSON export            | Real-time k6 Cloud dashboard                        |
| **Results storage**     | Local files (`/tmp/k6-suite-*/*.json`)   | k6 Cloud (persistent, shareable)                    |
| **Public services**     | Via INGRESS_BASE URLs                    | Via INGRESS_BASE URLs                               |
| **Private services**    | Via localhost / port-forward             | Requires Private Load Zones (PLZ)                   |
| **Cost**                | Free                                     | k6 Cloud subscription                               |
| **Best for**            | Development, debugging, private services | Production benchmarks, team dashboards, audit trail |
| **Bootstrap**           | Always local (1 VU, 1 iteration)         | Can run on cloud but local recommended              |
| **Saturation tests**    | Full control over scale-down/restore     | Need kubectl access from load zone                  |

### Local Execution

**Single script:**

```bash
cd benchmarks
source config/cloud.env
k6 run services/runtime.ts
```

**Full suite (per-service + integration):**

```bash
TIER=s ./benchmarks/scripts/local-run-suite.sh
```

The `local-run-suite.sh` script:

- Sources `cloud.env` automatically
- Refreshes AUTH_TOKEN between test runs (handles 15-min JWT expiry)
- Exports JSON summaries to `/tmp/k6-suite-<tier>-<timestamp>/`
- Runs per-service scripts first, then integration E2Es
- Prints latency summary from JSON exports

**Output location:**

```
/tmp/k6-suite-s-20260324-143000/
├── svc-runtime.json          # k6 summary export
├── svc-runtime.log           # k6 stdout/stderr
├── svc-studio.json
├── svc-studio.log
├── int-agent-conversation-e2e.json
├── int-agent-conversation-e2e.log
└── ...
```

### Grafana Cloud k6 Execution

**Single script:**

```bash
./benchmarks/scripts/cloud-run.sh benchmarks/services/runtime.ts
```

**Full suite:**

```bash
./benchmarks/scripts/cloud-run-suite.sh
# or with tier override:
TIER=l ./benchmarks/scripts/cloud-run-suite.sh
```

The `cloud-run.sh` script:

- Sources `cloud.env` and exports all vars as shell env vars (k6 1.6.1 bug workaround for `__ENV` at module init)
- Validates `K6_CLOUD_TOKEN`, `K6_CLOUD_PROJECT_ID`, `STAGING_URL`
- Runs `k6 cloud run <script>` which uploads and executes on Grafana Cloud
- Falls back to `k6 run` when extra args are provided (e.g., `--vus 1 --iterations 1`)

The `cloud-run-suite.sh` script:

- Runs public ingress scripts on cloud
- **Skips private services** (bge-m3, mongodb, opensearch, etc.) — these require Private Load Zones
- Refreshes AUTH_TOKEN between runs
- Outputs k6 Cloud dashboard link at the end

**k6 Cloud options in scripts:**

Each benchmark script includes cloud configuration for automatic project association:

```typescript
export const options: Options = {
  // ... scenarios, thresholds ...
  cloud: {
    projectID: __ENV.K6_CLOUD_PROJECT_ID || undefined,
  },
};
```

### Public vs Private Service Access

```
┌─────────────────────────────────────────────────────────────────┐
│ Grafana Cloud Load Zones                                       │
│   ├── Public services: runtime, studio, search-ai (via INGRESS)│
│   └── Private services: SKIPPED (need Private Load Zones)      │
└───────────────────┬─────────────────────────────────────────────┘
                    │ HTTPS
                    ▼
┌─────────────────────────────────────────────────────────────────┐
│ K8s Cluster Ingress (INGRESS_BASE)                             │
│   ├── /api/runtime → runtime service                           │
│   ├── /api/search-ai → search-ai service                      │
│   └── / → studio service                                       │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Local / CI Runner (kubectl port-forward or direct access)      │
│   ├── Public services: via INGRESS or localhost                 │
│   ├── Private services: bge-m3 :8000, docling :8080, etc.     │
│   └── Data stores: mongodb :27017, redis :6379, etc.           │
└─────────────────────────────────────────────────────────────────┘
```

| Category        | Services                                                                      | Cloud Access            | Local Access             |
| --------------- | ----------------------------------------------------------------------------- | ----------------------- | ------------------------ |
| **Public**      | runtime, studio, admin                                                        | INGRESS_BASE URLs       | INGRESS or localhost     |
| **Private App** | search-ai, search-ai-runtime, bge-m3, docling, preprocessing, workflow-engine | Private Load Zones only | localhost / port-forward |
| **Data Stores** | mongodb, redis, clickhouse, opensearch, qdrant, neo4j, restate                | Private Load Zones only | localhost / port-forward |

### Saturation Benchmarks — Execution Mode

Saturation benchmarks have additional requirements beyond regular load tests:

| Requirement                    | Local                      | Cloud                                   |
| ------------------------------ | -------------------------- | --------------------------------------- |
| Scale-down target to 1 replica | kubectl from local machine | kubectl from PLZ or pre-scaled manually |
| Restore replicas after test    | kubectl from local machine | kubectl from PLZ or manual              |
| Coroot MCP queries             | MCP tools run locally      | MCP tools run locally (post-test)       |
| k6 JSON summary export         | Direct file access         | Download via k6 Cloud API               |

**Recommended approach for saturation benchmarks:**

```bash
# 1. Bootstrap (always local)
k6 run benchmarks/setup/bootstrap.ts

# 2. Saturation tests — LOCAL recommended (needs kubectl + Coroot MCP)
#    The CLI orchestrator handles scale-down → k6 run → Coroot query → restore
pnpm cli sizing benchmark --tier M --output-calibration calibration.json

# 3. Alternatively, run saturation k6 scripts on cloud (manual scale-down)
#    a. Scale down manually: kubectl scale deployment/runtime --replicas=1
#    b. Run on cloud: ./benchmarks/scripts/cloud-run.sh benchmarks/saturation/runtime.ts
#    c. Restore manually: kubectl scale deployment/runtime --replicas=3
#    d. Coroot collection still runs locally via MCP
```

**For the full CLI-orchestrated pipeline (Section 11), local execution is the default.** The orchestrator calls `k6 run` directly. A future `--cloud` flag will add `k6 cloud run` support with automatic result download via the k6 Cloud API.

### k6 Cloud Results

The `benchmarks/scripts/cloud-results.sh` script fetches and displays results from k6 Cloud:

```bash
# Latest 10 runs (full report)
./benchmarks/scripts/cloud-results.sh

# Specific run
./benchmarks/scripts/cloud-results.sh --run-id 12345

# Last N runs
./benchmarks/scripts/cloud-results.sh --last 5
```

Results include latency percentiles, error rates, threshold pass/fail status, and links to the k6 Cloud dashboard.

### Workflow Summary

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Configure: benchmarks/config/cloud.env                      │
│    - Service URLs, auth tokens, tier, mock LLM flag            │
│    - K6_CLOUD_TOKEN + K6_CLOUD_PROJECT_ID (for cloud mode)     │
├─────────────────────────────────────────────────────────────────┤
│ 2. Bootstrap: k6 run benchmarks/setup/bootstrap.ts             │
│    - Creates tenant, project, agents, KB, mock LLM, seeds      │
│    - Always local, idempotent, 1 VU / 1 iteration              │
├─────────────────────────────────────────────────────────────────┤
│ 3a. Regular Load Tests (cloud):                                │
│     ./benchmarks/scripts/cloud-run-suite.sh                    │
│     → Results on k6 Cloud dashboard                            │
│                                                                │
│ 3b. Regular Load Tests (local):                                │
│     TIER=m ./benchmarks/scripts/local-run-suite.sh             │
│     → Results in /tmp/k6-suite-*/ JSON files                   │
│                                                                │
│ 3c. Saturation Benchmarks (local, CLI-orchestrated):           │
│     pnpm cli sizing benchmark --tier M            │
│     → scale-down → k6 run → Coroot → restore → calibrate      │
├─────────────────────────────────────────────────────────────────┤
│ 4. Results:                                                    │
│    - Cloud: https://app.k6.io/projects/<id>                    │
│    - Local: /tmp/k6-suite-<tier>-<timestamp>/                  │
│    - Calibration: calibration.json (for sizing calculator)     │
│    - Reports: markdown + PDF                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 8. Benchmark Orchestration Flow

### Scenario Strategy — Which Scenarios Are Tested?

Each service benchmark has multiple scenarios that exercise different operations. For example:

| Service               | Scenarios                                                            | What Each Tests                                                            |
| --------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **runtime**           | `single_turn`, `multi_turn`, `tool_calling`, `concurrent`            | SSE chat, WebSocket 5-msg conversation, 3 tool round-trips, ramp 1→100 VUs |
| **search-ai-runtime** | `doc_listing`, `chunk_reads`, `kb_reads`, `concurrent`               | Document listing, chunk retrieval, KB reads, ramping concurrency           |
| **opensearch**        | `documentIndex`, `vectorSearchK5`, `vectorSearchK50`, `hybridSearch` | Indexing, vector search at different k values, hybrid search under ramp    |
| **mongodb**           | `conversationCrud`, `messageInserts`, `aggregationQueries`           | CRUD operations, bulk inserts, aggregation pipeline under ramp             |
| **bge-m3**            | `single_embed`, `batch_embed`, `concurrent_embed`                    | Single embedding, batch embedding, concurrent ramp                         |

The saturation test runs **all scenarios in a blended workload** with configurable traffic weights. This reflects real production traffic where multiple operation types hit the service simultaneously.

#### Blended Workload (Default — Used for Sizing)

All scenarios run concurrently with weighted traffic distribution. The blended `maxRpsPerPod` is what the sizing calculator uses for replica computation.

```typescript
// Default scenario weights (configurable via saturation script)
// Applies to BOTH per-service and integration saturation tests.
const SCENARIO_WEIGHTS: Record<string, Record<string, number>> = {
  // ── Per-Service Benchmarks ──────────────────────────────────────────
  runtime: {
    single_turn: 0.5, // 50% — most common operation
    multi_turn: 0.25, // 25% — significant but less frequent
    tool_calling: 0.15, // 15% — agents with tools
    concurrent: 0.1, // 10% — burst/ramp behavior
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
  'bge-m3': {
    single_embed: 0.3,
    batch_embed: 0.4,
    concurrent_embed: 0.3,
  },
  studio: {
    page_load: 0.4,
    api_crud: 0.35,
    concurrent_developers: 0.25,
  },
  'search-ai': {
    kb_operations: 0.4,
    document_ops: 0.4,
    crawl_submit: 0.2,
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

  // ── Integration E2E Benchmarks ──────────────────────────────────────
  'agent-conversation-e2e': {
    single_turn: 0.4, // SSE single message
    multi_turn_conversation: 0.35, // multi-message conversation
    concurrent_conversations: 0.25, // ramping concurrent users
  },
  'multi-agent-orchestration': {
    single_delegation: 0.3, // SSE: one child agent
    multi_delegation: 0.25, // SSE: multiple child agents
    ws_multi_turn: 0.25, // WebSocket: 10-turn conversation
    concurrent: 0.2, // SSE: concurrent supervisor requests
  },
  'kb-ingestion-e2e': {
    single_document_pipeline: 0.3, // one doc through full pipeline
    bulk_ingestion_pipeline: 0.25, // batch of docs
    pdf_extraction_pipeline: 0.2, // PDF → docling → embed → index
    mixed_format_ingestion: 0.25, // mixed doc types under ramp
  },
  'search-query-e2e': {
    direct_search: 0.3, // direct vector search
    agent_context_search: 0.3, // search within agent conversation
    search_with_rerank: 0.2, // search + reranking
    high_concurrency_search: 0.2, // concurrent search ramp
  },
  'channel-message-e2e': {
    single_message: 0.3, // one message through channel
    burst_messages: 0.25, // burst of messages under ramp
    streaming_ingestion: 0.25, // continuous message stream
    conversation_lifecycle: 0.2, // create → messages → close
  },
  'workflow-execution-e2e': {
    create_and_execute: 0.3, // create workflow + run
    execute_existing: 0.3, // run pre-existing workflow
    parallel_executions: 0.25, // concurrent workflow runs
    long_running_workflow: 0.15, // multi-step long workflow
  },
};
```

The saturation k6 script distributes VUs across scenarios according to these weights during the ramp:

```
Example: runtime saturation test ramps 1→200 VUs over 20 minutes.
At 100 VUs: 50 run single_turn, 25 run multi_turn, 15 run tool_calling, 10 run concurrent.
Saturation detected at 150 VUs when error rate hits 1%.
→ blended maxRpsPerPod = total RPS across all scenarios at 150 VUs.
```

#### Per-Scenario Isolation (For Reports — Identifies Bottlenecks)

After the blended test, the saturation script optionally runs each scenario in isolation to find per-scenario ceilings. This reveals which operation type is the bottleneck:

```
Runtime per-scenario results (example):
  single_turn:  320 RPS/pod  (lightweight SSE response)
  multi_turn:   85 RPS/pod   (5 WebSocket round-trips, holds state)
  tool_calling: 45 RPS/pod   (3 tool calls per request, LLM-bound)
  concurrent:   250 RPS/pod  (same as single_turn but measures ramp)

Blended (50/25/15/10 weights): 180 RPS/pod

→ Report highlights: "tool_calling is the bottleneck scenario at 45 RPS/pod.
   If workload is tool-heavy, consider dedicated agent pools."
```

#### How Results Feed into Sizing

The sizing calculator uses the **blended** `saturation.maxRpsPerPod` for replica computation:

```
Customer workload: 500 concurrent conversations
Blended maxRpsPerPod: 180 (from saturation test)
Replicas = ceil(500 / 180 × 1.2) = 4 pods
```

The **per-scenario** results are recorded in `ServiceCapacity.scenarios` and used in the report to:

1. Identify which scenario is the bottleneck
2. Show capacity ceiling per operation type
3. Recommend workload-specific tuning (e.g., "if >40% tool-calling, add 1 more replica")

#### Customizing Scenario Weights

The `--scenario-weights` CLI flag or `SCENARIO_WEIGHTS` env var overrides the defaults:

```bash
# Customer with heavy tool usage — shift weight toward tool_calling
pnpm cli sizing benchmark --tier M \
  --scenario-weights "runtime:single_turn=0.30,multi_turn=0.20,tool_calling=0.40,concurrent=0.10"
```

This produces a calibration profile tuned to the customer's actual traffic pattern.

### Per-Service Saturation Test

For each service, the orchestrator runs this sequence:

```
sizing benchmark --service runtime --tier M
│
├─ 1. PRE-FLIGHT
│   ├─ Verify kubectl access and target namespace
│   ├─ Record current replica counts for ALL services (for restore)
│   └─ Verify Coroot MCP connectivity (health_check)
│
├─ 2. SCALE-DOWN TARGET
│   ├─ kubectl scale deployment/runtime --replicas=1
│   ├─ Wait for pod ready (kubectl rollout status)
│   └─ Record pod resource requests (cpu/memory from pod spec)
│
├─ 3. RUN RAMP-TO-SATURATION k6 TEST
│   ├─ k6 run benchmarks/saturation/runtime.ts
│   │   Stages: 1 VU → max over 20 minutes
│   │   Exports JSON summary to /tmp/k6-saturation-<service>-<timestamp>.json
│   ├─ Parse k6 summary: extract start/end timestamps, latency percentiles, error rates
│   └─ Detect saturation point from k6 data (error rate > 1% OR p95 > 2x baseline)
│
├─ 4. COLLECT COROOT METRICS (post-test, time-range query)
│   ├─ get_application(runtime) for time range [k6_start, k6_end]
│   │   → CPU peak/avg, memory peak/avg, pod restarts, OOMKills
│   ├─ get_application(mongodb) — connections used during runtime test
│   ├─ get_application(redis) — memory usage during runtime test
│   └─ Check CPU > 85% trigger (third saturation signal)
│
├─ 5. DETERMINE SATURATION POINT
│   ├─ Compare three signals: error-rate, latency, CPU
│   ├─ Earliest trigger wins → that's the per-pod capacity ceiling
│   └─ Record maxRpsPerPod at the saturation point
│
├─ 6. RESTORE REPLICAS
│   └─ kubectl scale deployment/runtime --replicas=<original>
│
└─ 7. WRITE SERVICE RESULT
    └─ Append ServiceCapacity entry to calibration profile JSON
```

### Isolation Strategy

Only the target service is scaled to 1 replica. All dependencies stay at full capacity. This measures the service's own ceiling without downstream bottlenecks.

### Service Test Order (Bottom-Up)

1. **Data stores:** MongoDB, Redis, ClickHouse, OpenSearch, Qdrant
2. **Compute:** bge-m3, docling, preprocessing
3. **App services:** search-ai-runtime, search-ai, runtime, studio, workflow-engine

Data stores first so their capacity numbers inform whether app-service results were bottlenecked by downstream dependencies.

### Integration Flow Saturation Testing

Per-service saturation tests measure isolated capacity — how much load 1 pod of runtime can handle when dependencies are over-provisioned. But production traffic flows through **multiple services in sequence**. Integration flow saturation tests measure the **end-to-end system ceiling** where cross-service interactions create bottlenecks invisible in isolation.

#### Why Integration Tests Matter

```
Per-service test:  runtime alone → 180 RPS (dependencies over-provisioned)
Integration test:  user → runtime → LLM → search-ai-runtime → opensearch → runtime → user
                   Same runtime pod → 120 RPS (connection contention, cascading latency)
```

The per-service ceiling is the **theoretical max**. The integration ceiling is the **practical max** — what the system actually delivers to users. Both are needed:

- **Per-service**: Identifies which service is the bottleneck, sizes individual pods
- **Integration**: Validates that the combined system meets SLAs, catches cross-service issues

#### Integration Flows Tested

| Flow                          | Script                         | Scenarios (default weights)                                                                                                        | Services in Path                                   |
| ----------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **Agent Conversation**        | `agent-conversation-e2e.ts`    | `single_turn` (40%), `multi_turn_conversation` (35%), `concurrent_conversations` (25%)                                             | runtime → LLM → mongodb → redis                    |
| **Multi-Agent Orchestration** | `multi-agent-orchestration.ts` | `single_delegation` (30%), `multi_delegation` (25%), `ws_multi_turn` (25%), `concurrent` (20%)                                     | runtime (supervisor) → runtime (children) → LLM    |
| **KB Ingestion Pipeline**     | `kb-ingestion-e2e.ts`          | `single_document_pipeline` (30%), `bulk_ingestion_pipeline` (25%), `pdf_extraction_pipeline` (20%), `mixed_format_ingestion` (25%) | search-ai → docling → bge-m3 → opensearch → qdrant |
| **Search Query**              | `search-query-e2e.ts`          | `direct_search` (30%), `agent_context_search` (30%), `search_with_rerank` (20%), `high_concurrency_search` (20%)                   | search-ai-runtime → opensearch → qdrant → bge-m3   |
| **Channel Message**           | `channel-message-e2e.ts`       | `single_message` (30%), `burst_messages` (25%), `streaming_ingestion` (25%), `conversation_lifecycle` (20%)                        | runtime → channel dispatch → mongodb → redis       |
| **Workflow Execution**        | `workflow-execution-e2e.ts`    | `create_and_execute` (30%), `execute_existing` (30%), `parallel_executions` (25%), `long_running_workflow` (15%)                   | workflow-engine → restate → runtime                |

#### Integration Saturation Approach

Integration tests run with **all services at their calibrated replica counts** (from per-service saturation results). This tests the system as a whole, not a single pod in isolation.

**The same scenario strategy applies to integration tests as to per-service tests.** Each integration script has 3-4 scenarios. The saturation test runs all scenarios in a blended workload with configurable weights (see `SCENARIO_WEIGHTS` above), then optionally runs per-scenario isolation to identify the bottleneck scenario.

```
Integration Saturation Test (per flow):
1. All services running at calibrated replicas (not scaled down)
2. Ramp VUs across ALL scenarios with weighted distribution
   e.g., agent-conversation-e2e at 100 VUs:
     40 VUs → single_turn, 35 VUs → multi_turn_conversation, 25 VUs → concurrent_conversations
3. Blended saturation = earliest of: p95 > target, error rate > 1%, connections exhausted
4. Record blended system ceiling (maxRps, maxConcurrentUsers)
5. Optionally run each scenario in isolation → per-scenario system ceilings
6. If ceiling < expected workload → flag bottleneck service + scenario for investigation
```

**Per-scenario isolation reveals which user journey is the system bottleneck:**

```
agent-conversation-e2e per-scenario results (example):
  single_turn:               400 RPS system-wide (SSE, fast)
  multi_turn_conversation:    90 RPS system-wide (WS + 5 round-trips + DB writes)
  concurrent_conversations:  300 RPS system-wide (ramp, no state)
  Blended (40/35/25):        250 RPS system-wide

→ Report: "multi_turn_conversation limits the system to 90 RPS.
   Bottleneck: runtime (CPU 88% during multi-turn, only 45% during single-turn).
   WS connections hold state → higher memory per connection → fewer concurrent users."
```

**No scale-down.** Integration tests exercise the full deployment to find:

- Connection pool exhaustion between services
- Redis/MongoDB contention under cross-service load
- Queue backpressure (BullMQ) cascading upstream
- Cascading latency amplification (one slow service degrades the whole chain)
- WebSocket connection limits under multi-turn/orchestration scenarios

#### Integration Results in CalibrationProfile

Integration flow results are stored separately from per-service results:

```typescript
interface CalibrationProfile {
  // ... existing fields ...
  services: Record<string, ServiceCapacity>;
  dataStores: Record<string, DataStoreCapacity>;

  // Integration flow saturation results
  integrationFlows: Record<string, IntegrationFlowCapacity>;
}

interface IntegrationFlowCapacity {
  name: string; // e.g., "agent-conversation-e2e"
  servicesInPath: string[]; // e.g., ["runtime", "mongodb", "redis"]

  // Blended system-level throughput (all scenarios weighted)
  // All services running at calibrated replicas
  systemCeiling: {
    maxRps: number; // end-to-end RPS before SLA breach (blended)
    maxConcurrentUsers: number; // VUs at saturation (blended)
    trigger: 'error-rate' | 'latency' | 'connections'; // what breached first
  };

  // Per-scenario breakdown within this integration flow
  // Same pattern as ServiceCapacity.scenarios — blended for ceiling, per-scenario for reports
  //
  // Example (agent-conversation-e2e):
  //   single_turn:               400 RPS system-wide (lightweight SSE)
  //   multi_turn_conversation:    90 RPS system-wide (WS + 5 round-trips)
  //   concurrent_conversations:  300 RPS system-wide (ramp)
  //   Blended (40/35/25):        250 RPS system-wide
  //   → Report: "multi_turn_conversation is the bottleneck at 90 RPS"
  scenarios: Record<string, IntegrationScenarioCapacity>;

  // End-to-end latency (full user journey, not individual service hops)
  // Blended across all scenarios
  latency: {
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    minMs: number;
    maxMs: number;
    baselineP95Ms: number;
  };

  // Per-service metrics during integration test (from Coroot)
  // Shows which service was the bottleneck in the chain
  serviceMetrics: Record<
    string,
    {
      cpuUtilization: number; // 0-100%
      memoryUtilization: number; // 0-100%
      errorRate: number; // 0-1
      p95Ms: number; // per-hop latency
      activeConnections: number; // WS + HTTP connections held
    }
  >;

  // Identified bottleneck (service with highest resource usage or error rate)
  bottleneck: {
    service: string;
    reason: string; // e.g., "CPU 92%", "connection pool exhausted", "p95 3x baseline"
  };
}

interface IntegrationScenarioCapacity {
  name: string; // e.g., "single_turn", "multi_turn_conversation"
  weight: number; // traffic weight in blended test
  maxRps: number; // system-wide RPS at saturation for this scenario
  maxConcurrentUsers: number; // VUs at saturation for this scenario
  trigger: 'error-rate' | 'latency' | 'connections';
  latency: {
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    minMs: number;
    maxMs: number;
    baselineP95Ms: number;
  };
  // Which service was the bottleneck during this specific scenario
  bottleneckService: string; // e.g., "runtime" for multi_turn, "bge-m3" for ingestion
}
```

#### Test Sequence

Integration saturation runs **after** per-service saturation:

```
Phase 1: Per-service saturation (bottom-up, one service at a time)
  → Produces per-service CalibrationProfile entries
  → Sizing calculator computes calibrated replica counts

Phase 2: Integration flow saturation (all services at calibrated replicas)
  → Validates the combined system meets expected workload
  → Identifies cross-service bottlenecks
  → If system ceiling < expected → adjust replicas upward

Phase 3: Sizing calculator final pass
  → Uses per-service ceilings for base replica counts
  → Adjusts upward if integration tests reveal bottlenecks
  → Produces final topology + Helm values
```

#### Report Impact

The integration results add sections to both reports:

**Internal report:**

- Per-flow throughput table: flow name, system ceiling RPS, bottleneck service, latency
- Per-flow detail: service-by-service metrics during the test, bottleneck analysis

**Customer report:**

- "Agent Conversation Performance" — uses agent-conversation-e2e results
- "Knowledge Base Performance" — uses kb-ingestion-e2e + search-query-e2e results
- SLA compliance section compares integration ceilings against customer workload

### Error Handling

- Service fails to scale down → skip it, log warning, continue to next
- k6 crashes → restore replicas immediately, log error, continue
- Coroot is unreachable → still produce calibration from k6 data alone (Coroot fields set to `null`)
- Replica restore happens in a `finally` block — always runs even on failure

### Saturation Detection — Multi-Signal

Four signals, earliest trigger wins:

| Signal      | Threshold                           | Rationale                                           |
| ----------- | ----------------------------------- | --------------------------------------------------- |
| Error rate  | > 1%                                | Service is failing under load                       |
| Latency     | p95 > 2× baseline p95               | Service is degrading (baseline = first 10% of ramp) |
| CPU         | > 85% (from Coroot)                 | Pod is compute-saturated                            |
| Connections | WS upgrade refused or timeout spike | Pod has exhausted connection capacity               |

The saturation point = the VU count / RPS / connection count where the first signal fires. That value is the per-pod capacity ceiling.

### WebSocket Connection Saturation Testing

HTTP-only services saturate on RPS — measure how many requests/sec one pod handles. But **WebSocket services saturate on concurrent connections** — a pod can only hold a finite number of long-lived connections regardless of message rate.

The runtime has both HTTP endpoints (SSE `/api/v1/chat`) and WebSocket endpoints (`/ws`, `/ws/sdk`, `/voice/media`, etc.). Saturation testing must measure both dimensions:

#### Two-Dimensional Capacity

```
Pod capacity = min(
  RPS capacity     — how many HTTP requests/sec (SSE single_turn, tool_calling)
  Connection capacity — how many concurrent WS connections (multi_turn, SDK sessions)
)

Replicas for RPS:         ceil(expectedRps / maxRpsPerPod × 1.2)
Replicas for connections: ceil(expectedConcurrentUsers / maxConnectionsPerPod × 1.2)
Replicas needed:          max(replicasForRps, replicasForConnections)
```

**Example:**

```
1 runtime pod can handle: 180 RPS (HTTP) and 800 concurrent WS connections.
Customer needs: 500 RPS + 2,000 concurrent conversations (WS).

Replicas for RPS:         ceil(500 / 180 × 1.2) = 4
Replicas for connections: ceil(2000 / 800 × 1.2) = 3
Replicas needed:          max(4, 3) = 4

But if customer has 200 RPS + 5,000 concurrent conversations:
Replicas for RPS:         ceil(200 / 180 × 1.2) = 2
Replicas for connections: ceil(5000 / 800 × 1.2) = 8
Replicas needed:          max(2, 8) = 8  ← connections are the bottleneck
```

#### WS Connection Ramp Test

For services with WebSocket endpoints, the saturation script includes a dedicated connection-ramp scenario:

```
WS Connection Saturation Test:
1. Open WS connections incrementally (10 new connections/sec)
2. Each connection: authenticate → load agent → send periodic keepalive
3. Monitor for: upgrade failures (non-101), timeouts, unexpected disconnects
4. Record per-connection: connect latency, memory growth (Coroot), heartbeat health
5. Saturation = first upgrade refused OR memory > 85% OR CPU > 85%
6. Record maxTotalConnectionsPerPod at saturation
```

The k6 `ws.connect()` API holds connections open — each VU maintains one active WebSocket connection. So ramping VUs directly ramps concurrent connections:

```typescript
// benchmarks/saturation/runtime.ts — WS connection ramp scenario
export const options = {
  scenarios: {
    // ... existing HTTP scenarios (single_turn, tool_calling) ...

    ws_connection_ramp: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '5m', target: 200 }, // 200 concurrent WS connections
        { duration: '5m', target: 500 }, // 500
        { duration: '5m', target: 1000 }, // 1000 (near default WS_MAX_CONNECTIONS)
        { duration: '5m', target: 2000 }, // 2000 (push past config limit)
      ],
      exec: 'wsConnectionRamp',
      tags: { scenario: 'ws_connection_ramp' },
    },
  },
};
```

#### Metrics Captured During WS Saturation

| Metric                                | Source                               | Purpose                                         |
| ------------------------------------- | ------------------------------------ | ----------------------------------------------- |
| `ws_connect_latency_ms` (p50/p95/p99) | k6                                   | Connection setup overhead                       |
| `ws_active_connections` (gauge)       | k6 VU count                          | Concurrent open connections                     |
| `ws_upgrade_failures` (counter)       | k6 (non-101 responses)               | Connection refusals                             |
| `ws_unexpected_disconnects` (counter) | k6 (`close` event before completion) | Server dropping connections                     |
| `ws_message_latency_ms` (p50/p95/p99) | k6 (per-message round-trip)          | Degradation under connection load               |
| `ws_heartbeat_failures` (counter)     | k6 (missed pong)                     | Heartbeat health (30s interval)                 |
| CPU/memory per pod                    | Coroot                               | Resource consumption per connection             |
| Memory growth rate                    | Coroot                               | Detect memory leak under long-lived connections |
| TCP connections (established)         | Coroot eBPF                          | Cross-validate against k6 VU count              |

#### Memory-Per-Connection Estimation

From Coroot data:

```
estimatedMemoryPerConnection = (memoryAtPeak - memoryAtBaseline) / activeConnectionsAtPeak
```

This is critical for the sizing calculator — if each WS connection consumes 2.5MB, then 10,000 concurrent connections need ~25GB of memory across pods, which directly determines memory requests and replica count.

#### Services With WebSocket Endpoints

| Service               | WS Endpoints                                                                   | Default Max/Pod                       | Connection Saturation Test? |
| --------------------- | ------------------------------------------------------------------------------ | ------------------------------------- | --------------------------- |
| **runtime**           | `/ws` (debug), `/ws/sdk` (SDK), `/voice/media`, `/ws/audiocodes`, `/ws/korevg` | 1,000 (config), 10K-50K (per-handler) | Yes — primary target        |
| **search-ai-runtime** | None (HTTP only)                                                               | N/A                                   | No                          |
| **studio**            | WebSocket for live reload (dev only)                                           | N/A                                   | No (dev-only)               |
| All other services    | None                                                                           | N/A                                   | No                          |

Only the **runtime** requires WS connection saturation testing. Other services are HTTP-only and saturate on RPS alone.

#### Sizing Calculator — Connection-Aware Replicas

The `calibratedSizeServices` function uses both dimensions:

```typescript
function calibratedSizeServices(tier, questionnaire, calibration) {
  for (const [name, capacity] of Object.entries(calibration.services)) {
    const rps = expectedRps(name, questionnaire);
    const replicasForRps = Math.ceil((rps / capacity.saturation.maxRpsPerPod) * headroom);

    let replicasForConnections = 0;
    if (capacity.websocket && questionnaire.agents.concurrentConversations > 0) {
      replicasForConnections = Math.ceil(
        (questionnaire.agents.concurrentConversations /
          capacity.websocket.maxTotalConnectionsPerPod) *
          headroom,
      );
    }

    const replicas = Math.max(MIN_REPLICAS[tier], replicasForRps, replicasForConnections);
    // ... rest of sizing
  }
}
```

---

## 9. Coroot Metrics Collection

After each k6 saturation test completes, query Coroot MCP tools using the time window derived from k6 summary timestamps.

### App Services (runtime, search-ai, search-ai-runtime, studio, etc.)

One `get_application` call per service for the test window:

| Metric                        | Destination                                 | Purpose                                 |
| ----------------------------- | ------------------------------------------- | --------------------------------------- |
| CPU usage (peak, avg)         | `measured.cpuPeak`, `measured.cpuAvg`       | Validate/adjust CPU requests in Helm    |
| Memory usage (peak, avg)      | `measured.memoryPeak`, `measured.memoryAvg` | Validate/adjust memory requests in Helm |
| Pod restarts                  | `measured.podRestarts`                      | Detect instability under load           |
| OOMKills                      | `measured.oomKills`                         | Detect memory under-provisioning        |
| Inbound request rate          | Cross-validation                            | Sanity check against k6 RPS             |
| Error rate (5xx)              | Cross-validation                            | Sanity check against k6 error rate      |
| Latency (p50/p95/p99/min/max) | Cross-validation                            | Server-side vs client-side comparison   |

### Data Stores

Each data store gets a `get_application` call plus `get_panel_data` for store-specific metrics.

**MongoDB** (Coroot native — eBPF):

| Metric                              | Category       |
| ----------------------------------- | -------------- |
| Connections used / max              | Capacity       |
| Query latency p50/p95/p99/min/max   | Performance    |
| Write latency p50/p95/p99/min/max   | Performance    |
| Read/write ops breakdown            | Performance    |
| CPU peak/avg, Memory peak/avg       | Resources      |
| Disk usage GB                       | Storage        |
| Replication lag                     | Health         |
| Oplog window size                   | Health         |
| WiredTiger cache hit ratio          | Efficiency     |
| WiredTiger cache dirty bytes        | Write pressure |
| Global lock queue (readers/writers) | Contention     |
| Slow query count                    | Performance    |
| Cursor count (open / timed-out)     | Capacity       |
| IOPS (read/write)                   | I/O            |

**Redis** (Coroot native — eBPF):

| Metric                                 | Category       |
| -------------------------------------- | -------------- |
| Memory used / max                      | Capacity       |
| Connected clients / max                | Capacity       |
| Command latency p50/p95/p99/min/max    | Performance    |
| CPU peak/avg                           | Resources      |
| Keyspace hit/miss ratio                | Efficiency     |
| Eviction rate                          | Pressure       |
| Expired keys rate                      | TTL throughput |
| Blocked clients (BLPOP/BRPOP — BullMQ) | Capacity       |
| Instantaneous ops/sec                  | Throughput     |
| Memory fragmentation ratio             | Health         |
| Persistence status (RDB/AOF)           | Durability     |
| Slowlog length                         | Performance    |

**ClickHouse** (Coroot native + app-level `system.*` tables):

| Metric                                    | Category               |
| ----------------------------------------- | ---------------------- |
| Connections used / max                    | Capacity               |
| Query latency p50/p95/p99/min/max         | Performance            |
| Insert throughput (rows/sec)              | Performance            |
| CPU peak/avg, Memory peak/avg             | Resources              |
| Disk usage / growth rate                  | Storage                |
| Active parts count per table              | Health (>300 = danger) |
| Merge activity (rate, duration)           | Health                 |
| Replication queue size                    | Health                 |
| Rejected inserts                          | Saturation             |
| Concurrent queries vs max                 | Capacity               |
| Memory per query distribution             | Resources              |
| Buffer health (pending rows, utilization) | Pipeline               |

**OpenSearch** (Coroot TCP-level only — no native instrumentation):

| Metric                                 | Category    |
| -------------------------------------- | ----------- |
| Search latency p50/p95/p99/min/max     | Performance |
| Indexing rate & latency                | Performance |
| CPU peak/avg, Memory peak/avg          | Resources   |
| JVM heap used %                        | Resources   |
| GC pause duration (old gen)            | Health      |
| Circuit breaker trips                  | Saturation  |
| Segment count                          | Performance |
| Thread pool rejections (search, write) | Saturation  |
| Refresh time                           | Performance |
| Pending cluster tasks                  | Health      |
| Cluster health (green/yellow/red)      | Health      |
| Disk usage                             | Storage     |
| Query cache hit/miss ratio             | Efficiency  |

**Qdrant** (Coroot TCP-level only):

| Metric                                   | Category    |
| ---------------------------------------- | ----------- |
| Search latency p50/p95/p99/min/max       | Performance |
| Search request rate & failures           | Performance |
| CPU peak/avg, Memory peak/avg (RSS)      | Resources   |
| Collection vector/point count            | Capacity    |
| WAL size / segments                      | Storage     |
| gRPC latency p95                         | Performance |
| Optimizer status (indexing/merge/vacuum) | Health      |
| Segment count per collection             | Health      |
| Update operations rate                   | Throughput  |
| Disk usage                               | Storage     |

**Neo4j** (Coroot TCP-level only, may not be in Coroot app list):

| Metric                                                   | Category    |
| -------------------------------------------------------- | ----------- |
| Transaction count (committed/rollback)                   | Performance |
| Active transactions                                      | Capacity    |
| Cypher query time p50/p95/p99/min/max                    | Performance |
| Bolt connections (opened/running)                        | Capacity    |
| Page cache hit ratio (<95% = graph doesn't fit in cache) | Efficiency  |
| CPU peak/avg, Memory/Heap usage                          | Resources   |
| GC pause time                                            | Health      |
| Store size (nodes, relationships)                        | Storage     |
| Disk usage                                               | Storage     |

### Collection Strategy Per Store

| Store      | Coroot Native?          | Collection Method                                                    |
| ---------- | ----------------------- | -------------------------------------------------------------------- |
| MongoDB    | Yes (eBPF)              | `get_application` + `get_panel_data`                                 |
| Redis      | Yes (eBPF)              | `get_application` + `get_panel_data`                                 |
| ClickHouse | Yes (eBPF) + app module | `get_application` + `get_panel_data` + ClickHouse `system.*` queries |
| OpenSearch | No                      | `get_application` (basic TCP metrics only)                           |
| Qdrant     | No                      | `get_application` (basic TCP metrics only)                           |
| Neo4j      | Not in Coroot           | `get_application` if available (basic TCP only)                      |
| Restate    | No                      | `get_application` (basic TCP metrics only)                           |

**Restate** — Coroot provides TCP-level metrics: connection count, latency, CPU, memory. Store-specific metrics (invocation queue depth, journal size, partition status) require Restate's admin API or Prometheus endpoint (future).

**Future:** When Prometheus becomes available (`--prometheus-url` flag), the collector fills in store-specific metrics for OpenSearch, Qdrant, and Neo4j from their native `/metrics` endpoints.

### Graceful Degradation

If Coroot is unreachable or returns incomplete data:

- App service calibration still works from k6 data alone (RPS, latency, error rate)
- `measured.*` fields set to `null`
- Report marks those fields as "Coroot data unavailable"
- Sizing calculator falls back to hardcoded resource specs when `measured` is null, but still uses k6-derived `maxRpsPerPod` for replica calculation

---

## 10. Sizing Calculator Changes

### Current Flow (Hardcoded)

```
Questionnaire → classifyTier() → tier (S/M/L/XL)
  → sizeApplicationServices(tier) → lookup APPLICATION_SERVICES[service][tier] → fixed replicas/cpu/memory
```

### New Flow (Calibration-Aware)

```
Questionnaire → classifyTier() → tier (S/M/L/XL)
  │
  ├─ CalibrationProfile provided?
  │   │
  │   YES → calibratedSizeServices(questionnaire, calibration)
  │   │     ├─ expectedRps(service, questionnaire)    ← traffic model
  │   │     ├─ replicas = ceil(expectedRps / maxRpsPerPod × headroom)
  │   │     ├─ cpu = measured.cpuPeak × 1.15 buffer
  │   │     └─ memory = measured.memoryPeak × 1.15 buffer
  │   │
  │   NO → sizeApplicationServices(tier)  ← existing hardcoded path (unchanged)
```

### File Changes

**`calculator.ts`** — Accepts optional `CalibrationProfile`:

```typescript
export function calculateTopology(
  questionnaire: Questionnaire,
  calibration?: CalibrationProfile,
): ClusterTopology {
  const tier = classifyTier(questionnaire);

  // When calibration is provided, calibratedSizeServices replaces BOTH
  // sizeApplicationServices AND sizeComputeServices — the CalibrationProfile's
  // flat services Record contains all services (app + compute).
  const allServices = calibration
    ? calibratedSizeServices(tier, questionnaire, calibration)
    : [
        ...sizeApplicationServices(tier, questionnaire),
        ...sizeComputeServices(tier, questionnaire),
      ];

  const dataStores = calibration
    ? calibratedSizeDataStores(tier, questionnaire, calibration)
    : sizeDataStores(tier, questionnaire);

  // ... rest unchanged (nodePools, totalNodes, diskGrowth, managedRecommendations)
}
```

**`service-sizer.ts`** — New `calibratedSizeServices` function alongside existing one:

```typescript
export function calibratedSizeServices(
  tier: Tier,
  questionnaire: Questionnaire,
  calibration: CalibrationProfile,
): ServiceTopology[] {
  const services: ServiceTopology[] = [];

  for (const [name, capacity] of Object.entries(calibration.services)) {
    const rps = expectedRps(name, questionnaire);
    const headroom = 1.2;

    const replicas = Math.max(
      MIN_REPLICAS[tier],
      Math.ceil((rps / capacity.saturation.maxRpsPerPod) * headroom),
    );

    const cpu = roundUpResource(parseFloat(capacity.measured.cpuPeak) * 1.15);
    const memory = roundUpResource(parseFloat(capacity.measured.memoryPeak) * 1.15);

    services.push({
      name,
      replicas,
      resources: { cpu: `${cpu}`, memory: `${memory}Gi` },
      nodePool: inferNodePool(name, cpu),
      hpa: {
        minReplicas: replicas,
        maxReplicas: Math.ceil(replicas * 1.5),
        targetCPUPercent: 70,
        targetMemoryPercent: 80,
      },
    });
  }

  return services;
}
```

**`datastore-sizer.ts`** — New `calibratedSizeDataStores` function:

```typescript
export function calibratedSizeDataStores(
  tier: Tier,
  questionnaire: Questionnaire,
  calibration: CalibrationProfile,
): DataStoreTopology[] {
  const stores: DataStoreTopology[] = [];

  for (const [name, capacity] of Object.entries(calibration.dataStores)) {
    // Replica count: HA-driven (not throughput-driven). Use tier minimums.
    // Data stores don't scale horizontally by RPS — they scale for HA and read throughput.
    const replicas = DATA_STORE_HA_REPLICAS[tier][name] ?? FALLBACK_REPLICAS[tier];

    // Resources: measured peak with 15% buffer, rounded to standard sizes
    const cpu = capacity.resources.cpuPeak
      ? roundUpResource(parseFloat(capacity.resources.cpuPeak) * 1.15)
      : HARDCODED_DATA_STORES[name][tier].cpu; // fallback if Coroot unavailable
    const memory = capacity.resources.memoryPeak
      ? roundUpResource(parseFloat(capacity.resources.memoryPeak) * 1.15)
      : HARDCODED_DATA_STORES[name][tier].memory;

    // Storage: measured disk + projected growth with 30% buffer
    const currentDisk = capacity.resources.diskUsageGB;
    const dailyGrowth = capacity.resources.diskGrowthRateGBPerDay;
    const projectedDisk90d = currentDisk + dailyGrowth * 90;
    const storage = `${Math.ceil(projectedDisk90d * 1.3)}Gi`;

    // Store-specific config derived from measured values
    const config: Record<string, string | number> = {};
    switch (name) {
      case 'mongodb':
        // Connection pool: measured max × service replicas × 1.5 headroom
        config.maxConnections = Math.ceil(capacity.connections.max * 1.5);
        break;
      case 'redis':
        // maxmemory: measured peak × 1.2 headroom
        config.maxmemory = `${Math.ceil(parseFloat(capacity.resources.memoryPeak) * 1.2)}gb`;
        break;
      case 'clickhouse':
        // max_concurrent_queries: measured concurrent × 1.3 headroom
        const concurrentQ = capacity.storeSpecific?.concurrentQueries;
        if (concurrentQ) config.maxConcurrentQueries = Math.ceil(Number(concurrentQ) * 1.3);
        break;
      case 'opensearch':
        // JVM heap: measured heap% → compute target heap size
        const heapPct = capacity.storeSpecific?.jvmHeapPercent;
        if (heapPct) config.jvmHeapSize = `${Math.ceil(parseFloat(memory) * 0.5)}g`;
        break;
    }

    stores.push({
      name,
      replicas,
      resources: { cpu: `${cpu}`, memory: `${memory}Gi` },
      storage,
      config,
    });
  }

  // Add stores not in calibration (not benchmarked) — use hardcoded fallback
  for (const name of Object.keys(HARDCODED_DATA_STORES)) {
    if (!calibration.dataStores[name]) {
      stores.push(sizeDataStoreFromConstants(name, tier, questionnaire));
    }
  }

  return stores;
}
```

**`traffic-model.ts`** — New file for workload-to-RPS conversion (see Section 5).

### Validation

A `CalibrationProfileSchema` (Zod) is added to `packages/sizing-calculator/src/schemas/` to validate calibration files on CLI ingestion. This follows the existing pattern where `QuestionnaireSchema.safeParse()` validates questionnaire input. Malformed or manually-edited calibration files produce clear error messages rather than runtime crashes.

```typescript
// packages/sizing-calculator/src/schemas/calibration.schema.ts
export const CalibrationProfileSchema = z.object({
  version: z.literal('1.0'),
  tier: z.enum(['S', 'M', 'L', 'XL']),
  timestamp: z.string().datetime(),
  environment: z.string().min(1),
  services: z.record(z.string(), ServiceCapacitySchema),
  dataStores: z.record(z.string(), DataStoreCapacitySchema),
});
```

### Backward Compatibility

- `calculateTopology(questionnaire)` — works exactly as before
- `calculateTopology(questionnaire, calibration)` — uses measured data
- All existing tests pass unchanged (calibration param is optional)
- `constants.ts` unchanged — hardcoded values remain as fallback

---

## 11. CLI Commands

### `sizing benchmark` — Full Pipeline Orchestrator

```bash
pnpm cli sizing benchmark \
  --tier M \
  --services runtime,search-ai,search-ai-runtime,bge-m3 \
  --namespace abl-platform-dev \
  --coroot-project vz762g8o \
  --output-calibration calibration.json \
  --output-report docs/benchmarks/report-m-2026-03-24.md \
  --output-pdf docs/benchmarks/report-m-2026-03-24.pdf
```

Runs the full pipeline sequentially per service (pre-flight → scale-down → k6 → Coroot → restore → next service → combine → report).

| Flag                   | Required | Default                       | Description                                       |
| ---------------------- | -------- | ----------------------------- | ------------------------------------------------- |
| `--tier`               | Yes      | —                             | S/M/L/XL                                          |
| `--services`           | No       | all benchmarkable services    | Comma-separated list or `@category` (see groups)  |
| `--namespace`          | No       | from kubeconfig context       | K8s namespace                                     |
| `--coroot-project`     | No       | from env `COROOT_PROJECT_ID`  | Coroot project ID                                 |
| `--output-calibration` | Yes      | —                             | Path for calibration.json                         |
| `--output-report`      | No       | stdout                        | Markdown report path                              |
| `--output-pdf`         | No       | —                             | PDF report path                                   |
| `--headroom`           | No       | 0.20                          | Headroom multiplier (20%)                         |
| `--dry-run`            | No       | false                         | Show plan without executing                       |
| `--max-duration`       | No       | 30m                           | Max duration per service before timeout           |
| `--scenario-weights`   | No       | built-in defaults per service | Override scenario traffic weights (see Section 8) |
| `--skip-per-scenario`  | No       | false                         | Skip per-scenario isolation runs (blended only)   |
| `--prometheus-url`     | No       | —                             | Future: Prometheus endpoint                       |

### `sizing benchmark-service` — Single Service

```bash
pnpm cli sizing benchmark-service \
  --service runtime \
  --tier M \
  --namespace abl-platform-dev
```

Tests one service in isolation. Outputs a single `ServiceCapacity` JSON. Useful for debugging or re-running a failed service.

### `sizing report` — Generate From Existing Calibration

```bash
pnpm cli sizing report \
  --calibration calibration.json \
  --questionnaire questionnaire.json \
  --format md,pdf \
  --output-dir docs/benchmarks/
```

Generates saturation/calibration reports without re-running benchmarks. Optionally takes a questionnaire to include the "recommended topology" section.

### `sizing load-report` — Generate Load Test Report

```bash
# From local results directory
pnpm cli sizing load-report \
  --results /tmp/k6-suite-m-2026-03-25/ \
  --format md,pdf \
  --output-dir docs/benchmarks/

# From most recent Grafana Cloud k6 run
pnpm cli sizing load-report \
  --cloud \
  --last 1 \
  --format md \
  --output-dir docs/benchmarks/

# Compare against a previous run (highlights regressions)
pnpm cli sizing load-report \
  --results /tmp/k6-suite-m-2026-03-25/ \
  --compare /tmp/k6-suite-m-2026-03-20/ \
  --format md,pdf \
  --output-dir docs/benchmarks/
```

Generates load test reports from local k6 JSON summaries or Grafana Cloud k6 results. Shows per-service latency, throughput, error rates, and SLA compliance. Unlike saturation reports (per-pod capacity), load test reports show performance at the current replica count.

| Flag           | Required | Default          | Description                                          |
| -------------- | -------- | ---------------- | ---------------------------------------------------- |
| `--results`    | No\*     | —                | Local k6 results directory (`/tmp/k6-suite-*/`)      |
| `--cloud`      | No\*     | false            | Fetch from Grafana Cloud k6                          |
| `--last`       | No       | 1                | Number of recent cloud runs to include               |
| `--compare`    | No       | —                | Previous results directory for regression comparison |
| `--format`     | No       | md               | `md`, `pdf`, or `md,pdf`                             |
| `--output-dir` | No       | stdout (md only) | Output directory                                     |

\* One of `--results` or `--cloud` is required.

### `sizing calibration-merge` — Merge Partial Calibration Files

```bash
pnpm cli sizing calibration-merge \
  --inputs calibration-compute.json,calibration-ai.json,calibration-datastores.json \
  --output calibration-combined.json
```

Merges partial calibration files (from running `sizing benchmark --services @category` separately) into a single `CalibrationProfile`. Useful when you run saturation tests in phases (data stores first, then compute, then AI) and need to combine results for the sizing calculator. Later runs take precedence for overlapping services.

### Updated `sizing calculate` — Accepts Calibration

```bash
# Existing (unchanged):
pnpm cli sizing calculate --input q.json --output topology.json

# New flag:
pnpm cli sizing calculate \
  --input q.json \
  --calibration calibration.json \
  --output topology-calibrated.json
```

### Typical SE Workflow

```bash
# 0. Configure cloud.env with target environment URLs, auth tokens, tier
#    Then bootstrap the benchmark environment (creates agents, KB, mock LLM)
cd benchmarks && source config/cloud.env
k6 run setup/bootstrap.ts

# 1. Generate questionnaire, fill in customer workload
pnpm cli sizing questionnaire --output q.json

# 2. Initial sizing (hardcoded, no benchmarks yet)
pnpm cli sizing calculate --input q.json --output topology.json
pnpm cli sizing helm --input topology.json --output-dir ./helm-values/
# Deploy to cluster...

# 3a. Run regular load tests (cloud — for dashboard & audit trail)
./benchmarks/scripts/cloud-run-suite.sh

# 3b. Run regular load tests (local — for development/debugging)
TIER=m ./benchmarks/scripts/local-run-suite.sh

# 3c. Run saturation benchmarks (local — needs kubectl + Coroot MCP)
pnpm cli sizing benchmark \
  --tier M \
  --output-calibration calibration.json \
  --output-report report.md \
  --output-pdf report.pdf

# 4. Re-size with measured data
pnpm cli sizing calculate \
  --input q.json \
  --calibration calibration.json \
  --output topology-calibrated.json

# 5. Generate calibrated Helm values
pnpm cli sizing helm \
  --input topology-calibrated.json \
  --output-dir ./helm-values-calibrated/

# 6. View cloud results (if tests ran on Grafana Cloud k6)
./benchmarks/scripts/cloud-results.sh --last 10
```

---

## 12. Report Generation

Reports are generated for both **load tests** and **saturation benchmarks**. They answer different questions:

| Report Type                      | Generated By         | Question Answered                                         | Audience          |
| -------------------------------- | -------------------- | --------------------------------------------------------- | ----------------- |
| **Load Test Report**             | `sizing load-report` | "Is the current deployment fast enough for the workload?" | SE, platform team |
| **Saturation Report (Internal)** | `sizing benchmark`   | "What is each pod's capacity ceiling?"                    | Platform team     |
| **Saturation Report (Customer)** | `sizing report`      | "Does the platform meet SLA? What topology is needed?"    | Customer, SE      |

All reports in markdown; customer reports also as PDF via `md-to-pdf` npm package.

### Load Test Report

Generated from regular load test results (local `/tmp/k6-suite-*/` or Grafana Cloud). Shows performance at the current replica count — not per-pod capacity.

**Sections:**

1. **Summary** — tier, duration, total requests, overall error rate, services tested, execution mode (local/cloud)
2. **Per-Service Results Table** — requests, error rate, p50/p95/p99 latency, throughput (RPS), threshold pass/fail
3. **Per-Service Detail** (per service) — scenario breakdown with per-scenario latency and throughput, custom metrics, threshold results
4. **Integration Flow Results** — end-to-end latency, success rate, per-service contribution, bottleneck identification
5. **SLA Compliance** — each SLA target vs measured result, pass/fail, delta from target
6. **Comparison vs Previous Run** (optional, if `--compare` provided) — latency regressions, throughput changes, new threshold failures highlighted in red

### Saturation Report — Internal Engineering

For platform team consumption. Full raw data, calibration deltas, warnings.

**Sections:**

1. **Executive Summary** — services tested, saturation triggers, calibration profile path
2. **Per-Service Capacity Table** — Max RPS/Pod, saturation trigger, CPU peak, memory peak, baseline p95, saturated p95, OOMKills, tested URL, ingress flag
3. **Per-Service Detail** (per service) — full k6 metrics, full Coroot metrics, calibration-vs-hardcoded comparison table, per-scenario breakdown (blended ceiling + individual bottleneck identification)
4. **WebSocket Capacity** (for services with WS endpoints) — max connections/pod, memory per connection, connect latency, endpoint-level breakdown
5. **Data Store Capacity Table** — connections used/max, query p95, write p95, CPU peak, memory peak, disk used, data source
6. **Data Store Detail** (per store) — all collected metrics including store-specific, data source flag
7. **Integration Flow Results** — system ceiling per flow, bottleneck service, per-service metrics during cross-service load
8. **Warnings** — under-provisioning alerts, missing Coroot data, connection utilization concerns, scenarios with disproportionate impact

### Saturation Report — Customer-Facing

Polished, no raw calibration data. Focused on SLA compliance and topology recommendation.

**Sections:**

1. **Executive Summary** — tier, SLA result summary, recommended deployment size
2. **Benchmark Methodology** — tool (k6), approach, monitoring (Coroot), duration, environment
3. **Agent Conversation Performance** — single-turn/multi-turn/tool-calling latencies, concurrent capacity, error rate vs SLA
4. **Knowledge Base Performance** — ingestion throughput, vector search latency, embedding throughput vs SLA
5. **Data Store Health** — per-store connection utilization, query latency, disk usage, status
6. **SLA Compliance Summary** — each SLA target vs measured result, pass/fail
7. **Recommended Production Topology** — node pools, service replicas with CPU/memory, data store sizing with key config (requires questionnaire input)
8. **Appendix** — test environment details, k6 script versions, Coroot collection window

### PDF Generation

Using `md-to-pdf` npm package (added as devDependency to `kore-platform-cli`):

```typescript
import { mdToPdf } from 'md-to-pdf';

async function generatePdf(markdownPath: string, outputPath: string): Promise<void> {
  const pdf = await mdToPdf(
    { path: markdownPath },
    {
      stylesheet: ['benchmarks/report/styles/customer-report.css'],
      pdf_options: {
        format: 'A4',
        margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
        headerTemplate:
          '<div style="font-size:8px;text-align:center;width:100%">ABL Platform — Confidential</div>',
        footerTemplate:
          '<div style="font-size:8px;text-align:center;width:100%"><span class="pageNumber"></span>/<span class="totalPages"></span></div>',
      },
    },
  );

  await writeFile(outputPath, pdf.content);
}
```

Report templates use Handlebars (`.hbs` files) for consistent formatting across runs.

---

## 13. Service Configuration

Service URLs are resolved from the existing `benchmarks/config/cloud.env` + `benchmarks/lib/config.ts` infrastructure. No new CLI flags for URLs.

### URL Resolution Priority

```
CLI -e flag → cloud.env value → config.ts default (private/localhost)
```

### Service Registry

```typescript
const SERVICES = {
  // Public services (cloud.env typically has ingress URLs)
  runtime: { configKey: 'runtimeUrl', k6Script: 'saturation/runtime.ts' },
  studio: { configKey: 'studioUrl', k6Script: 'saturation/studio.ts' },
  admin: { configKey: 'adminUrl', k6Script: 'saturation/admin.ts' },

  // Private services (default to localhost/ClusterIP, cloud.env can override)
  'search-ai': { configKey: 'searchAiUrl', k6Script: 'saturation/search-ai.ts' },
  'search-ai-runtime': {
    configKey: 'searchAiRuntimeUrl',
    k6Script: 'saturation/search-ai-runtime.ts',
  },
  'bge-m3': { configKey: 'bgeM3Url', k6Script: 'saturation/bge-m3.ts' },
  docling: { configKey: 'doclingUrl', k6Script: 'saturation/docling.ts' },
  preprocessing: { configKey: 'preprocessingUrl', k6Script: 'saturation/preprocessing.ts' },
  'workflow-engine': { configKey: 'workflowEngineUrl', k6Script: 'saturation/workflow-engine.ts' },

  // Data stores (always private, cloud.env can override)
  mongodb: { configKey: 'mongoUrl', k6Script: 'saturation/mongodb.ts' },
  redis: { configKey: 'redisUrl', k6Script: 'saturation/redis.ts' },
  clickhouse: { configKey: 'clickhouseUrl', k6Script: 'saturation/clickhouse.ts' },
  opensearch: { configKey: 'opensearchUrl', k6Script: 'saturation/opensearch.ts' },
  qdrant: { configKey: 'qdrantUrl', k6Script: 'saturation/qdrant.ts' },
  neo4j: { configKey: 'neo4jUrl', k6Script: 'saturation/neo4j.ts' },
  restate: { configKey: 'restateUrl', k6Script: 'saturation/restate.ts' },

  // Out of scope for v1 (no k6 saturation scripts — low traffic or sidecar services):
  // nlu-sidecar:       co-located with runtime, not independently scalable
  // crawler-go:        event-driven worker, not request-based — needs different benchmark approach
  // crawler-mcp:       same as crawler-go
  // multimodal:        not yet deployed in staging
};
```

### Access Detection

The orchestrator determines access type from the resolved URL:

- URL starts with `https://` and matches `INGRESS_BASE` → public ingress
- URL is `http://localhost:*` or `http://<service>:<port>` → private/direct

Health check runs against the resolved URL before each test. If it fails, the service is skipped with a warning.

### CalibrationProfile Records Access

```typescript
testedUrl: string; // actual URL used
testedViaIngress: boolean; // true if resolved from cloud.env ingress
```

This is important for the report — public benchmarks include LB/TLS overhead; private benchmarks are raw service capacity.

---

## 14. New Files and Package Changes

### New Files

```
packages/sizing-calculator/
  src/types/calibration.types.ts          # CalibrationProfile, ServiceCapacity, DataStoreCapacity
  src/schemas/calibration.schema.ts       # Zod validation for CalibrationProfile
  src/engine/traffic-model.ts             # peakRps(), expectedRps(), ENTERPRISE_TRAFFIC
  src/engine/calibrator.ts                # combineBenchmarkResults(), detectSaturation()
  src/engine/coroot-collector.ts          # collectCorootMetrics(), resolveCorootAppId()
  src/__tests__/traffic-model.test.ts     # Unit tests for traffic model
  src/__tests__/calibrator.test.ts        # Unit tests for saturation detection, result combining

packages/kore-platform-cli/
  src/commands/sizing-benchmark.ts        # sizing benchmark, sizing benchmark-service
  src/commands/sizing-report.ts           # sizing report command

benchmarks/
  saturation/runtime.ts                   # Ramp-to-saturation k6 script
  saturation/search-ai.ts
  saturation/search-ai-runtime.ts
  saturation/bge-m3.ts
  saturation/studio.ts
  saturation/admin.ts
  saturation/workflow-engine.ts
  saturation/docling.ts
  saturation/preprocessing.ts
  saturation/mongodb.ts
  saturation/redis.ts
  saturation/clickhouse.ts
  saturation/opensearch.ts
  saturation/qdrant.ts
  saturation/neo4j.ts
  saturation/restate.ts
  report/styles/customer-report.css       # PDF styling
  report/templates/internal.hbs           # Internal report template
  report/templates/customer.hbs           # Customer report template
```

### Modified Files

```
packages/sizing-calculator/
  src/index.ts                            # Export new types + functions
  src/engine/calculator.ts                # Accept optional CalibrationProfile param
  src/engine/service-sizer.ts             # Add calibratedSizeServices()
  src/engine/datastore-sizer.ts           # Add calibratedSizeDataStores()

packages/kore-platform-cli/
  src/commands/sizing.ts                  # Add --calibration flag to sizing calculate
  package.json                            # Add md-to-pdf, handlebars dependencies
```

### Unchanged

- `constants.ts` — hardcoded baselines remain as fallback
- `tier-classifier.ts` — tier classification unchanged
- `helm-values.ts` — generates from topology as before
- `questionnaire.schema.ts` — no new fields
- Existing k6 scripts in `benchmarks/services/` and `benchmarks/integration/`
- All existing tests

### Dependencies

| Package             | New Dependency | Why                           |
| ------------------- | -------------- | ----------------------------- |
| `kore-platform-cli` | `md-to-pdf`    | PDF report generation         |
| `kore-platform-cli` | `handlebars`   | Report templating             |
| `sizing-calculator` | None           | Pure computation, no new deps |
| `benchmarks`        | None           | k6 scripts use existing deps  |

### Notes

**md-to-pdf and Chromium:** `md-to-pdf` uses Puppeteer which downloads headless Chromium. If Chromium is unavailable (e.g., restricted CI environment), the `sizing report` and `sizing benchmark` commands skip PDF generation and output markdown only, with a warning.

**CalibrationProfile versioning:** The `version: '1.0'` field enables future schema evolution. The CLI rejects files with incompatible versions with a clear error message. Forward-compatible migrations will be added as needed.

**`roundUpResource()` rounding strategy:** CPU rounds to nearest 0.25 cores (e.g., 1.82 × 1.15 = 2.09 → 2.25). Memory rounds to nearest 256Mi (e.g., 3.2Gi × 1.15 = 3.68Gi → 3.75Gi). This produces Helm-friendly resource values.

**`inferNodePool()` logic:** Services with CPU ≥ 4 cores go to `compute` pool, services with GPU requirements go to `gpu` pool, everything else goes to `general` pool. Data stores always go to `data` pool.

---

## 15. Prerequisites and Configuration

### System Requirements

| Requirement                  | Version/Detail            | Why                                                                              |
| ---------------------------- | ------------------------- | -------------------------------------------------------------------------------- |
| **k6**                       | v1.6+                     | Native TypeScript support, `k6 cloud run` command                                |
| **Node.js**                  | 18+                       | kore-platform-cli, md-to-pdf report generation                                   |
| **pnpm**                     | 8+                        | Monorepo package management                                                      |
| **kubectl**                  | Matching cluster version  | Scale-down/restore for saturation tests                                          |
| **Azure CLI (`az`)**         | 2.50+                     | Obtain AKS cluster credentials for kubectl                                       |
| **python3**                  | 3.8+                      | Token refresh in shell scripts, result parsing                                   |
| **Grafana Cloud k6 account** | —                         | Required only for cloud execution mode                                           |
| **Coroot MCP**               | Connected via `.mcp.json` | Infrastructure metrics collection (optional — k6 data used alone if unavailable) |

### Cluster Access Setup (kubectl)

Saturation benchmarks require `kubectl` access to the target Kubernetes cluster. The ABL Platform runs on **Azure AKS**.

> **Note:** `kubectl` is only required for **saturation benchmarks** (the calibration pipeline). Regular load tests (`k6 run`, `k6 cloud run`) only need HTTP/WebSocket access to service URLs and do **not** require cluster access.

#### Why Cluster Access Is Needed

The saturation pipeline uses `kubectl` for four operations during each service's capacity test:

| Operation                     | kubectl Command                                        | Why                                                                                                                |
| ----------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| **Scale-down to 1 replica**   | `kubectl scale deployment/<svc> --replicas=1`          | Isolate a single pod to measure its true capacity ceiling — testing N pods gives per-cluster, not per-pod capacity |
| **Restore original replicas** | `kubectl scale deployment/<svc> --replicas=<original>` | Return the service to its pre-test state after saturation test completes (or fails)                                |
| **Pre-flight pod checks**     | `kubectl get pods -l app=<svc>`                        | Verify the target service is running and ready before starting the load ramp                                       |
| **Monitor pod health**        | `kubectl get pods`, `kubectl top pods`                 | Detect OOM kills, pod restarts, and resource exhaustion during the saturation ramp                                 |

Without cluster access, the CLI cannot scale services down, which means it cannot measure per-pod capacity — it would only measure the aggregate capacity of whatever replica count happens to be deployed.

#### Three-Repo Architecture

| Repo                                                      | Contents                                             |
| --------------------------------------------------------- | ---------------------------------------------------- |
| **abl-platform** (this repo)                              | App source, Dockerfiles, benchmark scripts           |
| **abl-platform-deploy** (`koreteam1/abl-platform-deploy`) | Helm charts, ArgoCD config, per-env values files     |
| **abl-platform-infra** (`koreteam1/abl-platform-infra`)   | Terraform/OpenTofu modules, AKS provisioning, tfvars |

The cluster name, resource group, and subscription ID are defined in `abl-platform-infra` tfvars.

#### Step-by-Step: Obtain kubectl Access

```bash
# 1. Install Azure CLI
brew install azure-cli
# or: https://learn.microsoft.com/en-us/cli/azure/install-azure-cli

# 2. Login to Azure (opens browser for SSO)
az login

# 3. Set the correct subscription (get ID from abl-platform-infra tfvars or team)
az account set --subscription <subscription-id>

# 4. Get AKS credentials (merges into ~/.kube/config)
az aks get-credentials \
  --resource-group <resource-group> \
  --name <cluster-name>
# Example for dev:
#   az aks get-credentials --resource-group abl-dev-rg --name abl-dev-aks

# 5. Verify access
kubectl get nodes
kubectl get pods -n abl-platform-dev

# 6. (Optional) Set default namespace to avoid -n flag everywhere
kubectl config set-context --current --namespace=abl-platform-dev
```

#### Cluster Environments and Namespaces

| Environment | Namespace          | Typical Use                          |
| ----------- | ------------------ | ------------------------------------ |
| Dev         | `abl-platform-dev` | Development, initial benchmark runs  |
| Staging     | `abl-platform`     | Pre-production saturation benchmarks |
| Benchmarks  | `abl-benchmarks`   | k6 Operator TestRun pods, ConfigMaps |

#### Verify kubectl Can Perform Required Operations

The saturation pipeline needs permissions to scale deployments and read pod metrics:

```bash
# Check if you can scale deployments (required for saturation tests)
kubectl auth can-i update deployments --namespace abl-platform-dev
# Should return: yes

# Check if you can read pods (required for pre-flight and restore)
kubectl auth can-i get pods --namespace abl-platform-dev
# Should return: yes

# Quick test: view current replicas for runtime
kubectl get deployment abl-platform-dev-runtime -n abl-platform-dev -o jsonpath='{.spec.replicas}'
```

If `kubectl auth can-i` returns `no`, request RBAC access from the cluster admin. The minimum role needed is:

```yaml
# Minimum RBAC for saturation benchmarks
rules:
  - apiGroups: ['apps']
    resources: ['deployments', 'deployments/scale', 'statefulsets', 'statefulsets/scale']
    verbs: ['get', 'list', 'patch', 'update']
  - apiGroups: ['']
    resources: ['pods', 'pods/log', 'services']
    verbs: ['get', 'list']
```

#### Port-Forward for Local Development (No Ingress)

When running benchmarks against a cluster without public ingress, use `kubectl port-forward` to access services locally:

```bash
# Forward all required services to localhost (each in a separate terminal or background)
kubectl port-forward -n abl-platform-dev svc/abl-platform-dev-runtime 3112:3112 &
kubectl port-forward -n abl-platform-dev svc/abl-platform-dev-studio 5173:5173 &
kubectl port-forward -n abl-platform-dev svc/abl-platform-dev-search-ai 3113:3113 &
kubectl port-forward -n abl-platform-dev svc/abl-platform-dev-admin 3003:3003 &

# Then use localhost URLs in cloud.env:
#   RUNTIME_URL=http://localhost:3112
#   STUDIO_URL=http://localhost:5173
#   SEARCH_AI_URL=http://localhost:3113
#   ADMIN_URL=http://localhost:3003
```

#### Troubleshooting Cluster Access

| Problem                                  | Cause                                      | Fix                                                                    |
| ---------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| `az login` — browser doesn't open        | Running in headless/SSH terminal           | Use `az login --use-device-code`                                       |
| `az aks get-credentials` — not found     | Wrong resource group or cluster name       | Check `abl-platform-infra` tfvars for correct values                   |
| `kubectl get nodes` — connection refused | VPN not connected or cluster not reachable | Connect to corporate VPN, verify cluster endpoint                      |
| `kubectl get pods` — forbidden           | RBAC not configured for your user          | Request `edit` or custom role from cluster admin                       |
| `kubectl scale` — forbidden              | Missing `update` permission on deployments | Request the RBAC role shown above                                      |
| Context pointing to wrong cluster        | Multiple clusters in kubeconfig            | `kubectl config get-contexts` then `kubectl config use-context <name>` |
| Port-forward drops connection            | Idle timeout or pod restart                | Re-run port-forward; use `--address 0.0.0.0` if needed                 |

### Environment Variables — Complete Reference

All environment variables are configured in `benchmarks/config/cloud.env`. The resolution priority is:

```
k6 CLI -e flag  →  cloud.env value  →  config.ts hardcoded default
```

#### Required for Cloud Execution

These are validated with `:?` in shell scripts — cloud runs fail without them.

| Variable              | Example                           | Description                                                                                            |
| --------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `K6_CLOUD_TOKEN`      | `e79d588e...`                     | Grafana k6 Cloud API token. Get from: Grafana Cloud → k6 → Settings → API tokens                       |
| `K6_CLOUD_PROJECT_ID` | `7014634`                         | k6 Cloud project ID. Get from: Grafana Cloud → k6 → Projects → URL                                     |
| `STAGING_URL`         | `https://agents-staging.kore.ai/` | Base URL for target environment. Used to derive per-service URLs when individual overrides are not set |

#### Required for Any Execution (Auth)

At least one auth method must work — either AUTH_TOKEN or dev-login credentials.

| Variable            | Default        | Description                                                                                                                  |
| ------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_TOKEN`        | `''` (empty)   | JWT access token. Get from: Studio UI → DevTools → Network → copy accessToken. 15-min TTL. If empty, falls back to dev-login |
| `REFRESH_TOKEN`     | `''` (empty)   | Refresh token for auto-renewal. Get alongside AUTH_TOKEN from cookies. Enables test suites longer than 15 min                |
| `DEV_LOGIN_EMAIL`   | `dev@kore.ai`  | Email for dev-login fallback (when AUTH_TOKEN is empty or expired and refresh fails)                                         |
| `DEV_LOGIN_NAME`    | `Developer`    | Display name for dev-login                                                                                                   |
| `DEV_LOGIN_USER_ID` | `user-dev-001` | User ID for dev-login                                                                                                        |

#### Tenant and Project Identity

| Variable     | Default             | Description                                                             |
| ------------ | ------------------- | ----------------------------------------------------------------------- |
| `TENANT_ID`  | `benchmark-tenant`  | Tenant UUID. Bootstrap reuses this tenant; sent as `X-Tenant-Id` header |
| `PROJECT_ID` | `benchmark-project` | Project UUID. Bootstrap reuses this project for agents, KBs, etc.       |

#### Service URLs

All service URLs have localhost defaults for local development. Override in cloud.env for staging/production targets.

| Variable                | Default                 | Port | Service                                                         |
| ----------------------- | ----------------------- | ---- | --------------------------------------------------------------- |
| `RUNTIME_URL`           | `http://localhost:3112` | 3112 | Runtime (agent chat, WebSocket)                                 |
| `STUDIO_URL`            | `http://localhost:5173` | 5173 | Studio (auth, agent CRUD, credentials)                          |
| `ADMIN_URL`             | `http://localhost:3003` | 3003 | Admin service                                                   |
| `SEARCH_AI_URL`         | `http://localhost:3113` | 3113 | Search AI (KB management, ingestion)                            |
| `SEARCH_AI_RUNTIME_URL` | `http://localhost:3114` | 3114 | Search AI Runtime (search queries)                              |
| `BGE_M3_URL`            | `http://localhost:8000` | 8000 | BGE-M3 embedding model                                          |
| `DOCLING_URL`           | `http://localhost:8080` | 8080 | Docling document processor                                      |
| `PREPROCESSING_URL`     | `http://localhost:8003` | 8003 | Preprocessing service                                           |
| `INGRESS_BASE`          | `''` (empty)            | —    | When set, enables ingress mode: `apiPath()` omits `/api` prefix |

#### Data Store URLs

| Variable         | Default                     | Port  | Store                       |
| ---------------- | --------------------------- | ----- | --------------------------- |
| `MONGO_URL`      | `mongodb://localhost:27017` | 27017 | MongoDB                     |
| `REDIS_URL`      | `redis://localhost:6379`    | 6379  | Redis                       |
| `CLICKHOUSE_URL` | `http://localhost:8123`     | 8123  | ClickHouse (HTTP interface) |
| `OPENSEARCH_URL` | `https://localhost:9200`    | 9200  | OpenSearch                  |
| `QDRANT_URL`     | `http://localhost:6333`     | 6333  | Qdrant                      |
| `NEO4J_URL`      | `bolt://localhost:7687`     | 7687  | Neo4j                       |
| `RESTATE_URL`    | `http://localhost:9070`     | 9070  | Restate                     |

#### Benchmark Control

| Variable        | Default                   | Description                                                                                                                                |
| --------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `TIER`          | `m` (cloud) / `s` (local) | Load tier: s, m, l, xl. Controls VU counts, durations, parallelism via `tier-profiles.json`                                                |
| `MOCK_LLM`      | not set                   | When `true`, bootstrap configures agents with mock LLM provider (no real API calls). Requires `ENABLE_MOCK_LLM=true` on Runtime deployment |
| `HEALTH_CHECK`  | `true`                    | When `true`, each benchmark runs `/health` check before starting. Set to `false` to skip                                                   |
| `LOAD_TEST_KEY` | `benchmark-bypass`        | Sent as `X-Load-Test` header for rate limit bypass (non-production only)                                                                   |
| `ENV`           | `staging`                 | Environment label for k6 Cloud dashboard tags                                                                                              |

#### Agent Configuration

| Variable             | Default                   | Description                                                     |
| -------------------- | ------------------------- | --------------------------------------------------------------- |
| `AGENT_NAME`         | `benchmark_agent`         | Name for the benchmark agent created by bootstrap               |
| `SUPERVISOR_NAME`    | `benchmark_supervisor`    | Name for the multi-agent supervisor                             |
| `AGENT_PATH`         | `default/benchmark_agent` | Full agent path override (format: `{projectId}/default/{name}`) |
| `AGENT_CONFIG`       | `{}`                      | JSON string to override agent configuration during bootstrap    |
| `MULTI_AGENT_CONFIG` | `''`                      | JSON string to override multi-agent topology during bootstrap   |

#### Search AI / Knowledge Base

| Variable    | Default | Description                                             |
| ----------- | ------- | ------------------------------------------------------- |
| `INDEX_ID`  | `''`    | Pre-existing index ID. If empty, bootstrap creates one  |
| `SOURCE_ID` | `''`    | Pre-existing source ID. If empty, bootstrap creates one |

#### Kubernetes (Saturation Tests and System Tests)

| Variable        | Default                 | Description                             |
| --------------- | ----------------------- | --------------------------------------- |
| `K8S_API_URL`   | `http://localhost:8001` | Kubernetes API URL (for failover tests) |
| `K8S_NAMESPACE` | `abl-platform`          | K8s namespace for pod operations        |
| `K8S_TOKEN`     | `''`                    | Bearer token for K8s API auth           |

#### Shell-Only Variables

| Variable | Default            | Description                |
| -------- | ------------------ | -------------------------- |
| `K6_BIN` | `$(command -v k6)` | Path to k6 binary override |

### Configuration File Locations

```
benchmarks/
├── config/
│   ├── cloud.env              # ← Main configuration (gitignored, contains secrets)
│   ├── cloud.env.example      # Template — copy to cloud.env and fill in
│   └── tier-profiles.json     # VU counts, duration, parallelism per tier (S/M/L/XL)
├── lib/
│   ├── config.ts              # Parses cloud.env, provides config object with lazy getters
│   ├── auth.ts                # Token acquisition, refresh, dev-login fallback
│   ├── metrics.ts             # Custom k6 metric definitions
│   └── http-utils.ts          # HTTP retry, backoff utilities
└── scripts/
    ├── cloud-run.sh           # Run single script on Grafana Cloud k6
    ├── cloud-run-suite.sh     # Run full suite on Grafana Cloud k6
    ├── local-run-suite.sh     # Run full suite locally
    └── cloud-results.sh       # Fetch results from k6 Cloud API
```

### Server-Side Prerequisites

| Requirement                | Where                      | Why                                                             |
| -------------------------- | -------------------------- | --------------------------------------------------------------- |
| `ENABLE_MOCK_LLM=true`     | Runtime deployment env var | Required if `MOCK_LLM=true` — enables the mock LLM provider     |
| Dev-login endpoint enabled | Studio deployment          | Fallback auth when AUTH_TOKEN is not set or expired             |
| Rate limit bypass          | Runtime deployment         | `LOAD_TEST_KEY` header must be recognized to bypass rate limits |
| Coroot agent deployed      | All pods                   | eBPF-based metrics collection for CPU, memory, connections      |

---

## 16. Usage Guide

### Quick Start — First Time Setup

```bash
# 1. Install tools
brew install k6           # v1.6+ required for native TypeScript
brew install azure-cli    # Required for kubectl access to AKS cluster
# Verify: k6 version && az --version

# 2. Get kubectl access to the cluster (see Section 15 for full details)
az login
az account set --subscription <subscription-id>
az aks get-credentials --resource-group <resource-group> --name <cluster-name>
# Get resource-group/cluster-name from abl-platform-infra tfvars or team
kubectl get nodes          # Verify access — should list cluster nodes
kubectl get pods -n abl-platform-dev   # Verify namespace access

# 3. Copy and configure cloud.env
cp benchmarks/config/cloud.env.example benchmarks/config/cloud.env
# Edit cloud.env:
#   - Set STAGING_URL to your target environment
#   - Set AUTH_TOKEN (from Studio UI → DevTools → Network)
#   - Set REFRESH_TOKEN (from cookies)
#   - Set TENANT_ID and PROJECT_ID
#   - Set K6_CLOUD_TOKEN and K6_CLOUD_PROJECT_ID (for cloud runs)
#   - Set MOCK_LLM=true (recommended for benchmarks without real LLM costs)
#   - Set K8S_NAMESPACE to match your cluster (default: abl-platform)

# 4. Bootstrap the benchmark environment
cd benchmarks
k6 run setup/bootstrap.ts
# Creates: tenant, project, agents, KB, mock LLM, seeded conversations
# Idempotent — safe to re-run

# 5. Verify bootstrap
# Check output for:
#   ✓ tenant has accessToken
#   ✓ tenant has projectId
#   ✓ agent has agentId
#   ✓ supervisor has agentId
#   ✓ mock model configured (if MOCK_LLM=true)
#   ✓ kb has indexId

# 6. Verify saturation test prerequisites (kubectl permissions)
kubectl auth can-i update deployments -n abl-platform-dev  # Must return: yes
kubectl auth can-i get pods -n abl-platform-dev            # Must return: yes
```

### Run Regular Load Tests

#### Service Selection for Load Tests

The `SERVICES` env var controls which services and integration scripts to run. It accepts service names, integration script names, `@category` groups, or any combination.

```bash
# ── All services (default — omit SERVICES) ──────────────────────
TIER=m ./benchmarks/scripts/local-run-suite.sh

# ── Single service ──────────────────────────────────────────────
SERVICES=runtime ./benchmarks/scripts/local-run-suite.sh
# or directly via k6:
cd benchmarks && k6 run services/runtime.ts

# ── Multiple specific services ──────────────────────────────────
SERVICES=runtime,search-ai,bge-m3 ./benchmarks/scripts/local-run-suite.sh

# ── Single integration script ──────────────────────────────────
SERVICES=agent-conversation-e2e ./benchmarks/scripts/local-run-suite.sh
# or directly via k6:
cd benchmarks && k6 run integration/agent-conversation-e2e.ts

# ── Multiple integration scripts ───────────────────────────────
SERVICES=agent-conversation-e2e,kb-ingestion-search-e2e ./benchmarks/scripts/local-run-suite.sh

# ── Mix services and integration scripts ───────────────────────
SERVICES=runtime,search-ai,agent-conversation-e2e ./benchmarks/scripts/local-run-suite.sh

# ── By category ────────────────────────────────────────────────
SERVICES=@compute ./benchmarks/scripts/local-run-suite.sh
SERVICES=@data-stores ./benchmarks/scripts/local-run-suite.sh
SERVICES=@ai ./benchmarks/scripts/local-run-suite.sh
SERVICES=@integration ./benchmarks/scripts/local-run-suite.sh

# ── Mix categories and individual names ────────────────────────
SERVICES=@compute,bge-m3,agent-conversation-e2e ./benchmarks/scripts/local-run-suite.sh
```

The same `SERVICES` env var works with cloud execution:

```bash
# Cloud — same selection patterns
SERVICES=runtime,search-ai ./benchmarks/scripts/cloud-run-suite.sh
SERVICES=@compute ./benchmarks/scripts/cloud-run-suite.sh
SERVICES=runtime,agent-conversation-e2e ./benchmarks/scripts/cloud-run-suite.sh

# Cloud — single script directly
./benchmarks/scripts/cloud-run.sh benchmarks/services/runtime.ts
./benchmarks/scripts/cloud-run.sh benchmarks/integration/agent-conversation-e2e.ts

# View results
./benchmarks/scripts/cloud-results.sh --last 10
```

#### Run Specific Scenarios Within a Service

```bash
# k6 --scenario flag runs specific scenarios within a single script
cd benchmarks
k6 run services/runtime.ts --scenario single_turn
k6 run services/runtime.ts --scenario multi_turn
k6 run integration/agent-conversation-e2e.ts --scenario concurrent_conversations
```

#### Service Groups (Categories)

Both load test scripts and saturation CLI support `@category` shorthand:

| Category       | Services                                                     | Scripts                                                          |
| -------------- | ------------------------------------------------------------ | ---------------------------------------------------------------- |
| `@compute`     | runtime, studio, admin                                       | `services/runtime.ts`, `services/studio.ts`, `services/admin.ts` |
| `@data-stores` | mongodb, redis, opensearch, qdrant, clickhouse               | `services/mongodb.ts`, `services/redis.ts`, etc.                 |
| `@ai`          | search-ai, search-ai-runtime, bge-m3, docling, preprocessing | `services/search-ai.ts`, `services/bge-m3.ts`, etc.              |
| `@integration` | (all integration flow scripts)                               | `integration/agent-conversation-e2e.ts`, etc.                    |
| `@all`         | All services + integration (default when nothing specified)  | All scripts                                                      |

Categories resolve to service lists at runtime. You can combine categories with individual names: `SERVICES=@compute,bge-m3` runs compute services plus bge-m3.

#### Load Test Reports

Regular load tests produce two types of output:

| Execution Mode | Raw Output                                          | Structured Report                                                         |
| -------------- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| **Local**      | k6 console summary + JSON in `/tmp/k6-suite-*/`     | `pnpm cli sizing load-report --results /tmp/k6-suite-*/`                  |
| **Cloud**      | Grafana Cloud k6 dashboard (real-time + historical) | Dashboard link printed at end; also `sizing load-report --cloud --last 1` |

```bash
# Generate a load test report from local results
pnpm cli sizing load-report \
  --results /tmp/k6-suite-m-2026-03-25/ \
  --format md,pdf \
  --output-dir docs/benchmarks/

# Generate from most recent cloud run
pnpm cli sizing load-report \
  --cloud \
  --last 1 \
  --format md \
  --output-dir docs/benchmarks/

# Output:
#   docs/benchmarks/load-test-report-2026-03-25.md
#   docs/benchmarks/load-test-report-2026-03-25.pdf  (if --format includes pdf)
```

**Load test report sections:**

1. **Summary** — tier, duration, total requests, overall error rate, services tested
2. **Per-Service Results Table** — requests, error rate, p50/p95/p99 latency, throughput (RPS)
3. **Per-Service Detail** (per service) — scenario breakdown, per-scenario latency, threshold pass/fail
4. **Integration Flow Results** — end-to-end latency, success rate, bottleneck service
5. **SLA Compliance** — each SLA target vs measured result, pass/fail
6. **Comparison vs Previous Run** (if `--compare <previous-results-dir>` provided) — regression highlights

> **Note:** Load test reports show _performance at current replica count_. Saturation reports show _per-pod capacity ceiling_. They answer different questions — "Is the current deployment fast enough?" vs "How many pods do we actually need?"

### Run Saturation Benchmarks (Calibration Pipeline)

#### Service Selection for Saturation Tests

The `--services` flag controls which services to saturate. It accepts service names, integration script names, `@category` groups, or any combination — same patterns as load tests.

```bash
# Prerequisites for all saturation tests:
#   - kubectl access to AKS cluster (see Section 15 "Cluster Access Setup")
#   - Coroot MCP connected via .mcp.json
#   - cloud.env configured with target URLs, auth tokens, and K8S_NAMESPACE

# ── All services (default — omit --services) ────────────────────
pnpm cli sizing benchmark \
  --tier M \
  --output-calibration calibration.json \
  --output-report report.md \
  --output-pdf report.pdf
# Runs: pre-flight → per-service saturation → integration flows → combine → report

# ── Single service ──────────────────────────────────────────────
pnpm cli sizing benchmark \
  --tier M \
  --services runtime \
  --output-calibration calibration-runtime.json

# Or use the dedicated single-service command:
pnpm cli sizing benchmark-service \
  --service runtime \
  --tier M \
  --namespace abl-platform-dev

# ── Multiple specific services ──────────────────────────────────
pnpm cli sizing benchmark \
  --tier M \
  --services runtime,search-ai,bge-m3 \
  --output-calibration calibration-partial.json

# ── Single integration flow ────────────────────────────────────
pnpm cli sizing benchmark \
  --tier M \
  --services agent-conversation-e2e \
  --output-calibration calibration-agent-e2e.json

# ── Multiple integration flows ─────────────────────────────────
pnpm cli sizing benchmark \
  --tier M \
  --services agent-conversation-e2e,kb-ingestion-search-e2e \
  --output-calibration calibration-integration.json

# ── Mix services and integration flows ─────────────────────────
pnpm cli sizing benchmark \
  --tier M \
  --services runtime,search-ai,agent-conversation-e2e \
  --output-calibration calibration-mixed.json

# ── By category ────────────────────────────────────────────────
pnpm cli sizing benchmark \
  --tier M \
  --services @compute \
  --output-calibration calibration-compute.json

pnpm cli sizing benchmark \
  --tier M \
  --services @data-stores \
  --output-calibration calibration-datastores.json

# ── Mix categories and individual names ────────────────────────
pnpm cli sizing benchmark \
  --tier M \
  --services @compute,bge-m3,agent-conversation-e2e \
  --output-calibration calibration-custom.json

# ── Merge partial calibration files into one ───────────────────
pnpm cli sizing calibration-merge \
  --inputs calibration-compute.json,calibration-datastores.json,calibration-ai.json \
  --output calibration-combined.json
```

> **Tip:** Run data stores first (`@data-stores`), then compute (`@compute`), then AI (`@ai`). Data store saturation results inform whether app service bottlenecks are DB-bound.

#### With Custom Scenario Weights

```bash
# Customer with heavy tool usage
pnpm cli sizing benchmark --tier M \
  --scenario-weights "runtime:single_turn=0.30,multi_turn=0.20,tool_calling=0.40,concurrent=0.10" \
  --output-calibration calibration.json

# Customer with heavy multi-agent orchestration
pnpm cli sizing benchmark --tier M \
  --scenario-weights "multi-agent-orchestration:ws_multi_turn=0.50,concurrent=0.30,single_delegation=0.10,multi_delegation=0.10" \
  --output-calibration calibration.json
```

#### Dry Run (Show Plan Without Executing)

```bash
pnpm cli sizing benchmark \
  --tier M \
  --dry-run \
  --output-calibration calibration.json
# Shows: services to test, scale-down plan, estimated duration, scenario weights
```

### Use Calibration Results in Sizing Calculator

```bash
# 1. Generate questionnaire (fill in customer workload)
pnpm cli sizing questionnaire --output q.json

# 2. Calculate topology WITHOUT calibration (hardcoded baselines)
pnpm cli sizing calculate --input q.json --output topology-baseline.json

# 3. Calculate topology WITH calibration (measured per-pod capacity)
pnpm cli sizing calculate \
  --input q.json \
  --calibration calibration.json \
  --output topology-calibrated.json

# 4. Compare baseline vs calibrated
diff topology-baseline.json topology-calibrated.json

# 5. Generate Helm values from calibrated topology
pnpm cli sizing helm \
  --input topology-calibrated.json \
  --output-dir ./helm-values-calibrated/
```

### Generate Reports

Reports can be generated for both load tests and saturation benchmarks. They can also be regenerated from saved results without re-running tests.

#### Load Test Reports

```bash
# From local results (generated after local-run-suite.sh)
pnpm cli sizing load-report \
  --results /tmp/k6-suite-m-2026-03-25/ \
  --format md,pdf \
  --output-dir docs/benchmarks/

# From Grafana Cloud k6 (most recent run)
pnpm cli sizing load-report \
  --cloud \
  --last 1 \
  --format md \
  --output-dir docs/benchmarks/

# Compare against a previous run (highlights regressions)
pnpm cli sizing load-report \
  --results /tmp/k6-suite-m-2026-03-25/ \
  --compare /tmp/k6-suite-m-2026-03-20/ \
  --format md,pdf \
  --output-dir docs/benchmarks/

# Output:
#   docs/benchmarks/load-test-report-2026-03-25.md
#   docs/benchmarks/load-test-report-2026-03-25.pdf
```

#### Saturation / Calibration Reports

```bash
# From existing calibration file (internal + customer reports)
pnpm cli sizing report \
  --calibration calibration.json \
  --format md,pdf \
  --output-dir docs/benchmarks/

# With questionnaire (includes recommended topology section in customer report)
pnpm cli sizing report \
  --calibration calibration.json \
  --questionnaire q.json \
  --format md,pdf \
  --output-dir docs/benchmarks/

# Output:
#   docs/benchmarks/internal-report-2026-03-25.md    (platform team)
#   docs/benchmarks/customer-report-2026-03-25.md    (customer-facing)
#   docs/benchmarks/customer-report-2026-03-25.pdf   (customer-facing PDF)
```

#### Metrics Comparison — Load Tests vs Saturation Tests

Load tests and saturation tests capture different metrics because they answer different questions.

| Metric Category             | Load Tests                         | Saturation Tests                                                      | Why Different                                                        |
| --------------------------- | ---------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Latency (p50/p95/p99)**   | Per service, per scenario          | Per service, per scenario                                             | Same — both use k6 metrics                                           |
| **Throughput (RPS)**        | Achieved at current replicas       | Max RPS per single pod (ceiling)                                      | Load tests measure current capacity; saturation finds the limit      |
| **Error rate**              | Overall and per service            | Overall and per service                                               | Same — both use k6 checks                                            |
| **TTFT**                    | Per service (if streaming)         | Per service (if streaming)                                            | Same — k6 custom metric                                              |
| **WebSocket metrics**       | Connect latency, timeouts          | Connect latency, timeouts, **max connections/pod, memory/connection** | Saturation adds connection capacity ceiling and memory estimation    |
| **CPU utilization**         | Not captured                       | Per pod via Coroot MCP                                                | Load tests don't need kubectl/Coroot; saturation needs infra metrics |
| **Memory utilization**      | Not captured                       | Per pod via Coroot MCP                                                | Same reason                                                          |
| **Pod restarts / OOMKills** | Not captured                       | Per pod via Coroot MCP                                                | Only relevant when pushing a single pod to its limit                 |
| **Connection pool usage**   | Not captured                       | Per data store via Coroot MCP                                         | Data store saturation requires infra-level visibility                |
| **Disk I/O**                | Not captured                       | Per data store via Coroot MCP                                         | Same reason                                                          |
| **Saturation trigger**      | N/A                                | Which signal hit first (error/latency/CPU/connections)                | Only meaningful in saturation context                                |
| **Scenario weights**        | N/A (all scenarios run as defined) | Configurable blend for sizing                                         | Saturation uses weighted mix for realistic capacity measurement      |
| **Calibration delta**       | N/A                                | Measured vs hardcoded comparison                                      | Only saturation produces CalibrationProfile                          |
| **Integration bottleneck**  | Which service is slowest           | Which service saturates first, system ceiling RPS                     | Saturation identifies the weakest link in the chain                  |
| **SLA compliance**          | Pass/fail vs thresholds            | Pass/fail vs thresholds                                               | Same — both check k6 thresholds                                      |
| **Regression comparison**   | vs previous load test run          | N/A (each saturation is standalone)                                   | Load tests are run regularly; saturation is periodic                 |

**Summary:** Load tests capture **k6-level metrics** (latency, throughput, errors, SLA compliance) at the current deployment scale. Saturation tests capture everything load tests do **plus infrastructure metrics** (CPU, memory, connections, disk) via Coroot MCP, because they need to find the per-pod capacity ceiling. If you only need to know "is it fast enough?", run load tests. If you need to know "how many pods do we need?", run saturation tests.

### Smoke Tests

Verify all k6 benchmark scripts can initialize and execute without crashing — a fast sanity check before running full load or saturation tests.

```bash
# Run all scripts (services, integration, saturation)
./benchmarks/scripts/smoke-run.sh

# Filter by category
CATEGORY=services ./benchmarks/scripts/smoke-run.sh
CATEGORY=integration ./benchmarks/scripts/smoke-run.sh
CATEGORY=saturation ./benchmarks/scripts/smoke-run.sh

# Filter by service name or @category (same patterns as load tests)
SERVICES=runtime,studio ./benchmarks/scripts/smoke-run.sh
SERVICES=@compute ./benchmarks/scripts/smoke-run.sh
SERVICES=@ai,agent-conversation-e2e ./benchmarks/scripts/smoke-run.sh
```

The smoke suite:

- Runs each script with `k6 run --no-thresholds --vus 1 --iterations 1`
- **Pre-authenticates once** via dev-login + refresh, exports `AUTH_TOKEN` and `REFRESH_TOKEN` for all scripts (avoids 429 rate limiting)
- Reports PASS/FAIL per script with elapsed time
- Logs per-script output to `/tmp/k6-smoke-<timestamp>/`

### Token Management for Long Test Suites

```bash
# Problem: AUTH_TOKEN JWT expires in 15 minutes.
# A full suite (17 services + 6 integration) takes hours.

# Solution 1: Dev-login + auto-refresh (recommended, no manual tokens)
# Leave AUTH_TOKEN and REFRESH_TOKEN empty in cloud.env.
# Set DEV_LOGIN_EMAIL and DEV_LOGIN_NAME.
# The auth flow: dev-login → gets refresh_token from Set-Cookie →
# calls /api/auth/refresh with Cookie to get accessToken.
# Subsequent scripts reuse the refresh token (no repeated dev-logins).
# Requires dev-login endpoint enabled on Studio.

# Solution 2: Set REFRESH_TOKEN in cloud.env
# If you have a refresh token (from browser cookies), set it in cloud.env.
# The auth system calls /api/auth/refresh to get fresh access tokens.
# No dev-login calls needed.

# Solution 3: Set both AUTH_TOKEN and REFRESH_TOKEN in cloud.env
# AUTH_TOKEN used directly until it expires, then auto-refreshes
# via REFRESH_TOKEN. Useful when dev-login is disabled.

# Solution 4: Manually refresh mid-run
# Get a fresh token from Studio UI and update cloud.env.
# Re-source: source benchmarks/config/cloud.env
```

**Auth priority order** (in `benchmarks/lib/auth.ts`):

1. `AUTH_TOKEN` env var → use directly (refresh if near expiry)
2. `REFRESH_TOKEN` env var → call `/api/auth/refresh` (skip dev-login)
3. Dev-login → `POST /api/auth/dev-login` → extract refresh token from `Set-Cookie` → `POST /api/auth/refresh` with `Cookie: refresh_token=...` → get access token

### Troubleshooting

| Problem                                          | Cause                                           | Fix                                                                                       |
| ------------------------------------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `401 Unauthorized` during tests                  | AUTH_TOKEN expired, refresh failed              | Set REFRESH_TOKEN in cloud.env, or use dev-login (leave AUTH_TOKEN empty)                 |
| `429 Too many login attempts` in smoke/suite     | Each script calls dev-login, hitting rate limit | Use `smoke-run.sh` (pre-authenticates once), or set AUTH_TOKEN/REFRESH_TOKEN in cloud.env |
| `Bootstrap check fails: tenant has accessToken`  | Auth not working against target                 | Verify STUDIO_URL is correct, get fresh AUTH_TOKEN                                        |
| `MOCK_LLM configured but agent returns empty`    | Runtime missing `ENABLE_MOCK_LLM=true`          | Set env var on Runtime deployment                                                         |
| `Health check failed: connection refused`        | Service URL incorrect or service down           | Check service URL in cloud.env, verify service is running                                 |
| `k6 cloud run` fails with "project not found"    | Wrong K6_CLOUD_PROJECT_ID                       | Get correct ID from Grafana Cloud → k6 → Projects                                         |
| Private service skipped in cloud suite           | Cloud load zones can't reach private services   | Use local execution or configure Private Load Zones                                       |
| `WebSocket connection refused` during multi_turn | WS_MAX_CONNECTIONS limit hit or auth failed     | Check `Sec-WebSocket-Protocol` header, verify connection limits                           |
| Saturation test never reaches saturation         | Service under-loaded, VU ramp too small         | Increase max VUs in saturation script, check TIER setting                                 |
| Coroot data unavailable                          | MCP not connected or project ID wrong           | Verify `.mcp.json` config, check `--coroot-project` flag                                  |
| Token refresh returns 401                        | Refresh token expired or rotated                | Get fresh tokens from Studio UI                                                           |
| `k6 run` can't find imports                      | Running from wrong directory                    | Must run from `benchmarks/` directory (relative imports)                                  |

### End-to-End SE Workflow

```bash
# ═══════════════════════════════════════════════════════════════════
# Complete workflow: from zero to calibrated production deployment
# ═══════════════════════════════════════════════════════════════════

# ── Step 0: Prerequisites ─────────────────────────────────────────
brew install k6 azure-cli         # Install required tools
az login && az aks get-credentials --resource-group <rg> --name <cluster>
kubectl get nodes                  # Verify cluster access

cp benchmarks/config/cloud.env.example benchmarks/config/cloud.env
vim benchmarks/config/cloud.env   # Fill in target URLs, tokens, IDs, K8S_NAMESPACE

# ── Step 1: Bootstrap ─────────────────────────────────────────────
cd benchmarks && k6 run setup/bootstrap.ts && cd ..

# ── Step 1b: Smoke Test (verify all scripts work) ────────────────
./benchmarks/scripts/smoke-run.sh
# Expected: 22-24 PASS. Failures indicate unreachable services.

# ── Step 2: Initial Sizing (hardcoded, pre-benchmark) ─────────────
pnpm cli sizing questionnaire --output q.json
# Edit q.json with customer's workload numbers
pnpm cli sizing calculate --input q.json --output topology.json
pnpm cli sizing helm --input topology.json --output-dir ./helm-values/
# Deploy to cluster with these initial Helm values...

# ── Step 3: Run Regular Load Tests (validate basics) ──────────────
TIER=m ./benchmarks/scripts/local-run-suite.sh
# or: ./benchmarks/scripts/cloud-run-suite.sh

# ── Step 4: Run Saturation Benchmarks (measure per-pod capacity) ──
pnpm cli sizing benchmark \
  --tier M \
  --output-calibration calibration.json \
  --output-report docs/benchmarks/report.md \
  --output-pdf docs/benchmarks/report.pdf

# ── Step 5: Re-Size with Measured Data ────────────────────────────
pnpm cli sizing calculate \
  --input q.json \
  --calibration calibration.json \
  --output topology-calibrated.json

# ── Step 6: Generate Calibrated Helm Values ───────────────────────
pnpm cli sizing helm \
  --input topology-calibrated.json \
  --output-dir ./helm-values-calibrated/
# Re-deploy with calibrated values...

# ── Step 7: Validate (optional re-run) ────────────────────────────
# Run load tests again against the calibrated deployment
TIER=m ./benchmarks/scripts/cloud-run-suite.sh
./benchmarks/scripts/cloud-results.sh --last 10

# ── Step 8: Deliver to Customer ───────────────────────────────────
# Deliverables:
#   - docs/benchmarks/report.pdf            (customer-facing)
#   - topology-calibrated.json              (recommended topology)
#   - helm-values-calibrated/               (production Helm values)
#   - calibration.json                      (raw data, internal)
```

---

## 17. Design Decisions

| #   | Decision                 | Choice                                                                    | Rationale                                                                                   |
| --- | ------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | Saturation test approach | Scale-down to 1 replica                                                   | Most accurate per-pod measurement                                                           |
| 2   | Dependency handling      | Isolate target, overprovision dependencies                                | Clean per-service capacity without downstream bottlenecks                                   |
| 3   | Coroot collection timing | Post-test time-range query                                                | One call per service, Coroot already stores time-series data                                |
| 4   | Saturation detection     | Multi-signal (error >1%, p95 >2× baseline, CPU >85%)                      | Most conservative — earliest signal is the real capacity limit                              |
| 5   | Report scope             | Internal engineering + customer-facing                                    | Internal for calibration, customer for delivery                                             |
| 6   | PDF toolchain            | md-to-pdf (npm)                                                           | Stays in Node ecosystem, no system-level installs                                           |
| 7   | Architecture             | CLI-orchestrated pipeline                                                 | Scriptable, CI/CD friendly, extends existing CLI                                            |
| 8   | Traffic model            | Standard enterprise (8h, 40/60 split)                                     | Hardcoded default, not exposed in questionnaire                                             |
| 9   | RPS priority             | Concurrent fields win over daily volumes                                  | User-provided peak load takes precedence                                                    |
| 10  | Latency metrics          | p50/p95/p99/min/max                                                       | Full distribution for all services and data stores                                          |
| 11  | Metrics source           | Coroot MCP tools only                                                     | No Prometheus available; future flag for it                                                 |
| 12  | Sizing calculator        | Optional CalibrationProfile, hardcoded fallback                           | Backward compatible                                                                         |
| 13  | Service URLs             | Reuse cloud.env + config.ts                                               | No new CLI flags, existing infrastructure handles it                                        |
| 14  | Service access           | Public/private derived from config                                        | Ingress from cloud.env, private defaults from config.ts                                     |
| 15  | Bootstrap execution      | Always local (k6 run, 1 VU, 1 iteration)                                  | Bootstrap is idempotent setup — no need for cloud load zones                                |
| 16  | k6 execution modes       | Local for saturation, cloud for regular load tests                        | Saturation needs kubectl + Coroot MCP; regular tests benefit from cloud dashboards          |
| 17  | Auth token management    | Auto-refresh via REFRESH_TOKEN + dev-login fallback                       | 15-min JWT TTL too short for multi-hour test suites                                         |
| 18  | Cloud private services   | Skip in cloud mode, require Private Load Zones                            | Private services not reachable from Grafana Cloud load zones                                |
| 19  | Scenario strategy        | Blended workload for sizing, per-scenario for reports                     | Production traffic is always a mix; per-scenario identifies bottlenecks                     |
| 20  | Scenario weights         | Configurable per service with sensible defaults                           | Different customers have different traffic patterns                                         |
| 21  | WebSocket saturation     | Connection ramp test separate from HTTP RPS test                          | WS connections are long-lived; pod saturates on connection count, not just RPS              |
| 22  | Two-dimensional sizing   | max(replicas for RPS, replicas for connections)                           | Whichever dimension is the bottleneck determines the pod count                              |
| 23  | Integration testing      | Full-system saturation after per-service calibration                      | Cross-service bottlenecks invisible in isolation; validates combined SLA compliance         |
| 24  | Integration approach     | All services at calibrated replicas (no scale-down)                       | Tests the real deployment, catches connection pool/queue/cascading issues                   |
| 25  | Cluster access           | Azure AKS via `az aks get-credentials`                                    | Platform runs on AKS; credentials, RBAC, and infra config live in `abl-platform-infra` repo |
| 26  | Service groups           | `@category` shorthand (`@compute`, `@data-stores`, `@ai`, `@integration`) | Run subsets without memorizing service names; combine categories with individual names      |
| 27  | Load test reports        | Separate `sizing load-report` command from saturation reports             | Different questions: "fast enough at current scale?" vs "how many pods needed?"             |
| 28  | Calibration merge        | `sizing calibration-merge` for partial → combined                         | Allows phased saturation runs (data stores → compute → AI) merged into one file             |

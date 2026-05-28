# ABL Platform Benchmarks

k6-based benchmark suite for service load testing, integration E2E testing, saturation testing, and infrastructure metrics collection. Generates reports with per-service latency, throughput, error rates, and infrastructure metrics (CPU, memory, connections, disk, OOM kills, pod restarts).

## Prerequisites

**Required:**

- **k6** — `brew install k6` or [k6.io/docs/get-started](https://k6.io/docs/get-started/installation/)
- **Node.js 18+** and **pnpm**
- **`benchmarks/config/cloud.env`** — copy from `cloud.env.example` and fill in target URLs, auth credentials, tenant/project IDs

**For infrastructure metrics (optional but recommended):**

- **Coroot** (primary) — set `COROOT_BASE_URL`, `COROOT_USERNAME`, `COROOT_PASSWORD`, `COROOT_PROJECT_ID` in `cloud.env`
- **kubectl** (fallback) — configured with cluster access for `kubectl top pods`

**kubectl access (AWS EKS):**

```bash
# 1. Install AWS CLI and kubectl
brew install awscli kubectl

# 2. Configure AWS credentials (SSO or access keys)
aws configure                          # access key method
aws sso login --profile <profile>      # SSO method

# 3. Update kubeconfig for your EKS cluster
aws eks update-kubeconfig \
  --region <region> \
  --name <cluster-name> \
  --alias <cluster-alias>

# Example for dev cluster:
aws eks update-kubeconfig \
  --region us-east-1 \
  --name abl-platform-dev \
  --alias abl-dev

# 4. Verify access
kubectl get namespaces
kubectl top pods -n abl-platform-dev

# 5. (Optional) Switch context if you have multiple clusters
kubectl config get-contexts
kubectl config use-context abl-dev
```

**kubectl access (Azure AKS):**

```bash
# 1. Install Azure CLI and kubectl
brew install azure-cli kubectl

# 2. Login to Azure
az login                               # browser-based login
az login --use-device-code             # headless/remote

# 3. Set your subscription
az account set --subscription <subscription-id>

# 4. Get AKS credentials (merges into ~/.kube/config)
az aks get-credentials \
  --resource-group <resource-group> \
  --name <cluster-name>

# Example for dev cluster:
az aks get-credentials \
  --resource-group abl-platform-rg \
  --name abl-platform-dev

# 5. Verify access
kubectl get namespaces
kubectl top pods -n abl-platform-dev

# 6. (Optional) Switch context if you have multiple clusters
kubectl config get-contexts
kubectl config use-context abl-platform-dev
```

**For k6 Cloud execution (optional):**

- **k6 Cloud account** — set `K6_CLOUD_TOKEN` and `K6_CLOUD_PROJECT_ID` in `cloud.env`

**For PDF reports (optional):**

- **Chromium/Chrome** — required by `md-to-pdf` for `--format pdf`

**Bootstrap (first time only):**

Before running benchmarks against a target environment, bootstrap the test data:

```bash
# Creates benchmark agents, KBs, indexes, and test conversations
pnpm cli sizing bootstrap --namespace abl-platform-dev
```

## Config Snapshots

Reusable benchmark math inputs live under `benchmarks/config/`.

- `benchmarks/config/theoretical-math/` stores fixed infra assumptions and live-captured sizing snapshots that we reuse for capacity math and saturation estimates.
- `benchmarks/config/datastore-study/` stores proposed scenario matrices for practical datastore-focused load experiments.

## Quick Start

```bash
# 1. Configure your environment
cp benchmarks/config/cloud.env.example benchmarks/config/cloud.env
# Edit cloud.env with your target URLs, credentials, and optionally Coroot config

# 2. Build the CLI
pnpm build --filter=@agent-platform/cli

# 3. Run smoke tests first (quick sanity check — 1 VU, 1 iteration)
pnpm cli sizing service-smoke --services runtime
pnpm cli sizing integration-smoke --services runtime
pnpm cli sizing saturation-smoke --services runtime

# 4. Run full tests
pnpm cli sizing service-test --tier s --services runtime
pnpm cli sizing integration-test --tier s --services runtime
pnpm cli sizing saturation-test --tier s --services runtime
```

## Commands

### `sizing service-test`

Runs per-service load benchmarks (`services/*.ts`). Each script exercises a single service with configurable VU counts and scenarios (single-turn, multi-turn, tool-calling, concurrent ramp). VU counts are controlled by `--tier` (from `tier-profiles.json`) or `--vus` (explicit override).

```bash
# All services
pnpm cli sizing service-test --tier s

# One service
pnpm cli sizing service-test --tier s --services runtime

# Multiple services
pnpm cli sizing service-test --tier s --services runtime,search-ai,redis

# Service category
pnpm cli sizing service-test --tier s --services @compute

# Custom VU count (overrides tier profile)
pnpm cli sizing service-test --tier s --services runtime --vus 50

# On k6 Cloud
pnpm cli sizing service-test --tier m --services runtime --cloud

# With comparison + PDF
pnpm cli sizing service-test --tier s --compare ./results/previous/ --format pdf

# Skip infra / skip report
pnpm cli sizing service-test --tier s --skip-infra
pnpm cli sizing service-test --tier s --skip-report
```

### `sizing integration-test`

Runs integration E2E flow tests (`integration/*.ts`). Each script exercises a multi-service flow end-to-end (agent conversations, KB ingestion, search queries, etc.).

```bash
# All integration tests
pnpm cli sizing integration-test --tier s

# Filter by service — runs integration scripts that exercise runtime
pnpm cli sizing integration-test --tier s --services runtime

# Filter by script name
pnpm cli sizing integration-test --tier s --services kb-ingestion-e2e

# On k6 Cloud
pnpm cli sizing integration-test --tier m --cloud
```

**Available integration scripts:**

| Script                      | Services Tested |
| --------------------------- | --------------- |
| `agent-conversation-e2e`    | runtime         |
| `multi-agent-orchestration` | runtime         |
| `kb-ingestion-e2e`          | search-ai       |
| `search-query-e2e`          | search-ai       |
| `channel-message-e2e`       | runtime, studio |
| `workflow-execution-e2e`    | workflow-engine |

### `sizing saturation-test`

Runs ramp-to-saturation tests (`saturation/*.ts`) to find the breaking point of each service. Uses blended weighted scenarios with ramping VU counts.

```bash
# All available saturation scripts
pnpm cli sizing saturation-test --tier s

# Single service
pnpm cli sizing saturation-test --tier s --services runtime

# Custom VU count and duration
pnpm cli sizing saturation-test --tier s --services runtime --vus 300 --duration 30

# On k6 Cloud
pnpm cli sizing saturation-test --tier m --services runtime --cloud
```

**Available saturation scripts:** `runtime`, `search-ai`, `bge-m3`

### `sizing saturation-find`

Auto-discovers the VU tipping point using adaptive binary search. Starts with exponential growth (doubling VUs each run) until the service becomes unhealthy, then narrows with binary refinement. Stops after convergence or max runs.

**Health criteria (all must pass):** error rate < 1%, p95 < 2,000 ms, no OOM kills.

```bash
# Auto-find tipping point for runtime (default: start 10 VUs, 10m per run, max 5 runs)
pnpm cli sizing saturation-find --services runtime --tier s

# On k6 Cloud
pnpm cli sizing saturation-find --services runtime --tier s --cloud

# Custom: start at 20 VUs, 15m per run, up to 7 runs
pnpm cli sizing saturation-find --services runtime --start-vus 20 --duration 15 --max-runs 7

# Tighter convergence (minimum 2 VU step)
pnpm cli sizing saturation-find --services runtime --start-vus 10 --min-step 2
```

**`saturation-find` flags:**

| Flag                | Default   | Description                                                      |
| ------------------- | --------- | ---------------------------------------------------------------- |
| `--services <list>` | `runtime` | Comma-separated services (available: runtime, search-ai, bge-m3) |
| `--tier <tier>`     | `s`       | Deployment tier                                                  |
| `--cloud`           | `false`   | Run on k6 Cloud                                                  |
| `--start-vus <n>`   | `10`      | Starting VU count for the first run                              |
| `--max-runs <n>`    | `5`       | Maximum number of test runs                                      |
| `--duration <min>`  | `10`      | Duration per run in minutes                                      |
| `--min-step <n>`    | `5`       | Minimum VU step to stop binary search                            |
| `--format <fmt>`    | `md`      | Report format: md or pdf                                         |
| `--skip-infra`      | `false`   | Skip infrastructure metrics collection                           |
| `--namespace <ns>`  | `abl`     | Kubernetes namespace                                             |

**Algorithm example (5 runs):**

```
Run 1: 10 VUs  → HEALTHY           (growth phase — double)
Run 2: 20 VUs  → HEALTHY           (growth phase — double)
Run 3: 40 VUs  → UNHEALTHY (p95)   (switch to refinement)
Run 4: 30 VUs  → HEALTHY           (binary search midpoint)
Run 5: 35 VUs  → UNHEALTHY (error) (converged: tipping point ≈ 30 VUs)
```

### Smoke Tests

Quick sanity checks that run each script with **1 VU, 1 iteration, no thresholds**. Use these to verify scripts can initialize, authenticate, and complete at least one request before running the full suite.

```bash
# Service smoke — all or filtered
pnpm cli sizing service-smoke
pnpm cli sizing service-smoke --services runtime
pnpm cli sizing service-smoke --services runtime,search-ai

# Integration smoke — all or filtered
pnpm cli sizing integration-smoke
pnpm cli sizing integration-smoke --services runtime
pnpm cli sizing integration-smoke --services kb-ingestion-e2e

# Saturation smoke — all or filtered
pnpm cli sizing saturation-smoke
pnpm cli sizing saturation-smoke --services runtime
```

### npm Scripts (from `benchmarks/`)

```bash
# Service tests
pnpm service-test                                       # all services
pnpm service-test -- --services runtime                 # one service
pnpm service-test -- --services runtime,search-ai       # multiple

# Integration tests
pnpm integration-test                                   # all
pnpm integration-test -- --services runtime             # filter by service
pnpm integration-test -- --services kb-ingestion-e2e    # filter by script name

# Saturation tests
pnpm saturation-test                                    # all
pnpm saturation-test -- --services runtime --cloud      # one service, cloud

# Saturation find (auto-discover tipping point)
pnpm cli sizing saturation-find --services runtime --tier s
pnpm cli sizing saturation-find --services runtime --cloud --start-vus 20

# Smoke tests
pnpm service-smoke                                      # all service scripts
pnpm service-smoke -- --services runtime                # one service
pnpm integration-smoke                                  # all integration scripts
pnpm saturation-smoke                                   # all saturation scripts
```

### `sizing load-report`

Generate reports from local k6 JSON results or k6 Cloud API. Supports filtering by service and test type.

```bash
# Generate report from local k6 JSON results
pnpm cli sizing load-report --results ./results/saturation-s-*/ --tier s --output-dir ./results/

# Generate report from k6 Cloud results (latest run per test)
pnpm cli sizing load-report --cloud --tier s --output-dir ./results/

# Filter to only runtime saturation tests from k6 Cloud
pnpm cli sizing load-report --cloud --services runtime --test-type saturation --tier s

# Filter to only integration tests
pnpm cli sizing load-report --cloud --test-type integration --tier s

# Multiple services
pnpm cli sizing load-report --cloud --services runtime,search-ai --tier s

# Average metrics across the last 3 runs per test (smooths outliers)
pnpm cli sizing load-report --cloud --last 3 --services runtime --tier s

# Include infrastructure metrics (collected during test run)
pnpm cli sizing load-report --results ./results/ --tier s \
  --infra-metrics ./results/infra-metrics.json

# PDF output
pnpm cli sizing load-report --cloud --services runtime --tier s --format pdf
```

**`load-report` flags:**

| Flag                     | Default | Description                                                          |
| ------------------------ | ------- | -------------------------------------------------------------------- |
| `--results <dir>`        | —       | Directory containing k6 JSON summaries (local mode)                  |
| `--cloud`                | `false` | Fetch results from k6 Cloud API                                      |
| `--services <list>`      | all     | Comma-separated — filters cloud tests by name match                  |
| `--test-type <type>`     | all     | Filter cloud tests: `saturation`, `service`, or `integration`        |
| `--tier <s\|m\|l\|xl>`   | —       | Adds tier config (VUs, parallelism, duration) to report              |
| `--last <count>`         | `1`     | Average metrics across last N cloud runs per test                    |
| `--infra-metrics <path>` | —       | Path to infra metrics JSON (adds CPU, memory, connections to report) |
| `--compare <dir>`        | —       | Previous results directory for comparison                            |
| `--format <md\|pdf>`     | `md`    | Report output format                                                 |
| `--output-dir <dir>`     | `.`     | Output directory for generated reports                               |

### Legacy Commands

```bash
# Shell-based suite (runs service + integration scripts)
TIER=s SERVICES=runtime ./benchmarks/scripts/local-run-suite.sh
```

## Common Flags (all three commands)

| Flag                        | Default        | Description                                                                                     |
| --------------------------- | -------------- | ----------------------------------------------------------------------------------------------- |
| `--tier <s\|m\|l\|xl>`      | `s`            | VU count and duration from `config/tier-profiles.json`                                          |
| `--services <list>`         | `@all`         | Comma-separated services, script names, or categories                                           |
| `--cloud`                   | `false`        | Run on k6 Cloud instead of locally                                                              |
| `--vus <count>`             | from tier      | Override total VU count. Scripts scale all scenario VUs proportionally. Overrides tier profile. |
| `--duration <minutes>`      | from tier      | Override test duration in minutes (saturation tests only)                                       |
| `--output-dir <dir>`        | auto-generated | Results + report output directory                                                               |
| `--compare <dir>`           | —              | Previous results directory for run-over-run comparison                                          |
| `--last <count>`            | `1`            | Average metrics across the last N cloud runs per test (cloud mode only)                         |
| `--format <md\|pdf>`        | `md`           | Report output format                                                                            |
| `--namespace <ns>`          | `abl`          | Kubernetes namespace for infra metrics                                                          |
| `--skip-infra`              | `false`        | Skip infrastructure metrics collection                                                          |
| `--skip-report`             | `false`        | Run tests only, no report generation                                                            |
| `--scenario-weights <json>` | —              | Override scenario weights as JSON (must sum to 1.0)                                             |

## Service Categories (for `--services`)

| Category       | Services                                                              |
| -------------- | --------------------------------------------------------------------- |
| `@all`         | All services below                                                    |
| `@compute`     | runtime, studio, admin, search-ai, search-ai-runtime, workflow-engine |
| `@data-stores` | mongodb, redis, clickhouse, opensearch, qdrant, neo4j                 |
| `@ai`          | bge-m3, docling, preprocessing                                        |

## Infrastructure Metrics

All three commands automatically collect infrastructure metrics after running tests.

### Coroot (Primary)

When `COROOT_BASE_URL`, `COROOT_USERNAME`, `COROOT_PASSWORD`, and `COROOT_PROJECT_ID` are set in `cloud.env`, the CLI queries the Coroot REST API for metrics during the test time window:

**App Services:** CPU peak/avg, memory peak/avg, pod restarts, OOM kills, observed RPS, error rate

**Data Stores:** Connection pool (used/max/utilization%), disk usage, disk growth rate, CPU, memory

### kubectl top (Fallback)

When Coroot is not configured or unreachable, the CLI falls back to `kubectl top pods` for basic CPU and memory metrics. Connection pool, disk, OOM, and restart data are not available in this mode.

### Skipping Infra Metrics

Use `--skip-infra` to skip infrastructure metrics collection entirely (useful for local development without a cluster).

## Configuration

### `benchmarks/config/cloud.env`

Central configuration file for all benchmark commands. Auto-loaded by the CLI (no need to `source` manually).

```bash
# Target environment
RUNTIME_URL=https://staging.example.com/api
STUDIO_URL=https://staging.example.com
SEARCH_AI_URL=https://staging.example.com/api/search-ai

# WebSocket URL — ingress routes /ws directly to runtime (NOT under /api)
# Auto-derived from INGRESS_BASE if not set. Only needed if WS path differs.
# WS_URL=wss://staging.example.com/ws

# Auth
TENANT_ID=your-tenant-id
PROJECT_ID=your-project-id

# k6 Cloud (optional)
K6_CLOUD_TOKEN=your-token
K6_CLOUD_PROJECT_ID=your-project-id

# Coroot (optional — enables rich infra metrics)
COROOT_BASE_URL=https://coroot.example.com
COROOT_USERNAME=admin
COROOT_PASSWORD=your-password
COROOT_PROJECT_ID=your-coroot-project-id

# Bootstrap safety (optional)
# Set to 'true' to allow cross-project agent cleanup on 409 conflicts.
# Without this, bootstrap fails with a descriptive error if the agent name
# collides with one in another project. Only benchmark_-prefixed agents
# can be cleaned up even when enabled.
BENCHMARK_CLEANUP_CONFLICTS=false
```

See `cloud.env.example` for all available options.

### `benchmarks/config/tier-profiles.json`

Defines VU counts, parallelism, and duration for each tier (s/m/l/xl). The CLI passes the tier's VU count as `MAX_VUS` env var to k6 scripts, which scale all scenario VU counts proportionally.

| Tier | Service VUs | Integration VUs | Saturation VUs | Parallelism |
| ---- | ----------: | --------------: | -------------: | ----------: |
| s    |          10 |               5 |             20 |           1 |
| m    |          50 |              20 |             50 |           4 |
| l    |         200 |             100 |            100 |           8 |
| xl   |         500 |             250 |            200 |          16 |

**VU priority:** `--vus` CLI flag > tier profile > script defaults. When neither `--vus` nor a matching tier profile is found, scripts use their hardcoded defaults.

## Scenario Weights

Saturation tests use weighted VU distribution across scenarios. Each scenario gets a proportion of the total VUs. Default weights are defined in `benchmarks/lib/saturation-utils.ts`.

**Default runtime weights:**

| Scenario       | Weight | VUs (at 200 max) |
| -------------- | -----: | ---------------: |
| `single_turn`  |    50% |              100 |
| `multi_turn`   |    25% |               50 |
| `tool_calling` |    15% |               30 |
| `concurrent`   |    10% |               20 |

**Override via CLI:**

```bash
# Custom weights — must sum to 1.0
pnpm cli sizing saturation-test --tier s --services runtime \
  --scenario-weights '{"single_turn":0.4,"multi_turn":0.3,"tool_calling":0.2,"concurrent":0.1}'

# Focus on tool calling
pnpm cli sizing saturation-test --tier s --services runtime \
  --scenario-weights '{"single_turn":0.3,"multi_turn":0.2,"tool_calling":0.4,"concurrent":0.1}'

# Only two scenarios (omitted ones get 0 VUs)
pnpm cli sizing saturation-test --tier s --services runtime \
  --scenario-weights '{"single_turn":0.6,"multi_turn":0.4}'
```

**Available scenarios per service:**

| Service   | Scenarios                                                 |
| --------- | --------------------------------------------------------- |
| runtime   | `single_turn`, `multi_turn`, `tool_calling`, `concurrent` |
| search-ai | `kb_operations`, `document_ops`, `crawl_submit`           |
| bge-m3    | `single_embed`, `batch_embed`, `concurrent_embed`         |

## Report Contents

Generated reports include:

- **Test Configuration** — tier, VUs, iterations, parallelism, start/end time, duration (from `tier-profiles.json`)
- **Per-Service Summary Table** — requests, VUs, iterations, error rate, throughput, avg, median, p90/p95/p99/max latency
- **Scenario Weights** — VU distribution per scenario for each tested service (from `config/scenario-weights.json`)
- **Per-Service Detail** — latency distribution (min, avg, median, p90, p95, p99, max), per-scenario breakdown with custom metric latencies, HTTP status codes
- **Infrastructure Overview** — replicas, ready count, CPU/memory requests and limits for all platform services (Deployments and StatefulSets)
- **Infrastructure Metrics** — CPU peak/avg, memory peak/avg, pod restarts, OOM kills, RPS (from Coroot or kubectl)
- **Data Store Metrics** — connection pool utilization, disk usage, growth rate
- **Per-Pod Capacity** — measured throughput per pod (RPS/pod, VUs/pod), health status based on error rate and p95 latency. Use to estimate required replicas for a target throughput: `replicas = target_rps / rps_per_pod`
- **SLA Compliance** — pass/fail against defined thresholds
- **Run-over-Run Comparison** — throughput, latency, and error rate changes with regression/improvement detection

**Cloud vs Local reports:** Both cloud (`--cloud`) and local execution produce the same report structure. Cloud mode fetches metrics from the k6 Cloud API (with real p99 and avg via `histogram_quantile` and `avg()` queries). Local mode reads k6 JSON summaries (p99 is extrapolated from p90/p95, capped at max). Infrastructure metrics and per-pod capacity are included in both modes when cluster access is available.

## Directory Structure

```
benchmarks/
├── config/
│   ├── cloud.env              # Environment configuration (git-ignored)
│   ├── cloud.env.example      # Template for cloud.env
│   ├── tier-profiles.json     # VU/duration/parallelism per tier
│   └── scenario-weights.json  # Scenario VU weight distribution per service
├── services/                  # Per-service k6 scripts (service-test)
│   ├── runtime.ts
│   ├── search-ai.ts
│   ├── mongodb.ts
│   └── ...
├── saturation/                # Ramp-to-saturation k6 scripts (saturation-test)
│   ├── runtime.ts
│   ├── search-ai.ts
│   └── bge-m3.ts
├── integration/               # E2E integration flow scripts (integration-test)
│   ├── agent-conversation-e2e.ts
│   ├── kb-ingestion-e2e.ts
│   └── ...
├── lib/                       # Shared k6 helpers
│   ├── auth.ts                # Token management + auto-refresh
│   ├── config.ts              # URL/env configuration (incl. wsUrl)
│   ├── metrics.ts             # Custom k6 metrics
│   ├── saturation-utils.ts    # Blended scenario builder
│   └── vu-scaling.ts          # VU scaling via MAX_VUS env var
├── setup/                     # Bootstrap scripts (create agents, KBs, etc.)
├── report/
│   ├── templates/             # Handlebars report templates
│   │   ├── load-test.hbs
│   │   ├── saturation-find.hbs
│   │   ├── internal.hbs
│   │   └── customer.hbs
│   └── styles/
│       └── customer-report.css
├── results/                   # Output directory for test results + reports
├── scripts/                   # Shell wrapper scripts (legacy)
└── package.json
```

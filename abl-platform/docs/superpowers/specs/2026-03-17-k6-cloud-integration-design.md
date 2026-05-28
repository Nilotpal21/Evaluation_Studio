# Grafana k6 Cloud Integration for ABL Platform Load Testing

**Date:** 2026-03-17
**Status:** Draft
**Driver:** Evaluate k6 Cloud as execution platform for benchmarks — better dashboards, geo-distributed load, less infra management
**Dependencies:** Existing k6 benchmark suite (`benchmarks/`), load testing bootstrap (just implemented), Grafana Cloud Pro account with k6 enabled

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Configuration & Scripts](#3-configuration--scripts)
4. [k6 Cloud Setup Steps](#4-k6-cloud-setup-steps)
5. [Dashboard Organization](#5-dashboard-organization)
6. [Private Load Zones (Phase 2)](#6-private-load-zones-phase-2)
7. [k6 Operator vs k6 Cloud Decision Framework](#7-k6-operator-vs-k6-cloud-decision-framework)
8. [Cost & Plan Limits](#8-cost--plan-limits)

---

## 1. Overview

### Goal

Evaluate Grafana k6 Cloud as an execution platform for ABL Platform benchmarks, running the same scripts that currently execute via the k6 Operator. k6 Cloud provides managed load generation, built-in dashboards, historical comparison, and shareable results — without maintaining Prometheus + Grafana + k6 Operator infrastructure.

### Approach

- **Same scripts, run anywhere** — one codebase, no cloud-specific forks. Scripts use `__ENV` vars for URLs and `options.cloud` for Cloud metadata. The `options.cloud` block is ignored when running locally or via k6 Operator.
- **Phase 1:** Cloud execution against the public staging ingress URL for application-level benchmarks (Runtime, Search AI, BGE-M3, integration E2Es).
- **Phase 2:** Private Load Zones for internal data store benchmarks (MongoDB, Redis, OpenSearch, etc.) that aren't exposed via public ingress.

### Grafana Cloud k6 Pro Plan

| Limit              | Value                                  |
| ------------------ | -------------------------------------- |
| Max concurrent VUs | 3,500                                  |
| Monthly VU-hours   | 600                                    |
| Max test duration  | 1 hour (extendable)                    |
| Data retention     | 12 months                              |
| Load zones         | 21 public regions + Private Load Zones |
| Team members       | Unlimited                              |

---

## 2. Architecture

### Execution Comparison

| Aspect     | k6 Operator (current)                         | k6 Cloud (new)                            |
| ---------- | --------------------------------------------- | ----------------------------------------- |
| Execution  | k6 runner pods inside K8s cluster             | Grafana Cloud managed load generators     |
| Target     | Internal K8s service URLs                     | Public ingress URL                        |
| Results    | Prometheus Remote Write → self-hosted Grafana | k6 Cloud dashboard (Grafana Cloud)        |
| Trigger    | `kubectl apply -f TestRun` CRD                | `k6 cloud run script.ts` CLI or Cloud API |
| Cost       | Cluster compute (free after infra)            | VU-hours from Pro plan                    |
| Sharing    | Requires VPN/cluster access                   | Shareable URL, PDF export                 |
| Historical | Limited by Prometheus retention               | 12 months automatic                       |

### Script Changes

Each script gets a `cloud` block added to the existing `options` export:

```typescript
export const options = {
  // ... existing scenarios and thresholds unchanged ...
  cloud: {
    projectID: __ENV.K6_CLOUD_PROJECT_ID || undefined,
    name: 'runtime-per-service',
    tags: {
      service: 'runtime',
      type: 'per-service',
      tier: __ENV.TIER || 'm',
      env: __ENV.ENV || 'staging',
    },
  },
};
```

This block is **ignored** when running via `k6 run` (local) or k6 Operator. It only activates when using `k6 cloud run`.

### Execution Modes (all use same script)

```bash
# Local (dev)
k6 run benchmarks/services/runtime.ts \
  -e RUNTIME_URL=http://localhost:3112

# k6 Operator (staging K8s)
kubectl apply -f benchmarks/k8s/testrun-setup.yaml

# k6 Cloud (new)
K6_CLOUD_TOKEN=xxx k6 cloud run benchmarks/services/runtime.ts \
  -e RUNTIME_URL=https://staging.abl-platform.com \
  -e TIER=m -e ENV=staging
```

---

## 3. Configuration & Scripts

### New Files

| File                                    | Purpose                                        |
| --------------------------------------- | ---------------------------------------------- |
| `benchmarks/config/cloud.env.example`   | Template for k6 Cloud env vars                 |
| `benchmarks/scripts/cloud-run.sh`       | Wrapper to run a single benchmark on k6 Cloud  |
| `benchmarks/scripts/cloud-run-suite.sh` | Wrapper to run all critical scripts as a batch |

### cloud.env.example

```bash
# Grafana k6 Cloud credentials
K6_CLOUD_TOKEN=your-api-token-here
K6_CLOUD_PROJECT_ID=your-project-id

# Target environment
STAGING_URL=https://staging.abl-platform.com
ENV=staging
TIER=m

# Auth (benchmark user token for the staging environment)
AUTH_TOKEN=your-staging-auth-token
TENANT_ID=benchmark-tenant
PROJECT_ID=benchmark-project
```

`cloud.env` is gitignored. Only the `.example` template is committed.

### cloud-run.sh

Wrapper script to run any benchmark on k6 Cloud:

```bash
./benchmarks/scripts/cloud-run.sh benchmarks/services/runtime.ts

# Override tier
TIER=l ./benchmarks/scripts/cloud-run.sh benchmarks/services/runtime.ts

# Override target URL
STAGING_URL=https://demo.abl-platform.com ./benchmarks/scripts/cloud-run.sh \
  benchmarks/integration/agent-conversation-e2e.ts
```

The wrapper:

1. Sources `cloud.env` for credentials
2. Maps `STAGING_URL` to all service URL env vars (`RUNTIME_URL`, `STUDIO_URL`, `SEARCH_AI_URL`, etc.)
3. Invokes `k6 cloud run <script>` with all env vars
4. Prints the k6 Cloud test URL for viewing results

### cloud-run-suite.sh

Runs all 8 critical per-service scripts + 3 integration E2Es as a sequential batch:

```bash
./benchmarks/scripts/cloud-run-suite.sh

# Override tier
TIER=l ./benchmarks/scripts/cloud-run-suite.sh
```

**Suite scripts (11 total):**

Per-service (5): `runtime.ts`, `search-ai.ts`, `bge-m3.ts`, `mongodb.ts`, `opensearch.ts`

Integration (3): `agent-conversation-e2e.ts`, `kb-ingestion-e2e.ts`, `search-query-e2e.ts`

_Note: `mongodb.ts` and `opensearch.ts` will only work via k6 Cloud in Phase 2 (Private Load Zones). In Phase 1, the suite script skips them and logs a warning._

### URL Mapping

When running on k6 Cloud, all service URLs point to the public ingress:

| Service   | k6 Operator (internal)                   | k6 Cloud (public)                         |
| --------- | ---------------------------------------- | ----------------------------------------- |
| Runtime   | `http://runtime.abl-platform.svc:3112`   | `https://staging.abl-platform.com`        |
| Studio    | `http://studio.abl-platform.svc:5173`    | `https://staging.abl-platform.com`        |
| Search AI | `http://search-ai.abl-platform.svc:3113` | `https://staging.abl-platform.com`        |
| BGE-M3    | `http://bge-m3.abl-platform.svc:8000`    | `https://staging.abl-platform.com/bge-m3` |

The scripts already read URLs from `__ENV` via `benchmarks/lib/config.ts`. The wrapper script sets these to the public ingress.

---

## 4. k6 Cloud Setup Steps

### One-Time Setup (Before First Run)

1. **Get k6 Cloud API token**
   - Navigate to: Grafana Cloud portal → k6 → Settings → API tokens
   - Create a token with "Read/Write" permission
   - Save as `K6_CLOUD_TOKEN`

2. **Create a k6 Cloud project**
   - Navigate to: Grafana Cloud portal → k6 → Projects → Create
   - Name: "ABL Platform Benchmarks"
   - Note the project ID from the URL (e.g., `https://app.k6.io/projects/12345` → `12345`)
   - Save as `K6_CLOUD_PROJECT_ID`

3. **Configure credentials locally**

   ```bash
   cp benchmarks/config/cloud.env.example benchmarks/config/cloud.env
   # Edit cloud.env with your token, project ID, staging URL
   ```

4. **Verify k6 CLI has Cloud support**

   ```bash
   k6 version
   # Should show k6 v1.x.x with cloud extension
   k6 cloud login --token $K6_CLOUD_TOKEN
   ```

5. **Run bootstrap first** (if not already done)
   The benchmark-setup must run via k6 Operator (or locally) to create fixtures on staging:

   ```bash
   kubectl apply -f benchmarks/k8s/testrun-setup.yaml
   ```

   k6 Cloud only generates load — it doesn't create the benchmark tenant/project/agent/KB.

6. **Verify staging ingress**

   ```bash
   curl -s https://staging.abl-platform.com/health
   # Should return 200
   ```

7. **First Cloud run (smoke test)**
   ```bash
   ./benchmarks/scripts/cloud-run.sh benchmarks/services/bge-m3.ts
   ```
   Verify results appear in the k6 Cloud dashboard.

### Ongoing Usage

```bash
# Run a single benchmark
./benchmarks/scripts/cloud-run.sh benchmarks/services/runtime.ts

# Run the full critical suite
./benchmarks/scripts/cloud-run-suite.sh

# Run with a specific tier
TIER=l ./benchmarks/scripts/cloud-run-suite.sh

# Run against a customer demo environment
STAGING_URL=https://demo.customer.com ENV=customer-acme \
  ./benchmarks/scripts/cloud-run.sh benchmarks/services/runtime.ts
```

---

## 5. Dashboard Organization

### Tagging Strategy

Tests are organized by tags set in `options.cloud.tags`:

| Tag       | Values                                                    | Purpose                      |
| --------- | --------------------------------------------------------- | ---------------------------- |
| `service` | `runtime`, `search-ai`, `bge-m3`, `mongodb`, `opensearch` | Filter by service            |
| `type`    | `per-service`, `integration`, `system-wide`               | Filter by benchmark level    |
| `tier`    | `s`, `m`, `l`, `xl`                                       | Filter by load tier          |
| `env`     | `staging`, `customer-<name>`                              | Filter by target environment |

### Naming Convention

Each test run appears in k6 Cloud with the name from `options.cloud.name`:

```
{service}-{type}-{tier}-{env}
```

Examples:

- `runtime-per-service-m-staging`
- `agent-conversation-integration-l-staging`
- `search-query-integration-m-customer-acme`

### Common Dashboard Queries

| Question                            | Filter                                            |
| ----------------------------------- | ------------------------------------------------- |
| All Tier M runtime benchmarks       | `service=runtime, tier=m`                         |
| Last week's integration E2Es        | `type=integration` + date range                   |
| Compare Tier S vs Tier L for search | `service=search-ai`, compare `tier=s` vs `tier=l` |
| Customer ACME engagement results    | `env=customer-acme`                               |
| All nightly regression runs         | `env=staging, type=per-service` + date range      |

### Results Comparison

k6 Cloud automatically tracks all test runs over time. For any test name:

- **Trend view:** See p95 latency, throughput, error rate across all runs
- **Compare any two runs:** Side-by-side diff showing regression/improvement
- **Thresholds:** Pass/fail status per run based on script thresholds
- **No Prometheus retention concerns** — 12 months retention on Pro plan

### Sharing Results

- **URL sharing:** Each test run has a permalink. Share with team or customers without VPN.
- **PDF export:** k6 Cloud supports PDF export of test results for customer reports.
- **Grafana dashboard embedding:** k6 Cloud metrics can be queried from Grafana Cloud dashboards for custom views.

---

## 6. Private Load Zones (Phase 2)

### What They Are

k6 Private Load Zones are k6 Cloud agents deployed as pods inside your K8s cluster. They receive test execution commands from Grafana Cloud but run within the cluster network — hitting internal service URLs directly.

### Why Phase 2

Per-service data store benchmarks (`mongodb.ts`, `redis.ts`, `opensearch.ts`, `qdrant.ts`, `neo4j.ts`, `restate.ts`) connect directly to data store ports not exposed via public ingress. These require Private Load Zones.

### Setup (When Ready)

1. **Install k6 Cloud agent via Helm:**

   ```bash
   helm repo add grafana https://grafana.github.io/helm-charts
   helm install k6-plz grafana/k6-cloud-agent \
     --namespace abl-benchmarks \
     --set cloudToken=$K6_CLOUD_TOKEN \
     --set zone=abl-staging-internal
   ```

2. **Configure scripts to use the private zone:**

   ```typescript
   export const options = {
     cloud: {
       distribution: {
         staging_internal: {
           loadZone: 'private:abl-staging-internal',
           percent: 100,
         },
       },
     },
   };
   ```

3. **Run data store benchmarks via Cloud:**
   ```bash
   K6_CLOUD_TOKEN=xxx k6 cloud run benchmarks/services/mongodb.ts \
     -e MONGO_URL=mongodb://mongodb.abl-platform.svc:27017
   ```

### What Runs Where (Final State After Phase 2)

| Scripts                                                                          | Phase 1 (Cloud public) | Phase 2 (Cloud private)    |
| -------------------------------------------------------------------------------- | ---------------------- | -------------------------- |
| `runtime.ts`, `search-ai.ts`, `bge-m3.ts`                                        | Public ingress         | Public ingress (unchanged) |
| `mongodb.ts`, `redis.ts`, `opensearch.ts`, `qdrant.ts`, `neo4j.ts`, `restate.ts` | Skip (use k6 Operator) | Private Load Zone          |
| Integration E2Es (3)                                                             | Public ingress         | Public ingress (unchanged) |
| System-wide (soak, burst, etc.)                                                  | Public ingress         | Public ingress (unchanged) |

### Trigger for Phase 2

Move to Phase 2 when you want to:

- Retire the k6 Operator entirely
- Consolidate all execution on k6 Cloud
- Get unified dashboards for both application and data store benchmarks

---

## 7. k6 Operator vs k6 Cloud Decision Framework

### When to Keep k6 Operator

- CI/CD release gates (Harness) — fast, deterministic, no cloud dependency
- Air-gapped or compliance-restricted environments
- Cost-sensitive — no per-VU-hour charges
- Internal data store benchmarks (until Phase 2 Private Load Zones)

### When to Use k6 Cloud

- Customer-facing reports — polished dashboards, PDF export, shareable URLs
- Multi-region testing (future) — test from 21 global regions
- Historical comparison — 12-month retention, automatic trend tracking
- Team sharing — no VPN/cluster access needed to view results
- Less infrastructure — no Prometheus + Grafana + k6 Operator to maintain

### Recommended Hybrid (Initial State)

| Use Case                  | Execution                                            | Why                                                      |
| ------------------------- | ---------------------------------------------------- | -------------------------------------------------------- |
| CI release gate (Harness) | k6 Operator                                          | Fast, deterministic, no cloud dependency                 |
| Nightly regression        | k6 Cloud                                             | Better dashboards, historical tracking, team visibility  |
| Weekly capacity           | k6 Cloud                                             | Full suite, shareable results, trend analysis            |
| Customer engagement       | k6 Cloud                                             | Professional dashboards, PDF export, shareable permalink |
| Data store benchmarks     | k6 Operator (Phase 1) → Private Load Zones (Phase 2) | Internal network access required                         |
| Pre-launch validation     | k6 Cloud                                             | Run all tiers, compare results across runs               |

### Migration Path

```
Current State:  k6 Operator only (all tests)
     ↓
Phase 1:        k6 Operator (CI gates + data stores)
                + k6 Cloud (nightly, weekly, customer, app-level benchmarks)
     ↓
Phase 2:        k6 Operator (CI gates only)
                + k6 Cloud with Private Load Zones (everything else)
     ↓
Optional:       k6 Cloud only (if CI gates can tolerate cloud latency)
```

---

## 8. Cost & Plan Limits

### Pro Plan Budget (600 VU-hours/month)

| Run Type                    | VUs (avg) | Duration (avg) | VU-hours per run | Runs/month | Monthly VU-hours |
| --------------------------- | --------- | -------------- | ---------------- | ---------- | ---------------- |
| Single per-service (Tier M) | 50        | 30m            | 25               | -          | -                |
| 8 critical scripts          | 50        | 30m            | 200              | -          | -                |
| Full 8+3 suite              | 35        | 20m            | 250              | -          | -                |

### Budget Scenarios

| Scenario                               | Allocation                   | Monthly VU-hours     | Fits in Pro?        |
| -------------------------------------- | ---------------------------- | -------------------- | ------------------- |
| Weekly suite + ad-hoc                  | 4 suite runs + 8 single runs | 4×250 + 8×25 = 1,200 | No — need to reduce |
| 2× weekly suite only                   | 2 suite runs                 | 2×250 = 500          | Yes                 |
| Daily critical 8                       | 20 runs × 200 VU-hrs         | 4,000                | No — far over       |
| Weekly suite + 2× nightly critical     | 1×250 + 8×200 = 1,850        | 1,850                | No                  |
| **Recommended: 2× weekly + 4× single** | 2×250 + 4×25 = 600           | 600                  | Yes — exactly fits  |

### Recommended Budget Allocation

| Use Case                             | Frequency    | VU-hours/month |
| ------------------------------------ | ------------ | -------------- |
| Weekly full suite (customer reports) | 2× per month | 500            |
| Ad-hoc single service benchmarks     | 4× per month | 100            |
| **Total**                            |              | **600**        |

_If you need more runs, upgrade to Pro+ or use k6 Operator for routine regression and reserve k6 Cloud for customer-facing runs._

### Cost Optimization Tips

- Use k6 Operator for CI gates and nightly regression (free, no VU-hour cost)
- Reserve k6 Cloud for weekly capacity runs and customer engagements
- Run Tier S (10 VUs, 10m) for quick smoke tests on Cloud — costs only ~1.7 VU-hours
- Use `--duration` override to shorten runs when full duration isn't needed

# ABL Platform — Load Testing Approach

**Date:** 2026-03-17
**Status:** Draft
**Driver:** Customer engagement requiring sizing validation within 2-3 weeks
**Dependencies:** Existing k6 benchmark suite (`benchmarks/`), k6 Operator on staging K8s cluster, topology sizing design doc

---

## Table of Contents

1. [Overview](#1-overview)
2. [Short-Term Plan (Weeks 1-3)](#2-short-term-plan-weeks-1-3)
3. [Long-Term Plan (Weeks 4-11)](#3-long-term-plan-weeks-4-11)
4. [Benchmark Environment Bootstrap](#4-benchmark-environment-bootstrap)
5. [Report Persistence & Customer Reports](#5-report-persistence--customer-reports)
6. [Tier-Based Load Profiles](#6-tier-based-load-profiles)
7. [Per-Tier SLA Table](#7-per-tier-sla-table)
8. [Harness CI/CD Integration](#8-harness-cicd-integration)
9. [Customer Deliverables](#9-customer-deliverables)
10. [LLM Provider Strategy for Benchmarks](#10-llm-provider-strategy-for-benchmarks)
11. [Risks & Mitigations](#11-risks--mitigations)
12. [Appendix: TestRun CRD Patterns](#12-appendix-testrun-crd-patterns)

---

## 1. Overview

### Problem

The ABL Platform has a comprehensive k6 benchmark suite (17 per-service + 6 integration + 6 system-wide scripts) and a detailed topology sizing design, but:

- None of the 29 scripts have been run against real services
- There is no automated pipeline for running load tests
- There are no validated performance numbers to share with customers
- There is no customer-facing report generation

### Goals

1. **Execution strategy** — Define what runs, when, by whom, on what environment
2. **Coverage validation** — Get all 29 scripts working against real services
3. **CI/CD integration** — Automate load tests in Harness pipelines with pass/fail gates
4. **Customer deliverables** — White paper for pre-sales + customizable runbook for post-sale validation + auto-generated PDF reports

### Audiences

| Audience        | Need                                                                | Delivery                                                  |
| --------------- | ------------------------------------------------------------------- | --------------------------------------------------------- |
| Engineering     | Regression detection, per-commit performance impact                 | Grafana dashboards + Slack alerts on nightly runs         |
| SRE/Ops         | Capacity planning, scaling validation, storage growth trends        | Weekly Grafana capacity dashboard + Slack summary         |
| Sales/Customers | Validated SLAs per tier, sizing proof points, benchmark methodology | White paper (quarterly refresh) + per-customer PDF report |

### Infrastructure

- **Execution environment:** Dedicated staging K8s cluster (EKS or AKS) with k6 Operator deployed
- **Metrics pipeline:** k6 pods → Prometheus Remote Write → Grafana dashboards
- **Report storage:** Object storage (AWS S3 or Azure Blob Storage) + Grafana snapshots
- **CI/CD:** Harness pipelines

### Cloud Provider Support

The load testing framework supports both AWS and Azure deployments. All references to object storage, K8s services, and managed infrastructure are cloud-neutral where possible. Provider-specific details:

| Component                             | AWS                                            | Azure                                                      |
| ------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| Kubernetes                            | EKS                                            | AKS                                                        |
| Object storage (reports)              | S3 bucket `abl-benchmarks`                     | Azure Blob container `abl-benchmarks` in a Storage Account |
| Prometheus                            | Self-hosted or Amazon Managed Prometheus (AMP) | Self-hosted or Azure Monitor managed Prometheus            |
| Grafana                               | Self-hosted or Amazon Managed Grafana          | Self-hosted or Azure Managed Grafana                       |
| Secrets management                    | AWS Secrets Manager → K8s External Secrets     | Azure Key Vault → K8s External Secrets                     |
| Container registry (export Job image) | ECR                                            | ACR                                                        |

The `STORAGE_PROVIDER` env var (`s3` or `azure-blob`) controls which object storage SDK the export Job and report generator use. Both are supported in the export Job Docker image.

---

## 2. Short-Term Plan (Weeks 1-3)

### Objective

Validated performance numbers for 3 critical user journeys, delivered as customer-ready artifacts, with Harness release-gate integration.

### Day 0: Staging Cluster Verification Checklist

Before starting Week 1, verify the staging cluster is ready:

- [ ] k6 Operator installed and `TestRun` CRD available (`kubectl get crd testruns.k6.io`)
- [ ] `abl-benchmarks` namespace created with resource quotas
- [ ] All ABL Platform services running and healthy (`runtime`, `search-ai`, `search-ai-runtime`, `studio`, `admin`, `bge-m3`, `docling`)
- [ ] All data stores running (MongoDB, Redis, ClickHouse, OpenSearch, Neo4j, Qdrant, Restate)
- [ ] Prometheus configured to accept Remote Write (`/api/v1/write` endpoint accessible)
- [ ] Grafana accessible with k6 dashboards provisioned from `deploy/grafana/dashboards/`
- [ ] Object storage provisioned: AWS S3 bucket `abl-benchmarks` or Azure Blob container `abl-benchmarks` with write access from cluster (via IRSA or Workload Identity)
- [ ] `ADMIN_TOKEN` provisioned as K8s Secret in `abl-benchmarks` namespace (see [Section 11](#11-risks--mitigations))
- [ ] LLM provider API key configured with elevated rate limits (see [Section 10](#10-llm-provider-strategy-for-benchmarks))

### Scripts in Scope (8 of 29)

**Per-service (5):** All scripts under `benchmarks/services/`

| Script                              | Why Critical                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| `benchmarks/services/runtime.ts`    | Core agent execution — single-turn, multi-turn, tool-calling, concurrent ramp |
| `benchmarks/services/search-ai.ts`  | KB ingestion pipeline throughput                                              |
| `benchmarks/services/bge-m3.ts`     | Embedding generation — bottleneck for both ingestion and search               |
| `benchmarks/services/mongodb.ts`    | Primary data store — IOPS and query latency under load                        |
| `benchmarks/services/opensearch.ts` | Vector search and document retrieval latency                                  |

**Integration (3):** All scripts under `benchmarks/integration/`

| Script                                             | Journey                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------- |
| `benchmarks/integration/agent-conversation-e2e.ts` | Studio → Runtime → LLM → MongoDB → ClickHouse                             |
| `benchmarks/integration/kb-ingestion-e2e.ts`       | Studio → Search AI → Docling → BGE-M3 → OpenSearch/Qdrant → Neo4j         |
| `benchmarks/integration/search-query-e2e.ts`       | Runtime → Search AI Runtime → Preprocessing → BGE-M3 → OpenSearch → Neo4j |

### Script Validation Criteria

A script is considered **validated** when all of the following pass:

1. `tsc --noEmit` — no type errors
2. `k6 inspect <script>` — k6 can parse the script without errors
3. `TestRun` with 1 VU, 1 min completes with status `finished` (not `error`)
4. Error rate < 5% at 5 VUs for 2 min
5. At least one custom metric appears in Prometheus (verifies remote write works)
6. Grafana dashboard panel shows data for the script's metrics

### Week 1: Bootstrap + Validate

| Day | Activity                                                                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1-2 | **Bootstrap harness**: Build `benchmarks/setup/bootstrap.ts` and all sub-modules (tenant, agent, KB, indexes, seed data). Build `benchmarks/setup/teardown.ts`. Create fixture data. Build ConfigMap creation script (`benchmarks/scripts/create-configmaps.sh`). See [Section 4](#4-benchmark-environment-bootstrap). |
| 3   | **Typecheck + deploy setup**: Run `tsc --noEmit` on all 8 scripts + setup module. Fix broken imports/types. Deploy `benchmark-setup` TestRun on staging. Verify tenant, agent, KB, and indexes are created successfully.                                                                                               |
| 4   | **Per-service smoke on staging**: Run ConfigMap creation script. Deploy 5 per-service `TestRun` CRDs (1 runner pod, 5 VUs, 2 min each). Validate against criteria above. Fix runtime failures.                                                                                                                         |
| 5   | **Integration E2Es on staging**: `TestRun` CRDs for the 3 integration scripts (parallelism: 2, 5 VUs, 10 min). Debug cross-service failures. These exercise multi-service pipelines — expect more debugging time.                                                                                                      |

### Week 2: Tier-Calibrated Runs + Packaging

| Day | Activity                                                                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1-2 | **Tier-calibrated runs (3 repetitions)**: Update `TestRun` CRDs to Tier M load — per-service (parallelism: 4, 50 VUs, 30 min), integration (parallelism: 4, 20 VUs, 15 min). Run 3 times to establish variance. Formalize SLA table from median of 3 runs.                                         |
| 3-4 | **Customer white paper**: Architecture overview, benchmark methodology, validated SLA table (S/M/L/XL), Grafana dashboard screenshots. **Customer runbook**: Step-by-step for SEs to run the 8 scripts on a customer cluster (includes local k6 binary fallback for clusters without k6 Operator). |
| 5   | **Post-run export Job**: Build `benchmarks/report/export-job/` — Docker image (Node.js) that queries Prometheus, exports JSON summaries, captures Grafana panel PNGs via Rendering API, uploads to S3. Deploy as K8s Job template.                                                                 |

### Week 3: Report Generator + CI Integration

| Day | Activity                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1-2 | **Report generator**: Build `benchmarks/report/generate-customer-report.ts` — pulls S3 summary JSONs, produces branded markdown with embedded PNGs, converts to PDF via Pandoc. See [Section 5](#5-report-persistence--customer-reports).                                      |
| 3   | **Harness pipeline**: Add `load-test` stage to release-branch pipeline — applies `benchmark-setup` TestRun, then 8 benchmark TestRuns via k6 Operator, runs export Job, queries Prometheus for SLA pass/fail, gates the release. See [Section 8](#8-harness-cicd-integration). |
| 4   | **Dry-run**: Trigger release pipeline → setup runs → benchmarks run → results in Grafana → export Job uploads to S3 → report generated → pass/fail gate works.                                                                                                                 |
| 5   | **Buffer**: Fix issues from dry-run. Generate first customer report from real data.                                                                                                                                                                                            |

### Short-Term Deliverables

1. Benchmark environment bootstrap (`benchmarks/setup/`) with teardown
2. ConfigMap creation script (`benchmarks/scripts/create-configmaps.sh`)
3. 8 validated, working k6 scripts with `TestRun` CRDs (validated per criteria above)
4. Grafana dashboards with real benchmark data
5. Post-run export Job (Prometheus → JSON + Grafana → PNG → S3)
6. Customer white paper (PDF-ready markdown)
7. Customer/SE runbook (with local k6 fallback path)
8. Report generator producing customer PDF (Pandoc-based)
9. Harness release-branch load test gate
10. Per-tier SLA table backed by 3 validated runs

---

## 3. Long-Term Plan (Weeks 4-11)

### Phase 1: Remaining Per-Service Validation (Weeks 4-5)

**Scripts (12):** All under `benchmarks/services/`: `clickhouse.ts`, `redis.ts`, `neo4j.ts`, `qdrant.ts`, `restate.ts`, `search-ai-runtime.ts`, `docling.ts`, `preprocessing.ts`, `studio.ts`, `workflow-engine.ts`, `multimodal.ts`, `crawler.ts`

| Week | Activity                                                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4    | Typecheck + fix all 12 scripts. Deploy ConfigMaps. Run each as `TestRun` (1 pod, 5 VUs, 2 min) to validate against real services per validation criteria. Fix failures.                           |
| 5    | Tier-calibrated runs (parallelism: 4, 50 VUs, 30 min, 3 repetitions). Establish per-replica throughput ceilings for each service. Update SLA table. Feed results into sizing calculator formulas. |

**Deliverables:**

- All 17 per-service scripts validated and producing real data
- Per-service throughput ceiling table (feeds the sizing calculator)
- Grafana `k6-per-service` dashboard fully populated

### Phase 2: Integration + System-Wide Tests (Weeks 6-8)

**Integration scripts (3):** `benchmarks/integration/workflow-execution-e2e.ts`, `benchmarks/integration/multi-agent-orchestration.ts`, `benchmarks/integration/channel-message-e2e.ts`

**System-wide scripts (6):** `benchmarks/system/soak-test.ts`, `benchmarks/system/ramp-to-saturation.ts`, `benchmarks/system/multi-tenant-isolation.ts`, `benchmarks/system/burst-traffic.ts`, `benchmarks/system/failover-recovery.ts`, `benchmarks/system/disk-pressure.ts`

| Week | Activity                                                                                                                                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6    | Validate + run the 3 remaining integration E2Es. Create seed data/fixtures (workflow definitions, multi-agent configs, channel webhooks) as additional bootstrap modules.        |
| 7    | System-wide stress tests on a **dedicated benchmark window** (no other staging use). Soak (4h, parallelism: 8, 100 VUs), ramp-to-saturation (30 min), burst (15 min, 10x spike). |
| 8    | Failover + multi-tenant isolation tests. Pod kills mid-test, per-tenant load shaping. Disk-pressure test to validate growth model from topology sizing doc.                      |

**Deliverables:**

- All 29 scripts validated per validation criteria
- System saturation point identified per tier
- Soak test proving no memory leaks / connection exhaustion over 4h
- Multi-tenant noisy-neighbor variance measured (target: <20%)
- Burst recovery time validated (target: <60s all tiers, <30s Tier L/XL)
- Failover recovery times validated against runbook expectations

### Phase 3: Automation & Reporting (Weeks 9-10)

**Three Harness pipeline tiers:**

| Pipeline    | Trigger             | Scripts                               | Duration | Purpose                                                  |
| ----------- | ------------------- | ------------------------------------- | -------- | -------------------------------------------------------- |
| **Smoke**   | Release branch push | 8 critical scripts                    | ~15 min  | Release gate — blocks merge on SLA violation             |
| **Nightly** | Cron (2 AM)         | All 17 per-service + 6 integration    | ~2 hours | Regression detection — alerts engineering on Slack       |
| **Weekly**  | Cron (Sunday 1 AM)  | Full 29 scripts including system-wide | ~6 hours | Capacity trend — SRE dashboard + storage growth tracking |

**Reporting per audience:**

| Audience       | Format                                     | Content                                                          | Delivery                        |
| -------------- | ------------------------------------------ | ---------------------------------------------------------------- | ------------------------------- |
| Engineering    | Grafana dashboard + Slack alert            | Per-run regression, p95 trends, error rate delta vs previous run | Automatic on nightly            |
| SRE/Ops        | Grafana Capacity Planning dashboard        | Throughput ceilings, storage growth projections, HPA headroom    | Weekly summary in Slack         |
| Sales/Customer | White paper (quarterly) + per-customer PDF | Validated SLAs per tier, architecture diagrams, methodology      | Manual refresh after weekly run |

### Phase 4: Customer Self-Service & Sizing Validation (Week 11)

| Deliverable                               | Description                                                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Benchmark data → sizing calculator**    | Export per-service throughput ceilings from Prometheus into `kore-platform-cli sizing calculate` input format. Replace assumed values with measured values.   |
| **Customer sizing validation runbook v2** | Extended runbook: SE runs benchmarks on customer cluster → results auto-feed sizing calculator → topology recommendation + Helm values generated in one flow. |
| **Quarterly refresh cadence**             | After each major release: re-run weekly suite, update white paper SLA table, publish updated sizing calculator coefficients.                                  |

### Full Timeline Summary

| Week | Phase      | Key Milestone                                                      |
| ---- | ---------- | ------------------------------------------------------------------ |
| 0    | Pre-work   | Staging cluster verification checklist                             |
| 1    | Short-term | Bootstrap harness + 8 scripts validated on staging                 |
| 2    | Short-term | Tier-calibrated runs (3x) + white paper + runbook                  |
| 3    | Short-term | Report generator + Harness release gate + dry-run                  |
| 4-5  | Phase 1    | All 17 per-service scripts validated                               |
| 6-8  | Phase 2    | All 29 scripts validated, system stress tests complete             |
| 9-10 | Phase 3    | Nightly + weekly pipelines, per-audience reporting                 |
| 11   | Phase 4    | Benchmark data feeds sizing calculator, customer self-service flow |

---

## 4. Benchmark Environment Bootstrap

Every benchmark run — whether on staging, a customer cluster, or in CI — requires a consistent set of fixtures. The bootstrap runs as a k6 `TestRun` before all other test runs.

### Modules

| Module                  | What It Creates                                                                                  | API Used                 |
| ----------------------- | ------------------------------------------------------------------------------------------------ | ------------------------ |
| `bootstrap-tenant.ts`   | Benchmark tenant + API credentials                                                               | Admin API                |
| `bootstrap-agent.ts`    | Benchmark agent with known tool set, model chain, LLM credential                                 | Runtime API              |
| `bootstrap-kb.ts`       | Knowledge base + sample document corpus (~100 docs of known sizes), waits for ingestion complete | Search AI API            |
| `bootstrap-indexes.ts`  | Verifies OpenSearch indices and Qdrant collections exist with correct schemas                    | OpenSearch + Qdrant APIs |
| `seed-conversations.ts` | Pre-seeds conversations for scripts that need existing session state                             | Runtime API              |

### Orchestrator

`benchmarks/setup/bootstrap.ts` — imports and runs all modules in sequence. Single entry point.

### TestRun CRD

```yaml
apiVersion: k6.io/v1alpha1
kind: TestRun
metadata:
  name: benchmark-setup
  namespace: abl-benchmarks
spec:
  parallelism: 1
  script:
    configMap:
      name: benchmark-setup-script
      file: bootstrap.ts
  arguments: >-
    --env RUNTIME_URL=http://runtime.abl-platform.svc.cluster.local:3112
    --env ADMIN_URL=http://admin.abl-platform.svc.cluster.local:3003
    --env SEARCH_AI_URL=http://search-ai.abl-platform.svc.cluster.local:3113
    --env ADMIN_TOKEN=${ADMIN_TOKEN}
    --iterations 1
    --vus 1
  runner:
    resources:
      requests:
        cpu: 250m
        memory: 256Mi
      limits:
        cpu: 500m
        memory: 512Mi
```

### Teardown

`benchmarks/setup/teardown.ts` — cleans up all fixtures created by bootstrap. Runs as a separate `TestRun` after benchmarks complete. Used in CI and customer engagements to leave the cluster clean.

### Fixture Data

Stored in `benchmarks/fixtures/`:

```
benchmarks/fixtures/
  documents/               # 100 sample documents (PDFs, HTML, markdown) of known sizes
    small-01.pdf           # ~2 pages
    medium-01.pdf          # ~20 pages
    large-01.pdf           # ~100 pages
    ...
  agent-config.json        # Benchmark agent definition with tools
  kb-config.json           # Knowledge base configuration
  model-chain.json         # LLM model chain (external API — no GPU required)
```

### ConfigMap Creation Script

`benchmarks/scripts/create-configmaps.sh` — creates ConfigMaps from all k6 scripts in one command:

```bash
#!/bin/bash
NAMESPACE=${1:-abl-benchmarks}

# Per-service scripts
for script in benchmarks/services/*.ts; do
  name=$(basename "$script" .ts)-benchmark-script
  kubectl create configmap "$name" \
    --from-file="$(basename $script)=$script" \
    -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
done

# Integration scripts
for script in benchmarks/integration/*.ts; do
  name=$(basename "$script" .ts)-script
  kubectl create configmap "$name" \
    --from-file="$(basename $script)=$script" \
    -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
done

# System-wide scripts
for script in benchmarks/system/*.ts; do
  name=$(basename "$script" .ts)-script
  kubectl create configmap "$name" \
    --from-file="$(basename $script)=$script" \
    -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
done

# Setup/teardown
kubectl create configmap benchmark-setup-script \
  --from-file=bootstrap.ts=benchmarks/setup/bootstrap.ts \
  -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
```

_Note: k6 scripts with inline fixtures must stay under the 1MiB ConfigMap limit. Large fixture data (sample documents) should be mounted from a PVC or pulled at runtime via HTTP._

### Auth Flow Per Context

| Context                   | Auth Mechanism                                           | Token Source                                                                                 |
| ------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Staging CI (Harness)**  | `ADMIN_TOKEN` env var                                    | K8s Secret `benchmark-secrets` in `abl-benchmarks` namespace, referenced by Harness pipeline |
| **Customer cluster (SE)** | `ADMIN_TOKEN` env var                                    | SE creates an API token via Admin UI, passes to TestRun CRD                                  |
| **Local dev**             | `AUTH_TOKEN` env var or fallback to `dev-login` endpoint | `benchmarks/lib/auth.ts` calls `POST /api/auth/dev-login` on Studio when no token provided   |

The K8s Secret for CI (created manually or synced from external secrets manager):

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: benchmark-secrets
  namespace: abl-benchmarks
type: Opaque
stringData:
  ADMIN_TOKEN: '<provisioned-via-admin-api>'
  LLM_API_KEY: '<llm-provider-api-key>'
  GRAFANA_API_KEY: '<grafana-service-account-token>'
```

**External secrets integration (recommended for production):**

| Provider | External Secrets Store | Sync Method                                                                                             |
| -------- | ---------------------- | ------------------------------------------------------------------------------------------------------- |
| AWS      | AWS Secrets Manager    | External Secrets Operator with `SecretStore` pointing to Secrets Manager                                |
| Azure    | Azure Key Vault        | External Secrets Operator with `SecretStore` pointing to Key Vault, authenticated via Workload Identity |

### Bootstrap KB Wait-for-Ingestion Pattern

`bootstrap-kb.ts` polls the Search AI API for ingestion completion:

- **Poll interval:** 10 seconds
- **Timeout:** 10 minutes (covers 100 docs including large PDFs through Docling)
- **Success condition:** All documents have status `indexed` in the KB document list API
- **Partial failure handling:** If >90% of documents indexed, proceed with a warning logged. If <90%, fail the bootstrap and abort the benchmark run.

---

## 5. Report Persistence & Customer Reports

### Storage Architecture

The same directory structure applies to both AWS S3 and Azure Blob Storage:

- **AWS:** `s3://abl-benchmarks/`
- **Azure:** `https://<storageaccount>.blob.core.windows.net/abl-benchmarks/`

```
abl-benchmarks/
  reports/
    {YYYY-MM-DD}-{run-type}/              # e.g., 2026-03-20-release-gate
      summary.json                         # k6 aggregated results
      per-service/
        runtime.json
        search-ai.json
        bge-m3.json
        mongodb.json
        opensearch.json
      integration/
        agent-conversation-e2e.json
        kb-ingestion-e2e.json
        search-query-e2e.json
      grafana-snapshots/
        k6-per-service.png
        k6-integration.png
      sla-report.md                        # Auto-generated pass/fail
    {YYYY-MM-DD}-nightly/
    {YYYY-MM-DD}-weekly/
  customer/
    {customer-name}-{date}/
      report.md                            # Source markdown
      report.pdf                           # Rendered PDF
      assets/                              # Charts, Grafana screenshots
      raw/                                 # JSON summaries, k6 output
      topology-recommendation.json         # Sizing calculator output
```

### Post-Run Export Job

**Location:** `benchmarks/report/export-job/`
**Language:** Node.js (TypeScript)
**Docker image:** `abl-benchmark-export:latest` (built from `benchmarks/report/export-job/Dockerfile`)

After each `TestRun` completes, a Kubernetes Job runs:

1. Queries Prometheus API for all k6 metrics from the run (tagged by `testrun` label)
2. Computes aggregated JSON summaries (p50/p95/p99, throughput, error rates per scenario)
3. Captures Grafana dashboard panel screenshots via Grafana Rendering API (`/render/d/<uid>`)
4. Uploads everything to object storage (S3 or Azure Blob)
5. Creates a Grafana snapshot via Snapshot API (`POST /api/snapshots`) for quick internal sharing

**K8s Job template:**

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: benchmark-export-${RUN_DATE}-${RUN_TYPE}
  namespace: abl-benchmarks
spec:
  backoffLimit: 2
  template:
    spec:
      restartPolicy: OnFailure
      serviceAccountName: benchmark-export-sa # IRSA (AWS) or Workload Identity (Azure)
      containers:
        - name: export
          image: abl-benchmark-export:latest
          env:
            - name: PROMETHEUS_URL
              value: http://prometheus-server.monitoring.svc.cluster.local:9090
            - name: GRAFANA_URL
              value: http://grafana.monitoring.svc.cluster.local:3000
            - name: GRAFANA_API_KEY
              valueFrom:
                secretKeyRef:
                  name: benchmark-secrets
                  key: GRAFANA_API_KEY
            - name: STORAGE_PROVIDER
              value: s3 # "s3" or "azure-blob"
            # --- AWS S3 ---
            - name: S3_BUCKET
              value: abl-benchmarks # used when STORAGE_PROVIDER=s3
            # --- Azure Blob ---
            # - name: AZURE_STORAGE_ACCOUNT
            #   value: ablbenchmarks  # used when STORAGE_PROVIDER=azure-blob
            # - name: AZURE_STORAGE_CONTAINER
            #   value: abl-benchmarks
            - name: STORAGE_PREFIX
              value: reports/${RUN_DATE}-${RUN_TYPE}
            - name: RUN_TYPE
              value: ${RUN_TYPE} # release-gate | nightly | weekly | customer
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
            limits:
              cpu: 500m
              memory: 512Mi
```

**Authentication to object storage:**

| Provider   | Method                                | Setup                                                                   |
| ---------- | ------------------------------------- | ----------------------------------------------------------------------- |
| AWS S3     | IRSA (IAM Roles for Service Accounts) | Annotate `benchmark-export-sa` with `eks.amazonaws.com/role-arn`        |
| Azure Blob | Workload Identity                     | Annotate `benchmark-export-sa` with `azure.workload.identity/client-id` |

### Customer Report Generator

**Location:** `benchmarks/report/generate-customer-report.ts`
**PDF toolchain:** Pandoc with LaTeX backend (`pandoc --pdf-engine=xelatex`)
**Docker image:** Included in `abl-benchmark-export:latest` (Pandoc + TexLive installed)

**Input:** Object storage path to a completed benchmark run (e.g., `customer/acme-corp-2026-03-20/raw/` — works with both S3 and Azure Blob)

**Output:** `report.md` + `report.pdf`

**Report sections:**

| Section                       | Content                                                                   |
| ----------------------------- | ------------------------------------------------------------------------- |
| Executive Summary             | Tier recommendation, key SLA results (pass/fail), deployment size         |
| Benchmark Methodology         | What was tested, k6 Operator setup, VU counts, duration, environment      |
| Results — Agent Conversations | Single-turn, multi-turn, tool-calling latencies. Concurrent user ceiling. |
| Results — Knowledge Base      | Ingestion throughput (docs/hr), pipeline latency breakdown by stage       |
| Results — Search              | Query latency (p50/p95/p99), concurrent query capacity                    |
| SLA Compliance Table          | Each metric vs tier SLA threshold — green/red pass/fail                   |
| Topology Recommendation       | Node pools, replica counts, storage — from sizing calculator              |
| Grafana Screenshots           | Embedded PNGs from dashboard snapshots                                    |
| Appendix                      | Raw numbers, test configuration, environment details                      |

**SE workflow:**

1. Run `benchmark-setup` TestRun on customer cluster
2. Run the 8 benchmark TestRuns
3. Post-run Job exports results to object storage (S3 or Azure Blob, depending on customer's cloud)
4. Report generator pulls from object storage, produces `report.md` + `report.pdf`
5. SE downloads PDF, reviews, shares with customer

---

## 6. Tier-Based Load Profiles

Each tier (S/M/L/XL) corresponds to a customer profile from the topology sizing design. The load profile defines the k6 TestRun parameters that simulate that tier's expected workload.

### How Tiers Map to Load

The tier profiles are derived from the customer questionnaire in the topology sizing design:

| Parameter                     | Unit                         | Tier S | Tier M   | Tier L    | Tier XL |
| ----------------------------- | ---------------------------- | ------ | -------- | --------- | ------- |
| Concurrent conversations      | simultaneous (at any moment) | 50     | 200      | 1,000     | 5,000   |
| Messages per day              | messages / 24h               | < 1K   | 1K-50K   | 50K-500K  | 500K+   |
| KB documents                  | total indexed documents      | < 10K  | 10K-500K | 500K-5M   | 5M+     |
| Vector search queries per day | queries / 24h                | < 1K   | 1K-100K  | 100K-1M   | 1M+     |
| Active agents                 | total deployed agent configs | 1-10   | 10-100   | 100-1,000 | 1,000+  |

### How Customer Workload Translates to k6 Load

Each k6 **Virtual User (VU)** simulates one user performing a complete action (conversation, search, ingestion) in a loop. The mapping from customer parameters to k6 parameters:

**Agent conversations:**

```
k6 VUs = concurrent conversations
         (each VU holds one active conversation at a time)

Example Tier M:
  200 concurrent conversations → 200 VUs on agent-conversation-e2e.ts
  Each VU: opens WebSocket → sends 5 messages → waits for responses → closes → repeats
  With ~5s per turn + 1s think time = ~30s per conversation cycle
  Throughput: 200 VUs × (60s / 30s) = ~400 conversations started/min
  Messages/day: 400 conv/min × 5 msgs × 60 × 24 = ~2.9M (peak; real is bursty)
```

**Search queries:**

```
k6 VUs = concurrent search users
         (derived from queries/day ÷ seconds/day × avg query duration)

Example Tier M:
  100K queries/day ÷ 86,400s = ~1.2 queries/sec average
  At p95 query latency ~300ms, 1 VU can do ~3 queries/sec
  Steady-state: ~1 VU needed for average load
  Peak (10x burst): ~12 VUs
  Benchmark target: 20 VUs to test well above average, find ceiling
```

**KB ingestion:**

```
k6 VUs = concurrent ingestion workers
         (each VU submits one document and waits for pipeline completion)

Example Tier M:
  200 docs/hr target throughput
  Avg ingestion time per doc: ~30s (Docling + BGE-M3 + indexing)
  VUs needed: 200/hr ÷ 120/hr-per-VU = ~2 VUs steady-state
  Benchmark target: 10 VUs to test pipeline under pressure
```

**Per-service benchmarks (data stores, compute services):**

```
k6 VUs ≈ concurrent connections / operations
         (each VU sends one request, waits for response, repeats)

VU count is set higher than the application tier requires to find
the per-replica throughput ceiling — the point where latency degrades.

Example: MongoDB Tier M
  Application generates ~50 concurrent DB operations
  Benchmark runs 50 VUs to match, then ramps to find ceiling
```

**Summary mapping:**

| Benchmark Type           | What 1 VU Represents             | How VU Count Is Derived                                                     |
| ------------------------ | -------------------------------- | --------------------------------------------------------------------------- |
| Agent conversation       | 1 user in an active conversation | = concurrent conversations from customer profile                            |
| Search query             | 1 user issuing search queries    | = peak queries/sec × avg latency (then 2-3x for headroom)                   |
| KB ingestion             | 1 document being ingested        | = target throughput ÷ per-doc processing time (then 2-3x)                   |
| Per-service (data store) | 1 concurrent operation           | = expected concurrent ops from application tier (then 2-3x to find ceiling) |

_Note: Benchmark VU counts in the tier tables below include the 2-3x headroom factor. The goal is not just to validate the SLA at expected load, but to find the throughput ceiling and saturation point for each tier._

### Per-Service TestRun Parameters by Tier

| Service        | Parameter   | Tier S | Tier M | Tier L | Tier XL |
| -------------- | ----------- | ------ | ------ | ------ | ------- |
| **Runtime**    | VUs         | 10     | 50     | 200    | 500     |
|                | Parallelism | 1      | 4      | 8      | 16      |
|                | Duration    | 10m    | 30m    | 30m    | 30m     |
| **Search AI**  | VUs         | 5      | 20     | 50     | 100     |
|                | Parallelism | 1      | 2      | 4      | 8       |
|                | Duration    | 10m    | 30m    | 30m    | 30m     |
| **BGE-M3**     | VUs         | 10     | 50     | 100    | 200     |
|                | Parallelism | 1      | 4      | 8      | 16      |
|                | Duration    | 10m    | 30m    | 30m    | 30m     |
| **MongoDB**    | VUs         | 10     | 50     | 200    | 500     |
|                | Parallelism | 1      | 4      | 8      | 16      |
|                | Duration    | 10m    | 30m    | 30m    | 30m     |
| **OpenSearch** | VUs         | 10     | 50     | 200    | 500     |
|                | Parallelism | 1      | 4      | 8      | 16      |
|                | Duration    | 10m    | 30m    | 30m    | 30m     |

### Integration TestRun Parameters by Tier

| Journey                    | Parameter   | Tier S | Tier M | Tier L | Tier XL |
| -------------------------- | ----------- | ------ | ------ | ------ | ------- |
| **Agent Conversation E2E** | VUs         | 5      | 20     | 100    | 250     |
|                            | Parallelism | 1      | 4      | 8      | 16      |
|                            | Duration    | 10m    | 15m    | 20m    | 30m     |
| **KB Ingestion E2E**       | VUs         | 2      | 10     | 30     | 50      |
|                            | Parallelism | 1      | 2      | 4      | 8       |
|                            | Duration    | 10m    | 15m    | 20m    | 30m     |
| **Search Query E2E**       | VUs         | 5      | 20     | 100    | 250     |
|                            | Parallelism | 1      | 4      | 8      | 16      |
|                            | Duration    | 10m    | 15m    | 20m    | 30m     |

### System-Wide TestRun Parameters by Tier

| Test                       | Parameter       | Tier S      | Tier M       | Tier L         | Tier XL         |
| -------------------------- | --------------- | ----------- | ------------ | -------------- | --------------- |
| **Soak**                   | VUs             | 20          | 50           | 100            | 200             |
|                            | Parallelism     | 2           | 4            | 8              | 16              |
|                            | Duration        | 2h          | 4h           | 4h             | 4h              |
| **Ramp-to-saturation**     | Max VUs         | 100         | 300          | 1,000          | 3,000           |
|                            | Parallelism     | 2           | 4            | 8              | 16              |
|                            | Ramp stages     | 1→25→50→100 | 1→50→150→300 | 1→200→500→1000 | 1→500→1500→3000 |
| **Burst traffic**          | Baseline VUs    | 10          | 50           | 100            | 200             |
|                            | Spike VUs (10x) | 100         | 500          | 1,000          | 2,000           |
|                            | Parallelism     | 2           | 4            | 8              | 16              |
| **Multi-tenant isolation** | VUs per tenant  | 5           | 20           | 50             | 100             |
|                            | Tenant count    | 3           | 5            | 10             | 20              |
|                            | Parallelism     | 2           | 4            | 8              | 16              |

### How to Run a Specific Tier

The `TIER` env var selects the load profile. Each TestRun CRD is parameterized:

```yaml
apiVersion: k6.io/v1alpha1
kind: TestRun
metadata:
  name: runtime-benchmark-tier-m
  namespace: abl-benchmarks
  labels:
    benchmark-type: per-service
    service: runtime
    tier: m
spec:
  parallelism: 4 # from tier table above
  script:
    configMap:
      name: runtime-benchmark-script
      file: runtime.ts
  arguments: >-
    --env RUNTIME_URL=http://runtime.abl-platform.svc.cluster.local:3112
    --env AUTH_TOKEN=${AUTH_TOKEN}
    --env TENANT_ID=${TENANT_ID}
    --env PROJECT_ID=${PROJECT_ID}
    --env TIER=m
    --duration 30m
    --vus 50
```

The scripts read `__ENV.TIER` to adjust internal behavior (e.g., multi-turn message count, tool call count, batch sizes). The outer TestRun CRD controls VUs, parallelism, and duration per the tier table.

### Tier Selection for Different Contexts

| Context                   | Which Tier to Run                     | Why                                                    |
| ------------------------- | ------------------------------------- | ------------------------------------------------------ |
| **CI release gate**       | Tier S only                           | Fast (~15 min), catches regressions without heavy load |
| **Nightly regression**    | Tier M                                | Moderate load, representative of mid-market customers  |
| **Weekly capacity**       | Tier M + Tier L                       | Validates scaling behavior across two tiers            |
| **Customer engagement**   | Customer's target tier                | SE selects based on customer questionnaire answers     |
| **Pre-launch validation** | All tiers (S → M → L → XL sequential) | Full coverage before major release                     |

### Generating Tier-Specific TestRun CRDs

`benchmarks/scripts/generate-testruns.sh` generates all TestRun CRDs for a given tier:

```bash
#!/bin/bash
TIER=${1:?Usage: generate-testruns.sh <s|m|l|xl>}
NAMESPACE=${2:-abl-benchmarks}
OUTPUT_DIR=${3:-benchmarks/k8s/generated}

# Reads tier parameters from benchmarks/config/tier-profiles.json
# Generates TestRun YAML for each script with correct VUs, parallelism, duration
node benchmarks/scripts/generate-testruns.ts --tier "$TIER" --namespace "$NAMESPACE" --output "$OUTPUT_DIR"

echo "Generated TestRun CRDs in $OUTPUT_DIR/"
echo "Apply with: kubectl apply -f $OUTPUT_DIR/"
```

The tier parameters are stored in `benchmarks/config/tier-profiles.json`:

```json
{
  "s": {
    "perService": { "vus": 10, "parallelism": 1, "duration": "10m" },
    "integration": { "vus": 5, "parallelism": 1, "duration": "10m" },
    "system": { "vus": 20, "parallelism": 2, "duration": "2h" }
  },
  "m": {
    "perService": { "vus": 50, "parallelism": 4, "duration": "30m" },
    "integration": { "vus": 20, "parallelism": 4, "duration": "15m" },
    "system": { "vus": 50, "parallelism": 4, "duration": "4h" }
  },
  "l": {
    "perService": { "vus": 200, "parallelism": 8, "duration": "30m" },
    "integration": { "vus": 100, "parallelism": 8, "duration": "20m" },
    "system": { "vus": 100, "parallelism": 8, "duration": "4h" }
  },
  "xl": {
    "perService": { "vus": 500, "parallelism": 16, "duration": "30m" },
    "integration": { "vus": 250, "parallelism": 16, "duration": "30m" },
    "system": { "vus": 200, "parallelism": 16, "duration": "4h" }
  }
}
```

### Staging Cluster Requirements by Tier

The staging cluster must be sized to match the tier being tested. Running Tier L benchmarks on a Tier S cluster will produce misleading results.

| Tier Under Test | Minimum Staging Cluster        | k6 Runner Pods | k6 Runner Resources | AWS Node Types                          | Azure Node Types                                    |
| --------------- | ------------------------------ | -------------- | ------------------- | --------------------------------------- | --------------------------------------------------- |
| S               | Tier S reference architecture  | 1-2            | 1 vCPU, 1Gi per pod | m5.large (general), r5.xlarge (data)    | Standard_D2s_v5 (general), Standard_E4s_v5 (data)   |
| M               | Tier M reference architecture  | 4              | 1 vCPU, 1Gi per pod | m5.xlarge (general), r5.2xlarge (data)  | Standard_D4s_v5 (general), Standard_E8s_v5 (data)   |
| L               | Tier L reference architecture  | 8              | 2 vCPU, 2Gi per pod | m5.2xlarge (general), r5.4xlarge (data) | Standard_D8s_v5 (general), Standard_E16s_v5 (data)  |
| XL              | Tier XL reference architecture | 16             | 2 vCPU, 2Gi per pod | m5.4xlarge (general), r5.4xlarge (data) | Standard_D16s_v5 (general), Standard_E16s_v5 (data) |

_Reference architectures are defined in the topology sizing design (Section 8). Node types are recommendations — equivalent SKUs may be used._

### Cloud-Specific Staging Notes

| Concern                      | AWS (EKS)                                      | Azure (AKS)                                     |
| ---------------------------- | ---------------------------------------------- | ----------------------------------------------- |
| k6 Operator install          | Helm install on EKS, no special config         | Helm install on AKS, no special config          |
| Prometheus Remote Write      | Self-hosted or Amazon Managed Prometheus (AMP) | Self-hosted or Azure Monitor managed Prometheus |
| Storage for benchmarks       | S3 with IRSA for pod-level access              | Azure Blob with Workload Identity               |
| GPU nodes (LLM benchmarks)   | g5.2xlarge (A10G) or p4d.24xlarge (A100)       | Standard_NC24ads_A100_v4 or Standard_ND96asr_v4 |
| Network policy               | Cilium CNI or VPC CNI                          | Cilium CNI or Azure CNI with Network Policy     |
| Load balancer for k6 targets | ALB/NLB via AWS Load Balancer Controller       | Azure Load Balancer or Application Gateway      |

---

## 7. Per-Tier SLA Table

Draft SLAs — to be replaced with validated numbers from Week 2 tier-calibrated runs.

### Agent Conversations

| Metric                         | Tier S  | Tier M  | Tier L  | Tier XL |
| ------------------------------ | ------- | ------- | ------- | ------- |
| Single-turn p95                | < 2s    | < 1.5s  | < 1s    | < 1s    |
| Multi-turn per-message p95     | < 3s    | < 2.5s  | < 2s    | < 2s    |
| Tool-calling (3 calls) p95     | < 10s   | < 8s    | < 6s    | < 5s    |
| TTFT (time to first token) p95 | < 500ms | < 400ms | < 300ms | < 250ms |
| Concurrent conversations       | 50      | 200     | 1,000   | 5,000   |

### Knowledge Base

| Metric                     | Tier S       | Tier M       | Tier L      | Tier XL      |
| -------------------------- | ------------ | ------------ | ----------- | ------------ |
| Ingestion throughput       | 50 docs/hr   | 200 docs/hr  | 1K docs/hr  | 5K docs/hr   |
| Ingestion p95 (single doc) | < 60s        | < 45s        | < 30s       | < 20s        |
| Embedding batch throughput | 100 chunks/s | 500 chunks/s | 2K chunks/s | 10K chunks/s |

### Search

| Metric                    | Tier S  | Tier M  | Tier L  | Tier XL |
| ------------------------- | ------- | ------- | ------- | ------- |
| Search query p95          | < 500ms | < 300ms | < 200ms | < 150ms |
| Hybrid search p95         | < 800ms | < 500ms | < 350ms | < 250ms |
| Concurrent search queries | 20      | 100     | 500     | 2,000   |

### General

| Metric                      | Tier S | Tier M | Tier L | Tier XL |
| --------------------------- | ------ | ------ | ------ | ------- |
| Error rate                  | < 1%   | < 0.5% | < 0.1% | < 0.1%  |
| Recovery after burst (10x)  | < 60s  | < 60s  | < 30s  | < 30s   |
| Soak test memory drift (4h) | < 10%  | < 5%   | < 5%   | < 3%    |

_Notes:_

- _LLM inference latency dominates agent conversation times and varies by provider/model. The SLAs above measure platform overhead excluding LLM provider latency. The white paper will include a separate table for observed LLM provider latency ranges._
- _All draft SLAs require validation from 3 independent runs (median value). Values will be updated after Week 2 tier-calibrated runs._
- _SLA numbers are published only after statistical validation (coefficient of variation < 15% across 3 runs)._

---

## 8. Harness CI/CD Integration

### Pipeline Architecture

Three pipeline tiers, all using k6 Operator `TestRun` CRDs:

```
Release Branch Push
  └─ Smoke Pipeline (~15 min)
       ├─ Stage 1: benchmark-setup TestRun
       ├─ Stage 2: 8 critical benchmark TestRuns (parallel)
       ├─ Stage 3: Post-run export Job (S3 + Grafana snapshot)
       ├─ Stage 4: SLA threshold check (query Prometheus)
       ├─ Stage 5: benchmark-teardown TestRun
       └─ Gate: pass/fail based on SLA check

Nightly Cron (2 AM)
  └─ Nightly Pipeline (~2 hours)
       ├─ Stage 1: benchmark-setup TestRun
       ├─ Stage 2: 17 per-service TestRuns (parallel, batched)
       ├─ Stage 3: 6 integration TestRuns (parallel)
       ├─ Stage 4: Post-run export Job
       ├─ Stage 5: SLA threshold check
       ├─ Stage 6: benchmark-teardown TestRun
       └─ Notify: Slack alert on regression (p95 > 110% of baseline)

Weekly Cron (Sunday 1 AM)
  └─ Weekly Pipeline (~6 hours)
       ├─ Stage 1: benchmark-setup TestRun
       ├─ Stage 2: All 29 TestRuns (sequential batches)
       ├─ Stage 3: Post-run export Job
       ├─ Stage 4: SLA threshold check
       ├─ Stage 5: Report generator (internal summary)
       ├─ Stage 6: benchmark-teardown TestRun
       └─ Notify: Slack summary to SRE channel
```

### SLA Threshold Check Logic

Harness pipeline step that queries Prometheus after all TestRuns complete:

```bash
# For each SLA metric, query Prometheus and compare against threshold
# Example: single-turn p95 < 2000ms for Tier M
RESULT=$(curl -s "http://prometheus:9090/api/v1/query" \
  --data-urlencode "query=histogram_quantile(0.95, sum(rate(k6_http_req_duration_bucket{scenario='single_turn'}[30m])) by (le))")

P95_MS=$(echo $RESULT | jq '.data.result[0].value[1]' -r)

if (( $(echo "$P95_MS > 1500" | bc -l) )); then
  echo "FAIL: single-turn p95 ${P95_MS}ms exceeds 1500ms SLA"
  exit 1
fi
```

Each metric from the SLA table gets a corresponding Prometheus query. Any failure gates the pipeline.

### TestRun Lifecycle Management

The Harness pipeline manages TestRun CRDs:

1. `kubectl apply -f` the TestRun CRD
2. Poll `kubectl get testrun <name> -o jsonpath='{.status.stage}'` until `finished` or `error`
3. On `error`: capture runner pod logs, fail the pipeline stage
4. On `finished`: proceed to next stage

---

## 9. Customer Deliverables

### 8.1 White Paper (Pre-Sales)

**Title:** ABL Platform — Performance & Sizing Validation

**Audience:** Technical evaluators, architects, procurement

**Updated:** Quarterly (after weekly pipeline produces fresh data)

**Sections:**

1. Platform architecture overview (services, data stores, scaling model)
2. Benchmark methodology (k6, k6 Operator, Prometheus, Grafana)
3. Validated SLA table per tier (S/M/L/XL)
4. Reference architectures with node counts and resource specs
5. Scaling behavior — HPA, KEDA, Karpenter response curves
6. Multi-tenant isolation results
7. Failover and recovery characteristics
8. How to read the results (Grafana dashboard guide)

**Format:** Markdown source in `docs/customer/` → PDF via CI

### 8.2 Customer Runbook (Post-Sale)

**Title:** ABL Platform — Sizing Validation Runbook

**Audience:** Solutions Engineers, customer DevOps teams

**Sections:**

1. Prerequisites (k6 Operator installed, Prometheus configured, credentials, cloud provider identified — AWS or Azure)
2. Run benchmark-setup (`kubectl apply -f benchmark-setup-testrun.yaml`)
3. Run the 8 benchmark TestRuns (provided as ready-to-apply YAMLs with customer-specific env vars)
4. Monitor progress (`kubectl get testrun -n abl-benchmarks -w`)
5. View results in Grafana dashboards
6. Run report generator → produces customer PDF
7. Feed results into sizing calculator → topology recommendation + Helm values
8. Cleanup (`kubectl apply -f benchmark-teardown-testrun.yaml`)

**Local k6 binary fallback:** For customer clusters that cannot install the k6 Operator (CRD restrictions, security policies), the runbook includes a fallback section that runs benchmarks using the k6 CLI binary directly. The same scripts work — only the execution wrapper changes:

```bash
# Fallback: run with local k6 binary instead of k6 Operator
k6 run benchmarks/services/runtime.ts \
  --env RUNTIME_URL=http://<customer-runtime-url>:3112 \
  --env AUTH_TOKEN=<token> \
  --duration 30m --vus 50 \
  --out json=results/runtime.json
```

**Format:** Markdown source in `docs/customer/` → PDF via CI

### 8.3 Customer Report (Per-Engagement)

Auto-generated PDF as described in [Section 5](#5-report-persistence--customer-reports). Unique per customer engagement, stored in object storage under `customer/{name}-{date}/`.

---

## 10. LLM Provider Strategy for Benchmarks

### The Problem

Agent conversation benchmarks call the Runtime, which calls an LLM provider. At 50 VUs for 30 minutes, that's ~50 concurrent LLM API calls. This creates three risks:

1. **Rate limiting** — LLM providers throttle at account level, making results reflect rate limits rather than platform performance
2. **Cost** — Each tier-calibrated run could cost $50-500+ depending on model and volume
3. **Non-determinism** — LLM response times vary by provider load, making results unreproducible

### Approach: Two Benchmark Modes

**Mode 1: Mock LLM (default for per-service and system-wide tests)**

Deploy a lightweight mock LLM endpoint that returns fixed responses with configurable latency:

- Fixed 200ms response delay (simulates median LLM latency)
- Returns a deterministic response body of realistic size (~500 tokens)
- Deployed as a K8s Deployment in `abl-benchmarks` namespace
- Runtime's model chain config points to the mock endpoint

This isolates platform performance from LLM provider variability. Used for:

- All per-service benchmarks (except when testing LLM-specific behavior)
- System-wide stress tests (soak, burst, saturation)
- CI release gates (must be deterministic)

**Mode 2: Real LLM (for integration benchmarks and customer reports)**

Use a real LLM provider for benchmarks that need to demonstrate end-to-end behavior:

- **Provider:** Use the same provider the customer will use (typically OpenAI or Anthropic)
- **Rate limits:** Request elevated rate limits from the provider before benchmark runs (document the limits in the white paper)
- **Cost budget:** Each integration benchmark run should cost < $50. The bootstrap agent uses a small model (e.g., GPT-4o-mini) to minimize cost.
- **Warm-up:** Run 5 min at low VUs before the measured run to prime provider-side caches

Used for:

- Integration E2E benchmarks (agent-conversation, search-query)
- Customer engagement runs

### Configuration

The `model-chain.json` fixture has two variants:

```
benchmarks/fixtures/
  model-chain-mock.json     # Points to mock LLM endpoint
  model-chain-real.json     # Points to real provider (API key from K8s Secret)
```

The bootstrap script selects the variant based on `LLM_MODE` env var (`mock` or `real`).

---

## 11. Risks & Mitigations

| Risk                                                    | Severity | Mitigation                                                                                                                                                               |
| ------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **LLM rate limits break tier-calibrated runs**          | High     | Use mock LLM for platform benchmarks. For real LLM runs, secure elevated limits from provider before benchmark window.                                                   |
| **Staging environment drift from production**           | High     | Maintain a staging-production parity checklist (instance types, data store versions, network topology). Review before each benchmark cycle.                              |
| **Single-run SLA numbers are not statistically robust** | High     | Require 3 independent runs per tier. Publish median values. Only publish if coefficient of variation < 15%.                                                              |
| **Bootstrap build takes longer than estimated**         | Medium   | Days 1-2 of Week 1 are allocated. If bootstrap slips, defer integration E2Es to Week 2 and compress packaging.                                                           |
| **Prometheus retention insufficient for long tests**    | Medium   | Verify Prometheus retention >= 7 days and storage >= 50Gi before soak tests. Configure `--storage.tsdb.retention.time=7d`.                                               |
| **Benchmark corrupts staging data**                     | Medium   | Bootstrap creates isolated tenant/project. Teardown cleans up. Data stores use benchmark-prefixed collections/indices. Staging backup verified before system-wide tests. |
| **ConfigMap size limit (1MiB)**                         | Low      | Keep scripts lean. Large fixture data (documents) mounted from PVC or pulled at runtime via HTTP, not embedded in ConfigMaps.                                            |
| **Nightly regression alert fatigue**                    | Low      | Only alert when p95 exceeds 110% of rolling 7-day baseline. Include "accept new baseline" workflow in runbook for intentional performance changes.                       |

### Nightly Failure Triage Process

When a nightly run fails SLA checks:

1. Slack alert posted to `#engineering-perf` with: which metrics failed, by how much, link to Grafana dashboard
2. On-call engineer triages within 1 business day
3. If regression is real: file a ticket, link to the benchmark run in S3
4. If regression is environmental (staging drift, provider issue): mark as false positive, document in the run's `sla-report.md`
5. Baseline is NOT auto-updated on failure. Manual "accept new baseline" requires explicit approval.

---

## 12. Appendix: TestRun CRD Patterns

### Per-Service Benchmark TestRun

```yaml
apiVersion: k6.io/v1alpha1
kind: TestRun
metadata:
  name: runtime-benchmark
  namespace: abl-benchmarks
  labels:
    benchmark-type: per-service
    service: runtime
spec:
  parallelism: 4
  script:
    configMap:
      name: runtime-benchmark-script
      file: runtime.ts
  arguments: >-
    --env RUNTIME_URL=http://runtime.abl-platform.svc.cluster.local:3112
    --env AUTH_TOKEN=${AUTH_TOKEN}
    --env TENANT_ID=${TENANT_ID}
    --env PROJECT_ID=${PROJECT_ID}
    --duration 30m
    --vus 50
  runner:
    env:
      - name: K6_PROMETHEUS_RW_SERVER_URL
        value: http://prometheus-server.monitoring.svc.cluster.local:9090/api/v1/write
      - name: K6_PROMETHEUS_RW_PUSH_INTERVAL
        value: '5s'
      - name: K6_PROMETHEUS_RW_NATIVE_HISTOGRAMS
        value: 'true'
      - name: K6_PROMETHEUS_RW_TREND_STATS
        value: 'p(50),p(95),p(99),max'
    resources:
      requests:
        cpu: 500m
        memory: 512Mi
      limits:
        cpu: '1'
        memory: 1Gi
```

### Integration Benchmark TestRun

```yaml
apiVersion: k6.io/v1alpha1
kind: TestRun
metadata:
  name: agent-conversation-e2e
  namespace: abl-benchmarks
  labels:
    benchmark-type: integration
    journey: agent-conversation
spec:
  parallelism: 4
  script:
    configMap:
      name: agent-conversation-e2e-script
      file: agent-conversation-e2e.ts
  arguments: >-
    --env RUNTIME_URL=http://runtime.abl-platform.svc.cluster.local:3112
    --env STUDIO_URL=http://studio.abl-platform.svc.cluster.local:5173
    --env AUTH_TOKEN=${AUTH_TOKEN}
    --env TENANT_ID=${TENANT_ID}
    --env PROJECT_ID=${PROJECT_ID}
    --duration 15m
    --vus 20
  runner:
    env:
      - name: K6_PROMETHEUS_RW_SERVER_URL
        value: http://prometheus-server.monitoring.svc.cluster.local:9090/api/v1/write
      - name: K6_PROMETHEUS_RW_PUSH_INTERVAL
        value: '5s'
      - name: K6_PROMETHEUS_RW_NATIVE_HISTOGRAMS
        value: 'true'
      - name: K6_PROMETHEUS_RW_TREND_STATS
        value: 'p(50),p(95),p(99),max'
    resources:
      requests:
        cpu: 500m
        memory: 512Mi
      limits:
        cpu: '1'
        memory: 1Gi
```

### Benchmark Setup TestRun

```yaml
apiVersion: k6.io/v1alpha1
kind: TestRun
metadata:
  name: benchmark-setup
  namespace: abl-benchmarks
  labels:
    benchmark-type: setup
spec:
  parallelism: 1
  script:
    configMap:
      name: benchmark-setup-script
      file: bootstrap.ts
  arguments: >-
    --env RUNTIME_URL=http://runtime.abl-platform.svc.cluster.local:3112
    --env ADMIN_URL=http://admin.abl-platform.svc.cluster.local:3003
    --env SEARCH_AI_URL=http://search-ai.abl-platform.svc.cluster.local:3113
    --env ADMIN_TOKEN=${ADMIN_TOKEN}
    --iterations 1
    --vus 1
  runner:
    resources:
      requests:
        cpu: 250m
        memory: 256Mi
      limits:
        cpu: 500m
        memory: 512Mi
```

### System-Wide Stress TestRun (Soak)

```yaml
apiVersion: k6.io/v1alpha1
kind: TestRun
metadata:
  name: steady-state-soak
  namespace: abl-benchmarks
  labels:
    benchmark-type: system-wide
    test: soak
spec:
  parallelism: 8
  script:
    configMap:
      name: soak-test-script
      file: soak-test.ts
  arguments: >-
    --env RUNTIME_URL=http://runtime.abl-platform.svc.cluster.local:3112
    --env SEARCH_AI_RUNTIME_URL=http://search-ai-runtime.abl-platform.svc.cluster.local:3114
    --env AUTH_TOKEN=${AUTH_TOKEN}
    --env TENANT_ID=${TENANT_ID}
    --env PROJECT_ID=${PROJECT_ID}
    --duration 4h
    --vus 100
  runner:
    env:
      - name: K6_PROMETHEUS_RW_SERVER_URL
        value: http://prometheus-server.monitoring.svc.cluster.local:9090/api/v1/write
      - name: K6_PROMETHEUS_RW_PUSH_INTERVAL
        value: '5s'
      - name: K6_PROMETHEUS_RW_NATIVE_HISTOGRAMS
        value: 'true'
      - name: K6_PROMETHEUS_RW_TREND_STATS
        value: 'p(50),p(95),p(99),max'
    resources:
      requests:
        cpu: '1'
        memory: 1Gi
      limits:
        cpu: '2'
        memory: 2Gi
```

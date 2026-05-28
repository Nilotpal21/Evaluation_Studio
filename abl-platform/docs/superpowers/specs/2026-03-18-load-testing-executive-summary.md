# ABL Platform — Load Testing Executive Summary

**Date:** 2026-03-18
**Prepared for:** Executive Leadership
**Status:** Phase 1 Complete — Infrastructure Validated, First Cloud Test Run Successful

---

## 1. What We Built

We established a comprehensive, production-grade load testing framework for the ABL Platform. This gives us the ability to:

- **Validate performance** before every release and customer deployment
- **Generate customer-facing proof points** with real, measured SLA data
- **Detect regressions** automatically through CI/CD-integrated benchmarks
- **Size customer deployments** using data-driven topology recommendations

### Framework at a Glance

| Component                                       | Status                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| k6 benchmark scripts (29 total)                 | Code written — 17 per-service, 6 integration, 6 system-wide             |
| Scripts validated on k6 Cloud                   | **1 of 29** — Search AI (first end-to-end Cloud run completed)          |
| Scripts with `apiPath()` ingress support        | **8 of 29** — 5 per-service + 3 integration (ready for Cloud execution) |
| Bootstrap harness (automated environment setup) | Implemented — tenant, agent, KB, indexes, seed data                     |
| Grafana k6 Cloud integration                    | Validated — pipeline working (upload → execute → dashboard)             |
| k6 Operator (on-cluster execution)              | Infrastructure ready, TestRun CRDs created                              |
| Tier-based load profiles (S/M/L/XL)             | Defined — maps customer size to VU/duration parameters                  |
| CI/CD pipeline integration (Harness)            | Designed — ready for implementation                                     |

---

## 2. First Cloud Test Run — Results

**Test:** Search AI ingestion benchmark
**Date:** 2026-03-18
**Platform:** Grafana k6 Cloud (Pro plan)
**Target:** `agents-staging.kore.ai` (public ingress)
**Load zone:** Amazon US (Columbus)
**Dashboard:** https://abl.grafana.net/a/k6-app/runs/7037356

### Run Details

| Parameter          | Value                                           |
| ------------------ | ----------------------------------------------- |
| Scenarios executed | 3 (single ingest, bulk ingest, connector sync)  |
| Max concurrent VUs | 35                                              |
| Duration           | ~8 minutes (across 3 sequential scenarios)      |
| Load zone          | Grafana Cloud — Amazon US East                  |
| Execution          | Fully managed — zero infrastructure on our side |

### Key Takeaway

The end-to-end k6 Cloud pipeline is operational:

- Scripts upload from local machine to Grafana Cloud
- Load generated from managed cloud infrastructure
- Results stream in real-time to Grafana k6 Cloud dashboard
- Test history tracked for trend analysis and comparison
- Shareable via URL — no VPN or cluster access needed

---

## 3. Architecture — How It Works

### Dual Execution Model

We support two execution modes using the **same scripts** — no code forks:

```
┌─────────────────────────────────────────────────────────┐
│                  k6 Benchmark Scripts                    │
│        (29 scripts — services, integration, system)      │
└──────────────┬──────────────────────┬────────────────────┘
               │                      │
      ┌────────▼────────┐    ┌────────▼────────┐
      │   k6 Operator   │    │   k6 Cloud      │
      │  (On-Cluster)   │    │  (Managed)      │
      ├─────────────────┤    ├─────────────────┤
      │ CI/CD gates     │    │ Nightly/weekly  │
      │ Data store tests│    │ Customer reports│
      │ Fast, free      │    │ Multi-region    │
      │ Internal URLs   │    │ Shareable URLs  │
      └────────┬────────┘    └────────┬────────┘
               │                      │
      ┌────────▼────────┐    ┌────────▼────────┐
      │ Prometheus +    │    │ k6 Cloud        │
      │ Self-hosted     │    │ Dashboard       │
      │ Grafana         │    │ (12mo retention)│
      └─────────────────┘    └─────────────────┘
```

### What Gets Tested

| Layer                        | Benchmarks                                                                                                                                                        | What It Validates                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Per-Service** (17 scripts) | Runtime, Search AI, BGE-M3, MongoDB, Redis, OpenSearch, ClickHouse, Neo4j, Qdrant, Restate, Studio, Admin, Docling, Preprocessing, Workflows, Multimodal, Crawler | Individual service throughput ceilings, latency under load    |
| **Integration** (6 scripts)  | Agent Conversation E2E, KB Ingestion E2E, Search Query E2E, Workflow E2E, Multi-Agent Orchestration, Channel Messages                                             | Cross-service pipeline performance, bottleneck identification |
| **System-Wide** (6 scripts)  | Soak (4h), Ramp-to-Saturation, Burst (10x spike), Multi-Tenant Isolation, Failover Recovery, Disk Pressure                                                        | Platform stability, scaling limits, recovery characteristics  |

---

## 4. Customer-Facing Value

### Tiered Performance Profiles

We defined four deployment tiers with measurable performance targets:

| Metric                   | Tier S (Starter) | Tier M (Mid-Market) | Tier L (Enterprise) | Tier XL (Hyperscale) |
| ------------------------ | ---------------- | ------------------- | ------------------- | -------------------- |
| Concurrent conversations | 50               | 200                 | 1,000               | 5,000                |
| Messages/day             | < 1K             | 1K–50K              | 50K–500K            | 500K+                |
| KB documents             | < 10K            | 10K–500K            | 500K–5M             | 5M+                  |
| Search queries/day       | < 1K             | 1K–100K             | 100K–1M             | 1M+                  |

_Draft SLA targets are defined per tier. Real numbers will be populated from validated benchmark runs._

### Customer Engagement Workflow

```
SE runs benchmarks on customer's target tier
         ↓
Results appear in k6 Cloud dashboard (shareable URL)
         ↓
Report generator produces branded PDF
         ↓
PDF includes: SLA compliance table, latency charts,
topology recommendation, Grafana screenshots
         ↓
Customer receives data-backed sizing proposal
```

---

## 5. CI/CD Integration Plan

| Pipeline         | Trigger             | What Runs                               | Purpose                                   |
| ---------------- | ------------------- | --------------------------------------- | ----------------------------------------- |
| **Release Gate** | Release branch push | 8 critical scripts (~15 min)            | Block releases that regress performance   |
| **Nightly**      | Cron 2 AM           | 17 per-service + 6 integration (~2 hrs) | Detect regressions early                  |
| **Weekly**       | Cron Sunday 1 AM    | All 29 scripts (~6 hrs)                 | Full capacity validation + trend tracking |

---

## 6. Cloud Provider Support

The framework is cloud-neutral, supporting both AWS and Azure:

| Component            | AWS                       | Azure                    |
| -------------------- | ------------------------- | ------------------------ |
| Kubernetes           | EKS                       | AKS                      |
| Benchmark storage    | S3                        | Azure Blob               |
| Monitoring           | Amazon Managed Prometheus | Azure Monitor Prometheus |
| GPU (LLM benchmarks) | g5/p4d instances          | NC/ND series             |

---

## 7. Cost

### k6 Cloud (Grafana Pro Plan)

| Item              | Monthly                                                       |
| ----------------- | ------------------------------------------------------------- |
| Plan cost         | Included in Grafana Cloud Pro subscription                    |
| VU-hour budget    | 600 VU-hours/month                                            |
| Recommended usage | 2 weekly suite runs (500 VU-hrs) + 4 ad-hoc runs (100 VU-hrs) |
| Data retention    | 12 months                                                     |

### k6 Operator (Self-Hosted)

No additional cost — runs on existing staging cluster compute.

---

## 8. Timeline & Next Steps

### Completed

- [x] Load testing design and spec approved
- [x] 29 benchmark scripts written (code complete, not yet validated)
- [x] 8 critical scripts updated with ingress-compatible URL routing (`apiPath()`)
- [x] Bootstrap harness (automated fixture creation — tenant, agent, KB)
- [x] k6 Cloud pipeline validated — first test run completed (Search AI)
- [x] Tier-based load profiles (S/M/L/XL) defined
- [x] K8s manifests (namespace, TestRun CRDs, secrets)
- [x] Cloud wrapper scripts (`cloud-run.sh`, `cloud-run-suite.sh`)

### Immediate Next (This Week)

- [ ] Validate remaining 7 critical scripts on k6 Cloud against staging
- [ ] Fix endpoint routing issues found during first run (auth, path mapping)
- [ ] Resolve auth token expiry for automated runs (service account or refresh flow)
- [ ] Run all 8 critical scripts end-to-end on k6 Cloud

### Short-Term (Weeks 3–4)

- [ ] Run tier-calibrated benchmarks (3 runs per tier for statistical validation)
- [ ] Generate first customer white paper with real SLA data
- [ ] Wire Harness release-gate pipeline

### Long-Term (Weeks 5–11)

- [ ] Validate remaining 21 scripts (per-service + system-wide)
- [ ] System-wide stress tests (soak, burst, failover)
- [ ] Nightly + weekly automated pipelines
- [ ] Customer self-service sizing validation flow
- [ ] Private Load Zones for internal data store benchmarks

---

## 9. Key Decisions Made

| Decision                              | Rationale                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| **k6 as benchmark tool**              | Native TypeScript, Grafana ecosystem, k6 Operator for K8s, Cloud for managed execution |
| **Dual execution (Operator + Cloud)** | Operator for fast CI gates (free), Cloud for dashboards/sharing/customer reports       |
| **Same scripts for both modes**       | No code forks, `apiPath()` helper handles URL routing differences                      |
| **Tier-based profiles**               | Customer questionnaire maps to VU counts — reproducible, comparable results            |
| **Mock LLM for platform benchmarks**  | Isolates platform performance from LLM provider variability                            |
| **3-run statistical validation**      | Publish SLA numbers only when coefficient of variation < 15%                           |

---

## 10. Risks & Mitigations

| Risk                                      | Mitigation                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| LLM rate limits affect benchmark accuracy | Mock LLM for platform tests, real LLM only for customer demos            |
| Short-lived auth tokens (15 min)          | Long-term: implement service account or API key auth for benchmarks      |
| k6 Cloud Pro plan VU-hour budget (600/mo) | Use k6 Operator for routine CI; reserve Cloud for weekly + customer runs |
| Staging environment drift from production | Staging-production parity checklist before each benchmark cycle          |

---

_For detailed technical specs, see:_

- _`docs/superpowers/specs/2026-03-17-abl-load-testing-design.md`_
- _`docs/superpowers/specs/2026-03-17-k6-cloud-integration-design.md`_

_Dashboard: https://abl.grafana.net/a/k6-app/runs/7037356_

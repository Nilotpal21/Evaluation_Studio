---
name: capacity-planner
description: Capacity planning — saturation testing, auto-scaling, k6 Cloud + kubectl + Coroot metrics, scaling recommendations.
---

# Capacity Planner Skill

Complete playbook for finding saturation points, scaling infrastructure, and verifying auto-scaling behavior across the ABL platform stack. Combines k6 Cloud load generation with live kubectl cluster observation.

**Depends on:** `load-test-analysis` skill for k6 API syntax, Coroot API details, and benchmark script reference.

---

## 0. Control Plane For The Skill

This skill is intentionally detailed. To avoid confused or overly broad answers, the agent must follow this control layer before using the procedural sections below.

### 0.1 Request Classification

Classify the user request into exactly one primary mode before doing anything else:

| Mode                     | Use When                                                                 | Primary Outcome                                                         |
| ------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `plan-only`              | User wants a test plan, ladder, prerequisites, or expected capacity math | Proposed run plan, expected pod/node table, and explicit risks          |
| `live-run`               | User wants the agent to supervise an active or about-to-start run        | Real-time proceed/warn/stop supervision with step-boundary decisions    |
| `post-run-analysis`      | User already has a run ID, report, or poll JSON                          | Clear bottleneck analysis and scaling recommendations                   |
| `safe-scaling-follow-up` | User wants concrete config changes after a completed analysis            | Only safe Deployment/HPA/node-user-pool recommendations or direct edits |

If the request spans multiple modes, finish the current mode first and make the transition explicit in the response.

### 0.2 Minimum Inputs Per Mode

Ask only for inputs that block correct analysis.

| Mode                     | Required Inputs                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `plan-only`              | target environment, benchmark script, step ladder, hold duration, whether output is analysis-only or change-applying          |
| `live-run`               | environment, benchmark script, exact `STEPS`, `STEP_DURATION_MINUTES`, `RAMP_SECONDS`, and run ID once available              |
| `post-run-analysis`      | run ID or poll artifact path, environment, benchmark script if known, and declared step ladder if poll metadata is incomplete |
| `safe-scaling-follow-up` | completed analysis result, allowed write scope, and whether the user wants recommendations only or edits applied              |

If hold-window boundaries, step ladder, or run ID are unknown, lower confidence immediately and say why.

### 0.3 Evidence Hierarchy

Use evidence in this order:

1. Hold-phase poll JSON for the current step
2. Direct k6 time-series for the same hold window
3. Coroot metrics for service saturation, event-loop delay, CPU delay, and datastore behavior
4. Kubernetes events/logs as explanatory evidence

Rules:

- Never mix ramp data into hold-window conclusions.
- Never use whole-run averages to decide a specific step.
- Never present a k6 dashboard screenshot or single noisy live sample as stronger evidence than a clean hold-window slice.
- If evidence conflicts, prefer the narrowest time-aligned source and recommend the more conservative action.

### 0.4 Bottleneck Attribution Contract

The goal is to identify the **first real bottleneck**, not list every stressed component.

For every bottleneck claim, the agent must state:

- exact service or layer
- exact VU step / hold window
- limiting metric and observed value
- relevant configured limit, target, or guardrail
- why this is the gating factor rather than a downstream symptom

Allowed labels:

- `healthy headroom`
- `degrading`
- `saturated`
- `insufficient evidence`

If the agent cannot defend the bottleneck with time-aligned evidence, it must say `insufficient evidence`.

### 0.5 Required Response Shape

Every substantive answer produced from this skill must use this structure:

1. `Mode` and exact scope
2. `Executive Summary`
3. `Primary Bottleneck`
4. `Supporting Signals`
5. `Recommended Actions`
6. `Risks / Uncertainty`
7. `Next Validation Step`

Within `Recommended Actions`, split recommendations into:

- `Agent-can-apply`
- `User-must-apply`

### 0.6 Repository And Change-Scope Rules

- Stay on the current branch unless the user explicitly instructs otherwise.
- Never tell the agent to commit or push to `main` by default.
- If edits are allowed, only modify files inside the permitted scope for this mode.
- If the true fix is a forbidden StatefulSet or restricted Terraform change, stop at a recommendation with exact file/field guidance.

### 0.7 Section Map And Reading Order

Use the skill in this order instead of scanning the whole file linearly:

| Need                              | Read First            | Then Use                                   |
| --------------------------------- | --------------------- | ------------------------------------------ |
| Scope the task correctly          | Section 0             | Section 1, then the mode-specific sections |
| Plan a new run                    | Sections 1-4          | Sections 7, 12, and 14                     |
| Supervise a live run              | Sections 10.1-10.7    | Sections 12, 13.2, and 14                  |
| Diagnose a bottleneck after a run | Sections 10.8-10.10   | Sections 12, 13.3, 15, and 16              |
| Apply safe scaling changes        | Sections 5 and 10.10A | Sections 12 and 14.4 for justification     |

Document layout:

- Sections `1-9` are planning, modeling, and reference material.
- Sections `10-11` are the execution workflow and generated artifacts.
- Sections `12-16` are the analysis appendix: thresholds, Coroot protocol, scorecards, MongoDB delay triage, and error-log review.

---

### CRITICAL SAFETY RULES

**NEVER modify StatefulSets — not via kubectl, not via Helm edits, not at all.** StatefulSets manage stateful infrastructure (MongoDB, Redis, Kafka, ClickHouse, OpenSearch, Neo4j). They have persistent volumes, ordered startup, and stable network identities. A wrong change can cause data loss, split-brain, or extended downtime.

**The agent must NEVER:**

- Run any kubectl write operation on StatefulSets: `kubectl scale`, `kubectl patch`, `kubectl delete`, `kubectl edit`, `kubectl rollout restart`, `kubectl exec` (write)
- Edit Helm values for StatefulSet workloads: `mongodb.*`, `redis.*`, `kafka.*`, `clickhouse.*`, `opensearch.*`, `neo4j.*` in `values-dev.yaml`
- Edit Terraform for database node pools: `db_node_*` in `.tfvars`

**The agent MAY:**

- **Read/observe** StatefulSet pods: `kubectl get`, `kubectl top`, `kubectl describe`, `kubectl logs` — always safe
- **Modify Deployments only:** HPA, PDB, replica count, resource requests/limits, configMap for Deployment-based workloads

| Workload Type   | Examples                                                                                                                           | Agent May Modify                                                                                     | Agent Must NOT Touch                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Deployment**  | runtime, studio, search-ai, ingress-nginx, workflow-engine, multimodal, preprocessing, crawlers, codetool-sandbox, bge-m3, docling | HPA (min/max replicas, targetCPU, behavior), PDB, resource requests/limits, replica count, configMap | N/A — all safe                                                                     |
| **StatefulSet** | MongoDB, Redis, Kafka, ClickHouse, OpenSearch, Neo4j                                                                               | **READ ONLY.** Observe via get/top/describe/logs.                                                    | Everything else. No edits to Helm values, no kubectl writes, no Terraform changes. |

**If a StatefulSet needs scaling** (e.g., MongoDB needs more CPU, Redis needs more replicas, Kafka needs more brokers):

1. **Stop.** Do NOT make the change yourself.
2. **Tell the user** exactly what needs to change and why (with evidence from the poll JSON).
3. **The user will make the change manually** in `values-dev.yaml` and push it.
4. Example message to user: _"MongoDB CPU is at 78% of its 16-core limit at 800 VUs. Recommend increasing `mongodb.resources.limits.cpu` from 16 to 24 in values-dev.yaml. This is a StatefulSet change — please make this edit and push manually."_

**This rule applies to the polling script too** — `cluster-poll.sh` is strictly read-only. It only uses `kubectl get` and `kubectl top`.

---

### Agent Command Reference

These are the exact commands the agent runs during each phase. Copy-paste ready.

#### Observing (always safe — read-only)

```bash
# Pre-flight: one-shot poll to verify cluster health
MAX_POLLS=1 RUN_ID=preflight ./benchmarks/scripts/cluster-poll.sh

# Read the pre-flight JSON result
# Agent uses: Read tool → benchmarks/results/polls/preflight/poll-0001.json

# Quick cluster snapshot (without the full poller)
CTX="aks-abl-dev-centralus" NS="abl-platform-dev"
kubectl --context $CTX -n $NS get hpa                          # All HPAs
kubectl --context $CTX -n $NS get pods -o wide                 # All pods
kubectl --context $CTX -n $NS describe hpa <name>              # HPA details
kubectl --context $CTX top nodes                               # Node utilization
kubectl --context $CTX -n $NS get events --sort-by='.lastTimestamp' | tail -20
```

#### Launching a Load Test

```bash
# Launch k6 Cloud run (background — agent uses run_in_background: true)
STEPS=200,500,800,1000,1200,1500 STEP_DURATION_MINUTES=5 RAMP_SECONDS=120 \
  ./benchmarks/scripts/cloud-run.sh benchmarks/multi-tenant-saturation.ts

# CRITICAL: Single invocation only. Never run twice.
# Extract RUN_ID from output: "Run ID: 7300001"
```

#### Starting the Poller (background)

```bash
# Launch poller alongside k6 (background — agent uses run_in_background: true)
# CRITICAL: Pass the same STEPS/STEP_DURATION_MINUTES/RAMP_SECONDS used for k6.
# Without these, the poller cannot compute k6.step.* (phase/stepIndex/stepVUs)
# and the "only trust hold-phase metrics" contract in 10.5A is weakened.
STEPS=200,500,800,1000,1200,1500 STEP_DURATION_MINUTES=5 RAMP_SECONDS=120 \
  RUN_ID=<k6-run-id> ./benchmarks/scripts/cluster-poll.sh
# Runs until stopped or MAX_POLLS reached
# Output: benchmarks/results/polls/<RUN_ID>/summary.json
# Pidfile: benchmarks/results/polls/<RUN_ID>/poller.pid
# To stop: ./benchmarks/scripts/cluster-poll.sh --stop <RUN_ID>
```

#### Real-Time Supervision Loop (agent must monitor while k6 is running)

```bash
# Check k6 run status every 30-60s
curl -s -H "Authorization: Token $K6_CLOUD_TOKEN" \
  "https://api.k6.io/cloud/v5/test_runs/<K6_RUN_ID>" | jq '{result_status, started, ended}'

# Read the latest cluster poll every 30-60s
ls -t benchmarks/results/polls/<RUN_ID>/poll-*.json | head -1

# While the run is active, the agent must continuously supervise:
#   - latest runtime replicas / HPA / pod CPU / pod memory
#   - pending pods / node growth / infra CPU
#   - latest k6 throughput / p95 / error rate (from poll JSON's k6 section)
#   - warn / continue / soft-stop / hard-stop accordingly
```

#### Reading Poll Data During The Run

```bash
# Read the full summary when needed:
# Agent uses: Read tool → benchmarks/results/polls/<RUN_ID>/summary.json

# For live supervision, read the latest individual poll:
# Agent uses: Bash → ls -t benchmarks/results/polls/<RUN_ID>/poll-*.json | head -1
# Then Read tool on that file

# Count polls collected so far
ls benchmarks/results/polls/<RUN_ID>/poll-*.json | wc -l
```

#### Querying k6 Metrics During The Run

```bash
# The latest poll JSON now includes live k6 metrics:
#   k6.run.resultStatus
#   k6.current.vus.value
#   k6.current.throughputMsgPerSec.value
#   k6.current.errorRate.value
#   k6.current.p95LatencyMs.value
#
# Read the latest poll first for the live point-in-time view.
# Query the k6 API directly when you need a wider hold-window slice or fallback verification.

# Use the v5 run API and time-series queries.
# Do NOT use whole-run aggregates for per-step decisions.

# 1. Get run bounds first
curl -s -H "Authorization: Token $K6_CLOUD_TOKEN" \
  "https://api.k6.io/cloud/v5/test_runs/<K6_RUN_ID>" | jq '{result_status, started, ended}'

# 2. For live monitoring, query from run start until current UTC time.
#    Replace START/END with seconds-precision UTC timestamps (UNQUOTED, no fractional seconds):
#    e.g., start=2026-04-10T15:30:00Z,end=2026-04-10T15:35:00Z
curl -s -H "Authorization: Token $K6_CLOUD_TOKEN" \
  "https://api.k6.io/cloud/v5/test_runs/<K6_RUN_ID>/query_range_k6(metric='chat_turn_success_total',query='rate',step=30,start=START,end=END)"

curl -s -H "Authorization: Token $K6_CLOUD_TOKEN" \
  "https://api.k6.io/cloud/v5/test_runs/<K6_RUN_ID>/query_range_k6(metric='http_req_failed',query='rate',step=30,start=START,end=END)"

curl -s -H "Authorization: Token $K6_CLOUD_TOKEN" \
  "https://api.k6.io/cloud/v5/test_runs/<K6_RUN_ID>/query_range_k6(metric='chat_turn_latency_ms',query='p95',step=30,start=START,end=END)"

# OData gotchas:
#   - metric and query are STRING params → wrap in single quotes: metric='...'
#   - start and end are Edm.DateTimeOffset → NO quotes: start=2026-04-10T15:30:00Z
#   - Quoting datetimes causes: "Expected value of type datetime for Edm.DateTimeOffset"
#   - Timestamps must be seconds-precision UTC (no .000Z fractional)
#
# 3. During the run, prefer the poll JSON's k6 section for live signals.
#    Use direct API calls only when you need a wider hold-window slice.
# 4. At hold-window boundaries, analyse only that hold window for step decisions.
```

#### Scaling Deployments (HPA / replicas / resources)

All changes go through Helm values — never kubectl directly.

```bash
# Agent uses: Edit tool → abl-platform-deploy/environments/dev/values.yaml
# Then commit + push → ArgoCD syncs automatically
#
# CRITICAL: ArgoCD reads from environments/dev/values.yaml — NOT helm/abl-platform-stack/values-dev.yaml.
# The helm/ file is the chart-level default; the environments/ file is the ArgoCD overlay.
# Verify with: kubectl -n argocd get app abl-platform-dev -o jsonpath='{.spec.source.helm.valueFiles}'

# Example edits (Deployments ONLY):
# runtime.hpa.minReplicas, maxReplicas, targetCPUUtilizationPercentage
# runtime.hpa.behavior.scaleUp.stabilizationWindowSeconds
# runtime.hpa.behavior.scaleUp.policies
# runtime.resources.requests.cpu, memory
# runtime.resources.limits.cpu, memory
# runtime.pdb.enabled, minAvailable
# runtime.replicas
# studio.hpa.*, searchAi.hpa.*, workflowEngine.hpa.*, etc.
```

#### Infrastructure & Node Pool Changes (USER ONLY — agent must not edit)

The agent NEVER edits StatefulSet Helm values, database Terraform, or node pool Terraform.
When analysis shows infra needs scaling, **tell the user what to change and why**:

```
Example message to user:

  "MongoDB is at 78% CPU limit (12.5/16 cores) at 800 VUs.
   Recommend changing in values-dev.yaml:
     mongodb.resources.limits.cpu: 16 → 24
     mongodb.resources.requests.cpu: 8 → 12

   Also, database node pool needs bigger VMs:
     db_node_vm_size: Standard_D16s_v5 → Standard_D32s_v5  (in dev-azure-centralus.tfvars)

   These are StatefulSet/infra changes — please make them manually and push."
```

**Files the agent must NOT edit:**

| File                           | Forbidden Sections                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `environments/dev/values.yaml` | `mongodb.*`, `redis.*`, `kafka.*`, `clickhouse.*`, `opensearch.*`, `neo4j.*`, `qdrant.*`    |
| `dev-azure-centralus.tfvars`   | `db_node_*`, `gpu_node_*`                                                                   |
| `main.tf`                      | `azurerm_kubernetes_cluster_node_pool.database`, `azurerm_kubernetes_cluster_node_pool.gpu` |

**Files the agent MAY edit:**

| File                           | Allowed Sections                                                                                                                                                                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environments/dev/values.yaml` | `runtime.*`, `studio.*`, `searchAi.*`, `searchAiRuntime.*`, `admin.*`, `preprocessing.*`, `workflowEngine.*`, `multimodal.*`, `crawlerGoWorker.*`, `crawlerMcpServer.*`, `codetoolSandbox.*`, `bgeM3.*`, `docling.*`, `ingress-nginx.*`, `pipelineEngine.*` |
| `dev-azure-centralus.tfvars`   | `user_node_min_count`, `user_node_max_count`, `user_node_vm_size`, `ci_node_*`                                                                                                                                                                              |
| `main.tf`                      | `auto_scaler_profile`, `azurerm_kubernetes_cluster_node_pool.user`, `azurerm_kubernetes_cluster_node_pool.ci`                                                                                                                                               |

#### Stopping k6 and the Poller

```bash
# Stop a running k6 Cloud test — use this for hard/soft stops
./benchmarks/scripts/stop-k6.sh <K6_RUN_ID>
# Tries: k6 CLI abort → API POST /stop → v4 PATCH. Falls back to manual URL.

# Stop the poller (pidfile-based — works non-interactively):
./benchmarks/scripts/cluster-poll.sh --stop <RUN_ID>
# Reads benchmarks/results/polls/<RUN_ID>/poller.pid and sends SIGTERM.
# Also auto-stops when MAX_POLLS is reached (if set).
```

#### Verifying ArgoCD Sync After Changes

```bash
CTX="aks-abl-dev-centralus"
kubectl --context $CTX -n argocd get application abl-platform-dev
kubectl --context $CTX -n argocd get application abl-platform-dev \
  -o jsonpath='{.status.sync.status}'
kubectl --context $CTX -n argocd get application abl-platform-dev \
  -o jsonpath='{.status.conditions[*].message}'
```

---

## 1. Workflow Overview

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  1. Baseline │────▶│ 2. Saturation│────▶│ 3. Capacity  │────▶│ 4. Scale &   │────▶│ 5. Verify &  │
│   Profile    │     │    Ladder    │     │    Plan      │     │   Configure  │     │   Re-test    │
└─────────────┘     └──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
 Low VUs, find       Ramp VUs until       Calculate pods,      Edit Helm values,    Re-run ladder
 per-pod ceiling     efficiency < 85%     nodes, DB sizing     Terraform, HPA       at target VUs
```

Each phase produces a document in `benchmarks/docs/` or `docs/load-testing/`.

---

## 2. Phase 1: Baseline Profile

### Goal

Find the **per-pod performance envelope** — max VUs and msg/s a single pod can handle before saturation.

### Prerequisites

- k6 Cloud configured (`benchmarks/config/cloud.env`)
- Target environment accessible from k6 Cloud runners
- Mock LLM enabled (`MOCK_LLM=true`) for infrastructure-only testing
- Runtime replica count is pinned for the entire run. A baseline is invalid if runtime autoscaling changes pod count mid-test.

### Pin Runtime Before Baseline

**CRITICAL:** Phase 1 only measures a per-pod envelope when runtime is fixed at a known replica count.

1. Pin runtime to a fixed count in Helm values before the run.
2. Keep `minReplicas == maxReplicas == replicas == 2` for the full baseline.
3. Verify `currentReplicas` and `desiredReplicas` stay at `2` throughout the run.
4. If runtime scales above 2 pods at any point, discard the run and re-run the baseline.

### Run

```bash
# Low VUs, stepped, exactly 2 fixed runtime pods
STEPS=20,40,60,100 STEP_DURATION_MINUTES=4 RAMP_SECONDS=30 \
  ./benchmarks/scripts/cloud-run.sh benchmarks/multi-tenant-saturation.ts
```

**CRITICAL:** Run `cloud-run.sh` in a SINGLE Bash call. Never pipe through two commands — each invocation launches a NEW k6 Cloud test run.

### Observe via kubectl (parallel with k6 run)

Poll cluster state every 30s during the run:

```bash
CONTEXT="aks-abl-dev-centralus"
NS="abl-platform-dev"

# Runtime pods — count, CPU, memory
kubectl --context $CONTEXT -n $NS top pods -l app.kubernetes.io/component=runtime

# HPA state — current replicas, targets, metrics
kubectl --context $CONTEXT -n $NS get hpa abl-platform-dev-runtime

# Node utilization
kubectl --context $CONTEXT top nodes

# Pod distribution across nodes
kubectl --context $CONTEXT -n $NS get pods -l app.kubernetes.io/component=runtime -o wide
```

### Key Metrics to Extract

| Metric                      | Source       | How                                                                                                                                          |
| --------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Throughput per step (msg/s) | k6 Cloud API | Pull `chat_turn_success_total` as a run-bounded time series and keep only the current step's hold window (`phase=hold`, `step=step_<VUs>vu`) |
| Latency per step (avg, p95) | k6 Cloud API | Pull `chat_turn_latency_ms` as a run-bounded time series and analyse only the hold window for the current step                               |
| Error rate                  | k6 Cloud API | Pull `http_req_failed` as a run-bounded time series and analyse only the hold window for the current step                                    |
| CPU per pod (cores)         | kubectl      | `kubectl top pods -l app.kubernetes.io/component=runtime`                                                                                    |
| Memory per pod              | kubectl      | Same command                                                                                                                                 |
| Pod count over time         | kubectl      | `kubectl get hpa` (REPLICAS column)                                                                                                          |
| Node count                  | kubectl      | `kubectl get nodes`                                                                                                                          |

### Baseline Profile Template

Save to `benchmarks/docs/baseline-profile-<date>.md`:

```markdown
# Baseline Profile — <date>

**Run ID:** <k6_run_id>
**Config:** <N> pods, <CPU> req/<CPU> limit, maxPoolSize=<N>

## Per-Pod Performance Envelope

| VU Step | Per-Pod VUs | Per-Pod msg/s | CPU (cores) | Memory (Mi) |
| ------- | ----------- | ------------- | ----------- | ----------- |
| 20      | 10          | 5.3           | 0.10        | 822         |
| 40      | 20          | 10.5          | 0.24        | 1002        |
| 60      | 30          | 15.4          | 0.37        | 1115        |
| 100     | 50          | 20.7          | 0.50        | 1252        |

## Sustainable Operating Point

**<X> msg/s per pod** (<Y> VUs/pod) — CPU < <Z> cores, memory stable.

## Saturation Point

**<A> VUs total** — efficiency drops below 85%, latency jumps disproportionately.

## Bottlenecks

1. ...
2. ...
```

### Key Formulas

```
Throughput efficiency = actual_msg_s / (VUs / VUs_baseline * baseline_msg_s) * 100%
Platform overhead = avg_latency - mock_llm_baseline (typically ~1000ms)
Per-pod ceiling = VUs where efficiency drops below 90%
Safe operating point = VUs where CPU stays comfortably below the HPA trigger relative to CPU request
HPA CPU utilization = actual CPU / CPU request (NOT CPU limit)
Memory guardrail = RSS stays < 70% of memory limit with no upward drift across hold windows
```

---

## 3. Phase 2: Saturation Ladder

### Goal

Progressive VU ramp to find the **system-level saturation point** — where auto-scaling can't keep up or infrastructure hits limits.

### VU Steps

Choose steps based on target. For 1500 VU target:

```bash
STEPS=200,500,800,1000,1200,1500 STEP_DURATION_MINUTES=5 RAMP_SECONDS=120 \
  ./benchmarks/scripts/cloud-run.sh benchmarks/multi-tenant-saturation.ts
```

For initial exploration (unknown ceiling):

```bash
MULTI_TENANT=false STEPS=50,100,200,400 STEP_DURATION_MINUTES=4 RAMP_SECONDS=60 \
  ./benchmarks/scripts/cloud-run.sh benchmarks/multi-turn-saturation.ts
```

### Live Cluster Monitoring

During the saturation run, poll every 30-60 seconds:

```bash
CONTEXT="aks-abl-dev-centralus"
NS="abl-platform-dev"

# === Runtime scaling ===
kubectl --context $CONTEXT -n $NS get hpa abl-platform-dev-runtime
kubectl --context $CONTEXT -n $NS top pods -l app.kubernetes.io/component=runtime --sort-by=cpu

# === Infrastructure health ===
# MongoDB — connections, CPU
kubectl --context $CONTEXT -n $NS top pods -l app=abl-platform-dev-mongodb-svc
# Redis — CPU, memory
kubectl --context $CONTEXT -n $NS top pods -l app.kubernetes.io/name=redis
# Kafka — CPU, memory
kubectl --context $CONTEXT -n $NS top pods -l strimzi.io/cluster
# Ingress — CPU, connections
kubectl --context $CONTEXT -n $NS top pods -l app.kubernetes.io/name=ingress-nginx
# ClickHouse
kubectl --context $CONTEXT -n $NS top pods -l app.kubernetes.io/name=clickhouse

# === Node-level ===
kubectl --context $CONTEXT top nodes
kubectl --context $CONTEXT get nodes -o wide

# === Events (scaling, evictions, OOM) ===
kubectl --context $CONTEXT -n $NS get events --sort-by='.lastTimestamp' --field-selector reason!=Pulled,reason!=Created,reason!=Started | tail -20

# === PDB status (disruption budget) ===
kubectl --context $CONTEXT -n $NS get pdb
```

### Saturation Signals Checklist

Poll and record these at each VU step:

| Signal               | How to Check                             | Threshold                                                           |
| -------------------- | ---------------------------------------- | ------------------------------------------------------------------- |
| HPA not scaling      | `get hpa` — REPLICAS stuck below MAXPODS | Pods not growing with VUs                                           |
| HPA scaling too slow | Compare VU ramp time vs pod count growth | Pods lag VUs by > 2 minutes                                         |
| Pods Pending         | `get pods` — STATUS=Pending              | Any Pending = node capacity hit                                     |
| Node capacity        | `top nodes` — CPU > 85%                  | Need more nodes                                                     |
| Pod eviction         | `get events` — reason=Evicted            | PDB missing or misconfigured                                        |
| Pod OOMKilled        | `get events` — reason=OOMKilled          | Memory limit too low                                                |
| MongoDB CPU          | `top pods -l mongodb` — CPU near limit   | Need bigger DB nodes                                                |
| Event loop lag       | Coroot Node.js runtime metrics           | > 100ms avg = degraded; see 12.1                                    |
| Runtime CPU delay    | Coroot app CPU metrics                   | > 100ms/s avg = node contention; see 12.1                           |
| MongoDB CPU delay    | Coroot MongoDB + node CPU metrics        | Low CPU + high delay = investigate thundering herd; see 12.2 and 15 |
| Mongo write latency  | Coroot MongoDB metrics                   | > 40ms sustained = write path backing up; see 12.2                  |
| Redis CPU            | `top pods -l redis` — CPU near limit     | Need replicas or cluster mode                                       |
| Error rate           | k6 Cloud API                             | > 1% sustained                                                      |
| p95 spike            | k6 Cloud API                             | > 3x baseline                                                       |

### Resource Protection Guardrails

These are **smart stop** conditions. They prevent wasting pods, nodes, and shared infra when extra load is no longer buying useful throughput.

**Headroom is intentional. Do not stop just because the system enters reserved capacity.**

Keep this reserve unless the test goal explicitly requires pushing past it:

- Runtime / HPA: keep roughly 15-20% replica headroom below `maxReplicas`
- Nodes: keep at least 1 spare user node or roughly 15% allocatable CPU headroom
- Stateful services: treat 80-85% CPU as the edge of safe steady-state, not the normal operating point

Stop the run early if any of these patterns appear, even if user-visible errors are still low:

| Pattern                              | Why It Matters                                                                 | Guardrail                                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Throughput plateau + pod growth      | Runtime pods are being consumed without meaningful capacity gain               | Stop if pod count grows by > 20% vs previous step, actual msg/s improves by < 10%, and the run is consuming replica headroom               |
| Throughput plateau + node growth     | Cluster autoscaler is spending nodes for little useful work                    | Stop if node count increases, efficiency does not recover above 85% by hold end, and the extra node is consuming reserved cluster headroom |
| Infra burn without errors yet        | Stateful services can be pushed into a bad state before the app starts failing | Stop if MongoDB, Redis, Kafka, or ClickHouse stays above ~85% of CPU limit for most of a hold window with no recovery back into headroom   |
| Memory drift under steady load       | Heap/RSS creep means the next step will consume resources disproportionately   | Stop if RSS or heap grows > 15% across a hold window without stabilizing                                                                   |
| HPA maxed but latency not recovering | Continuing only burns resources at the ceiling                                 | Stop if runtime stays at `maxReplicas` for the full hold window and p95 or error rate does not improve                                     |

### Recording Format

Build a time-series observation table during the run:

```markdown
| Time  | VUs | Pods | Pod CPU (avg) | Pod Mem (avg) | Nodes | Errors | Notes                   |
| ----- | --- | ---- | ------------- | ------------- | ----- | ------ | ----------------------- |
| 14:00 | 200 | 4    | 450m          | 1.2Gi         | 2     | 0%     | Scaling from 2→4        |
| 14:05 | 200 | 7    | 280m          | 1.1Gi         | 2     | 0%     | Steady                  |
| 14:10 | 500 | 7    | 680m          | 1.3Gi         | 3     | 0%     | HPA scaling, node added |
```

---

## 4. Phase 3: Capacity Plan

### Goal

Calculate exact infrastructure needed for target VU count.

### Capacity Formulas

```
# Pod count
pods_needed = target_msg_s / safe_msg_s_per_pod
target_msg_s = target_VUs / time_per_turn
time_per_turn = mock_llm_latency + platform_overhead + inter_message_delay

# Node count (user pool)
cores_needed = pods_needed * cpu_request
nodes_needed = ceil(cores_needed / allocatable_cores_per_node)
# D8s_v5: 8 vCPU, ~7 allocatable after system daemons
# D16s_v5: 16 vCPU, ~14 allocatable

# MongoDB connections
total_connections = pods_needed * MONGODB_MAX_POOL_SIZE
# MongoDB RS safe limit: ~3,000 connections
# If total > 2,000: consider sharding or reducing pool size

# Redis connections
# ioredis: 1 connection per pod for commands, 1 for pub/sub = 2 per pod
# total = pods * 2 — Redis handles 10K+ connections easily
# Bottleneck is throughput, not connections

# Kafka throughput
# Each message generates ~4 Kafka events (trace, audit, analytics, checkpoint)
# kafka_events_per_second = target_msg_s * 4
# Single Kafka broker handles ~50K msg/s easily
```

### Infrastructure Spec Template

```markdown
## Infrastructure Specification for <X> VUs

### Runtime

| Setting               | Value | Rationale                       |
| --------------------- | ----- | ------------------------------- |
| replicas              | <N>   | target_msg_s / safe_per_pod     |
| cpu request           | <N>   | Node.js single-threaded ceiling |
| cpu limit             | <N>   | 2x request for burst            |
| memory request        | <N>   | Baseline RSS + 50% headroom     |
| memory limit          | <N>   | 2x request                      |
| MONGODB_MAX_POOL_SIZE | <N>   | Total conns within RS limit     |

### HPA

| Setting                 | Value      | Rationale                           |
| ----------------------- | ---------- | ----------------------------------- |
| minReplicas             | <N>        | Idle cost floor                     |
| maxReplicas             | <N>        | Peak + 20% headroom                 |
| targetCPU               | <N>%       | Trigger before event loop saturates |
| scaleUp stabilization   | <N>s       | React time for VU ramp rate         |
| scaleUp policy          | +<N>%/<N>s | Match ramp speed                    |
| scaleDown stabilization | <N>s       | Hold during VU transitions          |

### Nodes (AKS)

| Pool     | VM Size | Min | Max | Rationale                           |
| -------- | ------- | --- | --- | ----------------------------------- |
| user     | <size>  | <N> | <N> | cores_needed / allocatable_per_node |
| database | <size>  | <N> | <N> | MongoDB/CH/Redis sizing             |

### MongoDB

| Setting              | Value   | Rationale                             |
| -------------------- | ------- | ------------------------------------- |
| cpu request/limit    | <N>/<N> | Handles <X> connections at <Y> ops/s  |
| memory request/limit | <N>/<N> | WiredTiger cache for connection count |

### Redis

| Setting          | Value                              | Rationale                               |
| ---------------- | ---------------------------------- | --------------------------------------- |
| architecture     | <standalone\|replication\|cluster> | Based on pod count and read/write ratio |
| master resources | <cpu>/<mem>                        | Write throughput from all pods          |
| replica count    | <N>                                | Read distribution                       |

### ClickHouse

| Setting  | Value | Rationale                    |
| -------- | ----- | ---------------------------- |
| shards   | <N>   | Analytics write distribution |
| replicas | <N>   | HA per shard                 |

### Kafka

| Setting            | Value | Rationale                  |
| ------------------ | ----- | -------------------------- |
| broker replicas    | <N>   | Throughput and replication |
| replication factor | <N>   | Durability                 |

### Ingress-NGINX

| Setting     | Value                         | Rationale               |
| ----------- | ----------------------------- | ----------------------- |
| minReplicas | <N>                           | Upstream backend count  |
| config      | keepalive, worker-connections | High-concurrency tuning |
```

---

## 5. Phase 4: Scale & Configure

### Files to Modify

| Change                      | File                                                | Repo                |
| --------------------------- | --------------------------------------------------- | ------------------- |
| Runtime HPA, PDB, configMap | `environments/dev/values.yaml`                      | abl-platform-deploy |
| HPA behavior template       | `helm/abl-platform/templates/runtime/hpa.yaml`      | abl-platform-deploy |
| MongoDB resources           | `environments/dev/values.yaml`                      | abl-platform-deploy |
| Redis architecture          | `environments/dev/values.yaml`                      | abl-platform-deploy |
| ClickHouse shards/replicas  | `environments/dev/values.yaml`                      | abl-platform-deploy |
| Kafka brokers               | `environments/dev/values.yaml`                      | abl-platform-deploy |
| Ingress-NGINX               | `environments/dev/values.yaml`                      | abl-platform-deploy |
| AKS node pools              | `terraform/environments/dev-azure-centralus.tfvars` | abl-platform-infra  |
| Cluster autoscaler profile  | `terraform/modules/kubernetes/azure/main.tf`        | abl-platform-infra  |

**CRITICAL: ArgoCD values file mapping.** ArgoCD for dev reads `environments/dev/values.yaml`, NOT `helm/abl-platform-stack/values-dev.yaml`. The `helm/` file is the chart-level default. The `environments/` file is the per-environment ArgoCD overlay and takes precedence. All Helm value edits for live environments go in `environments/<env>/values.yaml`. Verify via: `kubectl -n argocd get app abl-platform-dev -o jsonpath='{.spec.source.helm.valueFiles}'`

**REMINDER:** The agent may only edit HPA, PDB, replica count, and resource settings for **Deployments** (runtime, studio, search-ai, etc.). For **StatefulSets** (MongoDB, Redis, Kafka, ClickHouse, OpenSearch, Neo4j) and **database/GPU node pools** in Terraform — tell the user what to change and let them do it manually. See Safety Rules at the top.

### Auto-Scaling Design Principles

1. **Start small, scale on demand** — `minReplicas` should be low (2-4), not the full target. Let HPA scale up.
2. **maxReplicas = target + 20% headroom** — ceiling must accommodate peak + burst.
3. **Scale-up fast, scale-down slow** — aggressive scale-up (double every 15s), conservative scale-down (10% every 2min, 10min stabilization).
4. **Node auto-scaling ceiling** — `user_node_max_count` must accommodate max pods. Formula: `ceil(maxReplicas * cpu_request / allocatable_per_node) + 2` (headroom for other services).
5. **PDB always enabled** — prevents cluster autoscaler from evicting pods during load.
6. **Cluster autoscaler profile** — `scale_down_delay_after_add: 15m` prevents thrashing during ramp.

### HPA Tuning Reference

| Scenario                          | targetCPU | Scale-Up Policy           | Stabilization |
| --------------------------------- | --------- | ------------------------- | ------------- |
| Gradual ramp (2min between steps) | 50%       | +100%/15s or +8 pods/15s  | 15s           |
| Burst load (instant VU jump)      | 40%       | +200%/15s or +10 pods/15s | 0s            |
| Steady state (production)         | 60%       | +50%/30s or +4 pods/30s   | 60s           |
| Cost-sensitive (dev idle)         | 70%       | +100%/30s or +4 pods/30s  | 60s           |

### Scaling Chain Timing

```
HPA detects overload     →  15s  (scrape interval + stabilization)
HPA creates new pods     →  0-5s (API call)
Pods go Pending          →  0s   (if node capacity exists)
  └─ Node auto-scaler    →  3-5m (AKS provisions new VM)
  └─ Pod scheduling      →  10s  (kube-scheduler)
Container startup        →  10-30s (image pull + healthcheck)
Pod Ready                →  30-60s (readiness probe passes)
Traffic routes to pod    →  0-5s (endpoint update)

Total: 30-90s (existing capacity) or 4-7min (needs new node)
```

### Repackaging the Helm Chart

**CRITICAL:** After modifying files in `helm/abl-platform/`, you MUST repackage the subchart:

```bash
cd abl-platform-deploy

# Strip macOS extended attributes (prevents ._file poisoning in tarball)
xattr -cr helm/abl-platform/templates/

# Repackage with macOS xattr protection
COPYFILE_DISABLE=1 helm package helm/abl-platform/ -d helm/abl-platform-stack/charts/

# Verify — must succeed with no errors
helm template test helm/abl-platform-stack/ \
  --values helm/abl-platform-stack/values.yaml \
  --values helm/abl-platform-stack/values-dev.yaml > /dev/null
```

### Verifying ArgoCD Sync

After pushing changes:

```bash
CONTEXT="aks-abl-dev-centralus"

# Check sync status
kubectl --context $CONTEXT -n argocd get application abl-platform-dev

# Check for errors
kubectl --context $CONTEXT -n argocd get application abl-platform-dev \
  -o jsonpath='{.status.conditions[*].message}'

# If sync stuck with cached error — restart repo-server (requires user confirmation)
# kubectl --context $CONTEXT -n argocd rollout restart deployment argocd-repo-server

# Verify HPA applied
kubectl --context $CONTEXT -n $NS get hpa abl-platform-dev-runtime -o yaml | head -50

# Verify PDB created
kubectl --context $CONTEXT -n $NS get pdb

# Verify configMap updated
kubectl --context $CONTEXT -n $NS get configmap abl-platform-dev-runtime -o yaml | grep MONGODB_MAX_POOL_SIZE
```

---

## 6. Phase 5: Verify & Re-test

### Goal

Run the saturation ladder again against the scaled infrastructure. Compare before/after.

### Verification Checklist

Run these kubectl checks before starting the load test:

```bash
CONTEXT="aks-abl-dev-centralus"
NS="abl-platform-dev"

echo "=== Runtime Pods ==="
kubectl --context $CONTEXT -n $NS get pods -l app.kubernetes.io/component=runtime

echo "=== HPA Config ==="
kubectl --context $CONTEXT -n $NS describe hpa abl-platform-dev-runtime

echo "=== PDB ==="
kubectl --context $CONTEXT -n $NS get pdb

echo "=== Node Capacity ==="
kubectl --context $CONTEXT get nodes -o custom-columns=NAME:.metadata.name,CPU:.status.capacity.cpu,MEM:.status.capacity.memory,LABELS:.metadata.labels.workload

echo "=== MongoDB Resources ==="
kubectl --context $CONTEXT -n $NS top pods -l app=abl-platform-dev-mongodb-svc

echo "=== Redis Architecture ==="
kubectl --context $CONTEXT -n $NS get pods -l app.kubernetes.io/name=redis

echo "=== Kafka Brokers ==="
kubectl --context $CONTEXT -n $NS get pods -l strimzi.io/cluster

echo "=== Ingress Controllers ==="
kubectl --context $CONTEXT -n $NS get pods -l app.kubernetes.io/name=ingress-nginx
```

### During the Re-test

Monitor the auto-scaling chain:

```bash
# Watch HPA scaling in real-time (run in background terminal)
kubectl --context $CONTEXT -n $NS get hpa abl-platform-dev-runtime -w

# Periodic snapshot (every 30s)
echo "$(date +%H:%M:%S) | Pods: $(kubectl --context $CONTEXT -n $NS get pods -l app.kubernetes.io/component=runtime --no-headers | wc -l | tr -d ' ') | Nodes: $(kubectl --context $CONTEXT get nodes --no-headers | wc -l | tr -d ' ')"
```

### Cross-Run Comparison Table

```markdown
## Before vs After

| Metric                   | Before (Run <A>) | After (Run <B>) | Change |
| ------------------------ | ---------------- | --------------- | ------ |
| Max VUs sustained        | <X>              | <Y>             | +<Z>%  |
| Peak throughput (msg/s)  | <X>              | <Y>             |        |
| Peak error rate          | <X>%             | <Y>%            |        |
| p95 at max VU            | <X>ms            | <Y>ms           |        |
| Peak pod count           | <X>              | <Y>             |        |
| Time to scale 2→<N> pods | <X>min           | <Y>min          |        |
| Pod evictions            | <X>              | <Y>             |        |
| Node scale events        | <X>              | <Y>             |        |
| MongoDB CPU at peak      | <X>              | <Y>             |        |
| Redis CPU at peak        | <X>              | <Y>             |        |
```

---

## 7. Capacity Projection Model

### Per-Pod Performance Reference (from baseline)

These are the validated numbers from Run 7207713:

| Pod Config                      | Safe (msg/s) | Safe (VUs) | Max (msg/s) | Max (VUs) | CPU at Safe | CPU at Max |
| ------------------------------- | :----------: | :--------: | :---------: | :-------: | :---------: | :--------: |
| 1 CPU req / 2 CPU limit, pool=5 |      15      |     30     |     20      |    50     |    0.37     |    0.50    |

### Scaling Table

Given the per-pod baseline, here's a projection for different VU targets:

| Target VUs | msg/s | Pods (safe @15) | Pods (max @20) | Nodes (D8s_v5) | MongoDB Conns (@20 pool) | Monthly Cost (on-demand) |
| :--------: | :---: | :-------------: | :------------: | :------------: | :----------------------: | :----------------------: |
|    100     |  48   |        4        |       3        |       1        |            80            |          ~$280           |
|    200     |  95   |        7        |       5        |      1-2       |           140            |          ~$560           |
|    500     |  238  |       16        |       12       |       3        |           320            |          ~$840           |
|    800     |  381  |       26        |       20       |      4-5       |           520            |         ~$1,400          |
|    1000    |  476  |       32        |       24       |      5-6       |           640            |         ~$1,680          |
|    1200    |  571  |       38        |       29       |      6-7       |           760            |         ~$1,960          |
|    1500    |  714  |       48        |       36       |      8-9       |           960            |         ~$2,520          |

**Formula:** `pods = ceil(VUs / (time_per_turn * safe_msg_s_per_pod))`  
**Assumption:** `time_per_turn ≈ 2.1s` (1s mock LLM + 0.1s overhead + 1s inter-message delay)

### When to Re-baseline

Re-run Phase 1 when:

- Runtime code changes (new middleware, executor changes, encryption changes)
- CPU request/limit changes
- MongoDB pool size changes
- Redis architecture changes
- New sidecars added to runtime pod

---

## 8. Common Issues & Fixes

### HPA Not Scaling

| Symptom                       | Root Cause                                                                 | Fix                                                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Pods at min, CPU below target | CPU target is too high relative to CPU **request**, so HPA reacts too late | Lower `targetCPU` based on request utilization. Example: with `requests.cpu=1`, use a 50-60% target if pods degrade around 0.6-0.7 cores |
| HPA scales but too slowly     | Stabilization window too long                                              | Reduce `stabilizationWindowSeconds` to 15s                                                                                               |
| Pods added 1 at a time        | Scale-up policy too conservative                                           | Use `+100%/15s` or `+8 pods/15s`                                                                                                         |
| HPA shows `<unknown>/50%`     | Metrics server lag                                                         | Wait 60s, check `kubectl top pods` works                                                                                                 |

### Pod Evictions During Load

| Symptom                 | Root Cause                           | Fix                                    |
| ----------------------- | ------------------------------------ | -------------------------------------- |
| Pod restarts mid-test   | Cluster autoscaler evicts node       | Enable PDB (`minAvailable: 1`+)        |
| Pod OOMKilled           | Memory limit too low                 | Increase limit, check for memory leaks |
| Pod evicted, PDB exists | PDB allows it (minAvailable too low) | Set `minAvailable` = `minReplicas - 1` |

### Node Scaling Issues

| Symptom                                 | Root Cause                             | Fix                                        |
| --------------------------------------- | -------------------------------------- | ------------------------------------------ |
| Pods Pending for > 5min                 | Node pool at max                       | Increase `user_node_max_count`             |
| New node added then immediately removed | `scale_down_delay_after_add` too short | Set to 15m in autoscaler profile           |
| Nodes oscillating up/down               | `scale_down_unneeded` too short        | Set to 15m, `utilization_threshold` to 0.4 |

### ArgoCD Sync Failures

| Symptom                      | Root Cause                   | Fix                                                                                                                    |
| ---------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `._file` YAML parse error    | macOS xattrs in Helm tarball | `xattr -cr templates/ && COPYFILE_DISABLE=1 helm package`                                                              |
| Sync status "Unknown"        | Manifest generation error    | Check conditions: `kubectl get app -o jsonpath='{.status.conditions}'`                                                 |
| Stale cached error after fix | Repo-server cache            | Hard refresh: `kubectl patch app --type merge -p '{"metadata":{"annotations":{"argocd.argoproj.io/refresh":"hard"}}}'` |

---

## 9. kubectl Quick Reference for Load Testing

### Runtime

```bash
# Pod count and status
kubectl --context $CTX -n $NS get pods -l app.kubernetes.io/component=runtime --no-headers | wc -l

# CPU and memory per pod
kubectl --context $CTX -n $NS top pods -l app.kubernetes.io/component=runtime --sort-by=cpu

# HPA current state
kubectl --context $CTX -n $NS get hpa abl-platform-dev-runtime

# HPA events (scaling decisions)
kubectl --context $CTX -n $NS describe hpa abl-platform-dev-runtime | grep -A 20 "Events:"

# Pod distribution across nodes
kubectl --context $CTX -n $NS get pods -l app.kubernetes.io/component=runtime -o custom-columns=POD:.metadata.name,NODE:.spec.nodeName,CPU:.status.containerStatuses[0].resources,STATUS:.status.phase

# Runtime configMap (verify pool size, log level, etc.)
kubectl --context $CTX -n $NS get configmap -l app.kubernetes.io/component=runtime -o yaml | grep -E "MONGODB_MAX_POOL_SIZE|LOG_LEVEL|LLM_QUEUE"
```

### Infrastructure Services

```bash
# MongoDB — replica set status (Community Operator uses app= label)
kubectl --context $CTX -n $NS get pods -l app=abl-platform-dev-mongodb-svc -o wide
kubectl --context $CTX -n $NS top pods -l app=abl-platform-dev-mongodb-svc

# Redis — master + replicas
kubectl --context $CTX -n $NS get pods -l app.kubernetes.io/name=redis -o wide
kubectl --context $CTX -n $NS top pods -l app.kubernetes.io/name=redis

# Kafka — broker status
kubectl --context $CTX -n $NS get pods -l strimzi.io/cluster -o wide
kubectl --context $CTX -n $NS top pods -l strimzi.io/cluster

# ClickHouse — shard/replica status
kubectl --context $CTX -n $NS get pods -l app.kubernetes.io/name=clickhouse -o wide
kubectl --context $CTX -n $NS top pods -l app.kubernetes.io/name=clickhouse

# Ingress NGINX
kubectl --context $CTX -n $NS get pods -l app.kubernetes.io/name=ingress-nginx -o wide
kubectl --context $CTX -n $NS top pods -l app.kubernetes.io/name=ingress-nginx
```

### Cluster-Level

```bash
# Node resources and allocation
kubectl --context $CTX top nodes
kubectl --context $CTX get nodes -o custom-columns=NAME:.metadata.name,CPU_CAP:.status.capacity.cpu,MEM_CAP:.status.capacity.memory,POOL:.metadata.labels.workload

# All PDBs
kubectl --context $CTX -n $NS get pdb

# Recent events (scaling, failures, evictions)
kubectl --context $CTX -n $NS get events --sort-by='.lastTimestamp' | tail -30

# Pending pods (capacity constraint indicator)
kubectl --context $CTX -n $NS get pods --field-selector=status.phase=Pending
```

### One-Liner Status Snapshot

```bash
CTX="aks-abl-dev-centralus" NS="abl-platform-dev" && echo "Runtime: $(kubectl --context $CTX -n $NS get pods -l app.kubernetes.io/component=runtime --no-headers 2>/dev/null | wc -l | tr -d ' ') pods | Nodes: $(kubectl --context $CTX get nodes --no-headers 2>/dev/null | wc -l | tr -d ' ') | HPA: $(kubectl --context $CTX -n $NS get hpa abl-platform-dev-runtime -o jsonpath='{.status.currentReplicas}/{.spec.maxReplicas}' 2>/dev/null)"
```

---

## 10. Operational Step-Wise Execution Protocol

This is the main execution path for a live run. Read Sections 10.1 through 10.11 in order, then use Sections 12-16 only as analytical support when a signal turns ambiguous, degraded, or red.

**Architecture:** Raw cluster polling is done by a **script** (`benchmarks/scripts/cluster-poll.sh`), not by the agent issuing ad-hoc kubectl commands every 20s. The script writes every poll as JSON. The agent must supervise the run in real time by repeatedly reading the latest poll JSON plus live k6 run status/metrics while k6 runs in the background. Deep batch analysis still happens at hold-window boundaries.

```
┌────────────┐   ┌─────────────────┐   ┌────────────────────┐   ┌───────────────────┐
│ k6 Cloud   │   │ cluster-poll.sh │   │ JSON files         │   │ Agent Supervisor  │
│ (load gen) │   │ (every 20s)     │   │ (per-poll + summary│   │ (every 30-60s +   │
│            │   │                 │──▶│  in results/polls/) │──▶│  step boundaries) │
└────────────┘   └─────────────────┘   └────────────────────┘   └───────────────────┘
   runs in          runs in                 persisted               reads latest poll,
   background       background              to disk                 fetches k6 status,
                                                                    analyses live,
                                                                    warns/stops/continues
```

### 10.1 The Polling Script — `benchmarks/scripts/cluster-poll.sh`

**Tested and verified against live dev cluster.** Collects per-poll:

| Component         | Data Collected                                                                                                                                                                                                                                            | Pod Label                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **Runtime**       | per-pod CPU/memory (`kubectl top`), pod phase, restart count, resource requests/limits, HPA state (current/desired replicas, trigger CPU/memory %, behavior config, conditions), `/health` endpoint (heap, RSS, cached sessions, uptime, DB/Redis status) | `app.kubernetes.io/component=runtime`    |
| **MongoDB**       | per-pod CPU/memory, phase, restarts, resource limits                                                                                                                                                                                                      | `app=abl-platform-dev-mongodb-svc`       |
| **Redis**         | per-pod CPU/memory (master + replicas), phase, restarts, resource limits                                                                                                                                                                                  | `app.kubernetes.io/name=redis`           |
| **Kafka**         | per-pod CPU/memory (brokers + entity operator), phase, restarts, resource limits                                                                                                                                                                          | `strimzi.io/cluster`                     |
| **ClickHouse**    | per-pod CPU/memory, phase, restarts, resource limits                                                                                                                                                                                                      | `app.kubernetes.io/name=clickhouse`      |
| **OpenSearch**    | per-pod CPU/memory, phase, restarts, resource limits                                                                                                                                                                                                      | `app.kubernetes.io/component=opensearch` |
| **Neo4j**         | per-pod CPU/memory, phase, restarts, resource limits                                                                                                                                                                                                      | `app.kubernetes.io/component=neo4j`      |
| **Ingress-NGINX** | per-pod CPU/memory, phase, restarts, resource limits                                                                                                                                                                                                      | `app.kubernetes.io/name=ingress-nginx`   |
| **Nodes**         | per-node CPU/memory utilization (%), capacity, allocatable, pool label                                                                                                                                                                                    | N/A                                      |
| **Cluster**       | pending pods (with scheduling reason), PDB status (healthy/desired/allowed disruptions), recent events (OOM, evictions, scaling, node add/remove)                                                                                                         | N/A                                      |
| **k6**            | run status, current VUs, current throughput (`chat_turn_success_total` rate), current error rate, current p95 latency, plus the recent query window used to compute them                                                                                  | N/A                                      |

**Usage:**

```bash
# Start polling in background — writes pidfile for non-interactive stop
STEPS=200,500,800,1000,1200,1500 STEP_DURATION_MINUTES=5 RAMP_SECONDS=120 \
  RUN_ID=<k6-run-id> ./benchmarks/scripts/cluster-poll.sh &

# Or with options:
POLL_INTERVAL=20 RUN_ID=7300001 MAX_POLLS=200 \
  STEPS=200,500,800,1000,1200,1500 STEP_DURATION_MINUTES=5 RAMP_SECONDS=120 \
  ./benchmarks/scripts/cluster-poll.sh &

# Stop a running poller (non-interactive — uses pidfile):
./benchmarks/scripts/cluster-poll.sh --stop <RUN_ID>
```

**Output structure:**

```
benchmarks/results/polls/<RUN_ID>/
  poll-0001.json    # First poll snapshot
  poll-0002.json    # Second poll snapshot
  ...
  poll-NNNN.json    # Last poll snapshot
  summary.json      # Array of ALL polls — agent reads this for batch analysis
```

**Environment variables:**

| Var                   | Default                             | Description                                                           |
| --------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| `CONTEXT`             | `aks-abl-dev-centralus`             | kubectl context                                                       |
| `NS`                  | `abl-platform-dev`                  | Kubernetes namespace                                                  |
| `POLL_INTERVAL`       | `20`                                | Seconds between polls                                                 |
| `RUN_ID`              | epoch timestamp                     | Output directory name and default k6 run ID                           |
| `K6_RUN_ID`           | `$RUN_ID`                           | k6 Cloud test run ID (override if output dir != k6 run ID)            |
| `OUTPUT_DIR`          | `benchmarks/results/polls/<RUN_ID>` | Override output path                                                  |
| `MAX_POLLS`           | `0` (unlimited)                     | Stop after N polls                                                    |
| `HEALTH_PORT`         | `13112`                             | Local port for runtime /health port-forward                           |
| `K6_API_BASE`         | `https://api.k6.io/cloud/v5`        | k6 Cloud API base URL                                                 |
| `K6_METRIC_STEP`      | `20`                                | Step size in seconds for live k6 queries                              |
| `K6_LOOKBACK_SECONDS` | `180`                               | Recent lookback window for point-in-time k6 metrics                   |
| `K6_API_TIMEOUT`      | `4`                                 | Per-call timeout for k6 API requests (seconds)                        |
| `K6_STEPS`            | `$STEPS` or empty                   | Comma-separated VU steps (e.g. `200,500,800`) for step-aware metadata |
| `K6_STEP_DURATION`    | `$STEP_DURATION_MINUTES` or `5`     | Step duration in minutes (matches k6 config)                          |
| `K6_RAMP`             | `$RAMP_SECONDS` or `120`            | Ramp duration in seconds (matches k6 config)                          |

`K6_CLOUD_TOKEN` is loaded from `benchmarks/config/cloud.env` if it is not already present in the environment.

### 10.2 JSON Schema (Per-Poll)

Each `poll-NNNN.json` has this structure:

```jsonc
{
  "pollNumber": 1,
  "timestamp": "2026-04-10T15:30:53Z",
  "epoch": 1775835053,
  "runId": "7300001",                          // Output directory name
  "k6RunId": "7300001",                        // k6 Cloud test run ID (may differ from runId)
  "runtime": {
    "top": [                                    // kubectl top pods — actual CPU/memory usage
      {"pod": "...-runtime-xxx", "cpu": "450m", "memory": "1200Mi"}
    ],
    "pods": [                                   // kubectl get pods — phase, restarts, resource spec
      {"pod": "...-runtime-xxx", "phase": "Running", "restarts": 0,
       "resources": {"requests": {"cpu": "1", "memory": "2Gi"}, "limits": {"cpu": "2", "memory": "4Gi"}}}
    ],
    "hpa": {
      "minReplicas": 2, "maxReplicas": 50,
      "currentReplicas": 7, "desiredReplicas": 7,
      "currentMetrics": [                       // What HPA sees — the trigger values
        {"name": "cpu", "currentUtilization": 45, "currentValue": "450m"},
        {"name": "memory", "currentUtilization": 30, "currentValue": "664049664"}
      ],
      "targets": [
        {"name": "cpu", "targetUtilization": 50},
        {"name": "memory", "targetUtilization": 60}
      ],
      "behavior": {"scaleUp": {...}, "scaleDown": {...}},
      "conditions": [{"type": "AbleToScale", "status": "True", "reason": "...", "message": "..."}]
    },
    "health": {                                 // Runtime /health endpoint — Node.js process metrics
      "status": "healthy", "uptime": 3600,
      "database": "connected (mongo)", "redis": "connected", "clickhouse": "connected",
      "localCachedSessions": 42,                // Active sessions on this pod
      "memoryUsageMB": 645,                     // process.memoryUsage().rss
      "heapUsedMB": 447,                        // process.memoryUsage().heapUsed
      "heapTotalMB": 488                        // process.memoryUsage().heapTotal
    }
  },
  "mongodb": {                                  // Same structure for all infra components:
    "top": [...],                               //   top: kubectl top pods (actual usage)
    "pods": [...]                               //   pods: phase, restarts, resource spec
  },
  "redis": {"top": [...], "pods": [...]},
  "kafka": {"top": [...], "pods": [...]},
  "clickhouse": {"top": [...], "pods": [...]},
  "opensearch": {"top": [...], "pods": [...]},
  "neo4j": {"top": [...], "pods": [...]},
  "ingress": {"top": [...], "pods": [...]},
  "cluster": {
    "nodesTop": [                               // Per-node CPU/memory utilization
      {"node": "aks-user-xxx", "cpu": "2100m", "cpuPercent": "26%", "memory": "18Gi", "memPercent": "67%"}
    ],
    "nodeInfo": [                               // Node capacity and pool assignment
      {"node": "aks-user-xxx", "pool": "application", "cpuCapacity": "8", "memCapacity": "32Gi",
       "cpuAllocatable": "7820m", "memAllocatable": "27Gi"}
    ],
    "pendingPods": [                            // Any unschedulable pods
      {"pod": "...-runtime-yyy", "reason": "Unschedulable", "message": "insufficient cpu"}
    ],
    "pdb": [                                    // PodDisruptionBudget status
      {"name": "...-runtime", "minAvailable": 1, "currentHealthy": 7, "disruptionsAllowed": 6}
    ],
    "events": [                                 // Scaling, OOM, eviction events
      {"reason": "SuccessfulRescale", "message": "New size: 7", "object": "...-runtime", "lastTimestamp": "..."}
    ]
  },
  "k6": {
    "dataAvailable": true,                      // false when k6 API unreachable OR run not yet started
    // "notStarted": true,                     // present (true) when run exists but hasn't begun — normal, not an error
    // "error": "k6 api unavailable: ...",     // present only on real telemetry failures — distinct from notStarted
    "run": {
      "resultStatus": null,
      "runStatus": 1,
      "started": "2026-04-10T15:30:00Z",
      "ended": null
    },
    "step": {                                   // Computed from K6_STEPS + elapsed time
      "stepIndex": 1,                           // 0-indexed — which VU step we're in
      "stepVUs": 500,                           // Declared VUs for this step
      "phase": "hold",                          // "ramp" | "hold" | "finished" | "unknown"
      "elapsedSeconds": 420,                    // Seconds since run started
      "holdStartOffset": 420,                   // Seconds from run start to hold start for this step
      "holdEndOffset": 600                      // Seconds from run start to hold end for this step
    },
    "window": {
      "start": "2026-04-10T15:33:00Z",
      "end": "2026-04-10T15:36:00Z",
      "stepSeconds": 20
    },
    "current": {
      "vus": {"timestamp": 1775835360.0, "value": 500},
      "throughputMsgPerSec": {"timestamp": 1775835360.0, "value": 236.4},
      "errorRate": {"timestamp": 1775835360.0, "value": 0.0031},
      "p95LatencyMs": {"timestamp": 1775835360.0, "value": 1842.7}
    }
  }
}
```

### 10.3 Pre-Flight Checks

Before launching, run one poll to verify the cluster is healthy:

```bash
MAX_POLLS=1 RUN_ID=preflight ./benchmarks/scripts/cluster-poll.sh
```

Then read the JSON and verify:

```bash
# Agent reads: benchmarks/results/polls/preflight/poll-0001.json
```

**Gate — do NOT start load testing if:**

- Any runtime pod phase != Running
- HPA `currentMetrics` shows no data (metrics-server not ready)
- `cluster.pendingPods` is non-empty (capacity issue)
- `cluster.pdb` has no runtime entry (pods can be evicted)
- Runtime `/health` shows database/redis != "connected"

### 10.4 Expected vs Actual Projection Table

Before starting, compute the expected metrics. The agent compares these against the JSON at each step boundary.

**Formulas:**

```
per_pod_safe_msg_s = 15          # From baseline Run 7207713 — RE-BASELINE if runtime code changed
time_per_turn      = 2.1         # 1s mock LLM + 0.1s overhead + 1s inter-message delay
cpu_request        = <READ FROM LIVE ENV>   # runtime.pods[0].resources.requests.cpu from preflight poll
allocatable_per_node = <READ FROM LIVE ENV> # cluster.nodeInfo[0].cpuAllocatable from preflight poll
pool_size          = <READ FROM LIVE ENV>   # MONGODB_MAX_POOL_SIZE from runtime configMap

For each VU step:
  expected_msg_s       = VUs / time_per_turn
  expected_pods        = ceil(expected_msg_s / per_pod_safe_msg_s)
  expected_cpu_per_pod = (expected_msg_s / expected_pods) / per_pod_safe_msg_s * 0.37 cores
  expected_nodes       = ceil(expected_pods * cpu_request / allocatable_per_node)
  expected_mongo_conns = expected_pods * pool_size
```

**CRITICAL: Read dynamic values from the preflight poll JSON before computing.** Do not use the hardcoded defaults below if the preflight poll has different values. The preflight JSON contains `runtime.pods[0].resources.requests.cpu` (cpu_request), `cluster.nodeInfo[0].cpuAllocatable` (allocatable_per_node). Read `MONGODB_MAX_POOL_SIZE` via: `kubectl --context $CTX -n $NS get configmap -l app.kubernetes.io/component=runtime -o jsonpath='{.items[0].data.MONGODB_MAX_POOL_SIZE}'`.

**Pre-computed reference for 1500 VU ladder (with defaults: cpu_request=1, allocatable=7.82, pool=20):**

| Step | VUs  | Expected msg/s | Expected Pods | Expected CPU/pod | Expected Nodes | Mongo Conns |
| :--: | :--: | :------------: | :-----------: | :--------------: | :------------: | :---------: |
|  1   | 200  |       95       |       7       |      ~335m       |       1        |     140     |
|  2   | 500  |      238       |      16       |      ~367m       |       3        |     320     |
|  3   | 800  |      381       |      26       |      ~362m       |       4        |     520     |
|  4   | 1000 |      476       |      32       |      ~368m       |       5        |     640     |
|  5   | 1200 |      571       |      38       |      ~371m       |       6        |     760     |
|  6   | 1500 |      714       |      48       |      ~368m       |       7        |     960     |

### 10.5 Launch k6 + Poller

**Step 1: Launch k6 in background**

```bash
STEPS=200,500,800,1000,1200,1500 STEP_DURATION_MINUTES=5 RAMP_SECONDS=120 \
  ./benchmarks/scripts/cloud-run.sh benchmarks/multi-tenant-saturation.ts
```

**CRITICAL:** Single invocation only. Each call = new k6 Cloud run.

**CRITICAL — k6 Run ID Capture:** `cloud-run.sh` compiles TypeScript and uploads to k6 Cloud before producing output. The first ~60s of stdout may be **completely empty** due to shell buffering. Do NOT repeatedly check for output or assume the run failed.

**Run ID extraction protocol:**

1. Launch `cloud-run.sh` with `run_in_background: true`.
2. Wait at least 90 seconds before reading output.
3. If the output file is still empty after 90s, **ask the user for the run ID** — they can see it in the k6 Cloud dashboard.
4. If the user provides the run ID (e.g., from the k6 Cloud URL like `https://abl.grafana.net/a/k6-app/runs/7257230`), use that directly.
5. **Never guess or fabricate a run ID.** If you can't get it, ask the user.

**k6 Cloud run status codes — do NOT confuse these:**

| `result_status` | Meaning                        |
| --------------- | ------------------------------ |
| `0`             | **In progress** (NOT "passed") |
| `1`             | Passed                         |
| `2`             | Failed (thresholds exceeded)   |
| `3`             | Timed out                      |

| `run_status` | Meaning          |
| ------------ | ---------------- |
| `-2`         | Created          |
| `-1`         | Validated        |
| `0`          | Queued           |
| `1`          | Initializing     |
| `2`          | Running          |
| `3`          | Finished         |
| `4`          | Timed out        |
| `5`          | Aborted (user)   |
| `6`          | Aborted (system) |
| `7`          | Aborted (limit)  |

**The run is finished when `run_status >= 3`, NOT when `result_status` has a value.** `result_status=0` means running, not passed.

**k6 Cloud runs 2 instances** — the VUs shown in the dashboard or API are **per instance**. 750 VUs shown = 1500 actual VUs. Always multiply by 2.

**Step 2: Launch poller in background**

```bash
# CRITICAL: Pass the same step env vars used for k6 so the poller computes k6.step.*
STEPS=200,500,800,1000,1200,1500 STEP_DURATION_MINUTES=5 RAMP_SECONDS=120 \
  RUN_ID=<k6-run-id> ./benchmarks/scripts/cluster-poll.sh &
```

Both run concurrently. The poller writes JSON every 20s (including step-aware `k6.step.*` metadata). The agent must supervise the live run by reading the latest poll JSON and fetching live k6 status/metrics while k6 is active.

### 10.5A Real-Time Monitoring While The Run Is Active

As soon as k6 and the poller are running, the agent must enter a supervision loop until the run finishes or is stopped.

**Cadence:**

- Every 20s: `cluster-poll.sh` writes a new JSON snapshot
- Every 30-60s: the agent reads the latest `poll-*.json`
- Every 30-60s: the agent reads `k6.run.*` and `k6.current.*` from the latest poll JSON (no separate API call needed)
- As needed: the agent fetches k6 API directly for wider hold-window slices: `/cloud/v5/test_runs/<K6_RUN_ID>`
- At each hold-window end: the agent performs the deeper step decision analysis

**Live supervision loop:**

1. Read the latest poll JSON and compare it to the previous one.
2. **Check `k6.dataAvailable`** — determines evidence mode (see 10.5B below).
3. If k6 data is available: read `k6.step.*` for current phase/step, `k6.current.*` for live metrics.
4. **Check `k6.step.phase`** — only use k6 metrics for PROCEED/STOP decisions during `"hold"` phase. During `"ramp"`, metrics are transitional and must not trigger stops.
5. Fetch k6 directly only when you need a longer hold-window slice or to verify an ambiguous live signal.
6. **HPA behavior diagnosis + Coroot live checks**:
   - Compare `runtime.hpa.desiredReplicas` vs `currentReplicas` — if desired > current, scaling is in-flight. Diagnose WHY it's slow (node provisioning? image pull? readiness probe?).
   - Compare `currentReplicas` vs the expected pod count from Section 10.4 — if actual < expected, HPA is behind. Diagnose WHY (CPU below target? stabilization window? max replicas hit?).
   - Check `runtime.hpa.conditions` — look for `ScalingLimited`, `FailedGetResourceMetric`, or `AbleToScale=False`.
   - Check if `currentReplicas == maxReplicas` AND CPU utilization > target — this is an HPA ceiling, not a scaling lag.
   - Cross-reference with `cluster.pendingPods` — if pods are pending, it's a node capacity problem, not an HPA problem.
   - Run the prioritized Coroot live calls from Section 13.2 when the signal is ambiguous or trending worse than kubectl suggests.
   - Report the HPA state and diagnosis in every supervision note, not just the numbers.
7. Detect other live signals:
   - pending pods, node growth, infra CPU pressure
   - current VUs, rising error rate, p95 jump, throughput flattening
   - event loop lag, runtime CPU delay, MongoDB CPU delay, and MongoDB write latency using the thresholds in Section 12
8. Take action immediately when needed:
   - `CONTINUE` when scaling is healthy
   - `WARN` when the system is degraded but recovering
   - `SOFT STOP` at the end of the current hold window when efficiency is poor and headroom is being consumed
   - `HARD STOP` immediately for OOM, sustained pending pods, maxed HPA without recovery, or sustained stateful-service pressure
9. Record the reason for each action in the run notes / final report.
10. Display or refresh the Primary Scorecard from Section 14.1 on every supervision cycle and the Step Summary Scorecard from Section 14.2 at each hold-window boundary.

### 10.5B Degraded-Mode Contract (k6 Telemetry Unavailable)

Each poll JSON includes `k6.dataAvailable` (boolean) and optionally `k6.error` (string) or `k6.notStarted` (boolean). The agent **must** check this before using any k6 field.

**Three k6 states in the poll JSON:**

| State                 | Condition                   | Meaning                                                                                                 |
| --------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Data available**    | `k6.dataAvailable == true`  | k6 metrics are present and usable                                                                       |
| **Not started**       | `k6.notStarted == true`     | k6 run exists but hasn't begun yet — poller started before k6. This is **normal** and **not an error**. |
| **Telemetry failure** | `k6.error` present (string) | k6 Cloud API unreachable or returned an error. This is a **real degradation**.                          |

**Two evidence modes:**

| Mode                      | Condition                                                    | What You Can Do                                                                                                                       | What You Cannot Do                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Full evidence**         | `k6.dataAvailable == true`                                   | Use all k6 fields. Make PROCEED/STOP decisions using k6 throughput, error rate, p95, VU count. Compute efficiency. Use step metadata. | —                                                                                                                                                                                      |
| **Cluster-only evidence** | `k6.dataAvailable == false` (either `notStarted` or `error`) | Monitor cluster health: HPA, pod CPU/memory, infra CPU, pending pods, OOM events, node capacity, restarts.                            | **Do NOT** make step-boundary decisions (efficiency, throughput targets). **Do NOT** compute expected vs actual tables. **Do NOT** PROCEED to next step — wait for k6 data to recover. |

**When k6 has not started yet (`k6.notStarted == true`):**

The poller starts before k6 sometimes. This is expected for the first few polls. Do **not** log this as an error or degradation — just note "k6 not started yet" and operate in cluster-only mode until `k6.dataAvailable` flips to `true`. If `notStarted` persists for > 20 polls (~7 minutes), something may be wrong with the k6 launch — check the k6 cloud-run.sh output.

**When k6 telemetry fails mid-run (`k6.error` present):**

This is a real degradation — k6 was working and stopped.

1. Log: "k6 telemetry lost at poll #N — switching to cluster-only mode. Error: {k6.error}"
2. Continue cluster monitoring. Watch for HPA saturation, pending pods, OOM — these are still valid.
3. If k6 recovers within 6 polls (~2 minutes), resume full evidence mode.
4. If k6 stays unavailable for > 12 polls (~4 minutes), escalate to user: "k6 Cloud API unreachable for 4+ minutes. Cluster data looks [healthy/degraded]. Recommend [continuing blind / stopping]."
5. **Never make a PROCEED decision without k6 throughput data.** A STOP is safer than a blind PROCEED.

**When k6 step metadata is missing (`k6.step.stepIndex == null`):**

This happens when `K6_STEPS` was not passed to the poller. Fall back to VU-matching (10.6C Method 2) using `k6.current.vus.value` against the declared step list from the skill's expected table.

### 10.5C HPA Behavior Diagnosis

The supervision loop must not just report HPA numbers — it must explain **WHY** pods are or aren't scaling. Use this diagnostic tree on every supervision read.

**Input fields (all from poll JSON):**

```
hpa = runtime.hpa
current   = hpa.currentReplicas
desired   = hpa.desiredReplicas
max       = hpa.maxReplicas
min       = hpa.minReplicas
cpuUtil   = hpa.currentMetrics[name=cpu].currentUtilization      # what HPA sees (% of request)
cpuTarget = hpa.targets[name=cpu].targetUtilization               # configured target %
memUtil   = hpa.currentMetrics[name=memory].currentUtilization
memTarget = hpa.targets[name=memory].targetUtilization
conditions = hpa.conditions                                       # array of {type, status, reason, message}
behavior  = hpa.behavior.scaleUp                                  # {stabilizationWindowSeconds, policies}
expected  = expected_pods from Section 10.4 for the current VU step
pending   = cluster.pendingPods                                   # pods waiting for node capacity
```

**Diagnostic tree — walk top-to-bottom, first match wins:**

|  #  | Condition                                                                | Diagnosis                                                                        | Root Cause                                                                                                                                                        | What To Do                                                                                                                                                                                                                                                                                    |
| :-: | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|  1  | `current == max` AND `cpuUtil > cpuTarget`                               | **HPA ceiling** — at max replicas and still overloaded                           | `maxReplicas` is too low for this VU step                                                                                                                         | Increase `maxReplicas` in Helm. This is NOT a scaling lag — HPA did its job but ran out of headroom. Report: "HPA at ceiling: {current}/{max} replicas, CPU at {cpuUtil}% vs {cpuTarget}% target. maxReplicas must increase."                                                                 |
|  2  | `current == max` AND `cpuUtil < cpuTarget`                               | **At max but healthy** — pods are sufficient even at ceiling                     | Workload doesn't need more pods at this VU level                                                                                                                  | Normal — continue. Report: "HPA at max ({current}/{max}) but CPU healthy at {cpuUtil}%."                                                                                                                                                                                                      |
|  3  | `desired > current` AND `pending` is non-empty                           | **Node-bound scaling lag** — HPA wants more pods but nodes are full              | Cluster autoscaler is provisioning a new VM (3-5 min on AKS) or node pool is at `max_count`                                                                       | Check `cluster.nodesTop` count vs Terraform `user_node_max_count`. If at max: tell user to increase Terraform. If not: wait — AKS node provisioning takes 3-5 min. Report: "HPA wants {desired} pods but {len(pending)} pending — waiting for node. Nodes: {nodeCount}/{nodeMax}."            |
|  4  | `desired > current` AND `pending` is empty                               | **Pod startup lag** — new pods are being created, not yet Ready                  | Container pulling image, running init containers, or waiting for readiness probe. Scaling chain: pod created → image pull (10-30s) → healthcheck (10-30s) → Ready | Normal during ramp. If persists > 90s after desired changed: check events for `ImagePullBackOff`, `CrashLoopBackOff`, or failed readiness probes. Report: "HPA scaling {current}→{desired}, no pending pods — pods starting up. Expected ready in 30-90s."                                    |
|  5  | `current < expected` AND `cpuUtil < cpuTarget`                           | **HPA hasn't triggered** — load hasn't reached the scaling threshold             | Per-pod CPU is below the target. Either VUs are still ramping, or per-pod capacity is higher than estimated in Section 10.4                                       | During ramp phase: normal — wait for hold. During hold phase: your baseline per-pod-msg/s estimate may be too conservative (pods handle more than expected). Report: "HPA not scaling yet — CPU at {cpuUtil}% (target: {cpuTarget}%). Per-pod capacity may be higher than baseline estimate." |
|  6  | `current < expected` AND `cpuUtil >= cpuTarget` AND `desired == current` | **Stabilization window blocking** — HPA sees overload but won't scale yet        | `behavior.scaleUp.stabilizationWindowSeconds` prevents rapid scaling. HPA waits for sustained high CPU before adding pods.                                        | Check `behavior.scaleUp.stabilizationWindowSeconds` — if > 30s and you're in a load test, recommend reducing to 15s. Report: "CPU at {cpuUtil}% but HPA holding at {current} pods — stabilization window ({behavior.stabilizationWindowSeconds}s) may be blocking."                           |
|  7  | `current < expected` AND `cpuUtil >= cpuTarget` AND `desired > current`  | **Scaling in progress but slow** — HPA triggered but not adding pods fast enough | Scale-up policy is too conservative (e.g., +1 pod/60s). At 200→500 VU ramp needing 7→18 pods, +1/60s takes 11 minutes.                                            | Check `behavior.scaleUp.policies` — if `type: Pods, value: 1`: recommend `+100%/15s` or `+8 pods/15s`. Report: "HPA scaling slowly — wants {desired} but at {current}. Policy: {scaleUp.policies}. Consider more aggressive scale-up."                                                        |
|  8  | Any `conditions[*].reason == "FailedGetResourceMetric"`                  | **Metrics unavailable** — HPA can't read CPU/memory metrics                      | Metrics server is down, lagging, or pod was just created (no metrics yet)                                                                                         | If `currentMetrics[*].currentUtilization` is null or `<unknown>`: wait 60s. If persists: check `kubectl top pods` works. Report: "HPA can't read metrics — condition: {condition.message}. Check metrics-server."                                                                             |
|  9  | Any `conditions[*].reason == "ScalingLimited"`                           | **Scaling blocked by policy** — HPA wants to scale but a constraint prevents it  | Could be maxReplicas, stabilization window, or rate-limiting policy                                                                                               | Read the condition message — it tells you exactly which constraint. Report the message verbatim.                                                                                                                                                                                              |
| 10  | `current >= expected` AND `cpuUtil < cpuTarget`                          | **Healthy — at or above expected**                                               | Scaling worked correctly                                                                                                                                          | Normal — continue. Report: "HPA healthy: {current} pods (expected: {expected}), CPU at {cpuUtil}%."                                                                                                                                                                                           |

**Scaling lag measurement:**

When `desired > current`, track how long the gap persists across consecutive polls:

```
scaling_lag_polls = number of consecutive polls where desired > current
scaling_lag_seconds = scaling_lag_polls * POLL_INTERVAL (20s)
```

| Lag Duration | Severity | Meaning                                                                                               |
| :----------: | :------: | ----------------------------------------------------------------------------------------------------- |
|    < 60s     |  Normal  | Pod startup time — image pull + readiness probe                                                       |
|   60-180s    |   WARN   | Slow image pull or init container. Check for new node provisioning                                    |
|   180-300s   |   HIGH   | Likely waiting for cluster autoscaler to provision a VM (3-5 min on AKS)                              |
|    > 300s    | CRITICAL | Node pool at max, or autoscaler is stuck. Check `cluster.pendingPods` and node count vs Terraform max |

**HPA diagnosis in the decision template:**

Every step's decision template must include:

```markdown
**HPA Diagnosis:** <diagnosis from tree above>

- Current/Desired/Max: {current}/{desired}/{max}
- CPU: {cpuUtil}% (target: {cpuTarget}%)
- Expected pods (10.4): {expected}
- Scaling lag: {lag_seconds}s across {lag_polls} polls (or "none")
- Conditions: {any non-normal conditions, or "all healthy"}
- Scale-up policy: {behavior.scaleUp.policies summary}
```

**When to recommend HPA config changes:**

| Signal                                              | Recommendation                                                                                             |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Ceiling hit at any step below the final target      | Increase `maxReplicas` to at least `expected_pods_at_final_step * 1.2`                                     |
| Scaling lag > 180s at every step                    | Tune `behavior.scaleUp`: shorter `stabilizationWindowSeconds` (15s), larger step policy (`+100%/15s`)      |
| CPU consistently 20%+ below target during hold      | Target is too high — pods degrade before HPA reacts. Lower `targetCPU` by 10-15%                           |
| CPU bounces above/below target rapidly              | Stabilization window too short — pods scale up then down then up. Increase to 30-60s                       |
| Pods scale correctly but throughput doesn't improve | HPA is working but the bottleneck is elsewhere. Check 10.8A bottleneck checklist — it's not an HPA problem |

### 10.6 Agent Analysis At Step Boundaries

**When each VU step ends**, the agent reads the collected JSON.

`STEP_DURATION_MINUTES` already includes the ramp. Do **not** add `RAMP_SECONDS` again.

For step `i` (1-indexed):

```text
step_start = (i - 1) * STEP_DURATION_MINUTES * 60
hold_start = step_start + RAMP_SECONDS
hold_end   = step_start + STEP_DURATION_MINUTES * 60
```

Use only the polls and k6 samples in `hold_start..hold_end`. Do not mix ramp samples into the decision gate.

```bash
# Read the summary file (all polls as one JSON array)
# File: benchmarks/results/polls/<RUN_ID>/summary.json
```

**What to extract from the JSON at step boundary:**

1. **Runtime pod count** — `runtime.hpa.currentReplicas` from the last few polls of the step
2. **HPA desired replicas** — `runtime.hpa.desiredReplicas` (compare with currentReplicas to detect scaling lag)
3. **HPA trigger CPU %** — `runtime.hpa.currentMetrics[name=cpu].currentUtilization`
4. **HPA trigger memory %** — `runtime.hpa.currentMetrics[name=memory].currentUtilization`
5. **HPA conditions** — `runtime.hpa.conditions` (look for ScalingLimited, FailedGetResourceMetric)
6. **HPA scale-up config** — `runtime.hpa.behavior.scaleUp` (stabilizationWindowSeconds, policies)
7. **Current VUs** — `k6.current.vus.value`
8. **Current throughput** — `k6.current.throughputMsgPerSec.value`
9. **Current error rate** — `k6.current.errorRate.value`
10. **Current p95 latency** — `k6.current.p95LatencyMs.value`
11. **Per-pod CPU (avg + variance)** — average of `runtime.top[*].cpu` and check max vs min (see 10.6A)
12. **Per-pod memory** — average of `runtime.top[*].memory`
13. **Heap / RSS** — `runtime.health.heapUsedMB`, `runtime.health.memoryUsageMB` (single-pod sample; see 10.6B for fleet-wide)
14. **Cached sessions** — `runtime.health.localCachedSessions`
15. **Fleet restart delta** — `sum(runtime.pods[*].restarts)` at step start vs step end (see 10.6B)
16. **MongoDB CPU** — `mongodb.top[*].cpu` (check if approaching `mongodb.pods[*].resources.limits.cpu`)
17. **Redis CPU** — `redis.top[*].cpu` (check if approaching limits)
18. **Kafka CPU** — `kafka.top[*].cpu` (check if approaching limits; also check broker count stability)
19. **ClickHouse CPU** — `clickhouse.top[*].cpu` (check if approaching limits)
20. **Ingress CPU** — `ingress.top[*].cpu` (check if approaching limits; first bottleneck at high VU counts)
21. **Node count** — length of `cluster.nodesTop`
22. **Pending pods** — `cluster.pendingPods` (should be empty)
23. **Scaling events** — `cluster.events` with reason=SuccessfulRescale/ScalingReplicaSet
24. **OOM / eviction events** — `cluster.events` with reason=OOMKilling/Evicted
25. **Current VU step** — determine via elapsed time or VU matching (see 10.6C)
26. **HPA diagnosis** — Run the 10.5C diagnostic tree and record the match

Also query k6 API at this point for wider hold-window verification:

```bash
# Get run bounds: GET /cloud/v5/test_runs/<K6_RUN_ID>
# Pull run-bounded range series (step in seconds, timestamps UNQUOTED):
#
# curl -s -H "Authorization: Token $K6_CLOUD_TOKEN" \
#   "https://api.k6.io/cloud/v5/test_runs/<K6_RUN_ID>/query_range_k6(metric='chat_turn_success_total',query='rate',step=30,start=2026-04-10T15:30:00Z,end=2026-04-10T15:35:00Z)"
#
# Metrics to query:
#   chat_turn_success_total (counter) → query='rate' → msgs/s
#   http_req_failed         (rate)    → query='rate' → 0.0-1.0 error fraction
#   chat_turn_latency_ms    (trend)   → query='p95'  → p95 in ms
#   vus                     (gauge)   → query='max'  → current VU count
#
# Then slice only the timestamps in the current hold window (hold_start..hold_end).
# Cross-check against the poll JSON's k6 section for the same window.
```

### 10.6A Per-Pod Variance Detection

The average CPU across runtime pods hides hot-pod problems. **Always compute max and min alongside the average.**

```
cpu_values = [parse_cpu(p["cpu"]) for p in runtime.top]  # e.g., "450m" → 450
cpu_avg = mean(cpu_values)
cpu_max = max(cpu_values)
cpu_min = min(cpu_values)
variance_ratio = cpu_max / cpu_min  if cpu_min > 0  else ∞
```

| Variance Ratio | Meaning           | Action                                                                                                                                                                             |
| :------------: | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|     < 1.5      | Even distribution | Normal — continue                                                                                                                                                                  |
|   1.5 – 2.0    | Mild skew         | WARN — note in report, check session stickiness                                                                                                                                    |
|     > 2.0      | Hot-pod problem   | STOP candidate — sessions are unevenly distributed. One pod is saturated while others idle. Check ingress session affinity, sticky sessions config, or uneven connection draining. |

Also check if any single pod's CPU exceeds 80% of the pod's CPU limit while others are below 40%. This signals a load balancing issue, not a capacity issue — adding more pods won't help.

### 10.6B Fleet-Wide Memory & Stability Signals

**The `/health` endpoint scrapes a single pod.** With 30+ runtime pods, this is a sample of 1. Use these fleet-wide signals instead:

1. **Restart count delta** — compare `sum(runtime.pods[*].restarts)` between the first and last polls of a hold window. Any increase means pods crashed (OOM or unhandled exception). This is the most reliable fleet-wide memory leak indicator.

2. **Pod phase stability** — all pods in `runtime.pods[*].phase` should be "Running" throughout. Any "CrashLoopBackOff" or "Error" indicates instability.

3. **Per-pod memory from kubectl top** — `runtime.top[*].memory` gives RSS for every pod. Check:
   - If max memory across pods is > 80% of the memory limit → fleet-wide pressure
   - If memory variance across pods is high → some pods have leaked / accumulated more sessions

4. **Health endpoint as canary** — the single-pod health data is still useful for trending heap fragmentation (`heapUsedMB / heapTotalMB` ratio) and session accumulation within a step.

### 10.6C Step-Transition Detection

The agent needs to know which VU step each poll belongs to. Two methods:

**Method 1: Elapsed time (preferred for batch analysis)**

```
run_started = parse_iso(k6.run.started)        # from first poll's k6 section
elapsed_s   = poll.epoch - run_started_epoch
step_index  = floor(elapsed_s / (STEP_DURATION_MINUTES * 60))   # 0-indexed

# Map to VU step:
steps = [200, 500, 800, 1000, 1200, 1500]      # from STEPS env var
current_step_vus = steps[min(step_index, len(steps) - 1)]

# Determine if in ramp or hold:
step_offset = elapsed_s - (step_index * STEP_DURATION_MINUTES * 60)
in_ramp = step_offset < RAMP_SECONDS
in_hold = not in_ramp
```

**Method 2: VU matching (preferred for live supervision)**

```
current_vus = k6.current.vus.value
# Match to nearest declared step:
current_step = min(steps, key=lambda s: abs(s - current_vus))
# If current_vus is between two steps, you're in a ramp
in_ramp = abs(current_vus - current_step) > current_step * 0.05
```

**Use elapsed time for batch step-boundary analysis (precise). Use VU matching for live supervision (tolerant of k6 API lag).**

### 10.7 Decision Gates at Each Step

After reading the JSON, evaluate:

```
PROCEED to next step if ALL true:
  ✓ runtime.hpa.currentReplicas >= 80% of expected pods
  ✓ k6 error rate < 1%
  ✓ k6 p95 < 3x baseline p95
  ✓ runtime.hpa.currentMetrics[cpu].currentUtilization remains below the configured target ceiling with headroom
  ✓ cluster.pendingPods is empty
  ✓ No OOMKilling events in cluster.events
  ✓ Pod CPU variance ratio < 1.5 (see 10.6A)
  ✓ Fleet restart count unchanged across hold window (see 10.6B)
  ✓ No ingress pod CPU > 70% of its limit (ingress is first bottleneck at high VUs)

STOP and investigate if ANY true:
  ✗ k6 error rate > 5%
  ✗ k6 p95 > 10x baseline
  ✗ cluster.pendingPods non-empty for > 6 consecutive polls (2+ minutes at 20s cadence)
  ✗ OOMKilling events present
  ✗ runtime.hpa.currentReplicas == maxReplicas AND cpu utilization > target%
  ✗ pod count grows > 20% vs previous step, actual msg/s improves by < 10%, and replica headroom is being consumed
  ✗ node count increases, efficiency remains < 85% at the end of the hold window, and reserved node headroom is being consumed
  ✗ MongoDB, Redis, Kafka, ClickHouse, or ingress-nginx stays above ~85% CPU limit for most of a hold window with no recovery
  ✗ runtime heap or RSS drifts upward by > 15% across the hold window without flattening
  ✗ Pod CPU variance ratio > 2.0 — hot-pod problem, adding pods won't help (see 10.6A)
  ✗ Fleet restart count increased during hold window — pods are crashing under load (see 10.6B)
  ✗ Any runtime pod's max(top.memory) > 85% of pod memory limit — fleet-wide OOM risk

WARN but continue if:
  ⚠ Pods < 80% expected but errors < 1% (HPA catching up)
  ⚠ k6 p95 between 3x-5x baseline (degrading)
  ⚠ Nodes were added but efficiency recovered to >= 85% before hold end
  ⚠ Infra CPU briefly exceeded ~85% but returned below it before the hold window ended
  ⚠ Reserved pod or node headroom was used, but throughput scaled proportionally and reserve still remains for the next step
  ⚠ Pod CPU variance ratio 1.5-2.0 — mild skew, note in report (see 10.6A)
  ⚠ Ingress CPU between 50-70% of limit — approaching bottleneck, monitor closely
```

### 10.7A Smart Stop Procedure

When a stop guardrail trips, stop in a way that preserves the evidence but avoids burning extra resources:

1. Mark the current step as `STOP` and record the exact guardrail that fired.
2. Capture the last 2 polls of `summary.json` for evidence and note the last stable step.
3. **Terminate the k6 Cloud run immediately** — use the stop script:
   ```bash
   ./benchmarks/scripts/stop-k6.sh <K6_RUN_ID>
   ```
   This tries `k6 cloud abort`, then the Cloud API `POST /loadtests/v2/runs/{id}/stop`, then the v4 PATCH. Do not let the run continue into the next step.
4. **Stop the poller** after the final evidence polls are written:
   ```bash
   ./benchmarks/scripts/cluster-poll.sh --stop <RUN_ID>
   ```
   This reads the pidfile at `benchmarks/results/polls/<RUN_ID>/poller.pid` and sends SIGTERM.
5. Recommend scaling from the **last stable step**, not from the failed step.

Use this rule of thumb:

- **Soft stop:** finish the current hold window, then terminate before the next step. Use when efficiency is degraded but stable and infra recovered by the end of the hold.
- **Hard stop:** terminate immediately. Use for pending pods, OOM events, maxed HPA with no recovery, or sustained stateful-service pressure.
- **Do not stop on healthy headroom usage:** if the run briefly uses reserved replicas or node capacity but throughput scales proportionally and reserve still remains for the next step, continue.

**Decision template (fill after each step):**

```markdown
### Step <N>: <VUs> VUs — <PROCEED|STOP|WARN>

| Check            | Expected                   | Actual (from JSON)                                 | Pass? |
| ---------------- | -------------------------- | -------------------------------------------------- | ----- |
| Pod count        | <N>                        | runtime.hpa.currentReplicas                        | ✓/✗   |
| HPA CPU %        | below target with headroom | currentMetrics[cpu].currentUtilization             | ✓/✗   |
| Pod CPU variance | ratio < 1.5                | max(runtime.top.cpu) / min(runtime.top.cpu)        | ✓/✗   |
| Heap MB (sample) | stable                     | runtime.health.heapUsedMB                          | ✓/✗   |
| Fleet mem (max)  | < 85% of limit             | max(runtime.top.memory) vs limits                  | ✓/✗   |
| Fleet restarts   | delta = 0                  | sum(runtime.pods.restarts) end vs start of step    | ✓/✗   |
| Error rate       | < 1%                       | k6.current.errorRate.value                         | ✓/✗   |
| p95 latency      | < <N>ms                    | k6.current.p95LatencyMs.value                      | ✓/✗   |
| Pending pods     | 0                          | cluster.pendingPods                                | ✓/✗   |
| OOM events       | 0                          | cluster.events                                     | ✓/✗   |
| MongoDB CPU      | < 80% limit                | mongodb.top[*].cpu vs pods[*].resources.limits.cpu | ✓/✗   |
| Redis CPU        | < 80% limit                | redis.top[*].cpu vs pods[*].resources.limits.cpu   | ✓/✗   |
| Kafka CPU        | < 80% limit                | kafka.top[*].cpu vs pods[*].resources.limits.cpu   | ✓/✗   |
| ClickHouse CPU   | < 80% limit                | clickhouse.top[*].cpu vs limits                    | ✓/✗   |
| Ingress CPU      | < 70% limit                | ingress.top[*].cpu vs limits                       | ✓/✗   |
| Throughput trend | stable or rising           | k6 throughput last 3 polls (see 10.6D)             | ✓/✗   |

**HPA Diagnosis** (see 10.5C diagnostic tree):

- Current/Desired/Max: <current>/<desired>/<max>
- CPU: <cpuUtil>% (target: <cpuTarget>%)
- Expected pods (10.4): <expected>
- Scaling lag: <lag_seconds>s across <lag_polls> polls (or "none")
- Diagnosis: <tree match # and one-line explanation>
- Conditions: <any non-normal conditions, or "all healthy">
- Scale-up policy: <behavior.scaleUp.policies summary>

**Decision:** PROCEED / STOP — <reason>
**Infra notes:** <any bottleneck observed in MongoDB/Redis/Kafka/ClickHouse/ingress/nodes>
```

### 10.8 Saturation Detection

Compare k6 throughput against expected:

```
efficiency = actual_msg_s / expected_msg_s * 100

HEALTHY     (>= 90%): system keeping up
DEGRADED    (75-90%): check if HPA is still scaling (pods growing in JSON) or bottleneck
SATURATED   (50-75%): infrastructure limit — identify using the bottleneck checklist below (10.8A)
CRITICAL    (< 50%): cascading failure — stop test
```

### 10.8A Service-Specific Bottleneck Identification

When efficiency drops below 90%, walk this checklist top-to-bottom. The first credible match is usually the primary bottleneck.

Attribution discipline:

- Report one `Primary Bottleneck` first. Put secondary effects under `Supporting Signals`, not as separate root causes.
- Prefer the most upstream limiter that explains downstream stress. Example: ingress saturation causing runtime under-delivery is an ingress bottleneck, not a runtime bottleneck.
- Do not blame HPA when the real limiter is node capacity, metrics unavailability, or a datastore ceiling.
- Do not recommend scaling a downstream component unless the upstream bottleneck has been ruled out with evidence from the same hold window.

| Priority | Component         | What to Check in JSON                                                                                                                          | Bottleneck Signal                                                                                                       | Root Cause                                                                                                                   | Recommendation                                                                                                                                                                                             |
| :------: | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    1     | **Ingress-NGINX** | `ingress.top[*].cpu` vs `ingress.pods[*].resources.limits.cpu`                                                                                 | CPU > 70% limit                                                                                                         | Ingress is the gateway — saturates before app pods                                                                           | Tell user: increase ingress replicas or HPA. Consider `worker-connections` tuning in ingress configMap                                                                                                     |
|    2     | **Runtime HPA**   | `runtime.hpa.currentMetrics[cpu].currentUtilization` vs `targets[cpu].targetUtilization`, `desiredReplicas` vs `currentReplicas`, `conditions` | Utilization at or above target, but pods not scaling (or at maxReplicas). Or desired > current for > 60s (scaling lag). | HPA ceiling, scaling lag, stabilization delay, or metrics unavailable — run the 10.5C diagnostic tree                        | Follow 10.5C diagnosis. If ceiling: increase maxReplicas. If lag: check pending pods (node-bound?) or tune scale-up policy. If CPU below target but throughput flat: not an HPA problem — check downstream |
|    3     | **Runtime Pods**  | `runtime.top[*].cpu` variance (10.6A)                                                                                                          | High variance (ratio > 2.0)                                                                                             | Uneven load distribution. One pod overloaded, others idle                                                                    | Check ingress session affinity, connection draining. This is a routing problem, not capacity                                                                                                               |
|    4     | **MongoDB**       | `mongodb.top[*].cpu` vs `mongodb.pods[*].resources.limits.cpu`, Coroot Mongo CPU delay, write latency, disk latency, connections, and node CPU | Any pod > 80% of CPU limit, or low CPU + high CPU delay + rising write latency (see Section 15)                         | WiredTiger read/write ticket saturation, connection pool pressure, or journal/fsync thundering-herd behavior                 | Tell user (StatefulSet): increase CPU limits, reduce `MONGODB_MAX_POOL_SIZE`, and run the Section 15 investigation before blaming node CPU or throttling                                                   |
|    5     | **Redis**         | `redis.top[*].cpu` vs `redis.pods[*].resources.limits.cpu`                                                                                     | Master pod > 70% of CPU limit                                                                                           | Redis is single-threaded for commands — one core is the ceiling                                                              | Tell user (StatefulSet): switch to replication (read replicas for pub/sub subscribers) or cluster mode                                                                                                     |
|    6     | **Kafka**         | `kafka.top[*].cpu` vs `kafka.pods[*].resources.limits.cpu`, pod count stability                                                                | CPU > 70% limit, or broker pod restarts                                                                                 | Broker saturation or ISR (in-sync replica) lag. `kubectl top` only shows CPU — Kafka consumer lag requires app-level metrics | Tell user (StatefulSet): increase broker resources or add brokers. Note: Kafka has unique failure modes not visible in CPU alone                                                                           |
|    7     | **ClickHouse**    | `clickhouse.top[*].cpu` and `clickhouse.top[*].memory`                                                                                         | CPU > 70% or memory > 80% of limit                                                                                      | Analytics write backpressure. CH buffers in memory before flushing                                                           | Tell user (StatefulSet): increase memory limits, check merge rate in CH system tables                                                                                                                      |
|    8     | **Nodes**         | `cluster.nodesTop[*].cpuPercent`, `cluster.pendingPods`                                                                                        | Node CPU > 85% or pods pending                                                                                          | Cluster autoscaler ceiling or VM provisioning delay                                                                          | Increase `user_node_max_count` in Terraform. If nodes at max: tell user to change Terraform                                                                                                                |
|    9     | **Memory drift**  | `runtime.top[*].memory` trend across polls, `runtime.health.heapUsedMB`                                                                        | Monotonically increasing across hold window without flattening                                                          | Memory leak or unbounded session/cache growth                                                                                | Check heap fragmentation ratio (`heapUsedMB / heapTotalMB`). If > 0.9: V8 is near GC pressure. Check `localCachedSessions` for unbounded growth                                                            |

**When multiple signals fire simultaneously**, the upstream bottleneck (ingress → runtime → DB) is usually the root cause. Fixing ingress may relieve runtime, which relieves MongoDB.

### 10.8B Cross-Poll Trend Analysis

Don't just check thresholds at step boundaries — look for **trends within the hold window** that predict problems at the next step.

**For each metric, compare the last 3 polls of the hold window:**

```
trend(values) =
  if all values within ±5% of mean → STABLE
  if each successive value > previous by > 2% → RISING
  if each successive value < previous by > 2% → FALLING
  else → NOISY
```

| Metric                       | STABLE                                        | RISING                                                  | FALLING                                                                    |
| ---------------------------- | --------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Runtime CPU (avg)**        | Normal                                        | HPA may need to scale at next step — pre-check headroom | Load is decreasing or pods were just added (dilution)                      |
| **Runtime memory (max pod)** | Normal                                        | Memory leak candidate — will it hit limit next step?    | GC reclaimed — likely stable                                               |
| **k6 throughput**            | Normal — system at capacity for this VU count | Extra capacity available or ramp completing             | **Red flag** — throughput declining under constant load = saturation onset |
| **k6 error rate**            | Normal if < 1%                                | **Red flag** — errors accelerating, may cascade         | Transient errors recovering                                                |
| **k6 p95 latency**           | Normal                                        | Queueing building up — check if pods are scaling        | Recovery from ramp spike                                                   |
| **MongoDB CPU**              | Normal                                        | Approaching limit — next step may saturate DB           | Load redistributed or connections closed                                   |
| **Node CPU (max node)**      | Normal                                        | May need new node at next step                          | Node just added (dilution)                                                 |

**Key insight:** A metric that is STABLE at 75% is safer than one that is RISING and at 60%. The trend predicts the next step better than the current value.

**Throughput-specific trend: declining throughput under constant load**

If `k6.current.throughputMsgPerSec` is FALLING while `k6.current.vus` is STABLE (within the hold window, not during ramp), the system is actively degrading. This is the strongest saturation signal — it means something downstream is backing up (connection pool exhaustion, DB locks, GC pauses). Flag this as a STOP candidate even if error rate is still low.

### 10.9 End-of-Run Report

After k6 finishes (or early stop), the agent reads the full `summary.json` and k6 API to compile:

```markdown
# Saturation Ladder Report — Run <RUN_ID>

**Date:** <date>
**Target:** <max_VUs> VUs
**Baseline:** <per_pod_safe_msg_s> msg/s per pod (Run <baseline_id>)
**Config:** HPA min=<N> max=<N>, targetCPU=<N>%, scale-up=<policy>
**JSON data:** benchmarks/results/polls/<RUN_ID>/summary.json (<N> polls)

## Step Results

| Step | VUs | Result | Final Pods | Actual msg/s | Expected msg/s | Efficiency | p95  | Errors | Heap MB | Mongo CPU | Redis CPU |
| :--: | :-: | :----: | :--------: | :----------: | :------------: | :--------: | :--: | :----: | :-----: | :-------: | :-------: |
|  1   | 200 |  PASS  |     7      |      94      |       95       |    99%     | 1.1s |   0%   |   450   |    28m    |    17m    |
| ...  |

## Saturation Point

## Bottleneck Analysis (with JSON evidence)

## Scaling Timeline (from cluster.events in JSON)

## Auto-Scaling Performance

### HPA Scaling Summary

| Step | VUs | Expected Pods | Actual Pods | Desired Pods | Scaling Lag | HPA Diagnosis (10.5C) | CPU % (target %) |
| :--: | :-: | :-----------: | :---------: | :----------: | :---------: | :-------------------: | :--------------: |
|  1   | 200 |       7       |      7      |      7       |    none     |      #10 Healthy      |    45% (50%)     |
| ...  |

### HPA Config Assessment

- **maxReplicas:** Was <N> sufficient? Hit ceiling at step <N>?
- **targetCPU:** Was <N>% responsive enough? CPU stayed below/above target during hold?
- **Scale-up policy:** <policy>. Was scaling fast enough? Average lag: <N>s
- **Stabilization window:** <N>s. Did it cause observable delay?
- **Node provisioning events:** <N> nodes added. Longest pod-pending duration: <N>s

## Recommendations
```

### 10.10 Coroot Deep-Dive Analysis (Post-Run)

Use this section together with:

- Section 12 for component saturation thresholds
- Section 13 for the concrete Coroot MCP call protocol
- Section 15 when MongoDB shows delay-heavy or write-latency-heavy behavior without obvious CPU saturation

**After the k6 run finishes**, use the Coroot MCP tools to get metrics that kubectl cannot provide. These are essential for the final analysis.

Canonical interpretation sources:

- Use Section 13.3 for the complete post-run Coroot call set.
- Use Section 12 for all component `GREEN` / `YELLOW` / `RED` thresholds.
- Use Section 15 if MongoDB shows low CPU but high delay or rising write latency.

Minimum post-run Coroot set:

- `mcp__coroot__get_app_nodejs(app="runtime", from="<epoch_ms>", to="<epoch_ms>")`
- `mcp__coroot__get_app_cpu(app="runtime", from="<epoch_ms>", to="<epoch_ms>")`
- `mcp__coroot__get_app_memory(app="runtime", from="<epoch_ms>", to="<epoch_ms>")`
- `mcp__coroot__get_mongodb_metrics(from="<epoch_ms>", to="<epoch_ms>")`
- `mcp__coroot__get_redis_metrics(from="<epoch_ms>", to="<epoch_ms>")`
- `mcp__coroot__get_app_traces(app="runtime", from="<epoch_ms>", to="<epoch_ms>", min_duration_ms=1000, limit=20)`

Post-run interpretation rules:

- Classify runtime health using Section 12.1, not ad-hoc prose.
- Classify MongoDB and Redis using Sections 12.2 and 12.3.
- Report pod heat using runtime CPU delay:
  - `CRITICAL`: delayPeak > 300ms/s
  - `WARM`: delayPeak 100-300ms/s
  - `NORMAL`: delayPeak < 100ms/s
- For MongoDB primary vs secondary comparison, treat primary CPU ratio, primary delay, write latency, disk latency, and ops-per-message ratio as a combined signal, not independent root causes.

### 10.10A Pre-Warm and Post-Test Cleanup Checklist

**CRITICAL: If you changed `minReplicas` to pre-warm pods, you MUST restore it after the test.**

**Pre-warm protocol:**

1. Edit `environments/dev/values.yaml` — set `runtime.hpa.minReplicas` to the desired pre-warm count
2. Commit and push on the current working branch only if the user explicitly asked for a repo change
3. Verify ArgoCD synced: `kubectl -n argocd get app abl-platform-dev -o jsonpath='{.status.sync.status}'`
4. Verify pods scaled: `kubectl -n abl-platform-dev get pods -l app.kubernetes.io/component=runtime --no-headers | wc -l`
5. Run pre-flight poll to confirm all pods healthy

**Post-test restore — DO THIS IMMEDIATELY after the run finishes:**

1. Edit `environments/dev/values.yaml` — restore `runtime.hpa.minReplicas` to `1` (or the previous value)
2. If a commit is required, use the normal repo commit policy for the current branch and include the real JIRA key
3. Push the current branch only when the user asked for that workflow
4. Verify ArgoCD synced and pods are scaling down
5. **Never leave pre-warm values in place** — they waste cluster resources and cost money

**ArgoCD sync verification after ANY values file change:**

```bash
CTX="aks-abl-dev-centralus"

# 1. Check sync status
kubectl --context $CTX -n argocd get app abl-platform-dev -o jsonpath='{.status.sync.status}'
# Expected: "Synced"

# 2. If still "OutOfSync" after 2 minutes, trigger hard refresh:
kubectl --context $CTX -n argocd patch app abl-platform-dev --type merge \
  -p '{"metadata":{"annotations":{"argocd.argoproj.io/refresh":"hard"}}}'

# 3. Verify the HPA actually changed:
kubectl --context $CTX -n abl-platform-dev get hpa abl-platform-dev-runtime
# Check MINPODS column matches your edit

# 4. If MINPODS didn't change, you edited the WRONG FILE.
#    ArgoCD reads: environments/dev/values.yaml (verify with):
kubectl --context $CTX -n argocd get app abl-platform-dev \
  -o jsonpath='{.spec.sources[*].helm.valueFiles}' 2>/dev/null || \
kubectl --context $CTX -n argocd get app abl-platform-dev \
  -o jsonpath='{.spec.source.helm.valueFiles}'
```

### 10.10B Step-Wise Execution Checklist

1. **[ ] Pre-flight** — Run `MAX_POLLS=1 RUN_ID=preflight ./cluster-poll.sh`, read JSON, check gate
2. **[ ] Compute expected table** — Section 10.4 formulas
3. **[ ] Show expected table to user** — Confirm before launching
4. **[ ] Launch k6** — Single `cloud-run.sh` invocation (background). Wait 90s for run ID. If empty, ask user.
5. **[ ] Confirm run ID** — Extract from output OR get from user (k6 Cloud URL). Never guess.
6. **[ ] Launch poller** — `STEPS=... STEP_DURATION_MINUTES=... RAMP_SECONDS=... RUN_ID=<id> ./cluster-poll.sh &` (background, must pass step vars)
7. **[ ] Enter supervision loop immediately** — every 30-60s read latest poll JSON and fetch k6 run status + latest metric samples
8. **[ ] Run the five live Coroot calls in Section 13.2 during each supervision cycle when the run is in hold or a degradation signal appears**
9. **[ ] Refresh the Primary Scorecard** — Section 14.1 every supervision cycle
10. **[ ] Warn or stop in real time when live guardrails trip** — do not wait for the next step boundary if a hard-stop condition appears
11. **[ ] Wait for step 1 hold window to end** — `hold_end = STEP_DURATION_MINUTES * 60` for step 1
12. **[ ] Read summary.json** — Batch analysis of all polls for step 1
13. **[ ] Query k6 API** — Pull run-bounded range series and slice only the hold window for step 1
14. **[ ] Fill Step Summary Scorecard** — Section 14.2 with expected vs actual and trend direction
15. **[ ] Decide PROCEED / STOP** — Section 10.7 criteria
16. **[ ] Repeat supervision + step analysis for each step** — keep monitoring between boundaries
17. **[ ] Publish Cross-Step Comparison** — Section 14.3 once two or more hold windows exist
18. **[ ] Stop poller when k6 finishes or is stopped** — `./benchmarks/scripts/cluster-poll.sh --stop <RUN_ID>`
19. **[ ] Run Coroot Phase A** — Health + SLO calls from Section 13.3
20. **[ ] Run Coroot Phase B** — Runtime deep-dive calls from Section 13.3
21. **[ ] Run Coroot Phase C** — MongoDB deep-dive calls from Section 13.3
22. **[ ] Run Coroot Phase D and E** — Redis plus supporting services from Section 13.3
23. **[ ] Run the MongoDB Section 15 investigation** if delay-heavy behavior appears without obvious CPU saturation
24. **[ ] Compile final report + saturation summary** — Sections 14.4 and 16
25. **[ ] Save report and restore minReplicas if needed** — `benchmarks/docs/saturation-run-<RUN_ID>-<date>.md`, then Section 10.10A cleanup and next actions

### 10.11 Polling Cadence Summary

| Source              | Interval             | Who                               | Output                                                     |
| ------------------- | -------------------- | --------------------------------- | ---------------------------------------------------------- |
| kubectl (all infra) | 20s                  | `cluster-poll.sh` script          | `poll-NNNN.json`                                           |
| Runtime `/health`   | 20s                  | `cluster-poll.sh` (port-forward)  | Embedded in poll JSON (single-pod sample)                  |
| k6 Cloud API        | 20s                  | `cluster-poll.sh` (via K6_RUN_ID) | Embedded in poll JSON (`k6.*` section)                     |
| Latest poll JSON    | Every 30-60s         | Agent supervisor                  | Live runtime, infra, k6, variance, restarts, trend signals |
| k6 direct API       | As needed / hold end | Agent supervisor                  | Wider hold-window verification / cross-check               |
| Step-boundary slice | At each hold end     | Agent supervisor                  | Decision template + proceed/stop gate + trend analysis     |

**Why script plus agent loop:** The agent should not spam raw kubectl every 20s. The script handles high-frequency cluster collection and writes structured JSON, including live k6 metrics. The agent then supervises in real time by reading the latest JSON every 30-60s, and uses direct k6 API queries when it needs a wider hold-window slice or explicit verification.

**Why JSON:** Machine-readable, parseable by future scripts, archivable for cross-run comparison. Every field is available for programmatic analysis, not just what the agent summarised.

---

## 11. Artifacts Produced

| Phase             | Artifact                              | Location                                                        |
| ----------------- | ------------------------------------- | --------------------------------------------------------------- |
| 1. Baseline       | Baseline profile doc                  | `benchmarks/docs/baseline-profile-<date>.md`                    |
| 2. Saturation     | Run analysis doc                      | `docs/load-testing/run-<id>-analysis.md`                        |
| 3. Capacity Plan  | Infrastructure spec                   | `benchmarks/docs/charter-load-<target>-plan.md`                 |
| 4. Scale Config   | Helm/Terraform changes                | `values-dev.yaml`, `*.tfvars`, `main.tf`                        |
| 5. Verification   | Comparison doc                        | `docs/load-testing/run-<id>-analysis.md` (with cross-run table) |
| 6. Saturation Run | Step-wise report with observation log | `benchmarks/docs/saturation-run-<RUN_ID>-<date>.md`             |

---

## 12. Per-Stack Saturation Signal Definitions

Use these tables to convert raw measurements into `GREEN`, `YELLOW`, or `RED` status. Apply them to the current hold window, not to whole-run averages.

### 12.1 Node.js Runtime

| Signal                    | GREEN     | YELLOW             | RED                      | Why It Matters                                                              |
| ------------------------- | --------- | ------------------ | ------------------------ | --------------------------------------------------------------------------- |
| Event loop lag avg        | < 50ms    | 50-100ms           | > 100ms                  | Queueing inside the runtime before requests can execute                     |
| Event loop lag peak       | < 150ms   | 150-300ms          | > 300ms                  | Burst starvation and health-check stalls                                    |
| GC pause avg              | < 20ms    | 20-50ms            | > 50ms                   | Frequent stop-the-world pauses reduce throughput                            |
| GC pause peak             | < 100ms   | 100-200ms          | > 200ms                  | Large pauses usually appear before p95 spikes                               |
| CPU delay avg             | < 20ms/s  | 20-100ms/s         | > 100ms/s                | Scheduler contention invisible in `kubectl top`                             |
| CPU delay peak            | < 100ms/s | 100-300ms/s        | > 300ms/s                | One hot pod or node can gate throughput                                     |
| CPU throttling peak       | < 5%      | 5-15%              | > 15%                    | Limit-based throttling means request CPU is too low or limits are too tight |
| Heap used ratio           | < 0.70    | 0.70-0.85          | > 0.85                   | Persistent high heap occupancy means GC pressure                            |
| RSS vs memory limit       | < 70%     | 70-85%             | > 85%                    | Leading OOM indicator                                                       |
| OOM kills / restart delta | 0         | 1 isolated restart | > 1 or repeated restarts | Immediate instability signal                                                |
| Error rate                | < 1%      | 1-5%               | > 5%                     | User-visible failure                                                        |
| p95 latency vs baseline   | < 3x      | 3-5x               | > 5x                     | End-to-end degradation summary                                              |

Interpretation rules:

- Event loop lag + CPU delay both `RED` means runtime saturation or hot-node contention.
- Event loop lag `RED` with CPU delay `GREEN` usually points to internal blocking work, GC churn, or downstream waiting.
- High p95 with low event loop lag often means a downstream datastore or ingress bottleneck, not runtime CPU starvation.

### 12.2 MongoDB

| Signal                   | GREEN                  | YELLOW                        | RED                              | Why It Matters                                                                       |
| ------------------------ | ---------------------- | ----------------------------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| Primary CPU vs limit     | < 60%                  | 60-80%                        | > 80%                            | Primary write path saturation                                                        |
| Primary CPU delay avg    | < 50ms/s               | 50-150ms/s                    | > 150ms/s                        | Scheduler delay on the primary                                                       |
| CPU throttling peak      | < 5%                   | 5-15%                         | > 15%                            | Container limit is constraining Mongo                                                |
| Disk read latency        | < 10ms                 | 10-30ms                       | > 30ms                           | Working set spilling or storage pressure                                             |
| Disk write latency       | < 10ms                 | 10-40ms                       | > 40ms                           | Journal/fsync pressure on the write path                                             |
| Write latency            | < 20ms                 | 20-50ms                       | > 50ms                           | Direct user-path delay                                                               |
| Read latency             | < 15ms                 | 15-40ms                       | > 40ms                           | Query pressure and cache misses                                                      |
| Operations/sec trend     | Stable with throughput | Rising faster than throughput | Rising while throughput flattens | Inefficient retries / herd behavior                                                  |
| Connections              | < 60% of safe cap      | 60-80%                        | > 80%                            | Pool pressure and context switching                                                  |
| Replication lag          | < 1s                   | 1-5s                          | > 5s                             | Secondary reads and failover safety degrade                                          |
| Node CPU hosting primary | < 70%                  | 70-85%                        | > 85%                            | Shared-node pressure can cause Mongo delay without high Mongo CPU                    |
| Ops-per-message ratio    | Stable baseline ±20%   | +20-50% vs baseline           | > +50% vs baseline               | Too many Mongo ops per successful message indicates retries, locks, or poor batching |

Ops-per-message ratio formula:

```text
ops_per_message = mongodb.operationsPerSecond / runtime.successfulMessagesPerSecond
```

Guidance:

- If primary CPU is low but CPU delay is `RED`, throttling is zero, and write latency is rising, trigger the Section 15 investigation. This can be a WiredTiger write-ticket / journal fsync thundering-herd pattern rather than raw CPU saturation.
- Compare primary vs secondary CPU. A ratio above 3:1 is normal for write-heavy phases; a ratio above 6:1 with replication lag suggests the primary is the limiter.

### 12.3 Redis

| Signal                | GREEN                       | YELLOW                        | RED                                | Why It Matters                                      |
| --------------------- | --------------------------- | ----------------------------- | ---------------------------------- | --------------------------------------------------- |
| Master CPU vs limit   | < 50%                       | 50-70%                        | > 70%                              | Redis command path is effectively single-core bound |
| Memory usage vs limit | < 70%                       | 70-85%                        | > 85%                              | Eviction / OOM risk                                 |
| Operations/sec        | Stable with throughput      | Rising faster than throughput | Rising while throughput flattens   | Cache churn or pub/sub overload                     |
| Connections           | < 60% of safe cap           | 60-80%                        | > 80%                              | Excess connections amplify latency                  |
| Replica CPU           | < 50%                       | 50-70%                        | > 70%                              | Subscriber or replication pressure                  |
| OOM kills / evictions | 0                           | Any isolated eviction         | Any OOM kill or repeated evictions | Immediate data-path instability                     |
| Network throughput    | Stable and below NIC budget | 70-85% of observed safe rate  | > 85% or packet loss symptoms      | Cross-node cache traffic can bottleneck before CPU  |

### 12.4 Ingress-NGINX

| Signal                    | GREEN               | YELLOW                 | RED                                    |
| ------------------------- | ------------------- | ---------------------- | -------------------------------------- |
| CPU vs limit              | < 50%               | 50-70%                 | > 70%                                  |
| Active connections growth | Proportional to VUs | Faster than throughput | Faster than throughput with rising p95 |
| 5xx rate                  | < 0.1%              | 0.1-1%                 | > 1%                                   |
| Pod skew                  | Even                | Mild skew              | One hot ingress pod                    |

### 12.5 Kafka

| Signal                           | GREEN  | YELLOW                  | RED                                 |
| -------------------------------- | ------ | ----------------------- | ----------------------------------- |
| Broker CPU vs limit              | < 50%  | 50-70%                  | > 70%                               |
| Broker restart / ISR instability | None   | Minor warnings          | Restart or repeated ISR churn       |
| Network throughput               | Stable | Approaching node budget | Saturated / unstable                |
| Producer-side error symptoms     | None   | Intermittent retries    | Sustained retries or backlog growth |

### 12.6 ClickHouse

| Signal                 | GREEN  | YELLOW        | RED                                            |
| ---------------------- | ------ | ------------- | ---------------------------------------------- |
| CPU vs limit           | < 50%  | 50-70%        | > 70%                                          |
| Memory vs limit        | < 70%  | 70-85%        | > 85%                                          |
| Merge / flush pressure | Stable | Slowing       | Backlog growing                                |
| Write latency symptom  | Stable | Mild increase | Sustained increase with analytics backpressure |

---

## 13. Coroot MCP Deep-Dive Protocol

Use Coroot for signals that `kubectl top` cannot show: event loop lag, CPU delay, throttling, request-level health, datastore latency, and trace patterns.

### 13.1 Time Window Calculation

Coroot calls must use the same run window as the k6 hold window being analysed.

```text
run_started_ms = parse_iso(k6.run.started)
step_duration_ms = STEP_DURATION_MINUTES * 60 * 1000
ramp_ms = RAMP_SECONDS * 1000

step_start_ms = run_started_ms + ((step_index - 1) * step_duration_ms)
hold_start_ms = step_start_ms + ramp_ms
hold_end_ms = step_start_ms + step_duration_ms

post_run_from_ms = run_started_ms
post_run_to_ms = parse_iso(k6.run.ended or now)
```

Rules:

- For live supervision, use `from=hold_start_ms` and `to=now`.
- For step-boundary analysis, use `from=hold_start_ms` and `to=hold_end_ms`.
- For whole-run post-mortem, use `from=run_started_ms` and `to=run_ended_ms`.

### 13.2 During-Run Live Monitoring Calls

Prioritize these five Coroot calls during each supervision cycle when the current hold window is active or any signal is degrading:

1. `mcp__coroot__get_app_health(app="runtime", from="<hold_start_ms>", to="now")`
2. `mcp__coroot__get_app_slo(app="runtime", from="<hold_start_ms>", to="now")`
3. `mcp__coroot__get_app_nodejs(app="runtime", from="<hold_start_ms>", to="now")`
4. `mcp__coroot__get_app_cpu(app="runtime", from="<hold_start_ms>", to="now")`
5. `mcp__coroot__get_mongodb_metrics(from="<hold_start_ms>", to="now")`

Priority order:

- Start with runtime health and Node.js metrics.
- Pull runtime CPU when `kubectl top` and latency disagree.
- Pull MongoDB metrics when throughput flattens, write latency rises, or runtime looks healthy but requests slow down.
- Add `mcp__coroot__get_redis_metrics` opportunistically when cache pressure is suspected.

### 13.3 Post-Run Comprehensive Analysis

Run these calls in five logical phases. Within a phase, parallelize where possible.

#### Phase A: Health / SLO

1. `mcp__coroot__get_project_status()`
2. `mcp__coroot__get_app_health(app="runtime", from="<from_ms>", to="<to_ms>")`
3. `mcp__coroot__get_app_slo(app="runtime", from="<from_ms>", to="<to_ms>")`
4. `mcp__coroot__get_app_health(app="mongodb", from="<from_ms>", to="<to_ms>")`
5. `mcp__coroot__get_app_health(app="redis", from="<from_ms>", to="<to_ms>")`

#### Phase B: Runtime Deep-Dive

6. `mcp__coroot__get_app_nodejs(app="runtime", from="<from_ms>", to="<to_ms>")`
7. `mcp__coroot__get_app_cpu(app="runtime", from="<from_ms>", to="<to_ms>")`
8. `mcp__coroot__get_app_memory(app="runtime", from="<from_ms>", to="<to_ms>")`
9. `mcp__coroot__get_app_instances(app="runtime", from="<from_ms>", to="<to_ms>")`
10. `mcp__coroot__get_app_pods(app="runtime", from="<from_ms>", to="<to_ms>")`
11. `mcp__coroot__get_app_network(app="runtime", from="<from_ms>", to="<to_ms>")`
12. `mcp__coroot__get_app_traces(app="runtime", from="<from_ms>", to="<to_ms>", min_duration_ms=1000, limit=20)`
13. `mcp__coroot__get_root_cause_analysis(app="runtime", from="<from_ms>", to="<to_ms>")`

#### Phase C: MongoDB Deep-Dive

14. `mcp__coroot__get_mongodb_metrics(from="<from_ms>", to="<to_ms>")`
15. `mcp__coroot__get_app_cpu(app="mongodb", from="<from_ms>", to="<to_ms>")`
16. `mcp__coroot__get_app_memory(app="mongodb", from="<from_ms>", to="<to_ms>")`
17. `mcp__coroot__get_app_network(app="mongodb", from="<from_ms>", to="<to_ms>")`
18. `mcp__coroot__get_app_traces(app="runtime", from="<from_ms>", to="<to_ms>", min_duration_ms=500, limit=20)`
19. `mcp__coroot__get_datastore_connections(app="runtime", datastore="mongodb", from="<from_ms>", to="<to_ms>")`

#### Phase D: Redis Deep-Dive

20. `mcp__coroot__get_redis_metrics(from="<from_ms>", to="<to_ms>")`
21. `mcp__coroot__get_app_cpu(app="redis", from="<from_ms>", to="<to_ms>")`
22. `mcp__coroot__get_app_memory(app="redis", from="<from_ms>", to="<to_ms>")`
23. `mcp__coroot__get_datastore_connections(app="runtime", datastore="redis", from="<from_ms>", to="<to_ms>")`

#### Phase E: Supporting Services

24. `mcp__coroot__get_app_cpu(app="ingress-nginx", from="<from_ms>", to="<to_ms>")`
25. `mcp__coroot__get_app_network(app="ingress-nginx", from="<from_ms>", to="<to_ms>")`
26. `mcp__coroot__get_app_cpu(app="kafka", from="<from_ms>", to="<to_ms>")`
27. `mcp__coroot__get_app_network(app="kafka", from="<from_ms>", to="<to_ms>")`
28. `mcp__coroot__get_clickhouse_metrics(from="<from_ms>", to="<to_ms>")`
29. `mcp__coroot__get_nodes()`
30. `mcp__coroot__get_deployments(app="runtime")`

Phase interpretation:

- Phase A establishes whether the platform was actually degraded during the window.
- Phase B determines whether runtime saturation, event-loop starvation, or hot-node contention was present.
- Phase C checks whether MongoDB was the true bottleneck, including delay-heavy cases.
- Phase D determines if Redis was command-path or memory bound.
- Phase E validates ingress, Kafka, ClickHouse, and node-level supporting limits.

### 13.4 App ID Reference Table

Use these short names first. If Coroot expects a full app ID in a specific environment, resolve it via `mcp__coroot__list_applications`.

| Logical Stack    | Preferred Coroot App Name |
| ---------------- | ------------------------- |
| Runtime          | `runtime`                 |
| MongoDB          | `mongodb`                 |
| Redis            | `redis`                   |
| Ingress NGINX    | `ingress-nginx`           |
| Kafka            | `kafka`                   |
| ClickHouse       | `clickhouse`              |
| Studio           | `studio`                  |
| Admin            | `admin`                   |
| SearchAI         | `search-ai`               |
| SearchAI Runtime | `search-ai-runtime`       |
| Workflow Engine  | `workflow-engine`         |

---

## 14. Live Monitoring Scorecard Tables

These tables are the mandatory operator-facing output format during and after a run.

### 14.1 Primary Scorecard

Display every 30-60 seconds during a live hold window.

```markdown
| Time  | Step | k6 VUs | Msg/s | Error % | p95  | Runtime Pods | HPA Cur/Des/Max | Event Loop | CPU Delay | Mongo CPU | Mongo Delay | Redis CPU | Nodes | Pending Pods | Status | Note        |
| ----- | ---- | ------ | ----- | ------- | ---- | ------------ | --------------- | ---------- | --------- | --------- | ----------- | --------- | ----- | ------------ | ------ | ----------- |
| 15:32 | 500  | 498    | 92    | 0.2%    | 1.4s | 7            | 7/9/20          | 42ms G     | 18ms/s G  | 54% G     | 35ms/s G    | 31% G     | 3     | 0            | GREEN  | HPA healthy |
```

Columns:

- `Status` is derived from the worst meaningful component state, not from one noisy metric.
- `Note` must name the current diagnosis, such as `HPA catching up`, `Node-bound scaling lag`, or `Mongo write path degrading`.

### 14.2 Step Summary Scorecard

Display at each hold-window end.

```markdown
| Step    | Expected Pods | Actual Pods | Expected Msg/s | Actual Msg/s | Efficiency | p95 vs baseline | Event Loop | CPU Delay | Mongo Write Lat | Redis CPU | Decision |
| ------- | ------------- | ----------- | -------------- | ------------ | ---------- | --------------- | ---------- | --------- | --------------- | --------- | -------- |
| 500 VUs | 9             | 8           | 96             | 92           | 95.8%      | 2.1x            | GREEN      | YELLOW    | GREEN           | GREEN     | PROCEED  |
```

Mandatory extras:

- Add trend arrows for `Actual Msg/s`, `Event Loop`, and `Mongo Write Lat`.
- Include a one-line `Primary Bottleneck` statement immediately below the table.

### 14.3 Cross-Step Comparison

Show after two or more steps have completed.

```markdown
| Step | Pods | Nodes | Msg/s | Efficiency | Event Loop | CPU Delay | Mongo CPU | Mongo Delay | Redis CPU | Bottleneck          | Outcome |
| ---- | ---- | ----- | ----- | ---------- | ---------- | --------- | --------- | ----------- | --------- | ------------------- | ------- |
| 200  | 4    | 2     | 40    | 99%        | GREEN      | GREEN     | GREEN     | GREEN       | GREEN     | none                | PASS    |
| 500  | 8    | 3     | 92    | 96%        | YELLOW     | YELLOW    | GREEN     | GREEN       | GREEN     | runtime scaling lag | PASS    |
| 800  | 12   | 4     | 110   | 78%        | YELLOW     | GREEN     | YELLOW    | RED         | GREEN     | Mongo write path    | STOP    |
```

### 14.4 Final Report Saturation Summary

Include this in the final report.

```markdown
| Component | Status | Limiting Signal                       | Evidence Window | Role In Bottleneck Chain |
| --------- | ------ | ------------------------------------- | --------------- | ------------------------ |
| Ingress   | GREEN  | CPU 42%                               | 800 VU hold     | Not limiting             |
| Runtime   | YELLOW | Event loop lag 88ms                   | 800 VU hold     | Secondary pressure       |
| MongoDB   | RED    | Write latency 74ms, CPU delay 210ms/s | 800 VU hold     | Primary bottleneck       |
| Redis     | GREEN  | CPU 34%                               | 800 VU hold     | Not limiting             |
| Nodes     | YELLOW | Primary node CPU 82%                  | 800 VU hold     | Contributing             |
```

Below the table, add:

- `Primary Bottleneck`
- `Bottleneck Chain`
- `Last Stable Step`
- `Highest Safe Throughput`

---

## 15. MongoDB CPU Delay Investigation Protocol

Trigger this protocol when MongoDB looks slow but raw CPU does not explain it.

### When To Trigger

Run this investigation when all of the following are true within the same hold window:

- MongoDB primary CPU is `GREEN` or low `YELLOW`
- MongoDB CPU delay is `RED`
- CPU throttling is near zero
- Write latency is `YELLOW` or `RED`
- Runtime throughput is flattening or falling

### 15.1 Six-Point Evidence Chain

Collect and document these in order:

1. **Node CPU and node pressure**
   - Was the node hosting the primary already hot?
   - If node CPU is low, node saturation is not the explanation.
2. **Throttle check**
   - If MongoDB throttling is near zero, cgroup CPU limits are not the explanation.
3. **Delay pattern**
   - Is delay spiky around write-heavy hold windows rather than constant across the run?
   - Delay bursts aligned with high write load suggest scheduler queues or fsync coordination.
4. **Disk I/O**
   - Check disk write latency and read latency. Rising write latency with moderate CPU often indicates journal/fsync wait.
5. **Secondary comparison**
   - If secondaries stay cooler than the primary while primary delay rises, the primary write path is the bottleneck.
6. **Trace latency**
   - Use runtime traces to confirm request stalls align with Mongo-backed operations, not ingress or Node.js blocking alone.

### 15.2 Root Cause Explanation

Candidate explanation:

`WiredTiger write-ticket thundering herd at journal fsync`

Meaning:

- Many runtime workers reach MongoDB write boundaries around the same time.
- The primary is not fully CPU-bound, but many writers pile up waiting for journal/fsync or write-ticket progress.
- Coroot shows high CPU delay or latency without proportionally high CPU usage.
- Throughput flattens because requests queue behind the write path even though raw CPU looks available.

This is why low CPU does **not** prove MongoDB is healthy.

### 15.3 Diagnostic Markdown Template

```markdown
#### MongoDB Delay Investigation

- Trigger step: <step / VUs>
- Primary CPU: <value>
- Primary CPU delay: <value>
- CPU throttling: <value>
- Write latency: <value>
- Disk write latency: <value>
- Secondary CPU / delay comparison: <summary>
- Runtime trace symptom: <summary>
- Conclusion: <thundering-herd likely | node contention | storage latency | insufficient evidence>
```

### 15.4 What This Is NOT

Do not misdiagnose the following as thundering herd without the evidence chain:

1. **Raw node saturation**
   - If node CPU is already `RED`, start with node contention.
2. **Container throttling**
   - If MongoDB throttling is high, limits are the explanation.
3. **Read-heavy cache miss pattern**
   - High read latency with normal write latency points elsewhere.
4. **Runtime event-loop starvation**
   - If runtime event loop lag is `RED` and Mongo signals are mild, runtime is more likely primary.
5. **Ingress bottleneck**
   - If ingress CPU and connection pressure go `RED` first, MongoDB is downstream noise.

---

## 16. Coroot Error Log Analysis Protocol

Use this section when a run shows failures, restarts, or unexplained degradation.

### 16.1 How To Fetch Logs

Fetch logs from the most relevant apps for the exact hold or post-run window:

- `mcp__coroot__get_app_logs(app="runtime", from="<from_ms>", to="<to_ms>", severity="error", limit=200)`
- `mcp__coroot__get_app_logs(app="runtime", from="<from_ms>", to="<to_ms>", severity="warning", limit=200)`
- `mcp__coroot__get_app_logs(app="mongodb", from="<from_ms>", to="<to_ms>", severity="warning", limit=100)`
- `mcp__coroot__get_app_logs(app="redis", from="<from_ms>", to="<to_ms>", severity="warning", limit=100)`
- `mcp__coroot__get_app_logs(app="ingress-nginx", from="<from_ms>", to="<to_ms>", severity="error", limit=100)`

If a trace ID appears in logs, fetch the matching trace from `mcp__coroot__get_app_traces`.

### 16.2 Common Error Categories At Scale

Classify logs into these categories:

- `timeout` — upstream timeout, DB timeout, HTTP timeout
- `connection_pool` — pool exhaustion, too many connections, wait queue saturation
- `oom_or_memory` — OOM, allocation failure, heap out of memory
- `cpu_or_scheduler` — throttling, CPU starvation, event loop stall
- `auth_or_rate_limit` — 401, 403, 429, quota exhaustion
- `ingress_or_network` — resets, upstream closed, TLS or socket errors
- `mongo_write_path` — write concern, lock wait, ticket wait, journal/fsync symptoms
- `redis_pressure` — command timeout, maxmemory, connection churn
- `kafka_backpressure` — producer retries, broker timeout, metadata errors
- `unknown` — anything else requiring manual review

### 16.3 Programmatic Categorization Script

Use this snippet when log volume is too high for manual inspection:

```python
import json
import re
from collections import Counter

CATEGORY_PATTERNS = {
    "timeout": [r"timeout", r"timed out", r"deadline exceeded"],
    "connection_pool": [r"pool", r"too many connections", r"wait queue"],
    "oom_or_memory": [r"out of memory", r"oom", r"allocation failed"],
    "cpu_or_scheduler": [r"throttl", r"event loop", r"cpu delay", r"starvation"],
    "auth_or_rate_limit": [r"\b401\b", r"\b403\b", r"\b429\b", r"rate limit", r"quota"],
    "ingress_or_network": [r"connection reset", r"broken pipe", r"upstream", r"econnreset", r"tls"],
    "mongo_write_path": [r"write concern", r"ticket", r"fsync", r"journal", r"lock timeout"],
    "redis_pressure": [r"redis", r"maxmemory", r"command timeout"],
    "kafka_backpressure": [r"kafka", r"broker", r"producer", r"metadata"],
}

def classify(message: str) -> str:
    lower = message.lower()
    for category, patterns in CATEGORY_PATTERNS.items():
        if any(re.search(pattern, lower) for pattern in patterns):
            return category
    return "unknown"

with open("coroot-logs.json") as f:
    entries = json.load(f)

counts = Counter(classify(entry.get("message", "")) for entry in entries)
for category, count in counts.most_common():
    print(f"{category}: {count}")
```

### 16.4 Reporting Rules

- Summarize the top categories with counts and one representative message each.
- Separate causal errors from downstream noise.
- If logs contradict metrics, trust the time-aligned metrics first and use logs as explanation.
- If there are no meaningful errors, say so explicitly instead of inventing a failure mode.

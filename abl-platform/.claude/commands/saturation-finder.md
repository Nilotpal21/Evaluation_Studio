Find per-pod saturation point — max messages/sec at a given p95 target.

The saturation-runner.sh script handles ALL execution (k6 launch, cluster polling,
early-stop monitoring, cleanup). Claude's role is: collect inputs, pin replicas,
launch the script, display a running scorecard, revert replicas, then analyze results.

**CRITICAL: Do NOT improvise execution steps. Follow the 6 phases below exactly.**

**Reference files (read when needed, not upfront):**

- `.agents/skills/saturation-finder/references/saturation-finder-reference.md` —
  Poll JSON schema (including `coroot` object), run directory schema, threshold
  tables, report table templates. **Read this before Phase 4 and Phase 6.**
- `benchmarks/docs/k6-cloud-api.md` — k6 Cloud API reference (OData syntax,
  aggregation functions, response format). **Read before Step 6.2.**

---

## Phase 1: Collect Inputs

Most inputs have sensible defaults from the tier profile (`benchmarks/config/tier-profiles.json`).
Only ask the user for what's truly needed.

### Required — always ask:

| Input           | Example | Why                                      |
| --------------- | ------- | ---------------------------------------- |
| Replicas to pin | `2`     | Changes cluster state — user must decide |

### Defaults — show to user, let them override:

| Input                    | Default           | Source                                | Env Var                 |
| ------------------------ | ----------------- | ------------------------------------- | ----------------------- |
| Environment              | `qa`              | QA is the saturation test env         | `ENV`                   |
| Tier                     | `s`               | Small tier                            | `TIER`                  |
| VU steps                 | from tier profile | s=`25,50,65`                          | `STEPS`                 |
| p95 target (ms)          | `1500`            | from tier profile                     | `P95_TARGET`            |
| Hold duration (minutes)  | `5`               | from tier profile                     | `STEP_DURATION_MINUTES` |
| Ramp between steps (sec) | `60`              | from tier profile                     | `RAMP_SECONDS`          |
| LLM mode                 | `mock` (always)   | real LLM adds uncontrollable variance | `MOCK_LLM=true`         |
| XLSX report              | `no`              | optional spreadsheet                  | —                       |

### Auto-detected — read from live cluster (do NOT ask):

| Input                            | How to read                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current default replicas         | `kubectl get deploy -l app.kubernetes.io/component=runtime -o jsonpath='{.items[0].spec.replicas}'`                                                                                                                                                                                                                                                                                       |
| Current default min              | `kubectl get hpa -l app.kubernetes.io/component=runtime -o jsonpath='{.items[0].spec.minReplicas}'`                                                                                                                                                                                                                                                                                       |
| Current default max              | `kubectl get hpa -l app.kubernetes.io/component=runtime -o jsonpath='{.items[0].spec.maxReplicas}'`                                                                                                                                                                                                                                                                                       |
| MongoDB PVC storage class + size | `kubectl get pvc -l app.kubernetes.io/component=mongodb -o jsonpath='{range .items[*]}{.spec.storageClassName}{"\t"}{.status.capacity.storage}{"\n"}{end}'` — if label doesn't match, fall back to `kubectl get pvc -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.storageClassName}{"\t"}{.status.capacity.storage}{"\n"}{end}'` and pick the `data-volume-*-mongodb-*` PVCs |

Use `--context aks-abl-<ENV>-centralus -n abl-platform-<ENV>` for all kubectl commands.

**Derive MONGO_IOPS_CEILING from storage class + size** using the Azure disk tier
lookup table in `.agents/skills/saturation-finder/references/saturation-finder-reference.md`
(§ Azure Disk Tier IOPS Reference). Set three variables for use throughout the skill:

```
MONGO_IOPS_BASELINE  — baseline IOPS for the disk tier (e.g., 1100 for P15)
MONGO_IOPS_BURST     — max burst IOPS (e.g., 3500 for P15)
MONGO_IOPS_CEILING   — use BASELINE as the conservative ceiling for sustained load
MONGO_STORAGE_CLASS  — storage class name (e.g., managed-csi-premium)
MONGO_DISK_TIER      — derived tier name (e.g., P15)
MONGO_DISK_SIZE      — PVC size (e.g., 256Gi)
```

Display these in the Phase 1 confirmation message and include them in §1 of the report.

### Interaction flow:

1. Read tier profile defaults for the tier
2. Read current cluster state for revert values
3. Present ONE confirmation message:

```
Saturation test configuration:
  Environment:    qa
  Tier:           s
  Replicas to pin: <ASK USER>
  VU steps:       25, 50, 65 (from tier-s)
  p95 target:     1500ms
  Hold:           5min per step, 60s ramp
  LLM:            mock
  Current HPA:    min=2, max=2, replicas=2 (will revert after test)
  MongoDB disk:   managed-csi-premium 256Gi (P15: 1100 IOPS baseline, 3500 burst)

How many replicas to pin? (e.g., 1 for baseline, 2 for scaling test)
```

4. After user answers, confirm and proceed. No second round of questions.

---

## Phase 2: Prepare — Pin Replicas

Edit `abl-platform-deploy/environments/<ENV>/values.yaml` under
`abl-platform-stack.abl-platform.runtime`:

```yaml
runtime:
  replicas: <PINNED>
  hpa:
    enabled: true
    minReplicas: <PINNED>
    maxReplicas: <PINNED>
  pdb:
    enabled: true
    minAvailable: 1
```

Commit and push to `main`. Wait for ArgoCD sync (~3 minutes).

Verify:

```bash
kubectl --context aks-abl-<ENV>-centralus -n abl-platform-<ENV> \
  get hpa -l app.kubernetes.io/component=runtime \
  -o jsonpath='{.items[0].spec.minReplicas}={.items[0].spec.maxReplicas}={.items[0].status.currentReplicas}'
```

Expected: `<PINNED>=<PINNED>=<PINNED>`. Do NOT proceed until verified.

---

## Phase 3: Execute — Launch saturation-runner.sh

Run the script in background. **Single invocation only.**

Only pass env vars that differ from defaults. The script reads tier-profiles.json
for steps/hold/ramp/p95 and defaults MOCK_LLM=true.

```bash
ENV=qa TIER=s \
  ./benchmarks/scripts/saturation-runner.sh
```

If the user overrode any defaults, pass those too:

```bash
ENV=qa TIER=s \
  STEPS=25,50,65 \
  STEP_DURATION_MINUTES=5 \
  RAMP_SECONDS=60 \
  P95_TARGET=1500 \
  MOCK_LLM=true \
  ./benchmarks/scripts/saturation-runner.sh
```

Run with `run_in_background: true`.

The script writes artifacts to `benchmarks/results/runs/<RUN_LABEL>/`:

- `config.json` — all inputs
- `status.json` — live status (updated every poll cycle)
- `steps.json` — per-step time windows
- `polls/` — symlink to cluster-poll output (each poll includes `coroot` metrics)
- `k6-run-id` — k6 Cloud run ID
- `early-stop.json` — if early-stopped
- `summary.json` — final summary

**Wait 30 seconds**, then find the run directory:

```bash
ls -td benchmarks/results/runs/sat-* | head -1
```

This is `RUN_DIR`. Read `$RUN_DIR/status.json` to confirm the script started.
If `status.json` doesn't exist yet, wait another 30 seconds and retry (max 3 retries).

---

## Phase 4: Monitor — Running Scorecard (Display Only)

**This phase is display-only. Make NO decisions. Take NO actions.**

Every 45 seconds, read two files:

1. `$RUN_DIR/status.json`
2. The latest poll JSON: `ls -t $RUN_DIR/polls/poll-*.json | head -1`

From these, print one scorecard row. Accumulate rows into a table.

### Scorecard Format

```
### Running Scorecard — Run <RUN_LABEL>

| # | Time     | Phase | VUs | Msg/s | Err%  | p95    | CPU   | CPU%Lim | EvLoop | CpuDly  | Throt  | Heap | Sess | MongoIOPS | MongoCPU | RedisCPU | Status |
|---|----------|-------|-----|-------|-------|--------|-------|---------|--------|---------|--------|------|------|-----------|----------|----------|--------|
| 1 | 15:30:23 | run   | 10  | 5.8   | 0.00% | 1120ms | 320m  | 16%     | 20ms   | 3ms/s   | 0ms/s  | 0.48 | 298  | 6         | 35%      | 20%      | GREEN  |
| 2 | 15:31:08 | run   | 10  | 6.0   | 0.00% | 1105ms | 340m  | 17%     | 21ms   | 4ms/s   | 0ms/s  | 0.49 | 407  | 8         | 36%      | 21%      | GREEN  |
```

### Column Sources

The poll JSON contains ALL data — kubectl metrics, k6 API, Coroot REST API, and
runtime /health — in a single file. Read
`.agents/skills/saturation-finder/references/saturation-finder-reference.md`
for the full poll JSON schema with exact field paths.

| Column      | Source                                                                |
| ----------- | --------------------------------------------------------------------- |
| `#`         | Sequential counter                                                    |
| `Time`      | `status.json → timestampIso` (HH:MM:SS)                               |
| `Phase`     | `status.json → phase`                                                 |
| `VUs`       | `status.json → latestMetrics.vus`                                     |
| `Msg/s`     | `status.json → latestMetrics.msgPerSec`                               |
| `Err%`      | `status.json → latestMetrics.errRate` (format as %)                   |
| `p95`       | `status.json → latestMetrics.p95` (append "ms")                       |
| `CPU`       | `poll → runtime.top[0].cpu`                                           |
| `CPU%Lim`   | CPU / `poll → runtime.pods[0].resources.runtime.limits.cpu` × 100     |
| `EvLoop`    | `poll → coroot.runtime.nodejs.eventLoopBlockedAvgMs` (append "ms")    |
| `CpuDly`    | `poll → coroot.runtime.cpu.delay.avg` × 1000 (append "ms/s")          |
| `Throt`     | `poll → coroot.runtime.cpu.throttle.avg` × 1000 (append "ms/s")       |
| `Heap`      | `poll → runtime.health.heapUsedMB / runtime.health.heapTotalMB`       |
| `Sess`      | `poll → runtime.health.localCachedSessions`                           |
| `MongoIOPS` | `poll → coroot.mongodb.storage.iopsWriteAvg`                          |
| `MongoCPU`  | `poll → coroot.mongodb.cpu.usageAvgMilli` + "m" (or kubectl fallback) |
| `RedisCPU`  | `poll → coroot.redis.cpu.usageAvgMilli` + "m" (or kubectl fallback)   |
| `Status`    | Derived (see rules below)                                             |

**Status derivation** (MongoIOPS thresholds are relative to MONGO_IOPS_CEILING from Phase 1):

- **RED**: err > 1% OR p95 > target OR EvLoop > 100ms OR Throt > 50ms/s OR Heap > 0.90 OR MongoIOPS > 90% of MONGO_IOPS_CEILING
- **YELLOW**: p95 > 80% of target OR CPU%Lim > 70% OR EvLoop > 50ms OR Throt > 10ms/s OR Heap > 0.85 OR MongoIOPS > 60% of MONGO_IOPS_CEILING
- **GREEN**: none of the above

**Fallback:** If `poll.coroot` has an error or is disabled, fall back to kubectl-only
columns (drop EvLoop, CpuDly, MongoIOPS and use `mongodb.top[0].cpu` for MongoCPU).

### Rules

- **EVERY cycle MUST print the full accumulated table.** No exceptions. No skipping.
  Never replace the table with just text. The table comes FIRST, always.
- **After the table, add 1-2 lines of analysis.** Note what changed since last cycle:
  signal transitions (GREEN→YELLOW→RED), step changes, notable metric movements.
  Keep it short — one or two sentences, not paragraphs.
- **Do NOT investigate, query APIs, or run commands to diagnose.** Just read the two
  local files (status.json + latest poll) and report what you see.
- If `status.json` is not yet written or poll dir is empty, print "Waiting for first poll..." and retry in 30s.
- If k6 metrics show zeros (k6 not started yet), fill with `--` and note "k6 starting".
- **Do NOT make PROCEED/STOP decisions.** The script handles early-stop.
- **Do NOT query k6 API or Coroot during this phase.** Just read local files.
- **Do NOT run any kubectl commands.** The poller handles cluster data.

### Termination

Stop reading when ANY of these is true:

- `status.json` shows `phase = "finished"` — script completed normally
- `status.json` shows `phase = "early-stopped"` — script triggered early-stop
- `$RUN_DIR/summary.json` exists — script has exited (cleanup trap writes this)

Print the final status and proceed to Phase 5.

---

## Phase 5: Revert — Restore Deploy Repo

**Immediately** after the run completes (or early-stops):

Edit `abl-platform-deploy/environments/<ENV>/values.yaml` back to user defaults:

```yaml
runtime:
  replicas: <DEFAULT_REPLICAS>
  hpa:
    enabled: true
    minReplicas: <DEFAULT_MIN>
    maxReplicas: <DEFAULT_MAX>
```

Commit and push. Confirm ArgoCD sync.

---

## Phase 6: Analyze — Generate Report

Now — and only now — use LLM intelligence. Read all artifacts.

**REQUIRED READING before starting Phase 6:**

1. `.agents/skills/saturation-finder/references/saturation-finder-reference.md` —
   Poll JSON schema (including `coroot` object), threshold tables (analysis
   decisions + bottleneck attribution), report table templates
2. `benchmarks/docs/k6-cloud-api.md` — k6 Cloud API reference (auth, OData syntax,
   aggregate/range queries, response format, aggregation functions, gotchas)

### Step 6.1: Read Artifacts

```
$RUN_DIR/config.json        — run configuration
$RUN_DIR/steps.json          — per-step time windows with start/end epochs
$RUN_DIR/summary.json        — final status, poll count, steps completed
$RUN_DIR/early-stop.json     — if present, why the run stopped
$RUN_DIR/polls/summary.json  — all poll snapshots (built at poller shutdown from summary.jsonl)
```

Extract: k6 run ID, step time windows (start/end epoch ms), final status.

For each step, compute the hold window (excluding ramp):

```
hold_start_ms = step.startEpochMs + (RAMP_SECONDS * 1000)
hold_end_ms   = step.endEpochMs
```

**Group polls by step:** For each step, collect all poll JSONs whose `epoch` falls
within the hold window. These polls contain all the data needed — kubectl, k6, Coroot,
health, noisy neighbors. No external API calls are needed for infrastructure metrics.

### Step 6.2: Query k6 Cloud API (Per-Step Hold Windows)

The poll JSON contains live k6 snapshot metrics, but for authoritative per-step
aggregates (avg, p95, p99 over the full hold window), query the k6 Cloud API.

Follow `benchmarks/docs/k6-cloud-api.md` for auth, syntax, and response parsing.

**Metrics to query per hold window** (use `query_aggregate_k6`):

| Metric                     | Query   | Purpose                  |
| -------------------------- | ------- | ------------------------ |
| `chat_turn_success_total`  | `rate`  | msg/sec (PRIMARY metric) |
| `chat_turn_latency_ms`     | `avg`   | average latency          |
| `chat_turn_latency_ms`     | `p95`   | p95 latency              |
| `chat_turn_latency_ms`     | `p99`   | p99 latency              |
| `chat_turn_latency_ms`     | `max`   | peak latency             |
| `http_req_failed`          | `rate`  | error rate (0-1)         |
| `chat_turn_attempts_total` | `count` | total attempts           |

**Response value is at:** `data.result[0].values[0][1]`

Also fetch full-run time-series for peak detection:

| Metric                    | Query  | Step | Purpose              |
| ------------------------- | ------ | ---- | -------------------- |
| `chat_turn_success_total` | `rate` | `30` | throughput over time |
| `vus`                     | `max`  | `60` | VU step boundaries   |

### Step 6.3: Extract Coroot Metrics from Poll JSON

**No separate Coroot API calls needed.** The poller already collects Coroot data
via `collect-coroot.py` every poll cycle. All metrics are in `poll.coroot`.

For each step's hold-window polls, extract and aggregate:

**Runtime (from `poll.coroot.runtime`):**

| Metric             | Path                                          | Aggregate             |
| ------------------ | --------------------------------------------- | --------------------- |
| CPU usage (milli)  | `coroot.runtime.cpu.usageAvgMilli`            | avg/peak              |
| CPU delay          | `coroot.runtime.cpu.delay.avg` × 1000         | avg/peak (ms/s)       |
| CPU throttle       | `coroot.runtime.cpu.throttle.avg` × 1000      | avg/peak (ms/s)       |
| Event loop blocked | `coroot.runtime.nodejs.eventLoopBlockedAvgMs` | avg/peak              |
| RSS memory         | `coroot.runtime.memory.rssAvgMi`              | avg/peak              |
| Per-pod CPU        | `coroot.runtime.cpu.usage.perPod[]`           | for hot-pod detection |

**MongoDB (from `poll.coroot.mongodb`):**

| Metric            | Path                                      | Aggregate       |
| ----------------- | ----------------------------------------- | --------------- |
| CPU usage (milli) | `coroot.mongodb.cpu.usageAvgMilli`        | avg/peak        |
| Write IOPS        | `coroot.mongodb.storage.iopsWriteAvg`     | avg/peak        |
| IO latency        | `coroot.mongodb.storage.ioLatencyAvgMs`   | avg/peak        |
| IO utilization    | `coroot.mongodb.storage.ioUtilizationAvg` | avg/peak (%)    |
| IO load           | `coroot.mongodb.storage.ioLoadAvg`        | avg/peak (ms/s) |

**Redis (from `poll.coroot.redis`):**

| Metric            | Path                                         | Aggregate |
| ----------------- | -------------------------------------------- | --------- |
| CPU usage (milli) | `coroot.redis.cpu.usageAvgMilli`             | avg/peak  |
| Master CPU        | `coroot.redis.cpu.usage.perPod[]` (master-0) | avg/peak  |

**ClickHouse (from `poll.coroot.clickhouse`):**

| Metric            | Path                                       | Aggregate |
| ----------------- | ------------------------------------------ | --------- |
| CPU usage (milli) | `coroot.clickhouse.cpu.usageAvgMilli`      | avg/peak  |
| Storage           | NOT AVAILABLE (Coroot returns null for CH) | —         |

**If `poll.coroot` has errors or is disabled**, fall back to kubectl-only metrics
from the poll JSON (`runtime.top`, `mongodb.top`, `redis.top` for CPU;
`runtime.health` for heap/GC/event loop).

### Step 6.4: Compute Analysis

Using k6 API data (Step 6.2) + poll Coroot data (Step 6.3) + poll health data:

**Per-step efficiency:**

```
expected_msg_s = VUs / time_per_turn
time_per_turn (mock): mock_delay_s + 0.15 + inter_message_delay_s
time_per_turn (real): use step 1 avg latency as floor
efficiency = (actual_msg_s / expected_msg_s) * 100
```

| Band          | Range  | Meaning                       |
| ------------- | ------ | ----------------------------- |
| **OPTIMAL**   | >= 95% | Pod keeping up perfectly      |
| **HEALTHY**   | 90-95% | Minor overhead, normal        |
| **DEGRADING** | 75-90% | Queueing or resource pressure |
| **SATURATED** | 50-75% | Infrastructure limit hit      |
| **CRITICAL**  | < 50%  | Cascading failure             |

**Bottleneck attribution** (walk top-to-bottom, first credible match is primary).
Use the exact thresholds from `.agents/skills/saturation-finder/references/saturation-finder-reference.md`
(Bottleneck Attribution Thresholds table).

| Priority | Layer              | Signal                                          | Source                      |
| -------- | ------------------ | ----------------------------------------------- | --------------------------- |
| 1        | Runtime CPU        | Throttle > 25% (red) OR CPU > 85% of limit      | poll.coroot.runtime.cpu     |
| 2        | Runtime Event Loop | Avg blocked > 100ms with CPU not saturated      | poll.coroot.runtime.nodejs  |
| 3        | Runtime Memory/GC  | Memory > 85% of limit AND GC pause > 200ms      | poll.runtime.health         |
| 4        | MongoDB CPU        | CPU > 70% of limit                              | poll.coroot.mongodb.cpu     |
| 5        | MongoDB IOPS       | Write IOPS > 90% of MONGO_IOPS_CEILING          | poll.coroot.mongodb.storage |
| 6        | MongoDB IO latency | IO latency > 50ms                               | poll.coroot.mongodb.storage |
| 7        | Redis CPU          | Master CPU > 70% of limit                       | poll.coroot.redis.cpu       |
| 8        | Network/Connection | Pool exhaustion or health endpoint disconnected | poll.runtime.health         |

**Saturation ceiling estimate** (after 2+ steps):

```
p95_rate = (p95[N] - p95[N-1]) / (VUs[N] - VUs[N-1])
headroom_ms = P95_TARGET - p95[N]
estimated_max_vus = VUs[N] + headroom_ms / p95_rate
```

**Cross-step trends:**

```
For last 3 polls of each hold window:
  STABLE = all values within +/-5% of mean
  RISING = each successive value > previous by > 2%
  FALLING = each successive value < previous by > 2%
  NOISY = else
```

Throughput FALLING under constant VUs = strongest saturation signal.

**Step decision classification** (for report, NOT live):

- **PROCEED**: p95 < target, err < 1%, efficiency >= 90%, no restarts/OOM, IOPS < 60% of MONGO_IOPS_CEILING
- **WARN**: p95 within 10% of target, OR efficiency 75-90%, OR IOPS 60-90% of MONGO_IOPS_CEILING
- **STOP**: p95 > target, OR err > 5%, OR restarts/OOM, OR efficiency < 50%, OR IOPS > 90% of MONGO_IOPS_CEILING

### Step 6.5: Check Prior Runs

```bash
ls -t benchmarks/docs/saturation-run-*.md | head -5
```

If prior runs exist, read the most recent to extract: max safe VUs, max safe msg/s,
primary bottleneck. Include cross-run delta in the report.

### Step 6.6: Generate Markdown Report

Save to `benchmarks/docs/saturation-run-<K6_RUN_ID>-<DATE>.md`.

**Fixed sections — emit ALL of these, in this order:**

**§1 Run Configuration**

| Setting                | Value                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| Date                   | from summary.json                                                                                           |
| Environment            | from config.json                                                                                            |
| Scenario               | script path                                                                                                 |
| LLM                    | mock <delay>ms OR real <model>                                                                              |
| p95 target             | from config.json                                                                                            |
| Pods pinned            | from config.json                                                                                            |
| VU steps               | from config.json                                                                                            |
| Hold duration          | from config.json                                                                                            |
| Ramp time              | from config.json                                                                                            |
| k6 Run ID              | from k6-run-id file                                                                                         |
| Polls collected        | from summary.json                                                                                           |
| Coroot enabled         | from first poll coroot object                                                                               |
| CPU request / limit    | from first poll JSON                                                                                        |
| Memory request / limit | from first poll JSON                                                                                        |
| MongoDB disk           | MONGO_STORAGE_CLASS MONGO_DISK_SIZE (MONGO_DISK_TIER: MONGO_IOPS_BASELINE baseline, MONGO_IOPS_BURST burst) |
| IOPS ceiling           | MONGO_IOPS_CEILING (baseline, conservative for sustained load)                                              |
| Result                 | completed / early-stopped                                                                                   |

**§2 Running Scorecard**

Full accumulated table from Phase 4 (every row captured during monitoring).

**§3 Cross-Step Comparison**

| Step | VUs | Msg/s Avg | Msg/s Peak | p95 Avg | p99 Avg | CPU Avg | CPU%Lim | CpuDly | Throt | EvLoop | Heap End | Mongo CPU | Mongo IOPS | Mongo IOLat | Redis CPU | Efficiency | Eff Delta | Trend | Bottleneck | Decision |
| ---- | --- | --------- | ---------- | ------- | ------- | ------- | ------- | ------ | ----- | ------ | -------- | --------- | ---------- | ----------- | --------- | ---------- | --------- | ----- | ---------- | -------- |

**§4 Per-VU Results**

One row per VU step. All metrics from k6 API + poll Coroot + poll health.

| VU  | msg/s avg | msg/s peak | p95 avg | p95 peak | p99 avg | avg lat | CPU avg | CPU peak | CPU%lim | CPU delay | CPU throttle | Ev Loop | GC pause | Heap | Mongo CPU | Mongo IOPS | Mongo IOLat | Mongo IOUtil | Redis CPU | Efficiency | Trend | Errors | Decision |
| --- | --------- | ---------- | ------- | -------- | ------- | ------- | ------- | -------- | ------- | --------- | ------------ | ------- | -------- | ---- | --------- | ---------- | ----------- | ------------ | --------- | ---------- | ----- | ------ | -------- |

**§5 Saturation Summary**

| Component      | Status | Limiting Signal | Evidence Window | Role                           |
| -------------- | ------ | --------------- | --------------- | ------------------------------ |
| Runtime CPU    | G/Y/R  | metric + value  | step N hold     | primary/secondary/not limiting |
| Runtime Memory | G/Y/R  | ...             | ...             | ...                            |
| Event Loop     | G/Y/R  | ...             | ...             | ...                            |
| MongoDB CPU    | G/Y/R  | ...             | ...             | ...                            |
| MongoDB IOPS   | G/Y/R  | ...             | ...             | ...                            |
| Redis          | G/Y/R  | ...             | ...             | ...                            |

**§6 Key Findings**

1. **Max safe throughput** — last PROCEED step as VUs + msg/s per pod
2. **Saturation ceiling estimate** — from prediction model + confidence
3. **Scaling linearity** — msg/s per VU ratio, constant or degrading
4. **Latency floor** — minimum avg latency observed
5. **Primary bottleneck** — from attribution chain with exact metric + value
6. **Bottleneck chain** — if multiple layers stressed, show causal chain
7. **MongoDB status** — CPU + IOPS + IO latency + IO utilization with evidence
8. **Redis status** — healthy/degrading/saturated with evidence
9. **Runtime health** — event loop, GC, heap, memory drift
10. **Error classification** — if any errors, categorize (timeout, connection, oom, etc.)

**§7 Capacity Recommendation**

```
Per-pod capacity: <N> msg/s at p95 < <TARGET>ms
To serve <X> msg/s total: <N> pods (msg/s / per_pod_capacity, rounded up)
Datastore headroom: MongoDB IOPS <PEAK_OBSERVED>/<MONGO_IOPS_CEILING> (<MONGO_DISK_TIER> <MONGO_DISK_SIZE>, burst <MONGO_IOPS_BURST>), IO util <N>%, Redis CPU <N>%
Next step: <recommendation>
```

**§8 Cross-Run Comparison** (if prior runs exist)

| Run ID | Date | Replicas | LLM Mode | Steps | Max Safe VUs | Max Safe Msg/s | p95 at Max | Bottleneck | Notes |
| ------ | ---- | -------- | -------- | ----- | ------------ | -------------- | ---------- | ---------- | ----- |

Delta: improved (>+5%), regressed (>-5%), or stable.

### Step 6.7: Optional Sizing XLSX

If user requested XLSX, generate the sizing workbook from the saturation run.
Derive `--per-pod` from the analysis results (max safe msg/s per pod from
the last PROCEED/WARN step).

```bash
source benchmarks/scripts/.venv-sizing/bin/activate
python3 benchmarks/scripts/saturation-xlsx.py \
  --run-dir $RUN_DIR \
  --report benchmarks/docs/saturation-run-<K6_RUN_ID>-<DATE>.md \
  --per-pod <PER_POD_MSG_S> \
  --dirty-pages 8.2 \
  --target <USER_TARGET_OR_100> \
  --output benchmarks/docs/sizing-<K6_RUN_ID>-<DATE>.xlsx
```

`--per-pod` is the measured per-pod capacity from the run analysis (§6 Key
Findings #1). If the user hasn't specified a target msg/s, default to 100.

The workbook has two tabs:

- **Sizing & Cost** — editable target msg/s, per-pod capacity, costs →
  auto-calculates pods, nodes, IOPS, monthly cost via Excel formulas
- **Measured** — readonly: run config, infrastructure snapshot, node pools,
  measured capacity with RAG status, per-step scorecard

---

## Safety Rules

- **NEVER modify StatefulSets** (MongoDB, Redis, Kafka, etc.)
- **NEVER write test params into cloud.env**
- **ALWAYS revert deploy repo** immediately after run (Phase 5)
- **ALWAYS ask user** for replica counts — never assume
- **NEVER launch saturation-runner.sh twice** — single invocation only
- **NEVER run kubectl commands during Phase 4** — read files only
- **NEVER make PROCEED/STOP decisions during Phase 4** — display only
- **NEVER query Coroot API or MCP during Phase 4** — data is already in poll JSON
- `saturation-runner.sh` handles: safety gate, k6 launch, polling (with Coroot), early-stop, cleanup
- Claude handles: input collection, deploy pinning/revert, scorecard display, post-run analysis

## Data Architecture

The poll JSON is the **single source of truth** for all infrastructure metrics.
Each poll file contains data from four collection sources, merged into one JSON:

| Source                 | Poll path                                        | What it provides                                                      |
| ---------------------- | ------------------------------------------------ | --------------------------------------------------------------------- |
| kubectl top + get pods | `runtime.*`, `mongodb.*`, `redis.*`, `cluster.*` | Per-pod CPU/memory, phase, restarts, OOM, limits                      |
| kubectl port-forward   | `runtime.health`                                 | Heap, GC, event loop, sessions, DB/Redis status                       |
| k6 Cloud API           | `k6.*`                                           | VUs, msg/s, error rate, p95, p99, step metadata                       |
| Coroot REST API        | `coroot.*`                                       | CPU detail (delay/throttle), event loop, IOPS, IO latency, memory RSS |
| k8s events             | `eventLedger.*`                                  | Per-component k8s events                                              |
| kubectl top (all-ns)   | `noisyNeighbors.*`                               | Top CPU/memory consumers on runtime nodes                             |

**Phase 4** reads poll JSON for the running scorecard.
**Phase 6** reads poll JSON for all infrastructure metrics + k6 Cloud API for
authoritative per-step aggregate latency/throughput.

## k6 Cloud Gotchas

- **VU doubling:** k6 Cloud runs 2 load-generator instances. Dashboard VUs × 2 = actual VUs hitting the system.
- **Run ID timing:** k6 takes ~60-90s to compile and upload before producing output. The runner script handles extraction with retries.
- **Status codes:** `result_status=0` means IN PROGRESS, not "passed". Run is finished when `run_status >= 3`.
- **OData queries:** `metric`/`query` in single quotes, `start`/`end` as bare ISO timestamps.

## Metric Trust Sources

| Metric             | Authoritative Source                         | Fallback                              |
| ------------------ | -------------------------------------------- | ------------------------------------- |
| messages/sec       | k6 Cloud API `chat_turn_success_total` rate  | poll `k6.current.throughputMsgPerSec` |
| p95/p99 latency    | k6 Cloud API `chat_turn_latency_ms`          | poll `k6.current.p95LatencyMs`        |
| Runtime CPU detail | poll `coroot.runtime.cpu` (delay/throttle)   | poll `runtime.top[].cpu`              |
| Event loop blocked | poll `coroot.runtime.nodejs`                 | poll `runtime.health.eventLoop`       |
| Runtime memory     | poll `coroot.runtime.memory` (RSS)           | poll `runtime.health.memoryUsageMB`   |
| MongoDB CPU        | poll `coroot.mongodb.cpu`                    | poll `mongodb.top[].cpu`              |
| MongoDB IOPS       | poll `coroot.mongodb.storage.iopsWriteAvg`   | NOT available from kubectl            |
| MongoDB IO latency | poll `coroot.mongodb.storage.ioLatencyAvgMs` | NOT available from kubectl            |
| Redis CPU          | poll `coroot.redis.cpu`                      | poll `redis.top[].cpu`                |
| Heap/GC/sessions   | poll `runtime.health`                        | —                                     |

## Saturation Thresholds Reference

### Runtime

| Metric         | Healthy | Degrading | Saturated |
| -------------- | ------- | --------- | --------- |
| CPU % of limit | < 50%   | 50-75%    | > 75%     |
| CPU delay avg  | < 5ms/s | 5-15ms/s  | > 15ms/s  |
| CPU throttle   | < 3ms/s | 3-10ms/s  | > 10ms/s  |
| Event loop avg | < 50ms  | 50-100ms  | > 100ms   |
| GC pause avg   | < 20ms  | 20-50ms   | > 50ms    |
| Heap ratio     | < 0.70  | 0.70-0.85 | > 0.85    |
| RSS vs limit   | < 70%   | 70-85%    | > 85%     |

### MongoDB

IOPS thresholds are relative to MONGO_IOPS_CEILING (fetched from cluster in Phase 1).

| Metric         | Healthy          | Degrading         | Saturated        |
| -------------- | ---------------- | ----------------- | ---------------- |
| CPU vs limit   | < 60%            | 60-80%            | > 80%            |
| Write IOPS     | < 60% of ceiling | 60-90% of ceiling | > 90% of ceiling |
| IO latency     | < 10ms           | 10-50ms           | > 50ms           |
| IO utilization | < 50%            | 50-80%            | > 80%            |

### Redis

| Metric            | Healthy | Degrading | Saturated |
| ----------------- | ------- | --------- | --------- |
| Master CPU vs lim | < 50%   | 50-70%    | > 70%     |

$ARGUMENTS

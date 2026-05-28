---
name: saturation-finder
description: 'Find per-pod saturation point. Fully deterministic: verifies every assumption via kubectl/MCP before acting. Triggers saturation-runner.sh, monitors poll artifacts, queries Coroot MCP per step, generates Markdown + XLSX report.'
---

# Saturation Finder

Find the maximum **messages/sec per runtime pod** that keeps p95 latency below target.

## ⛔ FORBIDDEN PATTERNS — Read Before Anything Else

These are the most common agent mistakes. Violating ANY of these wastes the entire run.

| ❌ NEVER DO THIS                                      | ✅ DO THIS INSTEAD                                                        | WHY                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `./saturation-runner.sh 2>&1 \| tail -50`             | `Bash(command="./saturation-runner.sh", run_in_background=true)`          | Piping blocks until script exits (17+ min). Background lets you monitor polls live.               |
| `Bash(command="./saturation-runner.sh")` (foreground) | `Bash(command="./saturation-runner.sh", run_in_background=true)`          | Foreground blocks Claude entirely. 10min timeout will kill it.                                    |
| `sleep 8 && cat status.json`                          | `Read(<run_dir>/status.json)`                                             | Sleep blocks Claude, prevents user interaction. Polls are written independently — just read them. |
| `sleep N && cat polls/poll-*.json`                    | `Bash("ls <run_dir>/polls/")` then `Read(<run_dir>/polls/poll-0001.json)` | Same — no sleep needed. Read whatever exists NOW.                                                 |
| Reading k6 API output from Bash stdout                | Read `<run_dir>/polls/poll-NNNN.json` — k6 data is already captured there | cluster-poll.sh captures k6 Cloud API metrics every 20s into poll JSON                            |

**The script writes files every ~20s independently of Claude. Claude's job is to READ those files — not to wait for them.**

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  saturation-runner.sh (launched with run_in_background)   │
│  - Safety gate (kubectl check, ingress probe)            │
│  - Starts cluster-poll.sh (subprocess, writes polls)     │
│  - Starts k6 Cloud (subprocess)                          │
│  - Supervision loop: reads polls, early-stops on breach  │
│  - NOTE: Pin/restore is done by THIS SKILL via deploy    │
│    repo (Phase 0 / Phase D), NOT by the runner script    │
│  - Writes to RUN_DIR/:                                   │
│    runner.log    ← full log (readable anytime)           │
│    status.json   ← latest phase + metrics (updated/20s) │
│    polls/        ← poll-NNNN.json (every 20s)           │
│    steps.json    ← step time windows (updated live)     │
│    summary.json  ← final status (written at exit)       │
└──────────────────────────────────────────────────────────┘
         │
         │  Claude reads these files to monitor progress:
         │    • Read runner.log    → see what the script is doing
         │    • Read status.json   → structured state + latest k6 metrics
         │    • Read latest poll   → full runtime/k6/datastore snapshot
         │
         ▼
┌──────────────────────────────────────────────────────────┐
│  THIS SKILL (Claude)                                     │
│  While running: Read status.json/polls → Running Scorecard│
│  After complete: Coroot MCP per step → Analysis + Report │
└──────────────────────────────────────────────────────────┘
```

### How Claude Monitors

1. Launch script with `run_in_background=true`
2. Claude is notified when the process completes
3. **While waiting**, Claude reads these files DIRECTLY (no `sleep`, no blocking):
   - `<run_dir>/runner.log` — human-readable log of everything happening
   - `<run_dir>/status.json` — structured: phase, step, VUs, p95, err%, msg/s
   - `<run_dir>/polls/poll-NNNN.json` — full k8s + k6 snapshot per cycle
4. From ALL polls, Claude renders a **Running Scorecard** (accumulating table, not one-line summaries)
5. On completion notification → Phase B analysis

**CRITICAL:** Never `sleep N && command`. Never `Bash(sleep 60 && cat file)`. The background script writes files independently. Claude just reads whatever exists NOW. If the user wants an update, read and re-render the full scorecard table immediately.

---

## Phase 0: Verify + Pin + Preflight

**ZERO ASSUMPTIONS.** Every value is discovered and verified live before acting.

### Tool Selection Principle

| Need                                                         | Use                                        | Why                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| K8s object state (HPA spec, pod spec, deployment, namespace) | **kubectl**                                | Authoritative source of truth for k8s objects; real-time, zero lag                  |
| Pod status (phase, ready, restarts, OOM)                     | **kubectl**                                | Real-time; Coroot has 2-3min ingestion lag — unacceptable for pre-launch checks     |
| Rollout status                                               | **kubectl**                                | Only source for rollout conditions (Progressing/Available)                          |
| CPU/memory usage during test                                 | **Poll artifacts** (primary)               | Already captured every 20s by cluster-poll.sh via kubectl top — no need to re-query |
| Node.js internals (heap, event loop, GC) during test         | **Poll artifacts** (primary)               | Already captured every 20s from /health endpoint — no need to re-query              |
| CPU throttling %                                             | **Coroot** `get_app_pods`                  | Only source — eBPF cgroup metrics; polls don't have this                            |
| Server-side p50/p95/p99 latency                              | **Coroot** `get_app_slo`                   | Only source — computed from distributed traces; polls have client-side only         |
| Saturation signals (red/yellow/green)                        | **Coroot** `get_benchmark_saturation`      | Only source — multi-dimension threshold analysis                                    |
| Service health (availability, SLI summary)                   | **Coroot** `get_app_health`                | Only source — aggregated health from traces + metrics                               |
| Node capacity + usage (during test)                          | **Poll artifacts** `cluster.nodesTop[*]`   | Polls capture node CPU%/memory% every 20s via kubectl top nodes                     |
| Node capacity + usage (preflight, no polls yet)              | **Coroot** `get_nodes`                     | Before test launch, no polls exist — use Coroot for time-windowed check             |
| k6 metrics (VUs, msg/s, client p95, err%)                    | **Poll artifacts**                         | Already captured every 20s from k6 Cloud API — no need to re-query                  |
| MongoDB/Redis CPU during test                                | **Poll artifacts** (primary)               | Already captured every 20s via kubectl top                                          |
| Mutation (deploy repo, emergency patch)                      | **kubectl** / **git**                      | Only option; Coroot is read-only                                                    |
| Convergence verification (spec matches desired)              | **kubectl**                                | Need to verify k8s object spec was updated — authoritative                          |
| Post-convergence health (after ArgoCD sync)                  | **kubectl** (pod state) + **Coroot** (SLI) | kubectl confirms pods running; Coroot confirms they're serving correctly            |

**Rule:** Never use Coroot where kubectl is authoritative (object specs, current pod state). Never use kubectl where Coroot is the only source (throttling, latency percentiles, Node.js internals). When both can answer, prefer the one with higher fidelity for the specific question.

### Step 0a: Discover and verify environment

1. **Ask user** for: environment (`dev`|`qa`|`staging`), tier (`s`|`m`|`l`|`xl`), and any overrides.

2. **Derive context and namespace** (DO NOT assume they exist yet):

   ```
   CONTEXT = "aks-abl-<env>-centralus"
   NS = "abl-platform-<env>"
   ```

3. **VERIFY kubectl context exists and is reachable** — Tool: `kubectl` (only option for cluster connectivity):

   ```bash
   kubectl --context <CONTEXT> cluster-info --request-timeout=10s 2>&1
   ```

   - If fails: STOP. Tell user the context is not configured. Show `kubectl config get-contexts`.

4. **VERIFY namespace exists** — Tool: `kubectl` (authoritative for k8s objects):

   ```bash
   kubectl --context <CONTEXT> get namespace <NS> -o jsonpath='{.metadata.name}' 2>&1
   ```

   - If fails: STOP. Namespace does not exist.

5. **VERIFY Coroot MCP is accessible** — Tool: `mcp__coroot__list_environments` (needed for Phase B analysis):

   ```
   mcp__coroot__list_environments()
   ```

   - If fails or environment not in list: STOP. Coroot cannot observe this environment.

### Step 0b: Discover current live state

**Read the ACTUAL live state — never trust config files alone.**

6. **Get current HPA state** — Tool: `kubectl` (authoritative for HPA spec + status; real-time):

   ```bash
   kubectl --context <CONTEXT> -n <NS> get hpa -l app.kubernetes.io/component=runtime -o json
   ```

   - Extract: `hpaName`, `spec.minReplicas`, `spec.maxReplicas`, `status.currentReplicas`, `status.desiredReplicas`
   - If no HPA found: check if deployment exists without HPA (raw replicas)
   - Record ACTUAL values for restore: `RESTORE_MIN`, `RESTORE_MAX`, `RESTORE_REPLICAS`
   - Why kubectl: HPA spec is a k8s object — kubectl is the only authoritative source. Coroot does not expose HPA spec fields.

7. **Get current pod state** — Tool: `kubectl` (authoritative for pod spec + container resources):

   ```bash
   kubectl --context <CONTEXT> -n <NS> get pods -l app.kubernetes.io/component=runtime -o json
   ```

   - Extract: pod count, phase, ready status, restarts, resource requests/limits, node names
   - Record ACTUAL pod resources: `LIVE_CPU_REQ`, `LIVE_CPU_LIM`, `LIVE_MEM_REQ`, `LIVE_MEM_LIM`
   - Why kubectl: Pod spec (resource requests/limits) is only in the k8s API. Coroot `get_app_pods` shows usage but not the configured spec fields.

8. **Get current deployment state** — Tool: `kubectl` (authoritative for rollout conditions):

   ```bash
   kubectl --context <CONTEXT> -n <NS> get deployment -l app.kubernetes.io/component=runtime -o json
   ```

   - Extract: deployment name, replicas, image, strategy
   - Verify: no rollout in progress (`status.conditions` type=Available status=True, type=Progressing reason=NewReplicaSetAvailable)
   - Why kubectl: Rollout conditions (Progressing/Available) are k8s-native. Coroot `get_deployments` shows recent deploys but not rollout sub-conditions.

9. **Read tier profile** (for target values):

   ```bash
   Read(benchmarks/config/tier-profiles.json)
   ```

   - Extract `tier-profiles.json[<tier>].saturation`:
     - `pods.min`, `pods.max` → PIN_REPLICAS
     - `resources.cpuReq`, `resources.cpuLimit`, `resources.memReq`, `resources.memLimit` → TARGET_RESOURCES
     - `steps` → VU_STEPS
     - `holdMinutes`, `rampSeconds`, `p95Target`

10. **Compare live vs target**:

    ```
    RESOURCE_CHANGE_NEEDED = (LIVE_CPU_LIM != TARGET_CPU_LIM) OR (LIVE_MEM_LIM != TARGET_MEM_LIM)
    REPLICA_CHANGE_NEEDED = (LIVE_MIN != PIN_REPLICAS) OR (LIVE_MAX != PIN_REPLICAS)
    ```

    - Display comparison table to user:

    ```
    Current vs Target — <env>
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    Attribute       │ Live      │ Target (tier <tier>)  │ Action
    ────────────────┼───────────┼───────────────────────┼────────
    HPA min         │ 2         │ 2                     │ no change
    HPA max         │ 10        │ 2                     │ PIN
    Replicas        │ 3         │ 2                     │ PIN (scale down)
    CPU request     │ 500m      │ 1                     │ CHANGE
    CPU limit       │ 2         │ 2                     │ no change
    Mem request     │ 1Gi       │ 2Gi                   │ CHANGE
    Mem limit       │ 2Gi       │ 4Gi                   │ CHANGE
    ```

    - Ask user to confirm changes before proceeding.

### Step 0c: Discover and verify deploy repo

11. **Locate deploy repo**:

    ```bash
    # Check common sibling paths
    ls -d ../abl-platform-deploy 2>/dev/null || ls -d ../deploy 2>/dev/null
    ```

    - If not found: ASK user for path. Do not assume.

12. **Verify deploy repo is clean and on correct branch**:

    ```bash
    git -C <DEPLOY_REPO> status --porcelain
    git -C <DEPLOY_REPO> branch --show-current
    git -C <DEPLOY_REPO> remote -v
    ```

    - If dirty: STOP. Tell user to commit/stash first.
    - If not on expected branch (main/master or env-specific): WARN user.

13. **Read values.yaml and VERIFY structure**:

    ```bash
    Read(<DEPLOY_REPO>/environments/<env>/values.yaml)
    ```

    - VERIFY: file exists, contains `runtime` section with `replicas`, `hpa.minReplicas`, `hpa.maxReplicas`
    - VERIFY: resource fields exist if resource changes needed
    - If structure doesn't match expected: STOP. Show what was found. Ask user for correct path.

14. **Record exact restore values from values.yaml** (not from kubectl — values.yaml is the source of truth for GitOps):
    - `RESTORE_YAML_REPLICAS`, `RESTORE_YAML_HPA_MIN`, `RESTORE_YAML_HPA_MAX`
    - `RESTORE_YAML_CPU_REQ`, `RESTORE_YAML_CPU_LIM`, `RESTORE_YAML_MEM_REQ`, `RESTORE_YAML_MEM_LIM`

### Step 0d: Apply changes via deploy repo

15. **Edit values.yaml** — only the fields that need changing:

    ```yaml
    runtime:
      replicas: <PIN_REPLICAS>
      hpa:
        minReplicas: <PIN_REPLICAS>
        maxReplicas: <PIN_REPLICAS>
      resources:
        requests:
          cpu: '<TARGET_CPU_REQ>'
          memory: '<TARGET_MEM_REQ>'
        limits:
          cpu: '<TARGET_CPU_LIM>'
          memory: '<TARGET_MEM_LIM>'
    ```

16. **Commit + push**:

    ```bash
    git -C <DEPLOY_REPO> add environments/<env>/values.yaml
    git -C <DEPLOY_REPO> commit -m "perf: pin runtime for saturation test (<env>, <PIN_REPLICAS> pods, <TARGET_CPU_LIM> CPU)"
    git -C <DEPLOY_REPO> push
    ```

    - If push fails: STOP. Tell user to push manually.

### Step 0e: Wait for ArgoCD convergence (deterministic polling)

Tool: **kubectl** exclusively for convergence — checking that k8s objects match the desired spec requires the authoritative k8s API. Coroot's 2-3min lag would give false negatives (showing old state as current).

17. **Poll until LIVE state matches DESIRED** (max 10 minutes, 30s interval):

    ```bash
    # Every 30s, check:
    kubectl --context <CONTEXT> -n <NS> get hpa -l app.kubernetes.io/component=runtime \
      -o jsonpath='{.items[0].spec.minReplicas}/{.items[0].spec.maxReplicas}/{.items[0].status.currentReplicas}'
    # Expected: <PIN>/<PIN>/<PIN>
    ```

    Also verify pods are ready:

    ```bash
    kubectl --context <CONTEXT> -n <NS> get pods -l app.kubernetes.io/component=runtime -o json
    ```

    - Count: pods with `status.phase=Running` AND all containers ready = PIN_REPLICAS
    - No pod in CrashLoopBackOff, OOMKilled, or Pending

    Also verify resource changes applied:

    ```bash
    kubectl --context <CONTEXT> -n <NS> get pods -l app.kubernetes.io/component=runtime \
      -o jsonpath='{.items[0].spec.containers[0].resources}'
    ```

    - VERIFY: limits/requests match TARGET values

    **Timeout handling**: If not converged after 10 minutes:
    - STOP. Show current state. Show `kubectl describe` output.
    - RESTORE deploy repo to original values immediately.
    - Tell user what failed.

### Step 0f: Preflight health checks (after convergence confirmed)

**Run ALL checks. Block on ANY failure.**

| #   | Check                              | Tool                                                                                         | Why this tool                                                                                                  | Block if                                   | Actual value shown         |
| --- | ---------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------- |
| 1   | Runtime health (SLI)               | **Coroot** `get_app_health("runtime", from=<5min-epoch>, to=<now-epoch>, environment=<env>)` | Only source for aggregated availability, latency SLIs, error rate                                              | Any critical SLI failing                   | Show exact metrics         |
| 2   | Runtime pods (state)               | **kubectl** `get pods -l app.kubernetes.io/component=runtime -o json`                        | Authoritative for pod phase, readiness conditions, restart count, OOM — real-time, zero lag                    | OOM, restarts > 0, not ready, wrong count  | Show pod table             |
| 3   | Runtime Node.js (heap, event loop) | **Coroot** `get_app_nodejs("runtime", from=<5min-epoch>, to=<now-epoch>, environment=<env>)` | Only source for V8 heap, event loop lag, GC pauses (exposed via OpenTelemetry, not kubectl)                    | Heap > 80% of limit, event loop avg > 50ms | Show heap/eventLoop values |
| 4   | Node capacity + usage              | **Coroot** `get_nodes(environment=<env>)`                                                    | Time-windowed usage %; kubectl `top nodes` is instant snapshot that misses spikes                              | Any node CPU > 80% avg                     | Show per-node CPU%         |
| 5   | Rollout status                     | **kubectl** `rollout status deployment/<name> --timeout=5s`                                  | Only source for rollout conditions (Progressing/Available); Coroot shows deployments but not rollout sub-state | In-progress rollout                        | Show rollout status        |
| 6   | MongoDB health                     | **Coroot** `get_app_health("mongodb", from=<5min-epoch>, to=<now-epoch>, environment=<env>)` | Only source for MongoDB SLIs (replication lag, connection health, ops/s)                                       | Unhealthy                                  | Show status                |
| 7   | Redis health                       | **Coroot** `get_app_health("redis", from=<5min-epoch>, to=<now-epoch>, environment=<env>)`   | Only source for Redis SLIs (hit rate, connection health, memory)                                               | Unhealthy                                  | Show status                |
| 8   | Ingress reachable                  | **curl** (bash)                                                                              | External HTTP probe — neither kubectl nor Coroot tests end-to-end ingress path                                 | Non-200                                    | Show HTTP code             |
| 9   | k6 token available                 | **bash** `test -f ... && grep -q K6_CLOUD_TOKEN ...`                                         | Local file check — no k8s or Coroot involvement                                                                | Missing token                              | Show what's missing        |
| 10  | cluster-poll.sh executable         | **bash** `test -x ...`                                                                       | Local file permission — no k8s or Coroot involvement                                                           | Not executable                             | Show permissions           |
| 11  | k6 CLI available                   | **bash** `command -v k6`                                                                     | Local binary check — no k8s or Coroot involvement                                                              | Not installed                              | Show error                 |

### Preflight output to user:

```
Pin + Preflight — <env> (tier <tier>)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Context:           ✓ aks-abl-<env>-centralus reachable
Namespace:         ✓ abl-platform-<env> exists
Deploy Pin:        ✓ Committed + pushed (min=2, max=2, replicas=2, cpu=2, mem=4Gi)
ArgoCD Sync:       ✓ Converged (2/2 pods ready, resources match)
Runtime Health:    ✓ OK (availability 100%, p95=340ms)
Runtime Pods:      ✓ 2/2 Running, 0 restarts, heap 45% of limit
Node Capacity:     ✓ CPU: node1=35%, node2=42%
MongoDB:           ✓ Healthy (CPU 12%, connections OK)
Redis:             ✓ Healthy (CPU 3%, memory 28%)
Ingress:           ✓ HTTP 200 (latency 45ms)
k6 Token:          ✓ cloud.env present
k6 CLI:            ✓ k6 v0.52.0
cluster-poll.sh:   ✓ Executable

Restore values recorded:
  HPA: min=2, max=10 | Replicas: 3 | CPU: 500m/2 | Mem: 1Gi/2Gi

Ready to launch k6:
  VU Steps: [25, 50, 65] | Hold: 5min | Ramp: 60s
  p95 Target: 1500ms | Mock LLM: true | 2 pinned pods
  Proceed? [y/n]
```

**If ANY check fails**: Show the failure, explain remediation, do NOT proceed.

### Optional Input — XLSX Report

After collecting required inputs, ask the user:

> **Would you like an XLSX spreadsheet report in addition to the Markdown report?** (yes/no, default: no)

If yes, after the Markdown report is saved, generate an XLSX workbook via
`benchmarks/scripts/saturation-xlsx.py`. See Section 21 for details.

---

## Phase A: Launch + Monitor

### Step 1: Verify prerequisites one more time

Tool: **kubectl** — Need real-time pod state (phase, restarts) with zero lag. Coroot has 2-3min ingestion delay — a pod that crashed 30s ago would still show healthy in Coroot.

```bash
# Verify pods didn't crash between preflight and launch
kubectl --context <CONTEXT> -n <NS> get pods -l app.kubernetes.io/component=runtime \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\t"}{.status.containerStatuses[0].restartCount}{"\n"}{end}'
```

- If any pod restarted or isn't Running: STOP.

### Step 2: Launch the script

```bash
Bash(
  command="cd <REPO_ROOT> && ENV=<env> STEPS=<steps> P95_TARGET=<p95> MOCK_LLM=<mock> TIER=<tier> STEP_DURATION_MINUTES=<hold> RAMP_SECONDS=<ramp> ./benchmarks/scripts/saturation-runner.sh",
  run_in_background=true
)
```

### Step 3: Verify run directory was created

```bash
# Wait up to 10 seconds for dir to appear
ls -td benchmarks/results/runs/sat-<env>-* | head -1
```

- Read the dir path. If not found: script may have crashed. Read any recent logs.

### Step 4: Verify script is actually running

```bash
Read(<run_dir>/status.json)
```

- Valid phases: `"preflight"` → `"safety-gate"` → `"polling"` → `"running"` → `"early-stopped"` | `"finished"`
- Should show `"phase": "polling"` or `"phase": "running"` after successful launch.
- If file doesn't exist after 15s, read `runner.log` for crash reason.

### Step 5: Monitor (while script runs)

**CRITICAL: NEVER use `sleep` in monitoring commands.** Claude Code's background process model works like this:

- The script is running in background → Claude gets notified on completion
- Poll artifacts are written every ~20s by cluster-poll.sh (independent of Claude)
- Claude reads whatever exists RIGHT NOW — no waiting needed

**Monitoring pattern (NO SLEEP):**

```bash
# Read status — DIRECT, no sleep prefix
Read(<run_dir>/status.json)

# Read ALL polls collected so far — DIRECT, no sleep prefix
Bash(command="python3 -c \"
import json, os, glob
poll_dir = '<run_dir>/polls'
polls = sorted(glob.glob(os.path.join(poll_dir, 'poll-*.json')))
rows = []
for f in polls:
    with open(f) as fh:
        p = json.load(fh)
    cur = p.get('k6', {}).get('current', {})
    rt = p.get('runtime', {})
    health = rt.get('health', {})
    pods = rt.get('top', [])
    cpu_max = max((pod.get('cpu','0m').replace('m','') for pod in pods), default='0')
    mem_max = max((pod.get('memory','0Mi').replace('Mi','') for pod in pods), default='0')
    rows.append({
        'poll': os.path.basename(f).replace('poll-','').replace('.json',''),
        'time': p.get('timestamp','?')[11:19],
        'vus': cur.get('vus',{}).get('value','—'),
        'msgPerSec': round(cur.get('throughputMsgPerSec',{}).get('value',0) or 0, 1),
        'p95': round(cur.get('p95LatencyMs',{}).get('value',0) or 0),
        'p99': round(cur.get('p99LatencyMs',{}).get('value',0) or 0),
        'errPct': round((cur.get('errorRate',{}).get('value',0) or 0)*100, 2),
        'cpu': cpu_max + 'm',
        'mem': mem_max + 'Mi',
        'heap': str(health.get('heapUsedMB','—')) + '/' + str(health.get('heapTotalMB','—')),
        'evLoop': health.get('eventLoop',{}).get('lagPeakMs','—'),
        'step': p.get('k6',{}).get('step',{}).get('stepIndex','?')
    })
print(f'Polls collected: {len(rows)}')
print('| # | Time | Step | VUs | Msg/s | p95 | p99 | Err% | CPU | Mem | Heap MB | EvLoop ms |')
print('|---|------|------|-----|-------|-----|-----|------|-----|-----|---------|-----------|')
for r in rows:
    print(f'| {r[\"poll\"]} | {r[\"time\"]} | {r[\"step\"]} | {r[\"vus\"]} | {r[\"msgPerSec\"]} | {r[\"p95\"]} | {r[\"p99\"]} | {r[\"errPct\"]} | {r[\"cpu\"]} | {r[\"mem\"]} | {r[\"heap\"]} | {r[\"evLoop\"]} |')
\"")
```

**RENDER AS RUNNING SCORECARD — the accumulating table:**

```
Running Scorecard — sat-<env>-<date> (Step 1/3, 25 VUs)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
| # | Time     | Step | VUs | Msg/s | p95  | p99  | Err% | CPU   | Mem     | Heap MB   | EvLoop ms |
|---|----------|------|-----|-------|------|------|------|-------|---------|-----------|-----------|
| 1 | 08:05:32 | 0    | 25  | 6.1   | 1114 | 1135 | 0.0  | 462m  | 1075Mi  | 680/729   | 112       |
| 2 | 08:05:52 | 0    | 25  | 7.2   | 1090 | 1096 | 0.0  | 488m  | 1053Mi  | 695/729   | 98        |
| 3 | 08:06:12 | 0    | 25  | 14.2  | 1106 | 1120 | 0.0  | 510m  | 1080Mi  | 701/729   | 105       |
...

Status: p95=1106ms (target 1500ms) ✓ | Err=0% ✓ | CPU 25% of limit ✓
```

**Monitoring cadence:**

- Check ONCE immediately after launch confirmation (Step 4)
- Then check again ONLY when:
  - User asks for an update
  - ~2-3 minutes have passed since last check (use judgment, NOT sleep)
  - The background process completes (notification)
- Each check reads ALL polls and re-renders the FULL scorecard table
- NEVER do `sleep N && read` — just `read` directly

**Why no sleep:** `sleep 60 && cat file` blocks Claude for 60 seconds, preventing user interaction. The file is already being written by the background script. Just read it — if it hasn't changed since last read, say "no new polls yet" and move on.

**Poll field paths for scorecard (verified against actual poll JSON):**

- VUs: `poll.k6.current.vus.value`
- Msg/s: `poll.k6.current.throughputMsgPerSec.value`
- p95: `poll.k6.current.p95LatencyMs.value`
- p99: `poll.k6.current.p99LatencyMs.value`
- Err%: `poll.k6.current.errorRate.value × 100` (API returns 0-1 rate)
- CPU: `poll.runtime.top[*].cpu` (from kubectl top, captured by cluster-poll.sh)
- Mem: `poll.runtime.top[*].memory`
- Heap: `poll.runtime.health.heapUsedMB` / `poll.runtime.health.heapTotalMB` (flat fields, NOT nested under `.heap`)
- EvLoop: `poll.runtime.health.eventLoop.lagPeakMs` (NOT `.peakMs`)
- GC: `poll.runtime.health.gc.maxPauseMs`
- Sessions: `poll.runtime.health.localCachedSessions` (flat field, NOT nested)
- Nodes: `poll.cluster.nodesTop[*]` (NOT top-level `poll.nodes`)
- Events: `poll.cluster.events[*]` (NOT top-level `poll.events`)

### Step 6: Script completes (background notification)

When notified:

1. **Verify exit artifacts exist**:

   ```bash
   ls <run_dir>/summary.json <run_dir>/steps.json
   ```

2. **Read summary.json**:

   ```bash
   Read(<run_dir>/summary.json)
   ```

   - Extract: status, pollsCollected, stepsCompleted, k6RunId

3. **Read early-stop.json** (if exists):

   ```bash
   Read(<run_dir>/early-stop.json)
   ```

   - Extract: reason, timestamp, signals

4. **Read steps.json**:

   ```bash
   Read(<run_dir>/steps.json)
   ```

   - VERIFY: each step has `startEpochMs` and `endEpochMs` (both > 0)
   - VERIFY: time windows are non-overlapping and sequential
   - Mark any step with `endEpochMs - startEpochMs < 60000` as TOO_SHORT (less than 1 minute of data)

5. **Read k6 run ID**:

   ```bash
   Read(<run_dir>/k6-run-id)
   ```

6. Proceed to Phase B.

---

## Phase B: Post-Run Analysis

**Polls are the PRIMARY data source.** They already contain most metrics captured in real-time by cluster-poll.sh. Only query Coroot for metrics polls DON'T have.

### What polls already capture (DO NOT re-query from Coroot):

| Metric                         | Poll field path (verified)                                                          | Source in cluster-poll.sh                                |
| ------------------------------ | ----------------------------------------------------------------------------------- | -------------------------------------------------------- |
| CPU usage per pod              | `poll.runtime.top[*].cpu`                                                           | `kubectl top pods` (every 20s)                           |
| Memory usage per pod           | `poll.runtime.top[*].memory`                                                        | `kubectl top pods` (every 20s)                           |
| CPU/Memory limits              | `poll.runtime.pods[*].resources.runtime.limits`                                     | `kubectl get pods -o json`                               |
| Heap used/total MB             | `poll.runtime.health.heapUsedMB` / `.heapTotalMB` (FLAT — not nested under `.heap`) | `curl /health` via port-forward                          |
| RSS memory MB                  | `poll.runtime.health.memoryUsageMB`                                                 | `curl /health` via port-forward                          |
| Event loop lag ms              | `poll.runtime.health.eventLoop.lagPeakMs` (NOT `.peakMs`)                           | `curl /health` via port-forward                          |
| GC max pause ms                | `poll.runtime.health.gc.maxPauseMs`                                                 | `curl /health` via port-forward                          |
| GC window max ms               | `poll.runtime.health.gc.windowMaxMs`                                                | `curl /health` via port-forward                          |
| Cached sessions                | `poll.runtime.health.localCachedSessions` (FLAT — not nested)                       | `curl /health` via port-forward                          |
| MongoDB CPU/Memory             | `poll.mongodb.top[*].cpu/memory`                                                    | `kubectl top pods`                                       |
| Redis CPU/Memory               | `poll.redis.top[*].cpu/memory`                                                      | `kubectl top pods`                                       |
| ClickHouse CPU/Memory          | `poll.clickhouse.top[*].cpu/memory`                                                 | `kubectl top pods`                                       |
| k6 VUs, msg/s, p95, p99, err%  | `poll.k6.current.<metric>.value`                                                    | k6 Cloud API                                             |
| k6 step metadata               | `poll.k6.step.stepIndex/stepVUs/phase/elapsedSeconds`                               | Computed from k6 start time                              |
| k6 completion state            | `poll.k6.completion.isTerminal/state`                                               | k6 Cloud API run status                                  |
| Pod phase, restarts, OOM       | `poll.runtime.pods[*].phase/restarts/oomKilled`                                     | `kubectl get pods -o json`                               |
| Pod waiting/terminated reasons | `poll.runtime.pods[*].waitingReasons/terminatedReasons`                             | `kubectl get pods -o json`                               |
| HPA state                      | `poll.runtime.hpa.*`                                                                | `kubectl get hpa -o json`                                |
| Deployment rollout state       | `poll.runtime.deployment.deployments[*]`                                            | `kubectl get deploy -o json`                             |
| Node CPU/memory                | `poll.cluster.nodesTop[*].cpu/memory/cpuPercent/memPercent`                         | `kubectl top nodes`                                      |
| Node info (pool, capacity)     | `poll.cluster.nodeInfo[*].pool/cpuCapacity/memCapacity`                             | `kubectl get nodes -o json`                              |
| Pending pods                   | `poll.cluster.pendingPods`                                                          | `kubectl get pods --field-selector=status.phase=Pending` |
| K8s events (OOM, scaling)      | `poll.cluster.events[*]`                                                            | `kubectl get events`                                     |
| Component events               | `poll.eventLedger.runtime/mongodb/redis/clickhouse`                                 | `kubectl get events` per component                       |
| Noisy neighbors                | `poll.noisyNeighbors.topByCpu[*]/topByMemory[*]`                                    | `kubectl top pods -A` on runtime nodes                   |

### What ONLY Coroot has (query these):

| Metric                                | Why polls don't have it                                                                      | Coroot call                |
| ------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------- |
| CPU throttle %                        | CFS throttle is eBPF-only; not in kubectl top or /health                                     | `get_app_pods`             |
| Server-side p50/p95/p99 latency       | Polls have k6 client-side latency (includes network); Coroot has server-side from traces     | `get_app_slo`              |
| Saturation signals (red/yellow/green) | Computed multi-dimension analysis with thresholds                                            | `get_benchmark_saturation` |
| Server-side error rate                | Polls have k6-observed errors; Coroot catches errors k6 never sees (e.g., upstream timeouts) | `get_app_slo`              |
| RPS from server perspective           | Polls have k6 throughput; Coroot has actual server-side request count                        | `get_app_slo`              |

**Note: Polls DO have node CPU/memory** (`cluster.nodesTop[*].cpuPercent`), so Coroot `get_nodes` is only needed if you want time-windowed averages vs the instant snapshot polls captured.

### Step B1: Aggregate poll data per step (PRIMARY — no network calls needed)

For each step window in `steps.json`, aggregate polls whose `epoch` falls within `[startEpochMs/1000, endEpochMs/1000]`:

```bash
Bash(command="python3 -c \"
import json, os, glob, statistics

steps = json.load(open('<run_dir>/steps.json'))
poll_dir = '<run_dir>/polls'
polls = []
for f in sorted(glob.glob(os.path.join(poll_dir, 'poll-*.json'))):
    with open(f) as fh:
        polls.append(json.load(fh))

for i, step in enumerate(steps):
    start = step['startEpochMs'] // 1000
    end = step['endEpochMs'] // 1000
    step_polls = [p for p in polls if start <= p['epoch'] <= end]
    if not step_polls:
        print(f'Step {i}: NO POLLS IN WINDOW')
        continue

    # k6 metrics
    vus = [p['k6']['current']['vus']['value'] for p in step_polls if p.get('k6',{}).get('current',{}).get('vus',{}).get('value')]
    msgs = [p['k6']['current']['throughputMsgPerSec']['value'] for p in step_polls if p.get('k6',{}).get('current',{}).get('throughputMsgPerSec',{}).get('value')]
    p95s = [p['k6']['current']['p95LatencyMs']['value'] for p in step_polls if p.get('k6',{}).get('current',{}).get('p95LatencyMs',{}).get('value')]
    errs = [(p['k6']['current']['errorRate']['value'] or 0)*100 for p in step_polls if p.get('k6',{}).get('current',{}).get('errorRate',{}).get('value') is not None]

    # Runtime resources (from kubectl top captured in polls)
    cpus = []
    mems = []
    for p in step_polls:
        for pod in p.get('runtime',{}).get('top',[]):
            cpus.append(int(pod.get('cpu','0m').replace('m','')))
            mems.append(int(pod.get('memory','0Mi').replace('Mi','')))

    # Runtime health (from /health endpoint captured in polls)
    # NOTE: health fields are FLAT — heapUsedMB, not heap.usedMB
    heaps = [p['runtime']['health']['heapUsedMB'] for p in step_polls if p.get('runtime',{}).get('health',{}).get('heapUsedMB')]
    evloops = [p['runtime']['health']['eventLoop']['lagPeakMs'] for p in step_polls if p.get('runtime',{}).get('health',{}).get('eventLoop',{}).get('lagPeakMs') is not None]
    gcs = [p['runtime']['health']['gc']['maxPauseMs'] for p in step_polls if p.get('runtime',{}).get('health',{}).get('gc',{}).get('maxPauseMs') is not None]

    # CPU limit from pod spec
    limits = p.get('runtime',{}).get('pods',[{}])[0].get('resources',{}).get('runtime',{}).get('limits',{})
    cpu_limit_m = int(limits.get('cpu','2').replace('m','')) if 'm' in limits.get('cpu','2') else int(limits.get('cpu','2'))*1000

    print(json.dumps({
        'step': i, 'vus': max(vus) if vus else None,
        'msgPerSec': round(statistics.median(msgs),1) if msgs else None,
        'p95_client': round(statistics.median(p95s)) if p95s else None,
        'errPct': round(max(errs),2) if errs else None,
        'cpuPeakM': max(cpus) if cpus else None,
        'cpuAvgM': round(statistics.mean(cpus)) if cpus else None,
        'cpuPctLimit': round((max(cpus)/cpu_limit_m)*100,1) if cpus else None,
        'memPeakMi': max(mems) if mems else None,
        'heapPeakMB': max(heaps) if heaps else None,
        'evLoopPeakMs': max(evloops) if evloops else None,
        'gcMaxMs': max(gcs) if gcs else None,
        'pollCount': len(step_polls)
    }))
\"")
```

### Step B2: Query Coroot ONLY for missing metrics

**Only after poll aggregation is done.** Query Coroot for the 3 things polls don't have:

```
environment = <env>
from = step.startEpochMs
to = step.endEpochMs
```

**Coroot queries per step (run in parallel):**

| #   | Tool       | Call                                                                                      | Data extracted                             | Why needed (polls don't have this)                              |
| --- | ---------- | ----------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------- |
| 1   | **Coroot** | `get_benchmark_saturation(from, to, environment, services=["runtime","mongodb","redis"])` | Red/yellow/green per dimension per service | Computed multi-dimension threshold analysis                     |
| 2   | **Coroot** | `get_app_pods("runtime", from, to, environment)`                                          | CFS throttle % per pod                     | eBPF cgroup metric — not in kubectl top or /health              |
| 3   | **Coroot** | `get_app_slo("runtime", from, to, environment)`                                           | Server-side p50/p95/p99, error rate, RPS   | From distributed traces — polls only have client-side k6 values |

**NOT needed from Coroot (polls already have):**

- ~~`get_app_cpu`~~ → polls have `runtime.top[*].cpu` per 20s
- ~~`get_app_memory`~~ → polls have `runtime.top[*].memory` per 20s
- ~~`get_app_nodejs`~~ → polls have `runtime.health.heap/eventLoop/gc` per 20s
- ~~`get_benchmark_metrics` for CPU/memory~~ → polls have per-pod usage

**If Coroot is unavailable**: Proceed with poll-only analysis. Mark throttle% as UNAVAILABLE. Use k6 client-side p95 (from polls) instead of server-side. Note in report that server-side latency was unavailable.

**If any Coroot query returns empty for a step**: Mark that specific metric as UNAVAILABLE. Do not guess.

### Step B3: Compute per-step metrics

For each step, combine poll data (primary) + Coroot (gap-fill):

| Metric             | Source                                                    | Field / Call                                                                | How               | Notes                                                                                       |
| ------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------- |
| VUs                | **Polls**                                                 | `poll.k6.current.vus.value`                                                 | Max               | Already captured every 20s                                                                  |
| Msg/s              | **Polls**                                                 | `poll.k6.current.throughputMsgPerSec.value`                                 | Median            | Already captured every 20s                                                                  |
| p95 (ms)           | **Coroot** `get_app_slo` (primary) / **Polls** (fallback) | Coroot: server-side; Polls: `p95LatencyMs.value`                            | Prefer Coroot     | Server-side excludes network jitter. Fall back to polls (client-side) if Coroot unavailable |
| p99 (ms)           | **Coroot** `get_app_slo` (primary) / **Polls** (fallback) | Same                                                                        | Prefer Coroot     | Same reasoning                                                                              |
| Err%               | **Coroot** `get_app_slo` (primary) / **Polls** (fallback) | Coroot: error_rate; Polls: `errorRate.value × 100`                          | Prefer Coroot     | Coroot catches server-side errors k6 may not see                                            |
| CPU % limit        | **Polls**                                                 | `runtime.top[*].cpu` ÷ `runtime.pods[*].resources.runtime.limits.cpu` × 100 | Peak across polls | 20s granularity from kubectl top — sufficient                                               |
| Throttle %         | **Coroot** `get_app_pods`                                 | CFS throttle %                                                              | Direct            | **Only Coroot has this** — eBPF cgroup metric                                               |
| Mem % limit        | **Polls**                                                 | `runtime.top[*].memory` ÷ memory limit × 100                                | Peak across polls | From kubectl top every 20s                                                                  |
| Heap MB            | **Polls**                                                 | `runtime.health.heapUsedMB` (flat field)                                    | Peak              | From /health endpoint every 20s                                                             |
| EvLoop ms          | **Polls**                                                 | `runtime.health.eventLoop.lagPeakMs`                                        | Max               | From /health endpoint every 20s                                                             |
| GC ms              | **Polls**                                                 | `runtime.health.gc.maxPauseMs`                                              | Max               | From /health endpoint every 20s                                                             |
| Mongo CPU          | **Polls**                                                 | `mongodb.top[*].cpu` ÷ mongo CPU limit × 100                                | Peak              | From kubectl top; limit from infra-snapshot.json                                            |
| Redis CPU          | **Polls**                                                 | `redis.top[*].cpu` ÷ redis CPU limit × 100                                  | Peak              | From kubectl top; limit from infra-snapshot.json                                            |
| Saturation signals | **Coroot** `get_benchmark_saturation`                     | red/yellow/green per dimension                                              | Direct            | **Only Coroot has this** — computed analysis                                                |

### Step B4: Compute efficiency

```
baseline_step = first step where p95 < p95_target AND err < 1%
if no baseline: all steps BREACH, efficiency = N/A

For each step:
  expected_msg_s = baseline_msg_s × (current_vus / baseline_vus)
  efficiency = (actual_msg_s / expected_msg_s) × 100
```

### Step B5: Assign decisions

| Decision  | Criteria (ALL must be true)                                                      |
| --------- | -------------------------------------------------------------------------------- |
| PROCEED   | p95 < target AND err < 1% AND efficiency > 90% AND all Coroot signals green      |
| WARN      | p95 < target AND err < 1% AND (efficiency 75-90% OR throttle > 20% OR mem > 85%) |
| SOFT_STOP | p95 between 90-100% of target AND err < 5% AND efficiency 50-75%                 |
| BREACH    | p95 > target OR err > 5% OR efficiency < 50% OR any Coroot signal RED            |

### Step B6: Determine saturation point

```
max_safe_step = last step with PROCEED or WARN decision
max_safe_vus = that step's VUs
max_safe_msg_s = that step's Msg/s / pin_replicas  (per pod)
```

If early-stopped: `early-stop.json` reason is the primary bottleneck.

### Step B7: Bottleneck attribution

Rank by severity (first one that triggers = primary bottleneck):

| Priority | Component              | Yellow     | Red         | Source                                         | How                                                       |
| -------- | ---------------------- | ---------- | ----------- | ---------------------------------------------- | --------------------------------------------------------- |
| 1        | Runtime CPU throttle   | > 15%      | > 25%       | **Coroot** `get_app_pods`                      | Only source (eBPF cgroup) — polls don't have this         |
| 2        | Runtime event loop lag | > 50ms avg | > 100ms avg | **Polls** `runtime.health.eventLoop.lagPeakMs` | Captured every 20s from /health endpoint                  |
| 3        | Runtime memory % limit | > 75%      | > 85%       | **Polls** `runtime.top[*].memory` ÷ mem limit  | Captured every 20s; limit from pod spec in poll           |
| 4        | GC pause               | > 100ms    | > 200ms     | **Polls** `runtime.health.gc.maxPauseMs`       | Captured every 20s from /health endpoint                  |
| 5        | MongoDB CPU            | > 50%      | > 70%       | **Polls** `mongodb.top[*].cpu` ÷ mongo limit   | Captured every 20s; limit from infra-snapshot.json        |
| 6        | Redis CPU              | > 50%      | > 70%       | **Polls** `redis.top[*].cpu` ÷ redis limit     | Captured every 20s; limit from infra-snapshot.json        |
| 7        | Node pressure          | CPU > 70%  | CPU > 85%   | **Polls** `cluster.nodesTop[*].cpuPercent`     | Polls capture node CPU% every 20s via `kubectl top nodes` |

---

## Phase C: Report

### Step C1: Verify report directory exists

```bash
ls -d benchmarks/docs/ || mkdir -p benchmarks/docs/
```

### Step C2: Check for prior reports (cross-run comparison)

```bash
Bash(command="ls benchmarks/docs/saturation-run-*.md 2>/dev/null | sort")
```

- Read most recent 1-2 prior reports for comparison table.

### Step C3: Write markdown report

Save to: `benchmarks/docs/saturation-run-<K6_RUN_ID>-<YYYY-MM-DD>.md`

Structure:

```markdown
# Saturation Run Report — <K6_RUN_ID>

**Date:** <date> | **Env:** <env> | **Status:** completed|early-stopped
**Config:** <replicas> pods, <steps> VUs, p95 target <N>ms, mock=<bool>
**Tier:** <tier> | **CPU:** <limit> | **Memory:** <limit>
**k6 Cloud:** https://app.k6.io/runs/<K6_RUN_ID>

## Pod Configuration

| Field                | Value                    |
| -------------------- | ------------------------ |
| Replicas (pinned)    | <N>                      |
| CPU request/limit    | <req>/<lim>              |
| Memory request/limit | <req>/<lim>              |
| Node pool            | <pool> (<instance-type>) |
| Image                | <image-tag>              |

(from kubectl pod spec at runtime, verified in poll artifact)

## Per-Step Results

| Step | VUs | Msg/s | p95 | p99 | Err% | CPU%Lim | Throt% | Mem%Lim | Heap MB | EvLoop ms | GC ms | MongoCPU% | RedisCPU% | Eff% | Decision |
| ---- | --- | ----- | --- | --- | ---- | ------- | ------ | ------- | ------- | --------- | ----- | --------- | --------- | ---- | -------- |

## Saturation Summary

- **Max Safe VUs:** <N>
- **Max Safe Msg/s (per pod):** <N>
- **Max Safe Msg/s (fleet):** <N>
- **Primary Bottleneck:** <component> (evidence: <metric>=<value>)
- **Efficiency at limit:** <N>%
- **p95 at saturation:** <N>ms (target: <N>ms)

## Bottleneck Analysis

<Narrative based on Coroot evidence — cite actual metric values>

## Data Sources

- Coroot environment: <env>
- Poll artifacts: <run_dir>/polls/ (<N> polls)
- k6 Cloud run: <K6_RUN_ID>
- Steps analyzed: <N> (any skipped: list with reason)

## Capacity Recommendation

<pods needed = target_throughput / max_safe_msg_s_per_pod>

## Cross-Run Comparison

| Run ID | Date | Env | Pods | CPU Limit | VU Steps | Max Safe VUs | Max Msg/s/pod | p95@Max | Bottleneck |
```

### Step C4: Verify report was written correctly

```bash
wc -l benchmarks/docs/saturation-run-<K6_RUN_ID>-<DATE>.md
# Verify it has content (> 30 lines expected)
```

### Step C5: Generate XLSX

```bash
python3 benchmarks/scripts/saturation-xlsx.py \
  --report benchmarks/docs/saturation-run-<RUN_ID>-<DATE>.md \
  --polls-dir <run_dir>/polls/ \
  --output benchmarks/docs/saturation-run-<RUN_ID>-<DATE>.xlsx
```

- VERIFY: output file exists and has non-zero size.

### Step C6: Generate sizing projection (optional)

Only if measurement JSON exists at `benchmarks/config/sizing/measurements/`:

```bash
python3 benchmarks/scripts/sizing-live-xlsx.py \
  --scenario <scenario-id> \
  --measurement benchmarks/config/sizing/measurements/<measurement-id>.json \
  --sat-report benchmarks/docs/saturation-run-<RUN_ID>-<DATE>.md \
  --target <target-msg-s> \
  --out benchmarks/docs/sizing-<scenario>-<DATE>.xlsx
```

---

## Phase D: Restore (MANDATORY — immediately after report)

1. **[ ] Collect inputs** from user (Section 1)
2. **[ ] Check for prior runs** — `ls -t benchmarks/docs/saturation-run-*.md` (Section 17)
3. **[ ] Pin replicas** in deploy repo (Step 1)
4. **[ ] Verify ArgoCD sync** and replica count
5. **[ ] Pre-flight poll** — health gate scorecard, extract baselines (Step 2)
6. **[ ] Launch k6** — single `cloud-run.sh` invocation, background (Step 3)
7. **[ ] Extract run ID** — wait 90s, then read output or ask user
8. **[ ] Launch poller** with step env vars in background (Step 4)
9. **[ ] Enter adaptive supervision loop** (Step 5)
10. **[ ] Display Running Scorecard** — one row per cycle, ALWAYS show full table (Step 5)
11. **[ ] Compute efficiency score** at each cycle (Section 7)
12. **[ ] Run bottleneck attribution** when efficiency < 90% (Section 9)
13. **[ ] At each step boundary** — full decision gate with decision template (Step 6)
14. **[ ] Display Cross-Step Comparison** after 2+ steps (Step 5)
15. **[ ] Run predictive model** after step 2+ (Section 10)
16. **[ ] PROCEED, WARN, or STOP** based on evidence + prediction
17. **[ ] After run** — query k6 API for all hold windows (Section 5)
18. **[ ] Query Coroot** including `get_app_nodejs` for event loop + GC (Section 5)
19. **[ ] Fetch error logs** if any step had errors (Section 12)
20. **[ ] Stop poller** and **revert deploy repo** immediately (Section 5)
21. **[ ] Compile full report** — Running Scorecard + Cross-Step + Saturation Summary + Capacity Rec (Section 15)
22. **[ ] Include cross-run comparison** if prior runs exist (Section 17)
23. **[ ] Save report** to `benchmarks/docs/saturation-run-<RUN_ID>-<DATE>.md` (Section 17)
24. **[ ] Ask user** if they want XLSX report (Section 21)
25. **[ ] Generate XLSX** if requested — `python3 benchmarks/scripts/saturation-xlsx.py ...` (Section 21)
26. **[ ] Confirm output** — print XLSX file path and size

---

## Rules

1. **VERIFY before acting** — Never assume a context, namespace, file, or resource exists. Check first.
2. **Launch the script ONCE** with `run_in_background=true`. Never re-run it.
3. **Never sleep** during monitoring. Read whatever artifacts exist.
4. **Infrastructure changes are ONLY via deploy repo** — never kubectl patch/scale (except emergency restore).
5. **Poll artifacts are the PRIMARY data source** for Phase B analysis — they already have CPU, memory, heap, event loop, GC, k6 metrics. Only query Coroot for what polls lack: throttle%, server-side latency, saturation signals.
6. **Never re-query Coroot for data polls already have** — polls capture kubectl top + /health + k6 API every 20s. Re-querying wastes API calls and risks Coroot ingestion gaps masking real data.
7. **If steps.json has missing windows**, mark those steps INCOMPLETE — do not fabricate data.
8. **Always check prior reports** for cross-run comparison before writing.
9. **Always restore after run** — even if analysis is deferred, restore immediately.
10. **Show actual values** in all output — never "OK" without the number. Always show what was measured.
11. **Record restore values at discovery time** (Step 0b/0c) — do not rely on memory across phases.
12. **Every kubectl command must specify `--context`** — never rely on current-context.
13. **Every Coroot query must use epoch milliseconds** from steps.json — never "last 5m" for analysis.
14. **errorRate from k6 API is 0-1** — always multiply by 100 before comparing to percentage thresholds.
15. **If a tool/command fails, show the raw error** — do not hide failures behind generic messages.
16. **Tool selection is deterministic** — follow this decision tree, never substitute:
    - "Does the k8s object spec/state answer this?" → **kubectl** (HPA spec, pod phase, deployment conditions, namespace, rollout)
    - "Do I need time-windowed metrics or computed analysis?" → **Coroot** (throttle%, latency percentiles, saturation signals, SLO, Node.js internals)
    - "Am I checking something ONLY available in Coroot?" → **Coroot** (event loop, GC, heap, CFS throttle, service health SLIs, cross-service dependency)
    - "Am I checking real-time state that just changed (<2min ago)?" → **kubectl** (Coroot has 2-3min ingestion lag)
    - "Am I verifying a mutation converged?" → **kubectl** first (spec matches desired), then **Coroot** after 2min (SLI confirms serving)
17. **Never use Coroot for real-time pod state** — its 2-3min lag means a crashed pod still shows healthy. Use kubectl for any go/no-go pod check.
18. **Never use kubectl for performance metrics** — `kubectl top` is a single-instant snapshot. Use Coroot for any metric that needs time-windowed aggregation (averages, peaks, percentiles).
19. **NEVER use `sleep` in monitoring** — `Bash(sleep 60 && cat file)` blocks Claude for 60s, preventing user interaction. The background script writes polls every ~20s independently. Just `Read(file)` or `Bash(cat file)` directly. If no new data: say "no new polls" and move on.
20. **Running Scorecard is an accumulating TABLE** — every monitoring check reads ALL polls collected so far and renders the full markdown table. Never dump one-line summaries. The user must see the progression at a glance (VUs, msg/s, p95, err%, CPU, mem, heap, event loop — per poll row).

---

## Quick Start Examples

- Deploy pinning not confirmed: stop before k6.
- Pre-flight poll unhealthy: stop and diagnose.
- k6 metrics incomplete: mark step incomplete, do not interpolate.
- k6 telemetry lost: cluster-only mode (Section 6). Never PROCEED without k6 data.
- MongoDB/Redis is limiter: stop at recommendation. Do not change StatefulSets.
- Benchmark launched twice: tell user which run you are analyzing.
- Poller dies: fall back to manual kubectl at step boundaries, note reduced observability.
- Predictions conflict with observations: trust observations, lower prediction confidence.

---

## 21. XLSX Report Generation (Optional)

When the user opts in to XLSX generation (see Section 1), produce a
professional spreadsheet summarizing all performance metrics and results.

### When to Generate

- Only when the user explicitly says **yes** to the XLSX prompt.
- Only AFTER the Markdown report has been saved successfully.
- The XLSX is a companion artifact — the Markdown report remains the
  authoritative record.

### How to Generate

```bash
python3 benchmarks/scripts/saturation-xlsx.py \
  --report benchmarks/docs/saturation-run-<RUN_ID>-<DATE>.md \
  --polls-dir benchmarks/results/polls/<RUN_ID>/ \
  --output benchmarks/docs/saturation-run-<RUN_ID>-<DATE>.xlsx
```

If `openpyxl` is not installed: `pip3 install openpyxl --quiet`

### XLSX Workbook Sheets

| Sheet                    | Content                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| **Summary**              | Run metadata, max safe throughput, primary bottleneck, capacity recommendation              |
| **Per-VU Results**       | One row per VU step with all metrics (msg/s, latency, CPU, datastore, efficiency, decision) |
| **Running Scorecard**    | Full poll-by-poll table from supervision loop                                               |
| **Saturation Summary**   | Component status table (RED/YELLOW/GREEN per component)                                     |
| **Thresholds Reference** | Static reference thresholds from Section 16                                                 |
| **Cross-Run Comparison** | Delta table vs prior runs (if prior runs exist)                                             |
| **Charts**               | Throughput, Latency, CPU, Efficiency, and Datastore Load vs VUs                             |

### Charts

1. **Throughput vs VUs** — line, msg/s avg + peak
2. **Latency vs VUs** — line, p95 + p99, horizontal line at p95 target
3. **CPU vs VUs** — line, CPU avg + % of limit, horizontal line at 75%
4. **Efficiency vs VUs** — bar, color-coded by band
5. **Datastore Load vs VUs** — line, Mongo ops/s + Redis ops/s

### Formatting

- Bold frozen header row, conditional formatting on key metrics
- p95: green < 80% target, yellow 80-100%, red > target
- Efficiency: green ≥ 90%, yellow 75-90%, red < 75%
- Decision column: green PROCEED, yellow WARN, red STOP
- Auto-fit column widths, colored sheet tabs

### Error Handling

- Markdown parse failure: skip XLSX, do not block the run
- Missing poll JSONs: omit Running Scorecard sheet, note in Summary
- No openpyxl: print install instruction and skip

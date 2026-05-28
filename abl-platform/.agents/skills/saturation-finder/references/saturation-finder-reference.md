# Saturation Finder Reference

Load this when you need exact Coroot MCP query patterns, poll artifact schema,
status.json schema, report table templates, or threshold details.

## Coroot MCP Query Patterns

### Parameter Types (verified 2026-05-06)

| Tool family                | `from`/`to` type   | Accepts                                                        |
| -------------------------- | ------------------ | -------------------------------------------------------------- |
| `get_benchmark_metrics`    | `string \| number` | **Epoch ms ONLY.** Relative strings like `"30m"` are REJECTED. |
| `get_benchmark_saturation` | `string \| number` | **Epoch ms ONLY.** Same restriction.                           |
| `get_app_*`                | `string`           | Epoch ms as string, OR relative: `"30m"`, `"1h"`, `"6h"`       |
| `get_mongodb_metrics`      | `string`           | Same as `get_app_*`                                            |
| `get_redis_metrics`        | `string`           | Same as `get_app_*`                                            |
| `get_nodes`                | (no time params)   | Environment only                                               |

All tools accept `environment=<"dev"|"qa"|"staging">` (default: `"dev"`).

For saturation analysis, pass epoch ms from `steps.json`:

- Benchmark tools: `from=1777968000000, to=1777968300000` (number)
- App tools: `from="1777968000000", to="1777968300000"` (string)

### Benchmark-Wide (All Services)

```
mcp__coroot__get_benchmark_metrics(
  from=<startEpochMs>,
  to=<endEpochMs>,
  environment=<"dev"|"qa"|"staging">,
  services=["runtime", "mongodb", "redis", "clickhouse"]
)
→ Returns: CPU avg/peak, memory avg/peak, RPS, error rate, connections,
  Node.js runtime metrics, and storage metrics per service

mcp__coroot__get_benchmark_saturation(
  from=<startEpochMs>,
  to=<endEpochMs>,
  environment=<"dev"|"qa"|"staging">,
  services=["runtime", "mongodb", "redis", "clickhouse"]
)
→ Returns: red/yellow/green per service per dimension
  (CPU, throttle, memory, event loop, errors, restarts, network, disk)
```

### Runtime Deep Dive

```
mcp__coroot__get_app_cpu(
  app="runtime",
  from="<startEpochMs>",
  to="<endEpochMs>",
  environment=<env>
)
→ Returns:
  cpu.usagePeak, cpu.usageAvg          — e.g., "69m", "32m"
  cpu.delayPeak, cpu.delayAvg          — e.g., "6.3ms/s", "1.1ms/s"
  cpu.throttledPeak, cpu.throttledAvg  — e.g., "5.1ms/s", "0.1ms/s"
  cpu.requestPeak, cpu.limitPeak       — often null (not always populated)
  cpu.perPod[]                         — same fields per pod
  cpu.topNodeConsumers[]               — noisy-neighbor data

mcp__coroot__get_app_nodejs(
  app="runtime",
  from="<startEpochMs>",
  to="<endEpochMs>",
  environment=<env>
)
→ Returns:
  nodejs.eventLoopLagAvg    — e.g., "20.8ms" (string with unit)
  nodejs.eventLoopLagPeak   — e.g., "22.9ms"
  nodejs.gcPauseAvg         — may be null if no GC data
  nodejs.gcPausePeak        — may be null
  nodejs.heapUsedPeak       — may be null
  nodejs.heapUsedAvg        — may be null
  nodejs.activeHandles      — may be null
  NOTE: Many fields can be null if instrumentation data is sparse.

mcp__coroot__get_app_memory(
  app="runtime",
  from="<startEpochMs>",
  to="<endEpochMs>",
  environment=<env>
)
→ Returns: RSS peak/avg, working set, OOM kills, pressure, perPodRss[]

mcp__coroot__get_app_pods(
  app="runtime",
  from="<startEpochMs>",
  to="<endEpochMs>",
  environment=<env>
)
→ Returns: per-pod CPU (usage, % of limit), throttle%, memory (RSS, working set, % limit), node, status

mcp__coroot__get_app_slo(
  app="runtime",
  from="<startEpochMs>",
  to="<endEpochMs>",
  environment=<env>
)
→ Returns: requests/sec, errors/sec, error rate, p50/p95/p99 latency
  NOTE: This is Coroot-observed HTTP latency, NOT k6 chat_turn_latency.
  Use k6 API for authoritative msg/s and p95. Use this for cross-check only.
```

### Datastore Deep Dive (when saturation signal is yellow/red)

These return comprehensive data — not just the metric named in the tool.

```
mcp__coroot__get_mongodb_metrics(
  from="<startEpochMs>",
  to="<endEpochMs>",
  environment=<env>
)
→ Returns a RICH object with ALL of:
  health.overallStatus       — "green"/"yellow"/"red" + checks[]
  cpu.usagePeak/Avg          — per-pod and aggregate
  cpu.delayPeak/Avg, throttledPeak/Avg
  cpu.perPod[]               — per-pod breakdown
  memory.usagePeak/Avg, rssPeak, oomKills, perPodRss[]
  network.activeTcpConnections, tcpLatencyAvgMs
  storage.iopsWrite/iopsWritePeak/iopsWriteP95  — CRITICAL for disk saturation
  storage.latencyWriteMs/latencyWritePeakMs     — write path health
  storage.ioUtilizationAvg/Peak                 — % of disk capacity
  storage.ioUtilizationPerVolume[]              — per-volume breakdown
  storage.ioLoadAvg/Peak                        — total I/O load (ms/s)
  database.operationsPerSecond.avg, connections.avg/peak

  IOPS CEILING: Use MONGO_IOPS_CEILING derived from PVC storage class + size
  (fetched in Phase 1). iopsWrite > 90% of ceiling = approaching saturation.
  See Azure Disk Tier IOPS Reference table below for lookup.

mcp__coroot__get_redis_metrics(
  from="<startEpochMs>",
  to="<endEpochMs>",
  environment=<env>
)
→ Returns same rich structure as mongodb_metrics:
  health, cpu (perPod), memory (perPodRss), network, storage, database, checks

mcp__coroot__get_clickhouse_metrics(
  from="<startEpochMs>",
  to="<endEpochMs>",
  environment=<env>
)
→ Returns same structure as mongodb_metrics BUT:
  storage fields are often ALL NULL — Coroot doesn't instrument ClickHouse
  disk I/O the same way. Fall back to ClickHouse's own system tables or
  node-level metrics if disk saturation is suspected.
  database.operationsPerSecond.avg — typically very low (< 5 ops/s)

mcp__coroot__get_app_cpu(app="mongodb"|"redis"|"clickhouse", from, to, environment)
→ Returns: same cpu structure as runtime — perPod, delay, throttle

mcp__coroot__get_app_memory(app="mongodb"|"redis"|"clickhouse", from, to, environment)
→ Returns: per-pod RSS, working set, OOM kills, pressure
```

### Node / Dependency (when investigating noisy neighbors)

```
mcp__coroot__get_nodes(environment=<env>)
→ No time params. Returns:
  count, summary.byPool, summary.byZone, summary.unhealthyCount
  summary.hotspots.cpu[], summary.hotspots.memory[]
  nodes[]: name, instanceType, pool, availabilityZone, cloudProvider,
           compute ("8 vCPU / 33GB"), cpu.usagePercent, memory.usagePercent,
           ips[], uptimeMs, status.status/message
  NOTE: pool field may show "default" instead of actual pool name.

mcp__coroot__get_app_dependencies(app="runtime", from, to, environment)
→ Returns: upstream/downstream services with latency
```

## status.json Schema

Written by `saturation-runner.sh` every poll cycle. Phase 4 reads this for the
running scorecard.

```json
{
  "phase": "running",
  "message": "poll=5 VUs=25 p95=1120ms err=0%",
  "timestamp": 1777968000000,
  "timestampIso": "2026-05-05T12:00:00Z",
  "runLabel": "sat-qa-20260505-1200",
  "runDir": "benchmarks/results/runs/sat-qa-20260505-1200",
  "k6RunId": "7456464",
  "environment": "qa",
  "currentStep": 1,
  "totalSteps": 3,
  "currentVu": 30,
  "pollCount": 5,
  "consecutiveErr": 0,
  "consecutiveP95": 0,
  "latestMetrics": {
    "vus": 25,
    "msgPerSec": 6.1,
    "p95": 1120,
    "p99": 1280,
    "errRate": 0
  }
}
```

**Phase values:** `"preflight"`, `"safety-gate"`, `"polling"`, `"running"`,
`"early-stopped"`, `"finished"`.

**Termination:** Phase 4 stops when `phase` is `"finished"` or `"early-stopped"`,
or when `$RUN_DIR/summary.json` exists.

## Poll Artifact Schema

Each `poll-NNNN.json` from cluster-poll.sh (verified against actual output):

```json
{
  "pollNumber": 1,
  "timestamp": "2026-05-04T16:15:52Z",
  "epoch": 1777911352,
  "runId": "sat-qa-20260504-2137",
  "k6RunId": "7450314",
  "runtime": {
    "label": "app.kubernetes.io/component=runtime",
    "top": [{"pod": "...", "cpu": "78m", "memory": "925Mi"}],
    "pods": [{
      "pod": "...",
      "phase": "Running",
      "ready": true,
      "restarts": 0,
      "oomKilled": false,
      "waitingReasons": [],
      "terminatedReasons": [],
      "node": "aks-...",
      "usage": {"cpu": "78m", "memory": "925Mi"},
      "resources": {
        "runtime": {"requests": {"cpu": "1", "memory": "1Gi"}, "limits": {"cpu": "2", "memory": "2Gi"}}
      }
    }],
    "hpa": {
      "minReplicas": 2, "maxReplicas": 2,
      "currentReplicas": 2, "desiredReplicas": 2,
      "currentMetrics": [{"name": "cpu", "currentUtilization": 6}],
      "targets": [{"name": "cpu", "targetUtilization": 70}],
      "behavior": {"scaleUp": {}, "scaleDown": {}},
      "conditions": [{"type": "AbleToScale", "status": "True", "reason": "...", "message": "..."}]
    },
    "deployment": {
      "deployments": [{
        "name": "abl-platform-qa-runtime",
        "specReplicas": 2,
        "statusReplicas": 2,
        "readyReplicas": 2,
        "availableReplicas": 2,
        "updatedReplicas": 2,
        "unavailableReplicas": null,
        "conditions": [{"type": "Available", "status": "True", "reason": "MinimumReplicasAvailable"}]
      }]
    },
    "health": {
      "source": "kubectl-port-forward-runtime-health",
      "pod": "abl-platform-qa-runtime-77b8bf4c7c-lxnfz",
      "status": "healthy",
      "uptime": 1787.97,
      "database": "connected (mongo)",
      "redis": "connected",
      "clickhouse": "connected",
      "localCachedSessions": 1693,
      "memoryUsageMB": 1017,
      "heapUsedMB": 742,
      "heapTotalMB": 854,
      "externalMB": 37,
      "arrayBuffersMB": 29,
      "gc": {
        "windowCount": 1,
        "windowPauseMs": 2,
        "windowMaxMs": 2,
        "windowDurationSec": 0,
        "totalCount": 6192,
        "totalPauseMs": 17207,
        "maxPauseMs": 45,
        "byType": {"unknown": {"count": 6150, "totalMs": 16315, "maxMs": 25}, "major": {"count": 42, "totalMs": 892, "maxMs": 45}}
      },
      "eventLoop": {
        "lagMs": 0,
        "lagPeakMs": 55,
        "windowPeakMs": 0
      }
    }
  },
  "mongodb": {"label": "...", "top": [...], "pods": [...]},
  "redis": {"label": "...", "top": [...], "pods": [...]},
  "kafka": {"disabled": true},
  "clickhouse": {"label": "...", "top": [...], "pods": [...]},
  "opensearch": {"disabled": true},
  "neo4j": {"disabled": true},
  "ingress": {"disabled": true},
  "cluster": {
    "nodesTop": [{"node": "aks-...", "cpu": "2100m", "cpuPercent": "52%", "memory": "12Gi", "memPercent": "75%"}],
    "nodeInfo": [{"node": "aks-...", "pool": "userpool", "cpuCapacity": "4", "memCapacity": "16Gi"}],
    "pendingPods": [],
    "pdb": [...],
    "events": [{"reason": "ScalingReplicaSet", "message": "...", "object": "...", "type": "Normal"}],
    "errors": []
  },
  "eventLedger": {
    "runtime": {"component": "runtime", "events": [...]},
    "mongodb": {"component": "mongodb", "events": [...]},
    "redis": {"component": "redis", "events": [...]},
    "clickhouse": {"component": "clickhouse", "events": [...]}
  },
  "noisyNeighbors": {
    "runtimeLabel": "...",
    "runtimePodNodes": {"pod-name": "node-name"},
    "topByCpu": [{"namespace": "...", "pod": "...", "node": "...", "cpu": "500m", "cpuMillis": 500, "isRuntime": false}],
    "topByMemory": [...]
  },
  "coroot": {
    "timestamp": "2026-05-05T12:00:00Z",
    "environment": "qa",
    "timeWindow": {"fromMs": 1777968000000, "toMs": 1777968120000},
    "runtime": {
      "cpu": {
        "usage": {"avg": 0.063, "peak": 0.064, "perPod": [...]},
        "usageAvgMilli": 63, "usagePeakMilli": 64,
        "delay": {"avg": 0.003, "peak": 0.005, "perPod": [...]},
        "throttle": {"avg": 0.0, "peak": 0, "perPod": [...]}
      },
      "nodejs": {
        "available": true,
        "eventLoopBlockedAvg": 0.02,
        "eventLoopBlockedPeak": 0.021,
        "eventLoopBlockedAvgMs": 20.0,
        "eventLoopBlockedPeakMs": 21.0,
        "perPod": [{"name": "pod-name", "avg": 0.02, "max": 0.021, "n": 15}]
      },
      "memory": {
        "available": true,
        "rssAvgMi": 1585, "rssPeakMi": 838,
        "perPod": [{"name": "pod-name", "avg": 834547153, "max": 838012900, "n": 15}]
      }
    },
    "mongodb": {
      "cpu": {"usageAvgMilli": 94, "usagePeakMilli": 134, "...": "same structure as runtime"},
      "storage": {
        "available": true,
        "iopsWriteAvg": 6.2, "iopsWritePeak": 14.6,
        "iopsReadAvg": 0.0, "iopsReadPeak": 0,
        "ioLatencyAvgMs": 76.06, "ioLatencyPeakMs": 160.63,
        "ioUtilizationAvg": 0.8, "ioUtilizationPeak": 1.4,
        "ioLoadAvg": 1206.2, "ioLoadPeak": 2826.6
      }
    },
    "redis": {
      "cpu": {"usageAvgMilli": 87, "usagePeakMilli": 24, "...": "same structure"}
    },
    "clickhouse": {
      "cpu": {"usageAvgMilli": 86, "...": "same structure"},
      "storage": {"available": false}
    },
    "errors": []
  },
  "k6": {
    "run": {"resultStatus": 0, "runStatus": 2, "started": "2026-05-05T...", "ended": null},
    "completion": {"isTerminal": false, "state": "running", "runStatus": 2, "resultStatus": 0},
    "metricWindow": {"start": "...", "end": "...", "stepSeconds": 20},
    "step": {"stepIndex": 0, "stepVUs": 25, "phase": "hold", "elapsedSeconds": 120},
    "current": {
      "vus": {"timestamp": 1777968000, "value": 25},
      "throughputMsgPerSec": {"timestamp": 1777968000, "value": 6.1},
      "attemptedMsgPerSec": {"timestamp": 1777968000, "value": 6.5},
      "errorRate": {"timestamp": 1777968000, "value": 0},
      "p95LatencyMs": {"timestamp": 1777968000, "value": 1114},
      "p99LatencyMs": {"timestamp": 1777968000, "value": 1135}
    },
    "dataAvailable": true
  }
}
```

### Key k6 fields in polls

The `k6` object in each poll uses nested `current.<metric>.value` structure:

| Field                                  | Type        | Description                                             |
| -------------------------------------- | ----------- | ------------------------------------------------------- |
| `k6.current.vus.value`                 | number      | Current active VUs                                      |
| `k6.current.throughputMsgPerSec.value` | number      | Successful messages/sec (recent window)                 |
| `k6.current.attemptedMsgPerSec.value`  | number      | Attempted messages/sec (including failures)             |
| `k6.current.p95LatencyMs.value`        | number      | p95 latency ms                                          |
| `k6.current.p99LatencyMs.value`        | number      | p99 latency ms                                          |
| `k6.current.errorRate.value`           | number      | Error rate as 0-1 (NOT percentage)                      |
| `k6.completion.isTerminal`             | bool        | Whether k6 run has finished                             |
| `k6.completion.state`                  | string      | "running", "finished", "aborted_or_timed_out", "failed" |
| `k6.completion.runStatus`              | number      | k6 API run_status (2=running, 3=finished, 4-7=aborted)  |
| `k6.completion.resultStatus`           | number      | k6 API result_status (0=running, 1=passed, 2-3=failed)  |
| `k6.step.stepIndex`                    | number      | Current step index (0-based)                            |
| `k6.step.stepVUs`                      | number      | Configured VUs for current step                         |
| `k6.step.phase`                        | string      | "ramp", "hold", or "after_configured_steps"             |
| `k6.step.elapsedSeconds`               | number      | Seconds since k6 started                                |
| `k6.dataAvailable`                     | bool        | Whether k6 API returned data                            |
| `k6.run.started`                       | string      | ISO timestamp when k6 run began                         |
| `k6.run.ended`                         | string/null | ISO timestamp when k6 run ended (null if running)       |
| `k6.metricWindow.start`                | string      | ISO start of metric query window                        |
| `k6.metricWindow.end`                  | string      | ISO end of metric query window                          |

### Key health fields in polls

The `runtime.health` object has FLAT fields (not nested):

| Field                                   | Type   | Description                             |
| --------------------------------------- | ------ | --------------------------------------- |
| `runtime.health.status`                 | string | "healthy" or error                      |
| `runtime.health.heapUsedMB`             | number | V8 heap used (MB) — NOT `heap.usedMB`   |
| `runtime.health.heapTotalMB`            | number | V8 heap total (MB) — NOT `heap.totalMB` |
| `runtime.health.memoryUsageMB`          | number | Process RSS (MB)                        |
| `runtime.health.localCachedSessions`    | number | Cached sessions count                   |
| `runtime.health.eventLoop.lagMs`        | number | Current event loop lag                  |
| `runtime.health.eventLoop.lagPeakMs`    | number | Peak event loop lag — NOT `.peakMs`     |
| `runtime.health.eventLoop.windowPeakMs` | number | Window peak event loop lag              |
| `runtime.health.gc.maxPauseMs`          | number | Max GC pause (ms) — lifetime            |
| `runtime.health.gc.windowMaxMs`         | number | Max GC pause in recent window           |
| `runtime.health.gc.totalPauseMs`        | number | Total GC pause time (ms)                |
| `runtime.health.gc.totalCount`          | number | Total GC events                         |
| `runtime.health.gc.byType`              | object | GC pauses by type (unknown, major)      |

### Key cluster fields in polls

Node and event data is under `poll.cluster`, NOT top-level:

| Field                             | Type   | Description                                 |
| --------------------------------- | ------ | ------------------------------------------- |
| `cluster.nodesTop[*].node`        | string | Node name                                   |
| `cluster.nodesTop[*].cpu`         | string | CPU usage (e.g., "2100m")                   |
| `cluster.nodesTop[*].cpuPercent`  | string | CPU usage % (e.g., "52%")                   |
| `cluster.nodesTop[*].memory`      | string | Memory usage                                |
| `cluster.nodesTop[*].memPercent`  | string | Memory usage %                              |
| `cluster.nodeInfo[*].pool`        | string | Node pool label                             |
| `cluster.nodeInfo[*].cpuCapacity` | string | Total CPU cores                             |
| `cluster.pendingPods`             | array  | Pods stuck in Pending                       |
| `cluster.events`                  | array  | Interesting k8s events (OOM, scaling, etc.) |

## Run Directory Schema

```
benchmarks/results/runs/<RUN_LABEL>/
├── config.json        ← all inputs + derived values (written at start)
├── steps.json         ← [{step, vu, startEpochMs, endEpochMs, stopReason?}]
│                        step = 0-based index, vu = VU count for that step
├── status.json        ← live status (see status.json schema above)
├── runner.log         ← all stdout/stderr from saturation-runner.sh
├── polls/             ← symlink to benchmarks/results/polls/<RUN_LABEL>/
├── k6-run-id          ← k6 Cloud run ID (plain text, written when available)
├── k6-launch.log      ← k6 cloud-run.sh stdout/stderr
├── early-stop.json    ← {reason, timestamp, timestampIso, signals} (if early-stopped)
└── summary.json       ← final {runLabel, k6RunId, environment, status, stopReason,
                           exitCode, pollsCollected, stepsCompleted, totalSteps,
                           finishedAt, finishedAtIso}
```

## Threshold Tables

### Early-Stop (saturation-runner.sh, deterministic)

These are enforced by the script. Claude does NOT make these decisions.

| Condition   | Threshold    | Polls Required |
| ----------- | ------------ | -------------- |
| OOM killed  | Any pod      | 1 (immediate)  |
| Pod restart | restarts > 0 | 1 (immediate)  |
| Error rate  | > 30%        | 2 consecutive  |
| p95 breach  | > 2× target  | 2 consecutive  |
| Max runtime | total + 5min | 1 (timeout)    |

### Analysis Decisions (Phase 6, per-step classification for report)

These are applied by Claude in Phase 6 after the run completes. NOT live decisions.

| Decision | p95 vs target | Error % | Efficiency | Resource                    |
| -------- | ------------- | ------- | ---------- | --------------------------- |
| PROCEED  | < 100%        | < 1%    | >= 90%     | All green                   |
| WARN     | < 100%        | < 1%    | 75-90%     | Throttle > 20% or mem > 85% |
| STOP     | 90-110%       | 1-5%    | 50-75%     | Yellow signals              |
| BREACH   | > 110%        | > 5%    | < 50%      | Red signals                 |

### Bottleneck Attribution Thresholds

Walk top-to-bottom. First credible match is primary bottleneck.

| Priority | Component              | Yellow     | Red         | Source                          |
| -------- | ---------------------- | ---------- | ----------- | ------------------------------- |
| 1        | Runtime CPU throttle   | > 15%      | > 25%       | Coroot get_app_cpu              |
| 2        | Runtime CPU % limit    | > 70%      | > 85%       | Coroot get_app_cpu              |
| 3        | Runtime event loop     | > 50ms avg | > 100ms avg | Coroot get_app_nodejs           |
| 4        | Runtime memory % limit | > 75%      | > 85%       | Coroot get_app_memory           |
| 5        | GC pause               | > 100ms    | > 200ms     | Coroot get_app_nodejs           |
| 6        | MongoDB CPU            | > 50%      | > 70%       | Coroot get_mongodb_metrics      |
| 7        | MongoDB IOPS           | > 60% ceil | > 90% ceil  | Coroot storage.iopsWrite        |
| 8        | MongoDB write latency  | > 10ms     | > 50ms      | Coroot storage.latencyWriteMs   |
| 9        | MongoDB IO utilization | > 50%      | > 80%       | Coroot storage.ioUtilizationAvg |
| 10       | Redis CPU              | > 50%      | > 70%       | Coroot get_redis_metrics        |
| 11       | Node CPU               | > 70%      | > 85%       | Coroot or poll cluster.nodesTop |

Note: ClickHouse storage IOPS are not instrumented by Coroot (all null).
If ClickHouse disk saturation is suspected, query ClickHouse system tables directly.

## Report Table Templates

### Per-Step Results (§4 in report)

```markdown
| Step | VUs | Msg/s | p95 | p99 | Err% | CPU%Lim | Throt% | Mem%Lim | Heap MB | EvLoop ms | GC ms | MongoCPU | RedisCPU | Eff% | Decision |
| ---- | --- | ----- | --- | --- | ---- | ------- | ------ | ------- | ------- | --------- | ----- | -------- | -------- | ---- | -------- |
```

Sources: Msg/s, p95, p99, Err% from k6 Cloud API. CPU%Lim, Throt%, EvLoop, GC
from Coroot. Heap from poll JSON. MongoCPU, RedisCPU from Coroot. Eff% computed.

### Cross-Step Comparison (§3 in report)

Extended version with trends and bottleneck attribution:

```markdown
| Step | VUs | Msg/s Avg | Msg/s Peak | p95 Avg | p99 Avg | CPU Avg | CPU%Lim | Heap End | Ev Loop | GC  | Mongo CPU | Redis CPU | Efficiency | Eff Delta | Trend | Bottleneck | Decision |
| ---- | --- | --------- | ---------- | ------- | ------- | ------- | ------- | -------- | ------- | --- | --------- | --------- | ---------- | --------- | ----- | ---------- | -------- |
```

### Cross-Run Comparison (§8 in report)

```markdown
| Run ID | Date | Env | Pods | VU Steps | Max Safe VUs | Max Msg/s | p95@Max | Bottleneck | Key Diff |
| ------ | ---- | --- | ---- | -------- | ------------ | --------- | ------- | ---------- | -------- |
```

### Running Scorecard (Phase 4, §2 in report)

```markdown
| #   | Time | Phase | VUs | Msg/s | Err% | p95 | CPU | CPU%Lim | Heap | MongoCPU | RedisCPU | Status |
| --- | ---- | ----- | --- | ----- | ---- | --- | --- | ------- | ---- | -------- | -------- | ------ |
```

Sources: #, Time, Phase, VUs, Msg/s, Err%, p95 from status.json. CPU, CPU%Lim,
Heap, MongoCPU, RedisCPU from latest poll JSON.

## Azure Disk Tier IOPS Reference

Use this table to derive MONGO_IOPS_CEILING from the PVC storage class and size
fetched in Phase 1. Match storage class → disk family, then match PVC size to tier.

### How to fetch from cluster

```bash
kubectl --context aks-abl-<ENV>-centralus -n abl-platform-<ENV> \
  get pvc -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.storageClassName}{"\t"}{.status.capacity.storage}{"\n"}{end}' \
  | grep mongodb
```

Pick `data-volume-*-mongodb-*` PVCs. The storage class maps to a disk family:

| Storage Class           | Disk Family      |
| ----------------------- | ---------------- |
| `default`               | Standard SSD (E) |
| `managed-csi`           | Standard SSD (E) |
| `managed-csi-premium`   | Premium SSD (P)  |
| `managed-csi-premiumv2` | Premium SSD v2   |

### Standard SSD (E series) — `default` / `managed-csi`

| Tier | Size (GiB) | Baseline IOPS | Burst IOPS | Throughput (MBps) | Burst Throughput (MBps) |
| ---- | ---------- | ------------- | ---------- | ----------------- | ----------------------- |
| E4   | 32         | 500           | 600        | 100               | 150                     |
| E6   | 64         | 500           | 600        | 100               | 150                     |
| E10  | 128        | 500           | 600        | 100               | 150                     |
| E15  | 256        | 500           | 600        | 100               | 150                     |
| E20  | 512        | 500           | 600        | 100               | 150                     |
| E30  | 1024       | 500           | 1000       | 100               | 250                     |

### Premium SSD (P series) — `managed-csi-premium`

| Tier | Size (GiB) | Baseline IOPS | Burst IOPS | Throughput (MBps) | Burst Throughput (MBps) |
| ---- | ---------- | ------------- | ---------- | ----------------- | ----------------------- |
| P4   | 32         | 120           | 3500       | 25                | 170                     |
| P6   | 64         | 240           | 3500       | 50                | 170                     |
| P10  | 128        | 500           | 3500       | 100               | 170                     |
| P15  | 256        | 1100          | 3500       | 125               | 170                     |
| P20  | 512        | 2300          | 3500       | 150               | 170                     |
| P30  | 1024       | 5000          | 30000      | 200               | 1000                    |
| P40  | 2048       | 7500          | 30000      | 250               | 1000                    |
| P50  | 4096       | 7500          | 30000      | 250               | 1000                    |

### Premium SSD v2 — `managed-csi-premiumv2`

No fixed tiers. Baseline 3000 IOPS free, +500 IOPS per GiB above 6 GiB, max 80000.
Use 3000 as MONGO_IOPS_CEILING unless provisioned IOPS are known.

### Tier Selection Rule

Match PVC size to the **smallest tier whose size >= PVC size**:

- 256Gi PVC + `managed-csi-premium` → P15 (256 GiB) → baseline 1100, burst 3500
- 20Gi PVC + `default` → E4 (32 GiB) → baseline 500, burst 600
- 512Gi PVC + `managed-csi-premium` → P20 (512 GiB) → baseline 2300, burst 3500

Set:

- `MONGO_IOPS_CEILING = baseline IOPS` (conservative, sustained-load ceiling)
- `MONGO_IOPS_BURST = burst IOPS` (short-duration peak capacity)
- `MONGO_DISK_TIER = tier name` (e.g., P15, E10)

## XLSX Generation

Use `saturation-xlsx.py` to generate a 2-tab sizing workbook:

```bash
source benchmarks/scripts/.venv-sizing/bin/activate
python3 benchmarks/scripts/saturation-xlsx.py \
  --run-dir $RUN_DIR \
  --report benchmarks/docs/saturation-run-<RUN_ID>-<DATE>.md \
  --per-pod <PER_POD_MSG_S> \
  --dirty-pages 8.2 \
  --target 100 \
  --output benchmarks/docs/sizing-<RUN_ID>-<DATE>.xlsx
```

- `--per-pod`: measured per-pod msg/s from the run (key finding #1)
- `--dirty-pages`: MongoDB dirty pages per turn from OTel index analysis (default 8.2)
- `--target`: default target msg/s for projections (editable in the xlsx)

Tab 1 (Sizing & Cost): editable inputs → formulas auto-calculate pods, nodes,
IOPS, monthly cost, what-if scaling table. All yellow cells are editable.

Tab 2 (Measured): readonly run config, infrastructure snapshot, node pools,
measured capacity with RAG status, per-step scorecard.

Requires `openpyxl` (in `.venv-sizing`).

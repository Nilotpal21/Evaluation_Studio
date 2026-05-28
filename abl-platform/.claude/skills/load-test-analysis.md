---
name: load-test-analysis
description: Run k6 load tests on Grafana Cloud, fetch k6 + Coroot metrics for ALL services (runtime, MongoDB, Redis, ClickHouse, Kafka, NGINX), and produce a comprehensive saturation analysis report. Use when the user asks to run benchmarks, saturation tests, load tests, or analyze k6/Coroot metrics.
---

# Load Test & Analysis Skill

End-to-end playbook for running k6 benchmarks on Grafana k6 Cloud against abl-dev (or any target environment) and analyzing the results by combining k6 application metrics with Coroot infrastructure metrics for **every service** in the stack.

---

## 1. Benchmark Scripts

### Available Scripts

| Script                                  | Purpose                                                | Key Env Vars                                         |
| --------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| `benchmarks/multi-turn-saturation.ts`   | Single-tenant saturation — finds max msg/s             | `MAX_VUS`, `STEPS`, `STEP_DURATION_MINUTES`          |
| `benchmarks/multi-tenant-saturation.ts` | Multi-tenant saturation — spreads VUs across N tenants | Same + `MULTI_TENANT=true`, `TENANT_IDS=id1,id2,...` |
| `benchmarks/services/runtime.ts`        | Runtime service benchmark                              | `TIER` (s/m/l/xl)                                    |
| `benchmarks/services/search-ai.ts`      | SearchAI service benchmark                             | `TIER`                                               |

### Self-Contained Setup

Both saturation scripts are **self-contained** — they automatically:

1. Login via dev-login (using `DEV_LOGIN_EMAIL`)
2. Upgrade tenant to ENTERPRISE via super admin (`SUPER_ADMIN_EMAIL`)
3. Create/reuse project, agent, mock TenantModel, credential, connection
4. Configure agent to use mock LLM model
5. Run smoke check before load phase
6. Execute stepped VU ramp with tagged metrics

No manual bootstrap or token management is needed.

### Stepped Load Configuration

Control the VU ramp pattern with env vars:

```bash
# Explicit steps: ramp to 20, then 40, then 60, then 100 VUs
STEPS=20,40,60,100

# Hold duration per step (includes ramp time)
STEP_DURATION_MINUTES=4

# Ramp duration per step (default 30s)
RAMP_SECONDS=120  # 2-minute ramp

# Or use auto-generated steps from MAX_VUS + DURATION_MINUTES
MAX_VUS=100
DURATION_MINUTES=20
```

Each step has: ramp up + hold period. Steps are tagged in k6 metrics as `step=step_20vu`, `step=step_40vu`, etc.

---

## 2. Running on k6 Cloud

### CRITICAL: cloud-run.sh and MULTI_TENANT Override

`cloud.env` sets `MULTI_TENANT=true` by default for multi-tenant runs. **`cloud-run.sh` does NOT caller-save `MULTI_TENANT`** — it reads from cloud.env and exports it directly. To run single-tenant, you MUST override:

```bash
# Single-tenant: pass MULTI_TENANT=false explicitly
MULTI_TENANT=false STEPS=200,300 RAMP_SECONDS=120 STEP_DURATION_MINUTES=7 \
  ./benchmarks/scripts/cloud-run.sh benchmarks/multi-turn-saturation.ts

# Multi-tenant: cloud.env defaults work
STEPS=200,300 STEP_DURATION_MINUTES=7 \
  ./benchmarks/scripts/cloud-run.sh benchmarks/multi-tenant-saturation.ts
```

**Alternatively**, for single-tenant cloud runs via raw `k6 cloud run`, pass `-e MULTI_TENANT=false` directly:

```bash
source benchmarks/config/cloud.env
k6 cloud run \
  -e MULTI_TENANT=false \
  -e STEPS=200,300 \
  -e RAMP_SECONDS=120 \
  -e STEP_DURATION_MINUTES=7 \
  ... (other -e flags) \
  benchmarks/multi-turn-saturation.ts
```

### Configuration File

`benchmarks/config/cloud.env` — central config for all k6 runs.

**Key settings:**

```bash
# k6 Cloud credentials
K6_CLOUD_TOKEN=<token>
K6_CLOUD_PROJECT_ID=<project-id>

# Target environment
STAGING_URL=https://agents-dev.kore.ai
INGRESS_BASE=https://agents-dev.kore.ai
STUDIO_URL=https://agents-dev.kore.ai
RUNTIME_URL=https://agents-dev.kore.ai/api

# Multi-tenant (5 tenants = 25,000 req/min combined)
MULTI_TENANT=true
TENANT_IDS=tenant-dev-001,019d6259-92e6-724f-aec8-0b4807519445,...

# Mock LLM (no real LLM calls)
MOCK_LLM=true

# Super admin for ENTERPRISE upgrade
SUPER_ADMIN_EMAIL=superadmin@platform.internal

# Load test bypass key
LOAD_TEST_KEY=benchmark-bypass
```

### Available abl-dev Tenants

| Tenant ID                              | Name                    |
| -------------------------------------- | ----------------------- |
| `tenant-dev-001`                       | Default dev tenant      |
| `019d6259-92e6-724f-aec8-0b4807519445` | Load Test Enterprise 01 |
| `019d6259-b711-7c96-a293-f5bf87ad86eb` | Load Test Enterprise 02 |
| `019d6259-bb36-772f-bf15-6008512cc194` | Load Test Enterprise 03 |
| `019d6259-bf77-7fae-bb7c-645248231c0d` | Load Test Enterprise 04 |
| `019d6259-c346-7550-86bd-4a50d5cf7027` | Load Test Enterprise 05 |

Each ENTERPRISE tenant has 5,000 req/min. Multi-tenant mode round-robins VUs across tenants.

### Run Output

The run prints a Grafana Cloud URL:

```
output: https://abl.grafana.net/a/k6-app/runs/<RUN_ID>
```

Capture `<RUN_ID>` — you need it for all API queries.

### k6 CLI Behavior

When run via `k6 cloud run`, the CLI exits with code 0 **while the run is still active on the cloud**. The CLI output only shows "Initializing" — you must poll the k6 API for completion and metrics.

---

## 3. k6 Cloud Metrics API

### Authentication

```bash
K6_TOKEN="<from cloud.env K6_CLOUD_TOKEN>"
AUTH="Authorization: Token $K6_TOKEN"
BASE="https://api.k6.io/cloud/v5/test_runs/<RUN_ID>"
```

### Check Run Status

```bash
# Check if run completed
curl -s "$BASE" -H "$AUTH" | jq '{result_status, created, started, ended}'
# result_status: "Passed", "Failed", "Timed Out", or null if running

# Get exact timestamps (ISO 8601)
curl -s "$BASE" -H "$AUTH" | jq '{created, started, ended}'
```

**CRITICAL:** Always check `started` and `ended` to determine the correct time window for queries. Don't assume times — runs can start at unexpected offsets.

### List Available Metrics

```bash
curl -s "$BASE/ms" -H "$AUTH" | jq '[.value[] | {name, type}]'
```

**Custom benchmark metrics:**

| Metric                     | Type    | Description                                        |
| -------------------------- | ------- | -------------------------------------------------- |
| `chat_turn_latency_ms`     | trend   | Per-turn latency (tagged: `turn=create\|followup`) |
| `chat_turn_success_total`  | counter | Successful chat turns                              |
| `chat_turn_failure_total`  | counter | Failed chat turns                                  |
| `chat_turn_attempts_total` | counter | Total attempted chat turns                         |
| `chat_turn_success_rate`   | rate    | Success rate (0.0-1.0)                             |

**Built-in k6 metrics:**

| Metric              | Type    | Description             |
| ------------------- | ------- | ----------------------- |
| `http_req_duration` | trend   | HTTP request latency    |
| `http_req_failed`   | rate    | HTTP failure rate       |
| `http_reqs`         | counter | Total HTTP requests     |
| `iterations`        | counter | Completed VU iterations |
| `vus`               | gauge   | Active virtual users    |

### Time-Series Query (PREFERRED — available during/after run)

```bash
curl -s "$BASE/query_range_k6(metric='<name>',query='<agg>',step=<seconds>,start=<ISO8601>,end=<ISO8601>)" \
  -H "$AUTH"
```

**CRITICAL OData syntax rules:**

- `metric` and `query` are **strings** — wrap in **single quotes**: `metric='http_req_duration'`
- `start` and `end` are **DateTimeOffset** — **NO quotes**: `start=2026-04-06T19:00:00Z`
- Quoting datetimes causes `type_mismatch` error

**Aggregation values:**

- Trend metrics: `avg`, `min`, `max`, `p90`, `p95`, `p99`
- Counter metrics: `count`, `rate`
- Rate metrics: `rate` (0.0-1.0), `count`
- Gauge metrics: `avg`, `min`, `max`

**Response format:**

```json
{"data": {"result": [{"values": [[unix_timestamp, "value_string"], ...]}]}}
```

### Per-Step Analysis Recipe

Pull all key metrics in one batch with `step=60` (1-minute intervals):

```bash
K6_TOKEN="..." && RUN_ID=<id>
BASE="https://api.k6.io/cloud/v5/test_runs/$RUN_ID"
AUTH="Authorization: Token $K6_TOKEN"

# Get run time bounds first
curl -s "$BASE" -H "$AUTH" | jq '{started, ended}'

# Then pull all metrics (replace START/END with actual ISO timestamps)
for metric_query in \
  "vus max" \
  "chat_turn_latency_ms avg" \
  "chat_turn_latency_ms p95" \
  "chat_turn_latency_ms p99" \
  "chat_turn_latency_ms max" \
  "chat_turn_success_total rate" \
  "chat_turn_failure_total rate" \
  "http_req_failed rate"; do
  m=$(echo $metric_query | awk '{print $1}')
  q=$(echo $metric_query | awk '{print $2}')
  echo "=== $m ($q) ==="
  curl -s "$BASE/query_range_k6(metric='$m',query='$q',step=60,start=${START}Z,end=${END}Z)" -H "$AUTH" \
    | jq -r '.data.result[0].values[] | "\(.[0]) \(.[1])"'
done
```

### Correlating Timestamps with Steps

Query `vus` metric first to find exact step boundaries (VU plateau = hold phase):

```bash
curl -s "$BASE/query_range_k6(metric='vus',query='max',step=60,...)" -H "$AUTH"
```

Map minute-by-minute VU values to identify: ramp start → hold start → hold end → next ramp start.

---

## 4. Coroot Infrastructure Metrics API

### Authentication

```bash
COROOT_BASE="https://coroot-agents-dev.kore.ai"

# Login — returns coroot_session cookie
SESSION=$(curl -s -c - "$COROOT_BASE/api/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"coroot-abl-dev@kore.ai","password":"kxHeS69xTNujXT4VTAOT7R7mXrts8eTn"}' \
  2>/dev/null | grep coroot_session | awk '{print $NF}')

# Use in all subsequent requests
-b "coroot_session=$SESSION"
```

**CRITICAL:** Cookie name is `coroot_session`, NOT `auth`. Extract from the cookie jar (use `-c -` to print to stdout).

### Project and App IDs

```bash
PROJECT_ID="vz762g8o"  # abl-dev Coroot project
```

**All service App IDs:**

| Service    | App ID                                                                           |
| ---------- | -------------------------------------------------------------------------------- |
| Runtime    | `vz762g8o:abl-platform-dev:Deployment:abl-platform-dev-runtime`                  |
| Studio     | `vz762g8o:abl-platform-dev:Deployment:abl-platform-dev-studio`                   |
| SearchAI   | `vz762g8o:abl-platform-dev:Deployment:abl-platform-dev-search-ai`                |
| MongoDB    | `vz762g8o:abl-platform-dev:StatefulSet:abl-platform-dev-mongodb`                 |
| Redis      | `vz762g8o:abl-platform-dev:DatabaseCluster:abl-platform-dev-redis`               |
| ClickHouse | `vz762g8o:abl-platform-dev:StatefulSet:abl-platform-dev-clickhouse-shard-0`      |
| Kafka      | `vz762g8o:abl-platform-dev:StrimziPodSet:abl-platform-dev-kafka-default`         |
| NGINX      | `vz762g8o:abl-platform-dev:Deployment:abl-platform-dev-ingress-nginx-controller` |

URL-encode: `python3 -c "import urllib.parse; print(urllib.parse.quote('<APP_ID>', safe=''))"`

### Time Parameters

Coroot uses **Unix milliseconds** for `from` and `to`:

```bash
# Add 2-minute buffer before/after the k6 run
FROM_MS=$((k6_start_unix_seconds * 1000 - 120000))
TO_MS=$((k6_end_unix_seconds * 1000 + 120000))
```

### Fetching Application Data

```bash
ENCODED_APP=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$APP_ID', safe=''))")

curl -s -b "coroot_session=$SESSION" \
  "$COROOT_BASE/api/project/$PROJECT_ID/app/$ENCODED_APP?from=$FROM_MS&to=$TO_MS" \
  -o /tmp/cr_<service>.json
```

**CRITICAL: Fetch ALL services in one batch** — don't fetch one at a time:

```bash
declare -A APPS
APPS[runtime]="vz762g8o:abl-platform-dev:Deployment:abl-platform-dev-runtime"
APPS[mongodb]="vz762g8o:abl-platform-dev:StatefulSet:abl-platform-dev-mongodb"
APPS[redis]="vz762g8o:abl-platform-dev:DatabaseCluster:abl-platform-dev-redis"
APPS[clickhouse]="vz762g8o:abl-platform-dev:StatefulSet:abl-platform-dev-clickhouse-shard-0"
APPS[kafka]="vz762g8o:abl-platform-dev:StrimziPodSet:abl-platform-dev-kafka-default"
APPS[nginx]="vz762g8o:abl-platform-dev:Deployment:abl-platform-dev-ingress-nginx-controller"

for name in runtime mongodb redis clickhouse kafka nginx; do
    ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${APPS[$name]}', safe=''))")
    curl -s -b "coroot_session=$SESSION" \
        "$COROOT_BASE/api/project/vz762g8o/app/${ENCODED}?from=${FROM_MS}&to=${TO_MS}" \
        -o "/tmp/cr_${name}.json"
done
```

### Coroot JSON Response Structure

**CRITICAL:** The response structure is `data.reports[]`, NOT `reports[]`.

```
{
  "context": { ... },
  "data": {
    "app_map": { "application": {...}, "instances": [...], ... },
    "reports": [
      {
        "name": "SLO",
        "widgets": [
          { "table": { "header": [...], "rows": [...] } },     // SLO summary table
          { "heatmap": { "title": "Latency & Errors heatmap" } }, // heatmap
          { "chart": { "title": "Requests...", "ctx": {...}, "series": [...] } },  // chart
          { "chart": { "title": "Errors...", ... } }
        ]
      },
      {
        "name": "CPU",
        "widgets": [
          { "chart_group": { "charts": [...] } },  // Widget 0: CPU Usage
          { "chart_group": { "charts": [...] } },  // Widget 1: CPU Delay
          { "chart_group": { "charts": [...] } },  // Widget 2: CPU Throttle
          { "chart_group": { "charts": [...] } },  // Widget 3: Node CPU overview
          { "chart_group": { "charts": [...] } }   // Widget 4: Node CPU consumers
        ]
      },
      { "name": "Memory", "widgets": [...] },
      { "name": "Net", "widgets": [...] },
      { "name": "DNS", "widgets": [...] },
      { "name": "Node.js", "widgets": [...] },     // Runtime only
      { "name": "Logs", "widgets": [...] },
      { "name": "Instances", "widgets": [...] },
      { "name": "Deployments", "widgets": [...] },
      { "name": "Storage", "widgets": [...] },      // MongoDB, Kafka only
      { "name": "JVM", "widgets": [...] }            // Kafka only
    ]
  }
}
```

### Widget Types

Coroot has **4 widget types** — handle each differently:

| Type          | Key             | Content                                 | Example                                |
| ------------- | --------------- | --------------------------------------- | -------------------------------------- |
| `chart`       | `w.chart`       | Time-series with ctx + series           | SLO requests/s, errors/s, event loop   |
| `chart_group` | `w.chart_group` | Multiple charts (one per container/pod) | CPU usage, delay, throttle, memory RSS |
| `table`       | `w.table`       | Rows + columns                          | Instances list, SLO summary            |
| `heatmap`     | `w.heatmap`     | Latency distribution heatmap            | SLO latency heatmap                    |

### Time-Series Data Format

**CRITICAL:** Series data is a **flat array of floats** (not `[timestamp, value]` pairs). Timestamps are derived from `ctx`:

```python
ctx = chart.get('ctx', {})
from_ms = ctx['from']    # Unix milliseconds
step_ms = ctx['step']    # Usually 15000 (15 seconds)
# Point i has timestamp: from_ms + i * step_ms
# Total points = len(data) — typically 73 for a 18-min window at 15s step
```

**chart (direct):**

```python
chart = widget['chart']
ctx = chart['ctx']  # {'from': 1775618880000, 'to': 1775619960000, 'step': 15000}
for series in chart['series']:
    name = series['name']        # Pod name or label
    data = series['data']        # [0.525, 0.530, None, 0.518, ...]  (flat floats, None = no data)
    for i, val in enumerate(data):
        if val is not None:
            ts_ms = ctx['from'] + i * ctx['step']
```

**chart_group:**

```python
chart_group = widget['chart_group']
for chart in chart_group['charts']:
    title = chart['title']  # "container: runtime", "total", "RSS", etc.
    ctx = chart['ctx']
    for series in chart['series']:
        # same flat-array format as above
```

### CPU Widget Ordering

The CPU report has **5 chart_group widgets** in a fixed order:

| Widget Index | Content                | Charts                                                |
| ------------ | ---------------------- | ----------------------------------------------------- |
| 0            | **CPU Usage** (cores)  | `container: runtime`, `container: <sidecar>`, `total` |
| 1            | **CPU Delay** (s/s)    | Same containers                                       |
| 2            | **CPU Throttle** (s/s) | Same containers                                       |
| 3            | **Node CPU** overview  | `overview` + per-node breakdown                       |
| 4            | **Node CPU consumers** | Per-node top-5 CPU consumers                          |

**Always use the chart with title "total" for aggregate CPU**, not "container: runtime" (which excludes sidecars). For delay/throttle, "total" matches "container: runtime" since sidecars have ~zero delay.

### Memory Widget Ordering

| Widget Index        | Content                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| 0+ (chart_group)    | RSS per container, RSS total, RSS + PageCache, memory stall (some/full) |
| Last (chart)        | Node memory usage %                                                     |
| Last+ (chart_group) | Per-node memory consumers                                               |

Look for chart title `"RSS container: runtime"` for the main process, or `"RSS"` for total pod RSS.

### Complete Python Extraction Recipe

```python
import json, datetime as dt

def utc_ms(year, month, day, h, m, s):
    """Convert UTC time to Unix milliseconds."""
    return int(dt.datetime(year, month, day, h, m, s, tzinfo=dt.timezone.utc).timestamp() * 1000)

# Define hold phase windows (from k6 VU step analysis)
HOLD_200 = (utc_ms(2026,4,8, 3,31,30), utc_ms(2026,4,8, 3,36,30))
HOLD_300 = (utc_ms(2026,4,8, 3,38,30), utc_ms(2026,4,8, 3,43,30))
PHASES = [("200 VU", HOLD_200), ("300 VU", HOLD_300)]

def window_stats(series_list, start_ms, end_ms, ctx, min_avg=0.0):
    """Compute per-series avg/max/min within a time window."""
    fr = ctx.get('from', 0)
    step = ctx.get('step', 15000)
    results = []
    for s in series_list:
        name = s.get('name', '')
        data = s.get('data', [])
        vals = [v for i, v in enumerate(data)
                if v is not None and start_ms <= fr + i * step <= end_ms]
        if vals:
            avg = sum(vals) / len(vals)
            if avg >= min_avg:
                results.append({
                    'name': name, 'avg': avg,
                    'max': max(vals), 'min': min(vals), 'n': len(vals)
                })
    return sorted(results, key=lambda x: -x['avg'])

def extract_chart(reports, cat_name, title_substr):
    """Find a chart widget by category name and title substring."""
    for cat in reports:
        if cat.get('name', '') == cat_name:
            for w in (cat.get('widgets') or []):
                ch = w.get('chart') or {}
                if title_substr.lower() in ch.get('title', '').lower():
                    return ch
    return None

def extract_cpu_widget(reports, widget_idx):
    """Extract CPU chart_group by widget index (0=usage, 1=delay, 2=throttle)."""
    for cat in reports:
        if cat.get('name') == 'CPU':
            widgets = cat.get('widgets') or []
            if widget_idx < len(widgets):
                cg = widgets[widget_idx].get('chart_group') or {}
                charts = cg.get('charts', [])
                # Return "total" chart, or last chart as fallback
                for ch in charts:
                    if ch.get('title', '').lower() == 'total':
                        return ch
                return charts[-1] if charts else None
    return None

# Load and extract
with open('/tmp/cr_runtime.json') as f:
    data = json.load(f)
reports = data['data']['reports']

# CPU Usage
cpu = extract_cpu_widget(reports, 0)
if cpu:
    for label, (s, e) in PHASES:
        stats = window_stats(cpu['series'], s, e, cpu['ctx'])
        total = sum(r['avg'] for r in stats)
        print(f"CPU {label}: {total:.3f} cores ({len(stats)} pods)")

# Event Loop (runtime only — direct chart, not chart_group)
el = extract_chart(reports, 'Node.js', 'event loop')
if el:
    for label, (s, e) in PHASES:
        stats = window_stats(el['series'], s, e, el['ctx'], min_avg=0.001)
        avg = sum(r['avg'] for r in stats) / len(stats) if stats else 0
        print(f"Event Loop {label}: {avg:.3f} s/s per pod")

# SLO Requests (latency buckets)
slo = extract_chart(reports, 'SLO', 'Requests to')
if slo:
    for label, (s, e) in PHASES:
        stats = window_stats(slo['series'], s, e, slo['ctx'], min_avg=0.01)
        total = sum(r['avg'] for r in stats)
        print(f"SLO {label}: {total:.1f} req/s")
        for r in stats[:5]:
            pct = r['avg'] / total * 100 if total > 0 else 0
            print(f"  {r['name']}: {r['avg']:.1f} ({pct:.1f}%)")
```

### Report Categories by Service

| Service        | Reports Available                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| **Runtime**    | SLO, Instances, CPU, Memory, Net, DNS, **Node.js** (event loop), Logs, Deployments, Profiling, Tracing |
| **MongoDB**    | SLO, Instances, CPU, Memory, **Storage** (I/O, disk usage), Net, DNS, Logs                             |
| **Redis**      | SLO, Instances, CPU, Memory, Logs                                                                      |
| **ClickHouse** | SLO, Instances, CPU, Memory, Logs                                                                      |
| **Kafka**      | SLO, Instances, CPU, Memory, **Storage**, Net, **JVM** (GC, heap, safepoints), Logs                    |
| **NGINX**      | SLO, Instances, CPU, Memory, Net, Logs, Deployments                                                    |

### Instances Table Structure

```python
# Instances table has rows as dicts with 'cells' arrays
for cat in reports:
    if cat.get('name') == 'Instances':
        for w in (cat.get('widgets') or []):
            tbl = w.get('table')
            if tbl:
                headers = tbl['header']  # list of strings
                for row in tbl['rows']:
                    cells = row['cells']  # list of {value, status, ...}
                    pod_name = cells[0]['value']
                    status = cells[1]['value']   # "up (running)", "failed", "down (pending, not scheduled)"
                    ip = cells[3]['value']        # Pod IP
                    node = cells[4]['value']      # Node name
```

---

## 5. Analysis Playbook

### Step 1: Determine Run Time Window

```bash
# Get exact run boundaries
curl -s "$BASE" -H "$AUTH" | jq '{created, started, ended}'
```

Convert to Unix ms for Coroot:

```python
import datetime as dt
# Parse ISO 8601 from k6 API
started = "2026-04-08T03:29:30Z"
d = dt.datetime.fromisoformat(started.replace('Z', '+00:00'))
from_ms = int(d.timestamp() * 1000) - 120000  # 2min buffer before
```

### Step 2: Identify VU Step Boundaries

Query `vus` metric at 60s resolution to find plateau phases:

```bash
curl -s "$BASE/query_range_k6(metric='vus',query='max',step=60,...)" -H "$AUTH"
```

Map each minute to its VU count. Define hold phases as contiguous minutes at the target VU level (ignoring ramp-up minutes where VUs are changing).

### Step 3: Collect k6 Metrics

Pull all metrics at `step=60`:

- `chat_turn_latency_ms` — avg, p95, p99, max
- `chat_turn_success_total` — rate (msg/s)
- `chat_turn_failure_total` — rate
- `http_req_failed` — rate
- `vus` — max

### Step 4: Collect Coroot Metrics for ALL Services

Fetch app data for runtime, MongoDB, Redis, ClickHouse, Kafka, NGINX (see Section 4 batch recipe).

Extract per-phase for each service:

**Runtime:**

- CPU usage, delay, throttle (per pod + cluster total)
- Event loop blocked time (per pod + per-pod avg)
- Memory RSS (per pod)
- TCP connections (per destination)
- TCP connection latency
- TCP retransmissions
- DNS requests/errors/latency

**MongoDB:**

- SLO requests/s by latency bucket (shows query latency distribution)
- CPU per pod (identify primary vs secondaries)
- CPU delay/throttle
- Memory RSS
- Storage I/O: write IOPS, write throughput, read IOPS, I/O wait
- Network bandwidth (inbound/outbound)
- Active connections

**Redis:**

- SLO requests/s by latency bucket
- CPU usage/delay/throttle
- Memory RSS
- Note the 5-10s bucket (background ops) separately

**ClickHouse:**

- SLO requests/s (should be constant ~3 req/s regardless of load)
- CPU (should be low)

**Kafka:**

- SLO requests/s by latency bucket
- CPU
- JVM: heap usage, GC pauses, safepoint time

**NGINX:**

- CPU (3 controllers)
- TCP connections to upstream services
- Connection latency to runtime

### Step 5: Build Summary Tables

Produce per-step tables combining both sources:

| Step | VUs | Throughput | Avg Latency | p95 | p99 | Errors | RT CPU/pod | EL Blocked | RT RSS | Mongo req/s | Mongo <5ms% | Redis req/s | Redis <5ms% |
| ---- | --- | ---------- | ----------- | --- | --- | ------ | ---------- | ---------- | ------ | ----------- | ----------- | ----------- | ----------- |
| 1    | 200 | 99 msg/s   | 1081 ms     | ... | ... | 0%     | 0.68 cores | 0.50 s/s   | 1.2 GB | 3054        | 96.7%       | 2176        | 89.3%       |
| 2    | 300 | 145 msg/s  | 1136 ms     | ... | ... | 0%     | 0.94 cores | 0.69 s/s   | 1.4 GB | 4234        | 86.1%       | 2297        | 84.8%       |

### Step 6: Compute Scaling Efficiency

```
Expected throughput at step N = (VUs_N / VUs_baseline) * throughput_baseline
Efficiency = actual / expected * 100%

If efficiency < 85%, the system is saturated.
```

### Step 7: Identify Saturation Signals

| Signal              | Threshold                                        | Evidence Source     |
| ------------------- | ------------------------------------------------ | ------------------- |
| Throughput plateau  | Efficiency < 85%                                 | k6 throughput       |
| p95 knee            | Disproportionate jump (>2x the VU increase %)    | k6 p95              |
| CPU saturation      | Per-pod > 1.0 core (Node.js single-thread limit) | Coroot CPU          |
| CPU throttling      | > 0.05 s/s per pod                               | Coroot CPU throttle |
| Event loop blocking | > 0.5 s/s = >50% blocked, > 0.7 s/s = CRITICAL   | Coroot Node.js      |
| Memory pressure     | RSS > 80% of container limit                     | Coroot Memory       |
| Error rate          | Any non-zero http_req_failed                     | k6 errors           |
| MongoDB tail        | >5ms bucket grows > 15% of total                 | Coroot MongoDB SLO  |
| Redis stall         | Throughput doesn't grow with VUs                 | Coroot Redis SLO    |

### Step 8: Root Cause Classification

| Symptom                     | Likely Bottleneck                | Evidence                                |
| --------------------------- | -------------------------------- | --------------------------------------- |
| CPU > 1 core + throttling   | Pod CPU limit                    | Coroot CPU throttled time > 0.05 s/s    |
| Event loop > 0.7 s/s        | Node.js sync operations          | Coroot Node.js report — trace to code   |
| Memory climbing + GC spikes | Memory pressure                  | Coroot Memory RSS + latency correlation |
| p99 >> p95                  | Tail latency from DB/external    | Check MongoDB/Redis latency buckets     |
| Errors at high VUs          | Rate limiting                    | Check `chat_turn_failure_total` tags    |
| Throughput flat but low CPU | I/O bound (DB/network)           | Check Redis/MongoDB throughput scaling  |
| Redis throughput flat       | Event loop head-of-line blocking | Runtime can't dispatch Redis commands   |
| MongoDB latency tail grows  | Burst-pattern from event loop    | Queries bunch when event loop unblocks  |

### Step 9: Write Report

Save to `docs/load-testing/run-<RUN_ID>-analysis.md` with:

1. Test Configuration (script, env, steps, tenant, mock LLM)
2. Infrastructure Topology (pods, nodes, co-location)
3. k6 Application Metrics (throughput, latency, errors, efficiency)
4. Runtime Metrics (CPU, delay, throttle, event loop, memory, TCP, DNS)
5. MongoDB Metrics (SLO buckets, CPU, memory, storage I/O, network)
6. Redis Metrics (SLO buckets, CPU, memory)
7. ClickHouse Metrics (SLO, CPU — should be idle)
8. Kafka Metrics (SLO, CPU, JVM)
9. NGINX Metrics (CPU, connections, latency)
10. Node-Level Summary (memory per node)
11. Cross-Run Comparison (if prior runs exist)
12. Bottleneck Analysis (ranked by severity with evidence)
13. Capacity Projections
14. Recommendations

---

## 6. Common Recipes

### Recipe: Single-Tenant 200→300 VU Saturation (2min ramp, 5min hold)

```bash
MULTI_TENANT=false STEPS=200,300 RAMP_SECONDS=120 STEP_DURATION_MINUTES=7 \
  ./benchmarks/scripts/cloud-run.sh benchmarks/multi-turn-saturation.ts
```

### Recipe: Multi-Tenant Stepped Saturation (20→100 VU, 4min hold)

```bash
STEPS=20,40,60,80,100 STEP_DURATION_MINUTES=4 \
  ./benchmarks/scripts/cloud-run.sh benchmarks/multi-tenant-saturation.ts
```

### Recipe: Long Soak Test (50 VUs, 30 min)

```bash
MAX_VUS=50 DURATION_MINUTES=30 STEPS=50 \
  ./benchmarks/scripts/cloud-run.sh benchmarks/multi-tenant-saturation.ts
```

### Recipe: Quick Smoke Test (5 VUs, local with cloud upload)

```bash
./benchmarks/scripts/cloud-run.sh benchmarks/multi-turn-saturation.ts --vus 5 --iterations 10
```

### Recipe: Compare Two Runs

Query both run IDs with the same time-series calls and diff the per-step averages. Include infrastructure metrics from Coroot to explain differences (pod count, CPU, memory, event loop).

### Recipe: Discover Available Tenants

```bash
SA_TOKEN=$(curl -s https://agents-dev.kore.ai/api/auth/dev-login \
  -H 'Content-Type: application/json' \
  -d '{"email":"superadmin@platform.internal","name":"Super Admin"}' | jq -r '.accessToken')

curl -s "https://agents-dev.kore.ai/api/platform/admin/tenants" \
  -H "Authorization: Bearer $SA_TOKEN" \
  -H "Origin: https://agents-dev.kore.ai" \
  | jq '[.tenants[] | {id: .id, name: .name, plan: .subscription.planTier}]'
```

---

## 7. Known Event Loop Blockers (Runtime)

These synchronous operations cause the event loop blocking measured by Coroot's Node.js report:

| Operation                                     | File                                                                    | Est. Time | Frequency                              |
| --------------------------------------------- | ----------------------------------------------------------------------- | --------- | -------------------------------------- |
| `crypto.pbkdf2Sync` (100K iter)               | `packages/shared-encryption/src/key-derivation/pbkdf2.ts:9`             | 50–150 ms | Per encryption op                      |
| `JSON.stringify(IR)` + SHA-256                | `apps/runtime/src/services/session/session-service.ts:104-106`          | 5–50 ms   | Per session create                     |
| `JSON.stringify(compilationOutput)` + SHA-256 | `apps/runtime/src/services/session/session-service.ts:110-111`          | 5–100 ms  | Per session create                     |
| `parseAgentBasedABL` + `compileABLtoIR`       | `apps/runtime/src/services/execution/types.ts:939-964`                  | 10–100 ms | Per new session                        |
| `zlib.gunzipSync`                             | `apps/runtime/src/services/deployment-resolver.ts:794`                  | 5–50 ms   | Per deployment resolve                 |
| `JSON.stringify` in trim loop                 | `apps/runtime/src/services/execution/tool-result-compressor.ts:144-158` | Variable  | Per tool result                        |
| `JSON.stringify(msg)` per message             | `apps/runtime/src/services/session/redis-session-store.ts:267`          | 1–10 ms   | Per conversation persist               |
| Sync `jwt.verify` (HMAC)                      | `apps/runtime/src/middleware/auth.ts:174`                               | 1–5 ms    | Per request                            |
| `shouldPersistImmediately('api')` = true      | `apps/runtime/src/services/runtime-executor.ts:3382`                    | N/A       | Forces sync persist every HTTP message |

---

## 8. Gotchas & Troubleshooting

| Problem                                 | Cause                                                                  | Fix                                                        |
| --------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------- |
| Single-tenant run uses multi-tenant     | `cloud.env` sets `MULTI_TENANT=true`, no caller-save in `cloud-run.sh` | Pass `MULTI_TENANT=false` as env var before `cloud-run.sh` |
| k6 `__ENV.X` is empty                   | Used `source cloud.env && k6 cloud run`                                | Use `cloud-run.sh` which maps vars to `-e` flags           |
| Metrics return `N/A` after run          | Aggregation engine needs time                                          | Use `query_range_k6` (time-series) — available immediately |
| Coroot cookie empty                     | Parsing `Set-Cookie` wrong                                             | Use `grep coroot_session \| awk '{print $NF}'`             |
| Coroot CPU shows 0.000                  | Reading sidecar chart, not runtime                                     | Match chart by title containing "total" or "runtime"       |
| Coroot returns HTML instead of JSON     | Wrong API endpoint (SPA catch-all)                                     | Only use `/api/project/{id}/app/{encoded_app}?from=&to=`   |
| Coroot `widgets: null`                  | No data for the requested time range                                   | Verify `from`/`to` are correct Unix milliseconds           |
| Coroot data points have no timestamps   | Normal — data is flat float arrays                                     | Derive timestamps: `from_ms + index * step_ms`             |
| k6 run shows "Initializing" then exits  | Normal — `k6 cloud run` exits while run is active                      | Poll k6 API for `result_status`                            |
| Wrong Coroot time window                | Used estimated times instead of actual                                 | Always check k6 run `started`/`ended` first                |
| Credential 409 during setup             | Name conflict from previous run                                        | Scripts auto-retry with timestamped name                   |
| "Cannot determine provider for model"   | TenantModel credential chain broken                                    | Check: TenantModel → Connection → Credential chain         |
| Rate limit errors at high VUs           | Tenant not ENTERPRISE                                                  | Scripts auto-upgrade; verify `SUPER_ADMIN_EMAIL`           |
| `type_mismatch` in k6 OData query       | Quoted datetime params                                                 | Datetimes must NOT be quoted: `start=2026-04-06T19:00:00Z` |
| DNS NXDOMAIN flood in Coroot            | Runtime resolving external hostnames via cluster DNS                   | Cluster DNS falls through to external for mock LLM         |
| MongoDB latency degrades at high VUs    | Not MongoDB issue — burst-pattern from event loop blocking             | Runtime batches queries when event loop unblocks           |
| Redis throughput doesn't scale with VUs | Event loop head-of-line blocking                                       | Runtime can't dispatch Redis commands fast enough          |
| `maxPoolSize: 5` connection limit       | Default MongoDB pool is too small for 6+ pods                          | File: `packages/config/src/schemas/mongodb.schema.ts:16`   |

---

## 9. Reference

### k6 Cloud API Base

```
https://api.k6.io/cloud/v5/test_runs/<RUN_ID>/
```

### Coroot API Base

```
https://coroot-agents-dev.kore.ai/api/project/vz762g8o/
```

### Coroot Credentials

```
Email:    coroot-abl-dev@kore.ai
Password: kxHeS69xTNujXT4VTAOT7R7mXrts8eTn
```

### k6 Cloud Grafana Dashboard

```
https://abl.grafana.net/a/k6-app/runs/<RUN_ID>
```

### Coroot Deployment Prefixes

```
DEPLOYMENT_PREFIX=abl-platform-dev
NAMESPACE=abl-platform-dev
COROOT_PROJECT_ID=vz762g8o
```

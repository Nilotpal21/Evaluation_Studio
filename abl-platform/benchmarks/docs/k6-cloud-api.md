# k6 Cloud API Reference

Quick reference for programmatically querying k6 Cloud test run metrics via the v5 OData REST API and stopping active runs through the current v6 API or legacy fallbacks.

## Auth & Base URL

### Metrics API

```
Base:  https://api.k6.io/cloud/v5/
Auth:  Authorization: Token <K6_CLOUD_TOKEN>
```

Token is the same one used in `benchmarks/config/cloud.env` (`K6_CLOUD_TOKEN`).

### Current Cloud REST API

```
Base:  https://api.k6.io/cloud/v6/
Auth:  Authorization: Bearer <K6_CLOUD_API_TOKEN>
Scope: X-Stack-Id: <K6_STACK_ID>
```

`benchmarks/scripts/stop-k6.sh` uses the current v6 abort endpoint when `K6_STACK_ID` is configured, then falls back to the legacy stop APIs already used by this repo.

## Endpoints

### OpenAPI Spec

```bash
curl -H "Authorization: Token $TOKEN" \
  "https://api.k6.io/cloud/v5/openapi_spec"
```

### List Metrics for a Run

```bash
# All metrics (name, id, type, origin)
curl -H "Authorization: Token $TOKEN" \
  "https://api.k6.io/cloud/v5/test_runs/7175005/metrics"

# Ad-blocker-safe alias
curl -H "Authorization: Token $TOKEN" \
  "https://api.k6.io/cloud/v5/test_runs/7175005/ms"

# Single metric by UUID
curl -H "Authorization: Token $TOKEN" \
  "https://api.k6.io/cloud/v5/test_runs/7175005/ms('f778b909-2d19-537a-96dd-e5b116d7ddb8')"
```

### Aggregate Query (single value over time window)

Returns a single aggregated value (avg, p95, count, etc.) for a metric over the run.

```
GET /test_runs/{id}/query_aggregate_k6(
  metric='{metric_name}',
  query='{aggregation}',
  start={ISO8601_no_quotes},
  end={ISO8601_no_quotes}
)
```

**Example:**

```bash
curl -H "Authorization: Token $TOKEN" \
  "https://api.k6.io/cloud/v5/test_runs/7175005/query_aggregate_k6(metric='chat_turn_latency_ms',query='p95',start=2026-04-02T10:50:51Z,end=2026-04-02T11:11:15Z)"
```

**Response:**

```json
{
  "data": {
    "result": [
      {
        "metric": { "__name__": "chat_turn_latency_ms", "test_run_id": "7175005" },
        "values": [[1775128275.0, 3915.77490234375]]
      }
    ],
    "resultType": "vector"
  },
  "status": "success"
}
```

The value is in `data.result[0].values[0][1]`.

### Range Query (time series)

Returns time-series data points at a given step interval.

```
GET /test_runs/{id}/query_range_k6(
  metric='{metric_name}',
  query='{aggregation}',
  step={seconds},
  start={ISO8601_no_quotes},
  end={ISO8601_no_quotes}
)
```

### Series (label sets)

Lists label combinations for a metric (Prometheus-style).

```bash
curl -H "Authorization: Token $TOKEN" \
  "https://api.k6.io/cloud/v5/test_runs/7175005/series?match[]=http_req_duration"
```

### Labels

Lists all label names available for a run.

```bash
curl -H "Authorization: Token $TOKEN" \
  "https://api.k6.io/cloud/v5/test_runs/7175005/labels"
```

### Cross-Run Aggregate (load test level)

Compare a metric across multiple runs of the same load test.

```bash
# Last 5 runs
curl -H "Authorization: Token $TOKEN" \
  "https://api.k6.io/cloud/v5/load_tests/1191407/query_aggregate_k6(metric='http_req_duration',query='p95',test_run_count=5)"

# Specific run IDs
curl -H "Authorization: Token $TOKEN" \
  "https://api.k6.io/cloud/v5/load_tests/1191407/query_aggregate_k6(metric='http_req_duration',query='p95',test_run_ids=[7175005,7175010])"
```

### Abort or Stop a Running Test

Prefer the repo helper so token handling and fallbacks stay centralized:

```bash
./benchmarks/scripts/stop-k6.sh <RUN_ID>
```

The helper tries, in order:

1. `k6 cloud abort <RUN_ID>` when the local k6 CLI is installed.
2. `POST /cloud/v6/test_runs/<RUN_ID>/abort` when `K6_STACK_ID` is configured.
3. `POST /loadtests/v2/runs/<RUN_ID>/stop`.
4. `PATCH /v4/test-runs/<RUN_ID>` with `{"run_status": -2}`.

There is no repo command or k6 Cloud API call for "proceed to the next step" in the saturation ladder. Proceed decisions leave the already-running scripted ladder active; stop decisions abort the active run.

## Aggregation Functions

| Metric Type                   | Valid `query` values                      |
| ----------------------------- | ----------------------------------------- |
| **trend** (latency, duration) | `avg`, `min`, `max`, `p90`, `p95`, `p99`  |
| **counter** (reqs, bytes)     | `count`, `rate`                           |
| **rate** (success/failure)    | `rate` (0.0-1.0), `count` (total samples) |
| **gauge** (VUs, CPU)          | `avg`, `min`, `max`                       |

> Note: `med` (median/p50) returns empty for trend metrics. Use `p90` as the closest available.

## OData Gotchas

This API uses OData function-call syntax, not standard REST query params. Key rules:

1. **String params** use single quotes: `metric='http_req_duration'`
2. **DateTime params** are UNQUOTED: `start=2026-04-02T10:50:51Z` (not `start='...'`)
3. Quoting DateTimes causes: `Expected value of type datetime for Edm.DateTimeOffset`
4. Wrong param names cause: `No overload found for function ... found 'query'` (misleading error)
5. Functions are in the URL path, not query string: `.../query_aggregate_k6(metric='...',query='...')`
6. Get `start`/`end` timestamps from the test run metadata: `GET /test_runs/{id}` → `started`, `ended`

## Quick Script: Fetch All Metrics for a Run

```bash
#!/bin/bash
TOKEN="your-k6-cloud-token"
RUN_ID=7175005
START="2026-04-02T10:50:51Z"
END="2026-04-02T11:11:15Z"
BASE="https://api.k6.io/cloud/v5/test_runs/${RUN_ID}/query_aggregate_k6"

fetch() {
  curl -s -H "Authorization: Token $TOKEN" \
    "${BASE}(metric='$1',query='$2',start=${START},end=${END})" | \
    python3 -c "import sys,json; r=json.load(sys.stdin); print(r['data']['result'][0]['values'][0][1])" 2>/dev/null
}

echo "=== Latency (ms) ==="
for m in chat_turn_latency_ms chat_session_create_latency_ms http_req_duration; do
  for a in avg min max p90 p95 p99; do
    printf "%-40s %-5s = %s\n" "$m" "$a" "$(fetch $m $a)"
  done
  echo ""
done

echo "=== Throughput ==="
for m in http_reqs chat_messages_total chat_conversations_total iterations; do
  printf "%-40s count = %s\n" "$m" "$(fetch $m count)"
  printf "%-40s rate  = %s/s\n" "$m" "$(fetch $m rate)"
done

echo "=== Success Rates ==="
for m in chat_turn_success_rate chat_session_create_success_rate http_req_failed checks; do
  printf "%-40s rate  = %s\n" "$m" "$(fetch $m rate)"
done
```

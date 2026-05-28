#!/bin/bash
# Fetch k6 Cloud test run results and display a comprehensive report.
#
# The report has three sections:
#   1. Compact overview — one-line per run (pass/fail, latency, checks)
#   2. Detailed breakdown — per-run metrics (p50/p90/p95/p99, custom, thresholds)
#   3. Summary — totals, pass/fail counts, dashboard link
#
# Usage:
#   ./benchmarks/scripts/cloud-results.sh                  # Latest 10 runs (full report)
#   ./benchmarks/scripts/cloud-results.sh --run-id 12345   # Single run deep-dive
#   ./benchmarks/scripts/cloud-results.sh --last 5         # Last 5 runs
#   ./benchmarks/scripts/cloud-results.sh --save           # Also save JSON to /tmp/
#   ./benchmarks/scripts/cloud-results.sh --compact        # Compact overview only
#   ./benchmarks/scripts/cloud-results.sh --detailed       # Detailed only (no compact)
#   ./benchmarks/scripts/cloud-results.sh --markdown       # Generate markdown report to docs/
#
# Prerequisites:
#   1. benchmarks/config/cloud.env with K6_CLOUD_TOKEN and K6_CLOUD_PROJECT_ID
#   2. curl and jq installed

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG_FILE="${REPO_ROOT}/benchmarks/config/cloud.env"

if [ -f "$CONFIG_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
  set +a
else
  echo "ERROR: $CONFIG_FILE not found."
  exit 1
fi

: "${K6_CLOUD_TOKEN:?K6_CLOUD_TOKEN not set in cloud.env}"
: "${K6_CLOUD_PROJECT_ID:?K6_CLOUD_PROJECT_ID not set in cloud.env}"

API_BASE="https://api.k6.io/v4"
API_V5_BASE="https://api.k6.io/cloud/v5"
AUTH_HEADER="Authorization: Token ${K6_CLOUD_TOKEN}"

# Parse args
RUN_ID=""
LAST_N=10
SAVE=false
MODE="full"  # full | compact | detailed
MARKDOWN=false
MARKDOWN_OUT=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --run-id) RUN_ID="$2"; shift 2 ;;
    --last) LAST_N="$2"; shift 2 ;;
    --save) SAVE=true; shift ;;
    --compact) MODE="compact"; shift ;;
    --detailed) MODE="detailed"; shift ;;
    --markdown) MARKDOWN=true; shift ;;
    --markdown-out) MARKDOWN=true; MARKDOWN_OUT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# ────────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────────

fmt_ms() {
  local ms="${1:-0}"
  local rounded
  rounded=$(printf "%.0f" "$ms" 2>/dev/null || echo "0")
  if [ "$rounded" -ge 60000 ]; then
    printf "%.1fm" "$(echo "$ms / 60000" | bc -l 2>/dev/null || echo "0")"
  elif [ "$rounded" -ge 1000 ]; then
    printf "%.2fs" "$(echo "$ms / 1000" | bc -l 2>/dev/null || echo "0")"
  else
    printf "%dms" "$rounded"
  fi
}

fmt_bytes() {
  local bytes="${1:-0}"
  local rounded
  rounded=$(printf "%.0f" "$bytes" 2>/dev/null || echo "0")
  if [ "$rounded" -ge 1048576 ]; then
    printf "%.1fMB" "$(echo "$bytes / 1048576" | bc -l 2>/dev/null || echo "0")"
  elif [ "$rounded" -ge 1024 ]; then
    printf "%.1fKB" "$(echo "$bytes / 1024" | bc -l 2>/dev/null || echo "0")"
  else
    printf "%dB" "$rounded"
  fi
}

calc_elapsed() {
  local started="$1" ended="$2"
  if [ "$ended" = "null" ] || [ "$ended" = "running..." ] || [ "$started" = "?" ]; then
    echo "running"
    return
  fi
  local start_epoch end_epoch
  start_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${started%%.*}" "+%s" 2>/dev/null || echo "0")
  end_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${ended%%.*}" "+%s" 2>/dev/null || echo "0")
  if [ "$start_epoch" -gt 0 ] && [ "$end_epoch" -gt 0 ]; then
    local wall_sec=$((end_epoch - start_epoch))
    local mins=$((wall_sec / 60))
    local secs=$((wall_sec % 60))
    [ "$mins" -gt 0 ] && echo "${mins}m${secs}s" || echo "${wall_sec}s"
  else
    echo "?"
  fi
}

status_label() {
  case "$1" in
    2) echo "PASS" ;;
    3) echo "FAIL" ;;
    -2) echo "ABRT" ;;
    -1) echo "INIT" ;;
    0) echo "CRTD" ;;
    1) echo "RUN " ;;
    *) echo "????" ;;
  esac
}

HR="  ───────────────────────────────────────────────────────────────────────────────────────────────────────"

# Print a trend metric row with full percentile breakdown
print_metric_row() {
  local name="$1" json="$2" metric_path="$3"

  local avg med p90 p95 p99 min max count
  avg=$(echo "$json" | jq -r "${metric_path}.values.avg // 0")
  med=$(echo "$json" | jq -r "${metric_path}.values.med // ${metric_path}.values[\"p(50)\"] // 0")
  p90=$(echo "$json" | jq -r "${metric_path}.values[\"p(90)\"] // 0")
  p95=$(echo "$json" | jq -r "${metric_path}.values[\"p(95)\"] // 0")
  p99=$(echo "$json" | jq -r "${metric_path}.values[\"p(99)\"] // 0")
  min=$(echo "$json" | jq -r "${metric_path}.values.min // 0")
  max=$(echo "$json" | jq -r "${metric_path}.values.max // 0")
  count=$(echo "$json" | jq -r "${metric_path}.values.count // \"\"")

  printf "  %-36s  avg=%-7s  med=%-7s  p90=%-7s  p95=%-7s  p99=%-7s  min=%-7s  max=%-7s" \
    "$name" \
    "$(fmt_ms "$avg")" "$(fmt_ms "$med")" \
    "$(fmt_ms "$p90")" "$(fmt_ms "$p95")" "$(fmt_ms "$p99")" \
    "$(fmt_ms "$min")" "$(fmt_ms "$max")"

  if [ -n "$count" ] && [ "$count" != "null" ] && [ "$count" != "" ]; then
    printf "  n=%s" "$(printf "%.0f" "$count" 2>/dev/null || echo "$count")"
  fi
  echo ""
}

# Print a rate metric row
print_rate_row() {
  local name="$1" json="$2" metric_path="$3"

  local rate passes fails
  rate=$(echo "$json" | jq -r "${metric_path}.values.rate // 0")
  passes=$(echo "$json" | jq -r "${metric_path}.values.passes // \"\"")
  fails=$(echo "$json" | jq -r "${metric_path}.values.fails // \"\"")

  local pct
  pct=$(printf "%.2f%%" "$(echo "$rate * 100" | bc -l 2>/dev/null || echo "0")")

  if [ -n "$passes" ] && [ "$passes" != "null" ]; then
    printf "  %-36s  rate=%-8s  passed=%-6s  failed=%-6s\n" "$name" "$pct" "$passes" "$fails"
  else
    printf "  %-36s  rate=%-8s\n" "$name" "$pct"
  fi
}

# Print a counter metric row
print_counter_row() {
  local name="$1" json="$2" metric_path="$3"

  local count rate_per_sec
  count=$(echo "$json" | jq -r "${metric_path}.values.count // 0")
  rate_per_sec=$(echo "$json" | jq -r "${metric_path}.values.rate // 0")

  printf "  %-36s  total=%-8s  rate=%.1f/s\n" "$name" \
    "$(printf "%.0f" "$count" 2>/dev/null || echo "$count")" \
    "$rate_per_sec"
}

# ────────────────────────────────────────────────────────────────
# Fetch run metadata + metrics (cached per run_id)
# ────────────────────────────────────────────────────────────────

declare -A _run_cache _metrics_cache 2>/dev/null || true

fetch_run() {
  local run_id="$1"
  curl -sS -H "$AUTH_HEADER" "${API_BASE}/test-runs/${run_id}"
}

fetch_metrics() {
  local run_id="$1"
  curl -sS -H "$AUTH_HEADER" "${API_BASE}/test-runs/${run_id}/metrics" 2>/dev/null || echo "{}"
}

# ────────────────────────────────────────────────────────────────
# Compact one-liner per run
# ────────────────────────────────────────────────────────────────

show_run_compact() {
  local run_id="$1"
  local run_json metrics_json

  run_json=$(fetch_run "$run_id")
  metrics_json=$(fetch_metrics "$run_id")

  local test_name run_status vus started_at ended_at tags_tier tags_service
  test_name=$(echo "$run_json" | jq -r '.name // "unknown"')
  run_status=$(echo "$run_json" | jq -r '.run_status // 0')
  vus=$(echo "$run_json" | jq -r '.vus // 0')
  started_at=$(echo "$run_json" | jq -r '.started // "?"')
  ended_at=$(echo "$run_json" | jq -r '.ended // "null"')
  tags_tier=$(echo "$run_json" | jq -r '.tags.tier // "-"' 2>/dev/null)
  tags_service=$(echo "$run_json" | jq -r '.tags.service // "-"' 2>/dev/null)

  local elapsed slabel
  elapsed=$(calc_elapsed "$started_at" "$ended_at")
  slabel=$(status_label "$run_status")

  local avg p90 p95 p99 reqs fail_pct checks_pass checks_fail checks_total iters
  avg=$(echo "$metrics_json" | jq -r '.metrics.http_req_duration.values.avg // 0' 2>/dev/null)
  p90=$(echo "$metrics_json" | jq -r '.metrics.http_req_duration.values["p(90)"] // 0' 2>/dev/null)
  p95=$(echo "$metrics_json" | jq -r '.metrics.http_req_duration.values["p(95)"] // 0' 2>/dev/null)
  p99=$(echo "$metrics_json" | jq -r '.metrics.http_req_duration.values["p(99)"] // 0' 2>/dev/null)
  reqs=$(echo "$metrics_json" | jq -r '.metrics.http_reqs.values.count // 0' 2>/dev/null)
  iters=$(echo "$metrics_json" | jq -r '.metrics.iterations.values.count // 0' 2>/dev/null)
  fail_pct=$(printf "%.1f%%" "$(echo "$(echo "$metrics_json" | jq -r '.metrics.http_req_failed.values.rate // 0') * 100" | bc -l 2>/dev/null || echo "0")")
  checks_pass=$(echo "$metrics_json" | jq -r '.metrics.checks.values.passes // 0' 2>/dev/null)
  checks_fail=$(echo "$metrics_json" | jq -r '.metrics.checks.values.fails // 0' 2>/dev/null)
  checks_total=$((checks_pass + checks_fail))

  printf "  %-4s  %-32s  T:%-2s  VUs:%-3s  %-6s  Iters:%-5s  Reqs:%-5s  Avg:%-7s  P90:%-7s  P95:%-7s  P99:%-7s  Fail:%-5s  Checks:%s/%s\n" \
    "$slabel" "$test_name" "$tags_tier" "$vus" "$elapsed" \
    "$(printf "%.0f" "$iters")" "$(printf "%.0f" "$reqs")" \
    "$(fmt_ms "$avg")" "$(fmt_ms "$p90")" "$(fmt_ms "$p95")" "$(fmt_ms "$p99")" \
    "$fail_pct" "$checks_pass" "$checks_total"
}

# ────────────────────────────────────────────────────────────────
# Detailed view per run
# ────────────────────────────────────────────────────────────────

show_run_detailed() {
  local run_id="$1"
  local run_json metrics_json

  run_json=$(fetch_run "$run_id")
  metrics_json=$(fetch_metrics "$run_id")

  local test_name run_status started_at ended_at duration_sec vus
  local tags_tier tags_env tags_service tags_type
  test_name=$(echo "$run_json" | jq -r '.name // .test_name // "unknown"')
  run_status=$(echo "$run_json" | jq -r '.run_status // 0')
  started_at=$(echo "$run_json" | jq -r '.started // .created // "?"')
  ended_at=$(echo "$run_json" | jq -r '.ended // "null"')
  duration_sec=$(echo "$run_json" | jq -r '.duration // 0')
  vus=$(echo "$run_json" | jq -r '.vus // 0')
  tags_tier=$(echo "$run_json" | jq -r '.tags.tier // "-"' 2>/dev/null)
  tags_env=$(echo "$run_json" | jq -r '.tags.env // "-"' 2>/dev/null)
  tags_service=$(echo "$run_json" | jq -r '.tags.service // "-"' 2>/dev/null)
  tags_type=$(echo "$run_json" | jq -r '.tags.type // "-"' 2>/dev/null)

  local elapsed slabel
  elapsed=$(calc_elapsed "$started_at" "$ended_at")
  slabel=$(status_label "$run_status")

  echo ""
  echo "  ================================================================"
  printf "    %s  %s\n" "$slabel" "$test_name"
  echo "  ================================================================"
  printf "    Run ID:   %-20s  Service: %-15s  Type: %s\n" "$run_id" "$tags_service" "$tags_type"
  printf "    Tier:     %-20s  Env:     %-15s  VUs:  %s\n" "$tags_tier" "$tags_env" "$vus"
  printf "    Started:  %s\n" "$started_at"
  printf "    Ended:    %s\n" "$ended_at"
  printf "    Elapsed:  %s\n" "$elapsed"
  echo ""

  if ! echo "$metrics_json" | jq -e '.metrics' > /dev/null 2>&1; then
    echo "    (metrics not available yet)"
    return
  fi

  # ── Execution Overview ──
  echo "    Execution"
  echo "$HR"
  local iters iter_dur data_recv data_sent
  iters=$(echo "$metrics_json" | jq -r '.metrics.iterations.values.count // 0')
  iter_dur=$(echo "$metrics_json" | jq -r '.metrics.iteration_duration.values.avg // 0')
  data_recv=$(echo "$metrics_json" | jq -r '.metrics.data_received.values.count // 0')
  data_sent=$(echo "$metrics_json" | jq -r '.metrics.data_sent.values.count // 0')
  printf "    Iterations: %-8s  Avg iteration: %-10s  Data recv: %-10s  Data sent: %s\n" \
    "$(printf "%.0f" "$iters")" "$(fmt_ms "$iter_dur")" \
    "$(fmt_bytes "$data_recv")" "$(fmt_bytes "$data_sent")"
  echo ""

  # ── HTTP Latency (overall) ──
  echo "    HTTP Latency"
  echo "$HR"
  print_metric_row "http_req_duration (all)" "$metrics_json" ".metrics.http_req_duration"

  # Per-scenario sub-metrics
  local scenario_keys
  scenario_keys=$(echo "$metrics_json" | jq -r '.metrics | keys[]' 2>/dev/null | grep '^http_req_duration{' || true)
  for key in $scenario_keys; do
    local jq_key
    jq_key=$(echo "$key" | sed 's/"/\\"/g')
    print_metric_row "  $key" "$metrics_json" ".metrics[\"${jq_key}\"]"
  done
  echo ""

  # ── HTTP Requests & Errors ──
  echo "    HTTP Requests"
  echo "$HR"
  local reqs failed_rate
  reqs=$(echo "$metrics_json" | jq -r '.metrics.http_reqs.values.count // 0')
  failed_rate=$(echo "$metrics_json" | jq -r '.metrics.http_req_failed.values.rate // 0')
  local reqs_per_sec
  reqs_per_sec=$(echo "$metrics_json" | jq -r '.metrics.http_reqs.values.rate // 0')
  printf "    Total: %-8s  Rate: %.1f req/s  Fail rate: %.2f%%\n" \
    "$(printf "%.0f" "$reqs")" "$reqs_per_sec" \
    "$(echo "$failed_rate * 100" | bc -l 2>/dev/null || echo "0")"
  echo ""

  # ── Checks ──
  echo "    Checks"
  echo "$HR"
  local checks_passes checks_fails
  checks_passes=$(echo "$metrics_json" | jq -r '.metrics.checks.values.passes // 0')
  checks_fails=$(echo "$metrics_json" | jq -r '.metrics.checks.values.fails // 0')
  local checks_total=$((checks_passes + checks_fails))
  local checks_pct="N/A"
  if [ "$checks_total" -gt 0 ]; then
    checks_pct=$(printf "%.1f%%" "$(echo "$checks_passes * 100 / $checks_total" | bc -l 2>/dev/null || echo "0")")
  fi
  printf "    Passed: %-6s  Failed: %-6s  Total: %-6s  Rate: %s\n" \
    "$checks_passes" "$checks_fails" "$checks_total" "$checks_pct"
  echo ""

  # ── Custom Trend Metrics ──
  local custom_trends
  custom_trends=$(echo "$metrics_json" | jq -r '
    .metrics | to_entries[]
    | select(.key | test("^(http_|iteration_|data_|vus|checks$|ws_)") | not)
    | select(.value.type == "trend" or (.value.values | has("avg")))
    | .key
  ' 2>/dev/null | sort || true)

  if [ -n "$custom_trends" ]; then
    echo "    Custom Trend Metrics"
    echo "$HR"
    for metric in $custom_trends; do
      local jq_key
      jq_key=$(echo "$metric" | sed 's/"/\\"/g')
      print_metric_row "$metric" "$metrics_json" ".metrics[\"${jq_key}\"]"
    done
    echo ""
  fi

  # ── Custom Rate Metrics ──
  local custom_rates
  custom_rates=$(echo "$metrics_json" | jq -r '
    .metrics | to_entries[]
    | select(.key | test("^(http_|iteration_|data_|vus|checks$|ws_)") | not)
    | select(.value.type == "rate" or (.value.values | has("rate") and (.value.values | has("avg") | not)))
    | .key
  ' 2>/dev/null | sort || true)

  if [ -n "$custom_rates" ]; then
    echo "    Custom Rate Metrics"
    echo "$HR"
    for metric in $custom_rates; do
      local jq_key
      jq_key=$(echo "$metric" | sed 's/"/\\"/g')
      print_rate_row "$metric" "$metrics_json" ".metrics[\"${jq_key}\"]"
    done
    echo ""
  fi

  # ── Custom Counter Metrics ──
  local custom_counters
  custom_counters=$(echo "$metrics_json" | jq -r '
    .metrics | to_entries[]
    | select(.key | test("^(http_|iteration_|data_|vus|checks$|ws_)") | not)
    | select(.value.type == "counter" or (.value.values | has("count") and (.value.values | has("avg") | not) and (.value.values | has("rate") | not)))
    | .key
  ' 2>/dev/null | sort || true)

  if [ -n "$custom_counters" ]; then
    echo "    Custom Counters"
    echo "$HR"
    for metric in $custom_counters; do
      local jq_key
      jq_key=$(echo "$metric" | sed 's/"/\\"/g')
      print_counter_row "$metric" "$metrics_json" ".metrics[\"${jq_key}\"]"
    done
    echo ""
  fi

  # ── WebSocket (if present) ──
  local ws_keys
  ws_keys=$(echo "$metrics_json" | jq -r '.metrics | keys[]' 2>/dev/null | grep '^ws_' | sort || true)
  if [ -n "$ws_keys" ]; then
    echo "    WebSocket"
    echo "$HR"
    for ws_key in $ws_keys; do
      local ws_has_avg
      ws_has_avg=$(echo "$metrics_json" | jq -r ".metrics[\"${ws_key}\"].values.avg // \"none\"")
      if [ "$ws_has_avg" != "none" ]; then
        print_metric_row "$ws_key" "$metrics_json" ".metrics[\"${ws_key}\"]"
      else
        local ws_count
        ws_count=$(echo "$metrics_json" | jq -r ".metrics[\"${ws_key}\"].values.count // 0")
        printf "  %-36s  count=%s\n" "$ws_key" "$(printf "%.0f" "$ws_count")"
      fi
    done
    echo ""
  fi

  # ── Thresholds ──
  local thresholds
  thresholds=$(echo "$run_json" | jq -r '.thresholds // empty | to_entries[] | "\(.key)|\(.value.result // "unknown")"' 2>/dev/null || true)
  if [ -n "$thresholds" ]; then
    local thr_pass=0 thr_fail=0
    echo "    Thresholds"
    echo "$HR"
    echo "$thresholds" | while IFS='|' read -r thr_name thr_result; do
      local thr_icon="PASS"
      [ "$thr_result" = "false" ] && thr_icon="FAIL"
      printf "    %s  %s\n" "$thr_icon" "$thr_name"
    done
    thr_pass=$(echo "$thresholds" | grep -c '|true' || echo "0")
    thr_fail=$(echo "$thresholds" | grep -c '|false' || echo "0")
    echo ""
    printf "    Thresholds: %s passed, %s failed\n" "$thr_pass" "$thr_fail"
    echo ""
  fi

  # ── Save ──
  if [ "$SAVE" = true ]; then
    local save_dir="/tmp/k6-cloud-results"
    mkdir -p "$save_dir"
    echo "$run_json" | jq '.' > "${save_dir}/run-${run_id}.json"
    echo "$metrics_json" | jq '.' > "${save_dir}/run-${run_id}-metrics.json" 2>/dev/null || true
    echo "    Saved: ${save_dir}/run-${run_id}*.json"
  fi
}

# ────────────────────────────────────────────────────────────────
# Markdown report generation (--markdown)
# Uses the v5 OData API which returns richer run metadata.
# ────────────────────────────────────────────────────────────────

generate_markdown_report() {
  local runs_v5_json_file="$1"
  local report_date tier_label

  report_date=$(date '+%Y-%m-%d')
  tier_label="${TIER:-s}"

  # Determine output path
  local md_file
  if [ -n "$MARKDOWN_OUT" ]; then
    md_file="$MARKDOWN_OUT"
  else
    md_file="${REPO_ROOT}/docs/superpowers/specs/${report_date}-load-test-results-tier-${tier_label}.md"
  fi
  mkdir -p "$(dirname "$md_file")"

  # Parse runs into arrays using python for reliable JSON handling
  local run_data
  run_data=$(python3 << PYEOF
import json, sys, urllib.request
from datetime import datetime

TOKEN = "${K6_CLOUD_TOKEN}"
PROJECT_ID = "${K6_CLOUD_PROJECT_ID}"
V5_BASE = "${API_V5_BASE}"

with open("${runs_v5_json_file}") as f:
    runs_json = json.load(f)
all_runs = runs_json.get('value', [])

if not all_runs:
    print("NO_RUNS")
    sys.exit(0)

# Sort by started time (newest first for dedup, then reverse for output)
all_runs.sort(key=lambda r: r.get('started', ''), reverse=True)

# Deduplicate: keep only the latest run per test name
seen = set()
runs = []
for r in all_runs:
    cloud = r.get('config', {}).get('options', {}).get('cloud', {})
    name = cloud.get('name', 'unknown')
    if name in seen or name in ('unknown', '?'):
        continue
    seen.add(name)
    runs.append(r)

# Reverse to chronological order
runs.sort(key=lambda r: r.get('started', ''))

# Collect data per run
results = []
total_vus = 0
total_iters = 0
suite_start = None
suite_end = None

for r in runs:
    rid = r.get('id', '?')
    cloud = r.get('config', {}).get('options', {}).get('cloud', {})
    name = cloud.get('name', 'unknown')
    tags = cloud.get('tags', {})
    tier = tags.get('tier', '?')
    stype = tags.get('type', '?')
    started = r.get('started', '?')
    ended = r.get('ended', '?')
    vus = r.get('vus', 0) or 0
    run_status = r.get('run_status', 0)
    result_status = r.get('result_status', 'unknown')

    # Track suite boundaries
    if suite_start is None or started < suite_start:
        suite_start = started
    if suite_end is None or ended > suite_end:
        suite_end = ended

    total_vus += vus

    # Calculate duration
    duration_str = '?'
    try:
        s = datetime.fromisoformat(started.replace('Z', '+00:00').replace('.000000Z', '+00:00'))
        e = datetime.fromisoformat(ended.replace('Z', '+00:00').replace('.000000Z', '+00:00'))
        dur_sec = int((e - s).total_seconds())
        mins = dur_sec // 60
        secs = dur_sec % 60
        duration_str = f"{mins}m {secs}s"
    except:
        pass

    # Fetch iterations from v5 aggregate API
    iters = 0
    try:
        start_q = started.split('+')[0].split('.')[0] + 'Z'
        end_q = ended.split('+')[0].split('.')[0] + 'Z'
        url = f"{V5_BASE}/test_runs({rid})/query_aggregate_k6(metric='iterations',query='value()',start={start_q},end={end_q})"
        req = urllib.request.Request(url, headers={"Authorization": f"Token {TOKEN}"})
        resp = urllib.request.urlopen(req, timeout=10)
        data = json.loads(resp.read())
        iters = int(float(data["data"]["result"][0]["values"][0][1]))
    except:
        pass

    total_iters += iters

    # Fetch http_reqs count
    reqs = 0
    try:
        url = f"{V5_BASE}/test_runs({rid})/query_aggregate_k6(metric='http_reqs',query='value()',start={start_q},end={end_q})"
        req = urllib.request.Request(url, headers={"Authorization": f"Token {TOKEN}"})
        resp = urllib.request.urlopen(req, timeout=10)
        data = json.loads(resp.read())
        reqs = int(float(data["data"]["result"][0]["values"][0][1]))
    except:
        pass

    # Extract start/end time portion only
    start_time = started.split('T')[1].split('+')[0].split('.')[0] + 'Z' if 'T' in started else started
    end_time = ended.split('T')[1].split('+')[0].split('.')[0] + 'Z' if 'T' in ended else ended

    results.append({
        'rid': rid,
        'name': name,
        'tier': tier,
        'type': stype,
        'vus': vus,
        'iters': iters,
        'reqs': reqs,
        'started': started,
        'ended': ended,
        'start_time': start_time,
        'end_time': end_time,
        'duration': duration_str,
        'run_status': run_status,
        'result_status': result_status,
    })

# Calculate suite wall time
suite_wall = '?'
try:
    s = datetime.fromisoformat(suite_start.replace('Z', '+00:00').replace('.000000Z', '+00:00'))
    e = datetime.fromisoformat(suite_end.replace('Z', '+00:00').replace('.000000Z', '+00:00'))
    dur_sec = int((e - s).total_seconds())
    hours = dur_sec // 3600
    mins = (dur_sec % 3600) // 60
    if hours > 0:
        suite_wall = f"~{hours}h {mins}m"
    else:
        suite_wall = f"{mins}m"
except:
    pass

# Output as JSON for shell to consume
output = {
    'results': results,
    'total_vus': total_vus,
    'total_iters': total_iters,
    'suite_start': suite_start or '?',
    'suite_end': suite_end or '?',
    'suite_wall': suite_wall,
}
print(json.dumps(output))
PYEOF
  )

  if [ "$run_data" = "NO_RUNS" ]; then
    echo "  No runs found — cannot generate markdown report."
    return
  fi

  # Write intermediate data to temp file for safe JSON transfer
  local data_tmp
  data_tmp=$(mktemp /tmp/k6-md-data-XXXXXX.json)
  echo "$run_data" > "$data_tmp"

  # Generate the markdown file using python
  python3 << PYEOF
import json, sys
from datetime import datetime

with open("${data_tmp}") as f:
    data = json.load(f)
results = data['results']
total_vus = data['total_vus']
total_iters = data['total_iters']
suite_start = data['suite_start']
suite_end = data['suite_end']
suite_wall = data['suite_wall']

tier = "${TIER:-s}"
tier_names = {'s': 'S (Smoke)', 'm': 'M (Medium)', 'l': 'L (Large)', 'xl': 'XL (Extra-Large)'}
tier_label = tier_names.get(tier, tier.upper())
report_date = "$(date '+%Y-%m-%d')"
env = "${ENV:-staging}"
target = "${INGRESS_BASE:-${STAGING_URL:-unknown}}"

passed = sum(1 for r in results if r['run_status'] == 2)
failed = sum(1 for r in results if r['run_status'] == 3)
total = len(results)

svc_runs = [r for r in results if r['type'] in ('service', 'per-service')]
int_runs = [r for r in results if r['type'] == 'integration']
svc_passed = sum(1 for r in svc_runs if r['run_status'] == 2)
svc_failed = sum(1 for r in svc_runs if r['run_status'] == 3)
int_passed = sum(1 for r in int_runs if r['run_status'] == 2)
int_failed = sum(1 for r in int_runs if r['run_status'] == 3)

def fmt_num(n):
    return f"{n:,}"

lines = []
lines.append(f"# ABL Platform Load Test Results — Tier {tier_label}")
lines.append("")
lines.append(f"**Date:** {report_date}")
lines.append(f"**Suite Start:** {suite_start}")
lines.append(f"**Suite End:** {suite_end}")
lines.append(f"**Wall Time:** {suite_wall}")
lines.append(f"**Target:** \`{target}\`")
lines.append(f"**Tier:** {tier_label}")
lines.append(f"**Environment:** {env}")
lines.append("")
lines.append("---")
lines.append("")

# Execution Overview table
lines.append("## Execution Overview")
lines.append("")
lines.append("| Test | Type | VUs | Iterations | HTTP Reqs | Start (UTC) | End (UTC) | Duration |")
lines.append("|---|---|---|---|---|---|---|---|")
for r in results:
    lines.append(f"| {r['name']} | {r['type']} | {r['vus']} | {fmt_num(r['iters'])} | {fmt_num(r['reqs'])} | {r['start_time']} | {r['end_time']} | {r['duration']} |")
lines.append(f"| **Totals** | | **{total_vus}** | **{fmt_num(total_iters)}** | | | | **{suite_wall}** |")
lines.append("")
lines.append("---")
lines.append("")

# Executive Summary
pct = f"{passed * 100 // total}%" if total > 0 else "0%"
lines.append("## Executive Summary")
lines.append("")
lines.append("| Category | Tests Run | Passed | Failed | Pass Rate |")
lines.append("|---|---|---|---|---|")
lines.append(f"| **Services** | {len(svc_runs)} | {svc_passed} | {svc_failed} | {svc_passed * 100 // len(svc_runs) if svc_runs else 0}% |")
lines.append(f"| **Integrations** | {len(int_runs)} | {int_passed} | {int_failed} | {int_passed * 100 // len(int_runs) if int_runs else 0}% |")
lines.append(f"| **Total** | **{total}** | **{passed}** | **{failed}** | **{pct}** |")
lines.append("")
lines.append("---")
lines.append("")

# Per-test sections
lines.append("## Test Results")
lines.append("")
for r in results:
    status = "PASS" if r['run_status'] == 2 else "FAIL" if r['run_status'] == 3 else "UNKNOWN"
    lines.append(f"### {r['name']} — {status}")
    lines.append("")
    lines.append(f"> **Run ID:** {r['rid']} | **VUs:** {r['vus']} | **Iterations:** {fmt_num(r['iters'])} | **HTTP Reqs:** {fmt_num(r['reqs'])} | **Start:** {r['start_time']} | **End:** {r['end_time']} | **Duration:** {r['duration']}")
    lines.append("")

# Dashboard link
lines.append("---")
lines.append("")
lines.append(f"**k6 Cloud Dashboard:** https://app.k6.io/projects/${K6_CLOUD_PROJECT_ID}")
lines.append("")

with open("$md_file", 'w') as f:
    f.write('\n'.join(lines))

print(f"GENERATED:{len(results)}")
PYEOF

  local gen_result=$?
  rm -f "$data_tmp"
  if [ $gen_result -eq 0 ]; then
    echo "  Markdown report saved: ${md_file}"
  else
    echo "  ERROR: Failed to generate markdown report"
  fi
}

# ────────────────────────────────────────────────────────────────
# Main
# ────────────────────────────────────────────────────────────────

# ── Markdown mode: uses v5 API exclusively ──
if [ "$MARKDOWN" = true ]; then
  echo ""
  echo "  Fetching runs from k6 Cloud (v5 API)..."

  v5_tmp=$(mktemp /tmp/k6-v5-runs-XXXXXX.json)
  curl -sS -H "$AUTH_HEADER" \
    "${API_V5_BASE}/projects/${K6_CLOUD_PROJECT_ID}/test_runs?page_size=${LAST_N}" \
    > "$v5_tmp" 2>/dev/null

  v5_count=$(python3 -c "import json; print(len(json.load(open('${v5_tmp}')).get('value',[])))" 2>/dev/null || echo "0")

  if [ "$v5_count" = "0" ]; then
    echo "  No runs found for project ${K6_CLOUD_PROJECT_ID}"
    rm -f "$v5_tmp"
    exit 0
  fi

  echo "  Found ${v5_count} runs. Generating markdown report..."
  generate_markdown_report "$v5_tmp"
  rm -f "$v5_tmp"
  exit 0
fi

REPORT_TIME=$(date '+%Y-%m-%d %H:%M:%S')

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║              k6 Cloud Benchmark Results Report              ║"
echo "╠══════════════════════════════════════════════════════════════╣"
printf "║  Project:   %-48s║\n" "${K6_CLOUD_PROJECT_ID}"
printf "║  Generated: %-48s║\n" "${REPORT_TIME}"
printf "║  Env:       %-48s║\n" "${ENV:-staging}"
printf "║  Tier:      %-48s║\n" "${TIER:-s}"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

if [ -n "$RUN_ID" ]; then
  show_run_detailed "$RUN_ID"
else
  runs_json=$(curl -sS -H "$AUTH_HEADER" \
    "${API_BASE}/projects/${K6_CLOUD_PROJECT_ID}/test-runs?page_size=${LAST_N}&order_by=-started")

  run_count=$(echo "$runs_json" | jq -r '.test_runs | length' 2>/dev/null || echo "0")

  if [ "$run_count" = "0" ]; then
    echo "  No test runs found for project ${K6_CLOUD_PROJECT_ID}"
    echo ""
    echo "  Run a test first:"
    echo "    ./benchmarks/scripts/cloud-run.sh benchmarks/services/runtime.ts"
    exit 0
  fi

  # Collect run IDs
  run_ids=()
  while IFS= read -r rid; do
    run_ids+=("$rid")
  done < <(echo "$runs_json" | jq -r '.test_runs[] | "\(.id)"')

  # ── Section 1: Compact Overview ──
  if [ "$MODE" != "detailed" ]; then
    echo "┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐"
    echo "│  COMPACT OVERVIEW — ${run_count} runs                                                                                                              │"
    echo "└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘"
    echo ""
    printf "  %-4s  %-32s  %-4s  %-4s  %-6s  %-8s  %-8s  %-9s  %-9s  %-9s  %-9s  %-6s  %s\n" \
      "STAT" "TEST NAME" "TIER" "VUs" "TIME" "ITERS" "REQS" "AVG" "P90" "P95" "P99" "FAIL%" "CHECKS"
    printf "  %-4s  %-32s  %-4s  %-4s  %-6s  %-8s  %-8s  %-9s  %-9s  %-9s  %-9s  %-6s  %s\n" \
      "────" "────────────────────────────────" "────" "────" "──────" "────────" "────────" "─────────" "─────────" "─────────" "─────────" "──────" "──────"

    for rid in "${run_ids[@]}"; do
      show_run_compact "$rid"
    done
    echo ""
  fi

  # ── Section 2: Detailed Breakdown ──
  if [ "$MODE" != "compact" ]; then
    echo "┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐"
    echo "│  DETAILED BREAKDOWN                                                                                                                            │"
    echo "└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘"

    for rid in "${run_ids[@]}"; do
      show_run_detailed "$rid"
    done
  fi

  # ── Section 3: Summary ──
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  SUMMARY                                                    ║"
  echo "╠══════════════════════════════════════════════════════════════╣"

  pass_count=$(echo "$runs_json" | jq '[.test_runs[] | select(.run_status == 2)] | length')
  fail_count=$(echo "$runs_json" | jq '[.test_runs[] | select(.run_status == 3)] | length')
  other_count=$(echo "$runs_json" | jq '[.test_runs[] | select(.run_status != 2 and .run_status != 3)] | length')

  printf "║  Total:   %-50s║\n" "$run_count"
  printf "║  Passed:  %-50s║\n" "$pass_count"
  printf "║  Failed:  %-50s║\n" "$fail_count"
  printf "║  Other:   %-50s║\n" "$other_count"
  echo "╠══════════════════════════════════════════════════════════════╣"
  printf "║  Dashboard: %-48s║\n" "https://app.k6.io/projects/${K6_CLOUD_PROJECT_ID}"
  echo "╚══════════════════════════════════════════════════════════════╝"
fi

echo ""

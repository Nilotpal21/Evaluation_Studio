#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# cluster-poll.sh — Continuous Kubernetes fallback collector for load testing
#
# Polls infrastructure components every POLL_INTERVAL seconds and writes each
# snapshot as JSON. Also fetches live k6 Cloud run status + metrics so the agent
# can supervise the run from a single poll artifact.
#
# Groundcover remains the primary source for saturation-finder. This script is
# the Kubernetes/k6 fallback collector when Groundcover is unavailable or a
# mandatory cluster signal needs a second source. Mandatory metrics are still
# mandatory: a missing value in this script is an explicit missing source, not a
# silent pass.
#
# What it collects per poll:
#   - Runtime: per-pod CPU/memory (kubectl top), HPA state, readiness,
#     restarts, OOM/waiting reasons, resource requests/limits
#   - Runtime /health via kubectl port-forward: heap, RSS, cached sessions,
#     event loop, GC, DB/Redis/ClickHouse status. This is fallback telemetry,
#     not external reachability evidence.
#   - MongoDB: per-pod CPU/memory, readiness, restarts, events
#   - Redis: per-pod CPU/memory, readiness, restarts, events
#   - Kafka: per-pod CPU/memory, pod count
#   - ClickHouse: per-pod CPU/memory, pod count
#   - OpenSearch: per-pod CPU/memory, pod count
#   - Neo4j: per-pod CPU/memory, pod count
#   - Ingress-NGINX: per-pod CPU/memory, pod count
#   - Nodes: per-node CPU/memory utilization, capacity, allocatable, pool label
#   - Cluster: pending pods, PDB status, recent events (OOM, evictions, scaling)
#   - k6: run status, current VUs, current throughput, error rate, p95 latency
#
# Usage:
#   ./benchmarks/scripts/cluster-poll.sh
#   RUN_ID=7300001 ./benchmarks/scripts/cluster-poll.sh
#   RUN_ID=my-label K6_RUN_ID=7300001 ./benchmarks/scripts/cluster-poll.sh
#   RUN_ID=launch-dev-20260504 K6_RUN_ID=pending ./benchmarks/scripts/cluster-poll.sh
#   echo 7300001 > benchmarks/results/polls/launch-dev-20260504/k6-run-id
#
# Output:
#   benchmarks/results/polls/<RUN_ID>/
#     poll-0001.json  ... poll-NNNN.json
#     summary.jsonl    (one JSON object per line — append-only, no rewrite)
#     summary.json     (built at shutdown from summary.jsonl — full array)
#
# Stop: Ctrl+C, or use the --stop subcommand:
#   ./benchmarks/scripts/cluster-poll.sh --stop <RUN_ID>
#   (reads the pidfile and sends SIGTERM)
# =============================================================================

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# --- Stop subcommand: kill a running poller by RUN_ID -------------------------
if [ "${1:-}" = "--stop" ]; then
  STOP_RUN_ID="${2:-}"
  if [ -z "$STOP_RUN_ID" ]; then
    echo "Usage: $0 --stop <RUN_ID>"
    echo "  Stops a running poller by reading its pidfile."
    exit 1
  fi
  PIDFILE="${REPO_ROOT}/benchmarks/results/polls/${STOP_RUN_ID}/poller.pid"
  if [ ! -f "$PIDFILE" ]; then
    echo "No pidfile found at $PIDFILE — poller may not be running."
    exit 1
  fi
  PID=$(cat "$PIDFILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "Stopping poller (PID $PID) for run $STOP_RUN_ID..."
    kill "$PID"
    echo "Sent SIGTERM to PID $PID."
  else
    echo "PID $PID is not running. Removing stale pidfile."
    rm -f "$PIDFILE"
  fi
  exit 0
fi
K6_CONFIG_FILE="${REPO_ROOT}/benchmarks/config/cloud.env"

# Environment — override via ENV=qa, ENV=dev, etc. or set CONTEXT/NS directly.
# Save caller ENV before cloud.env can overwrite it (cloud.env may set ENV=abl-dev).
POLLER_ENV="${ENV:-dev}"
CONTEXT="${CONTEXT:-aks-abl-${POLLER_ENV}-centralus}"
NS="${NS:-abl-platform-${POLLER_ENV}}"
POLL_INTERVAL="${POLL_INTERVAL:-20}"
RUN_ID="${RUN_ID:-$(date +%s)}"
OUTPUT_DIR="${OUTPUT_DIR:-${REPO_ROOT}/benchmarks/results/polls/${RUN_ID}}"
MAX_POLLS="${MAX_POLLS:-0}"
HEALTH_PORT="${HEALTH_PORT:-13112}"
K6_API_BASE="${K6_API_BASE:-https://api.k6.io/cloud/v5}"
K6_RUN_ID="${K6_RUN_ID:-$RUN_ID}"   # k6 Cloud test run ID — defaults to RUN_ID
K6_RUN_ID_FILE="${K6_RUN_ID_FILE:-${OUTPUT_DIR}/k6-run-id}"
K6_METRIC_STEP="${K6_METRIC_STEP:-20}"
K6_LOOKBACK_SECONDS="${K6_LOOKBACK_SECONDS:-180}"
K6_API_TIMEOUT="${K6_API_TIMEOUT:-4}"  # per-call timeout for k6 API (seconds)

# Step-aware metadata — pass the same values used to launch k6
# e.g. K6_STEPS=200,500,800,1000,1200,1500 K6_STEP_DURATION=5 K6_RAMP=120
K6_STEPS="${K6_STEPS:-${STEPS:-}}"
K6_STEP_DURATION="${K6_STEP_DURATION:-${STEP_DURATION_MINUTES:-5}}"
K6_RAMP="${K6_RAMP:-${RAMP_SECONDS:-120}}"

# Derive HPA name from namespace instead of hardcoding
HPA_NAME="${HPA_NAME:-${NS}-runtime}"

# Labels are intentionally environment-driven. Defaults derive from NS so they
# work across dev/qa/staging without manual override.
RUNTIME_LABEL="${RUNTIME_LABEL:-app.kubernetes.io/component=runtime}"
MONGODB_LABEL="${MONGODB_LABEL:-app=${NS}-mongodb-svc}"
REDIS_LABEL="${REDIS_LABEL:-app.kubernetes.io/name=redis}"
KAFKA_LABEL="${KAFKA_LABEL:-strimzi.io/cluster}"
CLICKHOUSE_LABEL="${CLICKHOUSE_LABEL:-app.kubernetes.io/name=clickhouse}"
OPENSEARCH_LABEL="${OPENSEARCH_LABEL:-app.kubernetes.io/component=opensearch}"
NEO4J_LABEL="${NEO4J_LABEL:-app.kubernetes.io/component=neo4j}"
INGRESS_LABEL="${INGRESS_LABEL:-app.kubernetes.io/name=ingress-nginx}"
# Opt-in components — the saturation-finder skill uses Runtime, MongoDB, Redis,
# ClickHouse. Enable these only when the skill or operator explicitly needs them.
ENABLE_KAFKA="${ENABLE_KAFKA:-false}"
ENABLE_OPENSEARCH="${ENABLE_OPENSEARCH:-false}"
ENABLE_NEO4J="${ENABLE_NEO4J:-false}"
ENABLE_INGRESS="${ENABLE_INGRESS:-false}"
EVENTS_LIMIT="${EVENTS_LIMIT:-100}"
ENABLE_RUNTIME_HEALTH_FALLBACK="${ENABLE_RUNTIME_HEALTH_FALLBACK:-true}"
ENABLE_COROOT="${ENABLE_COROOT:-true}"
COROOT_LOOKBACK="${COROOT_LOOKBACK:-120}"  # Minimum 90s (Coroot 404s on <90s windows). Default 120s for safety.
COROOT_SERVICES="${COROOT_SERVICES:-runtime,mongodb,redis,clickhouse}"

if [ -z "${K6_CLOUD_TOKEN:-}" ] && [ -f "$K6_CONFIG_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$K6_CONFIG_FILE"
  set +a
fi

mkdir -p "$OUTPUT_DIR"

POLL_COUNT=0
SUMMARY_JSONL="${OUTPUT_DIR}/summary.jsonl"
SUMMARY_FILE="${OUTPUT_DIR}/summary.json"
PIDFILE="${OUTPUT_DIR}/poller.pid"
PF_PID=""
TMPDIR_POLL=$(mktemp -d)
HEALTH_CONSECUTIVE_FAILURES=0
HEALTH_POD_INDEX=0          # Cycle through runtime pods for /health
HEALTH_POD_LIST=()          # Populated by start_port_forward

refresh_k6_run_id() {
  if [ ! -f "$K6_RUN_ID_FILE" ]; then
    return
  fi

  local next_id
  next_id="$(tr -d '[:space:]' < "$K6_RUN_ID_FILE" 2>/dev/null || true)"
  if [ -n "$next_id" ] && [ "$next_id" != "$K6_RUN_ID" ]; then
    K6_RUN_ID="$next_id"
    echo "  k6 Run ID updated from $K6_RUN_ID_FILE: $K6_RUN_ID"
  fi
}

# Check for stale pidfile from a prior crash
if [ -f "$PIDFILE" ]; then
  OLD_PID=$(cat "$PIDFILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "ERROR: Another poller (PID $OLD_PID) is already running for this RUN_ID."
    echo "  Stop it first: $0 --stop $RUN_ID"
    exit 1
  else
    echo "WARN: Removing stale pidfile from PID $OLD_PID (not running)."
    rm -f "$PIDFILE"
  fi
fi

# Write pidfile so the agent can stop us non-interactively
echo $$ > "$PIDFILE"

# Initialize summary.jsonl (append-only — one JSON object per line)
: > "$SUMMARY_JSONL"

# --- Port-forward for runtime /health ---------------------------------------

start_port_forward() {
  if [ "$ENABLE_RUNTIME_HEALTH_FALLBACK" != "true" ]; then
    return
  fi

  # Refresh pod list on every call so new/restarted pods are picked up
  local raw
  raw=$(kubectl --context "$CONTEXT" -n "$NS" get pods \
    -l "$RUNTIME_LABEL" \
    --field-selector=status.phase=Running \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null || echo "")

  HEALTH_POD_LIST=()
  while IFS= read -r line; do
    [ -n "$line" ] && HEALTH_POD_LIST+=("$line")
  done <<< "$raw"

  if [ ${#HEALTH_POD_LIST[@]} -eq 0 ]; then
    echo "WARN: No running runtime pods — skipping /health scrape"
    return
  fi

  # Cycle to the next pod (round-robin across all runtime pods)
  if [ "$HEALTH_POD_INDEX" -ge "${#HEALTH_POD_LIST[@]}" ]; then
    HEALTH_POD_INDEX=0
  fi
  local pod="${HEALTH_POD_LIST[$HEALTH_POD_INDEX]}"
  HEALTH_POD_INDEX=$(( (HEALTH_POD_INDEX + 1) % ${#HEALTH_POD_LIST[@]} ))

  [ -n "$PF_PID" ] && kill "$PF_PID" 2>/dev/null || true
  kubectl --context "$CONTEXT" -n "$NS" port-forward "$pod" "${HEALTH_PORT}:3112" &>/dev/null &
  PF_PID=$!
  HEALTH_CONSECUTIVE_FAILURES=0
  echo "  /health port-forward → $pod (${HEALTH_POD_INDEX}/${#HEALTH_POD_LIST[@]} pods)"
  sleep 2
}

# --- Collector: writes JSON for a component to a temp file ------------------

collect_component() {
  local label="$1"
  local outfile="$2"

  python3 - "$CONTEXT" "$NS" "$label" "$outfile" <<'PYEOF'
import subprocess, json, sys

ctx, ns, label, outfile = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
errors = []

def run(cmd, name):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if r.returncode != 0:
            errors.append({
                "collector": name,
                "returnCode": r.returncode,
                "stderr": r.stderr.strip()[:500],
            })
        return r.stdout.strip()
    except Exception as e:
        errors.append({"collector": name, "error": str(e)})
        return ""

# kubectl top pods
top_raw = run(["kubectl", "--context", ctx, "-n", ns, "top", "pods", "-l", label, "--no-headers"], "topPods")
top = []
usage_by_pod = {}
for line in top_raw.splitlines():
    parts = line.split()
    if len(parts) >= 3:
        row = {"pod": parts[0], "cpu": parts[1], "memory": parts[2]}
        top.append(row)
        usage_by_pod[parts[0]] = {"cpu": parts[1], "memory": parts[2]}

# kubectl get pods — phase, restarts, resources
pods_raw = run(["kubectl", "--context", ctx, "-n", ns, "get", "pods", "-l", label, "-o", "json"], "getPods")
pods = []
if pods_raw:
    try:
        data = json.loads(pods_raw)
        for item in data.get("items", []):
            name = item["metadata"]["name"]
            meta = item.get("metadata", {})
            status = item.get("status", {})
            spec = item.get("spec", {})
            phase = item["status"].get("phase", "Unknown")
            restarts = 0
            ready = True
            oom_killed = False
            waiting_reasons = []
            terminated_reasons = []
            container_statuses = []
            for cs in status.get("containerStatuses", []):
                restarts += cs.get("restartCount", 0)
                if not cs.get("ready", False):
                    ready = False
                state = cs.get("state", {})
                last_state = cs.get("lastState", {})
                waiting = state.get("waiting")
                terminated = state.get("terminated") or last_state.get("terminated")
                if waiting and waiting.get("reason"):
                    waiting_reasons.append(waiting.get("reason"))
                if terminated and terminated.get("reason"):
                    reason = terminated.get("reason")
                    terminated_reasons.append(reason)
                    if reason == "OOMKilled":
                        oom_killed = True
                container_statuses.append({
                    "name": cs.get("name"),
                    "ready": cs.get("ready"),
                    "restartCount": cs.get("restartCount", 0),
                    "state": state,
                    "lastState": last_state,
                })

            containers = spec.get("containers", [])
            resources = {}
            for c in containers:
                res = c.get("resources", {})
                resources[c.get("name", "")] = {
                    "requests": res.get("requests", {}),
                    "limits": res.get("limits", {})
                }
            pods.append({
                "pod": name,
                "phase": phase,
                "ready": ready,
                "restarts": restarts,
                "oomKilled": oom_killed,
                "waitingReasons": waiting_reasons,
                "terminatedReasons": terminated_reasons,
                "node": spec.get("nodeName"),
                "labels": meta.get("labels", {}),
                "usage": usage_by_pod.get(name, {}),
                "resources": resources,
                "containerStatuses": container_statuses
            })
    except Exception as e:
        pods = [{"error": f"parse failed: {e}"}]

result = {"label": label, "top": top, "pods": pods, "errors": errors}
with open(outfile, "w") as f:
    json.dump(result, f)
PYEOF
}

# Collect HPA
collect_hpa() {
  local name="$1"
  local outfile="$2"

  python3 - "$CONTEXT" "$NS" "$name" "$outfile" <<'PYEOF'
import subprocess, json, sys

ctx, ns, name, outfile = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

try:
    r = subprocess.run(
        ["kubectl", "--context", ctx, "-n", ns, "get", "hpa", name, "-o", "json"],
        capture_output=True, text=True, timeout=10
    )
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or f"kubectl returned {r.returncode}")
    h = json.loads(r.stdout)
    spec = h.get("spec", {})
    status = h.get("status", {})

    current_metrics = []
    for m in status.get("currentMetrics", []):
        res = m.get("resource", {})
        current_metrics.append({
            "name": res.get("name", ""),
            "currentUtilization": res.get("current", {}).get("averageUtilization"),
            "currentValue": res.get("current", {}).get("averageValue", "")
        })

    targets = []
    for m in spec.get("metrics", []):
        res = m.get("resource", {})
        targets.append({
            "name": res.get("name", ""),
            "targetUtilization": res.get("target", {}).get("averageUtilization")
        })

    behavior = spec.get("behavior", {})

    out = {
        "minReplicas": spec.get("minReplicas"),
        "maxReplicas": spec.get("maxReplicas"),
        "currentReplicas": status.get("currentReplicas"),
        "desiredReplicas": status.get("desiredReplicas"),
        "currentMetrics": current_metrics,
        "targets": targets,
        "behavior": {
            "scaleUp": behavior.get("scaleUp", {}),
            "scaleDown": behavior.get("scaleDown", {})
        },
        "conditions": [
            {"type": c.get("type",""), "status": c.get("status",""),
             "reason": c.get("reason",""), "message": c.get("message","")}
            for c in status.get("conditions", [])
        ]
    }
except Exception as e:
    out = {"name": name, "error": str(e)}

with open(outfile, "w") as f:
    json.dump(out, f)
PYEOF
}

# Collect Deployment status — complements HPA with rollout state
collect_deployment() {
  local label="$1"
  local outfile="$2"

  python3 - "$CONTEXT" "$NS" "$label" "$outfile" <<'PYEOF'
import subprocess, json, sys

ctx, ns, label, outfile = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

try:
    r = subprocess.run(
        ["kubectl", "--context", ctx, "-n", ns, "get", "deploy", "-l", label, "-o", "json"],
        capture_output=True, text=True, timeout=10
    )
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or f"kubectl returned {r.returncode}")
    data = json.loads(r.stdout)
    deploys = []
    for item in data.get("items", []):
        spec = item.get("spec", {})
        status = item.get("status", {})
        deploys.append({
            "name": item["metadata"]["name"],
            "specReplicas": spec.get("replicas"),
            "statusReplicas": status.get("replicas"),
            "readyReplicas": status.get("readyReplicas"),
            "availableReplicas": status.get("availableReplicas"),
            "updatedReplicas": status.get("updatedReplicas"),
            "unavailableReplicas": status.get("unavailableReplicas"),
            "conditions": [
                {"type": c.get("type",""), "status": c.get("status",""),
                 "reason": c.get("reason",""), "message": c.get("message","")[:200]}
                for c in status.get("conditions", [])
            ],
        })
    out = {"deployments": deploys}
except Exception as e:
    out = {"error": str(e)}

with open(outfile, "w") as f:
    json.dump(out, f)
PYEOF
}

# Collect runtime /health
collect_health() {
  local outfile="$1"
  local raw_file="${TMPDIR_POLL}/health_raw.json"

  if [ "$ENABLE_RUNTIME_HEALTH_FALLBACK" != "true" ]; then
    echo '{"disabled":true,"source":"kubectl-port-forward-runtime-health"}' > "$outfile"
    return
  fi

  # Resolve which pod the port-forward targets
  local health_pod=""
  if [ ${#HEALTH_POD_LIST[@]} -gt 0 ]; then
    local idx=$(( (HEALTH_POD_INDEX + ${#HEALTH_POD_LIST[@]} - 1) % ${#HEALTH_POD_LIST[@]} ))
    health_pod="${HEALTH_POD_LIST[$idx]}"
  fi

  curl -s --connect-timeout 2 --max-time 3 "http://localhost:${HEALTH_PORT}/health" > "$raw_file" 2>/dev/null || true

  if [ ! -s "$raw_file" ]; then
    echo "{\"error\":\"unreachable\",\"source\":\"kubectl-port-forward-runtime-health\",\"pod\":\"${health_pod}\"}" > "$outfile"
    return
  fi

  python3 - "$raw_file" "$outfile" "$health_pod" <<'PYEOF'
import json, sys

raw_file, outfile, health_pod = sys.argv[1], sys.argv[2], sys.argv[3]

try:
    with open(raw_file) as f:
        h = json.load(f)
    m = h.get("metrics", {})
    gc = h.get("gc", {})
    el = h.get("eventLoop", {})
    chp = h.get("clickhouseProbe", {})
    out = {
        "source": "kubectl-port-forward-runtime-health",
        "pod": health_pod,
        "status": h.get("status"),
        "uptime": h.get("uptime"),
        "database": h.get("database"),
        "redis": h.get("redis"),
        "clickhouse": h.get("clickhouse"),
        "clickhouseProbe": {
            "ok": chp.get("ok"),
            "latencyMs": chp.get("latencyMs"),
        } if chp else None,
        "livekit": h.get("livekit"),
        "channelQueues": h.get("channelQueues"),
        "localCachedSessions": m.get("localCachedSessions"),
        "memoryUsageMB": m.get("memoryUsageMB"),
        "heapUsedMB": m.get("heapUsedMB"),
        "heapTotalMB": m.get("heapTotalMB"),
        "externalMB": m.get("externalMB"),
        "arrayBuffersMB": m.get("arrayBuffersMB"),
        "gc": {
            "windowCount": gc.get("windowCount"),
            "windowPauseMs": gc.get("windowPauseMs"),
            "windowMaxMs": gc.get("windowMaxMs"),
            "windowDurationSec": gc.get("windowDurationSec"),
            "totalCount": gc.get("totalCount"),
            "totalPauseMs": gc.get("totalPauseMs"),
            "maxPauseMs": gc.get("maxPauseMs"),
            "byType": gc.get("byType", {}),
        },
        "eventLoop": {
            "lagMs": el.get("lagMs"),
            "lagPeakMs": el.get("lagPeakMs"),
            "windowPeakMs": el.get("windowPeakMs"),
        },
    }
except Exception as e:
    out = {"error": f"parse failed: {e}"}

with open(outfile, "w") as f:
    json.dump(out, f)
PYEOF
}

# Collect cluster-level metrics
collect_cluster() {
  local outfile="$1"

  python3 - "$CONTEXT" "$NS" "$outfile" <<'PYEOF'
import subprocess, json, sys

ctx, ns, outfile = sys.argv[1], sys.argv[2], sys.argv[3]
errors = []

def run(cmd, name):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if r.returncode != 0:
            errors.append({
                "collector": name,
                "returnCode": r.returncode,
                "stderr": r.stderr.strip()[:500],
            })
        return r.stdout.strip()
    except Exception as e:
        errors.append({"collector": name, "error": str(e)})
        return ""

# Nodes top
nodes_top = []
raw = run(["kubectl", "--context", ctx, "top", "nodes", "--no-headers"], "topNodes")
for line in raw.splitlines():
    parts = line.split()
    if len(parts) >= 5:
        nodes_top.append({
            "node": parts[0], "cpu": parts[1], "cpuPercent": parts[2],
            "memory": parts[3], "memPercent": parts[4]
        })

# Node info (capacity, allocatable, pool)
node_info = []
raw = run(["kubectl", "--context", ctx, "get", "nodes", "-o", "json"], "getNodes")
if raw:
    try:
        data = json.loads(raw)
        for n in data.get("items", []):
            meta = n["metadata"]
            labels = meta.get("labels", {})
            cap = n["status"].get("capacity", {})
            alloc = n["status"].get("allocatable", {})
            # Try well-known pool labels: AKS, GKE, EKS, then custom
            pool = (labels.get("agentpool")
                    or labels.get("kubernetes.azure.com/agentpool")
                    or labels.get("cloud.google.com/gke-nodepool")
                    or labels.get("eks.amazonaws.com/nodegroup")
                    or labels.get("workload")
                    or "")
            node_info.append({
                "node": meta["name"],
                "pool": pool,
                "cpuCapacity": cap.get("cpu", ""),
                "memCapacity": cap.get("memory", ""),
                "cpuAllocatable": alloc.get("cpu", ""),
                "memAllocatable": alloc.get("memory", "")
            })
    except Exception as e:
        node_info = [{"error": f"parse failed: {e}"}]

# Pending pods
pending = []
raw = run(["kubectl", "--context", ctx, "-n", ns, "get", "pods",
           "--field-selector=status.phase=Pending", "-o", "json"], "pendingPods")
if raw:
    try:
        data = json.loads(raw)
        for item in data.get("items", []):
            name = item["metadata"]["name"]
            conditions = item["status"].get("conditions", [])
            reason = ""
            msg = ""
            for c in conditions:
                if c.get("type") == "PodScheduled":
                    reason = c.get("reason", "")
                    msg = c.get("message", "")[:200]
            pending.append({"pod": name, "reason": reason, "message": msg})
    except Exception as e:
        pending = [{"error": f"parse failed: {e}"}]

# PDB
pdb = []
raw = run(["kubectl", "--context", ctx, "-n", ns, "get", "pdb", "-o", "json"], "pdb")
if raw:
    try:
        data = json.loads(raw)
        for item in data.get("items", []):
            spec = item.get("spec", {})
            status = item.get("status", {})
            pdb.append({
                "name": item["metadata"]["name"],
                "minAvailable": spec.get("minAvailable"),
                "maxUnavailable": spec.get("maxUnavailable"),
                "currentHealthy": status.get("currentHealthy"),
                "desiredHealthy": status.get("desiredHealthy"),
                "disruptionsAllowed": status.get("disruptionsAllowed"),
                "expectedPods": status.get("expectedPods")
            })
    except Exception as e:
        pdb = [{"error": f"parse failed: {e}"}]

# Events — interesting scaling/error events only
events = []
raw = run(["kubectl", "--context", ctx, "-n", ns, "get", "events",
           "--sort-by=.lastTimestamp", "-o", "json"], "events")
if raw:
    try:
        data = json.loads(raw)
        interesting = {"OOMKilling","Evicted","FailedScheduling","ScalingReplicaSet",
                       "SuccessfulRescale","BackOff","Unhealthy","Killing",
                       "TriggeredScaleUp","ScaleDown","ProvisioningSucceeded",
                       "RegisteredNode","RemovingNode"}
        for e in data.get("items", [])[-50:]:
            reason = e.get("reason", "")
            if any(r in reason for r in interesting):
                events.append({
                    "reason": reason,
                    "message": e.get("message", "")[:200],
                    "object": e.get("involvedObject", {}).get("name", ""),
                    "type": e.get("type", ""),
                    "count": e.get("count", 1),
                    "lastTimestamp": e.get("lastTimestamp", "")
                })
        events = events[-15:]
    except Exception as e:
        events = [{"error": f"parse failed: {e}"}]

out = {
    "nodesTop": nodes_top,
    "nodeInfo": node_info,
    "pendingPods": pending,
    "pdb": pdb,
    "events": events,
    "errors": errors
}

with open(outfile, "w") as f:
    json.dump(out, f)
PYEOF
}

# Collect recent Kubernetes events for pods selected by a component label.
collect_component_events() {
  local label="$1"
  local component="$2"
  local outfile="$3"

  python3 - "$CONTEXT" "$NS" "$label" "$component" "$EVENTS_LIMIT" "$outfile" <<'PYEOF'
import json, subprocess, sys

ctx, ns, label, component, limit, outfile = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5]), sys.argv[6]
errors = []

def run(cmd, name):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if r.returncode != 0:
            errors.append({
                "collector": name,
                "returnCode": r.returncode,
                "stderr": r.stderr.strip()[:500],
            })
            return ""
        return r.stdout.strip()
    except Exception:
        errors.append({"collector": name, "error": "command failed"})
        return ""

pod_names = set()
pods_raw = run(["kubectl", "--context", ctx, "-n", ns, "get", "pods", "-l", label, "-o", "json"], "getPods")
if pods_raw:
    try:
        pods = json.loads(pods_raw)
        for item in pods.get("items", []):
            pod_names.add(item.get("metadata", {}).get("name", ""))
    except Exception:
        pass

events = []
events_raw = run(["kubectl", "--context", ctx, "-n", ns, "get", "events", "--sort-by=.lastTimestamp", "-o", "json"], "events")
if events_raw:
    try:
        data = json.loads(events_raw)
        for event in data.get("items", []):
            involved = event.get("involvedObject", {})
            object_name = involved.get("name", "")
            if object_name not in pod_names and not any(object_name.startswith(f"{pod}-") for pod in pod_names):
                continue
            events.append({
                "component": component,
                "uid": event.get("metadata", {}).get("uid", ""),
                "type": event.get("type", ""),
                "reason": event.get("reason", ""),
                "object": object_name,
                "kind": involved.get("kind", ""),
                "message": event.get("message", "")[:500],
                "count": event.get("count", 1),
                "firstTimestamp": event.get("firstTimestamp", ""),
                "lastTimestamp": event.get("lastTimestamp", ""),
                "eventTime": event.get("eventTime", ""),
                "dedupeKey": "|".join([
                    component,
                    event.get("reason", ""),
                    object_name,
                    event.get("message", "")[:500],
                ]),
            })
        events = events[-limit:]
    except Exception as e:
        events = [{"component": component, "error": f"parse failed: {e}"}]

out = {
    "component": component,
    "label": label,
    "podCount": len([p for p in pod_names if p]),
    "events": events,
    "errors": errors,
}

with open(outfile, "w") as f:
    json.dump(out, f)
PYEOF
}

# Collect top same-node pods for Runtime pod nodes. This is the Kubernetes
# fallback source for noisy-neighbor analysis.
collect_noisy_neighbors() {
  local outfile="$1"

  python3 - "$CONTEXT" "$NS" "$RUNTIME_LABEL" "$outfile" <<'PYEOF'
import json, subprocess, sys

ctx, ns, runtime_label, outfile = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
errors = []

def run(cmd, name):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        if r.returncode != 0:
            errors.append({
                "collector": name,
                "returnCode": r.returncode,
                "stderr": r.stderr.strip()[:500],
            })
            return ""
        return r.stdout.strip()
    except Exception as exc:
        errors.append({"collector": name, "error": str(exc)})
        return ""

def cpu_to_m(cpu):
    if not cpu:
        return None
    try:
        if cpu.endswith("m"):
            return float(cpu[:-1])
        if cpu.endswith("n"):
            return float(cpu[:-1]) / 1000000
        return float(cpu) * 1000
    except ValueError:
        return None

def mem_to_mi(mem):
    if not mem:
        return None
    units = {
        "Ki": 1 / 1024,
        "Mi": 1,
        "Gi": 1024,
        "Ti": 1024 * 1024,
        "K": 1 / 1000,
        "M": 1000 / 1024,
        "G": 1000 * 1000 / 1024,
    }
    try:
        for suffix, mult in units.items():
            if mem.endswith(suffix):
                return float(mem[: -len(suffix)]) * mult
        return float(mem) / (1024 * 1024)
    except ValueError:
        return None

runtime_nodes = {}
runtime_raw = run(["kubectl", "--context", ctx, "-n", ns, "get", "pods", "-l", runtime_label, "-o", "json"], "runtimePods")
if runtime_raw:
    try:
        data = json.loads(runtime_raw)
        for item in data.get("items", []):
            name = item.get("metadata", {}).get("name", "")
            node = item.get("spec", {}).get("nodeName", "")
            if name and node:
                runtime_nodes[name] = node
    except Exception as exc:
        errors.append({"collector": "runtimePods", "error": f"parse failed: {exc}"})

pod_nodes = {}
pods_raw = run(["kubectl", "--context", ctx, "get", "pods", "-A", "-o", "json"], "allPods")
if pods_raw:
    try:
        data = json.loads(pods_raw)
        for item in data.get("items", []):
            meta = item.get("metadata", {})
            key = f"{meta.get('namespace', '')}/{meta.get('name', '')}"
            pod_nodes[key] = {
                "namespace": meta.get("namespace", ""),
                "pod": meta.get("name", ""),
                "node": item.get("spec", {}).get("nodeName", ""),
                "phase": item.get("status", {}).get("phase", ""),
            }
    except Exception as exc:
        errors.append({"collector": "allPods", "error": f"parse failed: {exc}"})

top_rows = []
top_raw = run(["kubectl", "--context", ctx, "top", "pods", "-A", "--no-headers"], "topPodsAllNamespaces")
for line in top_raw.splitlines():
    parts = line.split()
    if len(parts) >= 4:
        namespace, pod, cpu, memory = parts[0], parts[1], parts[2], parts[3]
        key = f"{namespace}/{pod}"
        node = pod_nodes.get(key, {}).get("node", "")
        if node not in set(runtime_nodes.values()):
            continue
        top_rows.append({
            "namespace": namespace,
            "pod": pod,
            "node": node,
            "cpu": cpu,
            "cpuMillis": cpu_to_m(cpu),
            "memory": memory,
            "memoryMi": mem_to_mi(memory),
            "phase": pod_nodes.get(key, {}).get("phase", ""),
            "isRuntime": namespace == ns and pod in runtime_nodes,
        })

top_by_cpu = sorted(top_rows, key=lambda row: row.get("cpuMillis") or 0, reverse=True)[:20]
top_by_mem = sorted(top_rows, key=lambda row: row.get("memoryMi") or 0, reverse=True)[:20]

out = {
    "runtimeLabel": runtime_label,
    "runtimePodNodes": runtime_nodes,
    "topByCpu": top_by_cpu,
    "topByMemory": top_by_mem,
    "errors": errors,
}

with open(outfile, "w") as f:
    json.dump(out, f)
PYEOF
}

# Collect k6 run status + latest live metrics (step-aware, parallel, timeout-protected)
collect_k6() {
  local outfile="$1"

  python3 - "$K6_RUN_ID" "$K6_API_BASE" "${K6_CLOUD_TOKEN:-}" "$K6_METRIC_STEP" \
    "$K6_LOOKBACK_SECONDS" "$K6_API_TIMEOUT" "$K6_STEPS" "$K6_STEP_DURATION" "$K6_RAMP" \
    "$outfile" <<'PYEOF'
import json, math, sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from urllib.error import URLError, HTTPError
from urllib.request import Request, urlopen

run_id = sys.argv[1]
base = sys.argv[2]
token = sys.argv[3]
step = int(sys.argv[4])
lookback_seconds = int(sys.argv[5])
api_timeout = int(sys.argv[6])
steps_csv = sys.argv[7]           # e.g. "200,500,800,1000,1200,1500"
step_duration_min = int(sys.argv[8])
ramp_seconds = int(sys.argv[9])
outfile = sys.argv[10]

def write(payload):
    with open(outfile, "w") as f:
        json.dump(payload, f)

if not token:
    write({"error": "K6_CLOUD_TOKEN not set", "dataAvailable": False})
    sys.exit(0)

def fetch_json(url):
    req = Request(url, headers={"Authorization": f"Token {token}"})
    with urlopen(req, timeout=api_timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))

def parse_iso(ts):
    if not ts:
        return None
    normalized = ts.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        return None

def fmt_iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def latest_series(metric, query, start_ts, end_ts):
    url = (
        f"{base}/test_runs/{run_id}/query_range_k6("
        f"metric='{metric}',query='{query}',step={step},start={start_ts},end={end_ts})"
    )
    try:
        data = fetch_json(url)
        values = data.get("data", {}).get("result", [{}])[0].get("values", [])
        if not values:
            return {"timestamp": None, "value": None}
        ts, value = values[-1]
        try:
            value = float(value)
        except (TypeError, ValueError):
            value = None
        return {"timestamp": ts, "value": value}
    except Exception as e:
        return {"timestamp": None, "value": None, "error": f"fetch failed: {e}"}

# --- Step metadata computation ---
vu_steps = []
if steps_csv:
    try:
        vu_steps = [int(s.strip()) for s in steps_csv.split(",") if s.strip()]
    except ValueError:
        pass

step_duration_s = step_duration_min * 60

def compute_step_meta(started_dt, now_dt):
    """Compute step_index, phase, and step VUs from elapsed time."""
    if not started_dt or not vu_steps:
        return {"stepIndex": None, "stepVUs": None, "phase": "unknown",
                "elapsedSeconds": None, "stepsConfigured": len(vu_steps) > 0}

    elapsed_s = (now_dt - started_dt).total_seconds()
    if elapsed_s < 0:
        elapsed_s = 0

    step_idx = int(elapsed_s // step_duration_s)
    step_offset = elapsed_s - (step_idx * step_duration_s)

    if step_idx >= len(vu_steps):
        # Past configured steps. This is not proof that k6 Cloud has ended.
        return {"stepIndex": len(vu_steps) - 1, "stepVUs": vu_steps[-1],
                "phase": "after_configured_steps", "elapsedSeconds": round(elapsed_s),
                "configuredStepsElapsed": True}

    phase = "ramp" if step_offset < ramp_seconds else "hold"
    return {
        "stepIndex": step_idx,
        "stepVUs": vu_steps[step_idx],
        "phase": phase,
        "elapsedSeconds": round(elapsed_s),
        "holdStartOffset": round(step_idx * step_duration_s + ramp_seconds),
        "holdEndOffset": round((step_idx + 1) * step_duration_s),
    }

# --- Main: fetch run metadata first, then metrics in parallel ---
try:
    run = fetch_json(f"{base}/test_runs/{run_id}")
except (HTTPError, URLError, Exception) as e:
    write({"error": f"k6 api unavailable: {e}", "dataAvailable": False})
    sys.exit(0)

started = run.get("started")
ended = run.get("ended")

started_dt = parse_iso(started)
ended_dt = parse_iso(ended)
now_dt = datetime.now(timezone.utc)

run_info = {
    "resultStatus": run.get("result_status"),
    "runStatus": run.get("run_status"),
    "started": started,
    "ended": ended,
}

def as_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None

def classify_completion(info):
    """Classify k6 run lifecycle from status fields only.

    Metric query window timestamps are intentionally excluded; a query_range
    end timestamp is not a run-completion signal.
    """
    run_status = as_int(info.get("runStatus"))
    result_status = as_int(info.get("resultStatus"))
    ended_at = info.get("ended")

    if run_status == 2:
        state = "running"
        terminal = False
    elif run_status == 3:
        state = "finished"
        terminal = True
    elif run_status in {4, 5, 6, 7}:
        state = "aborted_or_timed_out"
        terminal = True
    elif result_status == 0:
        state = "running"
        terminal = False
    elif result_status == 1:
        state = "finished"
        terminal = True
    elif result_status in {2, 3}:
        state = "failed"
        terminal = True
    else:
        state = "unknown"
        terminal = False

    return {
        "state": state,
        "isTerminal": terminal,
        "runStatus": run_status,
        "resultStatus": result_status,
        "runEndedAt": ended_at if terminal else None,
        "source": "test_runs.status_fields",
    }

if started_dt is None:
    write({
        "run": run_info,
        "step": compute_step_meta(None, now_dt),
        "notStarted": True,
        "dataAvailable": False,
    })
    sys.exit(0)

query_end_dt = ended_dt or now_dt
query_start_dt = max(started_dt, query_end_dt - timedelta(seconds=lookback_seconds))
query_start = fmt_iso(query_start_dt)
query_end = fmt_iso(query_end_dt)

# Fetch 4 metric series in parallel (max 4 * api_timeout total instead of sequential)
metrics_to_fetch = {
    "vus": ("vus", "max"),
    "throughputMsgPerSec": ("chat_turn_success_total", "rate"),
    "attemptedMsgPerSec": ("chat_turn_attempts_total", "rate"),
    "errorRate": ("http_req_failed", "rate"),
    "p95LatencyMs": ("chat_turn_latency_ms", "p95"),
    "p99LatencyMs": ("chat_turn_latency_ms", "p99"),
}

current = {}
with ThreadPoolExecutor(max_workers=6) as pool:
    futures = {
        pool.submit(latest_series, metric, query, query_start, query_end): key
        for key, (metric, query) in metrics_to_fetch.items()
    }
    for future in as_completed(futures):
        key = futures[future]
        try:
            current[key] = future.result()
        except Exception:
            current[key] = {"timestamp": None, "value": None, "error": "thread failed"}

out = {
    "run": run_info,
    "completion": classify_completion(run_info),
    "metricWindow": {
        "start": query_start,
        "end": query_end,
        "stepSeconds": step,
        "kind": "k6_metric_query_range",
        "notRunCompletion": True,
    },
    "window": {
        "start": query_start,
        "end": query_end,
        "stepSeconds": step,
        "deprecated": "Use metricWindow. This is a metric query window, not run completion.",
    },
    "step": compute_step_meta(started_dt, now_dt),
    "current": current,
    "dataAvailable": True,
}
write(out)
PYEOF
}

# --- Collect Coroot observability metrics -----------------------------------

collect_coroot() {
  local outfile="$1"

  if [ "$ENABLE_COROOT" != "true" ]; then
    echo '{"disabled":true}' > "$outfile"
    return
  fi

  local coroot_script="${REPO_ROOT}/benchmarks/scripts/collect-coroot.py"
  if [ ! -f "$coroot_script" ]; then
    echo '{"error":"collect-coroot.py not found","disabled":true}' > "$outfile"
    return
  fi

  python3 "$coroot_script" \
    --env "$POLLER_ENV" \
    --lookback "$COROOT_LOOKBACK" \
    --output "$outfile" \
    --services "$COROOT_SERVICES" \
    2>/dev/null || echo '{"error":"collect-coroot.py failed"}' > "$outfile"
}

# --- Collect datastore ops (MongoDB opcounters, Redis commandstats, CH) -----

ENABLE_DATASTORE_OPS="${ENABLE_DATASTORE_OPS:-true}"
DATASTORE_OPS_PREV="${TMPDIR_POLL}/datastore-ops-prev.json"

# Resolve auth credentials once at startup (not per poll)
_DS_MONGO_POD="${NS}-mongodb-0"
_DS_REDIS_POD="${NS}-redis-master-0"
_DS_CH_POD="${NS}-clickhouse-shard-0-0"
_DS_MONGO_USER=""
_DS_MONGO_PASS=""
_DS_REDIS_PASS=""

_init_datastore_creds() {
  if [ -n "$_DS_MONGO_USER" ]; then return; fi
  local conn
  conn=$(kubectl --context "$CONTEXT" -n "$NS" get secret "${NS}-mongodb-admin-root" \
    -o jsonpath='{.data.connectionString\.standard}' 2>/dev/null | base64 -d 2>/dev/null || true)
  _DS_MONGO_USER=$(echo "$conn" | sed -n 's|mongodb://\([^:]*\):.*|\1|p')
  _DS_MONGO_PASS=$(echo "$conn" | sed -n 's|mongodb://[^:]*:\([^@]*\)@.*|\1|p')
  _DS_REDIS_PASS=$(kubectl --context "$CONTEXT" -n "$NS" get secret "${NS}-redis-auth" \
    -o jsonpath='{.data.redis-password}' 2>/dev/null | base64 -d 2>/dev/null || true)
}

collect_datastore_ops() {
  local outfile="$1"

  if [ "$ENABLE_DATASTORE_OPS" != "true" ]; then
    echo '{"disabled":true}' > "$outfile"
    return
  fi

  _init_datastore_creds

  if [ -z "$_DS_MONGO_USER" ]; then
    echo '{"error":"no mongo credentials"}' > "$outfile"
    return
  fi

  # --- MongoDB: opcounters + index counts ---
  local mongo_snap
  mongo_snap=$(kubectl --context "$CONTEXT" -n "$NS" exec "$_DS_MONGO_POD" -c mongod -- \
    mongosh --quiet --norc "mongodb://${_DS_MONGO_USER}:${_DS_MONGO_PASS}@localhost:27017/admin" \
    --eval '
var ss = db.adminCommand({serverStatus:1});
var o = ss.opcounters;
var wt = ss.wiredTiger;
function n(v) { return typeof v === "object" && v !== null && "low" in v ? Number(v) : (v || 0); }
var db2 = db.getSiblingDB("abl-platform");
var idx = {};
["sessions","session_states","messages","human_tasks","dek_registry","audit_logs"].forEach(function(c) {
  try { idx[c] = db2.getCollection(c).getIndexes().length; } catch(e) { idx[c] = -1; }
});
print(JSON.stringify({
  insert: n(o.insert), update: n(o.update), delete: n(o.delete),
  query: n(o.query), getmore: n(o.getmore), command: n(o.command),
  pagesWritten: n(wt.cache["pages written from cache"]),
  pagesRead: n(wt.cache["pages read into cache"]),
  dirtyBytes: n(wt.cache["tracked dirty bytes in the cache"]),
  checkpoints: n(wt.transaction["transaction checkpoints"]),
  connections: n(ss.connections.current),
  indexes: idx,
  epoch: Date.now()
}));
' 2>/dev/null | grep -v "Warning\|EACCES" | tail -1) || true

  # --- Redis: commandstats ---
  local redis_snap
  redis_snap=$(kubectl --context "$CONTEXT" -n "$NS" exec "$_DS_REDIS_POD" -- \
    redis-cli -a "$_DS_REDIS_PASS" INFO commandstats 2>/dev/null | \
    grep "^cmdstat_" | python3 -c "
import sys, json
d = {}
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    cmd = line.split(':')[0].replace('cmdstat_','')
    parts = dict(p.split('=') for p in line.split(':')[1].split(',') if '=' in p)
    d[cmd] = {'calls': int(parts.get('calls',0)), 'usec': int(parts.get('usec',0))}
print(json.dumps(d))
" 2>/dev/null) || true

  # --- ClickHouse: recent insert stats ---
  local ch_snap
  ch_snap=$(kubectl --context "$CONTEXT" -n "$NS" exec "$_DS_CH_POD" -c clickhouse -- \
    clickhouse-client --query "
SELECT
    tables[1] as tbl,
    count() as cnt,
    sum(written_rows) as rows,
    sum(written_bytes) as bytes
FROM system.query_log
WHERE event_date = today()
    AND event_time > now() - INTERVAL ${POLL_INTERVAL} SECOND
    AND query_kind IN ('Insert', 'AsyncInsertFlush')
    AND type = 'QueryFinish'
GROUP BY tbl
FORMAT JSONEachRow
" 2>/dev/null | python3 -c "
import sys, json
tables = []
for line in sys.stdin:
    line = line.strip()
    if line:
        try: tables.append(json.loads(line))
        except: pass
print(json.dumps(tables))
" 2>/dev/null) || true

  # --- Assemble + compute delta from previous snapshot ---
  python3 -c "
import json, sys, os

mongo_raw = '''${mongo_snap}'''.strip()
redis_raw = '''${redis_snap}'''.strip()
ch_raw = '''${ch_snap}'''.strip()
prev_file = '${DATASTORE_OPS_PREV}'
poll_interval = ${POLL_INTERVAL}

try:
    mongo = json.loads(mongo_raw) if mongo_raw else {}
except: mongo = {}
try:
    redis_stats = json.loads(redis_raw) if redis_raw else {}
except: redis_stats = {}
try:
    ch_tables = json.loads(ch_raw) if ch_raw else []
except: ch_tables = []

result = {
    'mongo': {
        'opcounters': {k: mongo.get(k, 0) for k in ['insert','update','delete','query','getmore','command']},
        'cache': {k: mongo.get(k, 0) for k in ['pagesWritten','pagesRead','dirtyBytes','checkpoints']},
        'connections': mongo.get('connections', 0),
        'indexes': mongo.get('indexes', {}),
    },
    'redis': {
        'totalCalls': sum(v.get('calls',0) for v in redis_stats.values()),
        'topCommands': dict(sorted(redis_stats.items(), key=lambda x: -x[1].get('calls',0))[:20]),
    },
    'clickhouse': {
        'tables': ch_tables,
        'totalRows': sum(t.get('rows',0) for t in ch_tables),
    },
    'delta': None,
}

# Compute delta from previous snapshot
if os.path.exists(prev_file):
    try:
        prev = json.load(open(prev_file))
        prev_mongo = prev.get('mongo', {}).get('opcounters', {})
        prev_redis_total = prev.get('redis', {}).get('totalCalls', 0)
        prev_redis_cmds = prev.get('redis', {}).get('topCommands', {})

        mongo_delta = {}
        for k in ['insert','update','delete','query','getmore','command']:
            d = result['mongo']['opcounters'].get(k, 0) - prev_mongo.get(k, 0)
            mongo_delta[k] = d
            mongo_delta[k + '_per_sec'] = round(d / poll_interval, 2) if poll_interval > 0 else 0

        redis_delta_calls = result['redis']['totalCalls'] - prev_redis_total
        redis_cmd_deltas = {}
        for cmd, v in result['redis']['topCommands'].items():
            prev_calls = prev_redis_cmds.get(cmd, {}).get('calls', 0)
            d = v.get('calls', 0) - prev_calls
            if d > 0:
                redis_cmd_deltas[cmd] = {'calls': d, 'per_sec': round(d / poll_interval, 2)}

        # Dirty page estimate from index amplification
        indexes = result['mongo']['indexes']
        writes_delta = mongo_delta.get('insert', 0) + mongo_delta.get('update', 0) + mongo_delta.get('delete', 0)
        # Approximate: use avg index count weighted by typical write distribution
        # sessions(27) gets ~17% of writes, session_states(6) gets ~65%, others ~18%
        avg_idx = 0.17 * indexes.get('sessions', 27) + 0.65 * indexes.get('session_states', 6) + 0.18 * 5
        dirty_pages = round(writes_delta * (1 + avg_idx))

        cache_delta = {}
        for k in ['pagesWritten','pagesRead','checkpoints']:
            d = result['mongo']['cache'].get(k, 0) - prev.get('mongo',{}).get('cache',{}).get(k, 0)
            cache_delta[k] = d
            cache_delta[k + '_per_sec'] = round(d / poll_interval, 2) if poll_interval > 0 else 0

        result['delta'] = {
            'intervalSeconds': poll_interval,
            'mongo': {
                'opcounterDelta': mongo_delta,
                'writesPerSec': round(writes_delta / poll_interval, 2) if poll_interval > 0 else 0,
                'dirtyPagesEstimate': dirty_pages,
                'dirtyPagesPerSec': round(dirty_pages / poll_interval, 2) if poll_interval > 0 else 0,
                'cacheDelta': cache_delta,
            },
            'redis': {
                'totalCallsDelta': redis_delta_calls,
                'callsPerSec': round(redis_delta_calls / poll_interval, 2) if poll_interval > 0 else 0,
                'topDeltas': dict(sorted(redis_cmd_deltas.items(), key=lambda x: -x[1]['calls'])[:15]),
            },
            'clickhouse': {
                'totalRows': sum(t.get('rows', 0) for t in ch_tables),
                'rowsPerSec': round(sum(t.get('rows', 0) for t in ch_tables) / poll_interval, 2) if poll_interval > 0 else 0,
                'tables': ch_tables,
            },
        }
    except Exception as e:
        result['delta'] = {'error': str(e)}

# Save current as prev for next poll
with open(prev_file, 'w') as f:
    json.dump(result, f)

print(json.dumps(result))
  " > "$outfile" 2>/dev/null || echo '{"error":"datastore-ops assembly failed"}' > "$outfile"
}

# --- Assemble all component files into final poll JSON ----------------------

assemble_poll() {
  local poll_num="$1"
  local timestamp="$2"
  local epoch="$3"
  local outfile="$4"

  python3 - "$poll_num" "$timestamp" "$epoch" "$RUN_ID" "$K6_RUN_ID" \
    "${TMPDIR_POLL}/runtime.json" \
    "${TMPDIR_POLL}/hpa.json" \
    "${TMPDIR_POLL}/deployment.json" \
    "${TMPDIR_POLL}/health.json" \
    "${TMPDIR_POLL}/mongodb.json" \
    "${TMPDIR_POLL}/redis.json" \
    "${TMPDIR_POLL}/kafka.json" \
    "${TMPDIR_POLL}/clickhouse.json" \
    "${TMPDIR_POLL}/opensearch.json" \
    "${TMPDIR_POLL}/neo4j.json" \
    "${TMPDIR_POLL}/ingress.json" \
    "${TMPDIR_POLL}/cluster.json" \
    "${TMPDIR_POLL}/k6.json" \
    "${TMPDIR_POLL}/runtime-events.json" \
    "${TMPDIR_POLL}/mongodb-events.json" \
    "${TMPDIR_POLL}/redis-events.json" \
    "${TMPDIR_POLL}/clickhouse-events.json" \
    "${TMPDIR_POLL}/noisy-neighbors.json" \
    "${TMPDIR_POLL}/coroot.json" \
    "${TMPDIR_POLL}/datastore-ops.json" \
    "$outfile" \
    "$SUMMARY_JSONL" <<'PYEOF'
import json, sys

poll_num = int(sys.argv[1])
timestamp = sys.argv[2]
epoch = int(sys.argv[3])
run_id = sys.argv[4]
k6_run_id = sys.argv[5]

def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception as e:
        return {"error": f"load failed: {e}"}

runtime = load(sys.argv[6])
hpa = load(sys.argv[7])
deployment = load(sys.argv[8])
health = load(sys.argv[9])
mongodb = load(sys.argv[10])
redis = load(sys.argv[11])
kafka = load(sys.argv[12])
clickhouse = load(sys.argv[13])
opensearch = load(sys.argv[14])
neo4j = load(sys.argv[15])
ingress = load(sys.argv[16])
cluster = load(sys.argv[17])
k6 = load(sys.argv[18])
runtime_events = load(sys.argv[19])
mongodb_events = load(sys.argv[20])
redis_events = load(sys.argv[21])
clickhouse_events = load(sys.argv[22])
noisy_neighbors = load(sys.argv[23])
coroot = load(sys.argv[24])
datastore_ops = load(sys.argv[25])
outfile = sys.argv[26]
summary_jsonl = sys.argv[27]

poll = {
    "pollNumber": poll_num,
    "timestamp": timestamp,
    "epoch": epoch,
    "runId": run_id,
    "k6RunId": k6_run_id,
    "runtime": {
        **runtime,
        "hpa": hpa,
        "deployment": deployment,
        "health": health
    },
    "mongodb": mongodb,
    "redis": redis,
    "kafka": kafka,
    "clickhouse": clickhouse,
    "opensearch": opensearch,
    "neo4j": neo4j,
    "ingress": ingress,
    "cluster": cluster,
    "eventLedger": {
        "runtime": runtime_events,
        "mongodb": mongodb_events,
        "redis": redis_events,
        "clickhouse": clickhouse_events
    },
    "noisyNeighbors": noisy_neighbors,
    "coroot": coroot,
    "datastoreOps": datastore_ops,
    "k6": k6
}

# Write individual poll file (pretty-printed for readability)
with open(outfile, "w") as f:
    json.dump(poll, f, indent=2)

# Append to summary.jsonl (one compact JSON object per line — O(1) append, no rewrite)
with open(summary_jsonl, "a") as f:
    f.write(json.dumps(poll, separators=(",", ":")) + "\n")

# Print one-liner
rt_running = len([p for p in runtime.get("pods", []) if p.get("phase") == "Running"])
hpa_cur = hpa.get("currentReplicas", "?")
hpa_des = hpa.get("desiredReplicas", "?")
hpa_max = hpa.get("maxReplicas", "?")

hpa_tag = f"HPA:{hpa_cur}/{hpa_des} max={hpa_max}"
if hpa_cur != "?" and hpa_des != "?" and hpa_des > hpa_cur:
    hpa_tag += " SCALING"
elif hpa_cur != "?" and hpa_max != "?" and hpa_cur == hpa_max:
    # Check if CPU is above target — ceiling
    cpu_util = None
    cpu_target = None
    for m in hpa.get("currentMetrics", []):
        if m.get("name") == "cpu":
            cpu_util = m.get("currentUtilization")
    for t in hpa.get("targets", []):
        if t.get("name") == "cpu":
            cpu_target = t.get("targetUtilization")
    if cpu_util is not None and cpu_target is not None and cpu_util >= cpu_target:
        hpa_tag += " CEILING!"

# Deployment rollout status
deploy_tag = ""
for d in deployment.get("deployments", []):
    ready = d.get("readyReplicas") or 0
    desired = d.get("specReplicas") or 0
    updated = d.get("updatedReplicas") or 0
    unavail = d.get("unavailableReplicas") or 0
    if unavail > 0 or updated < desired:
        deploy_tag = f" ROLLOUT:{updated}/{desired}"
    conds = d.get("conditions", [])
    for c in conds:
        if c.get("type") == "Progressing" and c.get("status") == "False":
            deploy_tag = f" ROLLOUT-STUCK:{c.get('reason','')}"

parts = [f"Rt:{rt_running} pods ({hpa_tag}{deploy_tag})"]

for m in hpa.get("currentMetrics", []):
    parts.append(f"{m.get('name','?')}={m.get('currentUtilization','?')}%")

h = health
if h.get("error"):
    parts.append(f"health=FAIL:{h.get('error')}")
elif h.get("disabled"):
    parts.append("health=disabled")
else:
    parts.append(f"heap={h.get('heapUsedMB','?')}MB rss={h.get('memoryUsageMB','?')}MB sess={h.get('localCachedSessions','?')}")

mongo_ct = len(mongodb.get("pods", []))
redis_ct = len(redis.get("pods", []))
kafka_ct = len(kafka.get("pods", []))
parts.append(f"Mongo:{mongo_ct} Redis:{redis_ct} Kafka:{kafka_ct}")

nodes_ct = len(cluster.get("nodesTop", []))
pending_ct = len(cluster.get("pendingPods", []))
parts.append(f"Nodes:{nodes_ct} Pend:{pending_ct}")

k6_current = k6.get("current", {})
k6_vus = k6_current.get("vus", {}).get("value")
k6_tput = k6_current.get("throughputMsgPerSec", {}).get("value")
k6_err = k6_current.get("errorRate", {}).get("value")
k6_p95 = k6_current.get("p95LatencyMs", {}).get("value")
k6_p99 = k6_current.get("p99LatencyMs", {}).get("value")
k6_step = k6.get("step", {})
k6_phase = k6_step.get("phase", "?")
k6_step_vus = k6_step.get("stepVUs")
k6_completion = k6.get("completion", {})

step_label = f"step:{k6_step_vus}vu/{k6_phase}" if k6_step_vus else ""
if step_label:
    parts.append(step_label)
if k6_completion:
    parts.append(f"k6state={k6_completion.get('state', 'unknown')}")
if k6_vus is not None:
    parts.append(f"k6:vus={int(k6_vus)}")
if k6_tput is not None:
    parts.append(f"msg/s={k6_tput:.1f}")
if k6_err is not None:
    parts.append(f"err={k6_err * 100:.2f}%")
if k6_p95 is not None:
    parts.append(f"p95={k6_p95:.0f}ms")
if k6_p99 is not None:
    parts.append(f"p99={k6_p99:.0f}ms")
if not k6.get("dataAvailable", True) and not k6.get("error"):
    parts.append("k6:NO_DATA")

event_counts = {
    "rt": len(runtime_events.get("events", [])),
    "mongo": len(mongodb_events.get("events", [])),
    "redis": len(redis_events.get("events", [])),
    "ch": len(clickhouse_events.get("events", [])),
}
parts.append(
    "events="
    + ",".join(f"{key}:{value}" for key, value in event_counts.items())
)

# Coroot observability summary
cr = coroot
if cr.get("disabled") or cr.get("error"):
    cr_tag = "coroot=OFF" if cr.get("disabled") else f"coroot=ERR:{cr.get('error','')[:30]}"
    parts.append(cr_tag)
else:
    cr_parts = []
    cr_rt = cr.get("runtime", {})
    cr_nodejs = cr_rt.get("nodejs", {})
    if cr_nodejs.get("available"):
        cr_parts.append(f"EL={cr_nodejs.get('eventLoopBlockedAvgMs', '?')}ms")
    cr_rt_cpu = cr_rt.get("cpu", {})
    if cr_rt_cpu.get("usage"):
        cr_parts.append(f"cpuDly={cr_rt_cpu.get('delay', {}).get('avg', 0)*1000:.0f}ms/s")
        cr_parts.append(f"throt={cr_rt_cpu.get('throttle', {}).get('avg', 0)*1000:.0f}ms/s")
    cr_mongo = cr.get("mongodb", {}).get("storage", {})
    if cr_mongo.get("available"):
        cr_parts.append(f"mongoIOPS={cr_mongo.get('iopsWriteAvg', '?')}")
        io_lat = cr_mongo.get('ioLatencyAvgMs', cr_mongo.get('writeLatencyAvgMs', '?'))
        cr_parts.append(f"ioLat={io_lat}ms")
    if cr_parts:
        parts.append("coroot:" + " ".join(cr_parts))

neighbor_cpu = noisy_neighbors.get("topByCpu", [])
neighbor_errors = noisy_neighbors.get("errors", [])
if neighbor_errors:
    parts.append("neighbors=ERR")
elif neighbor_cpu:
    top_neighbor = next((row for row in neighbor_cpu if not row.get("isRuntime")), None)
    if top_neighbor:
        parts.append(
            f"neighbor={top_neighbor.get('namespace')}/{top_neighbor.get('pod')}:{top_neighbor.get('cpu')}"
        )
    else:
        parts.append("neighbors=runtime-only")

print(" | ".join(parts))
PYEOF
}

# --- Cleanup ----------------------------------------------------------------

cleanup() {
  echo ""
  echo "=== Polling stopped after $POLL_COUNT polls ==="
  [ -n "$PF_PID" ] && kill "$PF_PID" 2>/dev/null || true
  rm -rf "$TMPDIR_POLL"
  rm -f "$PIDFILE"

  # Build summary.json from summary.jsonl for batch analysis compatibility
  if [ -f "$SUMMARY_JSONL" ] && [ -s "$SUMMARY_JSONL" ]; then
    python3 -c "
import json, sys
polls = []
with open('$SUMMARY_JSONL') as f:
    for line in f:
        line = line.strip()
        if line:
            try:
                polls.append(json.loads(line))
            except json.JSONDecodeError:
                pass
with open('$SUMMARY_FILE', 'w') as f:
    json.dump(polls, f, indent=2)
print(f'Built summary.json from {len(polls)} polls')
" 2>/dev/null || echo "WARN: Failed to build summary.json from JSONL"
  fi

  echo "Results: $OUTPUT_DIR"
  echo "Summary JSONL: $SUMMARY_JSONL ($POLL_COUNT snapshots)"
  echo "Summary JSON:  $SUMMARY_FILE (batch analysis)"
  exit 0
}

trap cleanup SIGINT SIGTERM

# --- Main loop --------------------------------------------------------------

echo "=== Cluster Poller Started ==="
echo "  Environment:   $POLLER_ENV"
echo "  Context:       $CONTEXT"
echo "  Namespace:     $NS"
echo "  Interval:      ${POLL_INTERVAL}s"
echo "  Run ID:        $RUN_ID"
echo "  k6 Run ID:     $K6_RUN_ID"
echo "  k6 ID file:    $K6_RUN_ID_FILE"
echo "  HPA name:      $HPA_NAME"
echo "  Runtime label: $RUNTIME_LABEL"
echo "  Mongo label:   $MONGODB_LABEL"
echo "  Redis label:   $REDIS_LABEL"
echo "  CH label:      $CLICKHOUSE_LABEL"
echo "  Health fb:     $ENABLE_RUNTIME_HEALTH_FALLBACK"
echo "  Kafka:         $ENABLE_KAFKA"
echo "  OpenSearch:    $ENABLE_OPENSEARCH"
echo "  Neo4j:         $ENABLE_NEO4J"
echo "  Ingress:       $ENABLE_INGRESS"
echo "  Coroot:        $ENABLE_COROOT (lookback=${COROOT_LOOKBACK}s, services=${COROOT_SERVICES})"
echo "  Output:        $OUTPUT_DIR"
echo "  Max polls:     ${MAX_POLLS:-unlimited}"
echo ""
echo "Press Ctrl+C to stop."
echo ""

start_port_forward

while true; do
  POLL_COUNT=$((POLL_COUNT + 1))
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  EPOCH=$(date +%s)

  echo -n "[Poll #${POLL_COUNT}] ${TIMESTAMP} — "
  refresh_k6_run_id

  # --- Collect components in PARALLEL using background subshells ---
  # Group 1: Independent kubectl calls (all can run simultaneously)
  WAIT_PIDS=""
  collect_component "$RUNTIME_LABEL" "${TMPDIR_POLL}/runtime.json" &
  WAIT_PIDS="$WAIT_PIDS $!"
  collect_hpa "$HPA_NAME" "${TMPDIR_POLL}/hpa.json" &
  WAIT_PIDS="$WAIT_PIDS $!"
  collect_deployment "$RUNTIME_LABEL" "${TMPDIR_POLL}/deployment.json" &
  WAIT_PIDS="$WAIT_PIDS $!"
  collect_component "$MONGODB_LABEL" "${TMPDIR_POLL}/mongodb.json" &
  WAIT_PIDS="$WAIT_PIDS $!"
  collect_component "$REDIS_LABEL" "${TMPDIR_POLL}/redis.json" &
  WAIT_PIDS="$WAIT_PIDS $!"
  collect_component "$CLICKHOUSE_LABEL" "${TMPDIR_POLL}/clickhouse.json" &
  WAIT_PIDS="$WAIT_PIDS $!"

  # Opt-in components — write empty stubs when disabled so assembly always has input files
  if [ "$ENABLE_KAFKA" = "true" ]; then
    collect_component "$KAFKA_LABEL" "${TMPDIR_POLL}/kafka.json" &
    WAIT_PIDS="$WAIT_PIDS $!"
  else
    echo '{"disabled":true,"label":"kafka"}' > "${TMPDIR_POLL}/kafka.json"
  fi
  if [ "$ENABLE_OPENSEARCH" = "true" ]; then
    collect_component "$OPENSEARCH_LABEL" "${TMPDIR_POLL}/opensearch.json" &
    WAIT_PIDS="$WAIT_PIDS $!"
  else
    echo '{"disabled":true,"label":"opensearch"}' > "${TMPDIR_POLL}/opensearch.json"
  fi
  if [ "$ENABLE_NEO4J" = "true" ]; then
    collect_component "$NEO4J_LABEL" "${TMPDIR_POLL}/neo4j.json" &
    WAIT_PIDS="$WAIT_PIDS $!"
  else
    echo '{"disabled":true,"label":"neo4j"}' > "${TMPDIR_POLL}/neo4j.json"
  fi
  if [ "$ENABLE_INGRESS" = "true" ]; then
    collect_component "$INGRESS_LABEL" "${TMPDIR_POLL}/ingress.json" &
    WAIT_PIDS="$WAIT_PIDS $!"
  else
    echo '{"disabled":true,"label":"ingress"}' > "${TMPDIR_POLL}/ingress.json"
  fi

  collect_cluster "${TMPDIR_POLL}/cluster.json" &
  WAIT_PIDS="$WAIT_PIDS $!"
  collect_k6 "${TMPDIR_POLL}/k6.json" &
  WAIT_PIDS="$WAIT_PIDS $!"
  collect_component_events "$RUNTIME_LABEL" "runtime" "${TMPDIR_POLL}/runtime-events.json" &
  WAIT_PIDS="$WAIT_PIDS $!"
  collect_component_events "$MONGODB_LABEL" "mongodb" "${TMPDIR_POLL}/mongodb-events.json" &
  WAIT_PIDS="$WAIT_PIDS $!"
  collect_component_events "$REDIS_LABEL" "redis" "${TMPDIR_POLL}/redis-events.json" &
  WAIT_PIDS="$WAIT_PIDS $!"
  collect_component_events "$CLICKHOUSE_LABEL" "clickhouse" "${TMPDIR_POLL}/clickhouse-events.json" &
  WAIT_PIDS="$WAIT_PIDS $!"
  collect_noisy_neighbors "${TMPDIR_POLL}/noisy-neighbors.json" &
  WAIT_PIDS="$WAIT_PIDS $!"
  collect_coroot "${TMPDIR_POLL}/coroot.json" &
  WAIT_PIDS="$WAIT_PIDS $!"
  collect_datastore_ops "${TMPDIR_POLL}/datastore-ops.json" &
  WAIT_PIDS="$WAIT_PIDS $!"

  # Health uses port-forward (not parallelizable with port-forward refresh)
  collect_health "${TMPDIR_POLL}/health.json"

  # Wait for all parallel collectors to finish
  # shellcheck disable=SC2086
  wait $WAIT_PIDS 2>/dev/null || true

  # Assemble into final JSON
  POLL_FILE="${OUTPUT_DIR}/poll-$(printf '%04d' "$POLL_COUNT").json"
  assemble_poll "$POLL_COUNT" "$TIMESTAMP" "$EPOCH" "$POLL_FILE"

  # --- Refresh port-forward: every 10 polls OR on health failure ---
  HEALTH_OK=$(python3 -c "
import json, sys
try:
    with open('${TMPDIR_POLL}/health.json') as f:
        h = json.load(f)
    print('ok' if 'error' not in h else 'fail')
except:
    print('fail')
" 2>/dev/null || echo "fail")

  if [ "$HEALTH_OK" = "fail" ]; then
    HEALTH_CONSECUTIVE_FAILURES=$((HEALTH_CONSECUTIVE_FAILURES + 1))
  else
    HEALTH_CONSECUTIVE_FAILURES=0
  fi

  # Refresh on consecutive failures (port-forward likely dead) or every 10 polls
  if [ "$HEALTH_CONSECUTIVE_FAILURES" -ge 2 ] || [ $((POLL_COUNT % 10)) -eq 0 ]; then
    if [ "$HEALTH_CONSECUTIVE_FAILURES" -ge 2 ]; then
      echo "  WARN: /health unreachable for $HEALTH_CONSECUTIVE_FAILURES polls — refreshing port-forward"
    fi
    start_port_forward
  fi

  # Check max polls
  if [ "$MAX_POLLS" -gt 0 ] && [ "$POLL_COUNT" -ge "$MAX_POLLS" ]; then
    echo ""
    echo "=== Reached MAX_POLLS=$MAX_POLLS — stopping ==="
    break
  fi

  sleep "$POLL_INTERVAL"
done

cleanup

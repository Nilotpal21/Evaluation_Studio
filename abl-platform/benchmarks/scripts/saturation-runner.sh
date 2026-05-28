#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# saturation-runner.sh — Single-command saturation test runner
#
# Launches k6 Cloud + cluster-poll as subprocesses, monitors for early-stop
# conditions, writes structured artifacts. Designed to be launched once by
# Claude (run_in_background=true) and monitored via poll artifacts.
#
# Environment-agnostic: ENV=dev|qa|staging switches all derived values.
#
# Usage:
#   ENV=qa ./benchmarks/scripts/saturation-runner.sh
#   ENV=dev STEPS=20,25,30 P95_TARGET=1300 ./benchmarks/scripts/saturation-runner.sh
#   ENV=qa STEPS=25,30,35 P95_TARGET=1500 ./benchmarks/scripts/saturation-runner.sh
#
# All knobs (with defaults):
#   ENV               dev|qa|staging (default: dev)
#   STEPS             VU ladder, comma-separated (default: from tier-profiles.json)
#   STEP_DURATION_MINUTES  Hold duration per step (default: from tier-profiles.json)
#   RAMP_SECONDS      Ramp time between steps (default: from tier-profiles.json)
#   P95_TARGET        Target p95 in ms (default: from tier-profiles.json)
#   MOCK_LLM          true|false (default: true)
#   TURNS             Chat turns per session (default: 5)
#   TIER              s|m|l|xl for profile lookup (default: s)
#   SCRIPT_PATH       k6 script (default: benchmarks/multi-turn-saturation.ts)
#   DRY_RUN           true = safety gate only, no k6 (default: false)
#   EARLY_STOP_ERR_PCT       Error% threshold (default: 30)
#   EARLY_STOP_P95_MULT      p95 multiplier for hard stop (default: 2)
#   EARLY_STOP_CONSECUTIVE   Polls before triggering (default: 2)
#
# Output: benchmarks/results/runs/<RUN_LABEL>/
#   config.json       — all inputs + derived values
#   steps.json        — per-step time windows (updated live)
#   status.json       — live status (updated every poll cycle)
#   polls/            — symlink to cluster-poll output
#   k6-run-id         — k6 Cloud run ID (written when available)
#   k6-launch.log     — k6 stdout/stderr
#   early-stop.json   — if early-stopped
#   summary.json      — final summary (written at exit)
# =============================================================================

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPTS_DIR="${REPO_ROOT}/benchmarks/scripts"

# ---------------------------------------------------------------------------
# Env derivation
# ---------------------------------------------------------------------------

ENV="${ENV:-qa}"
TIER="${TIER:-s}"

# Read tier profile
TIER_PROFILE="${REPO_ROOT}/benchmarks/config/tier-profiles.json"
if [ -f "$TIER_PROFILE" ]; then
  _TIER_OUT=$(python3 - "$TIER_PROFILE" "$TIER" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
sat = d.get(sys.argv[2], {}).get('saturation', {})
steps = ','.join(map(str, sat.get('steps', [25, 30, 35])))
print(f"PROFILE_STEPS={steps}")
print(f"PROFILE_HOLD={sat.get('holdMinutes', 5)}")
print(f"PROFILE_RAMP={sat.get('rampSeconds', 60)}")
print(f"PROFILE_P95={sat.get('p95Target', 1500)}")
PYEOF
  ) && eval "$_TIER_OUT" || { PROFILE_STEPS="25,30,35"; PROFILE_HOLD=5; PROFILE_RAMP=60; PROFILE_P95=1500; }
fi

# All derived from ENV
CONTEXT="${CONTEXT:-aks-abl-${ENV}-centralus}"
NS="${NS:-abl-platform-${ENV}}"
BASE_URL="${BASE_URL:-https://agents-${ENV}.kore.ai}"
HPA_NAME="${HPA_NAME:-${NS}-runtime}"

# Test parameters
STEPS="${STEPS:-${PROFILE_STEPS:-25,30,35}}"
STEP_DURATION_MINUTES="${STEP_DURATION_MINUTES:-${PROFILE_HOLD:-5}}"
RAMP_SECONDS="${RAMP_SECONDS:-${PROFILE_RAMP:-60}}"
P95_TARGET="${P95_TARGET:-${PROFILE_P95:-1500}}"
P99_TARGET="${P99_TARGET:-$((P95_TARGET * 2 > 3000 ? P95_TARGET * 2 : 3000))}"
MOCK_LLM="${MOCK_LLM:-true}"
TURNS="${TURNS:-5}"
SCRIPT_PATH="${SCRIPT_PATH:-benchmarks/multi-turn-saturation.ts}"
DRY_RUN="${DRY_RUN:-false}"

# Early-stop thresholds
EARLY_STOP_ERR_PCT="${EARLY_STOP_ERR_PCT:-30}"
EARLY_STOP_P95_MULT="${EARLY_STOP_P95_MULT:-2}"
EARLY_STOP_CONSECUTIVE="${EARLY_STOP_CONSECUTIVE:-2}"

# Run identity
RUN_LABEL="${RUN_LABEL:-sat-${ENV}-$(date +%Y%m%d-%H%M%S)}"
RUN_DIR="${REPO_ROOT}/benchmarks/results/runs/${RUN_LABEL}"

# Create run dir early so log file has a home
mkdir -p "$RUN_DIR"

# ---------------------------------------------------------------------------
# Log file — all stdout/stderr goes to both terminal AND a log file.
# Claude reads this file to monitor the process state.
# Using a named pipe + tee to avoid subshell flush issues on exit.
# ---------------------------------------------------------------------------

LOG_FILE="$RUN_DIR/runner.log"
: > "$LOG_FILE"  # truncate/create

# Redirect through tee; keep fd 3 as original stdout for direct writes if needed
exec > >(tee -a "$LOG_FILE") 2>&1
# Give tee's subshell a moment to start
sleep 0.1

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log() { echo "[$(date +%H:%M:%S)] $*"; }
err() { echo "[$(date +%H:%M:%S)] ERROR: $*" >&2; }
epoch_ms() { python3 -c "import time; print(int(time.time() * 1000))"; }

kube() { kubectl --context "$CONTEXT" -n "$NS" "$@"; }

# write_status: updates status.json with current state + latest metrics.
# Claude reads this file to render the Running Scorecard.
write_status() {
  local phase="$1" message="$2"
  python3 -c "
import json, time
status = {
    'phase': '$phase',
    'message': '$message',
    'timestamp': int(time.time() * 1000),
    'timestampIso': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'runLabel': '$RUN_LABEL',
    'runDir': '$RUN_DIR',
    'k6RunId': '${K6_RUN_ID:-}',
    'environment': '$ENV',
    'currentStep': ${CURRENT_STEP_INDEX:-0},
    'totalSteps': len('$STEPS'.split(',')),
    'currentVu': ${CURRENT_STEP_VU:-0},
    'pollCount': ${POLL_COUNT:-0},
    'consecutiveErr': ${CONSECUTIVE_ERR:-0},
    'consecutiveP95': ${CONSECUTIVE_P95:-0},
    'latestMetrics': {
        'vus': ${LATEST_VUS:-0},
        'msgPerSec': ${LATEST_MSG_S:-0},
        'p95': ${LATEST_P95:-0},
        'p99': ${LATEST_P99:-0},
        'errRate': ${LATEST_ERR:-0}
    }
}
with open('$RUN_DIR/status.json', 'w') as f:
    json.dump(status, f, indent=2)
"
}

POLL_PID=""
K6_PID=""
K6_RUN_ID=""
CURRENT_STEP_INDEX=0
CURRENT_STEP_VU=0
POLL_COUNT=0
CONSECUTIVE_ERR=0
CONSECUTIVE_P95=0
LATEST_VUS=0
LATEST_MSG_S=0
LATEST_P95=0
LATEST_P99=0
LATEST_ERR=0

cleanup() {
  local exit_code=$?
  log "Cleanup (exit=$exit_code)"

  # Stop cluster-poll
  if [ -n "$POLL_PID" ] && kill -0 "$POLL_PID" 2>/dev/null; then
    kill "$POLL_PID" 2>/dev/null || true
    wait "$POLL_PID" 2>/dev/null || true
  fi

  # Stop k6 process
  if [ -n "$K6_PID" ] && kill -0 "$K6_PID" 2>/dev/null; then
    kill "$K6_PID" 2>/dev/null || true
    wait "$K6_PID" 2>/dev/null || true
  fi

  # Write final summary
  if [ -d "$RUN_DIR" ]; then
    python3 -c "
import json, time, glob, os
poll_dir = os.path.realpath('$RUN_DIR/polls') if os.path.exists('$RUN_DIR/polls') else ''
poll_count = len(glob.glob(os.path.join(poll_dir, 'poll-*.json'))) if poll_dir else 0
steps = []
if os.path.exists('$RUN_DIR/steps.json'):
    with open('$RUN_DIR/steps.json') as f:
        steps = json.load(f)
stop_reason = '${STOP_REASON:-}'
if stop_reason:
    run_status = 'early-stopped'
elif $exit_code != 0:
    run_status = 'error'
else:
    run_status = 'completed'
summary = {
    'runLabel': '$RUN_LABEL',
    'k6RunId': '${K6_RUN_ID:-}',
    'environment': '$ENV',
    'status': run_status,
    'stopReason': stop_reason or None,
    'exitCode': $exit_code,
    'pollsCollected': poll_count,
    'stepsCompleted': len(steps),
    'totalSteps': len('$STEPS'.split(',')),
    'finishedAt': int(time.time() * 1000),
    'finishedAtIso': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
}
with open('$RUN_DIR/summary.json', 'w') as f:
    json.dump(summary, f, indent=2)
" 2>/dev/null || true
    write_status "finished" "exit=$exit_code" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Phase 0: Setup
# ---------------------------------------------------------------------------

IFS=',' read -ra VU_STEPS <<< "$STEPS"
MAX_VUS="${VU_STEPS[${#VU_STEPS[@]}-1]}"
CURRENT_STEP_VU="${VU_STEPS[0]}"
echo "[]" > "$RUN_DIR/steps.json"

# Write config
python3 -c "
import json, time
config = {
    'runLabel': '$RUN_LABEL',
    'environment': '$ENV',
    'tier': '$TIER',
    'context': '$CONTEXT',
    'namespace': '$NS',
    'baseUrl': '$BASE_URL',
    'hpaName': '$HPA_NAME',
    'vuSteps': [${STEPS}],
    'stepDurationMinutes': $STEP_DURATION_MINUTES,
    'rampSeconds': $RAMP_SECONDS,
    'p95TargetMs': $P95_TARGET,
    'p99TargetMs': $P99_TARGET,
    'mockLlm': $([ "$MOCK_LLM" = "true" ] && echo "True" || echo "False"),
    'turns': $TURNS,
    'scriptPath': '$SCRIPT_PATH',
    'maxVus': $MAX_VUS,
    'earlyStop': {
        'errPct': $EARLY_STOP_ERR_PCT,
        'p95Multiplier': $EARLY_STOP_P95_MULT,
        'consecutivePolls': $EARLY_STOP_CONSECUTIVE
    },
    'startedAt': int(time.time() * 1000),
    'startedAtIso': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
}
with open('$RUN_DIR/config.json', 'w') as f:
    json.dump(config, f, indent=2)
"

log "=== Saturation Runner ==="
log "  ENV=$ENV  TIER=$TIER  STEPS=$STEPS  HOLD=${STEP_DURATION_MINUTES}m  RAMP=${RAMP_SECONDS}s"
log "  p95_TARGET=${P95_TARGET}ms  MOCK=$MOCK_LLM  TURNS=$TURNS"
log "  RUN_DIR=$RUN_DIR"
log ""

write_status "preflight" "starting"

# ---------------------------------------------------------------------------
# Phase 1: Safety Gate (minimal — full preflight is done by the skill)
# ---------------------------------------------------------------------------

log "--- Safety Gate ---"

# kubectl must be reachable
if ! kube get ns "$NS" &>/dev/null; then
  err "Cannot reach namespace $NS via context $CONTEXT"
  err "Check: kubectl --context $CONTEXT -n $NS get ns $NS"
  exit 1
fi
log "  kubectl: OK ($CONTEXT / $NS)"

# At least 1 runtime pod must be running
RUNTIME_READY=$(kube get pods -l "app.kubernetes.io/component=runtime" --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l | tr -d ' ')
if [ "$RUNTIME_READY" -eq 0 ]; then
  err "No running runtime pods. Run preflight via the saturation-finder skill first."
  exit 1
fi
log "  Runtime pods running: $RUNTIME_READY"

log "  Safety gate PASSED"
log ""
write_status "safety-gate" "passed"

# Dry-run exits before k6 (useful for testing connectivity)
if [ "$DRY_RUN" = "true" ]; then
  log "DRY RUN complete. Safety gate passed, no k6 launched."
  write_status "finished" "dry-run"
  exit 0
fi

# ---------------------------------------------------------------------------
# Phase 3: Start cluster-poll (subprocess)
# ---------------------------------------------------------------------------

log "--- Start Cluster Poll ---"

POLL_DIR="${REPO_ROOT}/benchmarks/results/polls/${RUN_LABEL}"

ENV="$ENV" RUN_ID="$RUN_LABEL" K6_RUN_ID="pending" \
  K6_STEPS="$STEPS" K6_STEP_DURATION="$STEP_DURATION_MINUTES" K6_RAMP="$RAMP_SECONDS" \
  CONTEXT="$CONTEXT" NS="$NS" HPA_NAME="$HPA_NAME" \
  "${SCRIPTS_DIR}/cluster-poll.sh" &
POLL_PID=$!
log "  PID=$POLL_PID  dir=$POLL_DIR"

# Wait for first artifact
for i in $(seq 1 15); do
  [ -f "$POLL_DIR/poll-0001.json" ] && break
  sleep 2
  [ "$i" -eq 15 ] && { err "cluster-poll first artifact timeout"; exit 1; }
done
log "  First poll: OK"
ln -sf "$POLL_DIR" "$RUN_DIR/polls"
log ""

write_status "polling" "cluster-poll running"

# ---------------------------------------------------------------------------
# Phase 4: Launch k6 (subprocess)
# ---------------------------------------------------------------------------

log "--- Launch k6 Cloud ---"

K6_LOG="$RUN_DIR/k6-launch.log"

STEPS="$STEPS" TURNS="$TURNS" \
  STEP_DURATION_MINUTES="$STEP_DURATION_MINUTES" RAMP_SECONDS="$RAMP_SECONDS" \
  MAX_VUS="$MAX_VUS" MAX_TURN_P95_MS="$P95_TARGET" MAX_TURN_P99_MS="$P99_TARGET" \
  MOCK_LLM="$MOCK_LLM" ENV="$ENV" \
  "${SCRIPTS_DIR}/cloud-run.sh" "$SCRIPT_PATH" > "$K6_LOG" 2>&1 &
K6_PID=$!
log "  k6 PID=$K6_PID"

# Extract run ID (poll for up to 90s)
for i in $(seq 1 18); do
  sleep 5
  K6_RUN_ID=$(grep -oE 'runs/([0-9]+)' "$K6_LOG" 2>/dev/null | head -1 | grep -oE '[0-9]+' || echo "")
  [ -z "$K6_RUN_ID" ] && K6_RUN_ID=$(grep -oE 'test[_-]?run[s]?/([0-9]+)' "$K6_LOG" 2>/dev/null | head -1 | grep -oE '[0-9]+' || echo "")
  [ -z "$K6_RUN_ID" ] && K6_RUN_ID=$(grep -oE 'id[=: ]+([0-9]{5,})' "$K6_LOG" 2>/dev/null | head -1 | grep -oE '[0-9]+' || echo "")
  if [ -n "$K6_RUN_ID" ]; then
    echo "$K6_RUN_ID" > "$RUN_DIR/k6-run-id"
    echo "$K6_RUN_ID" > "$POLL_DIR/k6-run-id"
    log "  k6 Run ID: $K6_RUN_ID"
    break
  fi
done

[ -z "$K6_RUN_ID" ] && log "  WARNING: k6 Run ID not found yet (check $K6_LOG)"
log ""
write_status "running" "k6=$K6_RUN_ID"

# ---------------------------------------------------------------------------
# Phase 5: Supervision loop (deterministic early-stop)
# ---------------------------------------------------------------------------

log "--- Supervision (early-stop monitoring) ---"

P95_HARD_LIMIT=$(( P95_TARGET * EARLY_STOP_P95_MULT ))
TOTAL_STEPS=${#VU_STEPS[@]}
STEP_TOTAL_SEC=$(( STEP_DURATION_MINUTES * 60 + RAMP_SECONDS ))
MAX_RUNTIME=$(( TOTAL_STEPS * STEP_TOTAL_SEC + 300 ))
RUN_START=$(date +%s)
STEP_START_MS=$(epoch_ms)
STOP_REASON=""
LAST_POLL_FILE=""  # Track to avoid processing same poll twice

while true; do
  sleep 20

  # k6 exited?
  if ! kill -0 "$K6_PID" 2>/dev/null; then
    K6_EXIT=0
    wait "$K6_PID" 2>/dev/null || K6_EXIT=$?
    log "  k6 process exited (code=$K6_EXIT)"
    if [ "$K6_EXIT" -ne 0 ] && [ -z "$STOP_REASON" ]; then
      STOP_REASON="k6_exit_${K6_EXIT}"
    fi
    K6_PID=""
    break
  fi

  # Max runtime?
  ELAPSED=$(( $(date +%s) - RUN_START ))
  if [ "$ELAPSED" -gt "$MAX_RUNTIME" ]; then
    STOP_REASON="max_runtime"; log "  STOP: timeout (${ELAPSED}s)"; break
  fi

  # Read latest poll (skip if same file as last cycle)
  LATEST_POLL=$(ls -t "$POLL_DIR"/poll-*.json 2>/dev/null | head -1 || echo "")
  [ -z "$LATEST_POLL" ] && continue
  [ "$LATEST_POLL" = "$LAST_POLL_FILE" ] && continue
  LAST_POLL_FILE="$LATEST_POLL"

  POLL_COUNT=$((POLL_COUNT + 1))

  # Extract signals
  SIGNALS=$(python3 -c "
import json, sys
with open('$LATEST_POLL') as f:
    poll = json.load(f)
rt = poll.get('runtime', {})
oom = any(p.get('oomKilled') for p in rt.get('pods', []))
restarts = sum(p.get('restarts', 0) for p in rt.get('pods', []))
k6 = poll.get('k6', {})
cur = k6.get('current', {})
# errorRate from k6 API is a rate (0-1), convert to percentage
err_raw = cur.get('errorRate', {}).get('value') or 0
print(json.dumps({
    'oom': oom, 'restarts': restarts,
    'errRate': round(err_raw * 100, 2),
    'p95': cur.get('p95LatencyMs', {}).get('value') or 0,
    'vus': cur.get('vus', {}).get('value') or 0,
    'msgPerSec': cur.get('throughputMsgPerSec', {}).get('value') or 0,
    'isTerminal': k6.get('completion', {}).get('isTerminal', False)
}))
" 2>/dev/null || echo '{"oom":false,"restarts":0,"errRate":0,"p95":0,"vus":0,"msgPerSec":0,"isTerminal":false}')

  # Parse
  OOM=$(echo "$SIGNALS" | python3 -c "import json,sys; print(json.load(sys.stdin)['oom'])")
  RESTARTS=$(echo "$SIGNALS" | python3 -c "import json,sys; print(json.load(sys.stdin)['restarts'])")
  ERR_RATE=$(echo "$SIGNALS" | python3 -c "import json,sys; print(json.load(sys.stdin)['errRate'])")
  P95_NOW=$(echo "$SIGNALS" | python3 -c "import json,sys; print(json.load(sys.stdin)['p95'])")
  VUS_NOW=$(echo "$SIGNALS" | python3 -c "import json,sys; print(json.load(sys.stdin)['vus'])")
  IS_TERMINAL=$(echo "$SIGNALS" | python3 -c "import json,sys; print(json.load(sys.stdin)['isTerminal'])")

  # Update LATEST_* for status.json
  LATEST_VUS="${VUS_NOW:-0}"
  LATEST_P95="${P95_NOW:-0}"
  LATEST_ERR="${ERR_RATE:-0}"
  LATEST_MSG_S=$(echo "$SIGNALS" | python3 -c "import json,sys; print(json.load(sys.stdin)['msgPerSec'])" 2>/dev/null || echo "0")
  LATEST_P99=$(python3 -c "
import json
with open('$LATEST_POLL') as f:
    poll = json.load(f)
print(poll.get('k6', {}).get('current', {}).get('p99LatencyMs', {}).get('value') or 0)
" 2>/dev/null || echo "0")

  log "  [${POLL_COUNT}] VUs=$LATEST_VUS Msg/s=$LATEST_MSG_S p95=${LATEST_P95}ms err=${LATEST_ERR}% restarts=$RESTARTS"

  # Update status.json — Claude reads this for Running Scorecard
  write_status "running" "poll=$POLL_COUNT VUs=$LATEST_VUS p95=${LATEST_P95}ms err=${LATEST_ERR}%"

  # Terminal?
  [ "$IS_TERMINAL" = "True" ] && { log "  k6 terminal"; break; }

  # Early-stop checks
  if [ "$OOM" = "True" ]; then
    STOP_REASON="oom_killed"; log "  HARD STOP: OOM"; break
  fi
  if [ "$RESTARTS" -gt 0 ]; then
    STOP_REASON="pod_restart"; log "  HARD STOP: restarts=$RESTARTS"; break
  fi
  if python3 -c "exit(0 if float('$ERR_RATE') > $EARLY_STOP_ERR_PCT else 1)" 2>/dev/null; then
    CONSECUTIVE_ERR=$((CONSECUTIVE_ERR + 1))
    [ "$CONSECUTIVE_ERR" -ge "$EARLY_STOP_CONSECUTIVE" ] && { STOP_REASON="error_rate"; log "  HARD STOP: err=${ERR_RATE}% × $CONSECUTIVE_ERR"; break; }
  else
    CONSECUTIVE_ERR=0
  fi
  if python3 -c "exit(0 if float('$P95_NOW') > $P95_HARD_LIMIT and float('$P95_NOW') > 0 else 1)" 2>/dev/null; then
    CONSECUTIVE_P95=$((CONSECUTIVE_P95 + 1))
    [ "$CONSECUTIVE_P95" -ge "$EARLY_STOP_CONSECUTIVE" ] && { STOP_REASON="p95_breach"; log "  HARD STOP: p95=${P95_NOW}ms × $CONSECUTIVE_P95"; break; }
  else
    CONSECUTIVE_P95=0
  fi

  # Track step transitions (VUS_NOW may be float from k6, truncate to int)
  VUS_INT=$(python3 -c "print(int(float('${VUS_NOW:-0}')))" 2>/dev/null || echo "0")
  if [ "$VUS_INT" -gt 0 ]; then
    for i in "${!VU_STEPS[@]}"; do
      if [ "$VUS_INT" -ge "${VU_STEPS[$i]}" ] && [ "$i" -gt "$CURRENT_STEP_INDEX" ]; then
        STEP_END_MS=$(epoch_ms)
        python3 -c "
import json
with open('$RUN_DIR/steps.json') as f:
    steps = json.load(f)
steps.append({'step': $CURRENT_STEP_INDEX, 'vu': $CURRENT_STEP_VU, 'startEpochMs': $STEP_START_MS, 'endEpochMs': $STEP_END_MS})
with open('$RUN_DIR/steps.json', 'w') as f:
    json.dump(steps, f, indent=2)
"
        CURRENT_STEP_INDEX=$i
        CURRENT_STEP_VU="${VU_STEPS[$i]}"
        STEP_START_MS="$STEP_END_MS"
        log "  → Step $((CURRENT_STEP_INDEX+1))/$TOTAL_STEPS: ${CURRENT_STEP_VU} VUs"
      fi
    done
  fi
done

# Record final step
STEP_END_MS=$(epoch_ms)
python3 -c "
import json
with open('$RUN_DIR/steps.json') as f:
    steps = json.load(f)
steps.append({
    'step': $CURRENT_STEP_INDEX, 'vu': $CURRENT_STEP_VU,
    'startEpochMs': $STEP_START_MS, 'endEpochMs': $STEP_END_MS,
    'stopReason': '${STOP_REASON:-completed}'
})
with open('$RUN_DIR/steps.json', 'w') as f:
    json.dump(steps, f, indent=2)
"

# ---------------------------------------------------------------------------
# Phase 6: Stop k6 if early-stopped
# ---------------------------------------------------------------------------

if [ -n "$STOP_REASON" ]; then
  log ""
  log "--- Early Stop: $STOP_REASON ---"
  python3 -c "
import json, time, sys
signals_raw = sys.argv[1]
try:
    signals = json.loads(signals_raw)
except:
    signals = {'raw': signals_raw}
with open('$RUN_DIR/early-stop.json', 'w') as f:
    json.dump({'reason': '$STOP_REASON', 'timestamp': int(time.time()*1000),
               'timestampIso': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
               'signals': signals}, f, indent=2)
" "$SIGNALS"
  if [ -n "$K6_RUN_ID" ]; then
    "${SCRIPTS_DIR}/stop-k6.sh" "$K6_RUN_ID" 2>&1 || log "  stop-k6.sh warning"
  fi
  if [ -n "$K6_PID" ] && kill -0 "$K6_PID" 2>/dev/null; then
    kill "$K6_PID" 2>/dev/null || true
    wait "$K6_PID" 2>/dev/null || true
  fi
  K6_PID=""
  write_status "early-stopped" "$STOP_REASON"
fi

# ---------------------------------------------------------------------------
# Phase 7: Finalize
# ---------------------------------------------------------------------------

# Let poller capture one more snapshot after k6 stops
sleep 22

# Stop poller
if [ -n "$POLL_PID" ] && kill -0 "$POLL_PID" 2>/dev/null; then
  kill "$POLL_PID" 2>/dev/null || true
  wait "$POLL_PID" 2>/dev/null || true
fi
POLL_PID=""

log ""
log "=== Run Complete ==="
log "  Status: ${STOP_REASON:-completed}"
log "  k6 Run: ${K6_RUN_ID:-unknown}"
log "  Polls:  $(ls "$POLL_DIR"/poll-*.json 2>/dev/null | wc -l | tr -d ' ')"
log "  Output: $RUN_DIR"
log ""
log "  → Use saturation-finder skill to analyze + generate report"

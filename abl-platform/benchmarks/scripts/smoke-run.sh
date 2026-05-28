#!/usr/bin/env bash
# Smoke-test every benchmark script with --vus 1 --iterations 1.
#
# Verifies that all k6 scripts (services, integration, saturation) can
# initialise, authenticate, and execute at least one iteration without
# crashing. Does NOT exercise full load — this is a fast sanity check.
#
# Usage:
#   ./benchmarks/scripts/smoke-run.sh                    # all scripts
#   SERVICES=runtime,studio ./benchmarks/scripts/smoke-run.sh  # subset
#   SERVICES=@compute ./benchmarks/scripts/smoke-run.sh        # by category
#   CATEGORY=services ./benchmarks/scripts/smoke-run.sh        # by folder
#   CATEGORY=integration ./benchmarks/scripts/smoke-run.sh
#   CATEGORY=saturation ./benchmarks/scripts/smoke-run.sh
#
# Environment:
#   SERVICES       - Comma-separated service names or @category (default: all)
#   CATEGORY       - Folder filter: services | integration | saturation | all (default: all)
#   HEALTH_CHECK   - Run health check before each test (default: false)
#   TIMEOUT        - Per-script timeout in seconds (default: 120)
#   K6_BIN         - Path to k6 binary (default: auto-detect)
#
# Prerequisites:
#   1. Fill in benchmarks/config/cloud.env with AUTH_TOKEN + REFRESH_TOKEN
#   2. Run benchmark bootstrap first (creates agents, KBs, etc.)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "${REPO_ROOT}/benchmarks/scripts/lib/service-groups.sh"
CONFIG_FILE="${REPO_ROOT}/benchmarks/config/cloud.env"

# Source config
if [ -f "$CONFIG_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
  set +a
else
  echo "ERROR: $CONFIG_FILE not found."
  exit 1
fi

SERVICES="${SERVICES:-}"
CATEGORY="${CATEGORY:-all}"
HEALTH_CHECK="${HEALTH_CHECK:-false}"
TIMEOUT="${TIMEOUT:-120}"
K6_BIN="${K6_BIN:-$(command -v k6)}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RESULTS_DIR="/tmp/k6-smoke-${TIMESTAMP}"
mkdir -p "$RESULTS_DIR"

export HEALTH_CHECK TIER="${TIER:-s}" ENV="${ENV:-development}"

# Portable timeout — macOS lacks `timeout`, try gtimeout (brew install coreutils)
if command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
elif command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
else
  TIMEOUT_BIN=""
fi

run_with_timeout() {
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" "${TIMEOUT}" "$@"
  else
    "$@"
  fi
}

# ---------------------------------------------------------------------------
# Pre-authenticate once — obtain AUTH_TOKEN + REFRESH_TOKEN for all scripts.
# Avoids hitting the dev-login rate limiter (429) when running 24 scripts.
# Skipped if AUTH_TOKEN is already set in cloud.env.
# ---------------------------------------------------------------------------

pre_authenticate() {
  local studio_url="${STUDIO_URL:-${INGRESS_BASE:-http://localhost:5173}}"
  local email="${DEV_LOGIN_EMAIL:-dev@kore.ai}"
  local name="${DEV_LOGIN_NAME:-Developer}"

  echo "  Pre-auth: obtaining tokens from ${studio_url}..."

  # Step 1: dev-login → refresh_token in Set-Cookie
  local login_response
  login_response=$(curl -s -D - -o /dev/null \
    -X POST "${studio_url}/api/auth/dev-login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"${email}\",\"name\":\"${name}\"}" 2>&1)

  local refresh_token
  refresh_token=$(echo "$login_response" | grep -i 'set-cookie:.*refresh_token=' | sed 's/.*refresh_token=\([^;]*\).*/\1/' | tr -d '\r')

  if [ -z "$refresh_token" ]; then
    echo "  Pre-auth: WARNING — no refresh_token in Set-Cookie, scripts will auth individually"
    return 1
  fi

  # Step 2: refresh → accessToken in JSON body
  local refresh_response
  refresh_response=$(curl -s \
    -X POST "${studio_url}/api/auth/refresh" \
    -H 'Content-Type: application/json' \
    -H "Cookie: refresh_token=${refresh_token}" \
    -d '{}' 2>&1)

  local access_token
  access_token=$(echo "$refresh_response" | grep -o '"accessToken":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [ -z "$access_token" ]; then
    echo "  Pre-auth: WARNING — refresh failed, scripts will auth individually"
    return 1
  fi

  export AUTH_TOKEN="$access_token"
  export REFRESH_TOKEN="$refresh_token"
  echo "  Pre-auth: OK — tokens acquired, all scripts will reuse them"
  return 0
}

if [ -z "${AUTH_TOKEN:-}" ]; then
  pre_authenticate || true
fi

# k6 must run from benchmarks/ so relative imports resolve
cd "${REPO_ROOT}/benchmarks"

# ---------------------------------------------------------------------------
# Script registry — all scripts have a `default` export for smoke testing.
# Each entry: "category/script.ts"
# ---------------------------------------------------------------------------

ALL_SCRIPTS=(
  # Services — per-service benchmarks
  "services/runtime.ts"
  "services/studio.ts"
  "services/search-ai.ts"
  "services/search-ai-runtime.ts"
  "services/crawler.ts"
  "services/bge-m3.ts"
  "services/mongodb.ts"
  "services/redis.ts"
  "services/clickhouse.ts"
  "services/neo4j.ts"
  "services/opensearch.ts"
  "services/qdrant.ts"
  "services/preprocessing.ts"
  "services/docling.ts"
  "services/restate.ts"
  "services/workflow-engine.ts"

  # Integration — E2E multi-service flows
  "integration/agent-conversation-e2e.ts"
  "integration/channel-message-e2e.ts"
  "integration/multi-agent-orchestration.ts"
  "integration/kb-ingestion-e2e.ts"
  "integration/search-query-e2e.ts"
  "integration/workflow-execution-e2e.ts"

  # Saturation — ramp-to-failure load tests
  "saturation/runtime.ts"
  "saturation/bge-m3.ts"
  "saturation/search-ai.ts"
)

# Excluded — known non-functional scripts
EXCLUDED_SCRIPTS=(
  "services/multimodal.ts|No /media/process endpoint in Runtime"
  "integration/workflow-execution-e2e.ts|Workflow engine not deployed"
)

# ---------------------------------------------------------------------------
# Build the filtered list of scripts to run
# ---------------------------------------------------------------------------

RESOLVED_SERVICES=$(resolve_services "$SERVICES")

matches_category() {
  local script="$1"
  case "$CATEGORY" in
    all) return 0 ;;
    services)     [[ "$script" == services/* ]] ;;
    integration)  [[ "$script" == integration/* ]] ;;
    saturation)   [[ "$script" == saturation/* ]] ;;
    *) echo "ERROR: Unknown CATEGORY=$CATEGORY (use: services|integration|saturation|all)"; exit 1 ;;
  esac
}

matches_service_filter() {
  local script="$1"
  if echo "$RESOLVED_SERVICES" | grep -qx "__ALL__"; then
    return 0
  fi
  local base
  base=$(basename "$script" .ts)
  local base_short="${base%-e2e}"
  base_short="${base_short%-per-service}"

  if echo "$RESOLVED_SERVICES" | grep -qx "$base"; then return 0; fi
  if echo "$RESOLVED_SERVICES" | grep -qx "$base_short"; then return 0; fi
  if echo "$RESOLVED_SERVICES" | grep -qx "__ALL_INTEGRATION__" && [[ "$script" == integration/* ]]; then return 0; fi
  return 1
}

is_excluded() {
  local script="$1"
  for entry in "${EXCLUDED_SCRIPTS[@]}"; do
    local excl_script="${entry%%|*}"
    if [ "$script" = "$excl_script" ]; then return 0; fi
  done
  return 1
}

SCRIPTS_TO_RUN=()
for script in "${ALL_SCRIPTS[@]}"; do
  if is_excluded "$script"; then continue; fi
  if ! matches_category "$script"; then continue; fi
  if ! matches_service_filter "$script"; then continue; fi
  SCRIPTS_TO_RUN+=("$script")
done

if [ ${#SCRIPTS_TO_RUN[@]} -eq 0 ]; then
  echo "No scripts match the given filters (CATEGORY=$CATEGORY, SERVICES=$SERVICES)."
  exit 1
fi

# ---------------------------------------------------------------------------
# Run smoke tests
# ---------------------------------------------------------------------------

TOTAL=${#SCRIPTS_TO_RUN[@]}
PASSED=0
FAILED=0
FAILED_SCRIPTS=()

echo "========================================================"
echo "  k6 Benchmark Smoke Suite"
echo "========================================================"
echo "  Category:  ${CATEGORY}"
echo "  Scripts:   ${TOTAL}"
echo "  Timeout:   ${TIMEOUT}s per script"
echo "  Results:   ${RESULTS_DIR}"
if [ -n "$SERVICES" ]; then
  echo "  Filter:    ${SERVICES}"
fi
if [ -z "$TIMEOUT_BIN" ]; then
  echo "  NOTE:      No timeout command found (install coreutils for timeouts)"
fi
echo "========================================================"
echo ""

# Print excluded scripts
for entry in "${EXCLUDED_SCRIPTS[@]}"; do
  excl_script="${entry%%|*}"
  excl_reason="${entry#*|}"
  echo "  SKIP  ${excl_script} -- ${excl_reason}"
done
echo ""

IDX=0
for script in "${SCRIPTS_TO_RUN[@]}"; do
  IDX=$((IDX + 1))
  log_file="${RESULTS_DIR}/$(echo "$script" | tr '/' '-').log"

  # Every script has a default export — use --vus 1 --iterations 1
  # --no-thresholds: smoke tests only verify scripts can execute, not that
  # performance thresholds are met (a single iteration is not meaningful).
  K6_ARGS=("run" "--no-thresholds" "--vus" "1" "--iterations" "1" "-e" "HEALTH_CHECK=${HEALTH_CHECK}" "$script")

  printf "[%2d/%2d] %-50s " "$IDX" "$TOTAL" "$script"

  START_TIME=$(date +%s)

  if run_with_timeout "$K6_BIN" "${K6_ARGS[@]}" > "$log_file" 2>&1; then
    ELAPSED=$(( $(date +%s) - START_TIME ))
    echo "PASS  (${ELAPSED}s)"
    PASSED=$((PASSED + 1))
  else
    EXIT_CODE=$?
    ELAPSED=$(( $(date +%s) - START_TIME ))
    if [ "$EXIT_CODE" -eq 124 ]; then
      echo "TIMEOUT  (>${TIMEOUT}s)"
    else
      echo "FAIL  (${ELAPSED}s, exit=${EXIT_CODE})"
    fi
    FAILED=$((FAILED + 1))
    FAILED_SCRIPTS+=("$script")
    # Show last 3 lines of log for quick diagnosis
    tail -3 "$log_file" 2>/dev/null | while IFS= read -r line; do
      echo "         $line"
    done
  fi
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "========================================================"
echo "  SMOKE SUITE RESULTS"
echo "========================================================"
echo "  Total:    ${TOTAL}"
echo "  Passed:   ${PASSED}"
echo "  Failed:   ${FAILED}"
echo "  Skipped:  ${#EXCLUDED_SCRIPTS[@]}"
echo "  Results:  ${RESULTS_DIR}"
echo "========================================================"

if [ ${#FAILED_SCRIPTS[@]} -gt 0 ]; then
  echo ""
  echo "  FAILED SCRIPTS:"
  for fs in "${FAILED_SCRIPTS[@]}"; do
    echo "    x ${fs}"
    echo "      Log: ${RESULTS_DIR}/$(echo "$fs" | tr '/' '-').log"
  done
fi

echo ""

# Exit with failure if any test failed
if [ "$FAILED" -gt 0 ]; then
  exit 1
fi

#!/bin/bash
# Run the k6 benchmark suite locally with tier-based settings.
#
# Usage:
#   TIER=s ./benchmarks/scripts/local-run-suite.sh
#   TIER=m ./benchmarks/scripts/local-run-suite.sh
#
# The script uses each test's built-in scenario options (VUs, duration, stages).
# Results are exported to /tmp/k6-suite-<tier>-<timestamp>/.
#
# Prerequisites:
#   1. Fill in benchmarks/config/cloud.env with AUTH_TOKEN + REFRESH_TOKEN
#   2. Run benchmark bootstrap first (creates agents, KBs, etc.)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
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

TIER="${TIER:-s}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RESULTS_DIR="/tmp/k6-suite-${TIER}-${TIMESTAMP}"
mkdir -p "$RESULTS_DIR"

# Export for k6 __ENV
export TIER HEALTH_CHECK="${HEALTH_CHECK:-false}"

# k6 must run from benchmarks/ dir so relative imports resolve
cd "${REPO_ROOT}/benchmarks"

# ---------------------------------------------------------------------------
# Token refresh helper — refresh AUTH_TOKEN between sequential test runs.
# The JWT TTL is typically 15 min; the full suite takes hours.
# ---------------------------------------------------------------------------
refresh_auth_token() {
  if [ -z "${REFRESH_TOKEN:-}" ]; then
    return 0  # no refresh token available, k6 scripts will handle via dev-login
  fi

  local refresh_url="${STUDIO_URL}/api/auth/refresh"
  local header_file
  header_file=$(mktemp)

  local body http_code
  body=$(curl -s -D "$header_file" -w '\n%{http_code}' -X POST "$refresh_url" \
    -H "Content-Type: application/json" \
    -d "{\"refreshToken\": \"${REFRESH_TOKEN}\"}" 2>/dev/null) || { rm -f "$header_file"; return 0; }

  http_code=$(echo "$body" | tail -1)
  body=$(echo "$body" | sed '$d')

  if [ "$http_code" = "200" ]; then
    local new_token
    new_token=$(echo "$body" | python3 -c "import sys,json; print(json.load(sys.stdin).get('accessToken',''))" 2>/dev/null)

    # Refresh token comes from Set-Cookie header, not JSON body
    local new_refresh
    new_refresh=$(grep -i 'set-cookie.*refresh_token=' "$header_file" \
      | sed 's/.*refresh_token=\([^;]*\).*/\1/' 2>/dev/null)

    if [ -n "$new_token" ]; then
      export AUTH_TOKEN="$new_token"
      echo "  [auth] Token refreshed before test"
    fi
    if [ -n "$new_refresh" ]; then
      export REFRESH_TOKEN="$new_refresh"
      echo "  [auth] Refresh token rotated"
    fi
  else
    echo "  [auth] Token refresh returned $http_code — k6 will attempt dev-login"
  fi

  rm -f "$header_file"
}

# Per-service scripts (public ingress)
SERVICE_SCRIPTS=(
  "services/runtime.ts"
  "services/studio.ts"
  "services/search-ai.ts"
  "services/search-ai-runtime.ts"
  "services/crawler.ts"
)

# Integration E2E scripts (public ingress)
INTEGRATION_SCRIPTS=(
  "integration/agent-conversation-e2e.ts"
  "integration/multi-agent-orchestration.ts"
  "integration/kb-ingestion-e2e.ts"
  "integration/search-query-e2e.ts"
  "integration/channel-message-e2e.ts"
)

# Excluded (logged but not run)
EXCLUDED=(
  "benchmarks/services/multimodal.ts|No /media/process endpoint in Runtime"
  "benchmarks/integration/workflow-execution-e2e.ts|Workflow engine not deployed"
)

TOTAL=0
PASSED=0
FAILED=0

K6_BIN="${K6_BIN:-$(command -v k6)}"

echo "=== k6 Local Suite Run ==="
echo "  Tier:       ${TIER}"
echo "  Results:    ${RESULTS_DIR}"
echo "  Timestamp:  ${TIMESTAMP}"
echo ""

run_script() {
  local script="$1"
  local label="$2"
  local basename
  basename=$(basename "$script" .ts)

  TOTAL=$((TOTAL + 1))
  echo ""
  echo "[${TOTAL}] Running: ${script}"

  # Refresh auth token before each test to avoid expired JWT
  refresh_auth_token

  local summary_file="${RESULTS_DIR}/${label}-${basename}.json"
  local log_file="${RESULTS_DIR}/${label}-${basename}.log"

  if "$K6_BIN" run \
    -e HEALTH_CHECK=false \
    "$script" \
    --summary-export "$summary_file" \
    > "$log_file" 2>&1; then
    PASSED=$((PASSED + 1))
    echo "[${TOTAL}] PASSED: ${script}"
  else
    FAILED=$((FAILED + 1))
    echo "[${TOTAL}] FAILED: ${script}"
    # Show last 5 lines of log for quick diagnosis
    echo "         $(tail -3 "$log_file")"
  fi
}

# Run per-service scripts
echo "--- Per-Service Benchmarks ---"
for script in "${SERVICE_SCRIPTS[@]}"; do
  run_script "$script" "svc"
done

# Run integration scripts
echo ""
echo "--- Integration E2E Benchmarks ---"
for script in "${INTEGRATION_SCRIPTS[@]}"; do
  run_script "$script" "int"
done

# Log excluded scripts
echo ""
echo "--- Excluded ---"
for entry in "${EXCLUDED[@]}"; do
  script="${entry%%|*}"
  reason="${entry##*|}"
  echo "  SKIP: ${script} (${reason})"
done

# Generate summary
echo ""
echo "=== Suite Complete ==="
echo "  Total:    ${TOTAL}"
echo "  Passed:   ${PASSED}"
echo "  Failed:   ${FAILED}"
echo "  Excluded: ${#EXCLUDED[@]}"
echo "  Results:  ${RESULTS_DIR}"
echo ""

# Generate a quick summary from JSON exports
echo "--- Latency Summary (from JSON exports) ---"
for f in "${RESULTS_DIR}"/*.json; do
  [ -f "$f" ] || continue
  basename=$(basename "$f" .json)
  # Extract http_req_duration avg and p95 if available
  avg=$(python3 -c "
import json, sys
try:
  d = json.load(open('$f'))
  m = d.get('metrics', {}).get('http_req_duration', {}).get('values', {})
  print(f\"avg={m.get('avg',0):.0f}ms p95={m.get('p(95)',0):.0f}ms\")
except: print('N/A')
" 2>/dev/null)
  printf "  %-40s %s\n" "$basename" "$avg"
done

echo ""
echo "Full logs: ${RESULTS_DIR}/*.log"

if [ "${FAILED}" -gt 0 ]; then
  echo ""
  echo "WARNING: ${FAILED} script(s) failed. Check logs for details."
  exit 1
fi

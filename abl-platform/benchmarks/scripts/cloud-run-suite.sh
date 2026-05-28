#!/bin/bash
# Run all critical k6 benchmark scripts on Grafana k6 Cloud.
#
# Runs the per-service + integration scripts sequentially.
# Scripts that require internal K8s access (mongodb, opensearch) are
# skipped in Phase 1 with a warning.
#
# Usage:
#   ./benchmarks/scripts/cloud-run-suite.sh
#   TIER=l ./benchmarks/scripts/cloud-run-suite.sh
#
# Prerequisites: same as cloud-run.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLOUD_RUN="${REPO_ROOT}/benchmarks/scripts/cloud-run.sh"

# Phase 1: Scripts that work via public ingress
PUBLIC_SCRIPTS=(
  "benchmarks/services/runtime.ts"
  "benchmarks/services/studio.ts"
  "benchmarks/services/search-ai.ts"
  "benchmarks/services/search-ai-runtime.ts"
  "benchmarks/services/crawler.ts"
)

# Phase 1: Integration E2Es (public ingress)
INTEGRATION_SCRIPTS=(
  "benchmarks/integration/agent-conversation-e2e.ts"
  "benchmarks/integration/multi-agent-orchestration.ts"
  "benchmarks/integration/kb-ingestion-e2e.ts"
  "benchmarks/integration/search-query-e2e.ts"
  "benchmarks/integration/channel-message-e2e.ts"
)

# Phase 2 only: Require Private Load Zones (internal K8s access)
# BGE-M3 not exposed via public ingress; MongoDB/OpenSearch need direct data store access
PRIVATE_SCRIPTS=(
  "benchmarks/services/bge-m3.ts"
  "benchmarks/services/mongodb.ts"
  "benchmarks/services/opensearch.ts"
  "benchmarks/services/clickhouse.ts"
  "benchmarks/services/qdrant.ts"
  "benchmarks/services/neo4j.ts"
  "benchmarks/services/redis.ts"
  "benchmarks/services/restate.ts"
  "benchmarks/services/docling.ts"
  "benchmarks/services/preprocessing.ts"
)

# Excluded: endpoint does not exist yet
# - benchmarks/services/multimodal.ts (no /media/process route in Runtime)
# - benchmarks/integration/workflow-execution-e2e.ts (workflow engine not deployed)

# Forward any extra args (e.g., --vus 1 --iterations 1) to each cloud-run.sh call
EXTRA_K6_ARGS=("$@")

TOTAL=0
PASSED=0
FAILED=0
SKIPPED=0

echo "=== k6 Cloud Suite Run ==="
echo "  Tier: ${TIER:-m}"
echo "  Env:  ${ENV:-staging}"
if [ ${#EXTRA_K6_ARGS[@]} -gt 0 ]; then
  echo "  Extra: ${EXTRA_K6_ARGS[*]}"
fi
echo ""

# ---------------------------------------------------------------------------
# Token refresh helper — refresh AUTH_TOKEN between sequential test runs.
# ---------------------------------------------------------------------------
refresh_auth_token() {
  if [ -z "${REFRESH_TOKEN:-}" ]; then
    return 0
  fi

  local refresh_url="${STUDIO_URL:-${STAGING_URL}}api/auth/refresh"
  local header_file
  header_file=$(mktemp)

  local body http_code
  body=$(curl -s -D "$header_file" -w '\n%{http_code}' -X POST "$refresh_url" \
    -H "Content-Type: application/json" \
    -H "Cookie: refresh_token=${REFRESH_TOKEN}" \
    -d "{\"refreshToken\": \"${REFRESH_TOKEN}\"}" 2>/dev/null) || { rm -f "$header_file"; return 0; }

  http_code=$(echo "$body" | tail -1)
  body=$(echo "$body" | sed '$d')

  if [ "$http_code" = "200" ]; then
    local new_token
    new_token=$(echo "$body" | python3 -c "import sys,json; print(json.load(sys.stdin).get('accessToken',''))" 2>/dev/null)
    local new_refresh
    new_refresh=$(grep -i 'set-cookie.*refresh_token=' "$header_file" \
      | head -1 | sed 's/.*refresh_token=\([^;]*\).*/\1/' 2>/dev/null)

    if [ -n "$new_token" ] && [ ${#new_token} -gt 20 ]; then
      export AUTH_TOKEN="$new_token"
      echo "  [auth] Token refreshed"
    fi
    if [ -n "$new_refresh" ]; then
      export REFRESH_TOKEN="$new_refresh"
    fi
  else
    echo "  [auth] Refresh returned $http_code — using existing token"
  fi

  rm -f "$header_file"
}

# Run public per-service scripts
echo "--- Per-Service Benchmarks (Public Ingress) ---"
for script in "${PUBLIC_SCRIPTS[@]}"; do
  TOTAL=$((TOTAL + 1))
  echo ""
  echo "[${TOTAL}] Running: ${script}"
  refresh_auth_token
  if "$CLOUD_RUN" "$script" "${EXTRA_K6_ARGS[@]}"; then
    PASSED=$((PASSED + 1))
    echo "[${TOTAL}] PASSED: ${script}"
  else
    FAILED=$((FAILED + 1))
    echo "[${TOTAL}] FAILED: ${script}"
  fi
done

# Warn about skipped private scripts
echo ""
echo "--- Skipped (Require Private Load Zones — Phase 2) ---"
for script in "${PRIVATE_SCRIPTS[@]}"; do
  TOTAL=$((TOTAL + 1))
  SKIPPED=$((SKIPPED + 1))
  echo "  SKIPPED: ${script} (needs internal K8s access)"
done

# Run integration E2Es
echo ""
echo "--- Integration E2E Benchmarks (Public Ingress) ---"
for script in "${INTEGRATION_SCRIPTS[@]}"; do
  TOTAL=$((TOTAL + 1))
  echo ""
  echo "[${TOTAL}] Running: ${script}"
  refresh_auth_token
  if "$CLOUD_RUN" "$script" "${EXTRA_K6_ARGS[@]}"; then
    PASSED=$((PASSED + 1))
    echo "[${TOTAL}] PASSED: ${script}"
  else
    FAILED=$((FAILED + 1))
    echo "[${TOTAL}] FAILED: ${script}"
  fi
done

echo ""
echo "=== Suite Complete ==="
echo "  Total:   ${TOTAL}"
echo "  Passed:  ${PASSED}"
echo "  Failed:  ${FAILED}"
echo "  Skipped: ${SKIPPED} (Phase 2 — Private Load Zones)"
echo ""

echo "  Dashboard: https://app.k6.io/projects/${K6_CLOUD_PROJECT_ID:-}"
echo ""

# Show local-style results summary if cloud-results.sh exists
CLOUD_RESULTS="${REPO_ROOT}/benchmarks/scripts/cloud-results.sh"
if [ -x "$CLOUD_RESULTS" ]; then
  echo "--- Fetching Cloud Results Summary ---"
  "$CLOUD_RESULTS" --last "$((TOTAL - SKIPPED))" 2>/dev/null || true
fi

if [ "${FAILED}" -gt 0 ]; then
  echo "WARNING: ${FAILED} script(s) failed. Check k6 Cloud dashboard for details."
  exit 1
fi

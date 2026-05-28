#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# stop-k6.sh — Stop a running k6 Cloud test run
#
# Usage:
#   ./benchmarks/scripts/stop-k6.sh <K6_RUN_ID>
#   K6_CLOUD_TOKEN=xxx ./benchmarks/scripts/stop-k6.sh 7300001
#
# The script tries four methods in order:
#   1. k6 cloud abort <RUN_ID>  (if k6 CLI is available)
#   2. POST /cloud/v6/test_runs/<RUN_ID>/abort when K6_STACK_ID is set
#   3. POST /loadtests/v2/runs/<RUN_ID>/stop via API
#   4. PATCH /v4/test-runs/<RUN_ID> with run_status=-2
# =============================================================================

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
K6_CONFIG_FILE="${REPO_ROOT}/benchmarks/config/cloud.env"

K6_RUN_ID="${1:-}"

if [ -z "$K6_RUN_ID" ]; then
  echo "Usage: $0 <K6_RUN_ID>"
  echo "  Stops a running k6 Cloud test run."
  exit 1
fi

# Load token from cloud.env if not already set
if [ -z "${K6_CLOUD_TOKEN:-}" ] && [ -f "$K6_CONFIG_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$K6_CONFIG_FILE"
  set +a
fi

K6_CLOUD_API_TOKEN="${K6_CLOUD_API_TOKEN:-${K6_STACK_API_TOKEN:-${K6_CLOUD_TOKEN:-}}}"

if [ -z "${K6_CLOUD_TOKEN:-}" ] && [ -z "${K6_CLOUD_API_TOKEN:-}" ]; then
  echo "ERROR: K6_CLOUD_TOKEN or K6_CLOUD_API_TOKEN not set and not found in cloud.env"
  exit 1
fi

echo "Stopping k6 Cloud run: $K6_RUN_ID"

# Method 1: Try k6 CLI
if command -v k6 &>/dev/null; then
  echo "  Attempting: k6 cloud abort $K6_RUN_ID"
  if k6 cloud abort "$K6_RUN_ID" 2>&1; then
    echo "  Run $K6_RUN_ID stopped via k6 CLI."
    exit 0
  fi
  echo "  k6 CLI abort failed, falling back to API..."
fi

# Method 2: Current Grafana Cloud k6 REST API — POST abort endpoint
if [ -n "${K6_STACK_ID:-}" ] && [ -n "${K6_CLOUD_API_TOKEN:-}" ]; then
  echo "  Attempting: POST /cloud/v6/test_runs/$K6_RUN_ID/abort"
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST \
    -H "Authorization: Bearer ${K6_CLOUD_API_TOKEN}" \
    -H "X-Stack-Id: ${K6_STACK_ID}" \
    "https://api.k6.io/cloud/v6/test_runs/${K6_RUN_ID}/abort")

  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "204" ]; then
    echo "  Run $K6_RUN_ID aborted via v6 API (HTTP $HTTP_CODE)."
    exit 0
  fi

  echo "  v6 abort returned HTTP $HTTP_CODE."
else
  echo "  Skipping v6 abort: K6_STACK_ID is not set."
fi

# Method 3: Deprecated API call — POST to stop endpoint
# The Grafana k6 Cloud v2 API supports POST /loadtests/v2/runs/{id}/stop
echo "  Attempting: POST /loadtests/v2/runs/$K6_RUN_ID/stop"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST \
  -H "Authorization: Token ${K6_CLOUD_TOKEN}" \
  -H "Content-Type: application/json" \
  "https://api.k6.io/loadtests/v2/runs/${K6_RUN_ID}/stop")

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "204" ]; then
  echo "  Run $K6_RUN_ID stopped via API (HTTP $HTTP_CODE)."
  exit 0
fi

echo "  API stop returned HTTP $HTTP_CODE."

# Method 4: Try PATCH with run_status (older API)
echo "  Attempting: PATCH /v4/test-runs/$K6_RUN_ID with run_status=-2"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X PATCH \
  -H "Authorization: Token ${K6_CLOUD_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"run_status": -2}' \
  "https://api.k6.io/v4/test-runs/${K6_RUN_ID}")

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "204" ]; then
  echo "  Run $K6_RUN_ID stopped via v4 PATCH (HTTP $HTTP_CODE)."
  exit 0
fi

echo "ERROR: All stop methods failed. Stop the run manually in the k6 Cloud UI."
echo "  URL: https://app.k6.io/runs/$K6_RUN_ID"
exit 1

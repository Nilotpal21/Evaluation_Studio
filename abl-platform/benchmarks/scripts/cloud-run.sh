#!/bin/bash
# Run a single k6 benchmark script on Grafana k6 Cloud.
#
# Usage:
#   ./benchmarks/scripts/cloud-run.sh <script-path> [extra-k6-args...]
#
# Examples:
#   ./benchmarks/scripts/cloud-run.sh benchmarks/services/runtime.ts
#   TIER=l ./benchmarks/scripts/cloud-run.sh benchmarks/services/runtime.ts
#   STAGING_URL=https://demo.example.com ./benchmarks/scripts/cloud-run.sh benchmarks/services/runtime.ts
#
# Prerequisites:
#   1. Copy benchmarks/config/cloud.env.example → benchmarks/config/cloud.env
#   2. Fill in K6_CLOUD_TOKEN and K6_CLOUD_PROJECT_ID
#   3. Run benchmark bootstrap first (creates fixtures on target environment)

set -euo pipefail

SCRIPT_PATH="${1:?Usage: cloud-run.sh <script-path> [extra-k6-args...]}"
shift  # remaining args passed to k6

# Resolve script dir for sourcing config
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG_FILE="${REPO_ROOT}/benchmarks/config/cloud.env"

# Save caller-provided env vars BEFORE sourcing cloud.env,
# so that CLI overrides (e.g., TIER=m ./cloud-run.sh ...) are not clobbered.
_CALLER_TIER="${TIER:-}"
_CALLER_ENV="${ENV:-}"
_CALLER_HEALTH_CHECK="${HEALTH_CHECK:-}"
_CALLER_DEV_LOGIN_EMAIL="${DEV_LOGIN_EMAIL:-}"
_CALLER_DEV_LOGIN_NAME="${DEV_LOGIN_NAME:-}"

# Source cloud credentials
if [ -f "$CONFIG_FILE" ]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
else
  echo "ERROR: $CONFIG_FILE not found."
  echo "Copy benchmarks/config/cloud.env.example → benchmarks/config/cloud.env and fill in values."
  exit 1
fi

# Validate required vars
: "${K6_CLOUD_TOKEN:?K6_CLOUD_TOKEN not set in cloud.env}"
: "${K6_CLOUD_PROJECT_ID:?K6_CLOUD_PROJECT_ID not set in cloud.env}"
: "${STAGING_URL:?STAGING_URL not set in cloud.env}"

# Restore caller overrides (CLI env vars take precedence over cloud.env)
TIER="${_CALLER_TIER:-${TIER:-m}}"
ENV="${_CALLER_ENV:-${ENV:-staging}}"
HEALTH_CHECK="${_CALLER_HEALTH_CHECK:-${HEALTH_CHECK:-true}}"
AUTH_TOKEN="${AUTH_TOKEN:-}"
TENANT_ID="${TENANT_ID:-benchmark-tenant}"
PROJECT_ID="${PROJECT_ID:-benchmark-project}"
DEV_LOGIN_USER_ID="${DEV_LOGIN_USER_ID:-user-dev-001}"
DEV_LOGIN_EMAIL="${_CALLER_DEV_LOGIN_EMAIL:-${DEV_LOGIN_EMAIL:-dev@example.com}}"
DEV_LOGIN_NAME="${_CALLER_DEV_LOGIN_NAME:-${DEV_LOGIN_NAME:-Developer}}"
HEALTH_CHECK="${HEALTH_CHECK:-true}"

echo "=== k6 Cloud Run ==="
echo "  Script:  ${SCRIPT_PATH}"
echo "  Target:  ${STAGING_URL}"
echo "  Tier:    ${TIER}"
echo "  Env:     ${ENV}"
echo "  Project: ${K6_CLOUD_PROJECT_ID}"
echo ""

# Map STAGING_URL to per-service URL env vars.
# Public ingress routing: /api/runtime/*, /api/search-ai/*, etc.
# Scripts use apiPath() from config.ts which strips /api when INGRESS_BASE is set.
# Override individual service URLs in cloud.env if your ingress differs.
RUNTIME_URL="${RUNTIME_URL:-${STAGING_URL}/api}"
STUDIO_URL="${STUDIO_URL:-${STAGING_URL}}"
SEARCH_AI_URL="${SEARCH_AI_URL:-${STAGING_URL}/api/search-ai}"
SEARCH_AI_RUNTIME_URL="${SEARCH_AI_RUNTIME_URL:-${STAGING_URL}/api/search-ai-runtime}"
BGE_M3_URL="${BGE_M3_URL:-${STAGING_URL}/api/bge-m3}"
ADMIN_URL="${ADMIN_URL:-${STAGING_URL}/api/admin}"

# Export all vars so k6 sees them in __ENV.
# k6 1.6.1 with native TypeScript has a bug where -e flags are not
# available in __ENV at module init time. Exporting as shell env vars
# ensures they're visible to k6's __ENV throughout the script lifecycle.
export K6_CLOUD_TOKEN K6_CLOUD_PROJECT_ID
export SINGLE_SESSION="${SINGLE_SESSION:-}"
export MULTI_TENANT="${MULTI_TENANT:-}"
export TENANT_IDS="${TENANT_IDS:-}"
export SUPER_ADMIN_EMAIL="${SUPER_ADMIN_EMAIL:-}"
export SUPER_ADMIN_NAME="${SUPER_ADMIN_NAME:-}"
# Only set INGRESS_BASE if explicitly configured (cloud.env or caller env).
# When INGRESS_BASE is set, apiPath() strips /api prefix — local services need /api/*.
export INGRESS_BASE="${INGRESS_BASE:-}"
export RUNTIME_URL STUDIO_URL SEARCH_AI_URL SEARCH_AI_RUNTIME_URL
export BGE_M3_URL ADMIN_URL AUTH_TOKEN TENANT_ID PROJECT_ID
export TIER ENV DEV_LOGIN_USER_ID DEV_LOGIN_EMAIL DEV_LOGIN_NAME HEALTH_CHECK
export LOAD_TEST_KEY="${LOAD_TEST_KEY:-}"
export MOCK_LLM="${MOCK_LLM:-}"

# Force Go's cgo DNS resolver so k6 uses the macOS system resolver.
# Without this, Go's pure-Go resolver intermittently fails to resolve
# hostnames that curl/nslookup resolve fine (macOS DNS stack mismatch).
export GODEBUG="${GODEBUG:-netdns=cgo}"

# Use official k6 release if available (Homebrew builds may be dev builds)
K6_BIN="${K6_BIN:-$(command -v k6)}"

# When extra k6 args are provided (e.g., --vus 1 --iterations 1), run locally
# with the same env vars instead of cloud — k6 cloud doesn't support VU overrides.
# k6 must run from benchmarks/ dir so relative imports resolve.
if [ $# -gt 0 ]; then
  cd "${REPO_ROOT}/benchmarks"
  # Strip 'benchmarks/' prefix from path if present (scripts are relative to benchmarks/)
  LOCAL_PATH="${SCRIPT_PATH#benchmarks/}"
  "$K6_BIN" run --out cloud \
    -e K6_CLOUD_PROJECT_ID="${K6_CLOUD_PROJECT_ID}" \
    -e INGRESS_BASE="${INGRESS_BASE}" \
    -e RUNTIME_URL="${RUNTIME_URL}" \
    -e STUDIO_URL="${STUDIO_URL}" \
    -e SEARCH_AI_URL="${SEARCH_AI_URL}" \
    -e SEARCH_AI_RUNTIME_URL="${SEARCH_AI_RUNTIME_URL}" \
    -e TENANT_ID="${TENANT_ID}" \
    -e TIER="${TIER}" \
    -e ENV="${ENV}" \
    -e HEALTH_CHECK="${HEALTH_CHECK}" \
    -e DEV_LOGIN_USER_ID="${DEV_LOGIN_USER_ID}" \
    -e DEV_LOGIN_EMAIL="${DEV_LOGIN_EMAIL}" \
    -e DEV_LOGIN_NAME="${DEV_LOGIN_NAME}" \
    ${AUTH_TOKEN:+-e AUTH_TOKEN="${AUTH_TOKEN}"} \
    ${LOAD_TEST_KEY:+-e LOAD_TEST_KEY="${LOAD_TEST_KEY}"} \
    ${MOCK_LLM:+-e MOCK_LLM="${MOCK_LLM}"} \
    ${SINGLE_SESSION:+-e SINGLE_SESSION="${SINGLE_SESSION}"} \
    ${MULTI_TENANT:+-e MULTI_TENANT="${MULTI_TENANT}"} \
    ${TENANT_IDS:+-e TENANT_IDS="${TENANT_IDS}"} \
    ${SUPER_ADMIN_EMAIL:+-e SUPER_ADMIN_EMAIL="${SUPER_ADMIN_EMAIL}"} \
    ${INTER_MESSAGE_DELAY:+-e INTER_MESSAGE_DELAY="${INTER_MESSAGE_DELAY}"} \
    ${MAX_TURN_P95_MS:+-e MAX_TURN_P95_MS="${MAX_TURN_P95_MS}"} \
    ${MAX_TURN_P99_MS:+-e MAX_TURN_P99_MS="${MAX_TURN_P99_MS}"} \
    "$LOCAL_PATH" "$@"
else
  "$K6_BIN" cloud run \
    -e K6_CLOUD_PROJECT_ID="${K6_CLOUD_PROJECT_ID}" \
    -e INGRESS_BASE="${INGRESS_BASE}" \
    -e RUNTIME_URL="${RUNTIME_URL}" \
    -e STUDIO_URL="${STUDIO_URL}" \
    -e SEARCH_AI_URL="${SEARCH_AI_URL}" \
    -e SEARCH_AI_RUNTIME_URL="${SEARCH_AI_RUNTIME_URL}" \
    -e TENANT_ID="${TENANT_ID}" \
    -e TIER="${TIER}" \
    -e ENV="${ENV}" \
    -e HEALTH_CHECK="${HEALTH_CHECK}" \
    -e DEV_LOGIN_USER_ID="${DEV_LOGIN_USER_ID}" \
    -e DEV_LOGIN_EMAIL="${DEV_LOGIN_EMAIL}" \
    -e DEV_LOGIN_NAME="${DEV_LOGIN_NAME}" \
    ${STEPS:+-e STEPS="${STEPS}"} \
    ${DURATION_MINUTES:+-e DURATION_MINUTES="${DURATION_MINUTES}"} \
    ${MAX_VUS:+-e MAX_VUS="${MAX_VUS}"} \
    ${STEP_DURATION_MINUTES:+-e STEP_DURATION_MINUTES="${STEP_DURATION_MINUTES}"} \
    ${AUTH_TOKEN:+-e AUTH_TOKEN="${AUTH_TOKEN}"} \
    ${LOAD_TEST_KEY:+-e LOAD_TEST_KEY="${LOAD_TEST_KEY}"} \
    ${MOCK_LLM:+-e MOCK_LLM="${MOCK_LLM}"} \
    ${SINGLE_SESSION:+-e SINGLE_SESSION="${SINGLE_SESSION}"} \
    ${MULTI_TENANT:+-e MULTI_TENANT="${MULTI_TENANT}"} \
    ${TENANT_IDS:+-e TENANT_IDS="${TENANT_IDS}"} \
    ${SUPER_ADMIN_EMAIL:+-e SUPER_ADMIN_EMAIL="${SUPER_ADMIN_EMAIL}"} \
    ${TURNS:+-e TURNS="${TURNS}"} \
    ${RAMP_SECONDS:+-e RAMP_SECONDS="${RAMP_SECONDS}"} \
    ${INTER_MESSAGE_DELAY:+-e INTER_MESSAGE_DELAY="${INTER_MESSAGE_DELAY}"} \
    ${MAX_TURN_P95_MS:+-e MAX_TURN_P95_MS="${MAX_TURN_P95_MS}"} \
    ${MAX_TURN_P99_MS:+-e MAX_TURN_P99_MS="${MAX_TURN_P99_MS}"} \
    "$SCRIPT_PATH"
fi

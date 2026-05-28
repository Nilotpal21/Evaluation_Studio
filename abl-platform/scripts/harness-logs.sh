#!/usr/bin/env bash
# harness-logs.sh — Download and display Harness CI execution logs
#
# Usage:
#   ./scripts/harness-logs.sh <execution_id> <run_sequence> <stage_id> <step_id> [grep_pattern]
#
# Examples:
#   ./scripts/harness-logs.sh j3TdhsIpTiWEPg6UX4Iusg 228 build_test unit_tests
#   ./scripts/harness-logs.sh j3TdhsIpTiWEPg6UX4Iusg 228 build_test unit_tests "ECONNREFUSED|mongo|redis"
#   ./scripts/harness-logs.sh wN2o3w0XQZK1_6hosMoBLg 224 build_test integration_tests "FAIL|Error"
#
# Requires: HARNESS_API_KEY env var (PAT token)

set -euo pipefail

ACCOUNT_ID="mpHRLwiFS6aJ_4tBSlMv0w"
PIPELINE_ID="ci_build"
LOG_SERVICE_URL="https://app.harness.io/gateway/log-service/blob/download"

if [[ $# -lt 4 ]]; then
  echo "Usage: $0 <execution_id> <run_sequence> <stage_id> <step_id> [grep_pattern]"
  echo ""
  echo "Arguments:"
  echo "  execution_id   Pipeline execution ID (from Harness URL or harness_diagnose)"
  echo "  run_sequence   Build number (e.g., 224, 228)"
  echo "  stage_id       Stage identifier (e.g., build_test, docker_search_ai)"
  echo "  step_id        Step identifier (e.g., integration_tests, unit_tests, trivy_scan, build_image)"
  echo "  grep_pattern   Optional: regex to filter logs (e.g., 'error|fail|ECONNREFUSED')"
  exit 1
fi

EXECUTION_ID="$1"
RUN_SEQUENCE="$2"
STAGE_ID="$3"
STEP_ID="$4"
GREP_PATTERN="${5:-}"

if [[ -z "${HARNESS_API_KEY:-}" ]]; then
  echo "Error: HARNESS_API_KEY environment variable is not set"
  echo "Set it with: export HARNESS_API_KEY='pat.xxx...'"
  exit 1
fi

# Build the prefix path (note: execution_id gets a leading dash in the path)
PREFIX="${ACCOUNT_ID}/pipeline/${PIPELINE_ID}/${RUN_SEQUENCE}/-${EXECUTION_ID}/${STAGE_ID}/${STEP_ID}"
ENCODED_PREFIX=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${PREFIX}', safe=''))")

echo "Fetching logs for execution #${RUN_SEQUENCE} → ${STAGE_ID}/${STEP_ID}..." >&2

# Step 1: Get download link
RESPONSE=$(curl -s -X POST \
  "${LOG_SERVICE_URL}?accountID=${ACCOUNT_ID}&prefix=${ENCODED_PREFIX}" \
  -H "x-api-key: ${HARNESS_API_KEY}" \
  -H 'content-type: application/json' 2>&1)

LINK=$(echo "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('link',''))" 2>/dev/null)

if [[ -z "$LINK" ]]; then
  echo "Error: Could not get download link" >&2
  echo "Response: $RESPONSE" >&2
  exit 1
fi

# Step 2: Download zip
TMPFILE=$(mktemp /tmp/harness-logs-XXXXXX.zip)
curl -sL "$LINK" -o "$TMPFILE"

if [[ ! -s "$TMPFILE" ]]; then
  echo "Error: Downloaded empty file" >&2
  rm -f "$TMPFILE"
  exit 1
fi

# Step 3: Extract and parse JSON log lines → readable output
if [[ -n "$GREP_PATTERN" ]]; then
  echo "Filtering logs with pattern: ${GREP_PATTERN}" >&2
  echo "---" >&2
  unzip -p "$TMPFILE" 2>/dev/null | python3 -c "
import json, sys, re
pattern = re.compile(r'${GREP_PATTERN}', re.IGNORECASE)
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        entry = json.loads(line)
        out = entry.get('out', '')
        level = entry.get('level', 'info')
        # Strip ANSI codes for matching
        clean = re.sub(r'\x1b\[[0-9;]*m', '', out).strip()
        if pattern.search(clean):
            ts = entry.get('time', '')[:19]
            print(f'[{ts}] [{level}] {clean}')
    except json.JSONDecodeError:
        if pattern.search(line):
            print(line)
"
else
  # No filter — show last 200 lines as readable text
  echo "Showing last 200 log lines:" >&2
  echo "---" >&2
  unzip -p "$TMPFILE" 2>/dev/null | python3 -c "
import json, sys, re
lines = []
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        entry = json.loads(line)
        out = entry.get('out', '')
        level = entry.get('level', 'info')
        clean = re.sub(r'\x1b\[[0-9;]*m', '', out).strip()
        if clean:
            ts = entry.get('time', '')[:19]
            lines.append(f'[{ts}] [{level}] {clean}')
    except json.JSONDecodeError:
        lines.append(line)
for l in lines[-200:]:
    print(l)
"
fi

rm -f "$TMPFILE"

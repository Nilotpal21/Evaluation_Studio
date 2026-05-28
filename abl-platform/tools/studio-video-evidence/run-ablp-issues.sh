#!/usr/bin/env bash

set -uo pipefail

MODE="${MODE:-existing}"
FINAL_PAUSE_MS="${FINAL_PAUSE_MS:-1000}"
FAILED_ISSUES=()
PASSED_ISSUES=()

run_issue() {
  local scenario="$1"
  local issue="$2"
  echo
  echo "=== Running ${issue} (${scenario}) ==="

  if pnpm studio:video:evidence -- --mode "${MODE}" --scenario "${scenario}" --issue "${issue}" --final-pause-ms "${FINAL_PAUSE_MS}"; then
    PASSED_ISSUES+=("${issue}")
    return 0
  fi

  FAILED_ISSUES+=("${issue}")
  return 1
}

for issue in \
  ABLP-540 \
  ABLP-537 \
  ABLP-536 \
  ABLP-535 \
  ABLP-534 \
  ABLP-532 \
  ABLP-539 \
  ABLP-525 \
  ABLP-524 \
  ABLP-523 \
  ABLP-517 \
  ABLP-508 \
  ABLP-541 \
  ABLP-548
do
  case "${issue}" in
    ABLP-540|ABLP-537|ABLP-536|ABLP-534|ABLP-524|ABLP-548)
      run_issue "ablp-ui-regressions" "${issue}" || true
      ;;
    ABLP-508|ABLP-532|ABLP-535|ABLP-539|ABLP-541)
      run_issue "ablp-runtime-regressions" "${issue}" || true
      ;;
    ABLP-517|ABLP-523|ABLP-525)
      run_issue "ablp-ws-observability" "${issue}" || true
      ;;
    *)
      echo "Unsupported issue mapping: ${issue}" >&2
      exit 1
      ;;
  esac
done

echo
echo "=== Studio Video Evidence Summary ==="
echo "Passed: ${#PASSED_ISSUES[@]}"
for issue in "${PASSED_ISSUES[@]}"; do
  echo "  PASS ${issue}"
done

echo "Failed: ${#FAILED_ISSUES[@]}"
for issue in "${FAILED_ISSUES[@]}"; do
  echo "  FAIL ${issue}"
done

if ((${#FAILED_ISSUES[@]} > 0)); then
  exit 1
fi

#!/usr/bin/env bash
# auth-type-coverage.sh
#
# Drift guard for auth-profile type coverage (FR-17).
# Fails if a Studio-supported auth type is missing:
# 1) UI metadata entry
# 2) runtime handler dispatch in applyAuth
# 3) matrix test row in auth-profile-matrix.e2e.test.ts

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

METADATA_FILE="apps/studio/src/components/auth-profiles/auth-type-metadata.ts"
RUNTIME_HANDLER_FILE="packages/shared-auth-profile/src/apply-auth.ts"
MATRIX_FILE="apps/runtime/src/__tests__/auth-profile-matrix.e2e.test.ts"

if [ ! -f "$METADATA_FILE" ]; then
  echo "BLOCKED: missing metadata source file: $METADATA_FILE"
  exit 1
fi

if [ ! -f "$RUNTIME_HANDLER_FILE" ]; then
  echo "BLOCKED: missing runtime handler file: $RUNTIME_HANDLER_FILE"
  exit 1
fi

if [ ! -f "$MATRIX_FILE" ]; then
  echo "BLOCKED: missing matrix test file: $MATRIX_FILE"
  exit 1
fi

extract_auth_types_from_array() {
  local file="$1"
  local array_name="$2"
  awk -v array_name="$array_name" '
    BEGIN {
      in_array = 0
      start_re = "^[[:space:]]*(export[[:space:]]+)?const[[:space:]]+" array_name "[[:space:]]*:[[:space:]]*AuthType\\[\\][[:space:]]*=[[:space:]]*\\["
    }
    {
      if (in_array == 0 && $0 ~ start_re) {
        in_array = 1
        next
      }
      if (in_array == 1 && $0 ~ /^[[:space:]]*];[[:space:]]*$/) {
        in_array = 0
        exit
      }
      if (in_array == 1) {
        while (match($0, /'\''[a-z0-9_]+'\''/)) {
          value = substr($0, RSTART + 1, RLENGTH - 2)
          print value
          $0 = substr($0, RSTART + RLENGTH)
        }
      }
    }
  ' "$file"
}

PHASE1_TYPES="$(extract_auth_types_from_array "$METADATA_FILE" "PHASE1_AUTH_TYPES" || true)"
PHASE23_TYPES="$(extract_auth_types_from_array "$METADATA_FILE" "PHASE_2_3_AUTH_TYPES" || true)"

SUPPORTED_TYPES="$(printf '%s\n%s\n' "$PHASE1_TYPES" "$PHASE23_TYPES" | sed '/^$/d' | sort -u)"

if [ -z "$SUPPORTED_TYPES" ]; then
  echo "BLOCKED: failed to extract supported auth types from $METADATA_FILE"
  exit 1
fi

FAILURES=0
for auth_type in $SUPPORTED_TYPES; do
  if ! rg -n "^[[:space:]]*${auth_type}:[[:space:]]*\\{" "$METADATA_FILE" >/dev/null; then
    echo "MISSING UI metadata entry for auth type: $auth_type ($METADATA_FILE)"
    FAILURES=$((FAILURES + 1))
  fi

  if ! rg -n "case '${auth_type}':" "$RUNTIME_HANDLER_FILE" >/dev/null; then
    echo "MISSING runtime applyAuth case for auth type: $auth_type ($RUNTIME_HANDLER_FILE)"
    FAILURES=$((FAILURES + 1))
  fi

  if ! rg -n "'${auth_type}'" "$MATRIX_FILE" >/dev/null; then
    echo "MISSING matrix test row for auth type: $auth_type ($MATRIX_FILE)"
    FAILURES=$((FAILURES + 1))
  fi
done

if [ "$FAILURES" -gt 0 ]; then
  echo "===================================================================="
  echo "BLOCKED: auth-type coverage drift detected ($FAILURES issue(s))."
  echo "Every SUPPORTED_AUTH_TYPES entry must have UI metadata, runtime"
  echo "handler coverage, and a matrix row."
  echo "===================================================================="
  exit 1
fi

echo "auth-type coverage lint: OK ($(echo "$SUPPORTED_TYPES" | wc -w | tr -d ' ') auth types)"
exit 0

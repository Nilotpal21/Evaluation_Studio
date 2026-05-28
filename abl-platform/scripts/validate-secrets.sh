#!/usr/bin/env bash
#
# validate-secrets.sh
#
# Validates that:
#   1. All ExternalSecret templates reference valid vault paths
#   2. No ConfigMap templates contain hardcoded secret values
#
# Usage: ./scripts/validate-secrets.sh
#

set -euo pipefail

HELM_DIR="deploy/helm/abl-platform"
TEMPLATES_DIR="${HELM_DIR}/templates"
EXIT_CODE=0

echo "=== Secret Validation ==="
echo ""

# ---------------------------------------------------------------------------
# 1. Validate ExternalSecret templates reference valid vault paths
# ---------------------------------------------------------------------------
echo "--- Checking ExternalSecret templates for valid vault paths ---"

EXTERNAL_SECRET_FILES=$(find "${TEMPLATES_DIR}" -name '*.yaml' -o -name '*.tpl' 2>/dev/null | xargs grep -l 'kind: ExternalSecret' 2>/dev/null || true)

if [ -z "${EXTERNAL_SECRET_FILES}" ]; then
  echo "  No ExternalSecret templates found. Skipping vault path validation."
else
  for file in ${EXTERNAL_SECRET_FILES}; do
    echo "  Checking: ${file}"

    # Ensure every ExternalSecret has a remoteRef.key defined
    if ! grep -q 'remoteRef' "${file}"; then
      echo "  ERROR: ${file} - ExternalSecret missing 'remoteRef' block"
      EXIT_CODE=1
    fi

    # Check that vault paths are not empty or placeholder-only
    EMPTY_KEYS=$(grep -n 'key:\s*$' "${file}" || true)
    if [ -n "${EMPTY_KEYS}" ]; then
      echo "  ERROR: ${file} - Empty vault key found:"
      echo "${EMPTY_KEYS}" | sed 's/^/    /'
      EXIT_CODE=1
    fi

    # Check that vault paths use the expected prefix pattern (env-scoped)
    BAD_PATHS=$(grep 'key:' "${file}" | grep -v '{{' | grep -v '#' | grep -v 'abl-platform/' || true)
    if [ -n "${BAD_PATHS}" ]; then
      echo "  WARNING: ${file} - Vault paths may not follow 'abl-platform/' prefix convention:"
      echo "${BAD_PATHS}" | sed 's/^/    /'
    fi
  done
fi

echo ""

# ---------------------------------------------------------------------------
# 2. Ensure no secrets are hardcoded in ConfigMap templates
# ---------------------------------------------------------------------------
echo "--- Checking ConfigMap templates for hardcoded secrets ---"

CONFIGMAP_FILES=$(find "${TEMPLATES_DIR}" -name '*.yaml' -o -name '*.tpl' 2>/dev/null | xargs grep -l 'kind: ConfigMap' 2>/dev/null || true)

# Also check the values files for secret-like keys in configMap blocks
VALUES_FILES=$(find "${HELM_DIR}" -name 'values*.yaml' 2>/dev/null || true)

SECRET_KEYWORDS="SECRET|PASSWORD|PRIVATE_KEY|API_KEY|ACCESS_KEY|TOKEN|CREDENTIALS|CLIENT_SECRET"

if [ -z "${CONFIGMAP_FILES}" ]; then
  echo "  No ConfigMap templates found. Skipping."
else
  for file in ${CONFIGMAP_FILES}; do
    echo "  Checking: ${file}"

    MATCHES=$(grep -inE "(${SECRET_KEYWORDS})" "${file}" | grep -v '^\s*#' | grep -v 'secretRef' | grep -v 'secretKeyRef' | grep -v 'ExternalSecret' || true)
    if [ -n "${MATCHES}" ]; then
      echo "  ERROR: ${file} - Potential secrets found in ConfigMap template:"
      echo "${MATCHES}" | sed 's/^/    /'
      EXIT_CODE=1
    fi
  done
fi

echo ""

# ---------------------------------------------------------------------------
# 3. Check values files for secrets leaked into configMap sections
# ---------------------------------------------------------------------------
echo "--- Checking values files for secrets in configMap sections ---"

for file in ${VALUES_FILES}; do
  echo "  Checking: ${file}"

  # Extract lines within configMap blocks and check for secret keywords
  IN_CONFIGMAP=false
  LINE_NUM=0
  while IFS= read -r line; do
    LINE_NUM=$((LINE_NUM + 1))

    # Detect configMap block start (indented under a service)
    if echo "${line}" | grep -qE '^\s+configMap:'; then
      IN_CONFIGMAP=true
      continue
    fi

    # Detect block exit (same or lower indentation, non-empty, not a comment)
    if ${IN_CONFIGMAP} && echo "${line}" | grep -qE '^[a-zA-Z]'; then
      IN_CONFIGMAP=false
    fi

    if ${IN_CONFIGMAP}; then
      if echo "${line}" | grep -iqE "(${SECRET_KEYWORDS})" && ! echo "${line}" | grep -qE '^\s*#'; then
        echo "  ERROR: ${file}:${LINE_NUM} - Secret-like key in configMap section:"
        echo "    ${line}"
        EXIT_CODE=1
      fi
    fi
  done < "${file}"
done

echo ""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
if [ ${EXIT_CODE} -eq 0 ]; then
  echo "=== All secret validations passed ==="
else
  echo "=== Secret validation FAILED - see errors above ==="
fi

exit ${EXIT_CODE}

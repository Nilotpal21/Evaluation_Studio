#!/usr/bin/env bash
# =============================================================================
# Tenant Isolation Plugin Audit (Sprint 2 — Task 2.3)
#
# Checks all Mongoose model files to find models with tenantId field that
# do NOT apply the tenantIsolationPlugin, and vice versa.
#
# Usage: ./tools/audit-tenant-plugin.sh
# =============================================================================

set -euo pipefail

MODEL_DIR="packages/database/src/models"
GAPS=0
TOTAL_WITH_TENANT=0
TOTAL_WITH_PLUGIN=0

echo "=== Tenant Isolation Plugin Audit ==="
echo ""

# Models with tenantId in schema but NO tenantIsolationPlugin
echo "--- Models with tenantId but NO tenantIsolationPlugin ---"
for f in "$MODEL_DIR"/*.model.ts; do
  name=$(basename "$f" .model.ts)

  has_tenant=$(grep -l 'tenantId' "$f" 2>/dev/null || true)
  has_plugin=$(grep -l 'tenantIsolationPlugin' "$f" 2>/dev/null || true)

  if [ -n "$has_tenant" ]; then
    TOTAL_WITH_TENANT=$((TOTAL_WITH_TENANT + 1))
    if [ -z "$has_plugin" ]; then
      # Check if there's a documented exception
      has_exception=$(grep -l 'TENANT_PLUGIN_EXCEPTION' "$f" 2>/dev/null || true)
      if [ -n "$has_exception" ]; then
        echo "  [EXCEPTION] $name — documented exception"
      else
        echo "  [GAP] $name — has tenantId but no tenantIsolationPlugin"
        GAPS=$((GAPS + 1))
      fi
    fi
  fi

  if [ -n "$has_plugin" ]; then
    TOTAL_WITH_PLUGIN=$((TOTAL_WITH_PLUGIN + 1))
  fi
done

echo ""
echo "--- Models with tenantIsolationPlugin but NO tenantId field ---"
for f in "$MODEL_DIR"/*.model.ts; do
  name=$(basename "$f" .model.ts)

  has_tenant=$(grep -l 'tenantId' "$f" 2>/dev/null || true)
  has_plugin=$(grep -l 'tenantIsolationPlugin' "$f" 2>/dev/null || true)

  if [ -n "$has_plugin" ] && [ -z "$has_tenant" ]; then
    echo "  [MISCONFIGURED] $name — has plugin but no tenantId field"
    GAPS=$((GAPS + 1))
  fi
done

echo ""
echo "=== Summary ==="
echo "  Models with tenantId:              $TOTAL_WITH_TENANT"
echo "  Models with tenantIsolationPlugin: $TOTAL_WITH_PLUGIN"
echo "  Gaps found:                        $GAPS"

if [ "$GAPS" -gt 0 ]; then
  echo ""
  echo "ACTION: Add tenantIsolationPlugin to models with gaps,"
  echo "        or add a // TENANT_PLUGIN_EXCEPTION comment with justification."
  exit 1
fi

echo ""
echo "All models are covered or have documented exceptions."

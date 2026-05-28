#!/usr/bin/env bash
# =============================================================================
# Dev Session Reset & Tenant Plan Setup
#
# Fixes the "Session limit exceeded" error caused by Redis session counters
# accumulating across runtime restarts (tsx-watch) without decrementing.
#
# What it does:
#   1. Resets the Redis session counter for the tenant
#   2. Flushes the tenant config cache in Redis
#   3. Ensures the tenant has an ENTERPRISE subscription (unlimited sessions)
#
# Usage:
#   ./scripts/dev-reset-sessions.sh                    # uses default tenant
#   ./scripts/dev-reset-sessions.sh <tenant-id>        # specific tenant
# =============================================================================

set -euo pipefail

TENANT_ID="${1:-019c79c4-73fe-7659-8ccc-0c44e929109f}"
REDIS_CONTAINER="abl-redis"
MONGO_CONTAINER="abl-mongo"
MONGO_URI="mongodb://abl_admin:abl_dev_password@localhost:27017/abl_platform?authSource=admin"

echo "=== Dev Session Reset ==="
echo "Tenant: ${TENANT_ID}"
echo ""

# 1. Reset Redis session counter
echo "1. Resetting Redis session counter..."
CURRENT=$(docker exec "${REDIS_CONTAINER}" redis-cli -p 6379 GET "sessions:active:${TENANT_ID}" 2>/dev/null || echo "0")
docker exec "${REDIS_CONTAINER}" redis-cli -p 6379 DEL "sessions:active:${TENANT_ID}" > /dev/null 2>&1
echo "   Counter was: ${CURRENT:-0} → reset to 0"

# 2. Flush tenant config cache
echo "2. Flushing tenant config cache..."
docker exec "${REDIS_CONTAINER}" redis-cli -p 6379 DEL "cfg:${TENANT_ID}" > /dev/null 2>&1
echo "   Done"

# 3. Ensure ENTERPRISE subscription exists
echo "3. Ensuring ENTERPRISE subscription..."
docker exec "${MONGO_CONTAINER}" mongosh "${MONGO_URI}" --quiet --eval "
  const result = db.subscriptions.updateOne(
    { tenantId: '${TENANT_ID}' },
    { \$set: { planTier: 'ENTERPRISE', status: 'active', updatedAt: new Date() },
      \$setOnInsert: { tenantId: '${TENANT_ID}', createdAt: new Date() } },
    { upsert: true }
  );
  if (result.upsertedCount) print('   Created ENTERPRISE subscription');
  else if (result.modifiedCount) print('   Updated to ENTERPRISE');
  else print('   Already ENTERPRISE');
"

echo ""
echo "Done. Restart the runtime to pick up changes."

#!/usr/bin/env bash
#
# Dev Setup — runs seed and RBAC migration in one shot
#
# Order matters:
#   1. seed-mongo --dev — creates dev/e2e workspaces, example projects, resource types,
#                         prompt templates, pipeline configs, and project tools
#   2. migration     — aligns tool/MCP RBAC permissions (needs resource types & role definitions from step 1)
#
# Usage:
#   ./scripts/setup-dev-rbac.sh                    # Docker dev MongoDB
#   MONGODB_URL=mongodb://host:port/db ./scripts/setup-dev-rbac.sh
#
set -euo pipefail

MONGODB_URL="${MONGODB_URL:-mongodb://abl_admin:abl_dev_password@localhost:27018/abl_platform?authSource=admin}"
export MONGODB_URL

echo "=== Dev Setup ==="
echo "MongoDB: ${MONGODB_URL/\/\/[^@]*@/\/\/<credentials>@}"
echo ""

echo "--- Step 1/2: Seed Dev Fixtures ---"
pnpm tsx packages/database/seed-mongo.ts --dev
echo ""

echo "--- Step 2/2: RBAC Migration ---"
pnpm tsx scripts/rbac-tool-permissions.ts --verbose
echo ""

echo "=== Done ==="

# k6 Cloud Integration — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking. Run `npx prettier --write <files>` on ALL changed files before finishing your task. Do NOT run any git operations (add, commit, push). Do NOT switch branches.

**Goal:** Enable the existing k6 benchmark scripts to run on Grafana k6 Cloud with zero code forks — same scripts, different execution target.

**Architecture:** Add `options.cloud` blocks to existing scripts (ignored when not using k6 Cloud), create wrapper shell scripts that set env vars and invoke `k6 cloud run`, and add a `cloud.env.example` config template.

**Tech Stack:** k6 1.0 (native TypeScript), Grafana k6 Cloud Pro, bash

**Spec:** `docs/superpowers/specs/2026-03-17-k6-cloud-integration-design.md`

---

## File Structure

```
benchmarks/
  config/
    cloud.env.example          # NEW — template for k6 Cloud credentials + env vars
  scripts/
    cloud-run.sh               # NEW — wrapper to run a single script on k6 Cloud
    cloud-run-suite.sh         # NEW — wrapper to run all 8+3 critical scripts
  services/
    runtime.ts                 # MODIFY — add options.cloud block
    search-ai.ts               # MODIFY — add options.cloud block
    bge-m3.ts                  # MODIFY — add options.cloud block
    mongodb.ts                 # MODIFY — add options.cloud block
    opensearch.ts              # MODIFY — add options.cloud block
  integration/
    agent-conversation-e2e.ts  # MODIFY — add options.cloud block
    kb-ingestion-e2e.ts        # MODIFY — add options.cloud block
    search-query-e2e.ts        # MODIFY — add options.cloud block
  .gitignore (or root)         # MODIFY — add cloud.env to ignore list
```

---

## Chunk 1: Cloud Config + Wrapper Scripts

### Task 1: Cloud Environment Config Template

**Files:**

- Create: `benchmarks/config/cloud.env.example`
- Modify: `.gitignore` — add `benchmarks/config/cloud.env`

- [ ] **Step 1: Create cloud.env.example**

```bash
# Grafana k6 Cloud credentials
# Get your token from: Grafana Cloud portal → k6 → Settings → API tokens
K6_CLOUD_TOKEN=your-api-token-here

# k6 Cloud project ID
# Get from: Grafana Cloud portal → k6 → Projects → your project → URL contains the ID
K6_CLOUD_PROJECT_ID=your-project-id

# Target environment — public ingress URL for staging
STAGING_URL=https://staging.abl-platform.com

# Environment label (used in k6 Cloud dashboard tags)
ENV=staging

# Load tier: s, m, l, xl (controls VU count and duration)
TIER=m

# Auth credentials for the benchmark user on the target environment
# Run the bootstrap (k6 Operator or local) first to create these
AUTH_TOKEN=your-staging-auth-token
TENANT_ID=benchmark-tenant
PROJECT_ID=benchmark-project
```

- [ ] **Step 2: Add cloud.env to .gitignore**

Check if `.gitignore` exists at repo root or in `benchmarks/`. Add `benchmarks/config/cloud.env` to whichever is appropriate. Do NOT add the `.example` file — only the real secrets file.

- [ ] **Step 3: Format**

Run: `npx prettier --write benchmarks/config/cloud.env.example 2>/dev/null || true`

---

### Task 2: Cloud Run Wrapper Script (Single Script)

**Files:**

- Create: `benchmarks/scripts/cloud-run.sh`

- [ ] **Step 1: Create cloud-run.sh**

```bash
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

# Default optional vars
ENV="${ENV:-staging}"
TIER="${TIER:-m}"
AUTH_TOKEN="${AUTH_TOKEN:-}"
TENANT_ID="${TENANT_ID:-benchmark-tenant}"
PROJECT_ID="${PROJECT_ID:-benchmark-project}"

echo "=== k6 Cloud Run ==="
echo "  Script:  ${SCRIPT_PATH}"
echo "  Target:  ${STAGING_URL}"
echo "  Tier:    ${TIER}"
echo "  Env:     ${ENV}"
echo "  Project: ${K6_CLOUD_PROJECT_ID}"
echo ""

# Map STAGING_URL to all service URL env vars
# When hitting public ingress, all services are behind the same URL
# (path-based routing handled by the ingress controller)
export K6_CLOUD_TOKEN
export K6_CLOUD_PROJECT_ID

k6 cloud run "$SCRIPT_PATH" \
  -e RUNTIME_URL="${STAGING_URL}" \
  -e STUDIO_URL="${STAGING_URL}" \
  -e SEARCH_AI_URL="${STAGING_URL}" \
  -e SEARCH_AI_RUNTIME_URL="${STAGING_URL}" \
  -e BGE_M3_URL="${STAGING_URL}/bge-m3" \
  -e ADMIN_URL="${STAGING_URL}" \
  -e AUTH_TOKEN="${AUTH_TOKEN}" \
  -e TENANT_ID="${TENANT_ID}" \
  -e PROJECT_ID="${PROJECT_ID}" \
  -e K6_CLOUD_PROJECT_ID="${K6_CLOUD_PROJECT_ID}" \
  -e TIER="${TIER}" \
  -e ENV="${ENV}" \
  "$@"
```

- [ ] **Step 2: Make executable**

Run: `chmod +x benchmarks/scripts/cloud-run.sh`

---

### Task 3: Cloud Run Suite Script (Batch)

**Files:**

- Create: `benchmarks/scripts/cloud-run-suite.sh`

- [ ] **Step 1: Create cloud-run-suite.sh**

```bash
#!/bin/bash
# Run all critical k6 benchmark scripts on Grafana k6 Cloud.
#
# Runs the 8 per-service + 3 integration scripts sequentially.
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
  "benchmarks/services/search-ai.ts"
  "benchmarks/services/bge-m3.ts"
)

# Phase 1: Integration E2Es (public ingress)
INTEGRATION_SCRIPTS=(
  "benchmarks/integration/agent-conversation-e2e.ts"
  "benchmarks/integration/kb-ingestion-e2e.ts"
  "benchmarks/integration/search-query-e2e.ts"
)

# Phase 2 only: Require Private Load Zones (internal K8s access)
PRIVATE_SCRIPTS=(
  "benchmarks/services/mongodb.ts"
  "benchmarks/services/opensearch.ts"
)

TOTAL=0
PASSED=0
FAILED=0
SKIPPED=0

echo "=== k6 Cloud Suite Run ==="
echo "  Tier: ${TIER:-m}"
echo "  Env:  ${ENV:-staging}"
echo ""

# Run public per-service scripts
echo "--- Per-Service Benchmarks (Public Ingress) ---"
for script in "${PUBLIC_SCRIPTS[@]}"; do
  TOTAL=$((TOTAL + 1))
  echo ""
  echo "[${TOTAL}] Running: ${script}"
  if "$CLOUD_RUN" "$script"; then
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
  if "$CLOUD_RUN" "$script"; then
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

if [ "${FAILED}" -gt 0 ]; then
  echo "WARNING: ${FAILED} script(s) failed. Check k6 Cloud dashboard for details."
  exit 1
fi
```

- [ ] **Step 2: Make executable**

Run: `chmod +x benchmarks/scripts/cloud-run-suite.sh`

---

## Chunk 2: Add options.cloud to Existing Scripts

### Task 4: Add options.cloud to 5 Per-Service Scripts

**Files:**

- Modify: `benchmarks/services/runtime.ts`
- Modify: `benchmarks/services/search-ai.ts`
- Modify: `benchmarks/services/bge-m3.ts`
- Modify: `benchmarks/services/mongodb.ts`
- Modify: `benchmarks/services/opensearch.ts`

For each script, add a `cloud` property inside the existing `export const options` object. The `cloud` block is ignored when running locally or via k6 Operator — it only activates with `k6 cloud run`.

The pattern for each script:

```typescript
export const options = {
  // ... existing scenarios and thresholds unchanged ...
  cloud: {
    projectID: __ENV.K6_CLOUD_PROJECT_ID || undefined,
    name: '<service>-per-service',
    tags: {
      service: '<service>',
      type: 'per-service',
      tier: __ENV.TIER || 'm',
      env: __ENV.ENV || 'staging',
    },
  },
};
```

- [ ] **Step 1: Add cloud block to runtime.ts**

Read `benchmarks/services/runtime.ts` and find the `export const options` block. Add the `cloud` property at the end of the options object (before the closing `};`):

```typescript
  cloud: {
    projectID: __ENV.K6_CLOUD_PROJECT_ID || undefined,
    name: 'runtime-per-service',
    tags: {
      service: 'runtime',
      type: 'per-service',
      tier: __ENV.TIER || 'm',
      env: __ENV.ENV || 'staging',
    },
  },
```

- [ ] **Step 2: Add cloud block to search-ai.ts**

Same pattern, with `name: 'search-ai-per-service'` and `service: 'search-ai'`.

- [ ] **Step 3: Add cloud block to bge-m3.ts**

Same pattern, with `name: 'bge-m3-per-service'` and `service: 'bge-m3'`.

- [ ] **Step 4: Add cloud block to mongodb.ts**

Same pattern, with `name: 'mongodb-per-service'` and `service: 'mongodb'`.

- [ ] **Step 5: Add cloud block to opensearch.ts**

Same pattern, with `name: 'opensearch-per-service'` and `service: 'opensearch'`.

- [ ] **Step 6: Format all modified files**

Run: `npx prettier --write benchmarks/services/runtime.ts benchmarks/services/search-ai.ts benchmarks/services/bge-m3.ts benchmarks/services/mongodb.ts benchmarks/services/opensearch.ts`

- [ ] **Step 7: Verify types compile**

Run: `cd benchmarks && npx tsc --noEmit`
Expected: No errors (the `cloud` property is allowed by k6's `Options` type)

---

### Task 5: Add options.cloud to 3 Integration Scripts

**Files:**

- Modify: `benchmarks/integration/agent-conversation-e2e.ts`
- Modify: `benchmarks/integration/kb-ingestion-e2e.ts`
- Modify: `benchmarks/integration/search-query-e2e.ts`

Same pattern but with `type: 'integration'` and appropriate names:

- [ ] **Step 1: Add cloud block to agent-conversation-e2e.ts**

```typescript
  cloud: {
    projectID: __ENV.K6_CLOUD_PROJECT_ID || undefined,
    name: 'agent-conversation-integration',
    tags: {
      service: 'agent-conversation',
      type: 'integration',
      tier: __ENV.TIER || 'm',
      env: __ENV.ENV || 'staging',
    },
  },
```

- [ ] **Step 2: Add cloud block to kb-ingestion-e2e.ts**

Same pattern, with `name: 'kb-ingestion-integration'` and `service: 'kb-ingestion'`.

- [ ] **Step 3: Add cloud block to search-query-e2e.ts**

Same pattern, with `name: 'search-query-integration'` and `service: 'search-query'`.

- [ ] **Step 4: Format all modified files**

Run: `npx prettier --write benchmarks/integration/agent-conversation-e2e.ts benchmarks/integration/kb-ingestion-e2e.ts benchmarks/integration/search-query-e2e.ts`

- [ ] **Step 5: Verify types compile**

Run: `cd benchmarks && npx tsc --noEmit`
Expected: No errors

---

## Validation Checklist

After all tasks are complete, verify:

- [ ] `benchmarks/config/cloud.env.example` exists with all required env vars
- [ ] `cloud.env` is in `.gitignore`
- [ ] `benchmarks/scripts/cloud-run.sh` is executable (`ls -la` shows `-rwxr-xr-x`)
- [ ] `benchmarks/scripts/cloud-run-suite.sh` is executable
- [ ] All 8 modified scripts have `cloud` block in `options`
- [ ] `cd benchmarks && npx tsc --noEmit` passes with zero errors
- [ ] All files formatted with prettier

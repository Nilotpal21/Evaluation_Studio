#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────────────────
# detect-affected.sh — Detect which services need building based on code changes
#
# Usage:
#   ./tools/detect-affected.sh [target-branch]
#
# Outputs (as environment variable exports):
#   AFFECTED_SERVICES   — comma-separated list of Docker service names to build
#   AFFECTED_PACKAGES   — comma-separated list of turbo --filter values for Node.js
#   RUN_RUNTIME_SMOKE   — "true" if Runtime smoke tests should run in CI
#   HAS_NODE_CHANGES    — "true" if any Node.js app/package changed
#   HAS_PYTHON_CHANGES  — "true" if any Python service changed
#   HAS_STANDALONE_CHANGES — "true" if any standalone (Go/non-Node) app changed
#
# In Harness CI, pipe this script's stdout into an outputVariables step.
# Locally, source it: `source <(./tools/detect-affected.sh develop)`
# ────────────────────────────────────────────────────────────────────────────
set -euo pipefail

TARGET_BRANCH="${1:-main}"

echo "=== Detecting affected modules against origin/${TARGET_BRANCH} ==="

# Ensure we have the target branch ref for comparison.
# Harness CI uses shallow clones — we need enough history to find the merge-base.
# Try progressively deeper fetches if the shallow one can't resolve the diff.
echo "Fetching origin/${TARGET_BRANCH}..."
git fetch origin "${TARGET_BRANCH}" --depth=1 2>/dev/null || true

# If the three-dot diff fails (shallow clone can't find merge-base), deepen
if ! git merge-base "origin/${TARGET_BRANCH}" HEAD >/dev/null 2>&1; then
  echo "Shallow clone insufficient — deepening fetch..."
  git fetch origin "${TARGET_BRANCH}" --deepen=100 2>/dev/null || true
  git fetch --deepen=100 2>/dev/null || true
fi

# Last resort: unshallow if still can't resolve
if ! git merge-base "origin/${TARGET_BRANCH}" HEAD >/dev/null 2>&1; then
  echo "Still insufficient — fetching full history..."
  git fetch origin "${TARGET_BRANCH}" --unshallow 2>/dev/null || git fetch origin "${TARGET_BRANCH}" 2>/dev/null || true
  git fetch --unshallow 2>/dev/null || true
fi

# ── Step 0: Check if PR branch is up to date with target ───────────────────
# Note: In Harness CI, this check is also done in the pipeline YAML before
# pnpm install (to save time). This check here covers local usage.
if git merge-base "origin/${TARGET_BRANCH}" HEAD >/dev/null 2>&1; then
  if ! git merge-base --is-ancestor "origin/${TARGET_BRANCH}" HEAD; then
    echo ""
    echo "============================================================"
    echo "  WARNING: PR branch is behind origin/${TARGET_BRANCH}"
    echo "  Please rebase or merge ${TARGET_BRANCH} into your branch."
    echo "============================================================"
    echo ""
    echo "AFFECTED_SERVICES=none"
    echo "AFFECTED_PACKAGES=none"
    echo "RUN_RUNTIME_SMOKE=false"
    echo "HAS_NODE_CHANGES=false"
    echo "HAS_PYTHON_CHANGES=false"
    echo "HAS_STANDALONE_CHANGES=false"
    echo "BRANCH_BEHIND=true"
    # Exit 0 (not 1) so the pipeline step doesn't fail — the pipeline
    # handles behind-develop skip logic via output variables.
    exit 0
  fi
  echo "PR branch is up to date with origin/${TARGET_BRANCH} ✓"
fi

# ── Step 1: Get changed files ───────────────────────────────────────────────
# Try three-dot (merge-base) first, fall back to two-dot (direct diff)
CHANGED_FILES=$(git diff --name-only "origin/${TARGET_BRANCH}...HEAD" 2>/dev/null || git diff --name-only "origin/${TARGET_BRANCH}" HEAD 2>/dev/null || echo "")

if [ -z "$CHANGED_FILES" ]; then
  echo "No changed files detected."
  echo "AFFECTED_SERVICES=none"
  echo "AFFECTED_PACKAGES=none"
  echo "RUN_RUNTIME_SMOKE=false"
  echo "HAS_NODE_CHANGES=false"
  echo "HAS_PYTHON_CHANGES=false"
  echo "HAS_STANDALONE_CHANGES=false"
  exit 0
fi

echo "Changed files:"
echo "$CHANGED_FILES" | head -50
TOTAL_CHANGED=$(echo "$CHANGED_FILES" | wc -l | tr -d ' ')
if [ "$TOTAL_CHANGED" -gt 50 ]; then
  echo "  ... and $((TOTAL_CHANGED - 50)) more"
fi

# ── Step 2: Detect Python service changes (file-path based) ────────────────
# Python services live under services/ and don't participate in the turbo graph.
PYTHON_SERVICES=""
HAS_PYTHON_CHANGES="false"

for svc in docling-service bge-m3-service preprocessing-service codetool-sandbox; do
  if echo "$CHANGED_FILES" | grep -q "^services/${svc}/"; then
    PYTHON_SERVICES="${PYTHON_SERVICES}${svc},"
    HAS_PYTHON_CHANGES="true"
    echo "  Python service affected: ${svc}"
  fi
done

# ── Step 3: Detect standalone app changes (file-path based) ────────────────
# These are Go/non-Node apps with self-contained Dockerfiles.
STANDALONE_APPS=""
HAS_STANDALONE_CHANGES="false"

for app in nlu-sidecar crawler-go-worker; do
  if echo "$CHANGED_FILES" | grep -q "^apps/${app}/"; then
    STANDALONE_APPS="${STANDALONE_APPS}${app},"
    HAS_STANDALONE_CHANGES="true"
    echo "  Standalone app affected: ${app}"
  fi
done

# ── Step 4: Detect Node.js changes via Turbo dry run ───────────────────────
# turbo --filter=...[ref] includes:
#   - packages/apps that have file changes since ref
#   - ALL transitive dependents of those changed packages
# The --dry=json output tells us exactly which packages would run.
HAS_NODE_CHANGES="false"
TURBO_AFFECTED=""

# Check if any Node.js-relevant files changed (apps/, packages/, root config)
# Exclude standalone (non-Node) apps — they're detected via file-path matching in Step 3
NODE_RELEVANT=$(echo "$CHANGED_FILES" | grep -E "^(apps/|packages/|turbo\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig|package\.json|\.npmrc|\.nvmrc|coverage-thresholds\.json|\.eslintrc)" | grep -vE "^apps/(nlu-sidecar|crawler-go-worker)/" || true)

if [ -n "$NODE_RELEVANT" ]; then
  echo ""
  echo "=== Running Turbo dry run to resolve dependency graph ==="

  # Use turbo build --dry=json to get the full affected package list
  # This resolves the ^build dependency chain automatically.
  # If turbo's git-based filter fails (shallow clone), fall back to building
  # only the packages whose files we know changed (from CHANGED_FILES).
  TURBO_JSON=$(npx turbo run build --filter="...[origin/${TARGET_BRANCH}]" --dry=json 2>/dev/null || echo '{"tasks":[]}')

  # If turbo returned empty (git compare failed), build filter from changed file paths
  TASK_COUNT=$(echo "$TURBO_JSON" | node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log((d.tasks||[]).length)}catch(e){console.log(0)}")
  if [ "$TASK_COUNT" = "0" ]; then
    echo "  Turbo git filter returned empty — falling back to file-path detection"
    # Build --filter flags from changed apps/packages directories
    FALLBACK_FILTERS=""
    for dir in $(echo "$CHANGED_FILES" | grep -oE "^(apps|packages)/[^/]+" | sort -u); do
      FALLBACK_FILTERS="${FALLBACK_FILTERS} --filter=./${dir}"
    done
    if [ -n "$FALLBACK_FILTERS" ]; then
      TURBO_JSON=$(npx turbo run build ${FALLBACK_FILTERS} --dry=json 2>/dev/null || echo '{"tasks":[]}')
    fi
  fi

  # Extract package names from turbo output
  # turbo dry run outputs: { "packages": ["@agent-platform/runtime", ...], "tasks": [...] }
  TURBO_AFFECTED=$(echo "$TURBO_JSON" | node -e "
    const input = require('fs').readFileSync('/dev/stdin', 'utf8');
    try {
      const data = JSON.parse(input);
      // Get unique package names from tasks array
      const packages = [...new Set((data.tasks || []).map(t => t.package))];
      console.log(packages.join(','));
    } catch(e) {
      // Fallback: try packages array
      try {
        const data = JSON.parse(input);
        console.log((data.packages || []).join(','));
      } catch(e2) {
        console.log('');
      }
    }
  ")

  if [ -n "$TURBO_AFFECTED" ]; then
    HAS_NODE_CHANGES="true"
    echo "  Turbo affected packages: ${TURBO_AFFECTED}"
  fi
fi

# ── Step 5: Map affected packages → Docker services ───────────────────────
# Only apps that have Dockerfiles become Docker services.
# Shared packages don't produce Docker images — they affect apps transitively.
NODE_SERVICES=""
FILTER_FLAGS=""

# Map turbo package names to Docker service names
for pkg in $(echo "$TURBO_AFFECTED" | tr ',' ' '); do
  case "$pkg" in
    @agent-platform/runtime)          NODE_SERVICES="${NODE_SERVICES}runtime,";          FILTER_FLAGS="${FILTER_FLAGS} --filter=@agent-platform/runtime" ;;
    @agent-platform/studio)           NODE_SERVICES="${NODE_SERVICES}studio,";           FILTER_FLAGS="${FILTER_FLAGS} --filter=@agent-platform/studio" ;;
    @agent-platform/admin)            NODE_SERVICES="${NODE_SERVICES}admin,";            FILTER_FLAGS="${FILTER_FLAGS} --filter=@agent-platform/admin" ;;
    @agent-platform/search-ai)        NODE_SERVICES="${NODE_SERVICES}search-ai,";        FILTER_FLAGS="${FILTER_FLAGS} --filter=@agent-platform/search-ai" ;;
    @agent-platform/search-ai-runtime) NODE_SERVICES="${NODE_SERVICES}search-ai-runtime,"; FILTER_FLAGS="${FILTER_FLAGS} --filter=@agent-platform/search-ai-runtime" ;;
    @agent-platform/workflow-engine)  NODE_SERVICES="${NODE_SERVICES}workflow-engine,";  FILTER_FLAGS="${FILTER_FLAGS} --filter=@agent-platform/workflow-engine" ;;
    @agent-platform/multimodal-service) NODE_SERVICES="${NODE_SERVICES}multimodal-service,"; FILTER_FLAGS="${FILTER_FLAGS} --filter=@agent-platform/multimodal-service" ;;
    @agent-platform/crawler-mcp-server) NODE_SERVICES="${NODE_SERVICES}crawler-mcp-server,"; FILTER_FLAGS="${FILTER_FLAGS} --filter=@agent-platform/crawler-mcp-server" ;;
    # Shared packages don't map to services — they affect apps transitively (already handled by turbo)
    *) ;;
  esac
done

# ── Step 6: Check if root config files changed (affects everything) ─────────
ROOT_CONFIG_CHANGED="false"
if echo "$CHANGED_FILES" | grep -qE "^(pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|\.npmrc|\.nvmrc|tsconfig\.json|package\.json|coverage-thresholds\.json|\.eslintrc\.base\.json|commitlint\.config\.ts)$"; then
  ROOT_CONFIG_CHANGED="true"
  echo ""
  echo "  WARNING: Root config files changed — all Node.js services are affected"
  # When root config changes, we need to build and test everything
  NODE_SERVICES="runtime,studio,admin,search-ai,search-ai-runtime,workflow-engine,multimodal-service,crawler-mcp-server,"
  FILTER_FLAGS=""  # Empty means full build (no --filter = build all)
  HAS_NODE_CHANGES="true"
fi

# ── Step 7: Combine all affected services ──────────────────────────────────
ALL_SERVICES="${NODE_SERVICES}${PYTHON_SERVICES}${STANDALONE_APPS}"
# Remove trailing comma and deduplicate
ALL_SERVICES=$(echo "$ALL_SERVICES" | tr ',' '\n' | sort -u | grep -v '^$' | tr '\n' ',' | sed 's/,$//')

if [ -z "$ALL_SERVICES" ]; then
  ALL_SERVICES="none"
fi

# Trim filter flags
FILTER_FLAGS=$(echo "$FILTER_FLAGS" | xargs)

# Keep runtime in the fast Node.js lane even when other workspaces changed so
# the shared runtime regression ring is not skipped by selective PR detection.
if [ "$HAS_NODE_CHANGES" = "true" ] && [ "$ROOT_CONFIG_CHANGED" != "true" ]; then
  case " ${FILTER_FLAGS} " in
    *" --filter=@agent-platform/runtime "*)
      ;;
    *)
      FILTER_FLAGS=$(echo "${FILTER_FLAGS} --filter=@agent-platform/runtime" | xargs)
      ;;
  esac
fi

# ── Step 8: Determine CI smoke-test scope ──────────────────────────────────
RUN_RUNTIME_SMOKE="false"

if echo ",$ALL_SERVICES," | grep -q ",runtime,"; then
  RUN_RUNTIME_SMOKE="true"
fi

# ── Output ──────────────────────────────────────────────────────────────────
echo ""
echo "=== Detection Results ==="
echo "AFFECTED_SERVICES=${ALL_SERVICES}"
echo "AFFECTED_PACKAGES=${FILTER_FLAGS:-all}"
echo "RUN_RUNTIME_SMOKE=${RUN_RUNTIME_SMOKE}"
echo "HAS_NODE_CHANGES=${HAS_NODE_CHANGES}"
echo "HAS_PYTHON_CHANGES=${HAS_PYTHON_CHANGES}"
echo "HAS_STANDALONE_CHANGES=${HAS_STANDALONE_CHANGES}"
echo "ROOT_CONFIG_CHANGED=${ROOT_CONFIG_CHANGED}"

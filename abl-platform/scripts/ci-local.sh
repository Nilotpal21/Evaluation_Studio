#!/usr/bin/env bash
# =============================================================================
# Local CI Simulation
#
# Runs the same build+test steps as the Harness CI pipeline inside the same
# Docker image (node:22-bookworm-slim). Catches environment-specific failures
# before pushing.
#
# Usage:
#   ./scripts/ci-local.sh          # build + test
#   ./scripts/ci-local.sh build    # build only
#   ./scripts/ci-local.sh test     # test only (assumes build cache exists)
#   ./scripts/ci-local.sh shell    # drop into container for debugging
# =============================================================================

set -euo pipefail

IMAGE="node:22-bookworm-slim"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STEP="${1:-all}"

echo "=== CI Local: using ${IMAGE} ==="
echo "=== Repo: ${REPO_ROOT} ==="
echo ""

docker_run() {
  docker run --rm -it \
    -v "${REPO_ROOT}:/harness" \
    -w /harness \
    -e TURBO_TELEMETRY_DISABLED=1 \
    -e NODE_OPTIONS="--max-old-space-size=3072" \
    "${IMAGE}" \
    bash -c "$1"
}

case "${STEP}" in
  build)
    echo "=== Step: Build ==="
    docker_run "corepack enable && pnpm install --frozen-lockfile && pnpm turbo build --concurrency=3"
    ;;
  test)
    echo "=== Step: Test ==="
    docker_run "corepack enable && pnpm turbo test"
    ;;
  shell)
    echo "=== Dropping into container shell ==="
    docker run --rm -it \
      -v "${REPO_ROOT}:/harness" \
      -w /harness \
      -e TURBO_TELEMETRY_DISABLED=1 \
      -e NODE_OPTIONS="--max-old-space-size=3072" \
      "${IMAGE}" \
      bash
    ;;
  all|"")
    echo "=== Step 1/3: Install ==="
    docker_run "corepack enable && pnpm install --frozen-lockfile"
    echo ""
    echo "=== Step 2/3: Build ==="
    docker_run "corepack enable && pnpm turbo build --concurrency=3"
    echo ""
    echo "=== Step 3/3: Test ==="
    docker_run "corepack enable && pnpm turbo test"
    echo ""
    echo "=== All steps passed ==="
    ;;
  *)
    echo "Usage: $0 [build|test|shell|all]"
    exit 1
    ;;
esac

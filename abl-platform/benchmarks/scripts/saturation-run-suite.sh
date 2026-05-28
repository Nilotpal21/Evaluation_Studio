#!/usr/bin/env bash
set -euo pipefail

# Convenience wrapper around `npx kore-platform-cli sizing benchmark`.
#
# Usage:
#   ./benchmarks/scripts/saturation-run-suite.sh
#   TIER=m SERVICES=@compute ./benchmarks/scripts/saturation-run-suite.sh
#   SERVICES=runtime,redis OUTPUT_DIR=./my-results ./benchmarks/scripts/saturation-run-suite.sh
#
# Environment:
#   TIER        - Sizing tier (s/m/l/xl, default: s)
#   SERVICES    - Comma-separated services or @category (default: all)
#                 Categories: @all, @compute, @data-stores, @ai, @integration
#   OUTPUT_DIR  - Output directory for results (default: benchmarks/results/saturation)

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "${REPO_ROOT}/benchmarks/scripts/lib/service-groups.sh"

CONFIG_FILE="${REPO_ROOT}/benchmarks/config/cloud.env"

# Source config if available
if [ -f "$CONFIG_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
  set +a
fi

TIER="${TIER:-s}"
SERVICES="${SERVICES:-}"
RESOLVED_SERVICES=$(resolve_services "$SERVICES")
OUTPUT_DIR="${OUTPUT_DIR:-${REPO_ROOT}/benchmarks/results/saturation}"

mkdir -p "$OUTPUT_DIR"

echo "=== Saturation Benchmark Suite ==="
echo "  Tier:       ${TIER}"
print_service_selection "$SERVICES" "$RESOLVED_SERVICES"
echo "  Output:     ${OUTPUT_DIR}"
echo ""

# Build CLI arguments
CLI_ARGS=(sizing benchmark --tier "$TIER" --output-dir "$OUTPUT_DIR")

# Add services filter if specified
if [ -n "$SERVICES" ]; then
  CLI_ARGS+=(--services "$SERVICES")
fi

echo "Running: npx kore-platform-cli ${CLI_ARGS[*]}"
echo ""

cd "$REPO_ROOT"
npx kore-platform-cli "${CLI_ARGS[@]}"

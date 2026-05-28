#!/usr/bin/env bash
set -euo pipefail

# Compatibility wrapper. The saturation-finder skill uses k6 Cloud plus
# Kubernetes fallback polling; the implementation lives in cluster-poll.sh.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "${SCRIPT_DIR}/cluster-poll.sh" "$@"

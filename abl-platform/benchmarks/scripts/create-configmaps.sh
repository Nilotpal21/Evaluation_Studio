#!/bin/bash
# Creates ConfigMaps from all k6 benchmark scripts for k6 Operator TestRuns.
# Usage: ./benchmarks/scripts/create-configmaps.sh [namespace]

set -euo pipefail

NAMESPACE=${1:-abl-benchmarks}
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Creating ConfigMaps in namespace: ${NAMESPACE}"
echo "Script directory: ${SCRIPT_DIR}"

# Ensure namespace exists
kubectl get namespace "$NAMESPACE" >/dev/null 2>&1 || {
  echo "Creating namespace ${NAMESPACE}..."
  kubectl create namespace "$NAMESPACE"
}

# Per-service benchmark scripts
echo ""
echo "=== Per-service benchmarks ==="
for script in "${SCRIPT_DIR}"/services/*.ts; do
  [ -f "$script" ] || continue
  name="$(basename "$script" .ts)-benchmark-script"
  echo "  Creating: ${name}"
  kubectl create configmap "$name" \
    --from-file="$(basename "$script")=$script" \
    -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
done

# Integration benchmark scripts
echo ""
echo "=== Integration benchmarks ==="
for script in "${SCRIPT_DIR}"/integration/*.ts; do
  [ -f "$script" ] || continue
  name="$(basename "$script" .ts)-script"
  echo "  Creating: ${name}"
  kubectl create configmap "$name" \
    --from-file="$(basename "$script")=$script" \
    -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
done

# System-wide benchmark scripts
echo ""
echo "=== System-wide benchmarks ==="
for script in "${SCRIPT_DIR}"/system/*.ts; do
  [ -f "$script" ] || continue
  name="$(basename "$script" .ts)-script"
  echo "  Creating: ${name}"
  kubectl create configmap "$name" \
    --from-file="$(basename "$script")=$script" \
    -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
done

# Shared libraries
echo ""
echo "=== Shared libraries ==="
kubectl create configmap benchmark-lib \
  --from-file=config.js="${SCRIPT_DIR}/lib/config.ts" \
  --from-file=auth.js="${SCRIPT_DIR}/lib/auth.ts" \
  --from-file=metrics.js="${SCRIPT_DIR}/lib/metrics.ts" \
  -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
echo "  Created: benchmark-lib"

# Setup/teardown scripts
echo ""
echo "=== Setup/Teardown ==="
kubectl create configmap benchmark-setup-script \
  --from-file=bootstrap.ts="${SCRIPT_DIR}/setup/bootstrap.ts" \
  -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
echo "  Created: benchmark-setup-script"

kubectl create configmap benchmark-teardown-script \
  --from-file=teardown.ts="${SCRIPT_DIR}/setup/teardown.ts" \
  -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
echo "  Created: benchmark-teardown-script"

echo ""
echo "=== Done ==="
echo "All ConfigMaps created in namespace ${NAMESPACE}"

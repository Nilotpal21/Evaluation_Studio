#!/usr/bin/env bash
# Register the pipeline-worker deployment and Kafka subscriptions with Restate.
#
# NOTE: Auto-registration is now built into server.ts — the pipeline engine
# registers itself with Restate and creates Kafka subscriptions on startup.
# This script is kept as a manual fallback for debugging or re-registration.
#
# Run this AFTER:
#   1. docker compose up -d --wait   (infrastructure is healthy)
#   2. pnpm dev                      (pipeline-worker listening on :9082)
#
# Usage:
#   ./docker/register-services.sh
#   RESTATE_ADMIN=http://localhost:9070 WORKER=http://host.docker.internal:9082 ./docker/register-services.sh
set -euo pipefail

RESTATE_ADMIN="${RESTATE_ADMIN:-http://localhost:9070}"
# host.docker.internal lets Restate (in Docker) reach the worker running on the host
WORKER="${WORKER:-http://host.docker.internal:9082}"

echo "==> Registering pipeline-worker with Restate..."
echo "    Admin:  ${RESTATE_ADMIN}"
echo "    Worker: ${WORKER}"
echo ""

curl -sf -X POST "${RESTATE_ADMIN}/deployments" \
  -H "Content-Type: application/json" \
  -d "{\"uri\": \"${WORKER}\"}" \
  | python3 -m json.tool 2>/dev/null || true

echo ""
echo "==> Creating Kafka subscriptions..."

TOPICS=(
  "abl.session.created"
  "abl.session.ended"
  "abl.session.handoff"
  "abl.session.escalation"
  "abl.message.user"
  "abl.message.agent"
  "abl.tool.called"
  "abl.tool.completed"
)

for topic in "${TOPICS[@]}"; do
  echo "    Subscribing: ${topic} → PipelineTrigger/handleEvent"
  curl -sf -X POST "${RESTATE_ADMIN}/subscriptions" \
    -H "Content-Type: application/json" \
    -d "{
      \"source\": \"kafka://local/${topic}\",
      \"sink\": \"service://PipelineTrigger/handleEvent\"
    }" \
    | python3 -m json.tool 2>/dev/null || true
done

echo ""
echo "==> Done!"
echo ""
echo "Endpoints:"
echo "  Restate Ingress:  http://localhost:8080"
echo "  Restate Admin:    ${RESTATE_ADMIN}"
echo "  Kafka UI:         http://localhost:8090"
echo "  MongoDB:          mongodb://localhost:27018  (abl-platform)"
echo "  Redis:            redis://localhost:6380     (abl-platform)"
echo "  Pipeline Worker:  http://localhost:9082"

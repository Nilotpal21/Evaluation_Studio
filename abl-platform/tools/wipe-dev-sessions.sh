#!/usr/bin/env bash
# wipe-dev-sessions.sh — Clear all session data from dev environment
# Run this ONCE before deploying single-session-ID code.
#
# SAFETY: Refuses to run unless NODE_ENV=development or ABL_ENV=dev.
#         Also blocked by hostname checks for known production hosts.
#
# Usage: tools/wipe-dev-sessions.sh [--include-traces]
#
# Clears:
#   - MongoDB: sessions, messages, channel_sessions collections
#   - Redis: session:* keys
#   - ClickHouse: platform_events (only with --include-traces)

set -euo pipefail

# ── Production guard ──────────────────────────────────────────────────
BLOCKED_HOSTS="prod|production|staging|stg|live"
if echo "${HOSTNAME:-$(hostname)}" | grep -qiE "$BLOCKED_HOSTS"; then
  echo "FATAL: This script cannot run on host '$(hostname)' (matches production pattern)." >&2
  exit 1
fi

ENV="${ABL_ENV:-${NODE_ENV:-}}"
if [[ "$ENV" != "development" && "$ENV" != "dev" && "$ENV" != "test" && "$ENV" != "local" ]]; then
  echo "FATAL: Refusing to wipe data — NODE_ENV or ABL_ENV must be 'development', 'dev', 'test', or 'local'." >&2
  echo "Current: NODE_ENV=${NODE_ENV:-<unset>}, ABL_ENV=${ABL_ENV:-<unset>}" >&2
  echo "Set ABL_ENV=dev to proceed." >&2
  exit 1
fi

MONGO_URI="${MONGODB_URI:-mongodb://localhost:27017/abl_platform}"
if echo "$MONGO_URI" | grep -qiE "production|prod[-.]|prod[a-z]*\.mongodb|live[-.]|atlas"; then
  echo "FATAL: MongoDB URI looks like production: $MONGO_URI" >&2
  exit 1
fi
# ── End production guard ──────────────────────────────────────────────

INCLUDE_TRACES=false
if [[ "${1:-}" == "--include-traces" ]]; then
  INCLUDE_TRACES=true
fi

echo "=== Wiping dev session data (env=$ENV) ==="
echo "    MongoDB: $MONGO_URI"

# Confirmation prompt
read -r -p "This will DELETE all sessions, messages, and channel_sessions. Continue? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Aborted."
  exit 0
fi

# MongoDB
echo "[1/3] Clearing MongoDB sessions, messages, and channel_sessions..."
mongosh "$MONGO_URI" --quiet --eval '
  const sessCount = db.sessions.countDocuments();
  const msgCount = db.messages.countDocuments();
  const chSessCount = db.channel_sessions.countDocuments();
  const ssCount = db.session_states.countDocuments();
  db.sessions.deleteMany({});
  db.messages.deleteMany({});
  db.channel_sessions.deleteMany({});
  db.session_states.deleteMany({});
  db.audit_events.deleteMany({});
  print(`Deleted ${sessCount} sessions, ${msgCount} messages, ${chSessCount} channel_sessions, ${ssCount} session_states, and audit_events`);
'

# Redis
echo "[2/3] Clearing Redis session keys..."
REDIS_URL="${REDIS_URL:-redis://localhost:6380}"
redis-cli -u "$REDIS_URL" --scan --pattern "session:*" | xargs -r redis-cli -u "$REDIS_URL" DEL 2>/dev/null || true
redis-cli -u "$REDIS_URL" --scan --pattern "sess:*" | xargs -r redis-cli -u "$REDIS_URL" DEL 2>/dev/null || true
redis-cli -u "$REDIS_URL" --scan --pattern "trace:*" | xargs -r redis-cli -u "$REDIS_URL" DEL 2>/dev/null || true
redis-cli -u "$REDIS_URL" --scan --pattern "registry:*" | xargs -r redis-cli -u "$REDIS_URL" DEL 2>/dev/null || true
redis-cli -u "$REDIS_URL" --scan --pattern "lock:exec:*" | xargs -r redis-cli -u "$REDIS_URL" DEL 2>/dev/null || true
redis-cli -u "$REDIS_URL" --scan --pattern "sess-tid:*" | xargs -r redis-cli -u "$REDIS_URL" DEL 2>/dev/null || true
redis-cli -u "$REDIS_URL" --scan --pattern "resolve:*" | xargs -r redis-cli -u "$REDIS_URL" DEL 2>/dev/null || true
redis-cli -u "$REDIS_URL" --scan --pattern "ir:*" | xargs -r redis-cli -u "$REDIS_URL" DEL 2>/dev/null || true
redis-cli -u "$REDIS_URL" --scan --pattern "comp:*" | xargs -r redis-cli -u "$REDIS_URL" DEL 2>/dev/null || true
echo "Redis session keys cleared"

# ClickHouse (optional)
if [ "$INCLUDE_TRACES" = true ]; then
  echo "[3/3] Truncating ClickHouse platform_events..."
  CLICKHOUSE_URL="${CLICKHOUSE_URL:-http://localhost:8124}"
  curl -s "$CLICKHOUSE_URL" -d "TRUNCATE TABLE IF EXISTS abl_platform.platform_events" || echo "ClickHouse truncate failed (table may not exist)"
  curl -s "$CLICKHOUSE_URL" -d "TRUNCATE TABLE IF EXISTS abl_platform.audit_events" || echo "ClickHouse audit truncate failed"
  echo "ClickHouse traces cleared"
else
  echo "[3/3] Skipping ClickHouse traces (use --include-traces to clear)"
fi

echo ""
echo "=== Done. Deploy single-ID code now. ==="

#!/usr/bin/env bash
# ClickHouse Table Optimization — One-Time Maintenance
#
# Runs OPTIMIZE TABLE ... FINAL on ReplacingMergeTree tables to force
# merge of all parts and eliminate duplicates. This reduces:
# - Unmerged part count (fewer parts = faster queries)
# - FINAL query overhead (less dedup work needed)
# - Background merge pressure (fewer pending merges)
#
# WARNING: This is I/O intensive and should be run during low-traffic periods.
# Each OPTIMIZE can take minutes depending on table size.
#
# Usage:
#   ./scripts/clickhouse-optimize.sh              # Optimize all tables
#   ./scripts/clickhouse-optimize.sh --dry-run    # Show what would be optimized
#   ./scripts/clickhouse-optimize.sh --table X    # Optimize single table
#
# Requires: CLICKHOUSE_URL or port-forward to ClickHouse
#   kubectl port-forward -n abl-platform-dev svc/abl-platform-dev-clickhouse 8123:8123

set -euo pipefail

CH_URL="${CLICKHOUSE_URL:-http://abl_admin:abl_dev_password@localhost:8124}"
DRY_RUN=false
SINGLE_TABLE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --table)   SINGLE_TABLE="$2"; shift 2 ;;
    *)         echo "Unknown arg: $1"; exit 1 ;;
  esac
done

query() {
  curl -s "${CH_URL}" --data-binary "$1" 2>/dev/null
}

exec_query() {
  if $DRY_RUN; then
    echo "  [DRY RUN] $1"
  else
    echo "  Executing: $1"
    local result
    result=$(curl -sw '\n%{http_code}' "${CH_URL}" --data-binary "$1" 2>/dev/null)
    local http_code
    http_code=$(echo "$result" | tail -1)
    local body
    body=$(echo "$result" | sed '$d')
    if [[ "$http_code" != "200" ]]; then
      echo "  ERROR (HTTP $http_code): $body"
      return 1
    fi
    echo "  OK"
  fi
}

echo "=== ClickHouse Table Optimization ==="
echo "ClickHouse: ${CH_URL//:*@/:***@}"
echo "Mode: $( $DRY_RUN && echo 'DRY RUN' || echo 'LIVE' )"
echo ""

# ─── Step 1: Show current part counts ────────────────────────────────────────

echo "━━━ CURRENT TABLE STATISTICS ━━━"
echo ""
query "
SELECT
  database || '.' || table AS table_name,
  engine,
  count() AS total_parts,
  countIf(active) AS active_parts,
  formatReadableSize(sum(bytes_on_disk)) AS disk_size,
  sum(rows) AS total_rows,
  max(modification_time) AS last_modified
FROM system.parts
WHERE database = 'abl_platform'
  AND active = 1
GROUP BY database, table, engine
HAVING active_parts > 1
ORDER BY active_parts DESC
FORMAT PrettyCompactMonoBlock
"
echo ""

# ─── Step 2: Optimize tables ─────────────────────────────────────────────────

# Tables that benefit from OPTIMIZE:
# - ReplacingMergeTree tables (dedup on merge)
# - Tables with many active parts (fragmented)

TABLES_TO_OPTIMIZE=(
  "abl_platform.platform_events_by_session"
  "abl_platform.facts"
  "abl_platform.platform_events"
  "abl_platform.llm_metrics"
  "abl_platform.messages"
  "abl_platform.audit_events"
  "abl_platform.platform_events_voice_hourly_dest"
  "abl_platform.platform_events_agent_hourly_dest"
  "abl_platform.platform_events_error_hourly_dest"
)

if [[ -n "$SINGLE_TABLE" ]]; then
  TABLES_TO_OPTIMIZE=("$SINGLE_TABLE")
fi

echo "━━━ OPTIMIZING TABLES ━━━"
echo ""

for table in "${TABLES_TO_OPTIMIZE[@]}"; do
  # Get current part count
  parts=$(query "SELECT countIf(active) FROM system.parts WHERE database || '.' || table = '${table}' FORMAT TabSeparated" 2>/dev/null | tr -d '[:space:]')

  if [[ -z "$parts" || "$parts" == "0" ]]; then
    echo "[$table] Skipping — no parts found"
    continue
  fi

  echo "[$table] Active parts: $parts"

  if [[ "$parts" -le 3 ]]; then
    echo "  Already well-merged ($parts parts), skipping"
    echo ""
    continue
  fi

  # OPTIMIZE TABLE ... FINAL forces all parts to merge
  # PARTITION by recent date reduces scope (don't rewrite entire history)
  today=$(date +%Y-%m-%d)
  yesterday=$(date -v-1d +%Y-%m-%d 2>/dev/null || date -d 'yesterday' +%Y-%m-%d)
  week_ago=$(date -v-7d +%Y-%m-%d 2>/dev/null || date -d '7 days ago' +%Y-%m-%d)

  # Optimize recent partitions first (most impactful)
  echo "  Optimizing last 7 days of partitions..."
  for i in $(seq 0 6); do
    part_date=$(date -v-${i}d +%Y-%m-%d 2>/dev/null || date -d "${i} days ago" +%Y-%m-%d)
    exec_query "OPTIMIZE TABLE ${table} PARTITION '${part_date}' FINAL SETTINGS max_execution_time = 120" || true
  done

  # Show result
  if ! $DRY_RUN; then
    new_parts=$(query "SELECT countIf(active) FROM system.parts WHERE database || '.' || table = '${table}' FORMAT TabSeparated" 2>/dev/null | tr -d '[:space:]')
    echo "  Parts: $parts → $new_parts"
  fi
  echo ""
done

# ─── Step 3: Show results ────────────────────────────────────────────────────

if ! $DRY_RUN; then
  echo "━━━ AFTER OPTIMIZATION ━━━"
  echo ""
  query "
  SELECT
    database || '.' || table AS table_name,
    count() AS total_parts,
    countIf(active) AS active_parts,
    formatReadableSize(sum(bytes_on_disk)) AS disk_size,
    sum(rows) AS total_rows
  FROM system.parts
  WHERE database = 'abl_platform'
    AND active = 1
  GROUP BY database, table
  HAVING active_parts > 1
  ORDER BY active_parts DESC
  FORMAT PrettyCompactMonoBlock
  "
  echo ""
fi

echo "━━━ DONE ━━━"

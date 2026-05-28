#!/usr/bin/env bash
# ClickHouse Slow Query Analyzer
#
# Queries system.query_log on the dev cluster to find:
# 1. Slowest queries in the last N hours
# 2. Queries that hit memory limits
# 3. Most frequent queries by pattern
# 4. Table-level read statistics
#
# Usage:
#   ./scripts/clickhouse-slow-queries.sh [hours] [min_duration_ms]
#   ./scripts/clickhouse-slow-queries.sh 24 1000   # Last 24h, queries > 1s
#   ./scripts/clickhouse-slow-queries.sh            # Default: last 6h, > 500ms
#
# Requires: CLICKHOUSE_URL or port-forward to ClickHouse
#   kubectl port-forward -n abl-platform-dev svc/abl-platform-dev-clickhouse 8123:8123

set -euo pipefail

HOURS="${1:-6}"
MIN_DURATION_MS="${2:-500}"
CH_URL="${CLICKHOUSE_URL:-http://localhost:8123}"

query() {
  curl -s "${CH_URL}" --data-binary "$1" 2>/dev/null
}

echo "=== ClickHouse Slow Query Report ==="
echo "Time range: last ${HOURS}h | Min duration: ${MIN_DURATION_MS}ms"
echo "ClickHouse: ${CH_URL}"
echo ""

# ─── 1. Top 20 slowest queries ──────────────────────────────────────────────

echo "━━━ TOP 20 SLOWEST QUERIES ━━━"
echo ""
query "
SELECT
    query_duration_ms,
    formatReadableSize(memory_usage) AS peak_memory,
    formatReadableSize(read_bytes) AS read_bytes,
    read_rows,
    type,
    query_kind,
    replaceRegexpAll(query, '\\\\s+', ' ') AS query_short
FROM system.query_log
WHERE event_time >= now() - INTERVAL ${HOURS} HOUR
  AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
  AND query_duration_ms >= ${MIN_DURATION_MS}
  AND is_initial_query = 1
  AND query NOT LIKE '%system.query_log%'
ORDER BY query_duration_ms DESC
LIMIT 20
FORMAT PrettyCompactMonoBlock
"
echo ""

# ─── 2. Queries that failed with memory/timeout errors ──────────────────────

echo "━━━ FAILED QUERIES (Memory/Timeout/Exception) ━━━"
echo ""
query "
SELECT
    event_time,
    query_duration_ms,
    formatReadableSize(memory_usage) AS peak_memory,
    exception_code,
    substring(exception, 1, 150) AS exception_short,
    substring(replaceRegexpAll(query, '\\\\s+', ' '), 1, 200) AS query_short
FROM system.query_log
WHERE event_time >= now() - INTERVAL ${HOURS} HOUR
  AND type = 'ExceptionWhileProcessing'
  AND is_initial_query = 1
  AND query NOT LIKE '%system.query_log%'
ORDER BY event_time DESC
LIMIT 20
FORMAT PrettyCompactMonoBlock
"
echo ""

# ─── 3. Query patterns by average duration ──────────────────────────────────

echo "━━━ QUERY PATTERNS BY AVG DURATION ━━━"
echo ""
query "
SELECT
    count() AS executions,
    round(avg(query_duration_ms)) AS avg_ms,
    max(query_duration_ms) AS max_ms,
    round(avg(memory_usage / 1048576)) AS avg_mem_mb,
    max(memory_usage / 1048576) AS max_mem_mb,
    formatReadableSize(sum(read_bytes)) AS total_read,
    toString(normalized_query_hash) AS hash,
    substring(replaceRegexpAll(query, '\\\\s+', ' '), 1, 120) AS query_pattern
FROM system.query_log
WHERE event_time >= now() - INTERVAL ${HOURS} HOUR
  AND type = 'QueryFinish'
  AND is_initial_query = 1
  AND query NOT LIKE '%system.query_log%'
  AND query_duration_ms >= 100
GROUP BY normalized_query_hash, query_pattern
HAVING executions >= 2
ORDER BY avg_ms DESC
LIMIT 20
FORMAT PrettyCompactMonoBlock
"
echo ""

# ─── 4. Table-level read stats ──────────────────────────────────────────────

echo "━━━ TABLE READ STATISTICS ━━━"
echo ""
query "
SELECT
    arrayJoin(tables) AS table_name,
    count() AS query_count,
    round(avg(query_duration_ms)) AS avg_ms,
    max(query_duration_ms) AS max_ms,
    formatReadableSize(sum(read_bytes)) AS total_read,
    sum(read_rows) AS total_rows
FROM system.query_log
WHERE event_time >= now() - INTERVAL ${HOURS} HOUR
  AND type = 'QueryFinish'
  AND is_initial_query = 1
  AND query NOT LIKE '%system.query_log%'
  AND length(tables) > 0
GROUP BY table_name
ORDER BY avg_ms DESC
LIMIT 20
FORMAT PrettyCompactMonoBlock
"
echo ""

# ─── 5. FINAL queries (expensive dedup) ─────────────────────────────────────

echo "━━━ QUERIES USING FINAL (ReplacingMergeTree dedup) ━━━"
echo ""
query "
SELECT
    count() AS executions,
    round(avg(query_duration_ms)) AS avg_ms,
    max(query_duration_ms) AS max_ms,
    formatReadableSize(avg(read_bytes)) AS avg_read,
    substring(replaceRegexpAll(query, '\\\\s+', ' '), 1, 200) AS query_pattern
FROM system.query_log
WHERE event_time >= now() - INTERVAL ${HOURS} HOUR
  AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
  AND is_initial_query = 1
  AND query LIKE '%FINAL%'
  AND query NOT LIKE '%system.query_log%'
GROUP BY query_pattern
ORDER BY max_ms DESC
LIMIT 15
FORMAT PrettyCompactMonoBlock
"
echo ""

# ─── 6. Background merge activity ───────────────────────────────────────────

echo "━━━ MERGE ACTIVITY (Background) ━━━"
echo ""
query "
SELECT
    table,
    count() AS merge_count,
    round(avg(duration_ms)) AS avg_ms,
    max(duration_ms) AS max_ms,
    formatReadableSize(sum(bytes)) AS total_bytes,
    sum(rows) AS total_rows,
    countIf(exception != '') AS failed_merges
FROM system.part_log
WHERE event_time >= now() - INTERVAL ${HOURS} HOUR
  AND event_type = 'MergeParts'
GROUP BY table
ORDER BY max_ms DESC
LIMIT 15
FORMAT PrettyCompactMonoBlock
"
echo ""

# ─── 7. Memory usage summary ────────────────────────────────────────────────

echo "━━━ CURRENT MEMORY USAGE ━━━"
echo ""
query "
SELECT
    metric,
    formatReadableSize(value) AS value
FROM system.metrics
WHERE metric IN (
    'MemoryTracking',
    'MemoryResident',
    'MergesMutationsMemoryTracking',
    'BackgroundMergesAndMutationsPoolSize'
)
FORMAT PrettyCompactMonoBlock
"
echo ""

echo "━━━ END REPORT ━━━"

/**
 * ClickHouse Diagnostics Routes
 *
 * Admin-only endpoints for diagnosing ClickHouse performance issues.
 * Queries system.query_log, system.part_log, system.metrics.
 *
 * Mounted at /api/admin/clickhouse
 */

import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('clickhouse-diagnostics');

const router: RouterType = Router();
router.use(authMiddleware);

// Only allow platform admins (check role or specific permission)
router.use((req, res, next) => {
  const role = req.tenantContext?.role;
  if (role !== 'OWNER' && role !== 'ADMIN') {
    res.status(403).json({ success: false, error: 'Admin access required' });
    return;
  }
  next();
});

async function chQuery(sql: string): Promise<unknown[]> {
  const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
  const client = getClickHouseClient();
  if (!client) throw new Error('ClickHouse client not available');
  const result = await client.query({ query: sql, format: 'JSONEachRow' });
  return result.json();
}

/**
 * GET /slow-queries?hours=6&min_ms=500&limit=20
 * Top slowest queries from system.query_log
 */
router.get('/slow-queries', async (req, res) => {
  try {
    const hours = Math.min(Number(req.query.hours) || 6, 72);
    const minMs = Number(req.query.min_ms) || 500;
    const limit = Math.min(Number(req.query.limit) || 20, 100);

    const rows = await chQuery(`
      SELECT
        event_time,
        query_duration_ms,
        memory_usage,
        read_bytes,
        read_rows,
        result_rows,
        type,
        exception_code,
        substring(exception, 1, 200) AS exception_short,
        substring(replaceRegexpAll(query, '\\\\s+', ' '), 1, 300) AS query_short,
        arrayStringConcat(tables, ', ') AS tables_used
      FROM system.query_log
      WHERE event_time >= now() - INTERVAL ${hours} HOUR
        AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
        AND query_duration_ms >= ${minMs}
        AND is_initial_query = 1
        AND query NOT LIKE '%system.query_log%'
        AND query NOT LIKE '%system.part_log%'
        AND query NOT LIKE '%system.metrics%'
      ORDER BY query_duration_ms DESC
      LIMIT ${limit}
      SETTINGS max_execution_time = 10
    `);

    res.json({ success: true, data: { hours, minMs, count: rows.length, queries: rows } });
  } catch (err) {
    log.error('Failed to query slow queries', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Query failed',
    });
  }
});

/**
 * GET /failed-queries?hours=6&limit=20
 * Queries that failed with exceptions (memory, timeout, etc.)
 */
router.get('/failed-queries', async (req, res) => {
  try {
    const hours = Math.min(Number(req.query.hours) || 6, 72);
    const limit = Math.min(Number(req.query.limit) || 20, 100);

    const rows = await chQuery(`
      SELECT
        event_time,
        query_duration_ms,
        memory_usage,
        exception_code,
        substring(exception, 1, 300) AS exception_text,
        substring(replaceRegexpAll(query, '\\\\s+', ' '), 1, 300) AS query_short,
        arrayStringConcat(tables, ', ') AS tables_used
      FROM system.query_log
      WHERE event_time >= now() - INTERVAL ${hours} HOUR
        AND type = 'ExceptionWhileProcessing'
        AND is_initial_query = 1
        AND query NOT LIKE '%system.%'
      ORDER BY event_time DESC
      LIMIT ${limit}
      SETTINGS max_execution_time = 10
    `);

    res.json({ success: true, data: { hours, count: rows.length, queries: rows } });
  } catch (err) {
    log.error('Failed to query failed queries', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Query failed',
    });
  }
});

/**
 * GET /query-patterns?hours=6&min_avg_ms=100&limit=20
 * Aggregated query patterns by normalized hash — shows which query TYPES are slow
 */
router.get('/query-patterns', async (req, res) => {
  try {
    const hours = Math.min(Number(req.query.hours) || 6, 72);
    const minAvgMs = Number(req.query.min_avg_ms) || 100;
    const limit = Math.min(Number(req.query.limit) || 20, 100);

    const rows = await chQuery(`
      SELECT
        count() AS executions,
        round(avg(query_duration_ms)) AS avg_ms,
        max(query_duration_ms) AS max_ms,
        min(query_duration_ms) AS min_ms,
        round(quantile(0.95)(query_duration_ms)) AS p95_ms,
        round(avg(memory_usage / 1048576)) AS avg_mem_mb,
        max(memory_usage / 1048576) AS max_mem_mb,
        sum(read_rows) AS total_rows_read,
        formatReadableSize(sum(read_bytes)) AS total_read,
        substring(replaceRegexpAll(query, '\\\\s+', ' '), 1, 200) AS query_pattern,
        arrayStringConcat(any(tables), ', ') AS tables_used
      FROM system.query_log
      WHERE event_time >= now() - INTERVAL ${hours} HOUR
        AND type = 'QueryFinish'
        AND is_initial_query = 1
        AND query NOT LIKE '%system.%'
        AND query_duration_ms >= 50
      GROUP BY normalized_query_hash, query_pattern
      HAVING avg(query_duration_ms) >= ${minAvgMs}
      ORDER BY avg_ms DESC
      LIMIT ${limit}
      SETTINGS max_execution_time = 10
    `);

    res.json({ success: true, data: { hours, minAvgMs, count: rows.length, patterns: rows } });
  } catch (err) {
    log.error('Failed to query patterns', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Query failed',
    });
  }
});

/**
 * GET /table-stats?hours=6
 * Per-table read statistics — shows which tables are being hammered
 */
router.get('/table-stats', async (req, res) => {
  try {
    const hours = Math.min(Number(req.query.hours) || 6, 72);

    const rows = await chQuery(`
      SELECT
        arrayJoin(tables) AS table_name,
        count() AS query_count,
        round(avg(query_duration_ms)) AS avg_ms,
        max(query_duration_ms) AS max_ms,
        round(quantile(0.95)(query_duration_ms)) AS p95_ms,
        formatReadableSize(sum(read_bytes)) AS total_read,
        sum(read_rows) AS total_rows,
        countIf(type = 'ExceptionWhileProcessing') AS failed_queries
      FROM system.query_log
      WHERE event_time >= now() - INTERVAL ${hours} HOUR
        AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
        AND is_initial_query = 1
        AND query NOT LIKE '%system.%'
        AND length(tables) > 0
      GROUP BY table_name
      ORDER BY avg_ms DESC
      LIMIT 30
      SETTINGS max_execution_time = 10
    `);

    res.json({ success: true, data: { hours, tables: rows } });
  } catch (err) {
    log.error('Failed to query table stats', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Query failed',
    });
  }
});

/**
 * GET /merge-activity?hours=6
 * Background merge statistics — shows if merges are competing with queries
 */
router.get('/merge-activity', async (req, res) => {
  try {
    const hours = Math.min(Number(req.query.hours) || 6, 72);

    const rows = await chQuery(`
      SELECT
        table,
        count() AS merge_count,
        round(avg(duration_ms)) AS avg_ms,
        max(duration_ms) AS max_ms,
        formatReadableSize(sum(size_compressed)) AS total_compressed,
        sum(rows) AS total_rows,
        countIf(exception != '') AS failed_merges,
        substring(any(exception), 1, 200) AS last_exception
      FROM system.part_log
      WHERE event_time >= now() - INTERVAL ${hours} HOUR
        AND event_type = 'MergeParts'
      GROUP BY table
      ORDER BY failed_merges DESC, max_ms DESC
      LIMIT 20
      SETTINGS max_execution_time = 10
    `);

    res.json({ success: true, data: { hours, merges: rows } });
  } catch (err) {
    log.error('Failed to query merge activity', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Query failed',
    });
  }
});

/**
 * GET /memory
 * Current ClickHouse memory usage breakdown
 */
router.get('/memory', async (_req, res) => {
  try {
    const rows = await chQuery(`
      SELECT metric, value, description
      FROM system.metrics
      WHERE metric IN (
        'MemoryTracking', 'MemoryResident',
        'MergesMutationsMemoryTracking',
        'BackgroundMergesAndMutationsPoolSize',
        'BackgroundMergesAndMutationsPoolTask',
        'Query', 'Merge'
      )
      SETTINGS max_execution_time = 5
    `);

    const parts = await chQuery(`
      SELECT
        database || '.' || table AS table_name,
        count() AS part_count,
        countIf(active) AS active_parts,
        formatReadableSize(sum(bytes_on_disk)) AS disk_size,
        sum(rows) AS total_rows
      FROM system.parts
      WHERE database = 'abl_platform'
      GROUP BY table_name
      ORDER BY sum(bytes_on_disk) DESC
      LIMIT 20
      SETTINGS max_execution_time = 5
    `);

    res.json({ success: true, data: { metrics: rows, tables: parts } });
  } catch (err) {
    log.error('Failed to query memory', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Query failed',
    });
  }
});

export default router;

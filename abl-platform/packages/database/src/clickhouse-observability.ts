/**
 * ClickHouse Observability Module
 *
 * Captures ClickHouse internal metrics from system tables for debugging:
 * - Slow queries (system.query_log)
 * - Query errors (system.query_log, system.errors)
 * - Replication lag (system.replicas)
 * - Disk usage (system.disks, system.parts)
 * - Buffer health (tracked in application layer)
 *
 * These metrics are exposed for Prometheus scraping and structured logging.
 */

import type { ClickHouseClient } from '@clickhouse/client';

export interface SlowQuery {
  query_id: string;
  query: string;
  user: string;
  query_duration_ms: number;
  read_rows: number;
  read_bytes: number;
  memory_usage: number;
  exception: string;
  stack_trace: string;
  query_start_time: Date;
}

export interface QueryError {
  last_error_time: Date;
  error_code: number;
  error_name: string;
  value: number;
  last_error_message: string;
  last_error_trace: string;
}

export interface ReplicaHealth {
  database: string;
  table: string;
  replica_name: string;
  absolute_delay: number;
  queue_size: number;
  inserts_in_queue: number;
  merges_in_queue: number;
  log_max_index: number;
  log_pointer: number;
  is_readonly: boolean;
  is_session_expired: boolean;
}

export interface DiskUsage {
  name: string;
  path: string;
  free_space: number;
  total_space: number;
  used_percentage: number;
}

export interface TablePartitionMetrics {
  database: string;
  table: string;
  partition_count: number;
  total_rows: number;
  total_bytes: number;
  oldest_partition_date: Date | null;
  newest_partition_date: Date | null;
}

export class ClickHouseObservability {
  constructor(private client: ClickHouseClient) {}

  /**
   * Get slow queries from the last N minutes (queries exceeding threshold).
   * Default: queries slower than 2000ms in the last 5 minutes.
   */
  async getSlowQueries(params?: {
    thresholdMs?: number;
    lastMinutes?: number;
    limit?: number;
  }): Promise<SlowQuery[]> {
    const thresholdMs = params?.thresholdMs ?? 2000;
    const lastMinutes = params?.lastMinutes ?? 5;
    const limit = params?.limit ?? 100;

    const result = await this.client.query({
      query: `
        SELECT
          query_id,
          query,
          user,
          query_duration_ms,
          read_rows,
          read_bytes,
          memory_usage,
          exception,
          stack_trace,
          query_start_time
        FROM system.query_log
        WHERE type = 'QueryFinish'
          AND query_duration_ms > {thresholdMs:UInt32}
          AND query_start_time > now() - INTERVAL {lastMinutes:UInt32} MINUTE
        ORDER BY query_duration_ms DESC
        LIMIT {limit:UInt32}
      `,
      query_params: { thresholdMs, lastMinutes, limit },
      format: 'JSONEachRow',
    });

    const rows = await result.json<{
      query_id: string;
      query: string;
      user: string;
      query_duration_ms: string;
      read_rows: string;
      read_bytes: string;
      memory_usage: string;
      exception: string;
      stack_trace: string;
      query_start_time: string;
    }>();

    return rows.map((row) => ({
      query_id: row.query_id,
      query: row.query,
      user: row.user,
      query_duration_ms: parseInt(row.query_duration_ms, 10),
      read_rows: parseInt(row.read_rows, 10),
      read_bytes: parseInt(row.read_bytes, 10),
      memory_usage: parseInt(row.memory_usage, 10),
      exception: row.exception,
      stack_trace: row.stack_trace,
      query_start_time: new Date(row.query_start_time),
    }));
  }

  /**
   * Get query errors from the last N minutes.
   */
  async getQueryErrors(params?: { lastMinutes?: number; limit?: number }): Promise<QueryError[]> {
    const lastMinutes = params?.lastMinutes ?? 5;
    const limit = params?.limit ?? 100;

    const result = await this.client.query({
      query: `
        SELECT
          last_error_time,
          code AS error_code,
          name AS error_name,
          value,
          last_error_message,
          last_error_trace
        FROM system.errors
        WHERE last_error_time > now() - INTERVAL {lastMinutes:UInt32} MINUTE
          AND value > 0
        ORDER BY value DESC
        LIMIT {limit:UInt32}
      `,
      query_params: { lastMinutes, limit },
      format: 'JSONEachRow',
    });

    const rows = await result.json<{
      last_error_time: string;
      error_code: string;
      error_name: string;
      value: string;
      last_error_message: string;
      last_error_trace: string;
    }>();

    return rows.map((row) => ({
      last_error_time: new Date(row.last_error_time),
      error_code: parseInt(row.error_code, 10),
      error_name: row.error_name,
      value: parseInt(row.value, 10),
      last_error_message: row.last_error_message,
      last_error_trace: row.last_error_trace,
    }));
  }

  /**
   * Get replication health for all replicated tables.
   * Alert if absolute_delay > 60 seconds or queue_size > 1000.
   */
  async getReplicaHealth(): Promise<ReplicaHealth[]> {
    const result = await this.client.query({
      query: `
        SELECT
          database,
          table,
          replica_name,
          absolute_delay,
          queue_size,
          inserts_in_queue,
          merges_in_queue,
          log_max_index,
          log_pointer,
          is_readonly,
          is_session_expired
        FROM system.replicas
        ORDER BY absolute_delay DESC
      `,
      format: 'JSONEachRow',
    });

    const rows = await result.json<{
      database: string;
      table: string;
      replica_name: string;
      absolute_delay: string;
      queue_size: string;
      inserts_in_queue: string;
      merges_in_queue: string;
      log_max_index: string;
      log_pointer: string;
      is_readonly: string;
      is_session_expired: string;
    }>();

    return rows.map((row) => ({
      database: row.database,
      table: row.table,
      replica_name: row.replica_name,
      absolute_delay: parseInt(row.absolute_delay, 10),
      queue_size: parseInt(row.queue_size, 10),
      inserts_in_queue: parseInt(row.inserts_in_queue, 10),
      merges_in_queue: parseInt(row.merges_in_queue, 10),
      log_max_index: parseInt(row.log_max_index, 10),
      log_pointer: parseInt(row.log_pointer, 10),
      is_readonly: row.is_readonly === '1',
      is_session_expired: row.is_session_expired === '1',
    }));
  }

  /**
   * Get disk usage for all ClickHouse data disks.
   */
  async getDiskUsage(): Promise<DiskUsage[]> {
    const result = await this.client.query({
      query: `
        SELECT
          name,
          path,
          free_space,
          total_space,
          round((total_space - free_space) / total_space * 100, 2) AS used_percentage
        FROM system.disks
        WHERE type = 'local'
        ORDER BY used_percentage DESC
      `,
      format: 'JSONEachRow',
    });

    const rows = await result.json<{
      name: string;
      path: string;
      free_space: string;
      total_space: string;
      used_percentage: string;
    }>();

    return rows.map((row) => ({
      name: row.name,
      path: row.path,
      free_space: parseInt(row.free_space, 10),
      total_space: parseInt(row.total_space, 10),
      used_percentage: parseFloat(row.used_percentage),
    }));
  }

  /**
   * Get partition metrics for all tables in abl_platform database.
   * Useful for monitoring partition count growth and TTL effectiveness.
   */
  async getTablePartitionMetrics(database = 'abl_platform'): Promise<TablePartitionMetrics[]> {
    const result = await this.client.query({
      query: `
        SELECT
          database,
          table,
          count(DISTINCT partition) AS partition_count,
          sum(rows) AS total_rows,
          sum(bytes_on_disk) AS total_bytes,
          min(min_time) AS oldest_partition_date,
          max(max_time) AS newest_partition_date
        FROM system.parts
        WHERE database = {database:String}
          AND active = 1
        GROUP BY database, table
        ORDER BY total_bytes DESC
      `,
      query_params: { database },
      format: 'JSONEachRow',
    });

    const rows = await result.json<{
      database: string;
      table: string;
      partition_count: string;
      total_rows: string;
      total_bytes: string;
      oldest_partition_date: string;
      newest_partition_date: string;
    }>();

    return rows.map((row) => ({
      database: row.database,
      table: row.table,
      partition_count: parseInt(row.partition_count, 10),
      total_rows: parseInt(row.total_rows, 10),
      total_bytes: parseInt(row.total_bytes, 10),
      oldest_partition_date: row.oldest_partition_date ? new Date(row.oldest_partition_date) : null,
      newest_partition_date: row.newest_partition_date ? new Date(row.newest_partition_date) : null,
    }));
  }

  /**
   * Get partitions that should have been deleted by TTL but still exist.
   * Indicates TTL merge is not running or is backed up.
   */
  async getStalePartitions(database = 'abl_platform'): Promise<
    Array<{
      database: string;
      table: string;
      partition: string;
      rows: number;
      bytes: number;
      max_time: Date;
      days_overdue: number;
    }>
  > {
    const result = await this.client.query({
      query: `
        SELECT
          database,
          table,
          partition,
          rows,
          bytes_on_disk AS bytes,
          max_time,
          dateDiff('day', max_time, now()) AS days_overdue
        FROM system.parts
        WHERE database = {database:String}
          AND active = 1
          AND max_time < now() - INTERVAL 732 DAY  -- 2 years (longest TTL in schema)
        ORDER BY days_overdue DESC
        LIMIT 100
      `,
      query_params: { database },
      format: 'JSONEachRow',
    });

    const rows = await result.json<{
      database: string;
      table: string;
      partition: string;
      rows: string;
      bytes: string;
      max_time: string;
      days_overdue: string;
    }>();

    return rows.map((row) => ({
      database: row.database,
      table: row.table,
      partition: row.partition,
      rows: parseInt(row.rows, 10),
      bytes: parseInt(row.bytes, 10),
      max_time: new Date(row.max_time),
      days_overdue: parseInt(row.days_overdue, 10),
    }));
  }

  /**
   * Check if any replicas are lagging behind (absolute_delay > threshold).
   * Returns true if all replicas are healthy.
   */
  async isReplicationHealthy(maxDelaySeconds = 60): Promise<{
    healthy: boolean;
    laggingReplicas: Array<{
      database: string;
      table: string;
      replica: string;
      delaySeconds: number;
    }>;
  }> {
    const replicas = await this.getReplicaHealth();
    const lagging = replicas.filter((r) => r.absolute_delay > maxDelaySeconds);

    return {
      healthy: lagging.length === 0,
      laggingReplicas: lagging.map((r) => ({
        database: r.database,
        table: r.table,
        replica: r.replica_name,
        delaySeconds: r.absolute_delay,
      })),
    };
  }

  /**
   * Log a slow query to structured logs with full context.
   */
  logSlowQuery(query: SlowQuery, context?: Record<string, unknown>): void {
    console.warn('[ClickHouse] Slow query detected', {
      query_id: query.query_id,
      duration_ms: query.query_duration_ms,
      read_rows: query.read_rows,
      read_bytes: query.read_bytes,
      memory_usage: query.memory_usage,
      query_preview: query.query.substring(0, 200),
      timestamp: query.query_start_time.toISOString(),
      ...context,
    });
  }

  /**
   * Log a query error to structured logs with full context.
   */
  logQueryError(error: QueryError, context?: Record<string, unknown>): void {
    console.error('[ClickHouse] Query error', {
      error_code: error.error_code,
      error_name: error.error_name,
      error_count: error.value,
      last_error_message: error.last_error_message,
      last_error_trace: error.last_error_trace,
      timestamp: error.last_error_time.toISOString(),
      ...context,
    });
  }
}

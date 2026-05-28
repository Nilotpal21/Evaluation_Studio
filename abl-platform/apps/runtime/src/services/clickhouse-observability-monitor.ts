/**
 * ClickHouse Observability Monitor
 *
 * Periodic background monitoring of ClickHouse health using system tables.
 * Captures metrics for:
 * - Slow queries (> 2s)
 * - Query errors
 * - Replication lag
 * - Disk usage
 * - Stale partitions (TTL not running)
 *
 * These metrics are logged to structured logs (captured by Prometheus scraper)
 * and can trigger alerts based on thresholds.
 */

import { createLogger } from '@abl/compiler/platform';
import type { ClickHouseClient } from '@clickhouse/client';
import { ClickHouseObservability } from '@agent-platform/database';

const log = createLogger('clickhouse-observability');

export interface ObservabilityThresholds {
  /** Log slow queries slower than this (ms) */
  slowQueryMs: number;
  /** Alert on replication lag beyond this (seconds) */
  maxReplicaLagSeconds: number;
  /** Alert on disk usage beyond this (percent) */
  maxDiskUsagePercent: number;
  /** Alert on partition count beyond this */
  maxPartitionsPerTable: number;
}

const DEFAULT_THRESHOLDS: ObservabilityThresholds = {
  slowQueryMs: 2000,
  maxReplicaLagSeconds: 60,
  maxDiskUsagePercent: 85,
  maxPartitionsPerTable: 1000,
};

export class ClickHouseObservabilityMonitor {
  private observability: ClickHouseObservability;
  private thresholds: ObservabilityThresholds;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;

  constructor(client: ClickHouseClient, thresholds?: Partial<ObservabilityThresholds>) {
    this.observability = new ClickHouseObservability(client);
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  /**
   * Start periodic monitoring in the background.
   * Runs every 60 seconds by default.
   */
  start(intervalMs = 60_000): void {
    if (this.monitorTimer !== null) {
      log.warn('Observability monitor already running');
      return;
    }

    // Run initial check immediately
    this.runMonitoringChecks().catch((err) => {
      log.error('Initial observability check failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Schedule periodic checks
    this.monitorTimer = setInterval(() => {
      this.runMonitoringChecks().catch((err) => {
        log.error('Observability check failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, intervalMs);

    // Don't prevent Node.js from exiting
    if (this.monitorTimer.unref) this.monitorTimer.unref();

    log.info('ClickHouse observability monitor started', { intervalMs });
  }

  /**
   * Stop periodic monitoring.
   */
  stop(): void {
    if (this.monitorTimer !== null) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
      log.info('ClickHouse observability monitor stopped');
    }
  }

  /**
   * Run all monitoring checks once.
   * Can be called manually for on-demand health checks.
   */
  async runMonitoringChecks(): Promise<void> {
    await Promise.all([
      this.checkSlowQueries(),
      this.checkQueryErrors(),
      this.checkReplicationHealth(),
      this.checkDiskUsage(),
      this.checkStalePartitions(),
      this.checkPartitionCounts(),
    ]);
  }

  /**
   * Check for slow queries in the last 5 minutes.
   */
  private async checkSlowQueries(): Promise<void> {
    try {
      const slowQueries = await this.observability.getSlowQueries({
        thresholdMs: this.thresholds.slowQueryMs,
        lastMinutes: 5,
        limit: 10,
      });

      if (slowQueries.length > 0) {
        log.warn('[ClickHouse] Slow queries detected', {
          count: slowQueries.length,
          slowest_duration_ms: slowQueries[0]?.query_duration_ms,
          slowest_query: slowQueries[0]?.query.substring(0, 200),
        });

        // Log each slow query with full context
        for (const query of slowQueries) {
          this.observability.logSlowQuery(query, {
            threshold_ms: this.thresholds.slowQueryMs,
          });
        }
      }
    } catch (err) {
      log.error('[ClickHouse] Failed to check slow queries', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Check for query errors in the last 5 minutes.
   */
  private async checkQueryErrors(): Promise<void> {
    try {
      const errors = await this.observability.getQueryErrors({
        lastMinutes: 5,
        limit: 10,
      });

      if (errors.length > 0) {
        log.error('[ClickHouse] Query errors detected', {
          count: errors.length,
          most_common_error: errors[0]?.error_name,
          error_count: errors[0]?.value,
        });

        // Log each error type
        for (const error of errors) {
          this.observability.logQueryError(error);
        }
      }
    } catch (err) {
      log.error('[ClickHouse] Failed to check query errors', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Check replication health (lag and queue size).
   */
  private async checkReplicationHealth(): Promise<void> {
    try {
      const health = await this.observability.isReplicationHealthy(
        this.thresholds.maxReplicaLagSeconds,
      );

      if (!health.healthy) {
        log.error('[ClickHouse] Replication lag detected', {
          lagging_replicas: health.laggingReplicas.length,
          max_lag_seconds: Math.max(...health.laggingReplicas.map((r) => r.delaySeconds)),
          details: health.laggingReplicas,
        });
      } else {
        log.debug('[ClickHouse] Replication healthy');
      }
    } catch (err) {
      log.error('[ClickHouse] Failed to check replication health', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Check disk usage on all data disks.
   */
  private async checkDiskUsage(): Promise<void> {
    try {
      const disks = await this.observability.getDiskUsage();
      const highUsage = disks.filter(
        (d) => d.used_percentage > this.thresholds.maxDiskUsagePercent,
      );

      if (highUsage.length > 0) {
        log.warn('[ClickHouse] High disk usage detected', {
          disks: highUsage.map((d) => ({
            name: d.name,
            path: d.path,
            used_percent: d.used_percentage,
            free_gb: Math.round(d.free_space / 1024 / 1024 / 1024),
          })),
        });
      } else {
        log.debug('[ClickHouse] Disk usage healthy', {
          disks: disks.map((d) => ({
            name: d.name,
            used_percent: d.used_percentage,
          })),
        });
      }
    } catch (err) {
      log.error('[ClickHouse] Failed to check disk usage', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Check for partitions that should have been deleted by TTL but still exist.
   */
  private async checkStalePartitions(): Promise<void> {
    try {
      const stalePartitions = await this.observability.getStalePartitions();

      if (stalePartitions.length > 0) {
        log.warn('[ClickHouse] Stale partitions detected (TTL not running)', {
          count: stalePartitions.length,
          oldest_partition_days_overdue: stalePartitions[0]?.days_overdue,
          details: stalePartitions.map((p) => ({
            database: p.database,
            table: p.table,
            partition: p.partition,
            days_overdue: p.days_overdue,
            rows: p.rows,
          })),
        });
      } else {
        log.debug('[ClickHouse] No stale partitions detected');
      }
    } catch (err) {
      log.error('[ClickHouse] Failed to check stale partitions', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Check partition counts per table (warn if approaching limits).
   */
  private async checkPartitionCounts(): Promise<void> {
    try {
      const metrics = await this.observability.getTablePartitionMetrics();
      const highCounts = metrics.filter(
        (m) => m.partition_count > this.thresholds.maxPartitionsPerTable,
      );

      if (highCounts.length > 0) {
        log.warn('[ClickHouse] High partition counts detected', {
          tables: highCounts.map((m) => ({
            table: m.table,
            partition_count: m.partition_count,
            total_rows: m.total_rows,
            total_mb: Math.round(m.total_bytes / 1024 / 1024),
          })),
        });
      } else {
        log.debug('[ClickHouse] Partition counts healthy', {
          tables: metrics.map((m) => ({
            table: m.table,
            partitions: m.partition_count,
          })),
        });
      }
    } catch (err) {
      log.error('[ClickHouse] Failed to check partition counts', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Get comprehensive health report (for admin dashboard).
   */
  async getHealthReport(): Promise<{
    slowQueries: number;
    recentErrors: number;
    replicationHealthy: boolean;
    maxDiskUsagePercent: number;
    stalePartitions: number;
    tables: Array<{
      name: string;
      partitions: number;
      rows: number;
      sizeMB: number;
    }>;
  }> {
    const [slowQueries, errors, replicationHealth, disks, stalePartitions, tableMetrics] =
      await Promise.all([
        this.observability.getSlowQueries({ lastMinutes: 60 }),
        this.observability.getQueryErrors({ lastMinutes: 60 }),
        this.observability.isReplicationHealthy(),
        this.observability.getDiskUsage(),
        this.observability.getStalePartitions(),
        this.observability.getTablePartitionMetrics(),
      ]);

    return {
      slowQueries: slowQueries.length,
      recentErrors: errors.reduce((sum, e) => sum + e.value, 0),
      replicationHealthy: replicationHealth.healthy,
      maxDiskUsagePercent: Math.max(...disks.map((d) => d.used_percentage), 0),
      stalePartitions: stalePartitions.length,
      tables: tableMetrics.map((m) => ({
        name: m.table,
        partitions: m.partition_count,
        rows: m.total_rows,
        sizeMB: Math.round(m.total_bytes / 1024 / 1024),
      })),
    };
  }
}

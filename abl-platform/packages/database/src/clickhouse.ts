/**
 * ClickHouse Client Singleton & BufferedWriter
 *
 * Provides a shared ClickHouse client and a batched writer that buffers
 * 10,000 rows OR flushes every 5 seconds (whichever comes first).
 * ClickHouse async inserts are enabled as a safety net.
 */

import { ClickHouseLogLevel, createClient, type ClickHouseClient } from '@clickhouse/client';
import type { ClickHouseEncryptionInterceptor } from './clickhouse-encryption-interceptor.js';

// =============================================================================
// CLIENT SINGLETON (globalThis to survive ESM/CJS dual-module loading)
// =============================================================================

const GLOBAL_KEY = '__abl_clickhouse_client__' as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _g = globalThis as Record<string, any>;

export interface ClickHouseConfig {
  url?: string;
  username?: string;
  password?: string;
  database?: string;
}

function resolveClickHouseClientConfig(config?: ClickHouseConfig): {
  url: string;
  username?: string;
  password?: string;
} {
  const url =
    config?.url ||
    process.env.CLICKHOUSE_URL ||
    process.env.CLICKHOUSE_HOST ||
    'http://localhost:8123';
  const explicitUser = config?.username || process.env.CLICKHOUSE_USER;
  const explicitPass = config?.password || process.env.CLICKHOUSE_PASSWORD;

  return {
    url,
    ...(explicitUser !== undefined && { username: explicitUser }),
    ...(explicitPass !== undefined && { password: explicitPass }),
  };
}

function createConfiguredClickHouseClient(config?: ClickHouseConfig): ClickHouseClient {
  const resolved = resolveClickHouseClientConfig(config);

  const rawTimeout = process.env.CLICKHOUSE_REQUEST_TIMEOUT_MS;
  const parsed = rawTimeout !== undefined ? parseInt(rawTimeout, 10) : NaN;
  const requestTimeoutMs = Number.isNaN(parsed) ? 120_000 : parsed;

  // Don't set database on the client — all queries use fully-qualified
  // table names (e.g. abl_platform.messages). This avoids chicken-and-egg
  // problems where initClickHouseSchema needs to CREATE DATABASE first.
  // Don't default username/password — let @clickhouse/client parse them
  // from the URL (e.g. http://admin:pass@host:8123).
  const client = createClient({
    ...resolved,
    request_timeout: requestTimeoutMs,
    log: {
      // Runtime code logs ClickHouse failures with request context already.
      // Suppress the client library's duplicate stderr output.
      level: ClickHouseLogLevel.OFF,
    },
    clickhouse_settings: {
      async_insert: 1,
      async_insert_max_data_size: '10485760', // 10MB
      async_insert_busy_timeout_ms: 200, // flush after 200ms; fire-and-forget (no wait_for_async_insert)
    },
  });

  return client;
}

export function createDedicatedClickHouseClient(config?: ClickHouseConfig): ClickHouseClient {
  return createConfiguredClickHouseClient(config);
}

export function getClickHouseClient(config?: ClickHouseConfig): ClickHouseClient {
  if (_g[GLOBAL_KEY]) return _g[GLOBAL_KEY] as ClickHouseClient;

  const client = createConfiguredClickHouseClient(config);
  _g[GLOBAL_KEY] = client;
  return client;
}

export async function closeClickHouseClient(): Promise<void> {
  const existing = _g[GLOBAL_KEY] as ClickHouseClient | undefined;
  if (existing) {
    await existing.close();
    _g[GLOBAL_KEY] = undefined;
  }
}

// =============================================================================
// TIMESTAMP UTILITY
// =============================================================================

/**
 * Parse a ClickHouse DateTime/DateTime64 string into a JS Date.
 *
 * The @clickhouse/client returns DateTime values as strings without timezone
 * suffix (e.g. "2026-03-11 16:00:16.292"). ClickHouse stores them as UTC,
 * but `new Date()` interprets bare strings as local time. This utility
 * appends the UTC 'Z' suffix when missing so all consumers get correct UTC
 * dates regardless of the server's timezone.
 */
export function parseClickHouseTimestamp(ts: string | Date): Date {
  if (ts instanceof Date) return ts;
  // Already has timezone info — parse as-is
  if (ts.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(ts)) return new Date(ts);
  // Replace space separator with 'T' for ISO 8601 and append UTC marker
  return new Date(ts.replace(' ', 'T') + 'Z');
}

/**
 * Format a JS Date or ISO 8601 string for ClickHouse **DateTime64(3)** columns.
 *
 * Keeps millisecond precision.
 * Output: `"2026-04-14 18:17:50.464"`
 *
 * ClickHouse JSONEachRow parser rejects ISO 8601 timezone suffixes ('Z', '+05:30')
 * when the column type is DateTime64. It expects the bare format shown above.
 *
 * Use for: messages, llm_metrics, platform_events, facts, search_ingestion_events,
 * entity_instances, kms_audit_log, event_bus_dead_letters, search_queries,
 * and all analytics pipeline tables (message_sentiment, session_quality, etc.).
 */
export function toClickHouseDateTime(input: Date | string): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  // toISOString() → "2026-04-14T18:17:50.464Z"
  // DateTime64(3) wants → "2026-04-14 18:17:50.464"
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Format a JS Date or ISO 8601 string for ClickHouse **DateTime** (second-precision) columns.
 *
 * Strips milliseconds — DateTime columns reject fractional seconds in JSONEachRow format.
 * Output: `"2026-04-14 18:17:50"`
 *
 * Use for: audit_events, logs, table_metadata, and any column typed as plain `DateTime`.
 */
export function toClickHouseDateTimeSec(input: Date | string): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  // toISOString() → "2026-04-14T18:17:50.464Z"
  // DateTime wants   → "2026-04-14 18:17:50"
  return d
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '');
}

// =============================================================================
// BUFFERED WRITER
// =============================================================================

const DEFAULT_BATCH_SIZE = 10_000;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_MAX_BUFFER_SIZE = 100_000;
const DEFAULT_MAX_RETRIES = 3;

export interface BufferedWriterOptions {
  table: string;
  batchSize?: number;
  flushIntervalMs?: number;
  maxBufferSize?: number;
  maxRetries?: number;
  /** Suppress the writer's fallback console.error output. */
  suppressErrorLogs?: boolean;
  /** Optional logger for flush errors and buffer warnings */
  onError?: (
    error: unknown,
    context: { table: string; batchSize: number; pending: number; retries: number },
  ) => void;
  /** Optional callback for successful flush with metrics */
  onSuccess?: (rowCount: number, durationMs: number) => void;
  /** Optional callback for slow writes (threshold in ms) */
  slowWriteThresholdMs?: number;
  /** Optional encryption interceptor for field-level encryption */
  encryptionInterceptor?: ClickHouseEncryptionInterceptor;
}

export class BufferedClickHouseWriter<T extends object> {
  private buffer: T[] = [];
  private readonly table: string;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxBufferSize: number;
  private readonly maxRetries: number;
  private readonly slowWriteThresholdMs: number;
  private readonly suppressErrorLogs: boolean;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private client: ClickHouseClient;
  private consecutiveFailures = 0;
  private encryptionInterceptor?: ClickHouseEncryptionInterceptor;
  private onError?: BufferedWriterOptions['onError'];
  private onSuccess?: BufferedWriterOptions['onSuccess'];
  private totalWrites = 0;
  private totalRows = 0;
  private lastFlushTime = Date.now();

  constructor(client: ClickHouseClient, options: BufferedWriterOptions) {
    this.client = client;
    this.table = options.table;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxBufferSize = options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.slowWriteThresholdMs = options.slowWriteThresholdMs ?? 2000;
    this.suppressErrorLogs = options.suppressErrorLogs ?? false;
    this.encryptionInterceptor = options.encryptionInterceptor;
    this.onError = options.onError;
    this.onSuccess = options.onSuccess;

    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        this.reportError(err, 'timer-flush');
      });
    }, this.flushIntervalMs);
    // Don't prevent Node.js from exiting
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  insert(row: T): void {
    // Warn when buffer is 90% full (approaching overflow)
    if (this.buffer.length >= this.maxBufferSize * 0.9 && this.buffer.length < this.maxBufferSize) {
      console.warn('[BufferedClickHouseWriter] Buffer near capacity', {
        table: this.table,
        pending: this.buffer.length,
        maxBufferSize: this.maxBufferSize,
        utilizationPercent: Math.round((this.buffer.length / this.maxBufferSize) * 100),
      });
    }

    if (this.buffer.length >= this.maxBufferSize) {
      this.reportError(
        new Error(`Buffer overflow: ${this.buffer.length} rows pending, dropping oldest batch`),
        'backpressure',
      );
      // Drop oldest rows to prevent unbounded memory growth
      this.buffer.splice(0, this.batchSize);
    }
    this.buffer.push(row);
    if (this.buffer.length >= this.batchSize) {
      this.flush().catch((err) => {
        this.reportError(err, 'insert-flush');
      });
    }
  }

  insertMany(rows: T[]): void {
    this.buffer.push(...rows);
    if (this.buffer.length >= this.batchSize) {
      this.flush().catch((err) => {
        this.reportError(err, 'insertMany-flush');
      });
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;

    this.flushing = true;
    const batch = this.buffer.splice(0, this.batchSize);
    const startTime = Date.now();

    try {
      const tableName = this.table.includes('.') ? this.table.split('.').pop()! : this.table;
      const rows = this.encryptionInterceptor
        ? await this.encryptionInterceptor.beforeInsert(
            tableName,
            batch as Record<string, unknown>[],
          )
        : batch;

      await this.client.insert({
        table: this.table,
        values: rows as T[],
        format: 'JSONEachRow',
      });
      const durationMs = Date.now() - startTime;
      this.consecutiveFailures = 0;
      this.totalWrites++;
      this.totalRows += batch.length;
      this.lastFlushTime = Date.now();

      // Log slow writes
      if (durationMs > this.slowWriteThresholdMs) {
        console.warn('[BufferedClickHouseWriter] Slow write detected', {
          table: this.table,
          rowCount: batch.length,
          durationMs,
          thresholdMs: this.slowWriteThresholdMs,
          pending: this.buffer.length,
        });
      }

      // Call success callback for metrics
      if (this.onSuccess) {
        this.onSuccess(batch.length, durationMs);
      }
    } catch (err) {
      const durationMs = Date.now() - startTime;
      this.consecutiveFailures++;
      if (this.consecutiveFailures <= this.maxRetries) {
        // Re-add failed batch to front of buffer for retry
        this.buffer.unshift(...batch);
      } else {
        // Drop batch after max retries to prevent unbounded memory growth
        this.reportError(err, `drop-after-${this.maxRetries}-retries`);
      }
      // Log failed write with duration
      if (!this.suppressErrorLogs) {
        console.error('[BufferedClickHouseWriter] Write failed', {
          table: this.table,
          rowCount: batch.length,
          durationMs,
          retries: this.consecutiveFailures,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    } finally {
      this.flushing = false;
    }

    // If there's still data in the buffer above threshold, flush again
    if (this.buffer.length >= this.batchSize) {
      await this.flush();
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  get pending(): number {
    return this.buffer.length;
  }

  /**
   * Get buffer health metrics for observability
   */
  getMetrics(): {
    table: string;
    pending: number;
    utilizationPercent: number;
    totalWrites: number;
    totalRows: number;
    consecutiveFailures: number;
    secondsSinceLastFlush: number;
  } {
    return {
      table: this.table,
      pending: this.buffer.length,
      utilizationPercent: Math.round((this.buffer.length / this.maxBufferSize) * 100),
      totalWrites: this.totalWrites,
      totalRows: this.totalRows,
      consecutiveFailures: this.consecutiveFailures,
      secondsSinceLastFlush: Math.round((Date.now() - this.lastFlushTime) / 1000),
    };
  }

  private reportError(error: unknown, _context: string): void {
    if (this.onError) {
      this.onError(error, {
        table: this.table,
        batchSize: this.batchSize,
        pending: this.buffer.length,
        retries: this.consecutiveFailures,
      });
    }
  }
}

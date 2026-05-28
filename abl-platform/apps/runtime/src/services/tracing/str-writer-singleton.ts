/**
 * STRWriter Singleton
 *
 * Provides a production-wired STRWriter backed by a BufferedClickHouseWriter
 * that flushes spatial_trace_records rows to ClickHouse.
 *
 * Call initializeSTRWriter() at server startup after ClickHouse init.
 * Use getSTRWriter() elsewhere — returns null when ClickHouse is unavailable.
 */

import { createLogger } from '@abl/compiler/platform';
import {
  STRWriter,
  type SpatialTraceRow,
  type RowWriter,
} from '@agent-platform/shared-observability/sti';

const log = createLogger('str-writer-singleton');

const CH_TABLE = 'abl_platform.spatial_trace_records';

let _writer: STRWriter | null = null;
let _initialized = false;

/**
 * ClickHouse-backed RowWriter using BufferedClickHouseWriter for batched inserts.
 * Implements the RowWriter interface expected by STRWriter.
 */
class ClickHouseSTRRowWriter implements RowWriter {
  private readonly buffered: { insert(row: SpatialTraceRow): void };

  constructor(buffered: { insert(row: SpatialTraceRow): void }) {
    this.buffered = buffered;
  }

  insert(row: SpatialTraceRow): void {
    try {
      this.buffered.insert(row);
    } catch (err) {
      log.warn('STR row insert failed (fire-and-forget)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export async function initializeSTRWriter(opts: { clickhouseReady: boolean }): Promise<void> {
  if (_initialized) return;

  if (!opts.clickhouseReady) {
    log.warn('ClickHouse not ready — STRWriter will not be available');
    _initialized = true;
    return;
  }

  try {
    const { getClickHouseClient, BufferedClickHouseWriter } =
      await import('@agent-platform/database/clickhouse');
    const client = getClickHouseClient();

    const buffered = new BufferedClickHouseWriter<SpatialTraceRow>(client, {
      table: CH_TABLE,
      batchSize: 5_000,
      flushIntervalMs: 5_000,
      onError: (error, context) => {
        log.error('STR buffered writer flush error', {
          table: context.table,
          pending: context.pending,
          retries: context.retries,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });

    const rowWriter = new ClickHouseSTRRowWriter(buffered);
    _writer = new STRWriter(rowWriter);
    _initialized = true;

    log.info('STRWriter initialized with ClickHouse backend');
  } catch (err) {
    log.error('Failed to initialize STRWriter', {
      error: err instanceof Error ? err.message : String(err),
    });
    _initialized = true;
  }
}

export function getSTRWriter(): STRWriter | null {
  return _writer;
}

/** Test helper — reset singleton state */
export function _resetSTRWriter(): void {
  _writer = null;
  _initialized = false;
}

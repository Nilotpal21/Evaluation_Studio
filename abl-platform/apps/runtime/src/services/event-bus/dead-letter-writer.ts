/**
 * Dead-Letter Writer
 *
 * Interface and ClickHouse implementation for writing failed events to a
 * dead-letter store for later inspection and replay.
 *
 * The ClickHouseDeadLetterWriter delegates row writes to a BufferedWriter
 * (batched ClickHouse insert), keeping the dead-letter path off the
 * critical Kafka publish path.
 */

import type { AnyPlatformEvent } from './types.js';
import { toClickHouseDateTime } from '@agent-platform/database/clickhouse';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface DeadLetterWriter {
  write(event: AnyPlatformEvent, errorMessage: string, retryCount: number): Promise<void>;
  flush(): Promise<void>;
}

// ---------------------------------------------------------------------------
// BufferedWriter interface (for DI / mocking)
// ---------------------------------------------------------------------------

export interface BufferedWriter<T> {
  add(row: T): void;
  flush(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Dead-letter row shape
// ---------------------------------------------------------------------------

export interface DeadLetterRow {
  event_id: string;
  event_type: string;
  tenant_id: string;
  session_id: string;
  payload: string;
  error_message: string;
  retry_count: number;
  failed_at: string;
  replayed: number;
}

// ---------------------------------------------------------------------------
// ClickHouse dead-letter table DDL
// ---------------------------------------------------------------------------

export const DEAD_LETTER_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS event_dead_letter (
  event_id      String,
  event_type    LowCardinality(String),
  tenant_id     String,
  session_id    String,
  payload       String,
  error_message String,
  retry_count   UInt8,
  failed_at     DateTime64(3),
  replayed      UInt8 DEFAULT 0
)
ENGINE = MergeTree()
ORDER BY (tenant_id, failed_at, event_id)
TTL toDateTime(failed_at) + INTERVAL 30 DAY
SETTINGS index_granularity = 8192;
`.trim();

// ---------------------------------------------------------------------------
// ClickHouse implementation
// ---------------------------------------------------------------------------

export class ClickHouseDeadLetterWriter implements DeadLetterWriter {
  constructor(private writer: BufferedWriter<DeadLetterRow>) {}

  async write(event: AnyPlatformEvent, errorMessage: string, retryCount: number): Promise<void> {
    const row: DeadLetterRow = {
      event_id: event.eventId,
      event_type: event.type,
      tenant_id: event.tenantId,
      session_id: event.sessionId,
      payload: JSON.stringify(event),
      error_message: errorMessage,
      retry_count: retryCount,
      failed_at: toClickHouseDateTime(new Date()),
      replayed: 0,
    };
    this.writer.add(row);
  }

  async flush(): Promise<void> {
    await this.writer.flush();
  }
}

/**
 * ClickHouse Ingestion Store
 *
 * Writes ingestion events to ClickHouse for analytics and monitoring.
 * Uses BufferedClickHouseWriter for batched inserts (10K rows / 5s flush).
 */

import type { ClickHouseClient } from '@clickhouse/client';
import {
  BufferedClickHouseWriter,
  toClickHouseDateTime,
} from '@agent-platform/database/clickhouse';

// =============================================================================
// TYPES
// =============================================================================

export interface IngestionEventRow {
  tenant_id: string;
  timestamp: string;
  event_id: string;
  index_id: string;
  source_id: string;
  document_id: string;
  stage: string;
  status: string;
  duration_ms: number;
  chunk_count: number;
  token_count: number;
  embedding_cost: number;
  fields_mapped: number;
  has_error: number;
  error_message: string;
  retry_count: number;
  content_type: string;
  content_size_bytes: number;
}

export interface RecordIngestionEventParams {
  tenantId: string;
  eventId: string;
  indexId: string;
  sourceId: string;
  documentId?: string;
  stage: string;
  status: string;
  durationMs: number;
  chunkCount?: number;
  tokenCount?: number;
  embeddingCost?: number;
  fieldsMapped?: number;
  hasError?: boolean;
  errorMessage?: string;
  retryCount?: number;
  contentType?: string;
  contentSizeBytes?: number;
}

// =============================================================================
// STORE
// =============================================================================

export class ClickHouseIngestionStore {
  private writer: BufferedClickHouseWriter<IngestionEventRow>;

  constructor(client: ClickHouseClient) {
    this.writer = new BufferedClickHouseWriter(client, {
      table: 'abl_platform.search_ingestion_events',
      batchSize: 10_000,
      flushIntervalMs: 5_000,
      onError: (error, context) => {
        console.error('[clickhouse-ingestion] Flush error:', {
          table: context.table,
          pending: context.pending,
          retries: context.retries,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
  }

  /**
   * Record an ingestion event. Fire-and-forget (buffered).
   */
  record(params: RecordIngestionEventParams): void {
    const row: IngestionEventRow = {
      tenant_id: params.tenantId,
      timestamp: toClickHouseDateTime(new Date()),
      event_id: params.eventId,
      index_id: params.indexId,
      source_id: params.sourceId,
      document_id: params.documentId || '',
      stage: params.stage,
      status: params.status,
      duration_ms: params.durationMs,
      chunk_count: params.chunkCount || 0,
      token_count: params.tokenCount || 0,
      embedding_cost: params.embeddingCost || 0,
      fields_mapped: params.fieldsMapped || 0,
      has_error: params.hasError ? 1 : 0,
      error_message: params.errorMessage || '',
      retry_count: params.retryCount || 0,
      content_type: params.contentType || '',
      content_size_bytes: params.contentSizeBytes || 0,
    };

    this.writer.insert(row);
  }

  /**
   * Flush pending events and stop the writer.
   */
  async close(): Promise<void> {
    await this.writer.close();
  }

  /**
   * Number of events pending flush.
   */
  get pending(): number {
    return this.writer.pending;
  }
}

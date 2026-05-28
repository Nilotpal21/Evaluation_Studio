/**
 * Interaction Writer — Buffered ClickHouse writer for facet interaction events.
 *
 * Records user interaction events (impression, click, filter, expand, remove,
 * search, browse) to the ClickHouse `facet_interactions` table via
 * BufferedClickHouseWriter.
 *
 * Fail-open: if ClickHouse is unavailable, events are silently dropped.
 */

import { createLogger } from '@abl/compiler/platform';
import {
  getClickHouseClient,
  BufferedClickHouseWriter,
  toClickHouseDateTime,
} from '@agent-platform/database/clickhouse';
import type { ClickHouseClient } from '@clickhouse/client';

const log = createLogger('interaction-writer');

// =============================================================================
// TYPES
// =============================================================================

export type InteractionType =
  | 'impression'
  | 'click'
  | 'filter'
  | 'expand'
  | 'remove'
  | 'search'
  | 'browse';

export interface FacetInteractionEvent {
  tenantId: string;
  indexId: string;
  userId: string;
  sessionId: string;
  attributeType?: string;
  productType?: string;
  facetValue?: string;
  categoryId?: string;
  interactionType: InteractionType;
}

export interface FacetInteractionRow {
  tenant_id: string;
  index_id: string;
  user_id: string;
  session_id: string;
  attribute_type: string;
  product_type: string;
  facet_value: string;
  category_id: string;
  interaction_type: string;
  created_at: string;
}

// =============================================================================
// WRITER
// =============================================================================

export class InteractionWriter {
  private client: ClickHouseClient | null = null;
  private writer: BufferedClickHouseWriter<FacetInteractionRow> | null = null;

  constructor() {
    // Lazy ClickHouse init — fail-open
    try {
      this.client = getClickHouseClient();
      this.writer = new BufferedClickHouseWriter<FacetInteractionRow>(this.client, {
        table: 'abl_platform.facet_interactions',
        batchSize: 5_000,
        flushIntervalMs: 3_000,
        maxRetries: 3,
        onError: (error, ctx) => {
          log.error('ClickHouse interaction write failed', {
            table: ctx.table,
            pending: ctx.pending,
            retries: ctx.retries,
            error: error instanceof Error ? error.message : String(error),
          });
        },
        onSuccess: (rowCount, durationMs) => {
          log.info('ClickHouse interaction flush complete', {
            rowCount,
            durationMs,
          });
        },
      });
    } catch (error) {
      log.warn('ClickHouse unavailable for interaction tracking — events will be dropped', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  writeEvents(events: FacetInteractionEvent[]): void {
    if (!this.writer) return;
    const now = toClickHouseDateTime(new Date());
    for (const event of events) {
      this.writer.insert({
        tenant_id: event.tenantId,
        index_id: event.indexId,
        user_id: event.userId,
        session_id: event.sessionId,
        attribute_type: event.attributeType ?? '',
        product_type: event.productType ?? '',
        facet_value: event.facetValue ?? '',
        category_id: event.categoryId ?? '',
        interaction_type: event.interactionType,
        created_at: now,
      });
    }
  }

  async flush(): Promise<void> {
    if (this.writer) await this.writer.flush();
  }

  async close(): Promise<void> {
    if (this.writer) await this.writer.close();
  }
}

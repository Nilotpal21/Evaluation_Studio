/**
 * ClickHouse Entity Instance Store
 *
 * Writes entity instances to ClickHouse for Browse SDK facet queries.
 * Uses BufferedClickHouseWriter for batched writes.
 *
 * Re-enrichment safety: DELETE old rows before INSERT to prevent ghost
 * attribute types when taxonomy changes rename attributes (Amendment #8).
 */

import { createLogger } from '@abl/compiler/platform';
import {
  getClickHouseClient,
  BufferedClickHouseWriter,
  toClickHouseDateTime,
} from '@agent-platform/database/clickhouse';
import type { ClickHouseClient } from '@clickhouse/client';

const log = createLogger('clickhouse-entity-store');

const DATABASE = 'abl_platform';

export interface EntityInstanceRow {
  tenant_id: string;
  index_id: string;
  document_id: string;
  chunk_id: string;
  attribute_type: string;
  product_type: string;
  data_type: string;
  raw_value: string;
  normalized_value: string;
  enriched_at: string; // ISO datetime string
  taxonomy_version: string;
}

export class ClickHouseEntityStore {
  private writer: BufferedClickHouseWriter<EntityInstanceRow>;
  private client: ClickHouseClient;

  constructor() {
    this.client = getClickHouseClient();
    this.writer = new BufferedClickHouseWriter<EntityInstanceRow>(this.client, {
      table: `${DATABASE}.entity_instances`,
      batchSize: 10_000,
      flushIntervalMs: 5_000,
      maxRetries: 3,
      onError: (error, ctx) => {
        log.error('ClickHouse entity write failed', {
          table: ctx.table,
          pending: ctx.pending,
          retries: ctx.retries,
          error: error instanceof Error ? error.message : String(error),
        });
      },
      onSuccess: (rowCount, durationMs) => {
        log.info('ClickHouse entity flush complete', { rowCount, durationMs });
      },
    });
  }

  /**
   * Delete existing entity instances for a document (re-enrichment cleanup).
   * Amendment #8: prevents ghost rows when attribute types change on re-enrichment.
   */
  async deleteDocumentInstances(
    tenantId: string,
    indexId: string,
    documentId: string,
  ): Promise<void> {
    try {
      await this.client.command({
        query: `ALTER TABLE ${DATABASE}.entity_instances DELETE WHERE tenant_id = {t:String} AND index_id = {i:String} AND document_id = {d:String}`,
        query_params: { t: tenantId, i: indexId, d: documentId },
      });
    } catch (error) {
      log.error('Failed to delete entity instances for re-enrichment', {
        tenantId,
        indexId,
        documentId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw — allow new rows to be written even if delete fails
      // ReplacingMergeTree will eventually deduplicate on ORDER BY key
    }
  }

  /**
   * Write entity instances for a document to ClickHouse.
   * Expands document-level deduplicated entities into per-chunk rows.
   */
  writeEntityInstances(params: {
    tenantId: string;
    indexId: string;
    documentId: string;
    productType: string;
    taxonomyVersion: string;
    entityInstances: Array<{
      type: string;
      rawValue: string;
      normalizedValue: string | number | boolean;
      chunkIds: string[];
      dataType?: string;
    }>;
  }): void {
    const now = toClickHouseDateTime(new Date());

    for (const entity of params.entityInstances) {
      const chunkIds = entity.chunkIds.length > 0 ? entity.chunkIds : [''];

      for (const chunkId of chunkIds) {
        this.writer.insert({
          tenant_id: params.tenantId,
          index_id: params.indexId,
          document_id: params.documentId,
          chunk_id: chunkId,
          attribute_type: entity.type,
          product_type: params.productType,
          data_type: entity.dataType || 'string',
          raw_value: entity.rawValue,
          normalized_value: entity.normalizedValue != null ? String(entity.normalizedValue) : '',
          enriched_at: now,
          taxonomy_version: params.taxonomyVersion,
        });
      }
    }
  }

  async flush(): Promise<void> {
    await this.writer.flush();
  }

  async close(): Promise<void> {
    await this.writer.close();
  }
}

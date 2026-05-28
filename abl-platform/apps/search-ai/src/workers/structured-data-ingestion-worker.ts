/**
 * Structured Data Ingestion Worker
 *
 * Processes structured data (CSV, JSON, Excel) ingestion jobs. Picks up
 * IngestionJobData from QUEUE_STRUCTURED_INGESTION, parses the file,
 * applies smart chunking strategy, stores data in ClickHouse, creates
 * SearchChunk records, and enqueues embedding jobs.
 *
 * Flow: analyze → finalize → ingest (this worker) → embed
 */

import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { QUEUE_EMBEDDING, ChunkStatus } from '@agent-platform/search-ai-sdk';
import { withTenantContext } from '@agent-platform/database/mongo';
import type { Model } from 'mongoose';
import { getDualConnection } from '../db/index.js';
import { countTokens } from '@agent-platform/search-ai-internal/tokenizer';
import {
  createQueue,
  createWorkerOptions,
  workerLog,
  workerError,
  withTraceContext,
} from './shared.js';

function getModels() {
  const dualConn = getDualConnection();
  const platformConn = dualConn.getPlatformConnection();
  const contentConn = dualConn.getContentConnection();

  return {
    SearchIndex: platformConn.models.SearchIndex as Model<any>,
    SearchDocument: contentConn.models.SearchDocument as Model<any>,
    SearchChunk: contentConn.models.SearchChunk as Model<any>,
  };
}
import type { EmbeddingJobData } from './shared.js';
import { StructuredDataSchemaAnalyzer } from '../services/structured-data/schema-analyzer.js';
import { StructuredDataClickHouseClient } from '../services/structured-data/clickhouse-client.js';
import { StructuredDataChunkingStrategy } from '../services/structured-data/chunking-strategy.js';
import type { IngestionJobData } from '../services/structured-data/ingestion-types.js';
import type { ColumnSchema } from '../services/structured-data/types.js';

// =============================================================================
// CONSTANTS
// =============================================================================

const QUEUE_NAME = 'structured-data-ingestion';

// =============================================================================
// WORKER PROCESSOR
// =============================================================================

async function processStructuredDataIngestion(job: Job<IngestionJobData>): Promise<void> {
  const {
    tenantId,
    indexId,
    documentId,
    tableId,
    tableName,
    displayName,
    description,
    columns,
    primaryKey,
    fileBuffer,
    originalFilename,
    mimeType,
    metadata,
  } = job.data;
  const { SearchIndex, SearchDocument, SearchChunk } = getModels();

  workerLog(
    'structured-data-ingestion',
    `Processing structured data ingestion for table ${tableName}`,
    {
      indexId,
      tenantId,
      tableId,
      originalFilename,
      rowCount: 'unknown',
    },
  );

  await withTraceContext(job.data as unknown as Record<string, unknown>, () =>
    withTenantContext({ tenantId }, async () => {
      try {
        // ── 1. Verify index exists ──────────────────────────────────────────
        const index = await SearchIndex.findOne({ _id: indexId, tenantId }).lean();
        if (!index) {
          throw new Error(`Index ${indexId} not found for tenant ${tenantId}`);
        }

        // ── 2. Parse file to extract rows ───────────────────────────────────
        await job.updateProgress(10);
        workerLog('structured-data-ingestion', `Parsing file ${originalFilename}`, { tableId });

        // CRITICAL: BullMQ serializes to JSON, Buffer becomes plain object
        // Convert back to Buffer if needed
        let actualBuffer: Buffer;
        if (Buffer.isBuffer(fileBuffer)) {
          actualBuffer = fileBuffer;
        } else if (
          fileBuffer &&
          typeof fileBuffer === 'object' &&
          'type' in fileBuffer &&
          (fileBuffer as any).type === 'Buffer'
        ) {
          // BullMQ serialized Buffer format: {type: 'Buffer', data: [1,2,3,...]}
          actualBuffer = Buffer.from((fileBuffer as any).data);
        } else {
          throw new Error(`Invalid fileBuffer type: ${typeof fileBuffer}`);
        }

        const analyzer = new StructuredDataSchemaAnalyzer();
        const parsedData = await (analyzer as any).parseFile(
          actualBuffer,
          originalFilename,
          mimeType,
        );
        const rows = parsedData.rows;

        workerLog('structured-data-ingestion', `Parsed ${rows.length} rows`, { tableId });

        if (rows.length === 0) {
          throw new Error('No data rows found in file');
        }

        // ── 3. Apply smart chunking strategy ────────────────────────────────
        await job.updateProgress(20);
        workerLog('structured-data-ingestion', `Applying smart chunking strategy`, { tableId });

        // Convert columns to ColumnSchema format
        const columnSchemas: ColumnSchema[] = columns.map((col) => ({
          name: col.name,
          type: col.type as ColumnSchema['type'],
          description: col.description,
          nullable: true, // We don't have this info from finalize, assume nullable
          isEmbeddable: col.isEmbeddable,
          isFilterable: col.isFilterable,
        }));

        const chunkingStrategy = new StructuredDataChunkingStrategy();
        const chunkingResult = chunkingStrategy.chunk(
          tableName,
          displayName,
          description,
          columnSchemas,
          rows,
          primaryKey,
          [], // foreignKeys - will be populated by Task #25
          {}, // statistics
        );

        workerLog('structured-data-ingestion', `Chunking complete`, {
          tableId,
          totalRows: chunkingResult.statistics.totalRows,
          chunkedRows: chunkingResult.statistics.chunkedRows,
          skippedRows: chunkingResult.statistics.skippedRows,
          savingsPercent: chunkingResult.statistics.savingsPercent,
        });

        // ── 4. Store data rows in ClickHouse ────────────────────────────────
        await job.updateProgress(40);
        workerLog('structured-data-ingestion', `Storing ${rows.length} rows in ClickHouse`, {
          tableId,
        });

        const chClient = new StructuredDataClickHouseClient();
        await chClient.initialize();
        const insertResult = await chClient.insertRows(tenantId, indexId, tableId, rows);

        if (!insertResult.success) {
          throw new Error(
            `ClickHouse row insertion failed: ${insertResult.error?.message || 'Unknown error'}`,
          );
        }

        workerLog('structured-data-ingestion', `ClickHouse data storage complete`, { tableId });

        // ── 5. Store table metadata in ClickHouse ───────────────────────────
        await job.updateProgress(50);
        workerLog('structured-data-ingestion', `Storing table metadata`, { tableId });

        // Build searchable text from table name, display name, description, and column names
        const searchableText = [
          tableName,
          displayName,
          description,
          ...columnSchemas.map((c) => `${c.name} ${c.description || ''}`),
        ]
          .filter(Boolean)
          .join(' ');

        // Build column descriptions map
        const columnDescriptions: Record<string, string> = {};
        for (const col of columnSchemas) {
          if (col.description) {
            columnDescriptions[col.name] = col.description;
          }
        }

        const now = new Date();
        const tableMetadata: import('../services/structured-data/types.js').TableMetadata = {
          table_id: tableId,
          table_name: tableName,
          display_name: displayName,
          tenant_id: tenantId,
          index_id: indexId,
          columns: JSON.stringify(columnSchemas.map((c) => c.name)),
          column_types: JSON.stringify(columnSchemas.map((c) => c.type)),
          primary_key: primaryKey,
          row_count: rows.length,
          table_description: description,
          column_descriptions: JSON.stringify(columnDescriptions),
          statistics: JSON.stringify({}),
          sample_rows: JSON.stringify(chunkingResult.metadataChunk.sampleRows),
          foreign_keys: JSON.stringify([]),
          searchable_text: searchableText,
          created_at: now,
          updated_at: now,
        };

        await chClient.insertMetadata(tableMetadata);

        workerLog('structured-data-ingestion', `Table metadata stored`, { tableId });

        // ── 6. Create SearchChunk for table metadata (no row chunks) ────────
        await job.updateProgress(60);

        workerLog('structured-data-ingestion', `Creating metadata SearchChunk (no row chunks)`, {
          tableId,
          note: 'All rows stored in ClickHouse, only metadata chunk for semantic table discovery',
        });

        const chunkRecords = [];

        // Create ONLY the table metadata chunk (no row chunks)
        const metadataContent = JSON.stringify(chunkingResult.metadataChunk);

        // Fetch document to get sourceUrl for citation support
        const document = await SearchDocument.findOne({ _id: documentId, tenantId }).lean();
        const canonicalMetadata: Record<string, unknown> = {
          source_type: mimeType?.includes('csv') ? 'csv' : 'spreadsheet',
          mime_type: mimeType || 'text/csv',
          title:
            displayName || tableName || (document as any)?.name || originalFilename || undefined,
          // source_url: use external download URL for citations (never expose internal storage paths)
          ...((document as any)?.downloadUrl ? { source_url: (document as any).downloadUrl } : {}),
        };

        const metadataChunk = await SearchChunk.create({
          tenantId,
          indexId,
          documentId: documentId, // Use actual documentId
          sourceId: documentId, // Use actual documentId
          chunkIndex: 0,
          chunkType: 'table_metadata',
          content: metadataContent,
          tokenCount: countTokens(metadataContent),
          contentPreview: `Table: ${tableName} (${rows.length} rows, ${columnSchemas.length} columns)`,
          status: ChunkStatus.PENDING,
          canonicalMetadata,
          metadata: {
            tableId,
            tableName,
            displayName,
            rowCount: rows.length,
            columnCount: columnSchemas.length,
            primaryKey,
            sampleRowCount: chunkingResult.metadataChunk.sampleRows.length,
            chunkingStrategy: 'metadata-only',
            savingsPercent: chunkingResult.statistics.savingsPercent,
          },
        });

        chunkRecords.push(metadataChunk);

        // NO row chunks created - all data in ClickHouse
        // Query routing: SQL → ClickHouse, Semantic → metadata chunk → ClickHouse

        workerLog('structured-data-ingestion', `Created 1 metadata SearchChunk (100% savings)`, {
          tableId,
          totalRows: rows.length,
          rowChunksSkipped: rows.length,
        });

        // ── 7. Enqueue embedding job ────────────────────────────────────────
        await job.updateProgress(85);
        workerLog('structured-data-ingestion', `Enqueuing embedding job`, { tableId });

        const embeddingQueue = createQueue(QUEUE_EMBEDDING);
        try {
          const embeddingJobData: EmbeddingJobData = {
            indexId,
            documentId: documentId, // Use actual documentId
            chunkIds: chunkRecords.map((c) => String(c._id)),
            tenantId,
          };

          await embeddingQueue.add(`embed-structured-${documentId}`, embeddingJobData, {
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 5000,
            },
          });

          workerLog('structured-data-ingestion', `Embedding job enqueued`, {
            documentId,
            tableId,
          });
        } finally {
          await embeddingQueue.close();
        }

        // ── 8. Update document status and mark index as having structured data
        await SearchDocument.updateOne(
          { _id: documentId, tenantId },
          {
            $set: {
              status: 'indexed',
              chunkCount: chunkRecords.length,
            },
          },
        );

        // Mark index as having structured data (for query-time enrichment skip)
        await SearchIndex.updateOne(
          { _id: indexId, tenantId },
          { $set: { hasStructuredData: true } },
        );

        workerLog('structured-data-ingestion', `Document status updated to indexed`, {
          documentId,
          tableId,
        });

        // ── 9. Complete ─────────────────────────────────────────────────────
        await job.updateProgress(100);
        workerLog('structured-data-ingestion', `Structured data ingestion complete`, {
          tableId,
          totalRows: rows.length,
          chunksCreated: chunkRecords.length,
          embeddingsPending: chunkRecords.length,
        });
      } catch (error) {
        workerError(
          'structured-data-ingestion',
          `Ingestion failed for table ${tableName} (tableId=${tableId}, indexId=${indexId})`,
          error,
        );
        throw error; // Re-throw to mark job as failed
      }
    }),
  );
}

// =============================================================================
// WORKER INSTANCE
// =============================================================================

export function createStructuredDataIngestionWorker() {
  return new Worker(QUEUE_NAME, processStructuredDataIngestion, createWorkerOptions());
}

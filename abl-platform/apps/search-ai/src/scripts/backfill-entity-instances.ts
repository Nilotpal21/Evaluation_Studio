/**
 * Backfill entity instances from MongoDB to ClickHouse.
 *
 * Reads SearchDocument records with kgState.status === 'ENRICHED',
 * transforms their entityInstances[] into ClickHouse rows,
 * and writes via BufferedClickHouseWriter.
 *
 * Usage:
 *   npx tsx apps/search-ai/src/scripts/backfill-entity-instances.ts [options]
 *
 * Options:
 *   --tenant-id <id>    Filter to specific tenant
 *   --index-id <id>     Filter to specific index
 *   --batch-size <n>    MongoDB cursor batch size (default: 500)
 *   --dry-run           Count documents without writing to ClickHouse
 *   --clean             DELETE existing CH rows for scoped tenant/index before inserting
 */

import mongoose from 'mongoose';
import type { ISearchDocument } from '@agent-platform/database/models';
import {
  getClickHouseClient,
  closeClickHouseClient,
  BufferedClickHouseWriter,
} from '@agent-platform/database/clickhouse';
import { createLogger } from '@abl/compiler/platform';
import type { EntityInstanceRow } from '../services/knowledge-graph/clickhouse-entity-store.js';

const logger = createLogger('backfill-entity-instances');

const DATABASE = 'abl_platform';

// ─── CLI Argument Parsing ───────────────────────────────────────────────

interface BackfillOptions {
  tenantId?: string;
  indexId?: string;
  batchSize: number;
  dryRun: boolean;
  clean: boolean;
}

function parseArgs(): BackfillOptions {
  const args = process.argv.slice(2);
  const opts: BackfillOptions = {
    batchSize: 500,
    dryRun: false,
    clean: false,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tenant-id') opts.tenantId = args[++i];
    else if (args[i] === '--index-id') opts.indexId = args[++i];
    else if (args[i] === '--batch-size') opts.batchSize = parseInt(args[++i], 10);
    else if (args[i] === '--dry-run') opts.dryRun = true;
    else if (args[i] === '--clean') opts.clean = true;
  }

  return opts;
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  const startTime = Date.now();

  logger.info('Starting entity instances backfill', {
    tenantId: opts.tenantId ?? 'all',
    indexId: opts.indexId ?? 'all',
    batchSize: opts.batchSize,
    dryRun: opts.dryRun,
    clean: opts.clean,
  });

  // ── Connect to MongoDB (content DB) ──
  const mongoUri =
    process.env.SEARCH_AI_CONTENT_DB_URI ||
    process.env.MONGODB_URI ||
    'mongodb://localhost:27017/search_ai';

  logger.info('Connecting to MongoDB', { uri: mongoUri.replace(/\/\/[^@]+@/, '//***@') });
  await mongoose.connect(mongoUri);
  logger.info('MongoDB connected');

  // ── Import model after connection ──
  // SearchDocument self-registers on import; we need the connection to be open first
  const { SearchDocument } = await import('@agent-platform/database/models');

  // ── Clean if requested (requires ClickHouse) ──
  if (opts.clean) {
    if (!opts.tenantId) {
      logger.error('--clean requires --tenant-id to prevent accidental full table wipe');
      process.exit(1);
    }

    const cleanClient = getClickHouseClient();
    let deleteQuery = `ALTER TABLE ${DATABASE}.entity_instances DELETE WHERE tenant_id = {t:String}`;
    const params: Record<string, string> = { t: opts.tenantId };

    if (opts.indexId) {
      deleteQuery += ` AND index_id = {i:String}`;
      params.i = opts.indexId;
    }

    logger.info('Cleaning existing rows', { tenantId: opts.tenantId, indexId: opts.indexId });
    await cleanClient.command({ query: deleteQuery, query_params: params });
    logger.info('Clean complete');
  }

  // ── Build MongoDB query ──
  const filter: Record<string, unknown> = {
    'metadata.kgState.status': 'ENRICHED',
    entityInstances: { $exists: true, $ne: [] },
  };
  if (opts.tenantId) filter.tenantId = opts.tenantId;
  if (opts.indexId) filter.indexId = opts.indexId;

  // Count total
  const totalDocs = await SearchDocument.countDocuments(filter);
  logger.info(`Found ${totalDocs} enriched documents with entity instances`);

  if (totalDocs === 0) {
    logger.info('Nothing to backfill. Exiting.');
    await cleanup();
    return;
  }

  if (opts.dryRun) {
    logger.info('DRY RUN: Would process these documents. No ClickHouse writes.');
    await cleanup();
    return;
  }

  // ── Connect to ClickHouse (deferred until after dry-run check) ──
  const chClient = getClickHouseClient();

  // ── Create buffered writer ──
  const writer = new BufferedClickHouseWriter<EntityInstanceRow>(chClient, {
    table: `${DATABASE}.entity_instances`,
    batchSize: 5_000,
    flushIntervalMs: 3_000,
    maxRetries: 3,
    onError: (error, context) => {
      logger.error('ClickHouse write error', {
        error: error instanceof Error ? error.message : String(error),
        table: context.table,
        pending: context.pending,
        retries: context.retries,
      });
    },
    onSuccess: (rowCount, durationMs) => {
      logger.info('Flushed rows to ClickHouse', { rowCount, durationMs });
    },
  });

  // ── Stream documents via cursor ──
  const cursor = SearchDocument.find(filter)
    .select('_id tenantId indexId entityInstances classification metadata')
    .lean()
    .cursor({ batchSize: opts.batchSize });

  let processedDocs = 0;
  let totalRows = 0;
  let errorCount = 0;

  try {
    for await (const doc of cursor as AsyncIterable<ISearchDocument>) {
      try {
        const productType = doc.classification?.productScope?.primaryProduct ?? 'unknown';
        const enrichedAt =
          doc.metadata?.kgState?.enrichedAt instanceof Date
            ? doc.metadata.kgState.enrichedAt.toISOString()
            : new Date().toISOString();
        const taxonomyVersion = doc.metadata?.kgState?.taxonomyVersion ?? '';

        for (const entity of doc.entityInstances ?? []) {
          const normalizedStr =
            entity.normalizedValue != null ? String(entity.normalizedValue) : '';

          // Fallback to empty string if chunkIds is empty (matches ClickHouseEntityStore behavior)
          const chunkIds = entity.chunkIds?.length > 0 ? entity.chunkIds : [''];

          for (const chunkId of chunkIds) {
            const row: EntityInstanceRow = {
              tenant_id: doc.tenantId,
              index_id: doc.indexId,
              document_id: doc._id,
              chunk_id: chunkId,
              attribute_type: entity.type,
              product_type: productType,
              // data_type not available on IEntityInstance — defaults to 'string'.
              // Live enrichment resolves from taxonomy; backfill would need taxonomy
              // lookup per index which adds complexity. Acceptable for one-time backfill.
              data_type: 'string',
              raw_value: entity.rawValue,
              normalized_value: normalizedStr,
              enriched_at: enrichedAt,
              taxonomy_version: taxonomyVersion,
            };

            writer.insert(row);
            totalRows++;
          }
        }

        processedDocs++;

        if (processedDocs % 1000 === 0) {
          logger.info('Progress', {
            processedDocs,
            totalDocs,
            totalRows,
            percent: Math.round((processedDocs / totalDocs) * 100),
            pending: writer.pending,
          });
        }
      } catch (error) {
        errorCount++;
        logger.error('Failed to process document', {
          documentId: doc._id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await cursor.close();
  }

  // ── Flush remaining ──
  logger.info('Flushing remaining buffer', { pending: writer.pending });
  await writer.close();

  const durationMs = Date.now() - startTime;
  logger.info('Backfill complete', {
    totalDocs: processedDocs,
    totalRows,
    errors: errorCount,
    durationMs,
  });

  await cleanup();
}

async function cleanup(): Promise<void> {
  await mongoose.disconnect();
  await closeClickHouseClient();
}

// ── Run ─────────────────────────────────────────────────────────────────

main().catch((error) => {
  logger.error('Backfill script failed', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});

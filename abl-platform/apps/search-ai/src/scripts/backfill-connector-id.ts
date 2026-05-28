/**
 * Backfill Script: Populate connectorId in SearchDocument
 *
 * This script backfills the connectorId field for documents that were ingested
 * before the field existed. It looks up the SearchSource by sourceId and copies
 * the connectorId from the source to the document.
 *
 * Usage:
 *   pnpm tsx apps/search-ai/src/scripts/backfill-connector-id.ts [--dry-run] [--batch-size=1000]
 *
 * Options:
 *   --dry-run      : Preview changes without updating database
 *   --batch-size=N : Process N documents per batch (default: 1000)
 *   --tenant-id=X  : Only backfill for specific tenant (optional)
 */

import { getLazyModel, bindModelsForSearchAI } from '../db/index.js';
import type { ISearchDocument, ISearchSource } from '@agent-platform/database/models';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('backfill-connector-id');

// Parse CLI arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    dryRun: args.includes('--dry-run'),
    batchSize: 1000,
    tenantId: null as string | null,
  };

  for (const arg of args) {
    if (arg.startsWith('--batch-size=')) {
      options.batchSize = parseInt(arg.split('=')[1], 10);
    }
    if (arg.startsWith('--tenant-id=')) {
      options.tenantId = arg.split('=')[1];
    }
  }

  return options;
}

/**
 * Main backfill logic
 */
async function backfillConnectorId() {
  const options = parseArgs();

  logger.info('Starting connectorId backfill', {
    dryRun: options.dryRun,
    batchSize: options.batchSize,
    tenantId: options.tenantId || 'all',
  });

  // Bind models to correct databases
  await bindModelsForSearchAI();

  const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument');
  const SearchSource = getLazyModel<ISearchSource>('SearchSource');

  // Build filter: documents with null connectorId
  const filter: Record<string, unknown> = { connectorId: null };
  if (options.tenantId) {
    filter.tenantId = options.tenantId;
  }

  // Count total documents to process
  const totalCount = await SearchDocument.countDocuments(filter);
  logger.info(`Found ${totalCount} documents to backfill`);

  if (totalCount === 0) {
    logger.info('No documents need backfilling. Exiting.');
    process.exit(0);
  }

  // Process in batches
  let processedCount = 0;
  let updatedCount = 0;
  let errorCount = 0;
  let batchNumber = 0;

  while (processedCount < totalCount) {
    batchNumber++;
    const batchStartTime = Date.now();

    // Fetch batch of documents
    const documents = await SearchDocument.find(filter)
      .select('_id tenantId sourceId')
      .limit(options.batchSize)
      .lean();

    if (documents.length === 0) {
      break;
    }

    logger.info(`Processing batch ${batchNumber}`, {
      batchSize: documents.length,
      progress: `${processedCount}/${totalCount}`,
    });

    // Group by sourceId for efficient lookup
    const sourceIds = [...new Set(documents.map((doc) => doc.sourceId))];

    // Bulk fetch sources
    const sources = await SearchSource.find({
      _id: { $in: sourceIds },
    })
      .select('_id connectorId')
      .lean();

    // Create lookup map: sourceId -> connectorId
    const sourceMap = new Map<string, string | null>();
    for (const source of sources) {
      sourceMap.set(source._id, source.connectorId || null);
    }

    // Process each document
    for (const doc of documents) {
      try {
        const connectorId = sourceMap.get(doc.sourceId);

        if (connectorId) {
          if (!options.dryRun) {
            await SearchDocument.updateOne(
              { _id: doc._id, tenantId: doc.tenantId },
              { $set: { connectorId } },
            );
          }
          updatedCount++;
        } else {
          // Source has no connectorId - this is normal for direct uploads
          logger.debug('Document has no connector (direct upload)', {
            documentId: doc._id,
            sourceId: doc.sourceId,
          });
        }

        processedCount++;
      } catch (error) {
        errorCount++;
        logger.error('Failed to update document', {
          documentId: doc._id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const batchDuration = Date.now() - batchStartTime;
    logger.info(`Batch ${batchNumber} complete`, {
      processed: documents.length,
      duration: `${batchDuration}ms`,
      totalProgress: `${processedCount}/${totalCount} (${Math.round((processedCount / totalCount) * 100)}%)`,
    });
  }

  // Final summary
  logger.info('Backfill complete', {
    dryRun: options.dryRun,
    totalDocuments: totalCount,
    processedCount,
    updatedCount,
    errorCount,
    skippedCount: processedCount - updatedCount - errorCount,
  });

  if (options.dryRun) {
    logger.info('DRY RUN: No changes were made. Remove --dry-run flag to apply updates.');
  }

  process.exit(errorCount > 0 ? 1 : 0);
}

// Run the backfill
backfillConnectorId().catch((error) => {
  logger.error('Backfill script failed', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});

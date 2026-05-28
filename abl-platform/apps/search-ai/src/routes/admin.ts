/**
 * Admin API Routes
 *
 * Administrative operations for SearchAI service.
 * Requires elevated permissions.
 */

import { Router, type Request, type Response, type Router as RouterType } from 'express';
import { requirePermission } from '@agent-platform/shared-auth';
import {
  createVectorStore,
  forceRotateSharedIndex,
  syncAllSharedIndexStats,
  getAppIndices,
} from '@agent-platform/search-ai-internal/vector-store';
import { AVAILABLE_CANONICAL_FIELDS } from '@agent-platform/search-ai-internal';
import { getModel, getLazyModel } from '../db/index.js';
import { createLogger } from '@abl/compiler/platform';
import { Client as OpenSearchClient } from '@opensearch-project/opensearch';
import type { ISearchDocument, ISearchChunk, ISearchIndex } from '@agent-platform/database/models';
import { buildDefaultCanonicalFields } from '../workers/canonical-mapper-worker.js';
import queueMonitoringRouter from './queue-monitoring.js';
import errorsRouter from './errors.js';
import metricsRouter from './metrics.js';

const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument');
const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk');
const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');

const logger = createLogger('admin-routes');
const router: RouterType = Router();

// Mount queue monitoring routes (admin-only)
router.use('/queues', requirePermission('admin:queues:read'), queueMonitoringRouter);

// Mount error tracking routes
router.use('/errors', errorsRouter);

// Mount metrics routes
router.use('/metrics', metricsRouter);

/**
 * POST /api/admin/indexes/rotate-shared
 *
 * Manually trigger shared index rotation.
 * Forces rotation regardless of capacity threshold.
 *
 * @returns Rotation details including old/new index names and versions
 */
router.post(
  '/indexes/rotate-shared',
  requirePermission('admin:indexes:rotate'),
  async (req: Request, res: Response) => {
    try {
      const vectorStore = createVectorStore({
        provider: (process.env.VECTOR_STORE_PROVIDER as any) || 'opensearch',
        url: process.env.VECTOR_STORE_URL || 'http://localhost:9200',
        apiKey: process.env.VECTOR_STORE_API_KEY,
      });

      // Dimensions must be provided in the request body for dimension-aware rotation
      const dimensions = req.body?.dimensions || 1024;
      const result = await forceRotateSharedIndex(vectorStore, dimensions);

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      logger.error('Failed to rotate shared index', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'ROTATION_FAILED',
          message: error.message || 'Failed to rotate shared index',
        },
      });
    }
  },
);

/**
 * GET /api/admin/indexes/shared/status
 *
 * Get current status of all shared indices.
 *
 * @returns Array of shared index trackers with capacity info
 */
router.get(
  '/indexes/shared/status',
  requirePermission('admin:indexes:read'),
  async (_req: Request, res: Response) => {
    try {
      // Sync stats from OpenSearch (source of truth) before returning
      const vectorStore = createVectorStore({
        provider: (process.env.VECTOR_STORE_PROVIDER as any) || 'opensearch',
        url: process.env.VECTOR_STORE_URL || 'http://localhost:9200',
        apiKey: process.env.VECTOR_STORE_API_KEY,
      });
      await syncAllSharedIndexStats(vectorStore);

      const SharedIndexTracker = getModel('SharedIndexTracker');
      const trackers = await SharedIndexTracker.find()
        .sort({ dimensions: 1, version: -1 })
        .select(
          'indexName version dimensions status vectorCount estimatedSizeGB capacityPercent maxVectors appCount createdAt lastSyncedAt',
        )
        .lean();

      res.status(200).json({
        success: true,
        data: {
          trackers,
          activeIndices: trackers.filter((t: any) => t.status === 'active'),
          fullIndices: trackers.filter((t: any) => t.status === 'full'),
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get shared index status', { error: message });
      res.status(500).json({
        success: false,
        error: {
          code: 'STATUS_FETCH_FAILED',
          message: message || 'Failed to fetch shared index status',
        },
      });
    }
  },
);

/**
 * POST /api/admin/indexes/shared/archive/:version
 *
 * Archive a full shared index (mark as archived, optionally delete from OpenSearch).
 * Only allowed if appCount === 0.
 *
 * @param version - Shared index version to archive
 * @body deleteFromOpenSearch - Whether to delete from OpenSearch (default: false)
 * @returns Archival confirmation
 */
router.post(
  '/indexes/shared/archive/:version',
  requirePermission('admin:indexes:delete'),
  async (req: Request, res: Response) => {
    try {
      const version = parseInt(req.params.version, 10);
      const deleteFromOpenSearch = req.body.deleteFromOpenSearch === true;

      if (isNaN(version)) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_VERSION',
            message: 'Version must be a number',
          },
        });
      }

      const SharedIndexTracker = getModel('SharedIndexTracker');
      const tracker = await SharedIndexTracker.findOne({ version });

      if (!tracker) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'INDEX_NOT_FOUND',
            message: `Shared index v${version} not found`,
          },
        });
      }

      if (tracker.status === 'active') {
        return res.status(400).json({
          success: false,
          error: {
            code: 'CANNOT_ARCHIVE_ACTIVE',
            message: 'Cannot archive active index. Rotate first.',
          },
        });
      }

      if (tracker.appCount > 0) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INDEX_IN_USE',
            message: `Cannot archive index with ${tracker.appCount} apps still using it`,
          },
        });
      }

      // Mark as archived
      tracker.status = 'archived';
      await tracker.save();

      // Optionally delete from OpenSearch
      let deleted = false;
      if (deleteFromOpenSearch) {
        const vectorStore = createVectorStore({
          provider: (process.env.VECTOR_STORE_PROVIDER as any) || 'opensearch',
          url: process.env.VECTOR_STORE_URL || 'http://localhost:9200',
          apiKey: process.env.VECTOR_STORE_API_KEY,
        });

        await vectorStore.deleteCollection(tracker.indexName);
        deleted = true;
      }

      res.status(200).json({
        success: true,
        data: {
          indexName: tracker.indexName,
          version: tracker.version,
          deletedFromOpenSearch: deleted,
        },
      });
    } catch (error: any) {
      logger.error('Failed to archive shared index', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'ARCHIVE_FAILED',
          message: error.message || 'Failed to archive shared index',
        },
      });
    }
  },
);

// =============================================================================
// POST /api/admin/backfill-canonical-metadata
//
// One-shot migration: backfill null canonicalMetadata on chunks.
// Populates mime_type, source_type, and other canonical fields from the parent
// document's contentType. Updates both MongoDB and OpenSearch.
//
// This fixes chunks created before the canonical-mapper-worker was enhanced
// to populate default canonical fields (buildDefaultCanonicalFields).
// =============================================================================

router.post(
  '/backfill-canonical-metadata',
  requirePermission('admin:indexes:rotate'),
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.tenantContext?.tenantId;
      if (!tenantId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const dryRun = req.query.dryRun === 'true';

      // 1. Find all chunks with null canonicalMetadata for this tenant
      const nullChunks = await SearchChunk.find({
        tenantId,
        $or: [{ canonicalMetadata: null }, { canonicalMetadata: { $exists: false } }],
      })
        .select('_id documentId indexId')
        .lean();

      if (nullChunks.length === 0) {
        res.json({
          success: true,
          message: 'No chunks with null canonicalMetadata found',
          updated: 0,
        });
        return;
      }

      // 2. Group chunks by documentId
      const chunksByDoc = new Map<string, { chunkIds: string[]; indexId: string }>();
      for (const chunk of nullChunks) {
        const docId = String(chunk.documentId);
        if (!chunksByDoc.has(docId)) {
          chunksByDoc.set(docId, {
            chunkIds: [],
            indexId: String(chunk.indexId),
          });
        }
        chunksByDoc.get(docId)!.chunkIds.push(String(chunk._id));
      }

      logger.info('Backfill canonical metadata: found chunks to update', {
        totalChunks: nullChunks.length,
        documents: chunksByDoc.size,
        dryRun,
      });

      if (dryRun) {
        const preview: Record<string, unknown>[] = [];
        for (const [docId, { chunkIds, indexId }] of chunksByDoc) {
          const document = await SearchDocument.findOne({ _id: docId, tenantId }).lean();
          const index = await SearchIndex.findOne({ _id: indexId, tenantId }).lean();
          if (document && index) {
            const canonical = buildFilteredCanonical(document, index);
            preview.push({
              documentId: docId,
              contentType: document.contentType,
              chunkCount: chunkIds.length,
              canonicalMetadata: canonical,
            });
          }
        }
        res.json({
          success: true,
          dryRun: true,
          totalChunks: nullChunks.length,
          documents: chunksByDoc.size,
          preview,
        });
        return;
      }

      // 3. Process each document group
      let mongoUpdated = 0;
      let osUpdated = 0;
      const errors: string[] = [];

      // Create OpenSearch client for vector metadata updates
      const osUrl = process.env.VECTOR_STORE_URL || 'http://localhost:9200';
      const osApiKey = process.env.VECTOR_STORE_API_KEY;
      const osClient = new OpenSearchClient({
        node: osUrl,
        auth: osApiKey ? { username: 'admin', password: osApiKey } : undefined,
        requestTimeout: 30_000,
      });

      for (const [docId, { chunkIds, indexId }] of chunksByDoc) {
        try {
          // Load document and index
          const [document, index] = await Promise.all([
            SearchDocument.findOne({ _id: docId, tenantId }).lean(),
            SearchIndex.findOne({ _id: indexId, tenantId }).lean(),
          ]);

          if (!document || !index) {
            errors.push(`Document ${docId}: not found (skipped)`);
            continue;
          }

          // Build canonical metadata
          const canonical = buildFilteredCanonical(document, index);

          if (Object.keys(canonical).length === 0) {
            errors.push(
              `Document ${docId}: no canonical fields could be derived (contentType: ${document.contentType})`,
            );
            continue;
          }

          // 4. Update MongoDB chunks
          const mongoResult = await SearchChunk.updateMany(
            { _id: { $in: chunkIds }, tenantId },
            { $set: { canonicalMetadata: canonical } },
          );
          mongoUpdated += mongoResult.modifiedCount;

          // 5. Update OpenSearch vectors (partial doc update)
          try {
            const osIndices = await getAppIndices(tenantId, indexId);
            for (const osIndex of osIndices) {
              const updateResult = await osClient.updateByQuery({
                index: osIndex,
                body: {
                  query: {
                    terms: { _id: chunkIds },
                  },
                  script: {
                    source: 'ctx._source.metadata.canonical = params.canonical',
                    lang: 'painless',
                    params: { canonical },
                  },
                },
                refresh: true,
              });
              osUpdated += ((updateResult.body as any)?.updated as number) ?? 0;
            }
          } catch (osErr) {
            const msg = osErr instanceof Error ? osErr.message : String(osErr);
            errors.push(`Document ${docId}: OpenSearch update failed — ${msg}`);
            // MongoDB was already updated; log but continue
          }

          logger.info('Backfilled canonical metadata for document', {
            documentId: docId,
            contentType: document.contentType,
            chunkCount: chunkIds.length,
            fields: Object.keys(canonical),
          });
        } catch (docErr) {
          const msg = docErr instanceof Error ? docErr.message : String(docErr);
          errors.push(`Document ${docId}: ${msg}`);
        }
      }

      res.json({
        success: true,
        totalChunksFound: nullChunks.length,
        documentsProcessed: chunksByDoc.size,
        mongoChunksUpdated: mongoUpdated,
        opensearchVectorsUpdated: osUpdated,
        errors: errors.length > 0 ? errors : undefined,
      });
    } catch (error) {
      logger.error('Backfill canonical metadata failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'BACKFILL_FAILED',
          message: error instanceof Error ? error.message : 'Backfill failed',
        },
      });
    }
  },
);

/**
 * Build canonical metadata for a document, filtered through AVAILABLE_CANONICAL_FIELDS.
 * Reuses the same logic as canonical-mapper-worker's buildDefaultCanonicalFields.
 */
function buildFilteredCanonical(
  document: ISearchDocument,
  index: ISearchIndex,
): Record<string, unknown> {
  const raw = buildDefaultCanonicalFields(document, index);

  // Filter: only keep fields that are in AVAILABLE_CANONICAL_FIELDS
  const canonicalFieldNames = new Set(AVAILABLE_CANONICAL_FIELDS.map((f) => f.storageField));
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (canonicalFieldNames.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

export default router;

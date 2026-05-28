/**
 * Document Listing Routes
 *
 * GET  /:indexId/documents         — List documents for an index
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import {
  createVectorStore,
  resolveIndexForWrite,
  type VectorStoreProvider,
} from '@agent-platform/search-ai-internal';
import { createLogger } from '@abl/compiler/platform';

import { getLazyModel } from '../db/index.js';
import { applyProjectScopeFilter } from './project-scope.js';
import { StructuredDataClickHouseClient } from '../services/structured-data/clickhouse-client.js';
import { escapeRegex } from '../utils/query-helpers.js';
import type {
  ISearchDocument,
  ISearchIndex,
  ISearchChunk,
  IKnowledgeBase,
  IChunkQuestion,
  ISearchSource,
} from '@agent-platform/database/models';

// Models bound to correct databases (platform vs content)
const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument'); // → search_ai
const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex'); // → abl_platform
const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk'); // → search_ai
const SearchSource = getLazyModel<ISearchSource>('SearchSource'); // → search_ai
const ChunkQuestion = getLazyModel<IChunkQuestion>('ChunkQuestion'); // → search_ai
const KnowledgeBase = getLazyModel<IKnowledgeBase>('KnowledgeBase'); // → abl_platform
const logger = createLogger('documents');
const router: RouterType = Router();

const SAFE_ERROR_PREFIXES = [
  'no extractable content',
  'no chunks found',
  'unsupported file',
  'unsupported content',
  'unsupported format',
  'invalid file',
  'corrupt',
  'empty file',
  'password protected',
  'encrypted',
  'could not parse',
  'could not read',
  'not a valid',
  'file is too large',
  'zero bytes',
  'unable to extract',
  'extraction failed',
  'enrichment failed',
  'embedding failed',
  'canonical mapping failed',
  'docling extraction failed',
];

function sanitizeProcessingError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  for (const prefix of SAFE_ERROR_PREFIXES) {
    if (lower.includes(prefix))
      return raw
        .replace(/\/[\w\-./]+/g, '<path>')
        .replace(/(https?|mongodb(\+srv)?|redis|amqp):\/\/[^\s,)]+/g, '<url>')
        .replace(/\b(tenantId|apiKey|token|secret|password)=[^\s,)&]+/gi, '$1=<redacted>');
  }
  return 'Processing failed';
}

// =============================================================================
// GET /:indexId/documents — List documents for an index
// =============================================================================

router.get('/:indexId/documents', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const tenantId = req.tenantContext.tenantId;

    const { indexId } = req.params;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
    const sourceId = req.query.sourceId as string | undefined;
    const sourceType = req.query.sourceType as string | undefined;
    const status = req.query.status as string | undefined;
    const search = req.query.search as string | undefined;

    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext),
    ).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    const filter: Record<string, unknown> = { indexId, tenantId };
    if (sourceId) filter.sourceId = sourceId;
    if (sourceType) {
      // sourceType is a property on SearchSource, not on the document's sourceMetadata.
      // Look up sources of the given type and filter documents by their sourceIds.
      const matchingSources = await SearchSource.find(
        { indexId, tenantId, sourceType },
        { _id: 1 },
      ).lean();
      const matchingSourceIds = matchingSources.map((s) => String(s._id));
      filter.sourceId = { $in: matchingSourceIds };
    }
    if (status) {
      // Alias: 'processing' maps to the actual in-flight statuses (matches health-summary aggregation)
      const STATUS_ALIASES: Record<string, string[]> = {
        processing: ['extracting', 'enriching', 'embedding'],
      };
      const raw = (status as string)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const statuses = raw.flatMap((s) => STATUS_ALIASES[s] ?? [s]);
      filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
    }
    if (search) filter.originalReference = { $regex: escapeRegex(search as string), $options: 'i' };

    const total = await SearchDocument.countDocuments(filter);
    const documents = await SearchDocument.find(filter)
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .select(
        '_id originalReference status processingError chunkCount sourceId sourceMetadata contentType createdAt lastIndexedAt contentSizeBytes',
      )
      .lean();

    const mapped = documents.map((d) => ({
      _id: d._id,
      title: d.originalReference,
      status: d.status,
      processingError: sanitizeProcessingError(d.processingError),
      chunkCount: d.chunkCount,
      sourceId: d.sourceId,
      contentType: d.contentType,
      sourceMetadata: d.sourceMetadata,
      contentSizeBytes: d.contentSizeBytes,
      createdAt: (d as any).lastIndexedAt || d.createdAt,
      lastIndexedAt: (d as any).lastIndexedAt,
    }));

    res.json({
      documents: mapped,
      total,
      pagination: { limit, offset, hasMore: offset + mapped.length < total },
    });
  } catch (error) {
    logger.error('Failed to list documents', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to list documents' });
  }
});

// ---------------------------------------------------------------------------
// GET document status summary (aggregated counts)
// ---------------------------------------------------------------------------

router.get('/:indexId/documents/status-summary', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const { indexId } = req.params;
    const tenantId = req.tenantContext.tenantId;

    const [docStatusCounts, chunkErrorCounts] = await Promise.all([
      SearchDocument.aggregate([
        { $match: { indexId, tenantId } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      SearchChunk.aggregate([
        { $match: { indexId, tenantId, status: 'error' } },
        { $group: { _id: '$documentId', errorCount: { $sum: 1 } } },
        { $count: 'docsWithChunkErrors' },
      ]),
    ]);

    res.json({
      documentStatuses: docStatusCounts,
      docsWithChunkErrors: chunkErrorCounts[0]?.docsWithChunkErrors ?? 0,
    });
  } catch (error) {
    logger.error('Failed to get document status summary', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to get document status summary' });
  }
});

// ---------------------------------------------------------------------------
// GET single document detail (content preview)
// ---------------------------------------------------------------------------

router.get('/:indexId/documents/:documentId', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const tenantId = req.tenantContext.tenantId;

    const { indexId, documentId } = req.params;

    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext),
    ).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    const document = await SearchDocument.findOne({ _id: documentId, indexId, tenantId }).lean();
    if (!document) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }

    // Get chunks for this document (paginated — max 200 per request).
    // chunkCount is the real total from countDocuments, not the page size.
    const chunkLimit = Math.min(parseInt(req.query.limit as string) || 200, 200);
    const chunkOffset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    const [chunks, chunkCount] = await Promise.all([
      SearchChunk.find({ documentId, tenantId })
        .sort({ chunkIndex: 1 })
        .select('_id content position status metadata chunkIndex tokenCount')
        .skip(chunkOffset)
        .limit(chunkLimit)
        .lean(),
      SearchChunk.countDocuments({ documentId, tenantId }),
    ]);

    res.json({
      document: {
        _id: document._id,
        title: (document as any).sourceMetadata?.readability?.title || document.originalReference,
        url: document.originalReference,
        status: document.status,
        contentType: document.contentType,
        contentSizeBytes: document.contentSizeBytes,
        extractedText: document.extractedText
          ? document.extractedText.substring(0, 50000) // Cap at 50KB
          : null,
        extractedTextTruncated: document.extractedText
          ? document.extractedText.length > 50000
          : false,
        sourceMetadata: document.sourceMetadata,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
      },
      chunks: chunks.map((c: any) => ({
        _id: c._id,
        content: c.content,
        position: c.position,
        chunkIndex: c.chunkIndex,
        tokenCount: c.tokenCount,
        status: c.status,
      })),
      chunkCount,
      pagination: {
        total: chunkCount,
        limit: chunkLimit,
        offset: chunkOffset,
        hasMore: chunkOffset + chunks.length < chunkCount,
      },
    });
  } catch (error) {
    logger.error('Failed to get document', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to get document' });
  }
});

// ---------------------------------------------------------------------------
// DELETE single document (cascade: chunks → document → index counters)
// ---------------------------------------------------------------------------

router.delete('/:indexId/documents/:documentId', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const tenantId = req.tenantContext.tenantId;

    const { indexId, documentId } = req.params;

    // Verify index ownership
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext),
    ).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    // Verify document exists
    const document = await SearchDocument.findOne({ _id: documentId, indexId, tenantId }).lean();
    if (!document) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }

    // Delete vectors from vector store with retry before MongoDB cleanup.
    // Vectors MUST be deleted first — if MongoDB deletes succeed but vector
    // store fails, orphaned vectors remain in search results permanently.
    const chunks = await SearchChunk.find({ documentId, tenantId })
      .select('_id chunkType metadata')
      .lean();
    const chunkIds = chunks.map((c) => String(c._id));
    const chunkCount = chunkIds.length;

    // Fetch question IDs for cascade deletion
    const questions = await ChunkQuestion.find({ documentId, tenantId }).select('_id').lean();
    const questionIds = questions.map((q) => String(q._id));

    // Combine chunk IDs and question IDs for vector deletion
    const allVectorIds = [...chunkIds, ...questionIds];

    if (allVectorIds.length > 0) {
      const vectorStore: VectorStoreProvider = createVectorStore({
        provider:
          (process.env.VECTOR_STORE_PROVIDER as
            | 'opensearch'
            | 'qdrant'
            | 'pinecone'
            | 'pgvector') || 'opensearch',
        url: process.env.VECTOR_STORE_URL || 'http://localhost:9200',
        apiKey: process.env.VECTOR_STORE_API_KEY,
      });
      const vsIndexName = await resolveIndexForWrite(
        vectorStore,
        tenantId,
        indexId,
        document.sourceId,
      );

      // Retry vector deletion up to 3 times before giving up
      let vectorDeleteSuccess = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await vectorStore.delete(vsIndexName, allVectorIds);
          vectorDeleteSuccess = true;
          logger.info('Deleted vectors from vector store', {
            documentId,
            chunkCount: chunkIds.length,
            questionCount: questionIds.length,
            totalVectors: allVectorIds.length,
          });
          break;
        } catch (err) {
          logger.warn('Vector store delete attempt failed', {
            attempt,
            error: err instanceof Error ? err.message : String(err),
            documentId,
            chunkCount: chunkIds.length,
            questionCount: questionIds.length,
          });
          if (attempt < 3) {
            await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
          }
        }
      }

      if (!vectorDeleteSuccess) {
        // Mark document as delete-pending so a background job can retry later
        await SearchDocument.findOneAndUpdate(
          { _id: documentId, tenantId },
          {
            $set: {
              status: 'delete-pending',
              processingError: 'Vector store cleanup failed after 3 retries',
            },
          },
        );
        logger.error(
          'Vector store cleanup failed after 3 retries — document marked as delete-pending',
          {
            documentId,
            indexId,
            chunkIds: chunkIds.slice(0, 5),
            questionIds: questionIds.slice(0, 5),
          },
        );
        res.status(503).json({
          error: 'Vector store cleanup failed. Document marked for background deletion.',
        });
        return;
      }
    }

    // Cascade delete: questions → chunks → document → update index counters
    await ChunkQuestion.deleteMany({ documentId, tenantId });
    await SearchChunk.deleteMany({ documentId, tenantId });
    await SearchDocument.deleteOne({ _id: documentId, tenantId });

    // ── Structured data cleanup (ClickHouse) ────────────────────────────
    // If this document had a table_metadata chunk, clean up ClickHouse data
    // and check if the index still has any structured data documents left.
    const deletedChunkWasStructured = chunks.some(
      (c: any) => c.chunkType === 'table_metadata' || c.metadata?.tableId,
    );

    if (deletedChunkWasStructured) {
      try {
        // Find the tableId from chunk metadata
        const structuredChunk = chunks.find(
          (c: any) => c.chunkType === 'table_metadata' || c.metadata?.tableId,
        );
        const tableId = (structuredChunk as any)?.metadata?.tableId;

        if (tableId) {
          const chClient = new StructuredDataClickHouseClient();
          await chClient.deleteTable(tenantId, indexId, tableId);
          logger.info('Cleaned up ClickHouse structured data for deleted document', {
            documentId,
            tableId,
            indexId,
          });
        }

        // Check if any other table_metadata chunks remain in this index
        const remainingStructuredChunks = await SearchChunk.countDocuments({
          indexId,
          tenantId,
          chunkType: 'table_metadata',
        });

        if (remainingStructuredChunks === 0) {
          await SearchIndex.updateOne(
            applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext),
            { $set: { hasStructuredData: false } },
          );
          logger.info('Reset hasStructuredData flag — no structured data remains', {
            indexId,
            tenantId,
          });
        }
      } catch (chErr) {
        // Best-effort — don't fail the delete if ClickHouse cleanup fails
        logger.warn('ClickHouse structured data cleanup failed (best-effort)', {
          error: chErr instanceof Error ? chErr.message : String(chErr),
          documentId,
          indexId,
        });
      }
    }

    const updates: Promise<any>[] = [
      SearchIndex.findOneAndUpdate(
        applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext),
        { $inc: { documentCount: -1, chunkCount: -chunkCount } },
      ),
      KnowledgeBase.findOneAndUpdate(
        { searchIndexId: indexId, tenantId },
        { $inc: { documentCount: -1 } },
      ),
    ];

    // Decrement source count if document had a source
    if (document.sourceId) {
      updates.push(
        SearchSource.findOneAndUpdate(
          { _id: document.sourceId, tenantId },
          { $inc: { documentCount: -1 } },
        ),
      );
    }

    await Promise.all(updates);

    // ── Field & Vocabulary cleanup when last document is deleted ─────────
    try {
      const updatedIndex = await SearchIndex.findOne(
        applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext),
      )
        .select('documentCount')
        .lean();
      const remainingDocs = (updatedIndex as any)?.documentCount ?? 0;

      if (remainingDocs <= 0) {
        const { cleanupAllFieldsAndVocab } =
          await import('../services/document-cleanup.service.js');
        await cleanupAllFieldsAndVocab(tenantId, indexId);
      }
    } catch (cleanupErr) {
      // Non-fatal — document is already deleted
      logger.warn('Field/vocab cleanup failed after document deletion', {
        error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        documentId,
        indexId,
      });
    }

    res.status(204).send();
  } catch (error) {
    logger.error('Failed to delete document', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

export default router;

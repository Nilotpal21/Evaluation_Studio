/**
 * Chunks Routes
 *
 * GET /:indexId/documents/:documentId/chunks - List chunks for a document
 * GET /:indexId/chunks                       - List all chunks for an index
 * GET /:indexId/chunks/:chunkId              - Get a specific chunk
 *
 * All routes require authentication and enforce tenant isolation.
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { createLogger } from '@abl/compiler/platform';
import type { ISearchChunk, ISearchDocument, ISearchIndex } from '@agent-platform/database';
import { getLazyModel } from '../db/index.js';
import { applyProjectScopeFilter } from './project-scope.js';

const router: RouterType = Router();
const logger = createLogger('chunks-routes');

const ALLOWED_SORT_FIELDS = new Set([
  'chunkIndex',
  'tokenCount',
  'createdAt',
  'updatedAt',
  'status',
]);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function canReadIndex(req: Request, indexId: string, tenantId: string): Promise<boolean> {
  const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');
  const index = await SearchIndex.findOne(
    applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
  )
    .select('_id')
    .lean();
  return Boolean(index);
}

/**
 * GET /:indexId/documents/:documentId/chunks
 *
 * List all chunks for a document with pagination.
 *
 * Query params:
 *   - limit: Max chunks to return (default: 50, max: 200)
 *   - offset: Number of chunks to skip (default: 0)
 *   - includeContent: Include full content (default: true)
 */
router.get('/:indexId/documents/:documentId/chunks', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }

    const { indexId, documentId } = req.params;
    const tenantId = req.tenantContext.tenantId;

    if (!(await canReadIndex(req, indexId, tenantId))) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    // Parse query params
    const limit = Math.max(0, Math.min(parseInt(req.query.limit as string) || 50, 200));
    const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
    const includeContent = req.query.includeContent !== 'false';
    const status = req.query.status as string | undefined;

    // Build projection (exclude content if not requested)
    const projection = includeContent ? {} : { content: 0 };

    // Use getModel() to access the content-DB-bound model (not the default connection)
    const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk');

    // Build filter with tenant isolation
    const filter: Record<string, unknown> = { indexId, documentId, tenantId };

    // Add status filter (comma-separated support)
    if (status) {
      const statuses = (status as string)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
    }

    // Query with tenant isolation
    const [chunks, totalCount] = await Promise.all([
      SearchChunk.find(filter, projection).sort({ chunkIndex: 1 }).skip(offset).limit(limit).lean(),
      SearchChunk.countDocuments(filter),
    ]);

    res.json({
      chunks: chunks.map((chunk) => ({
        id: chunk._id,
        chunkIndex: chunk.chunkIndex,
        content: includeContent ? chunk.content : undefined,
        tokenCount: chunk.tokenCount,
        metadata: chunk.metadata,
        canonicalMetadata: chunk.canonicalMetadata,
        status: chunk.status,
        createdAt: chunk.createdAt,
        updatedAt: chunk.updatedAt,
      })),
      pagination: {
        total: totalCount,
        limit,
        offset,
        hasMore: offset + chunks.length < totalCount,
      },
    });
  } catch (error) {
    logger.error('List chunks failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to list chunks' });
  }
});

/**
 * GET /:indexId/chunks
 *
 * List all chunks for an index across all documents with pagination.
 *
 * Query params:
 *   - limit: Max chunks to return (default: 20, max: 200)
 *   - offset: Number of chunks to skip (default: 0)
 *   - status: Comma-separated status filter (e.g., "error,pending")
 *   - sourceId: Filter by source (resolves documents for that source)
 *   - documentId: Filter by specific document
 *   - search: Search within chunk content ($regex)
 *   - minTokens: Minimum token count
 *   - maxTokens: Maximum token count
 *   - sort: Sort field (default: "chunkIndex")
 *   - order: Sort direction "asc" | "desc" (default: "asc")
 *   - includeContent: Include full content (default: true)
 */
router.get('/:indexId/chunks', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }

    const { indexId } = req.params;
    const tenantId = req.tenantContext.tenantId;

    if (!(await canReadIndex(req, indexId, tenantId))) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    // Parse query params — max 200 to match per-document chunks endpoint
    const limit = Math.max(0, Math.min(parseInt(req.query.limit as string) || 20, 200));
    const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
    const includeContent = req.query.includeContent !== 'false';
    const status = req.query.status as string | undefined;
    const sourceId = req.query.sourceId as string | undefined;
    const documentId = req.query.documentId as string | undefined;
    const search = req.query.search as string | undefined;
    const minTokens = req.query.minTokens as string | undefined;
    const maxTokens = req.query.maxTokens as string | undefined;
    const rawSort = (req.query.sort as string) || 'chunkIndex';
    const sort = ALLOWED_SORT_FIELDS.has(rawSort) ? rawSort : 'chunkIndex';
    const order = (req.query.order as string) === 'desc' ? -1 : 1;

    const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk');
    const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument');

    // Build filter with tenant isolation
    const filter: Record<string, unknown> = { indexId, tenantId };

    // Status filter (comma-separated)
    if (status) {
      const statuses = status
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
    }

    // Document ID filter
    if (documentId) {
      filter.documentId = documentId;
    }

    // Source ID filter: resolve to document IDs first
    if (sourceId && !documentId) {
      const docs = await SearchDocument.find({ indexId, tenantId, sourceId }, { _id: 1 }).lean();
      const docIds = docs.map((d) => d._id);
      if (docIds.length === 0) {
        // No documents for this source — return empty
        res.json({
          chunks: [],
          pagination: { total: 0, limit, offset, hasMore: false },
        });
        return;
      }
      filter.documentId = { $in: docIds };
    }

    // Content search filter (escape user input to prevent ReDoS)
    if (search) {
      filter.content = { $regex: escapeRegex(search), $options: 'i' };
    }

    // Token count range filter
    if (minTokens !== undefined || maxTokens !== undefined) {
      const tokenFilter: Record<string, number> = {};
      if (minTokens !== undefined) {
        const min = parseInt(minTokens, 10);
        if (!isNaN(min)) tokenFilter.$gte = min;
      }
      if (maxTokens !== undefined) {
        const max = parseInt(maxTokens, 10);
        if (!isNaN(max)) tokenFilter.$lte = max;
      }
      if (Object.keys(tokenFilter).length > 0) {
        filter.tokenCount = tokenFilter;
      }
    }

    // Build projection (exclude content if not requested)
    const projection = includeContent ? {} : { content: 0 };

    // Build sort object
    const sortObj: Record<string, 1 | -1> = { [sort]: order as 1 | -1 };

    // Query with pagination + status counts (all in parallel)
    // Status counts use the base filter WITHOUT status restriction so they
    // reflect the full index, not just the currently-filtered view.
    const baseFilter: Record<string, unknown> = { indexId, tenantId };
    if (documentId) baseFilter.documentId = documentId;
    if (sourceId && !documentId && filter.documentId) baseFilter.documentId = filter.documentId;
    if (search) baseFilter.content = filter.content;
    if (filter.tokenCount) baseFilter.tokenCount = filter.tokenCount;

    const [chunks, total, statusAgg] = await Promise.all([
      SearchChunk.find(filter, projection).sort(sortObj).skip(offset).limit(limit).lean(),
      SearchChunk.countDocuments(filter),
      SearchChunk.aggregate([
        { $match: baseFilter },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
    ]);

    // Resolve document titles
    const uniqueDocIds = [...new Set(chunks.map((c) => c.documentId))];
    const docMap = new Map<string, string>();
    if (uniqueDocIds.length > 0) {
      const docs = await SearchDocument.find(
        { _id: { $in: uniqueDocIds }, tenantId },
        { _id: 1, name: 1 },
      ).lean();
      for (const doc of docs) {
        docMap.set(doc._id, doc.name ?? 'Untitled');
      }
    }

    // Convert aggregation result to { indexed: 44, pending: 2, ... }
    const statusCounts: Record<string, number> = {};
    for (const row of statusAgg) {
      if (row._id) statusCounts[row._id] = row.count;
    }

    res.json({
      chunks: chunks.map((chunk) => ({
        id: chunk._id,
        chunkIndex: chunk.chunkIndex,
        content: includeContent ? chunk.content : undefined,
        tokenCount: chunk.tokenCount,
        status: chunk.status,
        metadata: chunk.metadata,
        canonicalMetadata: chunk.canonicalMetadata,
        documentId: chunk.documentId,
        documentTitle: docMap.get(chunk.documentId) ?? 'Untitled',
        createdAt: chunk.createdAt,
        updatedAt: chunk.updatedAt,
      })),
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + chunks.length < total,
      },
      statusCounts,
    });
  } catch (error) {
    logger.error('List all chunks failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to list chunks' });
  }
});

/**
 * GET /:indexId/chunks/:chunkId
 *
 * Get a specific chunk by ID.
 */
router.get('/:indexId/chunks/:chunkId', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }

    const { indexId, chunkId } = req.params;
    const tenantId = req.tenantContext.tenantId;

    if (!(await canReadIndex(req, indexId, tenantId))) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk');

    // Query with tenant isolation
    const chunk = await SearchChunk.findOne({ _id: chunkId, indexId, tenantId }).lean();

    if (!chunk) {
      res.status(404).json({ error: 'Chunk not found' });
      return;
    }

    res.json({
      id: chunk._id,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      tokenCount: chunk.tokenCount,
      metadata: chunk.metadata,
      canonicalMetadata: chunk.canonicalMetadata,
      status: chunk.status,
      createdAt: chunk.createdAt,
      updatedAt: chunk.updatedAt,
    });
  } catch (error) {
    logger.error('Get chunk failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to get chunk' });
  }
});

export default router;

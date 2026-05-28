/**
 * @deprecated V2: Go crawler replaced by Node.js bulk-crawl worker.
 * This route remains for draining in-flight Go jobs and external integrations.
 *
 * Crawler Ingestion Routes
 *
 * POST /ingest/crawled-content - Ingest HTML content from web crawler
 * GET /ingest/status/:documentId - Get ingestion status
 *
 * Architecture:
 * 1. Receive HTML content from external crawler integrations
 * 2. Delegate to CrawlerIngestionService (shared with worker)
 * 3. Service handles: Readability → S3 upload → SearchDocument → Docling queue
 *
 * Note: This HTTP endpoint is for EXTERNAL integrations only.
 * Our internal crawler worker uses direct access (no HTTP roundtrip).
 *
 * Benefits:
 * - Readability removes noise (ads, navigation, footers)
 * - Adaptive chunking (sentence-aligned + semantic)
 * - Automatic table extraction
 * - Layout and structure preservation
 * - Progressive summarization with context
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { ISearchDocument } from '@agent-platform/database/models';
import { DocumentStatus } from '@agent-platform/search-ai-sdk';
import { getLazyModel } from '../db/index.js';

const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument');
import { crawlerIngestionService } from '../services/ingestion/crawler-ingestion.js';
import { createLogger } from '@abl/compiler/platform';

const router: RouterType = Router();
const logger = createLogger('crawler-ingestion');

// ─── Request Validation ─────────────────────────────────────────────────────

const CrawledContentSchema = z.object({
  indexId: z.string().min(1, 'Index ID required'),
  sourceId: z.string().min(1, 'Source ID required'),
  url: z.string().url('Valid URL required'),
  htmlContent: z.string().min(1, 'HTML content required'),
  metadata: z
    .object({
      crawledAt: z.string().datetime().optional(),
      domain: z.string().optional(),
      siteType: z.enum(['static', 'spa', 'hybrid', 'unknown']).optional(),
      profileConfidence: z.number().min(0).max(100).optional(),
      jsRequired: z.boolean().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      language: z.string().optional(),
    })
    .passthrough() // Allow additional fields
    .optional(),
  force: z.boolean().optional().default(false),
});

type CrawledContentRequest = z.infer<typeof CrawledContentSchema>;

/**
 * POST /ingest/crawled-content
 *
 * Ingest HTML content from web crawler into the search pipeline.
 *
 * Body (JSON):
 *   - indexId: Knowledge base index ID (required)
 *   - sourceId: Search source ID (required)
 *   - url: Original URL that was crawled (required)
 *   - htmlContent: Raw HTML content (required, will be cleaned with Readability)
 *   - metadata: Crawler metadata (optional)
 *   - force: Replace existing document with same URL (optional, default: false)
 *
 * Response:
 *   - 201: Document created and extraction job enqueued
 *   - 200: Duplicate document exists (use force=true to replace)
 *   - 400: Invalid request
 *   - 401: Unauthorized
 *   - 404: Index or source not found
 *   - 500: Internal server error
 */
router.post('/ingest/crawled-content', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Verify tenant context
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }

    const tenantId = req.tenantContext.tenantId;

    // Validate request body
    const parseResult = CrawledContentSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: 'Invalid request',
        details: parseResult.error.format(),
      });
      return;
    }

    const { indexId, sourceId, url, htmlContent, metadata, force } = parseResult.data;

    // Delegate to shared ingestion service (handles Readability, S3, MongoDB, BullMQ)
    const result = await crawlerIngestionService.ingestCrawledContent({
      indexId,
      sourceId,
      url,
      htmlContent,
      tenantId,
      metadata,
      force,
    });

    // Handle response based on result
    if (!result.success) {
      // Check for duplicate
      if (result.error?.code === 'DUPLICATE_CONTENT' && result.duplicate) {
        res.status(200).json({
          message:
            'Document already exists (duplicate URL or content hash). Use force=true to replace.',
          document: result.duplicate,
        });
        return;
      }

      // Check for not found errors
      if (result.error?.code === 'INDEX_NOT_FOUND') {
        res.status(404).json({ error: result.error.message });
        return;
      }

      if (result.error?.code === 'SOURCE_NOT_FOUND') {
        res.status(404).json({ error: result.error.message });
        return;
      }

      // Generic error
      res.status(500).json({
        error: 'Ingestion failed',
        message: result.error?.message || 'Unknown error',
      });
      return;
    }

    // Success
    res.status(201).json({
      id: result.documentId,
      originalReference: result.originalReference,
      contentType: result.contentType,
      contentSizeBytes: result.contentSizeBytes,
      status: result.status,
      metadata: result.metadata,
      createdAt: result.createdAt,
      message: 'Crawled content ingested successfully. Docling extraction pipeline started.',
    });
  } catch (error) {
    logger.error('Ingestion failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
});

/**
 * GET /ingest/status/:documentId
 *
 * Get ingestion status for a crawled document
 *
 * Response:
 *   - 200: Document status with chunk count
 *   - 401: Unauthorized
 *   - 404: Document not found
 *   - 500: Internal server error
 */
router.get('/ingest/status/:documentId', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }

    const { documentId } = req.params;
    const tenantId = req.tenantContext.tenantId;

    // Find document with tenant isolation
    const document = await SearchDocument.findOne({ _id: documentId, tenantId })
      .select('originalReference contentType status sourceMetadata createdAt updatedAt')
      .lean();

    if (!document) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }

    // Get chunk count if document is indexed
    let chunkCount = 0;
    if (document.status === DocumentStatus.INDEXED) {
      const { SearchChunk } = await import('@agent-platform/database');
      chunkCount = await SearchChunk.countDocuments({
        documentId,
        tenantId,
      });
    }

    res.status(200).json({
      id: document._id,
      url: document.originalReference,
      contentType: document.contentType,
      status: document.status,
      chunkCount,
      metadata: document.sourceMetadata,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    });
  } catch (error) {
    logger.error('Status check failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to get document status' });
  }
});

export default router;

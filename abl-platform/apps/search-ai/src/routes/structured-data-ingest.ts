/**
 * Structured Data Ingestion Routes (Two-Phase API)
 *
 * Phase 1: POST /:indexId/ingest/analyze
 * - Parse file and analyze schema WITHOUT creating chunks
 * - Return detected schema with confidence scores
 * - Cache analysis results (1 hour TTL)
 *
 * Phase 2: POST /:indexId/ingest/finalize
 * - Accept approved schema from user (with corrections)
 * - Create async job for ingestion
 * - Return job ID for status polling
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import type { ISearchIndex } from '@agent-platform/database/models';
import { getLazyModel } from '../db/index.js';
import { applyProjectScopeFilter } from './project-scope.js';

const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');
import { StructuredDataSchemaAnalyzer } from '../services/structured-data/schema-analyzer.js';
import { AnalysisCacheService } from '../services/structured-data/analysis-cache.js';
import { StructuredDataClickHouseClient } from '../services/structured-data/clickhouse-client.js';
import type {
  FinalizeRequest,
  FinalizeResponse,
  IngestionJobData,
} from '../services/structured-data/ingestion-types.js';
import { createQueue } from '../workers/shared.js';

const router: RouterType = Router();

// Configure multer for file uploads (store in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max file size
  },
  fileFilter: (_req, file, cb) => {
    const supportedTypes = new Set([
      'text/csv',
      'application/csv',
      'application/json',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
      'application/vnd.ms-excel', // .xls
    ]);

    if (supportedTypes.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          `Unsupported file type: ${file.mimetype}. Supported: CSV, JSON, Excel (.xlsx, .xls)`,
        ),
      );
    }
  },
});

// Queue name for structured data ingestion jobs
const QUEUE_STRUCTURED_INGESTION = 'structured-data-ingestion';

/**
 * POST /:indexId/ingest/analyze
 *
 * Phase 1: Analyze structured data file and return detected schema.
 *
 * Body (multipart/form-data):
 *   - file: Structured data file (CSV, JSON, Excel) [required]
 *   - metadata: JSON metadata [optional]
 *
 * Response:
 *   - analysisId: Cache ID for finalize phase
 *   - schema: Detected schema with confidence scores
 *   - estimates: Cost and performance estimates
 *   - quality: Quality metrics and recommendations
 */
router.post(
  '/:indexId/ingest/analyze',
  upload.single('file') as any,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.tenantContext) {
        res.status(401).json({ error: 'Tenant context required' });
        return;
      }

      const { indexId } = req.params;
      const tenantId = req.tenantContext.tenantId;

      // Validate file uploaded
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }

      // Verify index exists AND belongs to tenant (tenant isolation)
      const index = await SearchIndex.findOne(
        applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
      ).lean();
      if (!index) {
        res.status(404).json({ error: 'Index not found' });
        return;
      }

      console.log('[structured-data-ingest] Analyzing file:', {
        indexId,
        tenantId,
        filename: req.file.originalname,
        size: req.file.size,
        mimeType: req.file.mimetype,
      });

      // Analyze schema
      const analyzer = new StructuredDataSchemaAnalyzer();
      const analysis = await analyzer.analyze(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
      );

      console.log('[structured-data-ingest] Schema analysis complete:', {
        analysisId: analysis.analysisId,
        rowCount: analysis.schema.rowCount,
        columnCount: analysis.schema.columns.length,
        embeddingTokens: analysis.estimates.embeddingTokens,
      });

      // Cache analysis with file data (1 hour TTL)
      const cacheService = new AnalysisCacheService();
      await cacheService.set(
        analysis.analysisId,
        tenantId,
        indexId,
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
        req.file.size,
        analysis,
      );

      res.status(200).json(analysis);
    } catch (error) {
      console.error('[structured-data-ingest] Analysis failed:', error);
      next(error);
    }
  },
);

/**
 * POST /:indexId/ingest/finalize
 *
 * Phase 2: Finalize ingestion with user-approved schema.
 *
 * Body (JSON):
 *   - analysisId: Cache ID from analyze phase [required]
 *   - schema: User-approved schema with corrections [required]
 *   - metadata: Additional metadata [optional]
 *
 * Response:
 *   - jobId: Job ID for status polling
 *   - status: Initial job status
 *   - tableId: Created table ID
 */
router.post(
  '/:indexId/ingest/finalize',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.tenantContext) {
        res.status(401).json({ error: 'Tenant context required' });
        return;
      }

      const { indexId } = req.params;
      const tenantId = req.tenantContext.tenantId;

      // Validate request body
      const { analysisId, schema, metadata } = req.body as FinalizeRequest;

      if (!analysisId) {
        res.status(400).json({ error: 'analysisId is required' });
        return;
      }

      if (!schema || !schema.tableName || !schema.columns) {
        res.status(400).json({
          error: 'schema is required with tableName and columns',
        });
        return;
      }

      // Verify index exists AND belongs to tenant
      const index = await SearchIndex.findOne(
        applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
      ).lean();
      if (!index) {
        res.status(404).json({ error: 'Index not found' });
        return;
      }

      // Retrieve cached analysis
      const cacheService = new AnalysisCacheService();
      const cached = await cacheService.get(analysisId);

      if (!cached) {
        res.status(404).json({
          error: 'Analysis not found or expired. Please re-run analyze phase.',
        });
        return;
      }

      // Verify tenant/index match (security)
      if (cached.tenantId !== tenantId || cached.indexId !== indexId) {
        res.status(403).json({ error: 'Analysis does not belong to this tenant/index' });
        return;
      }

      console.log('[structured-data-ingest] Finalizing ingestion:', {
        analysisId,
        indexId,
        tenantId,
        tableName: schema.tableName,
        rowCount: cached.analysis.schema.rowCount,
      });

      // Generate table ID
      const tableId = uuidv4();

      // Create table in ClickHouse
      const chClient = new StructuredDataClickHouseClient();
      await chClient.initialize();
      await chClient.createDataTable(tenantId, indexId, tableId);

      console.log('[structured-data-ingest] ClickHouse table created:', { tableId });

      // Create ingestion job data
      const jobData: IngestionJobData = {
        tenantId,
        indexId,
        documentId: tableId, // No SearchDocument for finalize flow, use tableId
        tableId,
        tableName: schema.tableName,
        displayName: schema.displayName || schema.tableName,
        description: schema.description || '',
        columns: schema.columns,
        primaryKey: schema.primaryKey,
        fileBuffer: cached.fileBuffer,
        originalFilename: cached.originalFilename,
        mimeType: cached.mimeType,
        fileSize: cached.fileSize,
        metadata: metadata || {},
        createdAt: new Date(),
      };

      // Enqueue ingestion job
      const jobId = `structured-ingest:${tableId}`;
      const queue = createQueue(QUEUE_STRUCTURED_INGESTION);

      try {
        await queue.add(jobId, jobData, {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
        });

        console.log('[structured-data-ingest] Ingestion job enqueued:', { jobId, tableId });
      } finally {
        await queue.close();
      }

      // Delete cached analysis (no longer needed)
      await cacheService.delete(analysisId);

      // Estimate completion time (rough: 100 rows/second)
      const estimatedCompletionSeconds = Math.ceil(cached.analysis.schema.rowCount / 100);

      const response: FinalizeResponse = {
        jobId,
        status: 'pending',
        tableId,
        createdAt: new Date(),
        estimatedCompletionSeconds,
      };

      res.status(201).json(response);
    } catch (error) {
      console.error('[structured-data-ingest] Finalize failed:', error);
      next(error);
    }
  },
);

/**
 * GET /:indexId/ingest/jobs/:jobId
 *
 * Get ingestion job status.
 */
router.get('/:indexId/ingest/jobs/:jobId', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }

    const { indexId, jobId } = req.params;
    const tenantId = req.tenantContext.tenantId;

    // Verify index exists
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    // Get job status from BullMQ
    const queue = createQueue(QUEUE_STRUCTURED_INGESTION);

    try {
      const job = await queue.getJob(jobId);

      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }

      // Map BullMQ state to our status
      const state = await job.getState();
      const status =
        state === 'completed'
          ? 'completed'
          : state === 'failed'
            ? 'failed'
            : state === 'active'
              ? 'processing'
              : 'pending';

      res.json({
        jobId: job.id,
        status,
        progress: job.progress || 0,
        createdAt: new Date(job.timestamp),
        processedAt: job.processedOn ? new Date(job.processedOn) : null,
        finishedAt: job.finishedOn ? new Date(job.finishedOn) : null,
        failedReason: job.failedReason,
        data: job.data,
      });
    } finally {
      await queue.close();
    }
  } catch (error) {
    console.error('[structured-data-ingest] Get job status failed:', error);
    res.status(500).json({ error: 'Failed to get job status' });
  }
});

export default router;

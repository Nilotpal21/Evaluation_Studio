/**
 * Knowledge Graph Enrichment Routes
 *
 * API endpoints for triggering and monitoring KG enrichment jobs.
 *
 * POST   /:indexId/kg-enrich              - Trigger enrichment for an index
 * GET    /:indexId/kg-enrich/jobs/:jobId  - Get job status
 * GET    /:indexId/kg-enrich/jobs         - List enrichment jobs for index
 * GET    /:indexId/kg-enrich/stats        - Get KG statistics
 * GET    /:indexId/kg-enrich/documents    - Get classified documents with pagination
 * GET    /:indexId/kg-enrich/entities     - Get entity distribution
 * GET    /:indexId/kg-enrich/graph        - Get graph structure for visualization
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { createQueue } from '../workers/shared.js';
import type { KGEnrichmentJobData } from '../workers/shared.js';
import { getTaxonomyGraphService } from '../services/knowledge-graph/taxonomy-graph.service.js';
import { createLogger } from '@abl/compiler/platform';

import { getLazyModel } from '../db/index.js';
import { applyProjectScopeFilter } from './project-scope.js';
import type {
  ISearchIndex,
  ISearchDocument,
  ISearchChunk,
  IKnowledgeGraphTaxonomy,
} from '@agent-platform/database/models';

// Models bound to correct databases (platform vs content)
const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex'); // → abl_platform
const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument'); // → search_ai
const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk'); // → search_ai
const KnowledgeGraphTaxonomy = getLazyModel<IKnowledgeGraphTaxonomy>('KnowledgeGraphTaxonomy'); // → search_ai
const router: RouterType = Router();
const log = createLogger('kg-enrichment');

// Queue name for KG enrichment jobs
const QUEUE_KG_ENRICHMENT = 'kg-enrichment';

/**
 * POST /:indexId/kg-enrich
 *
 * Trigger KG enrichment for an entire index. Processes all documents with
 * summaries, classifies them by product scope, and extracts scoped entities.
 *
 * Body (JSON):
 *   - priority: 'low' | 'normal' | 'high' [optional, default: 'normal']
 *   - options:
 *       - batchSize: number [optional, default: 50]
 *       - retrySkipped: boolean [optional, default: false]
 *       - forceReclassify: boolean [optional, default: false] - Re-process ALL documents
 *   - filter:
 *       - uploadedAfter: ISO date string [optional]
 *
 * Response:
 *   - jobId: Job ID for status polling
 *   - status: 'QUEUED'
 *   - estimatedDocuments: Number of documents to process
 *   - taxonomyVersion: Taxonomy version being used
 *   - pollUrl: URL to poll for status
 */
router.post('/:indexId/kg-enrich', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Tenant context required' },
      });
      return;
    }

    const { indexId } = req.params;
    const tenantId = req.tenantContext.tenantId;
    const { priority, options, filter } = req.body;

    // Verify index exists AND belongs to tenant (tenant isolation)
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'Index not found' } });
      return;
    }

    // Check if taxonomy exists for this index
    const taxonomy = await KnowledgeGraphTaxonomy.findOne({ tenantId, indexId }).lean();
    if (!taxonomy) {
      res.status(400).json({
        success: false,
        error: {
          code: 'NO_TAXONOMY',
          message: 'No taxonomy configured for this index',
        },
      });
      return;
    }

    // Count documents to process
    // KG classification requires an LLM summary — matches kg-enrichment-worker query filter
    const summaryFilter = { 'metadata.documentSummary': { $ne: null } };

    const docQuery: any = {
      tenantId,
      indexId,
    };

    // Apply filters
    if (filter?.uploadedAfter) {
      docQuery.createdAt = { $gte: new Date(filter.uploadedAfter) };
    }

    // Filter by KG state (unless forceReclassify is true)
    if (!options?.forceReclassify) {
      const statusFilter: string[] = ['NOT_ENRICHED'];
      if (options?.retrySkipped) {
        statusFilter.push('SKIPPED');
      }

      // Combine summary filter + kgState filter with $and
      // (avoids two $or at the same level — matches kg-enrichment-worker.ts:204-218)
      docQuery.$and = [
        summaryFilter,
        {
          $or: [
            { 'metadata.kgState.status': { $in: statusFilter } },
            { 'metadata.kgState': { $exists: false } },
          ],
        },
      ];
    } else {
      // forceReclassify: process ALL documents with summaries (no status filter)
      docQuery.$and = [summaryFilter];
    }

    const estimatedDocuments = await SearchDocument.countDocuments(docQuery);

    if (estimatedDocuments === 0) {
      res.status(200).json({
        message: 'No documents to process',
        estimatedDocuments: 0,
        reason: 'All documents are already enriched or do not have summaries',
      });
      return;
    }

    // Create job data
    const jobData: KGEnrichmentJobData = {
      indexId,
      tenantId,
      filter,
      options: {
        batchSize: options?.batchSize || 50,
        parallelBatches: options?.parallelBatches,
        retrySkipped: options?.retrySkipped || false,
        forceReclassify: options?.forceReclassify || false,
      },
      priority: priority || 'normal',
    };

    // Enqueue enrichment job
    const jobId = `kg-enrich:${indexId}:${Date.now()}`;
    const queue = createQueue(QUEUE_KG_ENRICHMENT);

    try {
      await queue.add(jobId, jobData, {
        jobId,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        priority: priority === 'high' ? 1 : priority === 'low' ? 10 : 5,
      });

      log.info('Enrichment job enqueued', {
        jobId,
        indexId,
        tenantId,
        estimatedDocuments,
      });
    } finally {
      await queue.close();
    }

    // Estimate completion time (rough: 2 seconds per document)
    const estimatedDurationMinutes = Math.ceil((estimatedDocuments * 2) / 60);

    res.status(201).json({
      success: true,
      jobId,
      status: 'QUEUED',
      indexId,
      taxonomyVersion: taxonomy.version,
      statistics: {
        estimatedDocuments,
        estimatedDurationMinutes,
      },
      pollUrl: `/api/indexes/${indexId}/kg-enrich/jobs/${jobId}`,
      createdAt: new Date(),
    });
  } catch (error) {
    log.error('Failed to trigger enrichment', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'KG_ENRICHMENT_FAILED', message: 'Failed to trigger enrichment' },
    });
  }
});

/**
 * GET /:indexId/kg-enrich/jobs/:jobId
 *
 * Get KG enrichment job status.
 *
 * Response:
 *   - jobId: Job ID
 *   - status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'SKIPPED'
 *   - progress: Progress percentage (0-100)
 *   - statistics: Processing statistics
 *   - createdAt: Job creation timestamp
 *   - startedAt: Job start timestamp (if processing)
 *   - completedAt: Job completion timestamp (if completed)
 *   - error: Error message (if failed)
 */
router.get('/:indexId/kg-enrich/jobs/:jobId', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Tenant context required' },
      });
      return;
    }

    const { indexId, jobId } = req.params;
    const tenantId = req.tenantContext.tenantId;

    // Verify index exists AND belongs to tenant
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'Index not found' } });
      return;
    }

    // Get job status from BullMQ
    const queue = createQueue(QUEUE_KG_ENRICHMENT);

    try {
      const job = await queue.getJob(jobId);

      if (!job) {
        res
          .status(404)
          .json({ success: false, error: { code: 'NOT_FOUND', message: 'Job not found' } });
        return;
      }

      // Verify job belongs to this tenant/index (security)
      const jobData = job.data as KGEnrichmentJobData;
      if (jobData.tenantId !== tenantId || jobData.indexId !== indexId) {
        res
          .status(404)
          .json({ success: false, error: { code: 'NOT_FOUND', message: 'Job not found' } });
        return;
      }

      // Map BullMQ state to our status
      const state = await job.getState();
      const bullmqStatus =
        state === 'completed'
          ? 'COMPLETED'
          : state === 'failed'
            ? 'FAILED'
            : state === 'active'
              ? 'PROCESSING'
              : 'QUEUED';

      // Check if job result indicates SKIPPED
      const returnValue = job.returnvalue;
      const status =
        bullmqStatus === 'COMPLETED' && returnValue?.status === 'SKIPPED'
          ? 'SKIPPED'
          : bullmqStatus;

      const response: any = {
        jobId: job.id,
        status,
        progress: typeof job.progress === 'number' ? job.progress : 0,
        createdAt: new Date(job.timestamp),
        processedAt: job.processedOn ? new Date(job.processedOn) : null,
        finishedAt: job.finishedOn ? new Date(job.finishedOn) : null,
      };

      // Add statistics if available
      if (returnValue?.stats) {
        response.statistics = returnValue.stats;
      }

      // Add skip reason if SKIPPED
      if (status === 'SKIPPED' && returnValue?.reason) {
        response.reason = returnValue.reason;
        response.message = returnValue.message;
        if (returnValue.nextSteps) {
          response.nextSteps = returnValue.nextSteps;
        }
      }

      // Add documents processed count
      if (returnValue?.documentsProcessed !== undefined) {
        response.documentsProcessed = returnValue.documentsProcessed;
      }

      // Add error if failed. Stack traces are kept server-side only (BullMQ
      // retains job.stacktrace in Redis); leaking them to API callers exposes
      // internal file paths and module structure.
      if (status === 'FAILED') {
        response.error = job.failedReason || 'Unknown error';
      }

      // Calculate estimated completion time if processing
      if (status === 'PROCESSING' && typeof job.progress === 'number' && job.progress > 0) {
        const elapsedMs = Date.now() - (job.processedOn || job.timestamp);
        const estimatedTotalMs = (elapsedMs / job.progress) * 100;
        const estimatedRemainingMs = estimatedTotalMs - elapsedMs;
        response.estimatedCompletionAt = new Date(Date.now() + estimatedRemainingMs);
      }

      res.json(response);
    } finally {
      await queue.close();
    }
  } catch (error) {
    log.error('Failed to get job status', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'KG_JOB_STATUS_FAILED', message: 'Failed to get job status' },
    });
  }
});

/**
 * GET /:indexId/kg-enrich/jobs
 *
 * List KG enrichment jobs for an index.
 *
 * Query params:
 *   - status: Filter by status [optional]
 *   - limit: Max jobs to return [optional, default: 50]
 *
 * Response:
 *   - jobs: Array of job summaries
 *   - total: Total count
 */
router.get('/:indexId/kg-enrich/jobs', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Tenant context required' },
      });
      return;
    }

    const { indexId } = req.params;
    const tenantId = req.tenantContext.tenantId;
    const { status, limit = '50' } = req.query;

    // Verify index exists AND belongs to tenant
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'Index not found' } });
      return;
    }

    // Get jobs from BullMQ
    const queue = createQueue(QUEUE_KG_ENRICHMENT);

    try {
      // Get all jobs (could optimize with specific states if needed)
      const [completed, failed, active, waiting] = await Promise.all([
        queue.getCompleted(0, parseInt(limit as string, 10)),
        queue.getFailed(0, parseInt(limit as string, 10)),
        queue.getActive(0, parseInt(limit as string, 10)),
        queue.getWaiting(0, parseInt(limit as string, 10)),
      ]);

      const allJobs = [...completed, ...failed, ...active, ...waiting];

      // Filter by tenant/index
      const filteredJobs = allJobs.filter((job) => {
        const jobData = job.data as KGEnrichmentJobData;
        return jobData.tenantId === tenantId && jobData.indexId === indexId;
      });

      // Map jobs to response format
      const jobSummaries = await Promise.all(
        filteredJobs.map(async (job) => {
          const state = await job.getState();
          const jobStatus =
            state === 'completed'
              ? 'COMPLETED'
              : state === 'failed'
                ? 'FAILED'
                : state === 'active'
                  ? 'PROCESSING'
                  : 'QUEUED';

          return {
            jobId: job.id,
            status: jobStatus,
            progress: job.progress || 0,
            createdAt: new Date(job.timestamp),
            finishedAt: job.finishedOn ? new Date(job.finishedOn) : null,
          };
        }),
      );

      // Filter by status if provided
      let results = jobSummaries;
      if (status) {
        results = jobSummaries.filter((j) => j.status === status);
      }

      // Sort by creation time, newest first
      results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      res.json({
        jobs: results,
        total: results.length,
      });
    } finally {
      await queue.close();
    }
  } catch (error) {
    log.error('Failed to list jobs', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'KG_JOB_LIST_FAILED', message: 'Failed to list jobs' },
    });
  }
});

/**
 * GET /:indexId/kg-enrich/stats
 *
 * Get Knowledge Graph statistics for an index.
 *
 * Response:
 *   - totalDocuments: Total documents in index
 *   - enrichedDocuments: Documents with KG enrichment
 *   - pendingDocuments: Documents pending enrichment
 *   - skippedDocuments: Documents skipped (no summary)
 *   - productsDistribution: Array of { productId, name, count, percentage }
 *   - departmentsDistribution: Array of { department, count, percentage }
 *   - avgConfidence: Average classification confidence
 *   - taxonomyVersion: Current taxonomy version
 */
router.get('/:indexId/kg-enrich/stats', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Tenant context required' },
      });
      return;
    }

    const { indexId } = req.params;
    const tenantId = req.tenantContext.tenantId;

    // Verify index exists AND belongs to tenant
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'Index not found' } });
      return;
    }

    // Get taxonomy
    const taxonomy = await KnowledgeGraphTaxonomy.findOne({ tenantId, indexId }).lean();
    if (!taxonomy) {
      res.status(404).json({
        success: false,
        error: { code: 'NO_TAXONOMY', message: 'No taxonomy configured for this index' },
      });
      return;
    }

    // Count documents by status
    const totalDocuments = await SearchDocument.countDocuments({ tenantId, indexId });
    const enrichedDocuments = await SearchDocument.countDocuments({
      tenantId,
      indexId,
      'metadata.kgState.status': 'ENRICHED',
    });
    const pendingDocuments = await SearchDocument.countDocuments({
      tenantId,
      indexId,
      $or: [
        { 'metadata.kgState.status': 'NOT_ENRICHED' },
        { 'metadata.kgState': { $exists: false } },
      ],
    });
    const skippedDocuments = await SearchDocument.countDocuments({
      tenantId,
      indexId,
      'metadata.kgState.status': 'SKIPPED',
    });

    // Get product distribution using aggregation
    const productDistribution = await SearchDocument.aggregate([
      {
        $match: {
          tenantId,
          indexId,
          'classification.productScope.primaryProduct': { $exists: true },
        },
      },
      {
        $group: {
          _id: '$classification.productScope.primaryProduct',
          count: { $sum: 1 },
          avgConfidence: { $avg: '$classification.productScope.confidence' },
        },
      },
      { $sort: { count: -1 } },
    ]);

    // Get department distribution
    const departmentDistribution = await SearchDocument.aggregate([
      {
        $match: {
          tenantId,
          indexId,
          'classification.department': { $exists: true },
        },
      },
      {
        $group: {
          _id: '$classification.department',
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]);

    // Calculate average confidence
    const avgConfidenceResult = await SearchDocument.aggregate([
      {
        $match: {
          tenantId,
          indexId,
          'classification.productScope.confidence': { $exists: true },
        },
      },
      {
        $group: {
          _id: null,
          avgConfidence: { $avg: '$classification.productScope.confidence' },
        },
      },
    ]);

    // Map product IDs to names from taxonomy
    const productMap = new Map(taxonomy.taxonomy.products.map((p) => [p.id, p.name]));

    const productsDistribution = productDistribution.map((item) => ({
      productId: item._id,
      name: productMap.get(item._id) || item._id,
      count: item.count,
      percentage: enrichedDocuments > 0 ? (item.count / enrichedDocuments) * 100 : 0,
      avgConfidence: item.avgConfidence,
    }));

    const departmentsDistribution = departmentDistribution.map((item) => ({
      department: item._id,
      count: item.count,
      percentage: enrichedDocuments > 0 ? (item.count / enrichedDocuments) * 100 : 0,
    }));

    res.json({
      totalDocuments,
      enrichedDocuments,
      pendingDocuments,
      skippedDocuments,
      productsDistribution,
      departmentsDistribution,
      avgConfidence: avgConfidenceResult[0]?.avgConfidence || 0,
      taxonomyVersion: taxonomy.version,
      createdAt: taxonomy.createdAt,
      updatedAt: taxonomy.updatedAt,
    });
  } catch (error) {
    log.error('Failed to get KG statistics', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'KG_STATS_FAILED', message: 'Failed to get KG statistics' },
    });
  }
});

/**
 * GET /:indexId/kg-enrich/documents
 *
 * Get classified documents with pagination and filtering.
 *
 * Query params:
 *   - page: Page number [optional, default: 1]
 *   - limit: Results per page [optional, default: 20, max: 100]
 *   - productId: Filter by product ID [optional]
 *   - department: Filter by department [optional]
 *   - minConfidence: Minimum confidence threshold [optional, 0-1]
 *   - sortBy: 'confidence' | 'createdAt' [optional, default: 'createdAt']
 *   - sortOrder: 'asc' | 'desc' [optional, default: 'desc']
 *
 * Response:
 *   - documents: Array of document metadata
 *   - pagination: { page, limit, total, totalPages }
 */
router.get('/:indexId/kg-enrich/documents', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Tenant context required' },
      });
      return;
    }

    const { indexId } = req.params;
    const tenantId = req.tenantContext.tenantId;
    const {
      page = '1',
      limit = '20',
      productId,
      department,
      minConfidence,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = req.query;

    // Verify index exists AND belongs to tenant
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'Index not found' } });
      return;
    }

    // Parse pagination params
    const pageNum = Math.max(1, parseInt(page as string, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10)));
    const skip = (pageNum - 1) * limitNum;

    // Load taxonomy and build product map for name resolution
    const taxonomy = await KnowledgeGraphTaxonomy.findOne({ tenantId, indexId }).lean();
    const productMap = taxonomy
      ? new Map(
          (taxonomy.taxonomy.products as Array<{ id: string; name: string }>).map((p) => [
            p.id,
            p.name,
          ]),
        )
      : new Map<string, string>();

    // Build query filter
    const query: Record<string, unknown> = {
      tenantId,
      indexId,
      'metadata.kgState.status': 'ENRICHED',
    };

    if (productId) {
      query['classification.productScope.primaryProduct'] = productId;
    }

    if (department) {
      query['classification.department'] = department;
    }

    if (minConfidence) {
      query['classification.productScope.confidence'] = {
        $gte: parseFloat(minConfidence as string),
      };
    }

    // Build sort options
    const sortOptions: Record<string, 1 | -1> = {};
    if (sortBy === 'confidence') {
      sortOptions['classification.productScope.confidence'] = sortOrder === 'asc' ? 1 : -1;
    } else {
      sortOptions.createdAt = sortOrder === 'asc' ? 1 : -1;
    }

    // Count total matching documents
    const total = await SearchDocument.countDocuments(query);

    // Fetch documents
    const documents = await SearchDocument.find(query)
      .sort(sortOptions)
      .skip(skip)
      .limit(limitNum)
      .select({
        _id: 1,
        originalReference: 1,
        'metadata.documentSummary': 1,
        classification: 1,
        'metadata.kgState': 1,
        createdAt: 1,
        updatedAt: 1,
      })
      .lean();

    res.json({
      documents: documents.map((doc) => ({
        documentId: doc._id,
        title: doc.originalReference || 'Untitled',
        summary: (doc.metadata?.documentSummary as string) || '',
        primaryProduct: doc.classification?.productScope?.primaryProduct
          ? (productMap.get(doc.classification.productScope.primaryProduct) ??
            doc.classification.productScope.primaryProduct)
          : undefined,
        secondaryProducts: (doc.classification?.productScope?.secondaryProducts || []).map(
          (id: string) => productMap.get(id) || id,
        ),
        confidence: doc.classification?.productScope?.confidence,
        department: doc.classification?.department,
        category: doc.classification?.category,
        enrichedAt: doc.metadata?.kgState?.enrichedAt,
        createdAt: doc.createdAt,
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    log.error('Failed to get classified documents', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'KG_DOCUMENTS_FAILED', message: 'Failed to get classified documents' },
    });
  }
});

/**
 * GET /:indexId/kg-enrich/entities
 *
 * Get entity distribution across the knowledge graph.
 *
 * Query params:
 *   - productId: Filter by product ID [optional]
 *   - limit: Max entities to return [optional, default: 100]
 *
 * Response:
 *   - entities: Array of { attributeId, name, count, dataType, sampleValues }
 *   - total: Total unique entity types
 */
router.get('/:indexId/kg-enrich/entities', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Tenant context required' },
      });
      return;
    }

    const { indexId } = req.params;
    const tenantId = req.tenantContext.tenantId;
    const { productId, limit = '100' } = req.query;

    // Verify index exists AND belongs to tenant
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'Index not found' } });
      return;
    }

    // Get taxonomy for attribute metadata
    const taxonomy = await KnowledgeGraphTaxonomy.findOne({ tenantId, indexId }).lean();
    if (!taxonomy) {
      res.status(404).json({
        success: false,
        error: { code: 'NO_TAXONOMY', message: 'No taxonomy configured for this index' },
      });
      return;
    }

    // Build aggregation pipeline
    const matchStage: any = {
      tenantId,
      indexId,
      'metadata.entities': { $exists: true, $ne: [] },
    };

    // If filtering by product, join with documents
    let pipeline: any[];
    if (productId) {
      pipeline = [
        {
          $lookup: {
            from: 'search_documents',
            localField: 'documentId',
            foreignField: '_id',
            as: 'document',
          },
        },
        { $unwind: '$document' },
        {
          $match: {
            ...matchStage,
            'document.classification.productScope.primaryProduct': productId,
          },
        },
        { $unwind: '$metadata.entities' },
        {
          $group: {
            _id: '$metadata.entities.type',
            count: { $sum: 1 },
            sampleValues: { $addToSet: '$metadata.entities.rawValue' },
          },
        },
        { $sort: { count: -1 } },
        { $limit: parseInt(limit as string, 10) },
      ];
    } else {
      pipeline = [
        { $match: matchStage },
        { $unwind: '$metadata.entities' },
        {
          $group: {
            _id: '$metadata.entities.type',
            count: { $sum: 1 },
            sampleValues: { $addToSet: '$metadata.entities.rawValue' },
          },
        },
        { $sort: { count: -1 } },
        { $limit: parseInt(limit as string, 10) },
      ];
    }

    const entityDistribution = await SearchChunk.aggregate(pipeline);

    // Map attribute IDs to metadata from taxonomy
    const attributeMap = new Map(
      taxonomy.taxonomy.attributes.map((attr) => [
        attr.id,
        { name: attr.name, dataType: attr.dataType },
      ]),
    );

    const entities = entityDistribution.map((item) => {
      const attrMetadata = attributeMap.get(item._id);
      return {
        attributeId: item._id,
        name: attrMetadata?.name || item._id,
        dataType: attrMetadata?.dataType || 'string',
        count: item.count,
        sampleValues: item.sampleValues.slice(0, 5), // Return max 5 samples
      };
    });

    res.json({
      entities,
      total: entities.length,
    });
  } catch (error) {
    log.error('Failed to get entity distribution', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'KG_ENTITIES_FAILED', message: 'Failed to get entity distribution' },
    });
  }
});

/**
 * GET /:indexId/kg-enrich/graph
 *
 * Get knowledge graph structure for visualization.
 *
 * Query params:
 *   - nodeId: Starting node ID [optional] - If provided, returns neighborhood around this node
 *   - depth: Number of hops from starting node [optional, default: 1]
 *   - nodeType: Filter by node type (product, attribute, entity) [optional]
 *   - productId: Filter to show only this product and its connections [optional]
 *   - includeEntityInstances: Include top entity instances [optional, default: false]
 *   - entityLimit: Max entity instances per product [optional, default: 20]
 *
 * Response:
 *   - nodes: Array of { id, label, type, properties }
 *   - edges: Array of { from, to, type, properties }
 */
router.get('/:indexId/kg-enrich/graph', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Tenant context required' },
      });
      return;
    }

    const { indexId } = req.params;
    const tenantId = req.tenantContext.tenantId;

    // Validate query params with Zod
    const graphQuerySchema = z.object({
      summaryMode: z.enum(['true', 'false']).default('false'),
      entityLimit: z.coerce.number().int().min(1).max(100).default(20),
      includeEntityInstances: z.enum(['true', 'false']).default('false'),
      nodeId: z.string().optional(),
      depth: z.coerce.number().int().min(1).max(5).default(1),
      nodeType: z.string().optional(),
      productId: z.string().optional(),
    });
    const parsed = graphQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(400)
        .json({ success: false, error: { code: 'INVALID_PARAMS', message: parsed.error.message } });
      return;
    }
    const {
      summaryMode,
      entityLimit: parsedEntityLimit,
      includeEntityInstances: parsedIncludeEntities,
      nodeType: parsedNodeType,
      productId: parsedProductId,
    } = parsed.data;

    // Verify index exists AND belongs to tenant
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'Index not found' } });
      return;
    }

    // Get taxonomy
    const taxonomy = await KnowledgeGraphTaxonomy.findOne({ tenantId, indexId }).lean();
    if (!taxonomy) {
      res.status(404).json({
        success: false,
        error: { code: 'NO_TAXONOMY', message: 'No taxonomy configured for this index' },
      });
      return;
    }

    // Use singleton taxonomy graph service
    const taxonomyGraph = getTaxonomyGraphService();

    // Get taxonomy structure
    const graphStructure = await taxonomyGraph.getTaxonomyGraphStructure(tenantId, indexId);

    // Filter by product if specified
    if (parsedProductId) {
      const filteredNodes = graphStructure.nodes.filter(
        (node) =>
          node.id === parsedProductId ||
          node.type === 'domain' ||
          node.type === 'category' ||
          (node.type === 'attribute' &&
            graphStructure.edges.some(
              (edge) => edge.from === parsedProductId && edge.to === node.id,
            )),
      );

      const filteredNodeIds = new Set(filteredNodes.map((n) => n.id));
      const filteredEdges = graphStructure.edges.filter(
        (edge) => filteredNodeIds.has(edge.from) && filteredNodeIds.has(edge.to),
      );

      graphStructure.nodes = filteredNodes;
      graphStructure.edges = filteredEdges;
    }

    // Filter by node type if specified
    if (parsedNodeType && parsedNodeType !== 'all') {
      graphStructure.nodes = graphStructure.nodes.filter((node) => node.type === parsedNodeType);
      const nodeIds = new Set(graphStructure.nodes.map((n) => n.id));
      graphStructure.edges = graphStructure.edges.filter(
        (edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to),
      );
    }

    // Optionally include entity instances (top N per product)
    if (parsedIncludeEntities === 'true') {
      const productNodes = graphStructure.nodes.filter((n) => n.type === 'product');
      const entityNodes: Array<{
        id: string;
        label: string;
        type: 'entity_instance';
        properties: Record<string, unknown>;
      }> = [];
      const entityEdges: Array<{
        from: string;
        to: string;
        type: string;
        properties?: Record<string, unknown>;
      }> = [];

      for (const productNode of productNodes) {
        const topEntities = await taxonomyGraph.getTopEntityInstancesByProduct(
          tenantId,
          indexId,
          productNode.id,
          parsedEntityLimit,
        );

        for (const entity of topEntities) {
          entityNodes.push({
            id: entity.id,
            label: entity.rawValue,
            type: 'entity_instance',
            properties: {
              attributeId: entity.attributeId,
              rawValue: entity.rawValue,
              normalizedValue: entity.normalizedValue,
              documentCount: entity.documentCount,
              firstSeenAt: entity.firstSeenAt,
              lastSeenAt: entity.lastSeenAt,
            },
          });

          // Edge from product to entity instance (parent→child direction)
          entityEdges.push({
            from: productNode.id,
            to: entity.id,
            type: 'FOUND_IN_PRODUCT',
            properties: {
              documentCount: entity.documentCount,
            },
          });

          // Edge from attribute to entity instance (parent→child direction)
          entityEdges.push({
            from: entity.attributeId,
            to: entity.id,
            type: 'INSTANCE_OF',
          });
        }
      }

      graphStructure.nodes.push(...entityNodes);
      graphStructure.edges.push(...entityEdges);
    }

    // Add document counts to product nodes
    const productCounts = await SearchDocument.aggregate([
      {
        $match: {
          tenantId,
          indexId,
          'classification.productScope.primaryProduct': { $exists: true },
        },
      },
      {
        $group: {
          _id: '$classification.productScope.primaryProduct',
          count: { $sum: 1 },
        },
      },
    ]);

    const countMap = new Map(productCounts.map((item) => [item._id, item.count]));

    // Add entity instance counts per product
    const entityCounts = await taxonomyGraph.getEntityCountsByProduct(tenantId, indexId);

    for (const node of graphStructure.nodes) {
      if (node.type === 'product') {
        node.properties.documentCount = countMap.get(node.id) || 0;
        node.properties.totalEntityInstances = entityCounts.get(node.id) || 0;
      }
    }

    // Optionally include attribute summaries
    let attributeSummaries:
      | Array<{
          attributeId: string;
          uniqueValues: number;
          topValues: Array<{ value: string; documentCount: number }>;
        }>
      | undefined;
    if (summaryMode === 'true') {
      attributeSummaries = await taxonomyGraph.getAttributeSummaries(tenantId, indexId);
    }

    res.json({
      nodes: graphStructure.nodes,
      edges: graphStructure.edges,
      ...(attributeSummaries ? { attributeSummaries } : {}),
      statistics: {
        totalNodes: graphStructure.nodes.length,
        totalEdges: graphStructure.edges.length,
        nodeTypes: {
          domain: graphStructure.nodes.filter((n) => n.type === 'domain').length,
          category: graphStructure.nodes.filter((n) => n.type === 'category').length,
          product: graphStructure.nodes.filter((n) => n.type === 'product').length,
          attribute: graphStructure.nodes.filter((n) => n.type === 'attribute').length,
          entity_instance: graphStructure.nodes.filter((n) => n.type === 'entity_instance').length,
        },
      },
    });
  } catch (error) {
    log.error('Failed to get graph structure', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'KG_GRAPH_FAILED', message: 'Failed to get graph structure' },
    });
  }
});

export default router;

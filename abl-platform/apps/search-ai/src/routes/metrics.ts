/**
 * Quality Metrics API
 *
 * Endpoints for querying and aggregating quality metrics across crawl jobs.
 */

import { Router, type Request, type Response, type Router as RouterType } from 'express';
import { requirePermission } from '@agent-platform/shared-auth';
import type { ISearchDocument, ISearchChunk } from '@agent-platform/database/models';
import { DocumentStatus } from '@agent-platform/search-ai-sdk';
import { getLazyModel } from '../db/index.js';

const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument');
const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk');

const router: RouterType = Router();

/**
 * GET /api/admin/metrics/job/:jobId
 *
 * Get quality metrics for a specific crawl job.
 *
 * Response:
 * {
 *   success: true,
 *   jobId: string,
 *   metrics: {
 *     documents: {
 *       total: number,
 *       indexed: number,
 *       failed: number,
 *       successRate: number
 *     },
 *     quality: {
 *       avgQualityScore: number | null,
 *       avgContentPreservation: number | null,
 *       avgChunksPerDoc: number
 *     },
 *     chunks: {
 *       total: number,
 *       indexed: number,
 *       avgSize: number
 *     },
 *     timeline: {
 *       firstDocument: string | null,
 *       lastDocument: string | null,
 *       duration: number | null (seconds)
 *     }
 *   }
 * }
 */
router.get(
  '/job/:jobId',
  requirePermission('admin:metrics:read'),
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const { jobId } = req.params;

      // Query documents for this job — scoped to tenant
      const documents = await SearchDocument.find({
        tenantId,
        'metadata.crawlJobId': jobId,
      })
        .select('status metadata createdAt updatedAt chunkCount')
        .lean();

      if (documents.length === 0) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'JOB_NOT_FOUND',
            message: `No documents found for job ${jobId}`,
          },
        });
      }

      // Calculate document metrics
      const totalDocs = documents.length;
      const indexedDocs = documents.filter(
        (doc: any) => doc.status === DocumentStatus.INDEXED,
      ).length;
      const failedDocs = documents.filter((doc: any) => doc.status === DocumentStatus.ERROR).length;
      const successRate = totalDocs > 0 ? (indexedDocs / totalDocs) * 100 : 0;

      // Calculate quality metrics
      const qualityScores = documents
        .map((doc: any) => (doc as any).metadata?.qualityScore)
        .filter((score: any): score is number => typeof score === 'number');
      const avgQualityScore =
        qualityScores.length > 0
          ? qualityScores.reduce((sum: any, score: any) => sum + score, 0) / qualityScores.length
          : null;

      const contentPreservation = documents
        .map((doc: any) => (doc as any).metadata?.contentPreservation)
        .filter((pres: any): pres is number => typeof pres === 'number');
      const avgContentPreservation =
        contentPreservation.length > 0
          ? contentPreservation.reduce((sum: any, pres: any) => sum + pres, 0) /
            contentPreservation.length
          : null;

      const chunkCounts = documents
        .map((doc: any) => doc.chunkCount)
        .filter((count: any): count is number => typeof count === 'number' && count > 0);
      const avgChunksPerDoc =
        chunkCounts.length > 0
          ? chunkCounts.reduce((sum: any, count: any) => sum + count, 0) / chunkCounts.length
          : 0;

      // Query chunks for this job
      const documentIds = documents.map((doc: any) => doc._id);
      const chunks = await SearchChunk.find({
        documentId: { $in: documentIds },
      })
        .select('status content')
        .lean();

      const totalChunks = chunks.length;
      const indexedChunks = chunks.filter((chunk: any) => chunk.status === 'indexed').length;
      const chunkSizes = chunks.map((chunk: any) => chunk.content?.length || 0);
      const avgChunkSize =
        chunkSizes.length > 0
          ? chunkSizes.reduce((sum: any, size: any) => sum + size, 0) / chunkSizes.length
          : 0;

      // Timeline metrics
      const timestamps = documents.map((doc: any) => doc.createdAt.getTime());
      const firstTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : null;
      const lastTimestamp = timestamps.length > 0 ? Math.max(...timestamps) : null;
      const duration =
        firstTimestamp && lastTimestamp ? (lastTimestamp - firstTimestamp) / 1000 : null;

      res.status(200).json({
        success: true,
        jobId,
        metrics: {
          documents: {
            total: totalDocs,
            indexed: indexedDocs,
            failed: failedDocs,
            successRate: Math.round(successRate * 100) / 100,
          },
          quality: {
            avgQualityScore:
              avgQualityScore !== null ? Math.round(avgQualityScore * 100) / 100 : null,
            avgContentPreservation:
              avgContentPreservation !== null
                ? Math.round(avgContentPreservation * 100) / 100
                : null,
            avgChunksPerDoc: Math.round(avgChunksPerDoc * 100) / 100,
          },
          chunks: {
            total: totalChunks,
            indexed: indexedChunks,
            avgSize: Math.round(avgChunkSize),
          },
          timeline: {
            firstDocument: firstTimestamp ? new Date(firstTimestamp).toISOString() : null,
            lastDocument: lastTimestamp ? new Date(lastTimestamp).toISOString() : null,
            duration,
          },
        },
      });
    } catch (error) {
      console.error('[metrics] Failed to get job metrics:', error);
      res.status(500).json({
        success: false,
        error: {
          code: 'METRICS_FETCH_FAILED',
          message: error instanceof Error ? error.message : 'Failed to fetch metrics',
        },
      });
    }
  },
);

/**
 * GET /api/admin/metrics/aggregate
 *
 * Get aggregated quality metrics across multiple jobs or time periods.
 *
 * Query parameters:
 * - indexId: Filter by index ID
 * - since: Start time (ISO 8601 timestamp)
 * - until: End time (ISO 8601 timestamp)
 * - groupBy: Group results by 'day', 'week', 'month' (optional)
 *
 * Response:
 * {
 *   success: true,
 *   aggregate: {
 *     documents: {
 *       total: number,
 *       indexed: number,
 *       failed: number,
 *       successRate: number
 *     },
 *     quality: {
 *       avgQualityScore: number | null,
 *       avgContentPreservation: number | null,
 *       avgChunksPerDoc: number
 *     },
 *     chunks: {
 *       total: number,
 *       indexed: number
 *     }
 *   },
 *   timeWindow: {
 *     since: string,
 *     until: string
 *   },
 *   breakdown?: Array<{
 *     period: string,
 *     metrics: {...}
 *   }>
 * }
 */
router.get(
  '/aggregate',
  requirePermission('admin:metrics:read'),
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const { indexId, since, until, groupBy } = req.query;

      // Default time window: last 7 days
      const sinceDate = since ? new Date(since as string) : new Date(Date.now() - 7 * 86_400_000);
      const untilDate = until ? new Date(until as string) : new Date();

      // Build query filter — scoped to tenant
      const filter: any = {
        tenantId,
        status: { $in: [DocumentStatus.INDEXED, DocumentStatus.ERROR] },
        createdAt: {
          $gte: sinceDate,
          $lte: untilDate,
        },
      };

      if (indexId) {
        filter.indexId = indexId;
      }

      // Query documents
      const documents = await SearchDocument.find(filter)
        .select('status metadata createdAt chunkCount')
        .lean();

      // Calculate aggregate metrics
      const totalDocs = documents.length;
      const indexedDocs = documents.filter(
        (doc: any) => doc.status === DocumentStatus.INDEXED,
      ).length;
      const failedDocs = documents.filter((doc: any) => doc.status === DocumentStatus.ERROR).length;
      const successRate = totalDocs > 0 ? (indexedDocs / totalDocs) * 100 : 0;

      const qualityScores = documents
        .map((doc: any) => (doc as any).metadata?.qualityScore)
        .filter((score: any): score is number => typeof score === 'number');
      const avgQualityScore =
        qualityScores.length > 0
          ? qualityScores.reduce((sum: any, score: any) => sum + score, 0) / qualityScores.length
          : null;

      const contentPreservation = documents
        .map((doc: any) => (doc as any).metadata?.contentPreservation)
        .filter((pres: any): pres is number => typeof pres === 'number');
      const avgContentPreservation =
        contentPreservation.length > 0
          ? contentPreservation.reduce((sum: any, pres: any) => sum + pres, 0) /
            contentPreservation.length
          : null;

      const chunkCounts = documents
        .map((doc: any) => doc.chunkCount)
        .filter((count: any): count is number => typeof count === 'number' && count > 0);
      const avgChunksPerDoc =
        chunkCounts.length > 0
          ? chunkCounts.reduce((sum: any, count: any) => sum + count, 0) / chunkCounts.length
          : 0;

      // Query chunks
      const documentIds = documents.map((doc: any) => doc._id);
      const chunks = await SearchChunk.find({
        documentId: { $in: documentIds },
      })
        .select('status')
        .lean();

      const totalChunks = chunks.length;
      const indexedChunks = chunks.filter((chunk: any) => chunk.status === 'indexed').length;

      const response: any = {
        success: true,
        aggregate: {
          documents: {
            total: totalDocs,
            indexed: indexedDocs,
            failed: failedDocs,
            successRate: Math.round(successRate * 100) / 100,
          },
          quality: {
            avgQualityScore:
              avgQualityScore !== null ? Math.round(avgQualityScore * 100) / 100 : null,
            avgContentPreservation:
              avgContentPreservation !== null
                ? Math.round(avgContentPreservation * 100) / 100
                : null,
            avgChunksPerDoc: Math.round(avgChunksPerDoc * 100) / 100,
          },
          chunks: {
            total: totalChunks,
            indexed: indexedChunks,
          },
        },
        timeWindow: {
          since: sinceDate.toISOString(),
          until: untilDate.toISOString(),
        },
      };

      // Optional: Group by time period
      if (groupBy === 'day' || groupBy === 'week' || groupBy === 'month') {
        response.breakdown = groupDocumentsByPeriod(documents, chunks, groupBy);
      }

      res.status(200).json(response);
    } catch (error) {
      console.error('[metrics] Failed to get aggregate metrics:', error);
      res.status(500).json({
        success: false,
        error: {
          code: 'AGGREGATE_METRICS_FAILED',
          message: error instanceof Error ? error.message : 'Failed to fetch aggregate metrics',
        },
      });
    }
  },
);

/**
 * Helper function to group documents by time period
 */
function groupDocumentsByPeriod(
  documents: any[],
  chunks: any[],
  groupBy: 'day' | 'week' | 'month',
): Array<{ period: string; metrics: any }> {
  const groups = new Map<string, any[]>();

  // Group documents by period
  for (const doc of documents) {
    const period = getPeriodKey(doc.createdAt, groupBy);
    if (!groups.has(period)) {
      groups.set(period, []);
    }
    groups.get(period)!.push(doc);
  }

  // Calculate metrics for each period
  const breakdown = [];
  for (const [period, periodDocs] of Array.from(groups.entries()).sort()) {
    const totalDocs = periodDocs.length;
    const indexedDocs = periodDocs.filter((doc) => doc.status === DocumentStatus.INDEXED).length;
    const failedDocs = periodDocs.filter((doc) => doc.status === DocumentStatus.ERROR).length;
    const successRate = totalDocs > 0 ? (indexedDocs / totalDocs) * 100 : 0;

    const qualityScores = periodDocs
      .map((doc) => doc.metadata?.qualityScore)
      .filter((score): score is number => typeof score === 'number');
    const avgQualityScore =
      qualityScores.length > 0
        ? qualityScores.reduce((sum: number, score: number) => sum + score, 0) /
          qualityScores.length
        : null;

    const chunkCounts = periodDocs
      .map((doc) => doc.chunkCount)
      .filter((count): count is number => typeof count === 'number' && count > 0);
    const avgChunksPerDoc =
      chunkCounts.length > 0
        ? chunkCounts.reduce((sum, count) => sum + count, 0) / chunkCounts.length
        : 0;

    breakdown.push({
      period,
      metrics: {
        documents: {
          total: totalDocs,
          indexed: indexedDocs,
          failed: failedDocs,
          successRate: Math.round(successRate * 100) / 100,
        },
        quality: {
          avgQualityScore:
            avgQualityScore !== null ? Math.round(avgQualityScore * 100) / 100 : null,
          avgChunksPerDoc: Math.round(avgChunksPerDoc * 100) / 100,
        },
      },
    });
  }

  return breakdown;
}

/**
 * Helper function to get period key for grouping
 */
function getPeriodKey(date: Date, groupBy: 'day' | 'week' | 'month'): string {
  const d = new Date(date);

  if (groupBy === 'day') {
    return d.toISOString().split('T')[0]; // YYYY-MM-DD
  } else if (groupBy === 'week') {
    // Get week number
    const onejan = new Date(d.getFullYear(), 0, 1);
    const week = Math.ceil(((d.getTime() - onejan.getTime()) / 86400000 + onejan.getDay() + 1) / 7);
    return `${d.getFullYear()}-W${week.toString().padStart(2, '0')}`;
  } else {
    // month
    return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}`;
  }
}

export default router;

/**
 * Error Tracking API
 *
 * Endpoints for querying and aggregating pipeline errors.
 */

import { Router, type Request, type Response, type Router as RouterType } from 'express';
import { requirePermission } from '@agent-platform/shared-auth';
import type { ISearchDocument } from '@agent-platform/database/models';
import { DocumentStatus } from '@agent-platform/search-ai-sdk';
import { createLogger } from '@abl/compiler/platform';
import { getLazyModel } from '../db/index.js';

const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument');
const logger = createLogger('errors');

const router: RouterType = Router();

/**
 * GET /api/admin/errors
 *
 * Query documents with processing errors.
 * Supports filtering by indexId, time range, and pagination.
 *
 * Query parameters:
 * - indexId: Filter by index ID
 * - since: Start time (ISO 8601 timestamp)
 * - until: End time (ISO 8601 timestamp)
 * - limit: Max results (default: 100, max: 1000)
 * - offset: Skip results (default: 0)
 *
 * Response:
 * {
 *   success: true,
 *   errors: Array<{
 *     documentId: string,
 *     indexId: string,
 *     tenantId: string,
 *     status: string,
 *     error: string,
 *     timestamp: string,
 *     metadata: object
 *   }>,
 *   total: number,
 *   limit: number,
 *   offset: number
 * }
 */
router.get('/', requirePermission('admin:errors:read'), async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const { indexId, since, until, limit = '100', offset = '0' } = req.query;

    // Parse and validate pagination params
    const limitNum = Math.min(parseInt(limit as string, 10) || 100, 1000);
    const offsetNum = parseInt(offset as string, 10) || 0;

    // Build query filter — scoped to tenant
    const filter: Record<string, unknown> = {
      tenantId,
      status: DocumentStatus.ERROR,
      processingError: { $ne: null },
    };

    if (indexId) {
      filter.indexId = indexId;
    }

    if (since || until) {
      const dateFilter: { $gte?: Date; $lte?: Date } = {};
      if (since) {
        dateFilter.$gte = new Date(since as string);
      }
      if (until) {
        dateFilter.$lte = new Date(until as string);
      }
      filter.updatedAt = dateFilter;
    }

    // Query documents with errors
    const [documents, total] = await Promise.all([
      SearchDocument.find(filter)
        .select('_id indexId tenantId status processingError updatedAt metadata')
        .sort({ updatedAt: -1 })
        .limit(limitNum)
        .skip(offsetNum)
        .lean(),
      SearchDocument.countDocuments(filter),
    ]);

    // Format response
    const errors = documents.map((doc) => ({
      documentId: doc._id.toString(),
      indexId: doc.indexId,
      tenantId: doc.tenantId,
      status: doc.status,
      error: doc.processingError || 'Unknown error',
      timestamp: doc.updatedAt.toISOString(),
      metadata: (doc as Record<string, unknown>).metadata || {},
    }));

    res.status(200).json({
      success: true,
      errors,
      total,
      limit: limitNum,
      offset: offsetNum,
    });
  } catch (error) {
    logger.error('Failed to query errors', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: {
        code: 'ERROR_QUERY_FAILED',
        message: error instanceof Error ? error.message : 'Failed to query errors',
      },
    });
  }
});

/**
 * GET /api/admin/errors/stats
 *
 * Get error statistics aggregated by error type, index, and time window.
 *
 * Query parameters:
 * - indexId: Filter by index ID
 * - since: Start time (ISO 8601 timestamp, default: last 24 hours)
 * - until: End time (ISO 8601 timestamp, default: now)
 *
 * Response:
 * {
 *   success: true,
 *   stats: {
 *     total: number,
 *     byIndex: Record<string, number>,
 *     byErrorType: Record<string, number>,
 *     recentErrors: Array<{...}>
 *   },
 *   timeWindow: {
 *     since: string,
 *     until: string
 *   }
 * }
 */
router.get(
  '/stats',
  requirePermission('admin:errors:read'),
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const { indexId, since, until } = req.query;

      // Default time window: last 24 hours
      const sinceDate = since ? new Date(since as string) : new Date(Date.now() - 86_400_000);
      const untilDate = until ? new Date(until as string) : new Date();

      // Build query filter — scoped to tenant
      const filter: Record<string, unknown> = {
        tenantId,
        status: DocumentStatus.ERROR,
        processingError: { $ne: null },
        updatedAt: {
          $gte: sinceDate,
          $lte: untilDate,
        },
      };

      if (indexId) {
        filter.indexId = indexId;
      }

      // Query error documents
      const documents = await SearchDocument.find(filter)
        .select('indexId processingError updatedAt')
        .lean();

      // Aggregate by index
      const byIndex: Record<string, number> = {};
      for (const doc of documents) {
        byIndex[doc.indexId] = (byIndex[doc.indexId] || 0) + 1;
      }

      // Aggregate by error type (extract first line of error message)
      const byErrorType: Record<string, number> = {};
      for (const doc of documents) {
        if (!doc.processingError) continue;
        const errorType = doc.processingError.split('\n')[0].substring(0, 100);
        byErrorType[errorType] = (byErrorType[errorType] || 0) + 1;
      }

      // Get recent errors (last 10)
      const recentErrors = await SearchDocument.find(filter)
        .select('_id indexId processingError updatedAt')
        .sort({ updatedAt: -1 })
        .limit(10)
        .lean();

      res.status(200).json({
        success: true,
        stats: {
          total: documents.length,
          byIndex,
          byErrorType,
          recentErrors: recentErrors.map((doc) => ({
            documentId: doc._id.toString(),
            indexId: doc.indexId,
            error: doc.processingError || 'Unknown error',
            timestamp: doc.updatedAt.toISOString(),
          })),
        },
        timeWindow: {
          since: sinceDate.toISOString(),
          until: untilDate.toISOString(),
        },
      });
    } catch (error) {
      logger.error('Failed to get error stats', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'ERROR_STATS_FAILED',
          message: error instanceof Error ? error.message : 'Failed to get error stats',
        },
      });
    }
  },
);

/**
 * POST /api/admin/errors/bulk-retry
 *
 * Retry multiple failed documents by resetting their status to PENDING.
 * Accepts an array of 1-100 document IDs.
 *
 * Body: { documentIds: string[] }
 */
router.post(
  '/bulk-retry',
  requirePermission('admin:errors:retry'),
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const { documentIds } = req.body;

      if (
        !Array.isArray(documentIds) ||
        documentIds.length === 0 ||
        documentIds.length > 100 ||
        !documentIds.every((id: unknown) => typeof id === 'string' && id.length > 0)
      ) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'documentIds must be array of 1-100 non-empty string IDs',
          },
        });
        return;
      }

      const result = await SearchDocument.updateMany(
        { _id: { $in: documentIds }, tenantId, status: 'error' },
        { $set: { status: 'pending', processingError: null, updatedAt: new Date() } },
      );

      res.json({
        success: true,
        modifiedCount: result.modifiedCount,
        requestedCount: documentIds.length,
      });
    } catch (error) {
      logger.error('Failed to bulk retry documents', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to process bulk retry' },
      });
    }
  },
);

/**
 * POST /api/admin/errors/:documentId/retry
 *
 * Retry a failed document by resetting its status to PENDING.
 * This will re-enqueue the document for processing.
 *
 * Response:
 * {
 *   success: true,
 *   documentId: string,
 *   previousStatus: string,
 *   newStatus: string
 * }
 */
router.post(
  '/:documentId/retry',
  requirePermission('admin:errors:retry'),
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const { documentId } = req.params;

      // SECURITY: Scope lookup by tenantId to prevent cross-tenant access
      const document = await SearchDocument.findOne({ _id: documentId, tenantId });

      if (!document) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'DOCUMENT_NOT_FOUND',
            message: `Document ${documentId} not found`,
          },
        });
      }

      if (document.status !== DocumentStatus.ERROR) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'DOCUMENT_NOT_FAILED',
            message: `Document ${documentId} is not in ERROR status (current: ${document.status})`,
          },
        });
      }

      const previousStatus = document.status;

      // Reset to PENDING to re-trigger processing
      document.status = DocumentStatus.PENDING;
      document.processingError = null;
      document.updatedAt = new Date();
      await document.save();

      res.status(200).json({
        success: true,
        documentId,
        previousStatus,
        newStatus: DocumentStatus.PENDING,
        message: 'Document reset to PENDING for retry',
      });
    } catch (error) {
      logger.error('Failed to retry document', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'RETRY_FAILED',
          message: error instanceof Error ? error.message : 'Failed to retry document',
        },
      });
    }
  },
);

export default router;

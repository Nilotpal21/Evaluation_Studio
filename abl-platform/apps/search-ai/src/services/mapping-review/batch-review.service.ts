/**
 * Batch Review Service
 *
 * Handles batch operations for reviewing and approving/rejecting field mapping suggestions.
 * Supports filtering, sorting, and bulk status updates.
 */

import { getLazyModel } from '../../db/index.js';
import type { IFieldMapping } from '@agent-platform/database/models';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('batch-review');

const FieldMapping = getLazyModel<IFieldMapping>('FieldMapping');

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BatchReviewFilter {
  canonicalSchemaId?: string;
  connectorId?: string;
  status?: string | string[];
  minConfidence?: number;
  maxConfidence?: number;
  suggestedBy?: string;
}

export interface BatchReviewSortOptions {
  field: 'confidence' | 'createdAt' | 'canonicalField' | 'sourcePath';
  order: 'asc' | 'desc';
}

export interface BatchReviewRequest {
  tenantId: string;
  filter: BatchReviewFilter;
  sort?: BatchReviewSortOptions;
  limit?: number;
  offset?: number;
}

export interface BatchReviewResponse {
  mappings: IFieldMapping[];
  total: number;
  offset: number;
  limit: number;
}

export interface BatchUpdateRequest {
  tenantId: string;
  mappingIds: string[];
  action: 'approve' | 'reject' | 'needs_review';
  reviewedBy: string;
}

export interface BatchUpdateResponse {
  updatedCount: number;
  errors: Array<{ mappingId: string; error: string }>;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class BatchReviewService {
  /**
   * Fetch mappings for batch review.
   *
   * @param request - Review request with filters and pagination
   * @returns Paginated mapping results
   */
  async getMappingsForReview(request: BatchReviewRequest): Promise<BatchReviewResponse> {
    const { tenantId, filter, sort, limit = 50, offset = 0 } = request;

    logger.info('Fetching mappings for batch review', {
      tenantId,
      filter,
      sort,
      limit,
      offset,
    });

    // Build query
    const query: Record<string, any> = { tenantId };

    if (filter.canonicalSchemaId) {
      query.canonicalSchemaId = filter.canonicalSchemaId;
    }

    if (filter.connectorId) {
      query.connectorId = filter.connectorId;
    }

    if (filter.status) {
      if (Array.isArray(filter.status)) {
        query.status = { $in: filter.status };
      } else {
        query.status = filter.status;
      }
    }

    if (filter.minConfidence !== undefined || filter.maxConfidence !== undefined) {
      query.confidence = {};
      if (filter.minConfidence !== undefined) {
        query.confidence.$gte = filter.minConfidence;
      }
      if (filter.maxConfidence !== undefined) {
        query.confidence.$lte = filter.maxConfidence;
      }
    }

    if (filter.suggestedBy) {
      query.suggestedBy = filter.suggestedBy;
    }

    // Build sort
    const sortOptions: Record<string, 1 | -1> = {};
    if (sort) {
      sortOptions[sort.field] = sort.order === 'asc' ? 1 : -1;
    } else {
      // Default: sort by confidence descending (highest confidence first)
      sortOptions.confidence = -1;
    }

    // Execute query with pagination
    const [mappings, total] = await Promise.all([
      FieldMapping.find(query).sort(sortOptions).skip(offset).limit(limit).lean(),
      FieldMapping.countDocuments(query),
    ]);

    logger.info('Mappings fetched for review', {
      tenantId,
      count: mappings.length,
      total,
      offset,
      limit,
    });

    return {
      mappings: mappings as IFieldMapping[],
      total,
      offset,
      limit,
    };
  }

  /**
   * Batch update mapping statuses (approve/reject/needs_review).
   *
   * @param request - Batch update request
   * @returns Update result with success count and errors
   */
  async batchUpdateMappings(request: BatchUpdateRequest): Promise<BatchUpdateResponse> {
    const { tenantId, mappingIds, action, reviewedBy } = request;

    logger.info('Batch updating mappings', {
      tenantId,
      mappingIds: mappingIds.length,
      action,
      reviewedBy,
    });

    const errors: Array<{ mappingId: string; error: string }> = [];
    let updatedCount = 0;

    // Determine target status
    const targetStatus = this.actionToStatus(action);

    if (!targetStatus) {
      throw new Error(`Invalid action: ${action}`);
    }

    try {
      // Batch update with tenant isolation
      const result = await FieldMapping.updateMany(
        {
          _id: { $in: mappingIds },
          tenantId,
        },
        {
          $set: {
            status: targetStatus,
            reviewedBy: action === 'approve' ? reviewedBy : null,
            reviewedAt: action === 'approve' ? new Date() : null,
          },
        },
      );

      updatedCount = result.modifiedCount;

      logger.info('Batch update completed', {
        tenantId,
        updatedCount,
        action,
        requestedCount: mappingIds.length,
      });

      // If not all mappings were updated, some might not exist or belong to different tenant
      if (updatedCount < mappingIds.length) {
        const updatedMappings = await FieldMapping.find({
          _id: { $in: mappingIds },
          tenantId,
        })
          .select('_id')
          .lean();

        const updatedIds = new Set(updatedMappings.map((m) => m._id));
        for (const id of mappingIds) {
          if (!updatedIds.has(id)) {
            errors.push({
              mappingId: id,
              error: 'Mapping not found or access denied',
            });
          }
        }
      }
    } catch (error) {
      logger.error('Batch update failed', {
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    return {
      updatedCount,
      errors,
    };
  }

  /**
   * Get review statistics for a canonical schema.
   *
   * @param tenantId - Tenant ID
   * @param canonicalSchemaId - Canonical schema ID
   * @returns Review statistics
   */
  async getReviewStats(
    tenantId: string,
    canonicalSchemaId: string,
  ): Promise<{
    total: number;
    suggested: number;
    confirmed: number;
    rejected: number;
    needsReview: number;
    avgConfidence: number;
  }> {
    logger.info('Fetching review statistics', { tenantId, canonicalSchemaId });

    const [total, statusCounts, avgConfidenceResult] = await Promise.all([
      FieldMapping.countDocuments({ tenantId, canonicalSchemaId }),
      FieldMapping.aggregate([
        { $match: { tenantId, canonicalSchemaId } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      FieldMapping.aggregate([
        { $match: { tenantId, canonicalSchemaId } },
        { $group: { _id: null, avgConfidence: { $avg: '$confidence' } } },
      ]),
    ]);

    const statusMap = new Map<string, number>();
    for (const item of statusCounts) {
      statusMap.set(item._id, item.count);
    }

    const avgConfidence = avgConfidenceResult.length > 0 ? avgConfidenceResult[0].avgConfidence : 0;

    return {
      total,
      suggested: statusMap.get('suggested') || 0,
      confirmed: statusMap.get('confirmed') || 0,
      rejected: statusMap.get('rejected') || 0,
      needsReview: statusMap.get('needs_review') || 0,
      avgConfidence,
    };
  }

  /**
   * Convert action to status.
   *
   * @param action - Review action
   * @returns Status string
   */
  private actionToStatus(action: string): string | null {
    switch (action) {
      case 'approve':
        return 'confirmed';
      case 'reject':
        return 'rejected';
      case 'needs_review':
        return 'needs_review';
      default:
        return null;
    }
  }
}

// ─── Singleton Instance ──────────────────────────────────────────────────────

export const batchReviewService = new BatchReviewService();

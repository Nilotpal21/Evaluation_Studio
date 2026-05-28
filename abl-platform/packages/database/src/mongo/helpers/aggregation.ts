/**
 * Aggregation Pipeline Helpers
 *
 * Common aggregation pipeline builders for tenant-scoped queries,
 * date range filtering, and paginated aggregations.
 */

import type { PipelineStage } from 'mongoose';

// ─── Tenant Pipeline ─────────────────────────────────────────────────────

/**
 * Build a tenant-scoped aggregation pipeline.
 * Prepends a $match by tenantId before the rest of the stages.
 */
export function buildTenantPipeline(tenantId: string, stages: PipelineStage[]): PipelineStage[] {
  return [{ $match: { tenantId } }, ...stages];
}

// ─── Date Range Pipeline ─────────────────────────────────────────────────

/**
 * Build a date range filter stage.
 *
 * @param field - The date field to filter on (e.g., 'createdAt', 'lastActivityAt')
 * @param start - Start of range (inclusive)
 * @param end - End of range (exclusive)
 */
export function buildDateRangeStage(field: string, start: Date, end: Date): PipelineStage {
  return {
    $match: {
      [field]: {
        $gte: start,
        $lt: end,
      },
    },
  };
}

/**
 * Build a complete date range pipeline with optional tenant scoping.
 */
export function buildDateRangePipeline(
  field: string,
  start: Date,
  end: Date,
  options?: { tenantId?: string; additionalStages?: PipelineStage[] },
): PipelineStage[] {
  const stages: PipelineStage[] = [];

  if (options?.tenantId) {
    stages.push({ $match: { tenantId: options.tenantId } });
  }

  stages.push(buildDateRangeStage(field, start, end));

  if (options?.additionalStages) {
    stages.push(...options.additionalStages);
  }

  return stages;
}

// ─── Paginated Aggregation ───────────────────────────────────────────────

/**
 * Build a paginated aggregation pipeline using $facet.
 *
 * Adds pagination stages at the end of the pipeline:
 *   $facet { data: [$sort, $skip, $limit], total: [$count] }
 */
export function buildPaginatedPipeline(
  filter: Record<string, unknown>,
  sort: Record<string, 1 | -1>,
  page: number,
  limit: number,
  options?: {
    preFacetStages?: PipelineStage[];
  },
): PipelineStage[] {
  const safePage = Math.max(1, page);
  const safeLimit = Math.min(Math.max(1, limit), 100);

  const stages: PipelineStage[] = [{ $match: filter }];

  if (options?.preFacetStages) {
    stages.push(...options.preFacetStages);
  }

  stages.push({
    $facet: {
      data: [{ $sort: sort }, { $skip: (safePage - 1) * safeLimit }, { $limit: safeLimit }],
      total: [{ $count: 'count' }],
    },
  });

  return stages;
}

// ─── Group By Time Bucket ────────────────────────────────────────────────

type TimeBucket = 'hour' | 'day' | 'week' | 'month';

/**
 * Build a time-bucketed aggregation for analytics/metrics.
 *
 * Groups documents by a time bucket and computes metrics.
 *
 * @param dateField - The date field to bucket on
 * @param bucket - Time bucket size
 * @param metrics - Accumulator expressions for $group
 */
export function buildTimeBucketPipeline(
  dateField: string,
  bucket: TimeBucket,
  metrics: Record<string, Record<string, unknown>>,
  options?: { tenantId?: string; start?: Date; end?: Date },
): PipelineStage[] {
  const stages: PipelineStage[] = [];

  // Optional tenant filter
  if (options?.tenantId) {
    stages.push({ $match: { tenantId: options.tenantId } });
  }

  // Optional date range
  if (options?.start || options?.end) {
    const dateFilter: Record<string, unknown> = {};
    if (options.start) dateFilter.$gte = options.start;
    if (options.end) dateFilter.$lt = options.end;
    stages.push({ $match: { [dateField]: dateFilter } });
  }

  // Date truncation expression
  const dateTrunc = {
    $dateTrunc: {
      date: `$${dateField}`,
      unit: bucket,
    },
  };

  // Group by time bucket
  stages.push({
    $group: {
      _id: dateTrunc,
      ...metrics,
    },
  });

  // Sort by bucket ascending
  stages.push({ $sort: { _id: 1 } });

  return stages;
}

// ─── Lookup (Join) Helper ────────────────────────────────────────────────

/**
 * Build a $lookup stage for joining collections.
 */
export function buildLookupStage(
  from: string,
  localField: string,
  foreignField: string,
  as: string,
): PipelineStage {
  return {
    $lookup: {
      from,
      localField,
      foreignField,
      as,
    },
  };
}

/**
 * Build a $lookup + $unwind for a single-document join (1:1 or N:1).
 */
export function buildLookupOneStage(
  from: string,
  localField: string,
  foreignField: string,
  as: string,
): PipelineStage[] {
  return [
    buildLookupStage(from, localField, foreignField, as),
    {
      $unwind: {
        path: `$${as}`,
        preserveNullAndEmptyArrays: true,
      },
    },
  ];
}

// ─── Count By Field ──────────────────────────────────────────────────────

/**
 * Build a pipeline that counts documents grouped by a field value.
 * Useful for status distributions, type breakdowns, etc.
 */
export function buildCountByFieldPipeline(
  field: string,
  filter?: Record<string, unknown>,
): PipelineStage[] {
  const stages: PipelineStage[] = [];

  if (filter) {
    stages.push({ $match: filter });
  }

  stages.push(
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $project: { _id: 0, value: '$_id', count: 1 } },
  );

  return stages;
}

/**
 * Pagination Helpers
 *
 * Utility functions for building cursor-based and offset pagination
 * outside of BaseModel (e.g., in raw aggregation pipelines).
 */

import type { PipelineStage } from 'mongoose';
import type {
  PaginationOptions,
  PaginatedResult,
  CursorOptions,
  CursorResult,
} from '../base-document.js';

// ─── Offset Pagination Pipeline ──────────────────────────────────────────

/**
 * Build aggregation pipeline stages for offset-based pagination.
 *
 * Returns pipeline stages for: $sort → $facet({ data: [$skip, $limit], total: [$count] })
 */
export function buildOffsetPaginationPipeline(opts: PaginationOptions = {}): PipelineStage[] {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(Math.max(1, opts.limit ?? 20), 100);
  const sort = opts.sort ?? { createdAt: -1 };

  return [
    { $sort: sort },
    {
      $facet: {
        data: [{ $skip: (page - 1) * limit }, { $limit: limit }],
        total: [{ $count: 'count' }],
      },
    },
  ];
}

/**
 * Parse the result of an offset pagination facet into a PaginatedResult.
 */
export function parseOffsetPaginationResult<T>(
  facetResult: { data: T[]; total: { count: number }[] },
  opts: PaginationOptions = {},
): PaginatedResult<T> {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(Math.max(1, opts.limit ?? 20), 100);
  const total = facetResult.total[0]?.count ?? 0;
  const totalPages = Math.ceil(total / limit);

  return {
    data: facetResult.data,
    total,
    page,
    limit,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}

// ─── Cursor Pagination Pipeline ──────────────────────────────────────────

/**
 * Build aggregation pipeline stages for cursor-based pagination.
 *
 * Uses the _id field as the cursor. For large collections (conversations,
 * contacts, audit_logs), this avoids the performance penalty of large skip values.
 */
export function buildCursorPaginationPipeline(opts: CursorOptions = {}): PipelineStage[] {
  const limit = Math.min(Math.max(1, opts.limit ?? 20), 100);
  const sort = opts.sort ?? { _id: -1 };
  const direction = opts.direction ?? 'forward';

  const stages: PipelineStage[] = [];

  // Apply cursor filter
  if (opts.cursor) {
    const sortField = Object.keys(sort)[0] ?? '_id';
    const sortDir = Object.values(sort)[0] ?? -1;
    const op =
      (direction === 'forward' && sortDir === -1) || (direction === 'backward' && sortDir === 1)
        ? '$lt'
        : '$gt';

    stages.push({ $match: { [sortField]: { [op]: opts.cursor } } });
  }

  stages.push({ $sort: sort });
  stages.push({ $limit: limit + 1 }); // +1 to detect hasMore

  return stages;
}

/**
 * Parse the result of a cursor pagination query into a CursorResult.
 */
export function parseCursorPaginationResult<T extends { _id: string }>(
  docs: T[],
  limit: number,
  hasCursor: boolean,
): CursorResult<T> {
  const effectiveLimit = Math.min(Math.max(1, limit), 100);
  const hasMore = docs.length > effectiveLimit;

  if (hasMore) docs.pop();

  const nextCursor = hasMore && docs.length > 0 ? docs[docs.length - 1]._id : null;

  const prevCursor = hasCursor && docs.length > 0 ? docs[0]._id : null;

  return { data: docs, nextCursor, prevCursor, hasMore };
}

// ─── Pagination Defaults ─────────────────────────────────────────────────

/** Clamp and validate pagination parameters */
export function normalizePaginationOptions(opts: PaginationOptions): Required<PaginationOptions> {
  return {
    page: Math.max(1, opts.page ?? 1),
    limit: Math.min(Math.max(1, opts.limit ?? 20), 100),
    sort: opts.sort ?? { createdAt: -1 },
  };
}

/** Clamp and validate cursor options */
export function normalizeCursorOptions(opts: CursorOptions): Required<CursorOptions> {
  return {
    cursor: opts.cursor ?? '',
    limit: Math.min(Math.max(1, opts.limit ?? 20), 100),
    sort: opts.sort ?? { _id: -1 },
    direction: opts.direction ?? 'forward',
  };
}

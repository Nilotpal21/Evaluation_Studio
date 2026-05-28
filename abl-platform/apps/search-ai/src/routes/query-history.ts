/**
 * Query History Routes
 *
 * REST endpoint for reading search query history from ClickHouse.
 * Mounted at /api/indexes/:indexId/query-history
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform';
import { toClickHouseDateTime } from '@agent-platform/database/clickhouse';
import type { ISearchIndex } from '@agent-platform/database';
import { getLazyModel } from '../db/index.js';
import { applyProjectScopeFilter } from './project-scope.js';

const router: RouterType = Router({ mergeParams: true });
const logger = createLogger('query-history-routes');

// =============================================================================
// TYPES
// =============================================================================

/** Row shape returned from ClickHouse SELECT (excludes heavy/sensitive cols) */
interface SearchQueryRow {
  query_id: string;
  tenant_id: string;
  project_id: string;
  session_id: string;
  index_id: string;
  user_id: string;
  query_type: string;
  query_text: string;
  result_count: string;
  total_latency_ms: string;
  vocabulary_resolve_ms: string;
  vector_search_ms: string;
  structured_filter_ms: string;
  rerank_ms: string;
  cache_hit: string;
  timestamp: string;
  filters: string;
  vocabulary_terms: string;
  top_k: string;
  feedback_score: string;
  click_position: string;
}

// =============================================================================
// VALIDATION
// =============================================================================

const queryHistorySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

// =============================================================================
// CONSTANTS
// =============================================================================

// search_queries.timestamp is DateTime64(3) — we use toClickHouseDateTime (ms-preserving)
// imported above, with param hints matching the actual column type.

const TABLE = 'abl_platform.search_queries';

/**
 * Column list for search_queries table.
 * SYNC: Keep in sync with apps/search-ai-runtime/src/services/stores/clickhouse-search-query-store.ts
 * (cross-app — cannot be shared via import)
 */
const SELECT_COLUMNS = [
  'query_id',
  'tenant_id',
  'project_id',
  'session_id',
  'index_id',
  'user_id',
  'query_type',
  'query_text',
  'result_count',
  'total_latency_ms',
  'vocabulary_resolve_ms',
  'vector_search_ms',
  'structured_filter_ms',
  'rerank_ms',
  'cache_hit',
  'timestamp',
  'filters',
  'vocabulary_terms',
  'top_k',
  'feedback_score',
  'click_position',
].join(', ');

// =============================================================================
// ROUTES
// =============================================================================

/**
 * GET /api/indexes/:indexId/query-history
 *
 * Returns paginated search query history for a given index.
 * Requires authentication; scoped to tenant via tenantId.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const indexId = req.params.indexId;
    if (!indexId) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_INDEX_ID', message: 'indexId is required' },
      });
    }

    const tenantId = req.tenantContext?.tenantId;
    if (!tenantId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Missing tenant context' },
      });
    }

    const parsed = queryHistorySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        },
      });
    }

    const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    )
      .select('_id')
      .lean();
    if (!index) {
      return res.status(404).json({
        success: false,
        error: { code: 'INDEX_NOT_FOUND', message: 'Index not found' },
      });
    }

    const { limit, offset, from, to } = parsed.data;

    // Get ClickHouse client — globalThis singleton
    let chClient;
    try {
      const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
      chClient = getClickHouseClient();
    } catch {
      logger.warn('ClickHouse unavailable, returning empty result');
      return res.json({ success: true, data: { queries: [], total: 0, hasMore: false } });
    }

    // Build WHERE clause
    const conditions = ['tenant_id = {tenantId:String}', 'index_id = {indexId:String}'];
    const queryParams: Record<string, string | number> = {
      tenantId,
      indexId,
    };

    if (from) {
      conditions.push('timestamp >= {from:DateTime64(3)}');
      queryParams.from = toClickHouseDateTime(from);
    }
    if (to) {
      conditions.push('timestamp <= {to:DateTime64(3)}');
      queryParams.to = toClickHouseDateTime(to);
    }

    const whereClause = conditions.join(' AND ');

    // Get total count
    const countResult = await chClient.query({
      query: `SELECT count() AS cnt FROM ${TABLE} WHERE ${whereClause} SETTINGS max_execution_time = 15`,
      query_params: queryParams,
      format: 'JSONEachRow',
    });
    const countRows = await countResult.json<{ cnt: string }>();
    const total = parseInt(countRows[0]?.cnt || '0', 10);

    // Get paginated results
    const result = await chClient.query({
      query: `
        SELECT ${SELECT_COLUMNS}
        FROM ${TABLE}
        WHERE ${whereClause}
        ORDER BY timestamp DESC
        LIMIT {limit:UInt32} OFFSET {offset:UInt32}
        SETTINGS max_execution_time = 15
      `,
      query_params: { ...queryParams, limit, offset },
      format: 'JSONEachRow',
    });

    const rows = await result.json<SearchQueryRow>();

    return res.json({
      success: true,
      data: {
        queries: rows,
        total,
        hasMore: offset + limit < total,
      },
    });
  } catch (err) {
    const isClickHouseError =
      err instanceof Error &&
      (err.message.includes('ECONNREFUSED') ||
        err.message.includes('socket') ||
        err.message.includes('timeout'));

    if (isClickHouseError) {
      logger.warn('ClickHouse unavailable, degrading gracefully', {
        error: err instanceof Error ? err.message : String(err),
        indexId: req.params.indexId,
      });
      return res.json({
        success: true,
        data: { queries: [], total: 0, hasMore: false },
      });
    }

    logger.error('Failed to fetch query history', {
      error: err instanceof Error ? err.message : String(err),
      indexId: req.params.indexId,
    });
    return res.status(500).json({
      success: false,
      error: { code: 'QUERY_HISTORY_ERROR', message: 'Failed to fetch query history' },
    });
  }
});

export default router;

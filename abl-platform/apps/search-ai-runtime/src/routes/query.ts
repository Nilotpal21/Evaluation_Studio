/**
 * Unified Search Route
 *
 * POST /api/search/:indexId/query — Execute a search query.
 *
 * Supports all query types:
 * - vector/semantic: Pure k-NN vector search
 * - hybrid: k-NN + structured filters
 * - structured: BM25 + metadata filters
 * - aggregation: Group-by with metrics
 * - keyword: Pure BM25 text search (no embeddings)
 *
 * queryType is optional — if omitted, the pipeline auto-classifies via LLM
 * (requires DynamicVocabularyResolver to be configured).
 *
 * Per-tenant LLM resolution: Each query resolves the tenant's configured model
 * from SearchIndex.queryLLMConfig → TenantModel → LLMCredential. Falls back
 * to static vocabulary matching if no model is configured.
 */

import {
  Router,
  type Router as RouterType,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { verifyIndexOwnership } from '../middleware/verify-index-ownership.js';
import { createPermissionFilterMiddleware } from '../middleware/permission-filter.middleware.js';
import { createEndUserAuthMiddleware } from '../middleware/end-user-auth.middleware.js';
import { createEndUserRateLimitMiddleware } from '../middleware/end-user-rate-limit.middleware.js';
import { requirePermission } from '@agent-platform/shared';
import { getGlobalRedisClient } from '../services/cache/redis-client.js';
import { QueryPipeline } from '../services/query/query-pipeline.js';
import { getSharedPipelineWithFlags } from './shared-pipeline.js';
import { createLogger } from '@abl/compiler/platform';
import type { UnifiedSearchQuery } from '../services/query/types.js';
import { resolveSimilarityThreshold } from '../services/query/similarity-threshold.js';

const logger = createLogger('search-runtime-query');

const VALID_QUERY_TYPES = ['vector', 'hybrid', 'structured', 'semantic', 'aggregation', 'keyword'];

export function createQueryRouter(pipeline?: QueryPipeline): RouterType {
  const router: RouterType = Router();

  // End-user auth middleware (runs first — handles requests with no Authorization header)
  router.use('/:indexId', createEndUserAuthMiddleware());

  // Existing auth middleware (guarded — skips if tenantContext already set by end-user auth)
  const guardedAuthMiddleware = (req: Request, res: Response, next: NextFunction) => {
    if (req.tenantContext) {
      return next();
    }
    return authMiddleware(req, res, next);
  };
  router.use(guardedAuthMiddleware);

  router.use('/:indexId', verifyIndexOwnership);

  // Enforce knowledge_base:read permission.
  router.use(requirePermission('knowledge_base:read'));

  const redisClient = getGlobalRedisClient();
  router.use(createPermissionFilterMiddleware(redisClient));

  // End-user rate limiting (after identity resolution)
  router.use(createEndUserRateLimitMiddleware());

  /**
   * POST /:indexId/query
   *
   * All query types route through executeUnified().
   * 'vector' is a legacy alias for 'semantic'.
   * 'keyword' maps to 'structured' (BM25-only, no embeddings).
   */
  router.post('/:indexId/query', async (req, res) => {
    try {
      const { indexId } = req.params;
      const body = req.body;

      if (!body.query || typeof body.query !== 'string') {
        res
          .status(400)
          .json({ error: 'Missing or invalid "query" field. Must be a non-empty string.' });
        return;
      }

      if (body.queryType && !VALID_QUERY_TYPES.includes(body.queryType)) {
        res.status(400).json({
          error: `Invalid "queryType" field. Must be one of: ${VALID_QUERY_TYPES.join(', ')}, or omit for auto-classification.`,
        });
        return;
      }

      if (!req.tenantContext) {
        res.status(401).json({ error: 'Missing tenant context' });
        return;
      }
      const tenantId = req.tenantContext.tenantId;
      const callerContext = {
        identityTier: String(req.tenantContext.identityTier || 'user'),
        channel: 'api',
        initiatedById: req.tenantContext.userId,
      };

      const authMode = (req as any).authMode;
      const userIdentity = (req as any).userIdentity;
      const verifiedIndex = (req as any).verifiedIndex;

      let queryPipeline: QueryPipeline;
      // Read QI status from the already-loaded verifiedIndex (ownership
      // middleware fetches full SearchIndex document with its own cache).
      // This avoids depending on pipeline cache invalidation timing.
      const queryIntelligenceDisabled = verifiedIndex?.queryLLMConfig?.enabled !== true;
      if (pipeline) {
        queryPipeline = pipeline;
      } else {
        const result = await getSharedPipelineWithFlags(tenantId, indexId, verifiedIndex);
        queryPipeline = result.pipeline;
      }

      const unifiedQuery: UnifiedSearchQuery = {
        indexId,
        query: body.query,
        queryType:
          body.queryType === 'vector'
            ? 'semantic'
            : body.queryType === 'keyword'
              ? 'structured'
              : (body.queryType as UnifiedSearchQuery['queryType']),
        filters: body.filters,
        topK: body.topK,
        rerank: body.rerank,
        skipPreprocessing: body.skipPreprocessing,
        skipVocabularyResolution: body.skipVocabularyResolution || queryIntelligenceDisabled,
        sort: body.sort,
        offset: body.offset,
        limit: body.limit,
        aggregation: body.aggregation,
        debug: body.debug,
        documentIds:
          Array.isArray(body.documentIds) &&
          body.documentIds.length <= 65_536 &&
          body.documentIds.every(
            (id: unknown) => typeof id === 'string' && (id as string).length > 0,
          )
            ? body.documentIds
            : undefined,
        similarityThreshold: resolveSimilarityThreshold(body.similarityThreshold, verifiedIndex),
      };

      const response = await queryPipeline.executeUnified(
        unifiedQuery,
        tenantId,
        callerContext,
        authMode,
        userIdentity,
      );

      // Structured data enrichment (CSV/Excel tables)
      const hasStructuredData = verifiedIndex?.hasStructuredData === true;
      const TOP_N_CHECK = 5;
      const hasTableMetadataHit =
        hasStructuredData &&
        Array.isArray(response.results) &&
        response.results
          .slice(0, TOP_N_CHECK)
          .some(
            (r: any) =>
              typeof r.content === 'string' && r.content.startsWith('{"type":"table_metadata"'),
          );

      if (hasTableMetadataHit) {
        const enriched = await enrichWithStructuredData(
          response,
          body.query,
          indexId,
          tenantId,
          req.headers.authorization,
          logger,
        );
        res.json(enriched);
      } else {
        res.json(response);
      }
    } catch (error) {
      logger.error('Query execution failed', {
        indexId: req.params.indexId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

// Re-export for callers that imported from here
export { invalidatePipelineCache } from './shared-pipeline.js';

/**
 * Enrich query response with structured data from ClickHouse when the top result
 * is a table_metadata chunk (CSV/Excel). Proxies to search-ai's text-to-SQL endpoint.
 */
async function enrichWithStructuredData(
  response: any,
  query: string,
  indexId: string,
  tenantId: string,
  authHeader: string | undefined,
  log: typeof logger,
): Promise<any> {
  try {
    log.info('Structured data enrichment — proxying to text-to-SQL', { indexId, tenantId });

    const searchAiBaseUrl =
      process.env.SEARCH_AI_URL ||
      `http://${process.env.SEARCH_AI_HOST || 'localhost'}:${process.env.SEARCH_AI_PORT || '3005'}`;
    const url = `${searchAiBaseUrl}/api/indexes/${indexId}/structured-data/query`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const fetchResponse = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authHeader ? { Authorization: authHeader } : {}),
          'X-Tenant-Id': tenantId,
        },
        body: JSON.stringify({ query, limit: 20 }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!fetchResponse.ok) {
        log.warn('Structured data enrichment failed', {
          status: fetchResponse.status,
          statusText: fetchResponse.statusText,
        });
        return response;
      }

      const structuredResult = (await fetchResponse.json()) as any;

      if (structuredResult.success && structuredResult.data?.results?.length > 0) {
        return {
          ...response,
          structuredData: {
            intent: structuredResult.data.intent,
            results: structuredResult.data.results,
            totalCount: structuredResult.data.totalCount,
            sqlGenerated: structuredResult.data.sqlGenerated,
            executionTimeMs: structuredResult.data.executionTimeMs,
          },
        };
      }
    } catch (fetchError) {
      clearTimeout(timeout);
      log.warn('Structured data enrichment request failed', {
        error: fetchError instanceof Error ? fetchError.message : String(fetchError),
      });
    }

    return response;
  } catch (error) {
    log.warn('Structured data enrichment error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return response;
  }
}

export default createQueryRouter();

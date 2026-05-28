/**
 * Structured Search Route
 *
 * POST /api/search/:indexId/structured — Execute a structured (filter-based) search.
 * Delegates to executeUnified() with queryType='structured'.
 */

import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { verifyIndexOwnership } from '../middleware/verify-index-ownership.js';
import { createPermissionFilterMiddleware } from '../middleware/permission-filter.middleware.js';
import { getGlobalRedisClient } from '../services/cache/redis-client.js';
import { getSharedPipeline } from './shared-pipeline.js';
import { createLogger } from '@abl/compiler/platform';
import type { StructuredSearchQuery } from '@agent-platform/search-ai-sdk';
import type { QueryPipeline } from '../services/query/query-pipeline.js';

const logger = createLogger('search-runtime-structured');

export function createStructuredRouter(pipeline?: QueryPipeline): RouterType {
  const router: RouterType = Router();
  router.use(authMiddleware);
  router.use('/:indexId', verifyIndexOwnership);

  const redisClient = getGlobalRedisClient();
  router.use(createPermissionFilterMiddleware(redisClient));

  router.post('/:indexId/structured', async (req, res) => {
    try {
      const { indexId } = req.params;
      const body = req.body as StructuredSearchQuery;

      if (!body.filters || !Array.isArray(body.filters) || body.filters.length === 0) {
        res.status(400).json({
          error:
            'Missing or invalid "filters" field. Structured queries require at least one filter.',
        });
        return;
      }

      if (body.queryType && body.queryType !== 'structured') {
        res
          .status(400)
          .json({ error: 'Invalid "queryType" field. Must be "structured" for this endpoint.' });
        return;
      }

      if (!req.tenantContext) {
        res.status(401).json({ error: 'Unauthorized' });
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

      const queryPipeline =
        pipeline ?? (await getSharedPipeline(tenantId, indexId, (req as any).verifiedIndex));

      const response = await queryPipeline.executeUnified(
        {
          indexId,
          query: (body as any).query ?? '',
          queryType: 'structured',
          filters: body.filters,
          topK: body.topK,
          limit: body.limit,
          offset: body.offset,
          sort: body.sort,
          skipPreprocessing: true,
          skipVocabularyResolution: true,
        },
        tenantId,
        callerContext,
        authMode,
        userIdentity,
      );

      res.json(response);
    } catch (error) {
      logger.error('Structured search failed', {
        indexId: req.params.indexId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

export default createStructuredRouter();

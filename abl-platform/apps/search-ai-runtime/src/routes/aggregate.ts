/**
 * Aggregation Route
 *
 * POST /api/search/:indexId/aggregate — Execute an aggregation query.
 * Delegates to executeUnified() with queryType='aggregation'.
 */

import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { verifyIndexOwnership } from '../middleware/verify-index-ownership.js';
import { createPermissionFilterMiddleware } from '../middleware/permission-filter.middleware.js';
import { getGlobalRedisClient } from '../services/cache/redis-client.js';
import { getSharedPipeline } from './shared-pipeline.js';
import { createLogger } from '@abl/compiler/platform';
import type { AggregationQuery } from '@agent-platform/search-ai-sdk';
import type { QueryPipeline } from '../services/query/query-pipeline.js';

const logger = createLogger('search-runtime-aggregate');

export function createAggregateRouter(pipeline?: QueryPipeline): RouterType {
  const router: RouterType = Router();
  router.use(authMiddleware);
  router.use('/:indexId', verifyIndexOwnership);

  const redisClient = getGlobalRedisClient();
  router.use(createPermissionFilterMiddleware(redisClient));

  router.post('/:indexId/aggregate', async (req, res) => {
    try {
      const { indexId } = req.params;
      const body = req.body as AggregationQuery;

      if (!body.aggregation) {
        res.status(400).json({
          error:
            'Missing "aggregation" field. Aggregation queries require an aggregation specification.',
        });
        return;
      }

      if (!body.aggregation.measure || !body.aggregation.function) {
        res
          .status(400)
          .json({ error: 'Aggregation spec requires both "measure" and "function" fields.' });
        return;
      }

      const validFunctions = ['sum', 'avg', 'count', 'min', 'max', 'count_distinct'];
      if (!validFunctions.includes(body.aggregation.function)) {
        res.status(400).json({
          error: `Invalid aggregation function "${body.aggregation.function}". Must be one of: ${validFunctions.join(', ')}`,
        });
        return;
      }

      if (body.queryType && body.queryType !== 'aggregate') {
        res
          .status(400)
          .json({ error: 'Invalid "queryType" field. Must be "aggregate" for this endpoint.' });
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
          query: (body as any).query ?? body.aggregation.measure,
          queryType: 'aggregation',
          filters: body.filters,
          aggregation: body.aggregation,
          skipPreprocessing: true,
          skipVocabularyResolution: true,
        },
        tenantId,
        callerContext,
        authMode,
        userIdentity,
      );

      res.json({
        queryId: response.queryId,
        results: response.aggregations ?? [],
        totalCount: response.totalCount,
        latency: response.latency,
      });
    } catch (error) {
      logger.error('Aggregation query failed', {
        indexId: req.params.indexId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

export default createAggregateRouter();

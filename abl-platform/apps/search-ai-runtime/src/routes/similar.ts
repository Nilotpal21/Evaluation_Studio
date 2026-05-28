/**
 * Similar Documents Route
 *
 * POST /api/search/:indexId/similar — Find documents similar to a given document.
 * Uses executeUnified() with the document's content as the query text.
 */

import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { verifyIndexOwnership } from '../middleware/verify-index-ownership.js';
import { createPermissionFilterMiddleware } from '../middleware/permission-filter.middleware.js';
import { getGlobalRedisClient } from '../services/cache/redis-client.js';
import { getSharedPipeline } from './shared-pipeline.js';
import { createLogger } from '@abl/compiler/platform';
import type { SimilarQuery } from '@agent-platform/search-ai-sdk';

const logger = createLogger('search-runtime-similar');

export function createSimilarRouter(): RouterType {
  const router: RouterType = Router();
  router.use(authMiddleware);
  router.use('/:indexId', verifyIndexOwnership);

  const redisClient = getGlobalRedisClient();
  router.use(createPermissionFilterMiddleware(redisClient));

  router.post('/:indexId/similar', async (req, res) => {
    try {
      const { indexId } = req.params;
      const body = req.body as SimilarQuery;

      if (!body.documentId || typeof body.documentId !== 'string') {
        res
          .status(400)
          .json({ error: 'Missing or invalid "documentId" field. Must be a non-empty string.' });
        return;
      }

      const tenantId = req.tenantContext!.tenantId;
      const { SearchChunk } = await import('@agent-platform/database/models/search-chunk');
      const sourceChunk = await SearchChunk.findOne({
        indexId,
        tenantId,
        documentId: body.documentId,
      })
        .sort({ chunkIndex: 1 })
        .lean();

      const queryText = (sourceChunk as any)?.content ?? body.documentId;

      const callerContext = {
        identityTier: String(req.tenantContext!.identityTier || 'user'),
        channel: 'api',
        initiatedById: req.tenantContext!.userId,
      };

      const authMode = (req as any).authMode;
      const userIdentity = (req as any).userIdentity;

      const queryPipeline = await getSharedPipeline(tenantId, indexId, (req as any).verifiedIndex);

      const response = await queryPipeline.executeUnified(
        {
          indexId,
          query: queryText,
          queryType: 'semantic',
          topK: body.topK ?? 10,
          filters: body.filters,
          skipPreprocessing: true,
          skipVocabularyResolution: true,
        },
        tenantId,
        callerContext,
        authMode,
        userIdentity,
      );

      // Filter out the source document itself
      response.results = response.results.filter((r) => r.documentId !== body.documentId);
      response.totalCount = response.results.length;

      res.json(response);
    } catch (error) {
      logger.error('Similar search failed', {
        indexId: req.params.indexId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

export default createSimilarRouter();

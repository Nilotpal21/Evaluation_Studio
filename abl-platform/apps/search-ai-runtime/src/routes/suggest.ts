/**
 * Autocomplete / Suggest Route
 *
 * POST /api/search/:indexId/suggest — Get autocomplete suggestions.
 * Searches SearchChunk content by prefix match against MongoDB.
 */

import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { verifyIndexOwnership } from '../middleware/verify-index-ownership.js';
import { createLogger } from '@abl/compiler/platform';
import type { SuggestQuery, SearchResult } from '@agent-platform/search-ai-sdk';

const logger = createLogger('search-runtime-suggest');

export function createSuggestRouter(): RouterType {
  const router: RouterType = Router();
  router.use(authMiddleware);
  router.use('/:indexId', verifyIndexOwnership);

  /**
   * POST /:indexId/suggest
   *
   * Accepts a SuggestQuery body and returns SearchResult[].
   */
  router.post('/:indexId/suggest', async (req, res) => {
    try {
      const { indexId } = req.params;
      const body = req.body as SuggestQuery;

      // Validate required fields
      if (!body.prefix || typeof body.prefix !== 'string') {
        res
          .status(400)
          .json({ error: 'Missing or invalid "prefix" field. Must be a non-empty string.' });
        return;
      }

      const tenantId = req.tenantContext!.tenantId;
      const { SearchChunk } = await import('@agent-platform/database/models/search-chunk');
      const limit = body.limit ?? 10;

      // Escape regex special characters in prefix
      const escapedPrefix = body.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      const chunks = await SearchChunk.find({
        indexId,
        tenantId,
        status: 'indexed',
        content: { $regex: `\\b${escapedPrefix}`, $options: 'i' },
      })
        .limit(limit)
        .lean();

      const suggestions: SearchResult[] = chunks.map((chunk: any, idx: number) => ({
        documentId: chunk.documentId,
        chunkId: chunk._id,
        score: 1.0 - idx * 0.01,
        content: chunk.content,
        metadata: chunk.canonicalMetadata ?? chunk.metadata ?? {},
      }));

      res.json(suggestions);
    } catch (error) {
      logger.error('Suggest query failed', {
        indexId: req.params.indexId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

export default createSuggestRouter();

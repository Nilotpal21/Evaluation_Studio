/**
 * Vocabulary Resolution Route
 *
 * POST /api/search/:indexId/resolve — Resolve vocabulary terms to structured filters.
 * Uses VocabularyResolver with real MongoDB-backed domain vocabulary.
 */

import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { verifyIndexOwnership } from '../middleware/verify-index-ownership.js';
import {
  VocabularyResolver,
  getVocabularyResolver,
} from '../services/vocabulary/vocabulary-resolver.js';
import { createLogger } from '@abl/compiler/platform';
import type { VocabularyResolutionResult } from '@agent-platform/search-ai-sdk';

const logger = createLogger('search-runtime-resolve');

export function createResolveRouter(resolver?: VocabularyResolver): RouterType {
  const router: RouterType = Router();
  router.use(authMiddleware);
  router.use('/:indexId', verifyIndexOwnership);

  const vocabularyResolver = resolver ?? getVocabularyResolver();

  /**
   * POST /:indexId/resolve
   *
   * Accepts { query, mode } and returns a VocabularyResolutionResult.
   * Uses the verified indexId as projectKbId (not from request body).
   */
  router.post('/:indexId/resolve', async (req, res) => {
    try {
      const { indexId } = req.params;
      const { query, mode } = req.body as {
        query?: string;
        mode?: 'exact' | 'alias' | 'fuzzy';
      };

      // Validate required fields
      if (!query || typeof query !== 'string') {
        res
          .status(400)
          .json({ error: 'Missing or invalid "query" field. Must be a non-empty string.' });
        return;
      }

      const validModes = ['exact', 'alias', 'fuzzy'];
      if (mode && !validModes.includes(mode)) {
        res
          .status(400)
          .json({ error: `Invalid "mode" field. Must be one of: ${validModes.join(', ')}` });
        return;
      }

      // Use verified indexId as projectKbId (validated by verifyIndexOwnership)
      const tenantId = req.tenantContext?.tenantId;
      if (!tenantId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const result: VocabularyResolutionResult = await vocabularyResolver.resolve(
        indexId,
        query,
        tenantId,
        mode,
      );

      res.json(result);
    } catch (error) {
      logger.error('Vocabulary resolution failed', {
        indexId: req.params.indexId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

export default createResolveRouter();

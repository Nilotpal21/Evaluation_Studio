/**
 * Circuit Status Route
 *
 * Exposes GET /circuit-status for LLM circuit breaker health monitoring.
 * Enables admin UI to show "LLM suggestions temporarily unavailable" banner.
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { mappingSuggestionService } from '../services/mapping-suggestion/index.js';
import { resolveIndexLLMConfig } from '../services/llm-config/resolver.js';
import { createLogger } from '@abl/compiler/platform';
import { assertSearchIndexAccess } from './searchai-route-ownership.js';

const router: RouterType = Router();
const logger = createLogger('circuit-status-route');

/**
 * GET /circuit-status - Get LLM circuit breaker state for the requesting tenant
 *
 * Query params:
 *   - indexId: (required) SearchIndex ID to resolve LLM provider
 *
 * Returns the circuit breaker state for the tenant's primary LLM provider,
 * enabling the admin UI to display availability banners.
 */
router.get('/circuit-status', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantContext?.tenantId;
    if (!tenantId) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }

    const { indexId } = req.query;
    if (!indexId || typeof indexId !== 'string') {
      res.status(400).json({ error: 'indexId query parameter is required' });
      return;
    }

    // Resolve the tenant's primary LLM provider
    let provider: string;
    try {
      if (!(await assertSearchIndexAccess(req, indexId))) {
        res.status(404).json({ error: 'Could not resolve LLM provider for the given index' });
        return;
      }

      const llmConfig = await resolveIndexLLMConfig(tenantId, indexId);
      provider = llmConfig.useCases?.mapping_suggestion?.provider || llmConfig.provider;
    } catch (resolveError) {
      const errorMessage =
        resolveError instanceof Error ? resolveError.message : String(resolveError);
      logger.warn('Failed to resolve LLM config for circuit status', {
        tenantId,
        indexId,
        error: errorMessage,
      });
      res.status(404).json({ error: 'Could not resolve LLM provider for the given index' });
      return;
    }

    const status = await mappingSuggestionService.getCircuitBreakerStatus(tenantId, provider);

    if (!status) {
      // Circuit breaker not available (Redis not configured)
      res.json({
        provider,
        state: 'CLOSED',
        failureCount: 0,
        successCount: 0,
        totalCount: 0,
        failureRate: 0,
        openedAt: null,
        message: 'Circuit breaker monitoring unavailable (Redis not configured)',
      });
      return;
    }

    res.json(status);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to get circuit breaker status', { error: errorMessage });
    res.status(500).json({ error: 'Failed to get circuit breaker status' });
  }
});

export default router;

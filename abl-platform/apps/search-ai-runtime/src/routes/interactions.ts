/**
 * Interactions Router
 *
 * POST /api/search/:indexId/browse/interactions — Record user interaction
 * events (impression, click, filter, expand, remove, search, browse) to
 * ClickHouse facet_interactions table via buffered writer.
 */

import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { verifyIndexOwnership } from '../middleware/verify-index-ownership.js';
import { InteractionWriter } from '../services/browse/interaction-writer.js';
import type { FacetInteractionEvent } from '../services/browse/interaction-writer.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('interactions-router');

// =============================================================================
// MODULE-SCOPE SINGLETON
// =============================================================================

export const interactionWriter = new InteractionWriter();

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

const VALID_INTERACTION_TYPES = [
  'impression',
  'click',
  'filter',
  'expand',
  'remove',
  'search',
  'browse',
] as const;

const interactionEventSchema = z.object({
  attributeType: z.string().min(1).max(256).optional(),
  productType: z.string().min(1).max(256).optional(),
  facetValue: z.string().min(1).max(2000).optional(),
  categoryId: z.string().max(256).optional(),
  interactionType: z.enum(VALID_INTERACTION_TYPES),
  // userId is NOT accepted from clients — always server-derived from auth context
  // to prevent forged interaction data influencing the auto-promotion pipeline.
  // sessionId IS accepted from clients for session correlation (not security-sensitive).
  sessionId: z.string().min(1).max(256).optional(),
});

const interactionBatchSchema = z.object({
  events: z.array(interactionEventSchema).min(1).max(100),
});

// =============================================================================
// ROUTER FACTORY
// =============================================================================

export function createInteractionsRouter(): RouterType {
  const router: RouterType = Router();
  router.use(authMiddleware);
  router.use('/:indexId', verifyIndexOwnership);

  /**
   * POST /:indexId/browse/interactions
   *
   * Accept a batch of interaction events (max 100) and write them to
   * ClickHouse via the buffered writer. Returns { accepted: N }.
   */
  router.post('/:indexId/browse/interactions', async (req, res) => {
    try {
      const tenantId = req.tenantContext?.tenantId;
      if (!tenantId) {
        res.status(401).json({ error: 'Missing tenant context' });
        return;
      }
      const { indexId } = req.params;

      const parsed = interactionBatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'Invalid request body',
          details: parsed.error.issues,
        });
        return;
      }

      const { events } = parsed.data;

      // Map events, filling in tenantId/indexId. userId always from auth context
      // (never client-supplied) to prevent forged interaction data.
      const authUserId = req.user?.id ?? '';
      if (!authUserId) {
        res.status(401).json({ error: 'Missing user identity' });
        return;
      }
      const mappedEvents: FacetInteractionEvent[] = events.map((event) => ({
        tenantId,
        indexId,
        userId: authUserId,
        sessionId: event.sessionId ?? '',
        attributeType: event.attributeType,
        productType: event.productType,
        facetValue: event.facetValue,
        categoryId: event.categoryId,
        interactionType: event.interactionType,
      }));

      interactionWriter.writeEvents(mappedEvents);

      res.json({ accepted: events.length });
    } catch (error) {
      log.error('Interaction tracking endpoint failed', {
        indexId: req.params.indexId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

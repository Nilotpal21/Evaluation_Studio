/**
 * Connector Presence Routes
 *
 * Heartbeat and query endpoints for concurrent editing presence.
 *
 * Mounted under /api/indexes/:indexId/connectors/:connectorId/presence
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { createLogger } from '@abl/compiler/platform';
import * as presenceService from '../services/connector-presence.service.js';
import { requireConnectorIndexAccessFromParams } from './searchai-route-ownership.js';

const logger = createLogger('connector-presence-routes');
const router: RouterType = Router();

router.use(authMiddleware);
router.use('/:indexId/connectors/:connectorId', requireConnectorIndexAccessFromParams());

// ─── Zod Validation Schemas ─────────────────────────────────────────────

const routeParams = z.strictObject({
  indexId: z.string().min(1),
  connectorId: z.string().min(1),
});

const heartbeatBody = z.strictObject({
  activeTab: z.string().min(1),
});

// ─── Routes ─────────────────────────────────────────────────────────────

/**
 * POST /:indexId/connectors/:connectorId/presence/heartbeat
 * Send a presence heartbeat (userId/userName from auth context, NOT body)
 */
router.post(
  '/:indexId/connectors/:connectorId/presence/heartbeat',
  async (req: Request, res: Response) => {
    const paramResult = routeParams.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: paramResult.error.message },
      });
      return;
    }

    const bodyResult = heartbeatBody.safeParse(req.body);
    if (!bodyResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_BODY', message: 'activeTab is required' },
      });
      return;
    }

    const userId = req.tenantContext?.userId ?? 'unknown';
    const userName = req.user?.email ?? req.user?.name ?? 'Unknown User';

    await presenceService.sendHeartbeat(
      paramResult.data.connectorId,
      req.tenantContext!.tenantId,
      userId,
      userName,
      bodyResult.data.activeTab,
    );

    res.json({ success: true });
  },
);

/**
 * GET /:indexId/connectors/:connectorId/presence
 * Get active editors for a connector
 */
router.get('/:indexId/connectors/:connectorId/presence', async (req: Request, res: Response) => {
  const paramResult = routeParams.safeParse(req.params);
  if (!paramResult.success) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_PARAMS', message: paramResult.error.message },
    });
    return;
  }

  const editors = await presenceService.getActiveEditors(
    paramResult.data.connectorId,
    req.tenantContext!.tenantId,
  );

  res.json({ success: true, data: { editors } });
});

export default router;

/**
 * Connector Policy Routes
 *
 * Read-only endpoint for org-level connector policies.
 *
 * Mounted under /api/indexes/:indexId/connector-policy
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { createLogger } from '@abl/compiler/platform';
import * as policyService from '../services/connector-policy.service.js';
import { requireSearchIndexAccessFromParams } from './searchai-route-ownership.js';

const logger = createLogger('connector-policy-routes');
const router: RouterType = Router();

router.use(authMiddleware);
router.use('/:indexId', requireSearchIndexAccessFromParams());

// ─── Zod Validation Schemas ─────────────────────────────────────────────

const routeParams = z.strictObject({
  indexId: z.string().min(1),
});

// ─── Routes ─────────────────────────────────────────────────────────────

/**
 * GET /:indexId/connector-policy
 * Returns applicable connector policies for the current tenant
 */
router.get('/:indexId/connector-policy', async (req: Request, res: Response) => {
  const paramResult = routeParams.safeParse(req.params);
  if (!paramResult.success) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_PARAMS', message: paramResult.error.message },
    });
    return;
  }

  try {
    const data = await policyService.getConnectorPolicy(req.tenantContext!.tenantId);
    res.json({ success: true, data });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`POLICY_FETCH_FAILED: ${msg}`);
    res.status(500).json({
      success: false,
      error: { code: 'POLICY_FETCH_FAILED', message: 'Internal server error' },
    });
  }
});

export default router;

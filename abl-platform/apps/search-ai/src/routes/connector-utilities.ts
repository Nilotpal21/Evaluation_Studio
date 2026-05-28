/**
 * Connector Utility Routes
 *
 * Site statuses, filter analysis, and check-site-access endpoints
 * for error states and empty states.
 *
 * Mounted under /api/indexes via server.ts
 */

import { Router } from 'express';
import type { Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { createLogger } from '@abl/compiler/platform';
import * as utilityService from '../services/connector-utility.service.js';
import { ConnectorError } from '../services/connector.service.js';
import { requireConnectorIndexAccessFromParams } from './searchai-route-ownership.js';

const logger = createLogger('connector-utility-routes');
const router: RouterType = Router();

router.use(authMiddleware);
router.use('/:indexId/connectors/:connectorId', requireConnectorIndexAccessFromParams());

// ─── Zod Validation Schemas ──────────────────────────────────────────────

const utilityParams = z.strictObject({
  indexId: z.string().min(1),
  connectorId: z.string().min(1),
});

const checkSiteAccessBody = z.strictObject({
  siteUrl: z.string().url(),
});

// ─── Helpers ─────────────────────────────────────────────────────────────

function handleError(res: Response, error: unknown, fallbackCode: string): void {
  if (error instanceof ConnectorError) {
    res.status(error.statusCode).json({
      success: false,
      error: { code: error.code, message: error.message },
    });
    return;
  }
  const msg = error instanceof Error ? error.message : String(error);
  logger.error(`${fallbackCode}: ${msg}`);
  res.status(500).json({
    success: false,
    error: { code: fallbackCode, message: 'Internal server error' },
  });
}

// ─── Routes ──────────────────────────────────────────────────────────────

// GET /:indexId/connectors/:connectorId/site-statuses
router.get(
  '/:indexId/connectors/:connectorId/site-statuses',
  async (req: Request, res: Response) => {
    try {
      const parsed = utilityParams.safeParse(req.params);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_PARAMS', message: parsed.error.message },
        });
        return;
      }

      const tenantId = req.tenantContext!.tenantId;
      const data = await utilityService.getSiteStatuses(parsed.data.connectorId, tenantId);
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'SITE_STATUSES_FAILED');
    }
  },
);

// GET /:indexId/connectors/:connectorId/filter-analysis
router.get(
  '/:indexId/connectors/:connectorId/filter-analysis',
  async (req: Request, res: Response) => {
    try {
      const parsed = utilityParams.safeParse(req.params);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_PARAMS', message: parsed.error.message },
        });
        return;
      }

      const tenantId = req.tenantContext!.tenantId;
      const data = await utilityService.getFilterAnalysis(parsed.data.connectorId, tenantId);
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'FILTER_ANALYSIS_FAILED');
    }
  },
);

// POST /:indexId/connectors/:connectorId/check-site-access
router.post(
  '/:indexId/connectors/:connectorId/check-site-access',
  async (req: Request, res: Response) => {
    try {
      const paramsParsed = utilityParams.safeParse(req.params);
      if (!paramsParsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_PARAMS', message: paramsParsed.error.message },
        });
        return;
      }

      const bodyParsed = checkSiteAccessBody.safeParse(req.body);
      if (!bodyParsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_BODY', message: bodyParsed.error.message },
        });
        return;
      }

      const tenantId = req.tenantContext!.tenantId;
      const data = await utilityService.checkSiteAccess(
        paramsParsed.data.connectorId,
        tenantId,
        bodyParsed.data.siteUrl,
      );
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'CHECK_SITE_ACCESS_FAILED');
    }
  },
);

export default router;

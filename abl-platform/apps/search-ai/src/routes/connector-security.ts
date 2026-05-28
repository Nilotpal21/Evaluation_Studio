/**
 * Connector Security Routes
 *
 * Security overview, blast radius, emergency revoke, and security export
 * for enterprise connectors.
 *
 * Mounted under /api/indexes/:indexId/connectors/:connectorId/security
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { createLogger } from '@abl/compiler/platform';
import { ConnectorError } from '../services/connector.service.js';
import * as securityService from '../services/connector-security.service.js';
import { sendGeneratedExport } from './export-response.js';
import { requireConnectorIndexAccessFromParams } from './searchai-route-ownership.js';

const logger = createLogger('connector-security-routes');
const router: RouterType = Router();

router.use(authMiddleware);
router.use('/:indexId/connectors/:connectorId', requireConnectorIndexAccessFromParams());

// ─── Zod Validation Schemas ─────────────────────────────────────────────

const routeParams = z.strictObject({
  indexId: z.string().min(1),
  connectorId: z.string().min(1),
});

const revokeBody = z.strictObject({
  confirmPhrase: z.string().min(1),
});

const exportQuery = z.strictObject({
  format: z.enum(['json', 'yaml', 'markdown']),
});

// ─── Error Handler (ConnectorError-aware) ───────────────────────────────

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

// ─── Static routes FIRST ────────────────────────────────────────────────

/**
 * GET /:indexId/connectors/:connectorId/security/overview
 */
router.get(
  '/:indexId/connectors/:connectorId/security/overview',
  async (req: Request, res: Response) => {
    const paramResult = routeParams.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: paramResult.error.message },
      });
      return;
    }

    try {
      const data = await securityService.getSecurityOverview(
        paramResult.data.connectorId,
        req.tenantContext!.tenantId,
      );
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'SECURITY_OVERVIEW_FAILED');
    }
  },
);

/**
 * GET /:indexId/connectors/:connectorId/security/blast-radius
 */
router.get(
  '/:indexId/connectors/:connectorId/security/blast-radius',
  async (req: Request, res: Response) => {
    const paramResult = routeParams.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: paramResult.error.message },
      });
      return;
    }

    try {
      const data = await securityService.getBlastRadius(
        paramResult.data.connectorId,
        req.tenantContext!.tenantId,
      );
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'BLAST_RADIUS_FAILED');
    }
  },
);

/**
 * GET /:indexId/connectors/:connectorId/security/export
 */
router.get(
  '/:indexId/connectors/:connectorId/security/export',
  async (req: Request, res: Response) => {
    const paramResult = routeParams.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: paramResult.error.message },
      });
      return;
    }

    const queryResult = exportQuery.safeParse(req.query);
    if (!queryResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_QUERY', message: 'format must be json, yaml, or markdown' },
      });
      return;
    }

    try {
      const result = await securityService.exportSecurityDocument(
        paramResult.data.connectorId,
        req.tenantContext!.tenantId,
        queryResult.data.format,
      );
      sendGeneratedExport(res, result);
    } catch (error) {
      handleError(res, error, 'SECURITY_EXPORT_FAILED');
    }
  },
);

/**
 * POST /:indexId/connectors/:connectorId/security/emergency-revoke
 */
router.post(
  '/:indexId/connectors/:connectorId/security/emergency-revoke',
  async (req: Request, res: Response) => {
    const paramResult = routeParams.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: paramResult.error.message },
      });
      return;
    }

    const bodyResult = revokeBody.safeParse(req.body);
    if (!bodyResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_BODY', message: 'confirmPhrase is required' },
      });
      return;
    }

    try {
      const actor = req.user?.email ?? req.tenantContext?.userId ?? 'unknown';
      const data = await securityService.emergencyRevoke(
        paramResult.data.connectorId,
        req.tenantContext!.tenantId,
        actor,
      );
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'EMERGENCY_REVOKE_FAILED');
    }
  },
);

export default router;

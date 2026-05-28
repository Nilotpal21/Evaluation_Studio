/**
 * Connector Config Management Routes
 *
 * Config export, drift detection, drift resolution, and config import
 * for enterprise connectors.
 *
 * Mounted under /api/indexes/:indexId/connectors/:connectorId/config
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { createLogger } from '@abl/compiler/platform';
import { ConnectorError } from '../services/connector.service.js';
import * as configMgmtService from '../services/connector-config-mgmt.service.js';
import { requireConnectorIndexAccessFromParams } from './searchai-route-ownership.js';

const logger = createLogger('connector-config-mgmt-routes');
const router: RouterType = Router();

router.use(authMiddleware);
router.use('/:indexId/connectors/:connectorId', requireConnectorIndexAccessFromParams());

// ─── Zod Validation Schemas ─────────────────────────────────────────────

const routeParams = z.strictObject({
  indexId: z.string().min(1),
  connectorId: z.string().min(1),
});

const exportQuery = z.strictObject({
  format: z.enum(['json', 'yaml']).default('json'),
  includeScope: z.coerce.boolean().default(true),
  includeFilters: z.coerce.boolean().default(true),
  includeSchedule: z.coerce.boolean().default(true),
  includePermissionMode: z.coerce.boolean().default(true),
  includeCredentials: z.coerce.boolean().default(false),
});

const importBody = z.strictObject({
  config: z.record(z.unknown()),
});

// ─── Error Handler ──────────────────────────────────────────────────────

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

// ─── Static routes FIRST ─────────────────────────────────────────────────

/**
 * GET /:indexId/connectors/:connectorId/config/export
 * Export connector configuration as JSON or YAML
 */
router.get(
  '/:indexId/connectors/:connectorId/config/export',
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
        error: { code: 'INVALID_QUERY', message: queryResult.error.message },
      });
      return;
    }

    try {
      const data = await configMgmtService.exportConfig(
        paramResult.data.connectorId,
        req.tenantContext!.tenantId,
        queryResult.data,
      );
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'CONFIG_EXPORT_FAILED');
    }
  },
);

/**
 * GET /:indexId/connectors/:connectorId/config/drift
 * Detect config drift against template
 */
router.get(
  '/:indexId/connectors/:connectorId/config/drift',
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
      const data = await configMgmtService.getConfigDrift(
        paramResult.data.connectorId,
        req.tenantContext!.tenantId,
      );
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'DRIFT_DETECTION_FAILED');
    }
  },
);

/**
 * POST /:indexId/connectors/:connectorId/config/drift/reapply-template
 * Reapply template config, overwriting current deviations
 */
router.post(
  '/:indexId/connectors/:connectorId/config/drift/reapply-template',
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
      const version = await configMgmtService.reapplyTemplate(
        paramResult.data.connectorId,
        req.tenantContext!.tenantId,
        req.tenantContext!.userId ?? 'system',
      );
      res.json({ success: true, data: { version } });
    } catch (error) {
      handleError(res, error, 'REAPPLY_TEMPLATE_FAILED');
    }
  },
);

/**
 * POST /:indexId/connectors/:connectorId/config/drift/update-template
 * Update template to match current connector config
 */
router.post(
  '/:indexId/connectors/:connectorId/config/drift/update-template',
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
      const data = await configMgmtService.updateTemplateFromCurrent(
        paramResult.data.connectorId,
        req.tenantContext!.tenantId,
        req.tenantContext!.userId ?? 'system',
      );
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'UPDATE_TEMPLATE_FAILED');
    }
  },
);

/**
 * POST /:indexId/connectors/:connectorId/config/drift/ignore
 * Ignore drift notice for this connector
 */
router.post(
  '/:indexId/connectors/:connectorId/config/drift/ignore',
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
      const data = await configMgmtService.ignoreDrift(
        paramResult.data.connectorId,
        req.tenantContext!.tenantId,
      );
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'IGNORE_DRIFT_FAILED');
    }
  },
);

/**
 * POST /:indexId/connectors/:connectorId/config/import
 * Preview an imported config (diff against current)
 */
router.post(
  '/:indexId/connectors/:connectorId/config/import',
  async (req: Request, res: Response) => {
    const paramResult = routeParams.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: paramResult.error.message },
      });
      return;
    }

    const bodyResult = importBody.safeParse(req.body);
    if (!bodyResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_BODY', message: bodyResult.error.message },
      });
      return;
    }

    try {
      const data = await configMgmtService.previewImport(
        paramResult.data.connectorId,
        req.tenantContext!.tenantId,
        bodyResult.data.config,
      );
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'IMPORT_PREVIEW_FAILED');
    }
  },
);

/**
 * POST /:indexId/connectors/:connectorId/config/import/confirm
 * Confirm and apply imported config
 */
router.post(
  '/:indexId/connectors/:connectorId/config/import/confirm',
  async (req: Request, res: Response) => {
    const paramResult = routeParams.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: paramResult.error.message },
      });
      return;
    }

    const bodyResult = importBody.safeParse(req.body);
    if (!bodyResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_BODY', message: bodyResult.error.message },
      });
      return;
    }

    try {
      const version = await configMgmtService.confirmImport(
        paramResult.data.connectorId,
        req.tenantContext!.tenantId,
        bodyResult.data.config,
        req.tenantContext!.userId ?? 'system',
      );
      res.json({ success: true, data: { version } });
    } catch (error) {
      handleError(res, error, 'IMPORT_CONFIRM_FAILED');
    }
  },
);

export default router;

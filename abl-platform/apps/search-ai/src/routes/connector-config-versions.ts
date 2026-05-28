/**
 * Connector Config Version Routes
 *
 * Provides version history, snapshot retrieval, and diff endpoints
 * for connector configuration changes.
 *
 * Mounted under /api/indexes/:indexId/connectors/:connectorId/config/versions
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { createLogger } from '@abl/compiler/platform';
import * as versionService from '../services/connector-config-version.service.js';
import { ConnectorError } from '../services/connector.service.js';
import { requireConnectorIndexAccessFromParams } from './searchai-route-ownership.js';

const logger = createLogger('connector-config-version-routes');
const router: RouterType = Router();

router.use(authMiddleware);
router.use('/:indexId/connectors/:connectorId', requireConnectorIndexAccessFromParams());

// ─── Zod Validation Schemas ─────────────────────────────────────────────

const connectorIdParam = z.strictObject({
  indexId: z.string().min(1),
  connectorId: z.string().min(1),
});

const versionParams = z.strictObject({
  indexId: z.string().min(1),
  connectorId: z.string().min(1),
  versionNumber: z.coerce.number().int().positive(),
});

const historyQuery = z.strictObject({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

// diffQuery schema deferred to Wave 4 (config management) when diff UI is built

const createVersionBody = z.strictObject({
  configSnapshot: z.record(z.unknown()),
  changedFields: z.array(z.string()),
  changedBy: z.string().min(1),
  changeSource: z.enum(['user', 'system', 'import', 'restore']),
  summary: z.string(),
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

// ─── Routes ─────────────────────────────────────────────────────────────

/**
 * GET /:indexId/connectors/:connectorId/config/versions
 * List version history (paginated, newest first)
 */
router.get(
  '/:indexId/connectors/:connectorId/config/versions',
  async (req: Request, res: Response) => {
    const paramResult = connectorIdParam.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: paramResult.error.message },
      });
      return;
    }

    const queryResult = historyQuery.safeParse(req.query);
    if (!queryResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_QUERY', message: queryResult.error.message },
      });
      return;
    }

    try {
      const data = await versionService.getVersionHistory(
        paramResult.data.connectorId,
        req.tenantContext!.tenantId,
        queryResult.data,
      );
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'VERSION_HISTORY_FAILED');
    }
  },
);

// ─── Static routes MUST be registered BEFORE :versionNumber parameterized route ──

const diffQuery = z.strictObject({
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive(),
});

/**
 * GET /:indexId/connectors/:connectorId/config/versions/diff
 * Compare two version snapshots
 */
router.get(
  '/:indexId/connectors/:connectorId/config/versions/diff',
  async (req: Request, res: Response) => {
    const paramResult = connectorIdParam.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: paramResult.error.message },
      });
      return;
    }

    const queryResult = diffQuery.safeParse(req.query);
    if (!queryResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_QUERY', message: queryResult.error.message },
      });
      return;
    }

    try {
      const data = await versionService.diffVersions(
        paramResult.data.connectorId,
        req.tenantContext!.tenantId,
        queryResult.data.from,
        queryResult.data.to,
      );
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'VERSION_DIFF_FAILED');
    }
  },
);

// ─── Restore Route (static — registered BEFORE :versionNumber) ──────────

const restoreBody = z.strictObject({
  version: z.coerce.number().int().positive(),
});

/**
 * POST /:indexId/connectors/:connectorId/config/versions/restore
 * Restore a previous version's configuration
 */
router.post(
  '/:indexId/connectors/:connectorId/config/versions/restore',
  async (req: Request, res: Response) => {
    const paramResult = connectorIdParam.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: paramResult.error.message },
      });
      return;
    }

    const bodyResult = restoreBody.safeParse(req.body);
    if (!bodyResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_BODY', message: bodyResult.error.message },
      });
      return;
    }

    try {
      const version = await versionService.restoreVersion(
        paramResult.data.connectorId,
        req.tenantContext!.tenantId,
        bodyResult.data.version,
        req.tenantContext!.userId ?? 'system',
      );
      res.json({ success: true, data: { version } });
    } catch (error) {
      handleError(res, error, 'VERSION_RESTORE_FAILED');
    }
  },
);

// ─── Parameterized route AFTER static routes (diff, restore) ──────────────

/**
 * GET /:indexId/connectors/:connectorId/config/versions/:versionNumber
 * Get a specific version snapshot
 */
router.get(
  '/:indexId/connectors/:connectorId/config/versions/:versionNumber',
  async (req: Request, res: Response) => {
    const paramResult = versionParams.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: paramResult.error.message },
      });
      return;
    }

    try {
      const version = await versionService.getVersionSnapshot(
        paramResult.data.connectorId,
        req.tenantContext!.tenantId,
        paramResult.data.versionNumber,
      );

      if (!version) {
        res.status(404).json({
          success: false,
          error: { code: 'VERSION_NOT_FOUND', message: 'Version not found' },
        });
        return;
      }

      res.json({ success: true, data: { version } });
    } catch (error) {
      handleError(res, error, 'VERSION_SNAPSHOT_FAILED');
    }
  },
);

/**
 * POST /:indexId/connectors/:connectorId/config/versions
 * Create a new version snapshot
 */
router.post(
  '/:indexId/connectors/:connectorId/config/versions',
  async (req: Request, res: Response) => {
    const paramResult = connectorIdParam.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: paramResult.error.message },
      });
      return;
    }

    const bodyResult = createVersionBody.safeParse(req.body);
    if (!bodyResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_BODY', message: bodyResult.error.message },
      });
      return;
    }

    try {
      const version = await versionService.createVersion({
        connectorId: paramResult.data.connectorId,
        tenantId: req.tenantContext!.tenantId,
        ...bodyResult.data,
      });
      res.status(201).json({ success: true, data: { version } });
    } catch (error) {
      handleError(res, error, 'VERSION_CREATE_FAILED');
    }
  },
);

export default router;

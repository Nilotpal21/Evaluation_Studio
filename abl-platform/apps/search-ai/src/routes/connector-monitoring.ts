/**
 * Connector Monitoring Routes
 *
 * Overview, content-breakdown, sync-history, and permission-schedule endpoints
 * for the monitoring/overview tab.
 *
 * Mounted under /api/indexes via server.ts
 */

import { Router } from 'express';
import type { Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { createLogger } from '@abl/compiler/platform';
import * as monitoringService from '../services/connector-monitoring.service.js';
import { ConnectorError } from '../services/connector.service.js';
import { requireConnectorIndexAccessFromParams } from './searchai-route-ownership.js';

const logger = createLogger('connector-monitoring-routes');
const router: RouterType = Router();

router.use(authMiddleware);
router.use('/:indexId/connectors/:connectorId', requireConnectorIndexAccessFromParams());

// ─── Zod Validation Schemas ──────────────────────────────────────────────

const monitoringParams = z.strictObject({
  indexId: z.string().min(1),
  connectorId: z.string().min(1),
});

const syncHistoryQuery = z.strictObject({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const permissionScheduleBody = z
  .strictObject({
    schedule: z.enum(['manual', 'daily', 'weekly', 'custom']),
    cronExpression: z.string().min(1).optional(),
  })
  .refine(
    (data) => data.schedule !== 'custom' || (data.cronExpression && data.cronExpression.length > 0),
    {
      message: 'cronExpression is required when schedule is "custom"',
      path: ['cronExpression'],
    },
  );

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

// GET /:indexId/connectors/:connectorId/overview
router.get('/:indexId/connectors/:connectorId/overview', async (req: Request, res: Response) => {
  try {
    const parsed = monitoringParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: parsed.error.message },
      });
      return;
    }

    const tenantId = req.tenantContext!.tenantId;
    const data = await monitoringService.getOverview(parsed.data.connectorId, tenantId);
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, 'OVERVIEW_FAILED');
  }
});

// GET /:indexId/connectors/:connectorId/content-breakdown
router.get(
  '/:indexId/connectors/:connectorId/content-breakdown',
  async (req: Request, res: Response) => {
    try {
      const parsed = monitoringParams.safeParse(req.params);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_PARAMS', message: parsed.error.message },
        });
        return;
      }

      const tenantId = req.tenantContext!.tenantId;
      const data = await monitoringService.getContentBreakdown(parsed.data.connectorId, tenantId);
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'CONTENT_BREAKDOWN_FAILED');
    }
  },
);

// GET /:indexId/connectors/:connectorId/sync-history
router.get(
  '/:indexId/connectors/:connectorId/sync-history',
  async (req: Request, res: Response) => {
    try {
      const paramsParsed = monitoringParams.safeParse(req.params);
      if (!paramsParsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_PARAMS', message: paramsParsed.error.message },
        });
        return;
      }

      const queryParsed = syncHistoryQuery.safeParse(req.query);
      if (!queryParsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_QUERY', message: queryParsed.error.message },
        });
        return;
      }

      const tenantId = req.tenantContext!.tenantId;
      const data = await monitoringService.getSyncHistory(paramsParsed.data.connectorId, tenantId, {
        page: queryParsed.data.page,
        limit: queryParsed.data.limit,
      });
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'SYNC_HISTORY_FAILED');
    }
  },
);

// PUT /:indexId/connectors/:connectorId/permission-schedule (T-33)
router.put(
  '/:indexId/connectors/:connectorId/permission-schedule',
  async (req: Request, res: Response) => {
    try {
      const paramsParsed = monitoringParams.safeParse(req.params);
      if (!paramsParsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_PARAMS', message: paramsParsed.error.message },
        });
        return;
      }

      const bodyParsed = permissionScheduleBody.safeParse(req.body);
      if (!bodyParsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_BODY', message: bodyParsed.error.message },
        });
        return;
      }

      const tenantId = req.tenantContext!.tenantId;
      const data = await monitoringService.updatePermissionSchedule(
        paramsParsed.data.connectorId,
        tenantId,
        bodyParsed.data.schedule,
        bodyParsed.data.cronExpression,
      );
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'PERMISSION_SCHEDULE_FAILED');
    }
  },
);

export default router;

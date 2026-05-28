/**
 * Connector Error Recovery Routes
 *
 * Error status classification and retry action endpoints.
 * Mounted under /api/indexes via server.ts
 */

import { Router } from 'express';
import type { Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { createLogger } from '@abl/compiler/platform';
import * as errorService from '../services/connector-error.service.js';
import * as repo from '../repos/connector.repository.js';
import { ConnectorError } from '../services/connector.service.js';
import { requireConnectorIndexAccessFromParams } from './searchai-route-ownership.js';

const logger = createLogger('connector-error-recovery-routes');
const router: RouterType = Router();

router.use(authMiddleware);
router.use('/:indexId/connectors/:connectorId', requireConnectorIndexAccessFromParams());

// ─── Zod Validation Schemas ──────────────────────────────────────────────

const errorRecoveryParams = z.strictObject({
  indexId: z.string().min(1),
  connectorId: z.string().min(1),
});

const retryBody = z.strictObject({
  action: z.enum([
    'retry_auth',
    'retry_discovery',
    'resume_sync',
    'retry_failed_sites',
    'rerun_full_sync',
    'rerun_full_discovery',
  ]),
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

// GET /:indexId/connectors/:connectorId/error-status
router.get(
  '/:indexId/connectors/:connectorId/error-status',
  async (req: Request, res: Response) => {
    try {
      const parsed = errorRecoveryParams.safeParse(req.params);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_PARAMS', message: parsed.error.message },
        });
        return;
      }

      const tenantId = req.tenantContext!.tenantId;
      const connector = await repo.findConnectorByIdAndTenantLean(
        parsed.data.connectorId,
        tenantId,
      );
      if (!connector) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Connector not found' },
        });
        return;
      }

      const classified = errorService.classifyError(connector);
      res.json({ success: true, data: classified });
    } catch (error) {
      handleError(res, error, 'ERROR_STATUS_FAILED');
    }
  },
);

// POST /:indexId/connectors/:connectorId/retry
router.post('/:indexId/connectors/:connectorId/retry', async (req: Request, res: Response) => {
  try {
    const paramsParsed = errorRecoveryParams.safeParse(req.params);
    if (!paramsParsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: paramsParsed.error.message },
      });
      return;
    }

    const bodyParsed = retryBody.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_BODY', message: bodyParsed.error.message },
      });
      return;
    }

    const tenantId = req.tenantContext!.tenantId;
    const data = await errorService.executeRetry(
      paramsParsed.data.connectorId,
      tenantId,
      bodyParsed.data.action,
    );
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, 'RETRY_FAILED');
  }
});

export default router;

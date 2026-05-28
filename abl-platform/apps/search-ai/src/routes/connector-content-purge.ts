/**
 * Connector Content Purge Routes
 *
 * Manages content purge lifecycle: initiate, poll status, cancel, retry.
 *
 * Mounted under /api/indexes/:indexId/connectors/:connectorId/content
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { createLogger } from '@abl/compiler/platform';
import type {
  IConnectorCleanupJob,
  IConnectorConfig,
  ISearchIndex,
  ISearchSource,
} from '@agent-platform/database';
import { ConnectorError } from '../services/connector.service.js';
import * as purgeService from '../services/connector-content-purge.service.js';
import { getLazyModel } from '../db/index.js';
import { applyProjectScopeFilter } from './project-scope.js';

const logger = createLogger('connector-content-purge-routes');
const router: RouterType = Router();

router.use(authMiddleware);

// ─── Zod Validation Schemas ─────────────────────────────────────────────

const routeParams = z.strictObject({
  indexId: z.string().min(1),
  connectorId: z.string().min(1),
});

const cleanupIdParam = z.strictObject({
  indexId: z.string().min(1),
  connectorId: z.string().min(1),
  cleanupId: z.string().min(1),
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

async function assertConnectorBelongsToIndex(
  req: Request,
  indexId: string,
  connectorId: string,
  cleanupId?: string,
): Promise<void> {
  const tenantId = req.tenantContext!.tenantId;
  const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');
  const ConnectorConfig = getLazyModel<IConnectorConfig>('ConnectorConfig');
  const SearchSource = getLazyModel<ISearchSource>('SearchSource');

  const index = await SearchIndex.findOne(
    applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
  )
    .select('_id')
    .lean();
  if (!index) {
    throw new ConnectorError('NOT_FOUND', 'Index not found', 404);
  }

  const connector = await ConnectorConfig.findOne({ _id: connectorId, tenantId })
    .select('_id sourceId')
    .lean();
  const sourceId = connector?.sourceId;
  if (!connector || !sourceId) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  const source = await SearchSource.findOne({ _id: sourceId, tenantId, indexId })
    .select('_id')
    .lean();
  if (!source) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  if (cleanupId) {
    const ConnectorCleanupJob = getLazyModel<IConnectorCleanupJob>('ConnectorCleanupJob');
    const cleanup = await ConnectorCleanupJob.findOne({
      _id: cleanupId,
      tenantId,
      connectorId,
    })
      .select('_id')
      .lean();
    if (!cleanup) {
      throw new ConnectorError('NOT_FOUND', 'Cleanup job not found', 404);
    }
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────

/**
 * POST /:indexId/connectors/:connectorId/content/purge
 * Initiate a content purge
 */
router.post(
  '/:indexId/connectors/:connectorId/content/purge',
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
      const actor = req.user?.email ?? req.tenantContext?.userId ?? 'unknown';
      await assertConnectorBelongsToIndex(
        req,
        paramResult.data.indexId,
        paramResult.data.connectorId,
      );
      const data = await purgeService.initiatePurge(
        paramResult.data.connectorId,
        req.tenantContext!.tenantId,
        paramResult.data.indexId,
        actor,
      );
      res.status(201).json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'PURGE_INITIATE_FAILED');
    }
  },
);

/**
 * GET /:indexId/connectors/:connectorId/content/purge/:cleanupId
 * Poll purge status
 */
router.get(
  '/:indexId/connectors/:connectorId/content/purge/:cleanupId',
  async (req: Request, res: Response) => {
    const paramResult = cleanupIdParam.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: paramResult.error.message },
      });
      return;
    }

    try {
      await assertConnectorBelongsToIndex(
        req,
        paramResult.data.indexId,
        paramResult.data.connectorId,
        paramResult.data.cleanupId,
      );
      const data = await purgeService.getPurgeStatus(
        paramResult.data.cleanupId,
        req.tenantContext!.tenantId,
        paramResult.data.connectorId,
      );
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'PURGE_STATUS_FAILED');
    }
  },
);

/**
 * POST /:indexId/connectors/:connectorId/content/purge/:cleanupId/cancel
 * Cancel an in-progress purge
 */
router.post(
  '/:indexId/connectors/:connectorId/content/purge/:cleanupId/cancel',
  async (req: Request, res: Response) => {
    const paramResult = cleanupIdParam.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: paramResult.error.message },
      });
      return;
    }

    try {
      await assertConnectorBelongsToIndex(
        req,
        paramResult.data.indexId,
        paramResult.data.connectorId,
        paramResult.data.cleanupId,
      );
      const data = await purgeService.cancelPurge(
        paramResult.data.cleanupId,
        req.tenantContext!.tenantId,
        paramResult.data.connectorId,
      );
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'PURGE_CANCEL_FAILED');
    }
  },
);

/**
 * POST /:indexId/connectors/:connectorId/content/purge/:cleanupId/retry
 * Retry a failed purge
 */
router.post(
  '/:indexId/connectors/:connectorId/content/purge/:cleanupId/retry',
  async (req: Request, res: Response) => {
    const paramResult = cleanupIdParam.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: paramResult.error.message },
      });
      return;
    }

    try {
      await assertConnectorBelongsToIndex(
        req,
        paramResult.data.indexId,
        paramResult.data.connectorId,
        paramResult.data.cleanupId,
      );
      const data = await purgeService.retryPurge(
        paramResult.data.cleanupId,
        req.tenantContext!.tenantId,
        paramResult.data.connectorId,
        paramResult.data.indexId,
      );
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'PURGE_RETRY_FAILED');
    }
  },
);

export default router;

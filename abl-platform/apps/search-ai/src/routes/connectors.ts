/**
 * Connector Management Routes
 *
 * Thin route layer: auth → validate → service call → response.
 * Business logic lives in connector.service.ts; DB access in connector.repository.ts.
 *
 * Mounted under /api/indexes/:indexId/connectors and /api/connectors
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { createLogger } from '@abl/compiler/platform';
import * as connectorService from '../services/connector.service.js';
import { ConnectorError } from '../services/connector.service.js';
import { assertConnectorIndexAccess, assertSearchIndexAccess } from './searchai-route-ownership.js';

const logger = createLogger('connector-routes');
const router: RouterType = Router();

router.use(authMiddleware);

/** Map ConnectorError to HTTP response; log unexpected errors. */
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
    error: { code: fallbackCode, message: msg },
  });
}

// ─── CRUD ────────────────────────────────────────────────────────────────

const listSourcesQuery = z.strictObject({
  search: z.string().optional(),
  status: z.string().optional(),
  type: z.string().optional(),
  sortBy: z.enum(['name', 'status', 'lastSync', 'documentCount']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  groupBy: z.enum(['none', 'type', 'status', 'tenant']).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

router.get('/:indexId/connectors', async (req: Request, res: Response) => {
  try {
    if (!(await assertSearchIndexAccess(req, req.params.indexId))) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Index not found' },
      });
      return;
    }

    const queryResult = listSourcesQuery.safeParse(req.query);
    if (!queryResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_QUERY', message: queryResult.error.message },
      });
      return;
    }

    const options = {
      search: queryResult.data.search,
      status: queryResult.data.status?.split(',').filter(Boolean),
      type: queryResult.data.type?.split(',').filter(Boolean),
      sortBy: queryResult.data.sortBy,
      sortDir: queryResult.data.sortDir,
      groupBy: queryResult.data.groupBy,
      page: queryResult.data.page,
      limit: queryResult.data.limit,
    };

    const data = await connectorService.listConnectors(
      req.params.indexId,
      req.tenantContext!.tenantId,
      options,
    );
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, 'LIST_FAILED');
  }
});

router.post('/:indexId/connectors', async (req: Request, res: Response) => {
  try {
    if (!(await assertSearchIndexAccess(req, req.params.indexId))) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Index not found' },
      });
      return;
    }

    const result = await connectorService.createConnector(
      req.params.indexId,
      req.tenantContext!.tenantId,
      req.body,
    );
    const status = result.existing ? 200 : 201;
    res
      .status(status)
      .json({ success: true, data: { connector: result.connector, source: result.source } });
  } catch (error) {
    handleError(res, error, 'CREATE_FAILED');
  }
});

// ─── Static Routes (MUST be before parameterized :connectorId routes) ──

const checkNameQuery = z.strictObject({ name: z.string().min(1).max(200) });
const generateEmailBody = z.strictObject({ type: z.enum(['app_registration_setup']) });

const bulkActionBody = z.strictObject({
  action: z.enum([
    'pause',
    'resume',
    'sync_now',
    'delete',
    're_auth',
    'apply_schedule',
    'export_configs',
  ]),
  sourceIds: z.array(z.string().min(1)).min(1).max(50),
  params: z.record(z.unknown()).optional(),
});

router.post('/:indexId/connectors/bulk-actions', async (req: Request, res: Response) => {
  if (!(await assertSearchIndexAccess(req, req.params.indexId))) {
    res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Index not found' },
    });
    return;
  }

  const bodyResult = bulkActionBody.safeParse(req.body);
  if (!bodyResult.success) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_BODY', message: bodyResult.error.message },
    });
    return;
  }

  try {
    const data = await connectorService.executeBulkAction(
      req.params.indexId,
      req.tenantContext!.tenantId,
      bodyResult.data.action,
      bodyResult.data.sourceIds,
      bodyResult.data.params,
    );
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, 'BULK_ACTION_FAILED');
  }
});

router.get('/:indexId/connectors/check-name', async (req: Request, res: Response) => {
  try {
    if (!(await assertSearchIndexAccess(req, req.params.indexId))) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Index not found' },
      });
      return;
    }

    const parsed = checkNameQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Query parameter "name" is required (1-200 chars)',
        },
      });
      return;
    }
    const data = await connectorService.checkConnectorName(
      req.params.indexId,
      req.tenantContext!.tenantId,
      parsed.data.name,
    );
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, 'CHECK_NAME_FAILED');
  }
});

router.post('/:indexId/connectors/generate-admin-email', async (req: Request, res: Response) => {
  try {
    if (!(await assertSearchIndexAccess(req, req.params.indexId))) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Index not found' },
      });
      return;
    }

    const parsed = generateEmailBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Body must contain { type: "app_registration_setup" }',
        },
      });
      return;
    }
    const data = await connectorService.generateAdminEmail(
      req.params.indexId,
      req.tenantContext!.tenantId,
      parsed.data.type,
    );
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, 'GENERATE_EMAIL_FAILED');
  }
});

// ─── CRUD (continued) ────────────────────────────────────────────────────

router.get('/:indexId/connectors/:connectorId', async (req: Request, res: Response) => {
  try {
    if (!(await assertConnectorIndexAccess(req, req.params.connectorId, req.params.indexId))) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Connector not found' },
      });
      return;
    }

    const data = await connectorService.getConnector(
      req.params.connectorId,
      req.tenantContext!.tenantId,
    );
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, 'GET_FAILED');
  }
});

router.put('/:indexId/connectors/:connectorId', async (req: Request, res: Response) => {
  try {
    if (!(await assertConnectorIndexAccess(req, req.params.connectorId, req.params.indexId))) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Connector not found' },
      });
      return;
    }

    const data = await connectorService.updateConnector(
      req.params.connectorId,
      req.tenantContext!.tenantId,
      req.body,
    );
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, 'UPDATE_FAILED');
  }
});

router.delete('/:indexId/connectors/:connectorId', async (req: Request, res: Response) => {
  try {
    if (!(await assertConnectorIndexAccess(req, req.params.connectorId, req.params.indexId))) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Connector not found' },
      });
      return;
    }

    const data = await connectorService.deleteConnector(
      req.params.connectorId,
      req.tenantContext!.tenantId,
    );
    res.json({ success: true, ...data });
  } catch (error) {
    handleError(res, error, 'DELETE_FAILED');
  }
});

// ─── Authentication ──────────────────────────────────────────────────────

router.use('/connectors/:connectorId', async (req: Request, res: Response, next) => {
  try {
    if (!(await assertConnectorIndexAccess(req, req.params.connectorId))) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Connector not found' },
      });
      return;
    }

    next();
  } catch (error) {
    handleError(res, error, 'CONNECTOR_SCOPE_FAILED');
  }
});

router.post('/connectors/:connectorId/auth/initiate', async (req: Request, res: Response) => {
  try {
    const data = await connectorService.initiateAuth(
      req.params.connectorId,
      req.tenantContext!.tenantId,
      req.tenantContext!.userId,
    );
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, 'AUTH_INITIATE_FAILED');
  }
});

router.get('/connectors/:connectorId/auth/status', async (req: Request, res: Response) => {
  try {
    const data = await connectorService.getAuthStatus(
      req.params.connectorId,
      req.tenantContext!.tenantId,
      req.tenantContext!.userId,
    );
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, 'AUTH_STATUS_FAILED');
  }
});

router.post('/connectors/:connectorId/auth/callback', async (req: Request, res: Response) => {
  try {
    const data = await connectorService.authCallback(
      req.params.connectorId,
      req.tenantContext!.tenantId,
      req.tenantContext!.userId,
      req.body.code,
      req.body.state,
    );
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, 'AUTH_CALLBACK_FAILED');
  }
});

router.post('/connectors/:connectorId/auth/revoke', async (req: Request, res: Response) => {
  try {
    const data = await connectorService.revokeAuth(
      req.params.connectorId,
      req.tenantContext!.tenantId,
    );
    res.json({ success: true, ...data });
  } catch (error) {
    handleError(res, error, 'AUTH_REVOKE_FAILED');
  }
});

// ─── Filters ─────────────────────────────────────────────────────────────

router.get('/connectors/:connectorId/filters/validate', async (req: Request, res: Response) => {
  try {
    const data = await connectorService.validateFilters(
      req.params.connectorId,
      req.tenantContext!.tenantId,
    );
    res.json({ success: true, ...data });
  } catch (error) {
    handleError(res, error, 'VALIDATE_FILTERS_FAILED');
  }
});

router.get('/connectors/:connectorId/filters/templates', async (req: Request, res: Response) => {
  try {
    const data = await connectorService.getFilterTemplates(
      req.params.connectorId,
      req.tenantContext!.tenantId,
    );
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, 'GET_TEMPLATES_FAILED');
  }
});

router.post(
  '/connectors/:connectorId/filters/apply-template',
  async (req: Request, res: Response) => {
    try {
      const data = await connectorService.applyFilterTemplate(
        req.params.connectorId,
        req.tenantContext!.tenantId,
        req.body.templateId,
        req.body.merge ?? true,
      );
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'APPLY_TEMPLATE_FAILED');
    }
  },
);

router.post('/connectors/:connectorId/filters/preview', async (req: Request, res: Response) => {
  try {
    const data = await connectorService.previewFilters(
      req.params.connectorId,
      req.tenantContext!.tenantId,
      req.body.filterConfig,
    );
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, 'PREVIEW_FILTERS_FAILED');
  }
});

// ─── Sync Operations ────────────────────────────────────────────────────

router.post('/connectors/:connectorId/sync/start', async (req: Request, res: Response) => {
  try {
    const data = await connectorService.startSync(
      req.params.connectorId,
      req.tenantContext!.tenantId,
      req.body.syncType,
    );
    res.json({ success: true, ...data });
  } catch (error) {
    handleError(res, error, 'SYNC_START_FAILED');
  }
});

router.post('/connectors/:connectorId/sync/stop', async (req: Request, res: Response) => {
  try {
    const redis = req.app.get('redis');
    const data = await connectorService.stopSync(
      req.params.connectorId,
      req.tenantContext!.tenantId,
      redis,
      req.body.reason,
    );
    res.json({ success: true, ...data });
  } catch (error) {
    handleError(res, error, 'SYNC_STOP_FAILED');
  }
});

router.post('/connectors/:connectorId/sync/pause', async (req: Request, res: Response) => {
  try {
    const redis = req.app.get('redis');
    const data = await connectorService.pauseSync(
      req.params.connectorId,
      req.tenantContext!.tenantId,
      redis,
      req.body.reason,
    );
    res.json({ success: true, ...data });
  } catch (error) {
    handleError(res, error, 'SYNC_PAUSE_FAILED');
  }
});

router.post('/connectors/:connectorId/sync/resume', async (req: Request, res: Response) => {
  try {
    const data = await connectorService.resumeSync(
      req.params.connectorId,
      req.tenantContext!.tenantId,
    );
    res.json({ success: true, ...data });
  } catch (error) {
    handleError(res, error, 'SYNC_RESUME_FAILED');
  }
});

router.post('/connectors/:connectorId/sync/restart', async (req: Request, res: Response) => {
  try {
    const data = await connectorService.restartSync(
      req.params.connectorId,
      req.tenantContext!.tenantId,
    );
    res.json({ success: true, ...data });
  } catch (error) {
    handleError(res, error, 'SYNC_RESTART_FAILED');
  }
});

router.get('/connectors/:connectorId/sync/status', async (req: Request, res: Response) => {
  try {
    const data = await connectorService.getSyncStatus(
      req.params.connectorId,
      req.tenantContext!.tenantId,
    );
    res.json({ success: true, ...data });
  } catch (error) {
    handleError(res, error, 'SYNC_STATUS_FAILED');
  }
});

// ─── Delta Sync ──────────────────────────────────────────────────────────

router.post('/connectors/:connectorId/sync/delta', async (req: Request, res: Response) => {
  try {
    const data = await connectorService.triggerDeltaSync(
      req.params.connectorId,
      req.tenantContext!.tenantId,
    );
    res.json({ success: true, ...data });
  } catch (error) {
    handleError(res, error, 'DELTA_SYNC_FAILED');
  }
});

router.get('/connectors/:connectorId/delta-tokens', async (req: Request, res: Response) => {
  try {
    const data = await connectorService.listDeltaTokens(
      req.params.connectorId,
      req.tenantContext!.tenantId,
    );
    res.json({ success: true, ...data });
  } catch (error) {
    handleError(res, error, 'LIST_DELTA_TOKENS_FAILED');
  }
});

router.delete(
  '/connectors/:connectorId/delta-tokens/:driveId',
  async (req: Request, res: Response) => {
    try {
      const data = await connectorService.resetDeltaToken(
        req.params.connectorId,
        req.tenantContext!.tenantId,
        req.params.driveId,
      );
      res.json({ success: true, ...data });
    } catch (error) {
      handleError(res, error, 'RESET_DELTA_TOKEN_FAILED');
    }
  },
);

// ─── Permission Crawling ─────────────────────────────────────────────────

router.post('/connectors/:connectorId/permissions/crawl', async (req: Request, res: Response) => {
  try {
    const data = await connectorService.startPermissionCrawl(
      req.params.connectorId,
      req.tenantContext!.tenantId,
      req.body.mode,
    );
    res.json({ success: true, ...data });
  } catch (error) {
    handleError(res, error, 'PERMISSION_CRAWL_FAILED');
  }
});

router.get('/connectors/:connectorId/permissions/status', async (req: Request, res: Response) => {
  try {
    const data = await connectorService.getPermissionStatus(
      req.params.connectorId,
      req.tenantContext!.tenantId,
    );
    res.json({ success: true, ...data });
  } catch (error) {
    handleError(res, error, 'PERMISSION_STATUS_FAILED');
  }
});

router.put('/connectors/:connectorId/permissions/mode', async (req: Request, res: Response) => {
  try {
    const data = await connectorService.updatePermissionMode(
      req.params.connectorId,
      req.tenantContext!.tenantId,
      req.body.mode,
    );
    res.json({ success: true, ...data });
  } catch (error) {
    handleError(res, error, 'PERMISSION_MODE_FAILED');
  }
});

router.post('/connectors/:connectorId/permissions/recrawl', async (req: Request, res: Response) => {
  try {
    const data = await connectorService.triggerPermissionRecrawl(
      req.params.connectorId,
      req.tenantContext!.tenantId,
    );
    res.json({ success: true, ...data });
  } catch (error) {
    handleError(res, error, 'PERMISSION_RECRAWL_FAILED');
  }
});

// ─── Job Status ──────────────────────────────────────────────────────────

router.get('/jobs/:jobId', async (req: Request, res: Response) => {
  try {
    const data = await connectorService.getJobStatus(req.params.jobId);
    res.json({ success: true, ...data });
  } catch (error) {
    handleError(res, error, 'JOB_STATUS_FAILED');
  }
});

export default router;

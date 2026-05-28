/**
 * Connector Multi-Connector Routes
 *
 * Clone, template CRUD, template apply, and config import endpoints.
 *
 * Mounted under /api/indexes
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { createLogger } from '@abl/compiler/platform';
import { ConnectorError, cloneConnector } from '../services/connector.service.js';
import * as templateService from '../services/connector-template.service.js';
import {
  assertConnectorIndexAccess,
  requireConnectorIndexAccessFromParams,
  requireSearchIndexAccessFromParams,
} from './searchai-route-ownership.js';

const logger = createLogger('connector-multi-routes');
const router: RouterType = Router();

router.use(authMiddleware);
router.use('/:indexId/connectors/:connectorId', requireConnectorIndexAccessFromParams());
router.use('/:indexId', requireSearchIndexAccessFromParams());

// ─── Zod Validation Schemas ─────────────────────────────────────────────

const connectorParams = z.strictObject({
  indexId: z.string().min(1),
  connectorId: z.string().min(1),
});

const indexParams = z.strictObject({
  indexId: z.string().min(1),
});

const templateParams = z.strictObject({
  indexId: z.string().min(1),
  templateId: z.string().min(1),
});

const cloneBody = z.strictObject({
  securityDecision: z.enum(['continue_with_permissions', 'disable_permissions']).optional(),
});

const createTemplateBody = z.strictObject({
  sourceConnectorId: z.string().min(1),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

const applyTemplateBody = z.strictObject({
  securityDecision: z.enum(['continue_with_permissions', 'disable_permissions']).optional(),
});

const importBody = z.strictObject({
  config: z.record(z.unknown()),
  format: z.enum(['json', 'yaml']),
  securityDecision: z.enum(['continue_with_permissions', 'disable_permissions']).optional(),
});

const templateListQuery = z.strictObject({
  search: z.string().optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
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

// ─── Clone Route ─────────────────────────────────────────────────────────

/**
 * POST /:indexId/connectors/:connectorId/clone
 * Clone an existing connector configuration into a new draft
 */
router.post('/:indexId/connectors/:connectorId/clone', async (req: Request, res: Response) => {
  const paramResult = connectorParams.safeParse(req.params);
  if (!paramResult.success) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_PARAMS', message: paramResult.error.message },
    });
    return;
  }

  const bodyResult = cloneBody.safeParse(req.body);
  if (!bodyResult.success) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_BODY', message: bodyResult.error.message },
    });
    return;
  }

  try {
    const data = await cloneConnector(
      paramResult.data.indexId,
      paramResult.data.connectorId,
      req.tenantContext!.tenantId,
      bodyResult.data.securityDecision,
    );
    res.status(201).json({ success: true, data });
  } catch (error) {
    handleError(res, error, 'CLONE_FAILED');
  }
});

// ─── Template Routes ─────────────────────────────────────────────────────

/**
 * GET /:indexId/connector-templates
 * List available templates
 */
router.get('/:indexId/connector-templates', async (req: Request, res: Response) => {
  const paramResult = indexParams.safeParse(req.params);
  if (!paramResult.success) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_PARAMS', message: paramResult.error.message },
    });
    return;
  }

  const queryResult = templateListQuery.safeParse(req.query);
  if (!queryResult.success) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_QUERY', message: queryResult.error.message },
    });
    return;
  }

  try {
    const data = await templateService.listTemplates(
      paramResult.data.indexId,
      req.tenantContext!.tenantId,
      queryResult.data,
    );
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, 'LIST_TEMPLATES_FAILED');
  }
});

/**
 * POST /:indexId/connector-templates
 * Create a new template from an existing connector
 */
router.post('/:indexId/connector-templates', async (req: Request, res: Response) => {
  const paramResult = indexParams.safeParse(req.params);
  if (!paramResult.success) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_PARAMS', message: paramResult.error.message },
    });
    return;
  }

  const bodyResult = createTemplateBody.safeParse(req.body);
  if (!bodyResult.success) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_BODY', message: bodyResult.error.message },
    });
    return;
  }

  try {
    if (
      !(await assertConnectorIndexAccess(
        req,
        bodyResult.data.sourceConnectorId,
        paramResult.data.indexId,
      ))
    ) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Connector not found' },
      });
      return;
    }

    const template = await templateService.createTemplate(
      bodyResult.data.sourceConnectorId,
      req.tenantContext!.tenantId,
      bodyResult.data.name,
      bodyResult.data.description,
    );
    res.status(201).json({ success: true, data: { template } });
  } catch (error) {
    handleError(res, error, 'CREATE_TEMPLATE_FAILED');
  }
});

/**
 * POST /:indexId/connector-templates/:templateId/apply
 * Apply a template to create a new connector
 */
router.post(
  '/:indexId/connector-templates/:templateId/apply',
  async (req: Request, res: Response) => {
    const paramResult = templateParams.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_PARAMS', message: paramResult.error.message },
      });
      return;
    }

    const bodyResult = applyTemplateBody.safeParse(req.body);
    if (!bodyResult.success) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_BODY', message: bodyResult.error.message },
      });
      return;
    }

    try {
      const data = await templateService.applyTemplate(
        paramResult.data.templateId,
        paramResult.data.indexId,
        req.tenantContext!.tenantId,
        bodyResult.data.securityDecision,
      );
      res.status(201).json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'APPLY_TEMPLATE_FAILED');
    }
  },
);

// ─── Import Route ────────────────────────────────────────────────────────

/**
 * POST /:indexId/connectors/import
 * Import a connector configuration from JSON/YAML
 */
router.post('/:indexId/connectors/import', async (req: Request, res: Response) => {
  const paramResult = indexParams.safeParse(req.params);
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
    const data = await templateService.importConnectorConfig(
      paramResult.data.indexId,
      req.tenantContext!.tenantId,
      bodyResult.data.config,
      bodyResult.data.securityDecision,
    );
    res.status(201).json({ success: true, data });
  } catch (error) {
    handleError(res, error, 'IMPORT_FAILED');
  }
});

export default router;

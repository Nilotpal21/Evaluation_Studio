/**
 * Connector Audit Log Routes
 *
 * Read-only routes for querying and exporting the immutable connector audit trail.
 * Mounted under /api/indexes/:indexId/connectors/:connectorId/audit-log
 *
 * Auth middleware is applied on the parent router mount.
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { createLogger } from '@abl/compiler/platform';
import * as auditService from '../services/connector-audit.service.js';
import { ConnectorError } from '../services/connector.service.js';
import { sendGeneratedExport } from './export-response.js';
import { requireConnectorIndexAccessFromParams } from './searchai-route-ownership.js';

const logger = createLogger('connector-audit-routes');
const router: RouterType = Router();

router.use(authMiddleware);
router.use('/:indexId/connectors/:connectorId', requireConnectorIndexAccessFromParams());

// ─── Zod Validation Schemas ──────────────────────────────────────────────

const routeParamsSchema = z.strictObject({
  indexId: z.string().min(1),
  connectorId: z.string().min(1),
});

const auditLogQuerySchema = z.strictObject({
  category: z.enum(['auth', 'config', 'sync', 'permission', 'lifecycle']).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

const exportQuerySchema = z.strictObject({
  format: z.enum(['json', 'csv']),
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

/**
 * GET /:indexId/connectors/:connectorId/audit-log
 *
 * Returns paginated audit entries for a connector.
 */
router.get('/:indexId/connectors/:connectorId/audit-log', async (req: Request, res: Response) => {
  try {
    const paramsResult = routeParamsSchema.safeParse(req.params);
    if (!paramsResult.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_PARAMS',
          message: paramsResult.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; '),
        },
      });
      return;
    }

    const queryResult = auditLogQuerySchema.safeParse(req.query);
    if (!queryResult.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_QUERY',
          message: queryResult.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; '),
        },
      });
      return;
    }

    const { connectorId } = paramsResult.data;
    const tenantId = req.tenantContext!.tenantId;
    const query = queryResult.data;

    const data = await auditService.getAuditLog(connectorId, tenantId, {
      category: query.category,
      page: query.page,
      limit: query.limit,
      startDate: query.startDate ? new Date(query.startDate) : undefined,
      endDate: query.endDate ? new Date(query.endDate) : undefined,
    });

    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, 'AUDIT_LOG_FETCH_FAILED');
  }
});

/**
 * GET /:indexId/connectors/:connectorId/audit-log/export
 *
 * Exports the full audit log as JSON or CSV file download.
 */
router.get(
  '/:indexId/connectors/:connectorId/audit-log/export',
  async (req: Request, res: Response) => {
    try {
      const paramsResult = routeParamsSchema.safeParse(req.params);
      if (!paramsResult.success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_PARAMS',
            message: paramsResult.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; '),
          },
        });
        return;
      }

      const queryResult = exportQuerySchema.safeParse(req.query);
      if (!queryResult.success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_QUERY',
            message: queryResult.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; '),
          },
        });
        return;
      }

      const { connectorId } = paramsResult.data;
      const tenantId = req.tenantContext!.tenantId;
      const { format } = queryResult.data;

      const result = await auditService.exportAuditLog(connectorId, tenantId, format);

      sendGeneratedExport(res, result);
    } catch (error) {
      handleError(res, error, 'AUDIT_LOG_EXPORT_FAILED');
    }
  },
);

export default router;

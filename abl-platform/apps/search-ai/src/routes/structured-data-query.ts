/**
 * Structured Data Query Route
 *
 * POST /:indexId/structured-data/query
 *   Natural language query over structured (CSV/Excel/JSON) data.
 *   Routes to TextToSQLService for SQL generation + ClickHouse execution.
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { ISearchIndex } from '@agent-platform/database/models';
import { getLazyModel } from '../db/index.js';
import { applyProjectScopeFilter } from './project-scope.js';
import { StructuredDataQueryRouter } from '../services/structured-data/query-router.js';
import { StructuredDataClickHouseClient } from '../services/structured-data/clickhouse-client.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('structured-data-query');

const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');

const router: RouterType = Router();

// ─── Validation ──────────────────────────────────────────────────────────────

const queryRequestSchema = z.object({
  query: z.string().min(1, 'Query is required'),
  tableId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(1000).optional().default(10),
  offset: z.number().int().min(0).optional().default(0),
});

// ─── POST /:indexId/structured-data/query ────────────────────────────────────

router.post(
  '/:indexId/structured-data/query',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.tenantContext) {
        res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Tenant context required' },
        });
        return;
      }

      const { indexId } = req.params;
      const tenantId = req.tenantContext.tenantId;

      // Validate request body
      const parsed = queryRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues.map((i) => i.message).join(', '),
          },
        });
        return;
      }

      const { query, tableId, limit, offset } = parsed.data;

      // Verify index exists AND belongs to tenant (tenant isolation)
      const index = await SearchIndex.findOne(
        applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
      ).lean();
      if (!index) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Index not found' },
        });
        return;
      }

      logger.info('Structured data query', { tenantId, indexId, query, tableId });

      // Initialize ClickHouse client
      const chClient = new StructuredDataClickHouseClient();

      // Route the query
      const queryRouter = new StructuredDataQueryRouter(chClient);
      const result = await queryRouter.route({
        query,
        indexId,
        tenantId,
        tableId,
        limit,
        offset,
      });

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error('Structured data query failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      next(error);
    }
  },
);

export default router;

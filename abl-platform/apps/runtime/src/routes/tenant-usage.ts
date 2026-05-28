/**
 * Tenant Usage Analytics Route
 *
 * Serves aggregated LLM usage metrics from ClickHouse for the Billing & Usage page.
 * All queries are tenant-scoped and support optional project + date range filters.
 *
 * Mount: /api/tenants/:tenantId/usage
 */

import { type Router as RouterType } from 'express';
import { z } from 'zod';
import { createOpenAPIRouter, getValidatedRequestData } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requirePermission } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('tenant-usage-route');
const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/tenants/:tenantId/usage',
  tags: ['Tenant Usage'],
  validateRequests: true,
  wrapAsyncHandlers: true,
  onValidationError: (_error, _req, res) => {
    res.status(400).json({ success: false, error: 'Invalid query parameters' });
  },
});
const router: RouterType = openapi.router;

router.use(authMiddleware);
router.use(tenantRateLimit('request'));

const querySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  projectId: z.string().optional(),
});

const usageSummarySchema = z.object({
  totalRequests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  estimatedCost: z.number(),
  avgLatencyMs: z.number(),
});

const tenantUsageResponseSchema = z.object({
  success: z.boolean(),
  summary: usageSummarySchema,
  breakdown: z.array(z.record(z.unknown())),
  daily: z.array(z.record(z.unknown())),
  projects: z.array(z.record(z.unknown())),
});

/**
 * GET / — Tenant usage analytics
 *
 * Query params: startDate, endDate, projectId (all optional)
 * Returns summary, cost breakdown by model, daily usage, and project breakdown.
 */
openapi.route(
  'get',
  '/',
  {
    summary: 'Get tenant usage analytics',
    description:
      'Returns tenant-scoped usage summary, cost breakdown, daily usage, and project usage with optional date and project filters.',
    query: querySchema,
    response: tenantUsageResponseSchema,
  },
  requirePermission('credential:read'),
  async (req, res) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const validatedQuery = getValidatedRequestData(res)?.query as
        | z.infer<typeof querySchema>
        | undefined;
      const { startDate, endDate, projectId } = validatedQuery ?? {};

      // Build query params
      const params = {
        tenantId,
        projectId: projectId || undefined,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
      };

      // Initialize ClickHouse metrics store
      let metricsStore;
      try {
        const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
        const { ClickHouseMetricsStore } =
          await import('../services/stores/clickhouse-metrics-store.js');
        const client = getClickHouseClient();
        metricsStore = new ClickHouseMetricsStore({ type: 'clickhouse' }, { client, tenantId });
      } catch (err) {
        log.error('ClickHouse unavailable for usage analytics', {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(503).json({ success: false, error: 'Analytics not available' });
        return;
      }

      // Run all 4 queries in parallel
      const [summary, breakdown, daily, projects] = await Promise.all([
        metricsStore.getTenantUsage(params),
        metricsStore.getTenantCostBreakdown(params),
        metricsStore.getTenantDailyUsage(params),
        metricsStore.getTenantProjectUsage(params),
      ]);

      res.json({
        success: true,
        summary,
        breakdown,
        daily,
        projects,
      });
    } catch (error) {
      log.error('Failed to fetch tenant usage', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ success: false, error: 'Failed to fetch usage analytics' });
    }
  },
);

export default router;

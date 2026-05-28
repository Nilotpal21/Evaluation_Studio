/**
 * Project Billing Usage Routes
 *
 * Mounted at /api/projects/:projectId/billing
 */

import { type Router as RouterType } from 'express';
import { z } from 'zod';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';
import { runtimeRegistry } from '../openapi/registry.js';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import {
  BILLING_USAGE_REPORT_GRANULARITY_VALUES,
  BillingUsageReportError,
  BillingUsageReportService,
} from '../services/billing/billing-usage-report-service.js';

const log = createLogger('project-billing-route');
const billingUsageReportService = new BillingUsageReportService();

const reportMetricsSchema = z.object({
  examinedSessionCount: z.number().int().nonnegative(),
  includedSessionCount: z.number().int().nonnegative(),
  excludedSessionCount: z.number().int().nonnegative(),
  durationSeconds: z.number().int().nonnegative(),
  userMessageCount: z.number().int().nonnegative(),
  assistantMessageCount: z.number().int().nonnegative(),
  toolMessageCount: z.number().int().nonnegative(),
  interactiveTurnCount: z.number().int().nonnegative(),
  engagedSeconds: z.number().int().nonnegative(),
  llmCallCount: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  baseUnits: z.number().int().nonnegative(),
  llmAddonUnits: z.number().int().nonnegative(),
  toolAddonUnits: z.number().int().nonnegative(),
  totalUnits: z.number().int().nonnegative(),
});

const reportWindowSchema = reportMetricsSchema.extend({
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
});

const projectBreakdownSchema = reportMetricsSchema.extend({
  projectId: z.string().min(1),
});

const channelBreakdownSchema = reportMetricsSchema.extend({
  channel: z.string().min(1),
});

const usageReportQuerySchema = z.object({
  windowStart: z.string().datetime().optional(),
  windowEnd: z.string().datetime().optional(),
  granularity: z.enum(BILLING_USAGE_REPORT_GRANULARITY_VALUES).optional(),
});

const usageReportResponseSchema = z.object({
  success: z.literal(true),
  tenantId: z.string().min(1),
  projectId: z.string().min(1).nullable(),
  granularity: z.enum(BILLING_USAGE_REPORT_GRANULARITY_VALUES),
  range: z.object({
    windowStart: z.string().datetime(),
    windowEnd: z.string().datetime(),
    timeZone: z.literal('UTC'),
  }),
  totals: reportMetricsSchema,
  windows: z.array(reportWindowSchema),
  projectBreakdown: z.array(projectBreakdownSchema),
  channelBreakdown: z.array(channelBreakdownSchema),
});

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/billing',
  tags: ['Billing'],
});
const router: RouterType = openapi.router;

router.use(authMiddleware);
router.use(requireProjectScope('projectId', { concealOutOfScope: true }));
router.use(tenantRateLimit('request'));

openapi.route(
  'get',
  '/usage',
  {
    summary: 'Get project billing usage report',
    description:
      'Returns time-windowed billing usage and billing unit totals for the current project.',
    response: usageReportResponseSchema,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const parsed = usageReportQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: 'Invalid query parameters',
          details: parsed.error.issues,
        });
        return;
      }

      const report = await billingUsageReportService.getUsageReport({
        tenantId: req.tenantContext!.tenantId,
        projectId: req.params.projectId,
        windowStart: parsed.data.windowStart ? new Date(parsed.data.windowStart) : undefined,
        windowEnd: parsed.data.windowEnd ? new Date(parsed.data.windowEnd) : undefined,
        granularity: parsed.data.granularity,
      });

      res.json({
        success: true,
        ...report,
      });
    } catch (error: unknown) {
      if (error instanceof BillingUsageReportError) {
        res.status(400).json({
          success: false,
          error: error.message,
          details: error.details,
        });
        return;
      }

      log.error('Failed to get project billing usage report', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({
        success: false,
        error: 'Failed to get project billing usage report',
      });
    }
  },
);

export default router;

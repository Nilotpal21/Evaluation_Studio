/**
 * Platform Admin — Usage Summary Routes
 *
 * Aggregates LLM usage data across all tenants for platform-wide
 * analytics. Supports date range filtering, time-series grouping,
 * top tenants by cost, and provider breakdown.
 *
 * Mount: /api/platform/admin/usage-summary
 */

import { type Router as RouterType } from 'express';
import { z } from 'zod';
import { createOpenAPIRouter, getValidatedRequestData } from '@agent-platform/openapi/express';
import { requirePlatformAdmin, requirePlatformAdminIp } from '@agent-platform/shared-auth';
import { getCurrentRequestId } from '@agent-platform/shared-observability';
import { createLogger } from '@abl/compiler/platform';
import { getConfig } from '../config/index.js';
import { platformAdminAuthMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { runtimeRegistry } from '../openapi/registry.js';

const log = createLogger('platform-admin-usage');
const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/platform/admin/usage-summary',
  tags: ['Platform Admin Usage'],
  validateRequests: true,
  wrapAsyncHandlers: true,
  onValidationError: (_error, _req, res) => {
    res.status(400).json({ success: false, error: 'Invalid query parameters' });
  },
});
const router: RouterType = openapi.router;

// ─── Middleware ────────────────────────────────────────────────────────────

router.use(platformAdminAuthMiddleware);
router.use(tenantRateLimit('request'));
router.use(requirePlatformAdmin());
router.use(requirePlatformAdminIp(() => getConfig().security.platformAdminAllowedIps));

// ─── Constants ────────────────────────────────────────────────────────────

/** Default lookback period when no date range is specified (30 days). */
const DEFAULT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/** Maximum number of top tenants to return. */
const TOP_TENANTS_LIMIT = 10;

const platformAdminUsageQueryValueSchema = z.union([z.string(), z.array(z.string())]);

const platformAdminUsageQuerySchema = z.object({
  from: platformAdminUsageQueryValueSchema.optional(),
  to: platformAdminUsageQueryValueSchema.optional(),
  groupBy: platformAdminUsageQueryValueSchema.optional(),
  tenantId: platformAdminUsageQueryValueSchema.optional(),
});

const platformAdminUsageResponseSchema = z.object({
  success: z.literal(true),
  summary: z.object({
    totalTokens: z.number(),
    totalCost: z.number(),
    sessionCount: z.number(),
    activeTenants: z.number(),
  }),
  timeSeries: z.array(
    z.object({
      period: z.string(),
      tokens: z.number(),
      cost: z.number(),
      sessions: z.number(),
    }),
  ),
  topTenants: z.array(
    z.object({
      tenantId: z.string(),
      tenantName: z.string(),
      cost: z.number(),
      tokens: z.number(),
    }),
  ),
  providerBreakdown: z.array(
    z.object({
      provider: z.string(),
      tokens: z.number(),
      cost: z.number(),
      percentage: z.number(),
    }),
  ),
});

type PlatformAdminUsageQuery = z.infer<typeof platformAdminUsageQuerySchema>;
type PlatformAdminUsageQueryValue = z.infer<typeof platformAdminUsageQueryValueSchema>;

interface UsageSummaryAggregate {
  totalTokens?: number;
  totalCost?: number;
  sessionIds?: string[];
  tenantIds?: string[];
}

interface UsageTimeSeriesPoint {
  period: string;
  tokens: number;
  cost: number;
  sessions: number;
}

interface TopTenantAggregate {
  _id: string;
  cost: number;
  tokens: number;
}

interface ProviderUsageAggregate {
  _id: string;
  tokens: number;
  cost: number;
}

interface TenantNameRecord {
  _id: string;
  name?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function stringifyQueryValue(value: PlatformAdminUsageQueryValue | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return String(value);
}

/** Build a date format string for MongoDB $dateToString based on groupBy. */
function getDateFormat(groupBy: PlatformAdminUsageQueryValue | undefined): string {
  if (stringifyQueryValue(groupBy) === 'hour') {
    return '%Y-%m-%dT%H:00:00Z';
  }
  return '%Y-%m-%d';
}

/** Parse date range params with sensible defaults. */
function parseDateRange(query?: PlatformAdminUsageQuery): { from: Date; to: Date } {
  const now = new Date();
  const toValue = stringifyQueryValue(query?.to);
  const fromValue = stringifyQueryValue(query?.from);
  const to = toValue ? new Date(toValue) : now;
  const from = fromValue ? new Date(fromValue) : new Date(to.getTime() - DEFAULT_LOOKBACK_MS);
  return { from, to };
}

// ─── GET / — Usage Summary ────────────────────────────────────────────────

openapi.route(
  'get',
  '/',
  {
    summary: 'Get platform-wide usage summary',
    description:
      'Aggregates platform-wide LLM usage metrics with optional date filters, grouping, and tenant scoping for platform admins.',
    query: platformAdminUsageQuerySchema,
    response: platformAdminUsageResponseSchema,
  },
  async (req, res) => {
    const requestId = getCurrentRequestId();
    try {
      const { LLMUsageMetric, Tenant } = await import('@agent-platform/database/models');

      const validatedQuery = getValidatedRequestData(res)?.query as
        | PlatformAdminUsageQuery
        | undefined;
      const query = validatedQuery ?? (req.query as PlatformAdminUsageQuery);
      const { from, to } = parseDateRange(query);
      const groupBy = query?.groupBy;
      const tenantId = query?.tenantId;

      const dateMatch: {
        createdAt: { $gte: Date; $lte: Date };
        tenantId?: PlatformAdminUsageQueryValue;
      } = { createdAt: { $gte: from, $lte: to } };

      if (tenantId) {
        dateMatch.tenantId = tenantId;
      }

      const [summaryResult, timeSeriesResult, topTenantsResult, providerResult] =
        (await Promise.all([
          LLMUsageMetric.aggregate([
            { $match: dateMatch },
            {
              $group: {
                _id: null,
                totalTokens: { $sum: '$totalTokens' },
                totalCost: { $sum: '$estimatedCost' },
                sessionIds: { $addToSet: '$sessionId' },
                tenantIds: { $addToSet: '$tenantId' },
              },
            },
          ]).exec(),
          LLMUsageMetric.aggregate([
            { $match: dateMatch },
            {
              $group: {
                _id: {
                  $dateToString: { format: getDateFormat(groupBy), date: '$createdAt' },
                },
                tokens: { $sum: '$totalTokens' },
                cost: { $sum: '$estimatedCost' },
                sessions: { $addToSet: '$sessionId' },
              },
            },
            {
              $project: {
                _id: 0,
                period: '$_id',
                tokens: 1,
                cost: { $round: ['$cost', 4] },
                sessions: { $size: '$sessions' },
              },
            },
            { $sort: { period: 1 } },
          ]).exec(),
          LLMUsageMetric.aggregate([
            { $match: dateMatch },
            {
              $group: {
                _id: '$tenantId',
                cost: { $sum: '$estimatedCost' },
                tokens: { $sum: '$totalTokens' },
              },
            },
            { $sort: { cost: -1 } },
            { $limit: TOP_TENANTS_LIMIT },
          ]).exec(),
          LLMUsageMetric.aggregate([
            { $match: dateMatch },
            {
              $group: {
                _id: '$provider',
                tokens: { $sum: '$totalTokens' },
                cost: { $sum: '$estimatedCost' },
              },
            },
            { $sort: { cost: -1 } },
          ]).exec(),
        ])) as [
          UsageSummaryAggregate[],
          UsageTimeSeriesPoint[],
          TopTenantAggregate[],
          ProviderUsageAggregate[],
        ];

      const rawSummary = summaryResult[0];
      const summary = {
        totalTokens: rawSummary?.totalTokens ?? 0,
        totalCost: Math.round((rawSummary?.totalCost ?? 0) * 10000) / 10000,
        sessionCount: rawSummary?.sessionIds?.length ?? 0,
        activeTenants: rawSummary?.tenantIds?.length ?? 0,
      };

      const tenantIds = topTenantsResult.map((tenant) => tenant._id);
      const tenantNameMap = new Map<string, string>();
      if (tenantIds.length > 0) {
        try {
          const tenants = (await Tenant.find({ _id: { $in: tenantIds } }, { _id: 1, name: 1 })
            .lean()
            .exec()) as TenantNameRecord[];
          for (const tenant of tenants) {
            if (tenant.name) {
              tenantNameMap.set(String(tenant._id), tenant.name);
            }
          }
        } catch {
          // Tenant model may not exist — skip enrichment
        }
      }

      const topTenants = topTenantsResult.map((tenant) => ({
        tenantId: tenant._id,
        tenantName: tenantNameMap.get(String(tenant._id)) ?? tenant._id,
        cost: Math.round(tenant.cost * 10000) / 10000,
        tokens: tenant.tokens,
      }));

      const totalProviderTokens = providerResult.reduce(
        (sum, provider) => sum + provider.tokens,
        0,
      );
      const providerBreakdown = providerResult.map((provider) => ({
        provider: provider._id,
        tokens: provider.tokens,
        cost: Math.round(provider.cost * 10000) / 10000,
        percentage:
          totalProviderTokens > 0
            ? Math.round((provider.tokens / totalProviderTokens) * 10000) / 100
            : 0,
      }));

      res.json({
        success: true,
        summary,
        timeSeries: timeSeriesResult,
        topTenants,
        providerBreakdown,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Failed to aggregate usage data', { error: message, requestId });
      res.status(500).json({ success: false, error: 'Failed to aggregate usage data' });
    }
  },
);

export default router;

/**
 * Analytics API Routes
 *
 * Mounted at /api/projects/:projectId/analytics
 *
 * GET  /metrics           Aggregated metrics (containment, error rate, latency, cost)
 * GET  /events            Event listing with filters
 * GET  /agents/:name      Per-agent performance rollup
 * GET  /cost-breakdown    LLM cost breakdown by model/provider
 * GET  /session-metrics   Session-level metrics
 * POST /query             Ad-hoc event query
 * POST /aggregate         Ad-hoc aggregation query
 */

import { Router, type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectWideAnalyticsAccess } from '../middleware/rbac.js';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';
import { resolveProjectSessionAccess } from '../middleware/session-access.js';
import { getRuntimeExecutor } from '../services/runtime-executor.js';
import {
  ALLOWED_MONGO_COLLECTIONS,
  ALLOWED_CLICKHOUSE_TABLES,
} from '@agent-platform/pipeline-engine/contracts';

const log = createLogger('analytics-route');

// ─── Lazy EventStore access ─────────────────────────────────────────────────

async function getQueryService() {
  try {
    const { getEventStore } = await import('../services/eventstore-singleton.js');
    const store = getEventStore();
    if (!store) return null;
    return store.queryService;
  } catch {
    return null;
  }
}

// ─── Router setup ───────────────────────────────────────────────────────────

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/analytics',
  tags: ['Analytics'],
});
const router: RouterType = openapi.router;

// Middleware chain
router.use(authMiddleware);
router.use(requireProjectScope('projectId', { concealOutOfScope: true }));
router.use(tenantRateLimit('request'));

// ─── Shared schemas ─────────────────────────────────────────────────────────

const TimeRangeSchema = z.object({
  from: z.string().describe('ISO 8601 start date'),
  to: z.string().describe('ISO 8601 end date'),
});

const EventCategorySchema = z.enum([
  'session',
  'message',
  'llm',
  'tool',
  'agent',
  'gather',
  'flow',
  'channel',
  'deployment',
  'search',
  'voice',
  'audit',
  'evaluation',
  'feedback',
  'billing',
  'attachment',
  'system',
]);

const AggregateGroupBySchema = z.enum([
  'category',
  'event_type',
  'agent_name',
  'channel',
  'hour',
  'day',
  'data_model',
  'data_provider',
]);

const AggregateMetricSchema = z.enum([
  'count',
  'avg_duration',
  'error_rate',
  'p95_duration',
  'sum_tokens',
  'sum_cost',
]);

function parseCsvQueryParam(value: unknown, fallback: string[]): string[] {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value !== 'string') {
    return [''];
  }

  if (value.trim().length === 0) {
    return fallback;
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Parse time range from query params, defaulting to last 24 hours.
 *  Supports `range` shorthand (e.g. '7d', '30d', '90d') in addition to ISO `from`/`to`. */
function parseTimeRange(from?: string, to?: string, range?: string) {
  const now = new Date();

  // If a shorthand range like '30d' is provided, compute `from` from it
  if (range && /^\d+d$/.test(range)) {
    const days = parseInt(range, 10);
    return {
      from: new Date(now.getTime() - days * 24 * 60 * 60 * 1000),
      to: now,
    };
  }

  return {
    from: from ? new Date(from) : new Date(now.getTime() - 24 * 60 * 60 * 1000),
    to: to ? new Date(to) : now,
  };
}

function getTenantIdOrRespond(
  req: { tenantContext?: { tenantId?: string } },
  res: { status(code: number): { json(body: unknown): void } },
): string | null {
  const tenantId = req.tenantContext?.tenantId;
  if (!tenantId) {
    res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    });
    return null;
  }
  return tenantId;
}

interface AnalyticsSessionSummaryRow {
  sessionId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  traceEventCount: number | string;
  messageCount: number | string;
  errorCount: number | string;
  latestAgentName: string;
  latestChannel: string;
  latestDeploymentId: string;
}

interface AnalyticsSessionLifecycleRow {
  tenant_id: string;
  sessionId: string;
  eventType: string;
  timestamp: string;
  agentName: string | null;
  channel: string | null;
  deploymentId: string | null;
  data: string | Record<string, unknown> | null;
  _enc?: string;
}

interface AnalyticsSessionUsageRow {
  sessionId: string;
  inputTokens: number | string;
  outputTokens: number | string;
  tokenCount: number | string;
  estimatedCost: number | string;
}

interface AnalyticsGenerationRow {
  sessionId: string;
  modelId: string;
  provider: string;
  operationType: string;
  agentName: string;
  inputTokens: number | string;
  outputTokens: number | string;
  totalTokens: number | string;
  estimatedCost: number | string;
  latencyMs: number | string;
  timestamp: string;
}

interface AnalyticsRuntimeVisibilityRow {
  sessionId: string;
}

interface LlmMetricsBucketRow {
  bucket: string;
  count?: number | string;
  avg_duration?: number | string;
  p95_duration?: number | string;
  sum_tokens?: number | string;
  sum_cost?: number | string;
}

async function getClickHouseAnalyticsDeps() {
  try {
    const clickhouse = await import('@agent-platform/database/clickhouse');
    const client = clickhouse.getClickHouseClient();
    if (!client) {
      return null;
    }
    return {
      client,
      parseClickHouseTimestamp: clickhouse.parseClickHouseTimestamp,
      toClickHouseDateTime: clickhouse.toClickHouseDateTime,
    };
  } catch {
    return null;
  }
}

async function decryptPlatformEventRows<T extends object>(rows: T[]): Promise<T[]> {
  if (
    rows.length === 0 ||
    !rows.some((row) => {
      const encryptedRow = row as { _enc?: unknown };
      return typeof encryptedRow._enc === 'string' && encryptedRow._enc.length > 0;
    })
  ) {
    return rows;
  }

  try {
    const { getClickHouseEncryptionInterceptor } =
      await import('../services/stores/clickhouse-encryption-singleton.js');
    const interceptor = getClickHouseEncryptionInterceptor();
    if (!interceptor) {
      return rows;
    }

    const decryptedRows = await interceptor.afterQuery(
      'platform_events',
      rows as Record<string, unknown>[],
    );
    return decryptedRows as T[];
  } catch (error) {
    log.debug('Failed to decrypt analytics platform event rows', {
      error: error instanceof Error ? error.message : String(error),
      rowCount: rows.length,
    });
    return rows;
  }
}

function parseNumericValue(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

async function queryLlmMetricsBuckets({
  tenantId,
  projectId,
  timeRange,
  groupBy,
  metrics,
}: {
  tenantId: string;
  projectId: string;
  timeRange: { from: Date; to: Date };
  groupBy: Array<'hour' | 'day'>;
  metrics: Array<'count' | 'avg_duration' | 'p95_duration' | 'sum_tokens' | 'sum_cost'>;
}): Promise<{ buckets: Record<string, unknown>[] } | null> {
  if (groupBy.length !== 1 || (groupBy[0] !== 'hour' && groupBy[0] !== 'day')) {
    return null;
  }

  const deps = await getClickHouseAnalyticsDeps();
  if (!deps) {
    return null;
  }

  const bucketExpression = groupBy[0] === 'hour' ? 'toStartOfHour(timestamp)' : 'toDate(timestamp)';
  const metricExpressions = metrics.map((metric) => {
    switch (metric) {
      case 'count':
        return 'count() AS count';
      case 'avg_duration':
        return 'avg(latency_ms) AS avg_duration';
      case 'p95_duration':
        return 'quantile(0.95)(latency_ms) AS p95_duration';
      case 'sum_tokens':
        return 'sum(total_tokens) AS sum_tokens';
      case 'sum_cost':
        return 'sum(estimated_cost) AS sum_cost';
    }
  });
  if (metricExpressions.length === 0) {
    return null;
  }

  const result = await deps.client.query({
    query: `
      SELECT
        ${bucketExpression} AS bucket,
        ${metricExpressions.join(',\n        ')}
      FROM abl_platform.llm_metrics
      WHERE tenant_id = {tenantId:String}
        AND project_id = {projectId:String}
        AND timestamp >= {from:DateTime64(3)}
        AND timestamp <= {to:DateTime64(3)}
        AND operation_type != 'turn_aggregate'
      GROUP BY bucket
      ORDER BY bucket ASC
      SETTINGS max_execution_time = 15
    `,
    query_params: {
      tenantId,
      projectId,
      from: deps.toClickHouseDateTime(timeRange.from),
      to: deps.toClickHouseDateTime(timeRange.to),
    },
    format: 'JSONEachRow',
  });

  const rows = await result.json<LlmMetricsBucketRow>();
  return {
    buckets: rows.map((row) => ({
      [groupBy[0]]: deps.parseClickHouseTimestamp(row.bucket).toISOString(),
      count: parseNumericValue(row.count),
      avg_duration: parseNumericValue(row.avg_duration),
      p95_duration: parseNumericValue(row.p95_duration),
      sum_tokens: parseNumericValue(row.sum_tokens),
      sum_cost: parseNumericValue(row.sum_cost),
    })),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseAnalyticsEventData(
  value: string | Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!value) {
    return {};
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return asRecord(parsed) ?? {};
    } catch {
      return {};
    }
  }

  return asRecord(value) ?? {};
}

function readFirstString(data: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

function normalizeEndedSessionStatus(
  value: string | undefined,
  options: { hasError: boolean },
): 'completed' | 'escalated' | 'failed' | 'ended' {
  const normalized = value?.trim().toLowerCase();

  if (normalized === 'completed') {
    return 'completed';
  }
  if (normalized === 'escalated') {
    return 'escalated';
  }
  if (
    normalized === 'failed' ||
    normalized === 'error' ||
    normalized === 'timeout' ||
    normalized === 'provider_error'
  ) {
    return 'failed';
  }
  if (
    normalized === 'abandoned' ||
    normalized === 'agent_hangup' ||
    normalized === 'transferred' ||
    normalized === 'user_left' ||
    normalized === 'user_exit' ||
    normalized === 'unengaged' ||
    normalized === 'user_hangup'
  ) {
    return 'ended';
  }

  return options.hasError ? 'failed' : 'ended';
}

function buildAnalyticsSessionStatus(
  lifecycleRows: AnalyticsSessionLifecycleRow[],
  options: { hasError: boolean },
): 'active' | 'completed' | 'escalated' | 'failed' | 'ended' {
  const endedRows = lifecycleRows.filter(
    (row) => row.eventType === 'session.ended' || row.eventType === 'voice.session.ended',
  );
  const lastEndedRow = endedRows.at(-1);
  if (!lastEndedRow) {
    return 'active';
  }

  const endedData = parseAnalyticsEventData(lastEndedRow.data);
  const explicitStatus = readFirstString(
    endedData,
    'status',
    'disposition',
    'reason',
    'session_outcome',
    'sessionOutcome',
  );

  return normalizeEndedSessionStatus(explicitStatus, options);
}

function buildAnalyticsSessionDurationMs(params: {
  createdAt: Date;
  lastActivityAt: Date;
  lifecycleRows: AnalyticsSessionLifecycleRow[];
}): number {
  const endedRows = params.lifecycleRows.filter(
    (row) => row.eventType === 'session.ended' || row.eventType === 'voice.session.ended',
  );
  const lastEndedRow = endedRows.at(-1);
  if (lastEndedRow) {
    const endedData = parseAnalyticsEventData(lastEndedRow.data);
    const explicitDuration = parseNumericValue(
      endedData.total_duration_ms ??
        endedData.totalDurationMs ??
        endedData.call_duration_ms ??
        endedData.callDurationMs,
    );
    if (explicitDuration > 0) {
      return explicitDuration;
    }
  }

  return Math.max(0, params.lastActivityAt.getTime() - params.createdAt.getTime());
}

function buildAnalyticsSessionAgentName(
  summaryRow: AnalyticsSessionSummaryRow,
  lifecycleRows: AnalyticsSessionLifecycleRow[],
): string {
  const startRow = lifecycleRows.find(
    (row) => row.eventType === 'session.started' || row.eventType === 'voice.session.started',
  );
  const startData = startRow ? parseAnalyticsEventData(startRow.data) : {};
  const startAgentName = startRow?.agentName?.trim();
  const latestAgentName = summaryRow.latestAgentName.trim();

  return (
    readFirstString(startData, 'agent_name', 'agentName') ??
    (startAgentName && startAgentName.length > 0 ? startAgentName : undefined) ??
    (latestAgentName.length > 0 ? latestAgentName : undefined) ??
    'Unknown agent'
  );
}

function buildAnalyticsSessionChannel(
  summaryRow: AnalyticsSessionSummaryRow,
  lifecycleRows: AnalyticsSessionLifecycleRow[],
): string | undefined {
  const startRow = lifecycleRows.find(
    (row) => row.eventType === 'session.started' || row.eventType === 'voice.session.started',
  );
  const startData = startRow ? parseAnalyticsEventData(startRow.data) : {};
  const startChannel = startRow?.channel?.trim();
  const latestChannel = summaryRow.latestChannel.trim();

  return (
    readFirstString(startData, 'channel', 'channelType') ??
    (startChannel && startChannel.length > 0 ? startChannel : undefined) ??
    (latestChannel.length > 0 ? latestChannel : undefined) ??
    undefined
  );
}

function buildAnalyticsSessionCreatedAt(
  summaryRow: AnalyticsSessionSummaryRow,
  lifecycleRows: AnalyticsSessionLifecycleRow[],
  parseClickHouseTimestamp: (timestamp: string | Date) => Date,
): Date {
  const startRow = lifecycleRows.find(
    (row) => row.eventType === 'session.started' || row.eventType === 'voice.session.started',
  );
  return parseClickHouseTimestamp(startRow?.timestamp ?? summaryRow.firstSeenAt);
}

const ANALYTICS_PAGE_LIMIT_DEFAULT = 1_000;
const ANALYTICS_PAGE_LIMIT_MAX = 5_000;

/**
 * Valid knownSource values for analytics filtering.
 * Rows written before the known_source column existed use the ClickHouse default 'production'.
 */
const VALID_KNOWN_SOURCES = new Set(['production', 'eval', 'synthetic']);

/**
 * Parse the knownSource query parameter into a ClickHouse SQL fragment and params.
 *
 * - No parameter / 'all': no filter (returns all sessions)
 * - 'production' (default when param is absent and Studio sets it): excludes eval & synthetic
 * - Comma-separated values: include only the specified sources
 *
 * Uses the first-class `known_source` ClickHouse column.
 */
function parseKnownSourceFilter(param?: string): {
  sql: string;
  params: Record<string, string>;
} {
  if (!param || param === 'all') {
    return { sql: '', params: {} };
  }

  const sources = param
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => VALID_KNOWN_SOURCES.has(s));

  if (sources.length === 0) {
    return { sql: '', params: {} };
  }

  const includesProduction = sources.includes('production');
  const nonProductionSources = sources.filter((s) => s !== 'production');

  if (includesProduction && nonProductionSources.length === 0) {
    return {
      sql: `AND known_source = 'production'`,
      params: {},
    };
  }

  if (!includesProduction && nonProductionSources.length > 0) {
    // Only non-production sources (e.g., 'eval', 'synthetic')
    const placeholders = nonProductionSources.map((_, i) => `{ks_${i}:String}`).join(', ');
    const params: Record<string, string> = {};
    nonProductionSources.forEach((s, i) => {
      params[`ks_${i}`] = s;
    });
    return {
      sql: `AND known_source IN (${placeholders})`,
      params,
    };
  }

  // Mix of production + non-production
  const placeholders = nonProductionSources.map((_, i) => `{ks_${i}:String}`).join(', ');
  const params: Record<string, string> = {};
  nonProductionSources.forEach((s, i) => {
    params[`ks_${i}`] = s;
  });
  return {
    sql: `AND (known_source = 'production' OR known_source IN (${placeholders}))`,
    params,
  };
}
const ANALYTICS_LIFECYCLE_EVENT_TYPES = [
  'session.started',
  'session.ended',
  'voice.session.started',
  'voice.session.ended',
];

// ─── GET /sessions ──────────────────────────────────────────────────────────

openapi.route(
  'get',
  '/sessions',
  {
    summary: 'List analytics sessions from ClickHouse',
    description:
      'Returns ClickHouse-backed session summaries for the selected time range. Live runtime sessions are excluded.',
    response: z.object({
      success: z.boolean(),
      data: z.object({
        total: z.number(),
        limit: z.number(),
        offset: z.number(),
        sessions: z.array(
          z.object({
            id: z.string(),
            agentId: z.string(),
            agentName: z.string(),
            status: z.string(),
            durationMs: z.number(),
            messageCount: z.number(),
            traceEventCount: z.number(),
            tokenCount: z.number(),
            estimatedCost: z.number(),
            errorCount: z.number(),
            channel: z.string().optional(),
            channelType: z.string().optional(),
            environment: z.string().optional(),
            disposition: z.string().nullable().optional(),
            createdAt: z.string(),
            lastActivityAt: z.string(),
            inputTokens: z.number().optional(),
            outputTokens: z.number().optional(),
            source: z.literal('clickhouse'),
          }),
        ),
      }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectWideAnalyticsAccess(req, res))) {
        return;
      }

      const deps = await getClickHouseAnalyticsDeps();
      if (!deps) {
        res.status(503).json({
          success: false,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Analytics database unavailable' },
        });
        return;
      }

      const tenantId = getTenantIdOrRespond(req, res);
      if (!tenantId) {
        return;
      }
      const { projectId } = req.params;
      const timeRange = parseTimeRange(
        req.query.from as string,
        req.query.to as string,
        req.query.range as string,
      );
      const limit = Math.max(
        1,
        Math.min(
          Number.parseInt(String(req.query.limit ?? ''), 10) || ANALYTICS_PAGE_LIMIT_DEFAULT,
          ANALYTICS_PAGE_LIMIT_MAX,
        ),
      );
      const offset = Math.max(0, Number.parseInt(String(req.query.offset ?? ''), 10) || 0);
      const clickhouseFrom = deps.toClickHouseDateTime(timeRange.from);
      const clickhouseTo = deps.toClickHouseDateTime(timeRange.to);

      // knownSource filter — exclude eval/synthetic sessions by default (production only)
      const knownSourceParam = req.query.knownSource as string | undefined;
      const knownSourceFilter = parseKnownSourceFilter(knownSourceParam);

      const [totalResult, sessionResult] = await Promise.all([
        deps.client.query({
          query: `
            SELECT uniqExact(session_id) AS total
            FROM abl_platform.platform_events_by_session
            WHERE tenant_id = {tenantId:String}
              AND project_id = {projectId:String}
              AND session_id != ''
              AND timestamp >= {from:DateTime64(3)}
              AND timestamp <= {to:DateTime64(3)}
              ${knownSourceFilter.sql}
            SETTINGS max_execution_time = 15
          `,
          query_params: {
            tenantId,
            projectId,
            from: clickhouseFrom,
            to: clickhouseTo,
            ...knownSourceFilter.params,
          },
          format: 'JSONEachRow',
        }),
        deps.client.query({
          query: `
            SELECT
              session_id AS sessionId,
              min(timestamp) AS firstSeenAt,
              max(timestamp) AS lastSeenAt,
              count() AS traceEventCount,
              countIf(category = 'message' OR event_type = 'voice.turn.completed') AS messageCount,
              countIf(has_error = 1) AS errorCount,
              argMax(agent_name, timestamp) AS latestAgentName,
              argMax(channel, timestamp) AS latestChannel,
              argMax(deployment_id, timestamp) AS latestDeploymentId
            FROM abl_platform.platform_events_by_session
            WHERE tenant_id = {tenantId:String}
              AND project_id = {projectId:String}
              AND session_id != ''
              AND timestamp >= {from:DateTime64(3)}
              AND timestamp <= {to:DateTime64(3)}
              ${knownSourceFilter.sql}
            GROUP BY session_id
            ORDER BY lastSeenAt DESC
            LIMIT {limit:UInt32}
            OFFSET {offset:UInt32}
            SETTINGS max_execution_time = 15
          `,
          query_params: {
            tenantId,
            projectId,
            from: clickhouseFrom,
            to: clickhouseTo,
            limit,
            offset,
            ...knownSourceFilter.params,
          },
          format: 'JSONEachRow',
        }),
      ]);

      const totalRows = await totalResult.json<{ total: number | string }>();
      const sessionRows = await sessionResult.json<AnalyticsSessionSummaryRow>();
      const total = parseNumericValue(totalRows[0]?.total);

      const sessionIds = sessionRows.map((row) => row.sessionId).filter((id) => id.length > 0);
      if (sessionIds.length === 0) {
        res.json({
          success: true,
          data: { total, limit, offset, sessions: [] },
        });
        return;
      }

      const [lifecycleResult, usageResult] = await Promise.all([
        deps.client.query({
          query: `
            SELECT
              tenant_id,
              session_id AS sessionId,
              event_type AS eventType,
              timestamp,
              agent_name AS agentName,
              channel,
              deployment_id AS deploymentId,
              data,
              _enc
            FROM abl_platform.platform_events_by_session
            WHERE tenant_id = {tenantId:String}
              AND project_id = {projectId:String}
              AND session_id IN ({sessionIds:Array(String)})
              AND event_type IN ({eventTypes:Array(String)})
            ORDER BY sessionId ASC, timestamp ASC
            SETTINGS max_execution_time = 15
          `,
          query_params: {
            tenantId,
            projectId,
            sessionIds,
            eventTypes: ANALYTICS_LIFECYCLE_EVENT_TYPES,
          },
          format: 'JSONEachRow',
        }),
        deps.client.query({
          query: `
            SELECT
              session_id AS sessionId,
              sum(input_tokens) AS inputTokens,
              sum(output_tokens) AS outputTokens,
              sum(total_tokens) AS tokenCount,
              sum(estimated_cost) AS estimatedCost
            FROM abl_platform.llm_metrics
            WHERE tenant_id = {tenantId:String}
              AND project_id = {projectId:String}
              AND session_id IN ({sessionIds:Array(String)})
              AND timestamp >= {from:DateTime64(3)}
              AND timestamp <= {to:DateTime64(3)}
            GROUP BY session_id
            SETTINGS max_execution_time = 15
          `,
          query_params: {
            tenantId,
            projectId,
            sessionIds,
            from: clickhouseFrom,
            to: clickhouseTo,
          },
          format: 'JSONEachRow',
        }),
      ]);

      const rawLifecycleRows = await lifecycleResult.json<AnalyticsSessionLifecycleRow>();
      const lifecycleRows = await decryptPlatformEventRows(rawLifecycleRows);
      const usageRows = await usageResult.json<AnalyticsSessionUsageRow>();

      const lifecycleBySessionId = new Map<string, AnalyticsSessionLifecycleRow[]>();
      for (const row of lifecycleRows) {
        const rowsForSession = lifecycleBySessionId.get(row.sessionId) ?? [];
        rowsForSession.push(row);
        lifecycleBySessionId.set(row.sessionId, rowsForSession);
      }

      const usageBySessionId = new Map<string, AnalyticsSessionUsageRow>();
      for (const row of usageRows) {
        usageBySessionId.set(row.sessionId, row);
      }

      const sessions = sessionRows.map((summaryRow) => {
        const lifecycleEntries = lifecycleBySessionId.get(summaryRow.sessionId) ?? [];
        const usage = usageBySessionId.get(summaryRow.sessionId);
        const createdAt = buildAnalyticsSessionCreatedAt(
          summaryRow,
          lifecycleEntries,
          deps.parseClickHouseTimestamp,
        );
        const lastActivityAt = deps.parseClickHouseTimestamp(summaryRow.lastSeenAt);
        const status = buildAnalyticsSessionStatus(lifecycleEntries, {
          hasError: parseNumericValue(summaryRow.errorCount) > 0,
        });
        const durationMs = buildAnalyticsSessionDurationMs({
          createdAt,
          lastActivityAt,
          lifecycleRows: lifecycleEntries,
        });
        const channel = buildAnalyticsSessionChannel(summaryRow, lifecycleEntries);
        const dispositionRow = lifecycleEntries
          .filter(
            (row) => row.eventType === 'session.ended' || row.eventType === 'voice.session.ended',
          )
          .at(-1);
        const dispositionData = dispositionRow ? parseAnalyticsEventData(dispositionRow.data) : {};
        const disposition = readFirstString(
          dispositionData,
          'disposition',
          'reason',
          'session_outcome',
          'sessionOutcome',
        );

        return {
          id: summaryRow.sessionId,
          agentId: buildAnalyticsSessionAgentName(summaryRow, lifecycleEntries),
          agentName: buildAnalyticsSessionAgentName(summaryRow, lifecycleEntries),
          status,
          durationMs,
          messageCount: parseNumericValue(summaryRow.messageCount),
          traceEventCount: parseNumericValue(summaryRow.traceEventCount),
          tokenCount: parseNumericValue(usage?.tokenCount),
          estimatedCost: parseNumericValue(usage?.estimatedCost),
          errorCount: parseNumericValue(summaryRow.errorCount),
          disposition: disposition ?? null,
          channel,
          channelType: channel,
          createdAt: createdAt.toISOString(),
          lastActivityAt: lastActivityAt.toISOString(),
          inputTokens: parseNumericValue(usage?.inputTokens),
          outputTokens: parseNumericValue(usage?.outputTokens),
          source: 'clickhouse' as const,
        };
      });

      res.json({
        success: true,
        data: {
          total,
          limit,
          offset,
          sessions,
        },
      });
    } catch (error) {
      log.error('Analytics sessions query failed', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'QUERY_EXECUTION_FAILED', message: 'Failed to query analytics sessions' },
      });
    }
  },
);

// ─── GET /generations ──────────────────────────────────────────────────────

openapi.route(
  'get',
  '/generations',
  {
    summary: 'List analytics generations from ClickHouse',
    description:
      'Returns ClickHouse-backed LLM generation rows for the selected time range from llm_metrics.',
    response: z.object({
      success: z.boolean(),
      data: z.object({
        total: z.number(),
        limit: z.number(),
        offset: z.number(),
        generations: z.array(
          z.object({
            id: z.string(),
            model: z.string(),
            name: z.string(),
            provider: z.string(),
            tokensIn: z.number(),
            tokensOut: z.number(),
            totalTokens: z.number(),
            latencyMs: z.number(),
            cost: z.number(),
            timestamp: z.string(),
            sessionId: z.string(),
          }),
        ),
      }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectWideAnalyticsAccess(req, res))) {
        return;
      }

      const deps = await getClickHouseAnalyticsDeps();
      if (!deps) {
        res.status(503).json({
          success: false,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Analytics database unavailable' },
        });
        return;
      }

      const tenantId = getTenantIdOrRespond(req, res);
      if (!tenantId) {
        return;
      }
      const { projectId } = req.params;
      const timeRange = parseTimeRange(
        req.query.from as string,
        req.query.to as string,
        req.query.range as string,
      );
      const limit = Math.max(
        1,
        Math.min(
          Number.parseInt(String(req.query.limit ?? ''), 10) || ANALYTICS_PAGE_LIMIT_DEFAULT,
          ANALYTICS_PAGE_LIMIT_MAX,
        ),
      );
      const offset = Math.max(0, Number.parseInt(String(req.query.offset ?? ''), 10) || 0);
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId.trim() : '';
      const clickhouseFrom = deps.toClickHouseDateTime(timeRange.from);
      const clickhouseTo = deps.toClickHouseDateTime(timeRange.to);

      const conditions = [
        'tenant_id = {tenantId:String}',
        'project_id = {projectId:String}',
        "session_id != ''",
        'timestamp >= {from:DateTime64(3)}',
        'timestamp <= {to:DateTime64(3)}',
        "operation_type != 'turn_aggregate'",
      ];
      const queryParams: Record<string, string | number> = {
        tenantId,
        projectId,
        from: clickhouseFrom,
        to: clickhouseTo,
        limit,
        offset,
      };

      if (sessionId.length > 0) {
        conditions.push('session_id = {sessionId:String}');
        queryParams.sessionId = sessionId;
      }

      const whereClause = conditions.join(' AND ');

      const [totalResult, generationResult] = await Promise.all([
        deps.client.query({
          query: `
            SELECT count() AS total
            FROM abl_platform.llm_metrics
            WHERE ${whereClause}
            SETTINGS max_execution_time = 15
          `,
          query_params: queryParams,
          format: 'JSONEachRow',
        }),
        deps.client.query({
          query: `
            SELECT
              session_id AS sessionId,
              model_id AS modelId,
              provider,
              operation_type AS operationType,
              agent_name AS agentName,
              input_tokens AS inputTokens,
              output_tokens AS outputTokens,
              total_tokens AS totalTokens,
              estimated_cost AS estimatedCost,
              latency_ms AS latencyMs,
              timestamp
            FROM abl_platform.llm_metrics
            WHERE ${whereClause}
            ORDER BY timestamp DESC
            LIMIT {limit:UInt32}
            OFFSET {offset:UInt32}
            SETTINGS max_execution_time = 15
          `,
          query_params: queryParams,
          format: 'JSONEachRow',
        }),
      ]);

      const totalRows = await totalResult.json<{ total: number | string }>();
      const generationRows = await generationResult.json<AnalyticsGenerationRow>();
      const total = parseNumericValue(totalRows[0]?.total);

      res.json({
        success: true,
        data: {
          total,
          limit,
          offset,
          generations: generationRows.map((row) => {
            const timestamp = deps.parseClickHouseTimestamp(row.timestamp).toISOString();
            const model = row.modelId || 'unknown';
            const provider = row.provider || 'unknown';
            const name = row.agentName || row.operationType || provider || 'LLM call';
            return {
              id: [
                row.sessionId,
                timestamp,
                model,
                provider,
                String(row.inputTokens),
                String(row.outputTokens),
                String(row.latencyMs),
              ].join(':'),
              model,
              name,
              provider,
              tokensIn: parseNumericValue(row.inputTokens),
              tokensOut: parseNumericValue(row.outputTokens),
              totalTokens: parseNumericValue(row.totalTokens),
              latencyMs: parseNumericValue(row.latencyMs),
              cost: parseNumericValue(row.estimatedCost),
              timestamp,
              sessionId: row.sessionId,
            };
          }),
        },
      });
    } catch (error) {
      log.error('Analytics generations query failed', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'QUERY_EXECUTION_FAILED',
          message: 'Failed to query analytics generations',
        },
      });
    }
  },
);

// ─── GET /flush-status ─────────────────────────────────────────────────────

openapi.route(
  'get',
  '/flush-status',
  {
    summary: 'Get live runtime session flush visibility',
    description:
      'Returns how many live runtime sessions exist for the project and how many are not yet visible in ClickHouse.',
    response: z.object({
      success: z.boolean(),
      data: z.object({
        liveSessionCount: z.number(),
        visibleLiveSessionCount: z.number(),
        unflushedLiveSessionCount: z.number(),
        pendingSessionIds: z.array(z.string()),
        lastCheckedAt: z.string(),
      }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectWideAnalyticsAccess(req, res))) {
        return;
      }

      const deps = await getClickHouseAnalyticsDeps();
      if (!deps) {
        res.status(503).json({
          success: false,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Analytics database unavailable' },
        });
        return;
      }

      const tenantId = getTenantIdOrRespond(req, res);
      if (!tenantId) {
        return;
      }
      const { projectId } = req.params;
      const executor = getRuntimeExecutor();
      const liveSessions = executor
        .listSessions()
        .map((summary) => executor.getSession(summary.id))
        .filter((session): session is NonNullable<typeof session> => Boolean(session))
        .filter((session) => session.tenantId === tenantId && session.projectId === projectId);

      if (liveSessions.length === 0) {
        res.json({
          success: true,
          data: {
            liveSessionCount: 0,
            visibleLiveSessionCount: 0,
            unflushedLiveSessionCount: 0,
            pendingSessionIds: [],
            lastCheckedAt: new Date().toISOString(),
          },
        });
        return;
      }

      const sessionIds = liveSessions.map((session) => session.id);
      const visibilityResult = await deps.client.query({
        query: `
          SELECT DISTINCT session_id AS sessionId
          FROM abl_platform.platform_events_by_session
          WHERE tenant_id = {tenantId:String}
            AND project_id = {projectId:String}
            AND session_id IN ({sessionIds:Array(String)})
          SETTINGS max_execution_time = 15
        `,
        query_params: {
          tenantId,
          projectId,
          sessionIds,
        },
        format: 'JSONEachRow',
      });

      const visibleRows = await visibilityResult.json<AnalyticsRuntimeVisibilityRow>();
      const visibleSessionIds = new Set(
        visibleRows.map((row) => row.sessionId).filter((sessionId) => sessionId.length > 0),
      );
      const pendingSessionIds = liveSessions
        .map((session) => session.id)
        .filter((sessionId) => !visibleSessionIds.has(sessionId));

      res.json({
        success: true,
        data: {
          liveSessionCount: liveSessions.length,
          visibleLiveSessionCount: visibleSessionIds.size,
          unflushedLiveSessionCount: pendingSessionIds.length,
          pendingSessionIds: pendingSessionIds.slice(0, 10),
          lastCheckedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      log.error('Analytics flush-status query failed', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'QUERY_EXECUTION_FAILED',
          message: 'Failed to query analytics flush status',
        },
      });
    }
  },
);

// ─── GET /metrics ───────────────────────────────────────────────────────────

openapi.route(
  'get',
  '/metrics',
  {
    summary: 'Get aggregated metrics',
    description: 'Returns aggregated event metrics grouped by specified dimensions',
    response: z.object({
      success: z.boolean(),
      data: z.object({
        buckets: z.array(z.record(z.unknown())),
      }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectWideAnalyticsAccess(req, res))) {
        return;
      }

      const tenantId = getTenantIdOrRespond(req, res);
      if (!tenantId) {
        return;
      }
      const { projectId } = req.params;
      const timeRange = parseTimeRange(req.query.from as string, req.query.to as string);

      const groupByParse = z
        .array(AggregateGroupBySchema)
        .min(1)
        .safeParse(parseCsvQueryParam(req.query.groupBy, ['category']));
      if (!groupByParse.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Invalid groupBy parameter' },
        });
        return;
      }

      const metricsParse = z
        .array(AggregateMetricSchema)
        .min(1)
        .safeParse(parseCsvQueryParam(req.query.metrics, ['count', 'error_rate']));
      if (!metricsParse.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Invalid metrics parameter' },
        });
        return;
      }

      if (req.query.category !== undefined && typeof req.query.category !== 'string') {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Invalid category parameter' },
        });
        return;
      }

      const categoryParse =
        typeof req.query.category === 'string' && req.query.category.trim().length > 0
          ? EventCategorySchema.safeParse(req.query.category.trim())
          : null;
      if (categoryParse && !categoryParse.success) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Invalid category parameter' },
        });
        return;
      }

      const groupBy = groupByParse.data;
      const metrics = metricsParse.data;
      const category = categoryParse?.data;

      if (category === 'llm') {
        const llmResult = await queryLlmMetricsBuckets({
          tenantId,
          projectId,
          timeRange,
          groupBy: groupBy.filter((dim): dim is 'hour' | 'day' => dim === 'hour' || dim === 'day'),
          metrics: metrics.filter(
            (
              metric,
            ): metric is 'count' | 'avg_duration' | 'p95_duration' | 'sum_tokens' | 'sum_cost' =>
              metric !== 'error_rate',
          ),
        });

        if (llmResult) {
          res.json({ success: true, data: llmResult });
          return;
        }
      }

      const queryService = await getQueryService();
      if (!queryService) {
        res.status(503).json({
          success: false,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Analytics service unavailable' },
        });
        return;
      }

      const result = await queryService.aggregate({
        tenantId,
        projectId,
        timeRange,
        groupBy,
        metrics,
        filters: category ? { category } : undefined,
      });

      res.json({ success: true, data: result });
    } catch (error) {
      log.error('Analytics metrics query failed', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'QUERY_EXECUTION_FAILED', message: 'Failed to query metrics' },
      });
    }
  },
);

// ─── GET /events ────────────────────────────────────────────────────────────

openapi.route(
  'get',
  '/events',
  {
    summary: 'List events with filters',
    description: 'Returns raw events matching filter criteria, ordered by timestamp descending',
    response: z.object({
      success: z.boolean(),
      data: z.object({
        events: z.array(z.record(z.unknown())),
        total: z.number(),
        hasMore: z.boolean(),
      }),
    }),
  },
  async (req, res) => {
    try {
      const sessionId =
        typeof req.query.sessionId === 'string' && req.query.sessionId.length > 0
          ? req.query.sessionId
          : undefined;
      if (sessionId) {
        const sessionAccess = await resolveProjectSessionAccess(req, {
          sessionId,
          projectId: req.params.projectId,
          requiredPermission: 'session:read',
        });
        if ('denial' in sessionAccess) {
          const body: Record<string, unknown> = {
            success: false,
            error: {
              code: 'ACCESS_DENIED',
              message: sessionAccess.denial.publicError,
            },
          };
          if (sessionAccess.denial.publicMessage) {
            body.message = sessionAccess.denial.publicMessage;
          }
          res.status(sessionAccess.denial.statusCode).json(body);
          return;
        }
      } else if (!(await requireProjectWideAnalyticsAccess(req, res))) {
        return;
      }

      const queryService = await getQueryService();
      if (!queryService) {
        res.status(503).json({
          success: false,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Analytics service unavailable' },
        });
        return;
      }

      const tenantId = getTenantIdOrRespond(req, res);
      if (!tenantId) {
        return;
      }
      const { projectId } = req.params;
      const timeRange = parseTimeRange(req.query.from as string, req.query.to as string);

      const limit = Math.min(Number(req.query.limit) || 100, 10000);
      const offset = Number(req.query.offset) || 0;

      const result = await queryService.query({
        tenantId,
        projectId,
        timeRange,
        category: req.query.category as any,
        eventTypes: req.query.eventTypes ? (req.query.eventTypes as string).split(',') : undefined,
        sessionId,
        agentName: req.query.agentName as string,
        hasError: req.query.hasError === 'true' ? true : undefined,
        limit,
        offset,
      });

      res.json({ success: true, data: result });
    } catch (error) {
      log.error('Analytics events query failed', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'QUERY_EXECUTION_FAILED', message: 'Failed to query events' },
      });
    }
  },
);

// ─── GET /agents/:agentName ─────────────────────────────────────────────────

openapi.route(
  'get',
  '/agents/:agentName',
  {
    summary: 'Get agent performance metrics',
    description: 'Returns performance metrics for a specific agent',
    response: z.object({
      success: z.boolean(),
      data: z.object({
        agentName: z.string(),
        timeRange: TimeRangeSchema,
        metrics: z.record(z.unknown()),
      }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectWideAnalyticsAccess(req, res))) return;

      const queryService = await getQueryService();
      if (!queryService) {
        res.status(503).json({
          success: false,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Analytics service unavailable' },
        });
        return;
      }

      const tenantId = getTenantIdOrRespond(req, res);
      if (!tenantId) {
        return;
      }
      const { projectId, agentName } = req.params;
      const timeRange = parseTimeRange(req.query.from as string, req.query.to as string);

      // Parallel queries for comprehensive agent metrics
      const [eventCounts, costBreakdown, errorAgg] = await Promise.all([
        queryService.count({
          tenantId,
          projectId,
          timeRange,
          groupBy: 'event_type',
          filters: { category: undefined },
        }),
        queryService.aggregate({
          tenantId,
          projectId,
          timeRange,
          groupBy: ['agent_name'],
          metrics: ['count', 'avg_duration', 'error_rate', 'sum_cost'],
          filters: { eventTypes: ['agent.entered', 'agent.exited'] },
        }),
        queryService.aggregate({
          tenantId,
          projectId,
          timeRange,
          groupBy: ['event_type'],
          metrics: ['count', 'avg_duration', 'error_rate'],
          filters: { eventTypes: ['tool.call.completed', 'tool.call.failed'] },
        }),
      ]);

      // Extract agent-specific counts
      const agentBuckets = costBreakdown.buckets.filter((b: any) => b.agent_name === agentName);

      res.json({
        success: true,
        data: {
          agentName,
          timeRange: {
            from: timeRange.from.toISOString(),
            to: timeRange.to.toISOString(),
          },
          metrics: {
            eventCounts: eventCounts.counts,
            agentMetrics: agentBuckets[0] || null,
            toolMetrics: errorAgg.buckets,
          },
        },
      });
    } catch (error) {
      log.error('Agent performance query failed', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
        agentName: req.params.agentName,
      });
      res.status(500).json({
        success: false,
        error: { code: 'QUERY_EXECUTION_FAILED', message: 'Failed to query agent metrics' },
      });
    }
  },
);

// ─── GET /cost-breakdown ────────────────────────────────────────────────────

openapi.route(
  'get',
  '/cost-breakdown',
  {
    summary: 'Get LLM cost breakdown',
    description: 'Returns cost breakdown by model and provider',
    response: z.object({
      success: z.boolean(),
      data: z.array(
        z.object({
          model: z.string(),
          provider: z.string(),
          callCount: z.number(),
          totalTokens: z.number(),
          totalCost: z.number(),
        }),
      ),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectWideAnalyticsAccess(req, res))) return;

      const deps = await getClickHouseAnalyticsDeps();
      if (!deps) {
        res.status(503).json({
          success: false,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Analytics database unavailable' },
        });
        return;
      }

      const tenantId = getTenantIdOrRespond(req, res);
      if (!tenantId) {
        return;
      }
      const { projectId } = req.params;
      const timeRange = parseTimeRange(
        req.query.from as string,
        req.query.to as string,
        req.query.range as string,
      );

      const clickhouseFrom = deps.toClickHouseDateTime(timeRange.from);
      const clickhouseTo = deps.toClickHouseDateTime(timeRange.to);
      const result = await deps.client.query({
        query: `
          SELECT
            model_id AS model,
            provider,
            count() AS callCount,
            sum(total_tokens) AS totalTokens,
            sum(estimated_cost) AS totalCost
          FROM abl_platform.llm_metrics
          WHERE tenant_id = {tenantId:String}
            AND project_id = {projectId:String}
            AND timestamp >= {from:DateTime64(3)}
            AND timestamp <= {to:DateTime64(3)}
            AND model_id != ''
            AND model_id != 'unknown'
            AND operation_type != 'turn_aggregate'
          GROUP BY model_id, provider
          ORDER BY totalCost DESC
          SETTINGS max_execution_time = 15
        `,
        query_params: {
          tenantId,
          projectId,
          from: clickhouseFrom,
          to: clickhouseTo,
        },
        format: 'JSONEachRow',
      });

      const rows = await result.json<{
        model: string;
        provider: string;
        callCount: number | string;
        totalTokens: number | string;
        totalCost: number | string;
      }>();

      res.json({
        success: true,
        data: rows.map((row) => ({
          model: row.model || 'unknown',
          provider: row.provider || 'unknown',
          callCount: parseNumericValue(row.callCount),
          totalTokens: parseNumericValue(row.totalTokens),
          totalCost: parseNumericValue(row.totalCost),
        })),
      });
    } catch (error) {
      log.error('Cost breakdown query failed', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'QUERY_EXECUTION_FAILED', message: 'Failed to query cost breakdown' },
      });
    }
  },
);

// ─── GET /session-metrics ───────────────────────────────────────────────────

openapi.route(
  'get',
  '/session-metrics',
  {
    summary: 'Get session-level metrics',
    description: 'Returns session completion rate, avg duration, avg cost',
    response: z.object({
      success: z.boolean(),
      data: z.object({
        totalSessions: z.number(),
        completedSessions: z.number(),
        completionRate: z.number(),
        avgDurationMs: z.number(),
        avgCost: z.number(),
      }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectWideAnalyticsAccess(req, res))) return;

      const queryService = await getQueryService();
      if (!queryService) {
        res.status(503).json({
          success: false,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Analytics service unavailable' },
        });
        return;
      }

      const tenantId = getTenantIdOrRespond(req, res);
      if (!tenantId) {
        return;
      }
      const { projectId } = req.params;
      const timeRange = parseTimeRange(
        req.query.from as string,
        req.query.to as string,
        req.query.range as string,
      );

      const result = await queryService.getSessionMetrics(tenantId, projectId, timeRange);
      res.json({ success: true, data: result });
    } catch (error) {
      log.error('Session metrics query failed', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'QUERY_EXECUTION_FAILED', message: 'Failed to query session metrics' },
      });
    }
  },
);

// ─── POST /query ────────────────────────────────────────────────────────────

const QueryBodySchema = z.object({
  timeRange: z.object({
    from: z.string(),
    to: z.string(),
  }),
  category: EventCategorySchema.optional(),
  eventTypes: z.array(z.string()).optional(),
  sessionId: z.string().optional(),
  agentName: z.string().optional(),
  hasError: z.boolean().optional(),
  limit: z.number().min(1).max(10000).default(100),
  offset: z.number().min(0).default(0),
});

openapi.route(
  'post',
  '/query',
  {
    summary: 'Ad-hoc event query',
    description: 'Execute a custom event query with full filter options',
    body: QueryBodySchema,
    response: z.object({
      success: z.boolean(),
      data: z.object({
        events: z.array(z.record(z.unknown())),
        total: z.number(),
        hasMore: z.boolean(),
      }),
    }),
  },
  async (req, res) => {
    try {
      const body = req.body;
      if (typeof body.sessionId === 'string' && body.sessionId.length > 0) {
        const sessionAccess = await resolveProjectSessionAccess(req, {
          sessionId: body.sessionId,
          projectId: req.params.projectId,
          requiredPermission: 'session:read',
        });
        if ('denial' in sessionAccess) {
          const denialBody: Record<string, unknown> = {
            success: false,
            error: {
              code: 'ACCESS_DENIED',
              message: sessionAccess.denial.publicError,
            },
          };
          if (sessionAccess.denial.publicMessage) {
            denialBody.message = sessionAccess.denial.publicMessage;
          }
          res.status(sessionAccess.denial.statusCode).json(denialBody);
          return;
        }
      } else if (!(await requireProjectWideAnalyticsAccess(req, res))) {
        return;
      }

      const queryService = await getQueryService();
      if (!queryService) {
        res.status(503).json({
          success: false,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Analytics service unavailable' },
        });
        return;
      }

      const tenantId = getTenantIdOrRespond(req, res);
      if (!tenantId) {
        return;
      }
      const { projectId } = req.params;

      const result = await queryService.query({
        tenantId,
        projectId,
        timeRange: {
          from: new Date(body.timeRange.from),
          to: new Date(body.timeRange.to),
        },
        category: body.category as any,
        eventTypes: body.eventTypes,
        sessionId: body.sessionId,
        agentName: body.agentName,
        hasError: body.hasError,
        limit: body.limit,
        offset: body.offset,
      });

      res.json({ success: true, data: result });
    } catch (error) {
      log.error('Ad-hoc query failed', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'QUERY_EXECUTION_FAILED', message: 'Failed to execute query' },
      });
    }
  },
);

// ─── POST /aggregate ────────────────────────────────────────────────────────

const AggregateBodySchema = z.object({
  timeRange: z.object({
    from: z.string(),
    to: z.string(),
  }),
  groupBy: z.array(AggregateGroupBySchema),
  metrics: z.array(AggregateMetricSchema),
  filters: z
    .object({
      category: EventCategorySchema.optional(),
      eventTypes: z.array(z.string()).optional(),
      hasError: z.boolean().optional(),
    })
    .optional(),
});

openapi.route(
  'post',
  '/aggregate',
  {
    summary: 'Ad-hoc aggregation query',
    description: 'Execute a custom aggregation query with GROUP BY dimensions',
    body: AggregateBodySchema,
    response: z.object({
      success: z.boolean(),
      data: z.object({
        buckets: z.array(z.record(z.unknown())),
      }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectWideAnalyticsAccess(req, res))) return;

      const queryService = await getQueryService();
      if (!queryService) {
        res.status(503).json({
          success: false,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Analytics service unavailable' },
        });
        return;
      }

      const tenantId = getTenantIdOrRespond(req, res);
      if (!tenantId) {
        return;
      }
      const { projectId } = req.params;
      const body = req.body;

      const result = await queryService.aggregate({
        tenantId,
        projectId,
        timeRange: {
          from: new Date(body.timeRange.from),
          to: new Date(body.timeRange.to),
        },
        groupBy: body.groupBy,
        metrics: body.metrics,
        filters: body.filters as any,
      });

      res.json({ success: true, data: result });
    } catch (error) {
      log.error('Aggregation query failed', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'QUERY_EXECUTION_FAILED', message: 'Failed to execute aggregation' },
      });
    }
  },
);

// ─── GET /event-counts ──────────────────────────────────────────────────────

openapi.route(
  'get',
  '/event-counts',
  {
    summary: 'Get event counts by category',
    description: 'Returns event counts grouped by a dimension',
    response: z.object({
      success: z.boolean(),
      data: z.object({
        counts: z.array(
          z.object({
            key: z.string(),
            count: z.number(),
            errorCount: z.number(),
          }),
        ),
      }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectWideAnalyticsAccess(req, res))) return;

      const queryService = await getQueryService();
      if (!queryService) {
        res.status(503).json({
          success: false,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Analytics service unavailable' },
        });
        return;
      }

      const tenantId = getTenantIdOrRespond(req, res);
      if (!tenantId) {
        return;
      }
      const { projectId } = req.params;
      const timeRange = parseTimeRange(req.query.from as string, req.query.to as string);

      const result = await queryService.getEventCounts(tenantId, projectId, timeRange);
      res.json({ success: true, data: result });
    } catch (error) {
      log.error('Event counts query failed', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'QUERY_EXECUTION_FAILED', message: 'Failed to query event counts' },
      });
    }
  },
);

// ─── GET /tables — List analytics tables available to /sql-query ───────────

openapi.route(
  'get',
  '/tables',
  {
    summary: 'List analytics tables available to /sql-query',
    description:
      'Returns the allowlist of ClickHouse tables that POST /sql-query will accept in a FROM clause, along with the per-query row cap.',
    response: z.object({
      success: z.boolean(),
      data: z
        .object({
          tables: z.array(
            z.object({
              name: z.string(),
              description: z.string(),
            }),
          ),
          maxRows: z.number(),
        })
        .optional(),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
    }),
  },
  async (req, res) => {
    if (!(await requireProjectWideAnalyticsAccess(req, res))) return;

    res.json({
      success: true,
      data: {
        tables: ALLOWED_ANALYTICS_TABLES,
        maxRows: MAX_SQL_QUERY_ROWS,
      },
    });
  },
);

// ─── GET /mongo-collections — List MongoDB collections for db-query node ───

openapi.route(
  'get',
  '/mongo-collections',
  {
    summary: 'List MongoDB collections available to the db-query pipeline node',
    description:
      'Returns the server-controlled allowlist of MongoDB collections that the db-query node accepts. Used by the Studio config form to populate the collection dropdown.',
    response: z.object({
      success: z.boolean(),
      data: z
        .object({
          collections: z.array(
            z.object({
              name: z.string(),
              description: z.string(),
              defaultQuery: z.string(),
            }),
          ),
        })
        .optional(),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
    }),
  },
  async (req, res) => {
    if (!(await requireProjectWideAnalyticsAccess(req, res))) return;

    res.json({
      success: true,
      data: { collections: ALLOWED_MONGO_COLLECTIONS },
    });
  },
);

// ─── GET /clickhouse-tables — List ClickHouse tables for db-query node ───────

openapi.route(
  'get',
  '/clickhouse-tables',
  {
    summary: 'List ClickHouse tables available to the db-query pipeline node',
    description:
      'Returns the server-controlled allowlist of ClickHouse tables (with session_id) that the db-query node accepts. Used by the Studio config form to populate the table dropdown.',
    response: z.object({
      success: z.boolean(),
      data: z
        .object({
          tables: z.array(
            z.object({
              name: z.string(),
              description: z.string(),
              defaultQuery: z.string(),
            }),
          ),
        })
        .optional(),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
    }),
  },
  async (req, res) => {
    if (!(await requireProjectWideAnalyticsAccess(req, res))) return;

    res.json({
      success: true,
      data: { tables: ALLOWED_CLICKHOUSE_TABLES },
    });
  },
);

// ─── POST /sql-query — Developer SQL query endpoint ────────────────────────

const FORBIDDEN_SQL_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|REPLACE|MERGE|ATTACH|DETACH|RENAME|OPTIMIZE|KILL)\b/i;

interface AnalyticsTableDescriptor {
  name: string;
  description: string;
}

// Every table in this allowlist MUST have both tenant_id and project_id columns
// so the mandatory WHERE filters (tenant_id = {tenantId:String} AND
// project_id = {projectId:String}) remain enforceable — this is what keeps
// cross-tenant leakage out of raw SQL.
const ALLOWED_ANALYTICS_TABLES: AnalyticsTableDescriptor[] = [
  {
    name: 'abl_platform.platform_events',
    description:
      'All analytics events (sessions, LLM/tool calls, agent events, custom events) with known_source for production/eval/synthetic filtering. Ordered by (tenant_id, category, event_type, timestamp).',
  },
  {
    name: 'abl_platform.platform_events_by_session',
    description:
      'Same columns as platform_events, ordered by (tenant_id, session_id, timestamp) — use this when filtering by session_id.',
  },
  {
    name: 'abl_platform.llm_metrics',
    description:
      'Per-call LLM usage: tokens, cost, latency, model, provider, agent_name, session_id.',
  },
  {
    name: 'abl_platform.llm_metrics_hourly_dest',
    description:
      'Pre-aggregated hourly LLM metrics (calls, tokens, cost) by model/provider/agent_name.',
  },
  {
    name: 'abl_platform.llm_metrics_daily_dest',
    description: 'Pre-aggregated daily LLM metrics (calls, tokens, cost) by model/provider.',
  },
  {
    name: 'abl_platform.platform_events_agent_hourly_dest',
    description: 'Pre-aggregated hourly platform-event rollup keyed by agent_name.',
  },
  {
    name: 'abl_platform.platform_events_tool_daily_dest',
    description: 'Pre-aggregated daily platform-event rollup keyed by tool_name.',
  },
  {
    name: 'abl_platform.platform_events_error_hourly_dest',
    description: 'Pre-aggregated hourly error counts keyed by event_type and error_type.',
  },
  {
    name: 'abl_platform.platform_events_voice_hourly_dest',
    description: 'Pre-aggregated hourly voice-turn metrics.',
  },
  {
    name: 'abl_platform.audit_events',
    description: 'Auth/authz and resource-change audit trail (action, actor_id, resource_type).',
  },
  {
    name: 'abl_platform.search_queries',
    description: 'Search query events with latency breakdown and result_count per index.',
  },
  {
    name: 'abl_platform.spatial_trace_records',
    description:
      'Structured trace records with sti_path, span/agent/tool identifiers, and attributes JSON.',
  },
  {
    name: 'abl_platform.insight_results',
    description: 'Pipeline evaluation results (score, status, dimensions) per insight_type.',
  },
  {
    name: 'abl_platform.custom_pipeline_results',
    description:
      'Custom pipeline run results: per-run scores, output JSON, source step status, and execution metadata (pipeline_name, run_id, score_name, score_value).',
  },
  {
    name: 'abl_platform.messages',
    description:
      'Conversation messages (user, assistant, system) written after session close — includes after-call-work content. Keyed by (tenant_id, project_id, session_id, created_at).',
  },
];

const ALLOWED_TABLE_NAMES = ALLOWED_ANALYTICS_TABLES.map((t) => t.name);
const MAX_SQL_QUERY_ROWS = 1000;
const SQL_QUERY_TIMEOUT_MS = 10_000;
const PARAMETERIZED_TENANT_FILTER = /\b(?:[\w]+\.)?tenant_id\s*=\s*\{tenantId:String\}(?!\w)/i;
const PARAMETERIZED_PROJECT_FILTER = /\b(?:[\w]+\.)?project_id\s*=\s*\{projectId:String\}(?!\w)/i;
const SQL_COMMENT_PATTERN = /(?:--|\/\*|#)/;
const SQL_COMPLEXITY_PATTERN = /\b(UNION|INTERSECT|EXCEPT|JOIN|WITH)\b/i;
const SQL_DISALLOWED_WHERE_PATTERN = /\bOR\b/i;
// Built from ALLOWED_ANALYTICS_TABLES so the allowlist lives in exactly one place.
const SQL_ALLOWED_FROM_PATTERN = new RegExp(
  `^(?:${ALLOWED_TABLE_NAMES.map((n) => n.replace(/\./g, '\\.')).join('|')})(?:\\s+(?:AS\\s+)?[A-Za-z_][A-Za-z0-9_]*)?$`,
  'i',
);
const SQL_CLAUSE_BOUNDARY_PATTERN =
  /\bWHERE\b|\bGROUP\s+BY\b|\bHAVING\b|\bORDER\s+BY\b|\bLIMIT\b|\bSETTINGS\b/i;
// Matches the top-level `LIMIT <n>` or `LIMIT <offset>, <n>`. Group 2 is the
// row-count that we clamp. We enforce single-SELECT + no-JOIN/CTE earlier, so
// a subquery LIMIT cannot slip past; the surrounding ClickHouse
// max_result_rows safety net covers any residual edge case (e.g. a string
// literal containing "LIMIT 9999999").
const LIMIT_CLAUSE_PATTERN = /\bLIMIT\s+(?:(\d+)\s*,\s*)?(\d+)\b/i;

const SqlQueryBodySchema = z.object({
  sql: z.string().min(1).max(5000).describe('ClickHouse SQL query (SELECT only)'),
  sessionId: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe('Optional session ID injected as {sessionId:String}'),
  timeRange: TimeRangeSchema.optional(),
});

function sanitizeSqlForValidation(sql: string): string {
  return sql
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:\\"|[^"])*"/g, '""')
    .replace(/`[^`]*`/g, '``')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSqlClause(sql: string, clause: 'FROM' | 'WHERE'): string | null {
  const start = clause === 'FROM' ? /\bFROM\b/i : /\bWHERE\b/i;
  const match = sql.match(start);
  if (!match || typeof match.index !== 'number') {
    return null;
  }

  const clauseStart = match.index + match[0].length;
  const remainder = sql.slice(clauseStart).trimStart();
  const boundaryMatch = remainder.match(SQL_CLAUSE_BOUNDARY_PATTERN);
  const clauseText = boundaryMatch
    ? remainder.slice(0, boundaryMatch.index).trim()
    : remainder.trim();

  return clauseText.length > 0 ? clauseText : null;
}

function applySqlSafetyRails(sql: string, maxRows: number, timeoutMs: number): string {
  // Strip any trailing SETTINGS clause the caller supplied — we always control
  // execution settings here — and re-append our own after clamping LIMIT.
  const withoutSettings = sql.replace(/\bSETTINGS\b[\s\S]*$/i, '').trimEnd();

  let withLimit = withoutSettings;
  const limitMatch = withoutSettings.match(LIMIT_CLAUSE_PATTERN);
  if (limitMatch) {
    const userLimit = Number.parseInt(limitMatch[2], 10);
    if (Number.isFinite(userLimit) && userLimit > maxRows) {
      const clampedLimit = `LIMIT ${limitMatch[1] ? `${limitMatch[1]}, ` : ''}${maxRows}`;
      withLimit = withoutSettings.replace(LIMIT_CLAUSE_PATTERN, clampedLimit);
    }
  } else {
    withLimit = `${withoutSettings}\nLIMIT ${maxRows}`;
  }

  const timeoutSeconds = Math.ceil(timeoutMs / 1000);
  return (
    `${withLimit}\nSETTINGS max_execution_time = ${timeoutSeconds}, ` +
    `max_result_rows = ${maxRows}, result_overflow_mode = 'break'`
  );
}

function validateDeveloperSqlQuery(sql: string): string | null {
  if (SQL_COMMENT_PATTERN.test(sql)) {
    return 'SQL comments are not supported on this endpoint';
  }

  const normalizedSql = sanitizeSqlForValidation(sql);
  const selectCount = normalizedSql.match(/\bSELECT\b/gi)?.length ?? 0;
  if (selectCount !== 1) {
    return 'Only single SELECT statements are allowed';
  }

  if (SQL_COMPLEXITY_PATTERN.test(normalizedSql)) {
    return 'Query must target a single analytics table without joins, unions, or CTEs';
  }

  const fromClause = extractSqlClause(normalizedSql, 'FROM');
  if (!fromClause || !SQL_ALLOWED_FROM_PATTERN.test(fromClause)) {
    return `Query must target a single analytics table. Allowed: ${ALLOWED_TABLE_NAMES.join(', ')}`;
  }

  const whereClause = extractSqlClause(normalizedSql, 'WHERE');
  if (!whereClause) {
    return 'Query must include tenant and project filters in the WHERE clause';
  }

  if (SQL_DISALLOWED_WHERE_PATTERN.test(whereClause)) {
    return 'OR conditions are not supported on this endpoint';
  }

  if (!PARAMETERIZED_TENANT_FILTER.test(whereClause)) {
    return 'Query must include a tenant_id = {tenantId:String} filter for security isolation';
  }
  if (!PARAMETERIZED_PROJECT_FILTER.test(whereClause)) {
    return 'Query must include a project_id = {projectId:String} filter for security isolation';
  }

  return null;
}

openapi.route(
  'post',
  '/sql-query',
  {
    summary: 'Execute developer SQL query',
    description:
      'Execute a raw ClickHouse SQL query (SELECT only) against analytics tables. Tenant isolation is enforced.',
    body: SqlQueryBodySchema,
    response: z.object({
      success: z.boolean(),
      data: z
        .object({
          columns: z.array(z.string()),
          rows: z.array(z.array(z.unknown())),
          rowCount: z.number(),
        })
        .optional(),
      executionTimeMs: z.number().optional(),
      error: z
        .object({
          code: z.string(),
          message: z.string(),
        })
        .optional(),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectWideAnalyticsAccess(req, res))) return;

      const tenantId = getTenantIdOrRespond(req, res);
      if (!tenantId) {
        return;
      }
      const { projectId } = req.params;
      const { sql } = req.body;
      const queryTimeRange = req.body.timeRange
        ? {
            from: new Date(req.body.timeRange.from),
            to: new Date(req.body.timeRange.to),
          }
        : null;

      if (
        queryTimeRange &&
        (!Number.isFinite(queryTimeRange.from.getTime()) ||
          !Number.isFinite(queryTimeRange.to.getTime()) ||
          queryTimeRange.from.getTime() >= queryTimeRange.to.getTime())
      ) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Invalid query time range' },
        });
        return;
      }

      // Security: Only allow SELECT statements
      const trimmedSql = sql.trim();
      if (!trimmedSql.toUpperCase().startsWith('SELECT')) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_QUERY', message: 'Only SELECT queries are allowed' },
        });
        return;
      }

      if (FORBIDDEN_SQL_KEYWORDS.test(trimmedSql)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'FORBIDDEN_SQL',
            message: 'Query contains forbidden SQL keywords. Only SELECT queries are allowed.',
          },
        });
        return;
      }

      const validationError = validateDeveloperSqlQuery(trimmedSql);
      if (validationError) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: validationError },
        });
        return;
      }

      // If the query uses {sessionId:String}, the caller must supply a value —
      // otherwise ClickHouse throws "Substitution not set" at execution time.
      if (/\{sessionId:String\}/i.test(trimmedSql) && !req.body.sessionId) {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message:
              'Query uses {sessionId:String} but no sessionId was provided in the request body',
          },
        });
        return;
      }

      // Get ClickHouse client
      let client;
      let toClickHouseDateTime: ((date: Date) => string) | undefined;
      try {
        const ch = await import('@agent-platform/database/clickhouse');
        client = ch.getClickHouseClient();
        toClickHouseDateTime = ch.toClickHouseDateTime;
      } catch (err) {
        log.error('ClickHouse unavailable for SQL query', {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(503).json({
          success: false,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Analytics database unavailable' },
        });
        return;
      }

      // Enforce row limit. Three layers of defence:
      //   1. Clamp user-supplied LIMIT to MAX_SQL_QUERY_ROWS (cap a naive 1M)
      //   2. Append LIMIT if the user didn't specify one
      //   3. ClickHouse SETTINGS max_result_rows + result_overflow_mode='break'
      //      so a future SQL bypass still can't exfiltrate more rows.
      const execSql = applySqlSafetyRails(trimmedSql, MAX_SQL_QUERY_ROWS, SQL_QUERY_TIMEOUT_MS);

      // Execute query with tenant isolation
      const startTime = Date.now();
      const queryParams: Record<string, string> = { tenantId, projectId };
      if (req.body.sessionId) queryParams.sessionId = req.body.sessionId;
      if (queryTimeRange && toClickHouseDateTime) {
        queryParams.from = toClickHouseDateTime(queryTimeRange.from);
        queryParams.to = toClickHouseDateTime(queryTimeRange.to);
      }

      const result = await client.query({
        query: execSql,
        query_params: queryParams,
        format: 'JSONCompactEachRowWithNames',
      });

      const text = await result.text();
      const lines = text.trim().split('\n').filter(Boolean);

      if (lines.length === 0) {
        res.json({
          success: true,
          data: { columns: [], rows: [], rowCount: 0 },
          executionTimeMs: Date.now() - startTime,
        });
        return;
      }

      // First line is column names
      const columns: string[] = JSON.parse(lines[0]);
      const rows: unknown[][] = [];
      for (let i = 1; i < lines.length; i++) {
        try {
          rows.push(JSON.parse(lines[i]));
        } catch {
          // Skip malformed rows
        }
      }

      res.json({
        success: true,
        data: { columns, rows, rowCount: rows.length },
        executionTimeMs: Date.now() - startTime,
      });
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      log.error('SQL query execution failed', { error: raw, projectId: req.params.projectId });
      // Strip the query body from ClickHouse messages (it contains tenant IDs).
      // Keep only the diagnostic clause before "in scope" or after the last period.
      const sanitized = raw.split(' in scope ')[0].split('\n')[0].slice(0, 300);
      res.status(500).json({
        success: false,
        error: { code: 'QUERY_EXECUTION_FAILED', message: sanitized || 'Query execution failed' },
      });
    }
  },
);

export default openapi.router;

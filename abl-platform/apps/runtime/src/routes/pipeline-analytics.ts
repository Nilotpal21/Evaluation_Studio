/**
 * Pipeline Analytics API Routes
 *
 * Mounted at /api/projects/:projectId/pipeline-analytics
 *
 * GET  /:pipelineType/summary             Scorecard metrics for a pipeline
 * GET  /:pipelineType/breakdown           Breakdown by dimension (agent, channel)
 * GET  /:pipelineType/conversations       Conversation list with score filters
 * GET  /:pipelineType/conversation/:sid   Single conversation detail
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
import { AnalyticsCache } from '@agent-platform/pipeline-engine';
import { resolveProjectSessionAccess } from '../middleware/session-access.js';
import {
  VALID_PIPELINE_TYPES,
  PIPELINE_TABLES,
  PIPELINE_MV_TABLES,
  PIPELINE_DATE_COLUMNS,
  buildLatestPipelineRowsSubquery,
  GUARDRAIL_FAILURE_PREDICATE,
  dateWindowPredicate,
  dateWindowQueryParams,
  isSessionEvaluationPipeline,
  parseOffsetDays,
  periodToDays,
  pipelineSourcePredicate,
  pipelineTableExpression,
  validatePipelineType,
  parseClickHouseRows,
  shouldDedupePipelineBySession,
} from './pipeline-analytics-helpers.js';
import { executePipelineSummary } from '../services/pipeline-analytics-summary.service.js';
import { Session } from '@agent-platform/database/models';

const log = createLogger('pipeline-analytics-route');

// ─── Agent name enrichment ───────────────────────────────────────────────────

type LeanSession = { _id: unknown; entryAgentName?: string | null; currentAgent?: string };
type SessionLookupFn = (ids: string[], tenantId: string) => Promise<LeanSession[]>;

/**
 * Fills in blank agent_name on conversation rows using MongoDB session data.
 * Exported for unit testing with plain async fixtures — no module mocks needed.
 * The route handler passes Session.find as the lookup; tests pass plain stubs.
 */
export async function enrichBlankAgentRows(
  conversations: Record<string, unknown>[],
  tenantId: string,
  lookupSessions: SessionLookupFn,
): Promise<void> {
  const blankRows = conversations.filter((c) => !c.agent_name);
  if (blankRows.length === 0) return;

  const sessionIds = blankRows.map((c) => String(c.session_id));
  const sessions = await lookupSessions(sessionIds, tenantId);
  const sessionMap = new Map(
    sessions.map((s) => [String(s._id), String(s.entryAgentName || s.currentAgent || '')]),
  );
  for (const row of conversations) {
    if (!row.agent_name) {
      row.agent_name = sessionMap.get(String(row.session_id)) ?? '';
    }
  }
}

const FLAGGED_FILTER_PIPELINES = new Set([
  'quality_evaluation',
  'hallucination_detection',
  'knowledge_gap',
  'guardrail_analysis',
  'context_preservation',
  'friction_detection',
  'drift_detection',
  'llm_evaluate',
]);

// ─── Lazy ClickHouse + Redis access ─────────────────────────────────────────

let analyticsCache: AnalyticsCache | null = null;

async function getCache(): Promise<AnalyticsCache> {
  if (analyticsCache) return analyticsCache;
  try {
    const { getRedisClient } = await import('../services/redis/redis-client.js');
    analyticsCache = new AnalyticsCache(getRedisClient());
  } catch (err) {
    log.warn('Redis cache unavailable, running without cache', {
      error: err instanceof Error ? err.message : String(err),
    });
    analyticsCache = new AnalyticsCache(null);
  }
  return analyticsCache;
}

async function getClickHouse() {
  const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
  return getClickHouseClient();
}

// ─── Router setup ───────────────────────────────────────────────────────────

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/pipeline-analytics',
  tags: ['Pipeline Analytics'],
});
const router: RouterType = openapi.router;

router.use(authMiddleware);
router.use(requireProjectScope('projectId', { concealOutOfScope: true }));
router.use(tenantRateLimit('request'));

// ─── Helpers (imported from ./pipeline-analytics-helpers.ts) ────────────────

// ─── GET /:pipelineType/summary ─────────────────────────────────────────────

openapi.route(
  'get',
  '/:pipelineType/summary',
  {
    summary: 'Get pipeline analytics summary',
    description: 'Returns scorecard metrics for a pipeline over a time period',
    response: z.object({
      success: z.boolean(),
      data: z.record(z.unknown()),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectWideAnalyticsAccess(req, res))) return;

      const { projectId, pipelineType } = req.params;
      const tenantId = req.tenantContext!.tenantId;
      const period = (req.query.period as string) || '7d';
      const offsetDays = parseOffsetDays(req.query.offsetDays);

      if (!validatePipelineType(pipelineType)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_PIPELINE_TYPE',
            message: `Invalid pipeline type: ${pipelineType}`,
          },
        });
        return;
      }

      const cache = await getCache();
      const cacheOpts = {
        tenantId,
        projectId,
        pipelineType,
        queryType: 'summary',
        params: { period, offsetDays },
      };

      const cached = await cache.get(cacheOpts);
      if (cached) {
        res.json({ success: true, data: cached });
        return;
      }

      const ch = await getClickHouse();
      const data = await executePipelineSummary(
        ch,
        tenantId,
        projectId,
        pipelineType,
        period,
        offsetDays,
      );

      await cache.set(cacheOpts, data);
      res.json({ success: true, data });
    } catch (error) {
      log.error('Pipeline summary query failed', {
        error: error instanceof Error ? error.message : String(error),
        pipelineType: req.params.pipelineType,
        projectId: req.params.projectId,
      });
      res.status(500).json({
        success: false,
        error: { code: 'PIPELINE_SUMMARY_FAILED', message: 'Failed to query pipeline summary' },
      });
    }
  },
);

// ─── GET /:pipelineType/breakdown ───────────────────────────────────────────

openapi.route(
  'get',
  '/:pipelineType/breakdown',
  {
    summary: 'Get pipeline breakdown by dimension',
    description: 'Returns pipeline metrics grouped by agent_name, channel, or intent',
    response: z.object({
      success: z.boolean(),
      data: z.array(z.record(z.unknown())),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectWideAnalyticsAccess(req, res))) return;

      const { projectId, pipelineType } = req.params;
      const tenantId = req.tenantContext!.tenantId;
      const period = (req.query.period as string) || '7d';
      const offsetDays = parseOffsetDays(req.query.offsetDays);
      const dimension = (req.query.dimension as string) || 'agent_name';

      if (!validatePipelineType(pipelineType)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_PIPELINE_TYPE',
            message: `Invalid pipeline type: ${pipelineType}`,
          },
        });
        return;
      }

      const allowedDimensions = ['agent_name', 'channel'];
      if (pipelineType === 'intent_classification') allowedDimensions.push('intent');
      if (!allowedDimensions.includes(dimension)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_DIMENSION', message: `Invalid dimension: ${dimension}` },
        });
        return;
      }

      const cache = await getCache();
      const cacheOpts = {
        tenantId,
        projectId,
        pipelineType,
        queryType: 'breakdown',
        params: { period, dimension, offsetDays },
      };

      const cached = await cache.get<Record<string, unknown>[]>(cacheOpts);
      if (cached) {
        res.json({ success: true, data: cached });
        return;
      }

      const ch = await getClickHouse();
      const days = periodToDays(period);
      const table = PIPELINE_TABLES[pipelineType];
      const dateParams = dateWindowQueryParams(days, offsetDays);
      const dateCol = PIPELINE_DATE_COLUMNS[pipelineType] ?? 'session_started_at';
      const shouldDedupeBySession = shouldDedupePipelineBySession(pipelineType);
      const source = shouldDedupeBySession
        ? buildLatestPipelineRowsSubquery(pipelineType, table, dateCol, offsetDays)
        : pipelineTableExpression(pipelineType, table);
      const datePredicate = dateWindowPredicate(dateCol, offsetDays);
      const sourcePredicate = pipelineSourcePredicate(pipelineType);
      const sourceScope = shouldDedupeBySession
        ? ''
        : `
          WHERE tenant_id = {tenantId:String}
            AND project_id = {projectId:String}
            AND ${datePredicate}
            ${sourcePredicate}
        `;

      let selectMetrics: string;
      if (pipelineType === 'intent_classification') {
        selectMetrics = `
          count() AS conversation_count,
          round(avg(confidence), 3) AS avg_confidence,
          countIf(resolution_status != '') AS evaluated_count,
          round(countIf(resolution_status = 'resolved') / nullif(countIf(resolution_status != ''), 0), 3) AS resolution_rate,
          round(countIf(resolution_status = 'partial') / nullif(countIf(resolution_status != ''), 0), 3) AS partial_rate
        `;
      } else if (pipelineType === 'sentiment_analysis') {
        selectMetrics = `
          count() AS conversation_count,
          round(avg(avg_sentiment), 3) AS avg_sentiment,
          sum(frustration_detected) AS frustrated_count
        `;
      } else if (pipelineType === 'friction_detection') {
        selectMetrics = `
          count() AS conversation_count,
          round(avg(friction_score), 3) AS avg_friction_score,
          sum(flagged) AS flagged_count
        `;
      } else if (pipelineType === 'knowledge_gap') {
        selectMetrics = `
          count() AS conversation_count,
          round(avg(overall_score), 3) AS avg_overall_score,
          sum(gap_detected) AS gap_count,
          sum(flagged) AS flagged_count
        `;
      } else if (pipelineType === 'guardrail_analysis') {
        selectMetrics = `
          count() AS conversation_count,
          round(avg(overall_score), 3) AS avg_overall_score,
          countIf(${GUARDRAIL_FAILURE_PREDICATE}) AS flagged_count
        `;
      } else {
        selectMetrics = `
          count() AS conversation_count,
          round(avg(overall_score), 3) AS avg_overall_score,
          sum(flagged) AS flagged_count
        `;
      }

      // SECURITY: dimension is validated against allowedDimensions allowlist above (line ~340).
      // It can only be 'agent_name', 'channel', or 'intent' — never user-supplied SQL.
      const query = `
        SELECT
          ${dimension},
          ${selectMetrics}
        FROM ${source}
        ${sourceScope}
        GROUP BY ${dimension}
        ORDER BY conversation_count DESC
        LIMIT 50
        SETTINGS max_execution_time = 15
      `;

      const result = await ch.query({
        query,
        query_params: { tenantId, projectId, ...dateParams },
      });
      const rawData = parseClickHouseRows(await result.json());

      // For agent_name breakdowns, drop rows with a blank agent_name. These are
      // historical sessions written before the conversation-reader field-name bug
      // was fixed. Since breakdown rows are aggregates (no session_id), we cannot
      // recover the real name via MongoDB — filtering is the only safe option.
      const data =
        dimension === 'agent_name'
          ? (rawData as Record<string, unknown>[]).filter((row) => row.agent_name)
          : rawData;

      await cache.set(cacheOpts, data);
      res.json({ success: true, data });
    } catch (error) {
      log.error('Pipeline breakdown query failed', {
        error: error instanceof Error ? error.message : String(error),
        pipelineType: req.params.pipelineType,
        projectId: req.params.projectId,
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'PIPELINE_BREAKDOWN_FAILED',
          message: 'Failed to query pipeline breakdown',
        },
      });
    }
  },
);

// ─── GET /:pipelineType/conversations ───────────────────────────────────────

openapi.route(
  'get',
  '/:pipelineType/conversations',
  {
    summary: 'List conversations with pipeline scores',
    description: 'Returns conversations matching score filters, ordered by recency',
    response: z.object({
      success: z.boolean(),
      data: z.object({
        conversations: z.array(z.record(z.unknown())),
        total: z.number(),
        hasMore: z.boolean(),
      }),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectWideAnalyticsAccess(req, res))) return;

      const { projectId, pipelineType } = req.params;
      const tenantId = req.tenantContext!.tenantId;
      const period = (req.query.period as string) || '7d';
      const filter = (req.query.filter as string) || '';
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const offset = Number(req.query.offset) || 0;

      if (!validatePipelineType(pipelineType)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_PIPELINE_TYPE',
            message: `Invalid pipeline type: ${pipelineType}`,
          },
        });
        return;
      }

      const cache = await getCache();
      const cacheOpts = {
        tenantId,
        projectId,
        pipelineType,
        queryType: 'conversations',
        params: { period, filter, limit, offset },
      };

      const cached = await cache.get(cacheOpts);
      if (cached) {
        res.json({ success: true, data: cached });
        return;
      }

      const ch = await getClickHouse();
      const days = periodToDays(period);
      const table = PIPELINE_TABLES[pipelineType];
      const dateCol = PIPELINE_DATE_COLUMNS[pipelineType] ?? 'session_started_at';
      const dedupeBySession = shouldDedupePipelineBySession(pipelineType);
      const source = dedupeBySession
        ? buildLatestPipelineRowsSubquery(pipelineType, table, dateCol)
        : pipelineTableExpression(pipelineType, table);
      const sourcePredicate = pipelineSourcePredicate(pipelineType);
      const sourceScope = dedupeBySession
        ? ''
        : `
          WHERE tenant_id = {tenantId:String}
            AND project_id = {projectId:String}
            AND ${dateCol} >= now() - INTERVAL {days:UInt32} DAY
            ${sourcePredicate}
        `;

      // Parse filter (e.g., "score_lt:3.0", "flagged:true", "trajectory:declining")
      let filterClause = '';
      const extraParams: Record<string, unknown> = {};
      if (filter) {
        const colonIdx = filter.indexOf(':');
        const filterKey = colonIdx === -1 ? filter : filter.slice(0, colonIdx);
        const filterValue = colonIdx === -1 ? '' : filter.slice(colonIdx + 1);
        if (filterKey === 'score_lt' && pipelineType === 'quality_evaluation') {
          filterClause = `AND overall_score < {filterScore:Float64}`;
          extraParams.filterScore = Number(filterValue) || 3.0;
        } else if (filterKey === 'score_gt' && pipelineType === 'quality_evaluation') {
          filterClause = `AND overall_score > {filterScore:Float64}`;
          extraParams.filterScore = Number(filterValue) || 3.0;
        } else if (filterKey === 'flagged' && FLAGGED_FILTER_PIPELINES.has(pipelineType)) {
          filterClause = `AND flagged = {filterFlagged:UInt8}`;
          extraParams.filterFlagged = filterValue === 'false' ? 0 : 1;
        } else if (filterKey === 'trajectory' && pipelineType === 'sentiment_analysis') {
          filterClause = `AND sentiment_trajectory = {filterTrajectory:String}`;
          extraParams.filterTrajectory = filterValue;
        } else if (filterKey === 'frustrated' && pipelineType === 'sentiment_analysis') {
          filterClause = `AND frustration_detected = 1`;
        } else if (filterKey === 'intent' && pipelineType === 'intent_classification') {
          filterClause = `AND intent = {filterIntent:String}`;
          extraParams.filterIntent = filterValue;
        }
      }
      const scopedFilterClause =
        filterClause && !sourceScope ? filterClause.replace(/^AND\s+/, 'WHERE ') : filterClause;

      // Select columns based on pipeline type
      let selectCols: string;
      if (pipelineType === 'sentiment_analysis') {
        selectCols =
          'session_id, session_started_at, agent_name, channel, avg_sentiment, sentiment_trajectory, frustration_detected';
      } else if (pipelineType === 'intent_classification') {
        selectCols =
          'session_id, session_started_at, agent_name, channel, intent, intent_display, confidence';
      } else if (pipelineType === 'hallucination_detection') {
        selectCols =
          'session_id, session_started_at, agent_name, channel, overall_score, faithfulness_score, flagged, flag_reasons';
      } else if (pipelineType === 'knowledge_gap') {
        selectCols =
          'session_id, session_started_at, agent_name, channel, overall_score, retrieval_precision, citation_rate, gap_detected, flagged, flag_reasons';
      } else if (pipelineType === 'guardrail_analysis') {
        selectCols =
          'session_id, session_started_at, agent_name, channel, overall_score, false_positive_score, false_negative_score, bypass_detected, severity, flagged, flag_reasons';
      } else if (pipelineType === 'context_preservation') {
        selectCols =
          'session_id, session_started_at, agent_name, channel, overall_score, context_score, duplication_detected, handoff_count, flagged, flag_reasons';
      } else if (pipelineType === 'friction_detection') {
        selectCols =
          'session_id, session_started_at, agent_name, channel, friction_score, rephrase_count, caps_count, exclamation_count, flagged';
      } else if (pipelineType === 'anomaly_detection') {
        selectCols =
          'session_id, processed_at, anomaly_flag, severity, z_score, metric_name, metric_value';
      } else if (pipelineType === 'drift_detection') {
        selectCols =
          'session_id, processed_at, drift_score, drift_type, baseline_mean, current_mean, flagged';
      } else if (pipelineType === 'llm_evaluate') {
        selectCols = 'session_id, processed_at, agent_name, channel, overall_score, flagged';
      } else {
        selectCols =
          'session_id, session_started_at, agent_name, channel, overall_score, helpfulness, accuracy, professionalism, instruction_following, custom_dimensions, flagged, flag_reasons';
      }

      const countQuery = `
        SELECT count() AS total
        FROM ${source}
        ${sourceScope}
          ${scopedFilterClause}
        SETTINGS max_execution_time = 15
      `;

      const dataQuery = `
        SELECT ${selectCols}
        FROM ${source}
        ${sourceScope}
          ${scopedFilterClause}
        ORDER BY ${dateCol} DESC
        LIMIT {limit:UInt32} OFFSET {offset:UInt32}
        SETTINGS max_execution_time = 15
      `;

      const queryParams = {
        tenantId,
        projectId,
        days,
        windowStartDays: days,
        offsetDays: 0,
        limit,
        offset,
        ...extraParams,
      };
      const [countResult, dataResult] = await Promise.all([
        ch.query({ query: countQuery, query_params: queryParams }),
        ch.query({ query: dataQuery, query_params: queryParams }),
      ]);

      const countRows = parseClickHouseRows(await countResult.json());
      const total = Number(countRows[0]?.total ?? 0);
      const conversations = parseClickHouseRows(await dataResult.json());

      // Enrich rows that have a blank agent_name (old data written before the
      // conversation-reader field-name bug was fixed). Non-fatal — if MongoDB
      // is unavailable, rows stay blank rather than failing the whole request.
      try {
        await enrichBlankAgentRows(
          conversations as Record<string, unknown>[],
          tenantId,
          (ids, tid) =>
            Session.find(
              { _id: { $in: ids }, tenantId: tid },
              { entryAgentName: 1, currentAgent: 1 },
            ).lean() as Promise<LeanSession[]>,
        );
      } catch (err) {
        log.warn('Failed to enrich blank agent_name rows from MongoDB (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const data = {
        conversations,
        total,
        hasMore: offset + limit < total,
      };

      await cache.set(cacheOpts, data);
      res.json({ success: true, data });
    } catch (error) {
      log.error('Pipeline conversations query failed', {
        error: error instanceof Error ? error.message : String(error),
        pipelineType: req.params.pipelineType,
        projectId: req.params.projectId,
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'PIPELINE_CONVERSATIONS_FAILED',
          message: 'Failed to query conversations',
        },
      });
    }
  },
);

// ─── GET /:pipelineType/conversation/:sessionId ─────────────────────────────

openapi.route(
  'get',
  '/:pipelineType/conversation/:sessionId',
  {
    summary: 'Get single conversation pipeline detail',
    description: 'Returns full pipeline analysis for a single conversation',
    response: z.object({
      success: z.boolean(),
      data: z.record(z.unknown()).nullable(),
    }),
  },
  async (req, res) => {
    try {
      const { projectId, pipelineType, sessionId } = req.params;
      const sessionAccess = await resolveProjectSessionAccess(req, {
        sessionId,
        projectId,
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

      const tenantId = req.tenantContext!.tenantId;

      if (!validatePipelineType(pipelineType)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_PIPELINE_TYPE',
            message: `Invalid pipeline type: ${pipelineType}`,
          },
        });
        return;
      }

      const cache = await getCache();
      const cacheOpts = {
        tenantId,
        projectId,
        pipelineType,
        queryType: 'conversation',
        params: { sessionId },
      };

      const cached = await cache.get(cacheOpts);
      if (cached) {
        res.json({ success: true, data: cached });
        return;
      }

      const ch = await getClickHouse();
      const table = PIPELINE_TABLES[pipelineType];

      // Get the conversation-level record
      const convQuery = `
        SELECT *
        FROM ${table}
        WHERE tenant_id = {tenantId:String}
          AND project_id = {projectId:String}
          AND session_id = {sessionId:String}
        ORDER BY processed_at DESC
        LIMIT 1
        SETTINGS max_execution_time = 15
      `;

      const convResult = await ch.query({
        query: convQuery,
        query_params: { tenantId, projectId, sessionId },
      });
      const convRows = parseClickHouseRows(await convResult.json());

      if (convRows.length === 0) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'No pipeline data found for this session' },
        });
        return;
      }

      let data: Record<string, unknown> = { ...convRows[0] };

      // For sentiment, also fetch per-message scores
      if (pipelineType === 'sentiment_analysis') {
        const msgQuery = `
          SELECT message_id, role, sentiment_score, sentiment_label, frustration_detected, frustration_signals
          FROM abl_platform.message_sentiment
          WHERE tenant_id = {tenantId:String}
            AND project_id = {projectId:String}
            AND session_id = {sessionId:String}
          ORDER BY message_at ASC
          SETTINGS max_execution_time = 15
        `;
        const msgResult = await ch.query({
          query: msgQuery,
          query_params: { tenantId, projectId, sessionId },
        });
        const messageSentiments = parseClickHouseRows(await msgResult.json());
        data.messageSentiments = messageSentiments;
      }

      await cache.set(cacheOpts, data);
      res.json({ success: true, data });
    } catch (error) {
      log.error('Pipeline conversation detail query failed', {
        error: error instanceof Error ? error.message : String(error),
        pipelineType: req.params.pipelineType,
        sessionId: req.params.sessionId,
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'PIPELINE_CONVERSATION_DETAIL_FAILED',
          message: 'Failed to query conversation detail',
        },
      });
    }
  },
);

// ─── GET /:pipelineType/timeseries ──────────────────────────────────────────

openapi.route(
  'get',
  '/:pipelineType/timeseries',
  {
    summary: 'Get pipeline metrics timeseries',
    description: 'Returns daily aggregated metrics for trend analysis',
    response: z.object({
      success: z.boolean(),
      data: z.array(z.record(z.unknown())),
    }),
  },
  async (req, res) => {
    try {
      if (!(await requireProjectWideAnalyticsAccess(req, res))) return;

      const { projectId, pipelineType } = req.params;
      const tenantId = req.tenantContext!.tenantId;
      const period = (req.query.period as string) || '30d';
      const offsetDays = parseOffsetDays(req.query.offsetDays);

      if (!validatePipelineType(pipelineType)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_PIPELINE_TYPE',
            message: `Invalid pipeline type: ${pipelineType}`,
          },
        });
        return;
      }

      const cache = await getCache();
      const cacheOpts = {
        tenantId,
        projectId,
        pipelineType,
        queryType: 'timeseries',
        params: { period, offsetDays },
      };

      const cached = await cache.get<Record<string, unknown>[]>(cacheOpts);
      if (cached) {
        res.json({ success: true, data: cached });
        return;
      }

      const ch = await getClickHouse();
      const days = periodToDays(period);
      const dateParams = dateWindowQueryParams(days, offsetDays);
      const mvTable = PIPELINE_MV_TABLES[pipelineType];
      const dateCol = PIPELINE_DATE_COLUMNS[pipelineType] ?? 'session_started_at';
      const datePredicate = dateWindowPredicate(dateCol, offsetDays);

      let query: string;
      // Intent classification timeseries needs resolution_status which is not in
      // the materialized view. Use raw table directly so we can include
      // resolution_rate and partial_rate per day. Cost is acceptable: daily
      // granularity over <=90 days = small result set.
      // Collapse to the latest row per session before daily aggregation. A
      // session may have realtime and batch rows, and only the latest row should
      // contribute to intent, confidence, and resolution metrics.
      if (pipelineType === 'intent_classification') {
        const rawTable = PIPELINE_TABLES.intent_classification;
        query = `
          SELECT
            day,
            count() AS conversation_count,
            round(avg(confidence), 3) AS avg_confidence,
            uniqExact(intent) AS unique_intents,
            countIf(resolution_status != '') AS evaluated_count,
            round(countIf(resolution_status = 'resolved') / nullif(countIf(resolution_status != ''), 0), 3) AS resolution_rate,
            round(countIf(resolution_status = 'partial') / nullif(countIf(resolution_status != ''), 0), 3) AS partial_rate
          FROM (
            SELECT
              session_id,
              toDate(argMax(${dateCol}, processed_at)) AS day,
              argMax(intent, processed_at) AS intent,
              argMax(confidence, processed_at) AS confidence,
              argMax(resolution_status, processed_at) AS resolution_status
            FROM ${rawTable}
            WHERE tenant_id = {tenantId:String}
              AND project_id = {projectId:String}
              AND ${datePredicate}
            GROUP BY session_id
          )
          GROUP BY day
          ORDER BY day ASC
          SETTINGS max_execution_time = 15
        `;
      } else if (isSessionEvaluationPipeline(pipelineType)) {
        const rawTable = PIPELINE_TABLES[pipelineType];
        const rawTableExpression = pipelineTableExpression(pipelineType, rawTable);
        const sourcePredicate = pipelineSourcePredicate(pipelineType);
        const avgAlias = pipelineType === 'quality_evaluation' ? 'avg_overall_score' : 'avg_score';
        const flaggedExpression =
          pipelineType === 'knowledge_gap'
            ? 'sum(gap_detected)'
            : pipelineType === 'guardrail_analysis'
              ? `countIf(${GUARDRAIL_FAILURE_PREDICATE})`
              : 'sum(flagged)';

        query = `
          SELECT
            toDate(${dateCol}) AS day,
            count() AS conversation_count,
            round(avg(overall_score), 3) AS ${avgAlias},
            ${flaggedExpression} AS flagged_count
          FROM ${rawTableExpression}
          WHERE tenant_id = {tenantId:String}
            AND project_id = {projectId:String}
            AND ${datePredicate}
            ${sourcePredicate}
          GROUP BY day
          ORDER BY day ASC
          SETTINGS max_execution_time = 15
        `;
      } else if (mvTable) {
        // Use materialized view for original pipeline types
        // MV column is `date`, aliased to `day` for API consistency.
        // MV uses SummingMergeTree so columns store sums — divide to get averages.
        // Use `cnt` alias to avoid ClickHouse ILLEGAL_AGGREGATION with column name collision.
        let selectMetrics: string;
        if (pipelineType === 'sentiment_analysis') {
          const rawTable = PIPELINE_TABLES.sentiment_analysis;
          query = `
            SELECT
              day,
              count() AS conversation_count,
              round(avg(avg_sentiment), 3) AS avg_sentiment,
              sum(frustration_detected) AS frustrated_count
            FROM (
              SELECT
                toDate(${dateCol}) AS day,
                session_id,
                argMax(avg_sentiment, processed_at) AS avg_sentiment,
                argMax(frustration_detected, processed_at) AS frustration_detected
              FROM ${rawTable}
              WHERE tenant_id = {tenantId:String}
                AND project_id = {projectId:String}
                AND ${datePredicate}
              GROUP BY day, session_id
            )
            GROUP BY day
            ORDER BY day ASC
            SETTINGS max_execution_time = 15
          `;
        } else {
          // mv_daily_llm_evaluate uses eval_count/scored_eval_count/total_score —
          // it has no conversation_count or flagged_count columns.
          selectMetrics = `
            date AS day,
            sum(eval_count) AS cnt,
            round(sum(total_score) / nullIf(sum(scored_eval_count), 0), 3) AS avg_overall_score,
            0 AS flagged_count
          `;

          // Wrap in subquery to rename cnt back to conversation_count for API consistency
          query = `
            SELECT day, cnt AS conversation_count, * EXCEPT (day, cnt)
            FROM (
              SELECT ${selectMetrics}
              FROM ${mvTable}
              WHERE tenant_id = {tenantId:String}
                AND project_id = {projectId:String}
                AND ${dateWindowPredicate('date', offsetDays)}
              GROUP BY date
              ORDER BY date ASC
            )
            ORDER BY day ASC
            SETTINGS max_execution_time = 15
          `;
        }
      } else {
        // Fall back to raw table aggregation for new pipeline types
        const rawTable = PIPELINE_TABLES[pipelineType];
        const scoreCol =
          pipelineType === 'friction_detection'
            ? 'friction_score'
            : pipelineType === 'anomaly_detection'
              ? 'z_score'
              : pipelineType === 'drift_detection'
                ? 'drift_score'
                : 'overall_score';
        const flagCol = pipelineType === 'anomaly_detection' ? 'anomaly_flag' : 'flagged';

        query = `
          SELECT
            toDate(${dateCol}) AS day,
            count() AS conversation_count,
            round(avg(${scoreCol}), 3) AS avg_score,
            sum(${flagCol}) AS flagged_count
          FROM ${rawTable}
          WHERE tenant_id = {tenantId:String}
            AND project_id = {projectId:String}
            AND ${datePredicate}
          GROUP BY day
          ORDER BY day ASC
          SETTINGS max_execution_time = 15
        `;
      }

      const result = await ch.query({
        query,
        query_params: { tenantId, projectId, ...dateParams },
      });
      const data = parseClickHouseRows(await result.json());

      await cache.set(cacheOpts, data);
      res.json({ success: true, data });
    } catch (error) {
      log.error('Pipeline timeseries query failed', {
        error: error instanceof Error ? error.message : String(error),
        pipelineType: req.params.pipelineType,
        projectId: req.params.projectId,
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'PIPELINE_TIMESERIES_FAILED',
          message: 'Failed to query pipeline timeseries',
        },
      });
    }
  },
);

export default openapi.router;

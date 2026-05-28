/**
 * Voice Analytics API Routes
 *
 * Mounted at /api/projects/:projectId/voice-analytics
 *
 * GET  /hourly   Hourly aggregated voice metrics from materialized view
 * GET  /summary  Summary KPIs for dashboard cards
 */

import { type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { createOpenAPIRouter, getValidatedRequestData } from '@agent-platform/openapi/express';
import { createLogger } from '@abl/compiler/platform';
import { authMiddleware } from '../middleware/auth.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { requireProjectScope } from '@agent-platform/shared';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import { runtimeRegistry } from '../openapi/registry.js';

const log = createLogger('voice-analytics-route');
const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/voice-analytics',
  tags: ['Voice Analytics'],
  validateRequests: true,
  wrapAsyncHandlers: true,
  onValidationError: (_error, _req, res) => {
    res.status(400).json({ success: false, error: 'Invalid query parameters' });
  },
});
const router: RouterType = openapi.router;

// Middleware chain
router.use(authMiddleware);
router.use(requireProjectScope('projectId'));

const DEFAULT_HOURS_BACK = 168;

const voiceAnalyticsQueryValueSchema = z.union([z.string(), z.array(z.string())]);

const voiceAnalyticsParamsSchema = z.object({
  projectId: z.string().min(1).describe('Project ID'),
});

const voiceAnalyticsQuerySchema = z.object({
  hours: voiceAnalyticsQueryValueSchema.optional(),
});

const voiceAnalyticsHourlyResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(z.record(z.unknown())),
});

const voiceAnalyticsSummaryResponseSchema = z.object({
  success: z.literal(true),
  data: z.record(z.unknown()),
});

type VoiceAnalyticsParams = z.infer<typeof voiceAnalyticsParamsSchema>;
type VoiceAnalyticsQuery = z.infer<typeof voiceAnalyticsQuerySchema>;
type VoiceAnalyticsQueryValue = z.infer<typeof voiceAnalyticsQueryValueSchema>;

interface VoiceAnalyticsRequestState {
  projectId?: string;
  tenantId?: string;
  hoursBack: number;
}

function stringifyQueryValue(value: VoiceAnalyticsQueryValue | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return String(value);
}

function parseHoursBack(value: VoiceAnalyticsQueryValue | undefined): number {
  return Number.parseInt(stringifyQueryValue(value) ?? '', 10) || DEFAULT_HOURS_BACK;
}

function getRequestProjectId(
  request: Request,
  params: VoiceAnalyticsParams | undefined,
): string | undefined {
  return (
    params?.projectId ??
    (request as Request & { projectId?: string }).projectId ??
    request.params.projectId
  );
}

function getVoiceAnalyticsRequestState(
  request: Request,
  response: Pick<Response, 'locals'>,
): VoiceAnalyticsRequestState {
  const validated = getValidatedRequestData(response);
  const params = validated?.params as VoiceAnalyticsParams | undefined;
  const query = validated?.query as VoiceAnalyticsQuery | undefined;

  return {
    projectId: getRequestProjectId(request, params),
    tenantId: request.tenantContext?.tenantId,
    hoursBack: parseHoursBack(query?.hours),
  };
}

/**
 * GET /api/projects/:projectId/voice-analytics/hourly
 * Returns aggregated hourly voice metrics from materialized view
 */
openapi.route(
  'get',
  '/hourly',
  {
    summary: 'Get hourly voice analytics',
    description:
      'Returns aggregated hourly voice call metrics for a project from the ClickHouse materialized view.',
    params: voiceAnalyticsParamsSchema,
    query: voiceAnalyticsQuerySchema,
    response: voiceAnalyticsHourlyResponseSchema,
  },
  async (req: Request, res: Response) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const { projectId, tenantId, hoursBack } = getVoiceAnalyticsRequestState(req, res);
      const legacyProjectId = (req as Request & { projectId?: string }).projectId;

      log.info('[DEBUG] Voice analytics hourly query params', {
        projectId,
        tenantId,
        hoursBack,
        reqProjectId: legacyProjectId,
        paramsProjectId: req.params.projectId,
        hasTenantContext: !!req.tenantContext,
      });

      if (!projectId || !tenantId) {
        log.warn('[DEBUG] Missing required params', { projectId, tenantId });
        res.status(400).json({ success: false, error: 'Missing projectId or tenantId' });
        return;
      }

      const client = getClickHouseClient();
      if (!client) {
        log.warn('ClickHouse client unavailable');
        res.status(503).json({ success: false, error: 'Analytics service unavailable' });
        return;
      }

      const result = await client.query({
        query: `
        WITH aggregated AS (
          SELECT
            hour,
            sum(session_count) AS session_count,
            sum(error_count) AS error_count,
            sum(sum_call_duration_ms) AS total_call_duration_ms,
            sum(sum_inbound_mos) AS total_inbound_mos,
            sum(sum_outbound_mos) AS total_outbound_mos,
            sum(sum_inbound_jitter_ms) AS total_inbound_jitter_ms,
            sum(sum_outbound_jitter_ms) AS total_outbound_jitter_ms,
            sum(sum_e2e_latency_ms) AS total_e2e_latency_ms,
            sum(sum_barge_in_rate) AS total_barge_in_rate,
            sum(sum_dtmf_fallback_rate) AS total_dtmf_fallback_rate,
            sum(sum_asr_score) AS total_asr_score,
            sum(sum_tts_proxy_mos) AS total_tts_proxy_mos,
            sum(sum_silence_percent) AS total_silence_percent,
            sum(total_turns) AS total_turns,
            sum(total_barge_in_count) AS total_barge_in_count,
            sum(total_dtmf_turn_count) AS total_dtmf_turn_count,
            sum(mos_sample_count) AS mos_sample_count,
            sum(metric_sample_count) AS metric_sample_count
          FROM abl_platform.platform_events_voice_hourly_dest
          WHERE tenant_id = {tenantId:String}
            AND project_id = {projectId:String}
            AND hour >= now() - INTERVAL {hoursBack:UInt32} HOUR
          GROUP BY hour
        )
        SELECT
          hour,
          session_count,
          error_count,

          -- Calculate averages from aggregated sums
          if(session_count > 0, total_call_duration_ms / session_count, 0) AS avg_call_duration_ms,
          if(mos_sample_count > 0, total_inbound_mos / mos_sample_count, NULL) AS avg_inbound_mos,
          if(mos_sample_count > 0, total_outbound_mos / mos_sample_count, NULL) AS avg_outbound_mos,
          if(mos_sample_count > 0, total_inbound_jitter_ms / mos_sample_count, NULL) AS avg_inbound_jitter_ms,
          if(mos_sample_count > 0, total_outbound_jitter_ms / mos_sample_count, NULL) AS avg_outbound_jitter_ms,
          if(metric_sample_count > 0, total_e2e_latency_ms / metric_sample_count, NULL) AS avg_e2e_latency_ms,
          if(metric_sample_count > 0, total_barge_in_rate / metric_sample_count, NULL) AS avg_barge_in_rate,
          if(metric_sample_count > 0, total_dtmf_fallback_rate / metric_sample_count, NULL) AS avg_dtmf_fallback_rate,
          if(metric_sample_count > 0, total_asr_score / metric_sample_count, NULL) AS avg_asr_score,
          if(metric_sample_count > 0, total_tts_proxy_mos / metric_sample_count, NULL) AS avg_tts_proxy_mos,
          if(metric_sample_count > 0, total_silence_percent / metric_sample_count, NULL) AS avg_silence_percent,

          -- Totals
          total_turns,
          total_barge_in_count,
          total_dtmf_turn_count,

          -- Sample counts
          mos_sample_count,
          metric_sample_count
        FROM aggregated
        ORDER BY hour ASC
        LIMIT 500
        SETTINGS max_execution_time = 15
      `,
        query_params: { tenantId, projectId, hoursBack },
        format: 'JSONEachRow',
      });

      const data = (await result.json()) as Record<string, unknown>[];

      log.info('Voice analytics hourly data fetched', {
        projectId,
        tenantId,
        hoursBack,
        rowCount: data.length,
      });

      res.json({ success: true, data });
    } catch (error) {
      log.error('Voice analytics hourly query failed', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({ success: false, error: 'Failed to fetch voice analytics' });
    }
  },
);

/**
 * GET /api/projects/:projectId/voice-analytics/summary
 * Returns summary KPIs for the dashboard cards
 */
openapi.route(
  'get',
  '/summary',
  {
    summary: 'Get voice analytics summary',
    description:
      'Returns summary KPIs for voice calls in the selected project over the requested lookback window.',
    params: voiceAnalyticsParamsSchema,
    query: voiceAnalyticsQuerySchema,
    response: voiceAnalyticsSummaryResponseSchema,
  },
  async (req: Request, res: Response) => {
    try {
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;

      const { projectId, tenantId, hoursBack } = getVoiceAnalyticsRequestState(req, res);

      if (!projectId || !tenantId) {
        log.warn('[DEBUG] Summary missing required params', { projectId, tenantId });
        res.status(400).json({ success: false, error: 'Missing projectId or tenantId' });
        return;
      }

      const client = getClickHouseClient();
      if (!client) {
        log.warn('ClickHouse client unavailable');
        res.status(503).json({ success: false, error: 'Analytics service unavailable' });
        return;
      }

      const result = await client.query({
        query: `
        SELECT
          sum(session_count) AS total_calls,
          sum(error_count) AS total_errors,
          if(sum(session_count) > 0, sum(sum_call_duration_ms) / sum(session_count), 0) AS avg_call_duration_ms,

          -- Weighted averages
          if(sum(mos_sample_count) > 0, sum(sum_inbound_mos) / sum(mos_sample_count), NULL) AS overall_avg_inbound_mos,
          if(sum(mos_sample_count) > 0, sum(sum_outbound_mos) / sum(mos_sample_count), NULL) AS overall_avg_outbound_mos,
          if(sum(mos_sample_count) > 0, sum(sum_inbound_jitter_ms) / sum(mos_sample_count), NULL) AS overall_avg_inbound_jitter_ms,
          if(sum(metric_sample_count) > 0, sum(sum_e2e_latency_ms) / sum(metric_sample_count), NULL) AS overall_avg_latency_ms,
          if(sum(metric_sample_count) > 0, sum(sum_barge_in_rate) / sum(metric_sample_count), NULL) AS overall_barge_in_rate,
          if(sum(metric_sample_count) > 0, sum(sum_dtmf_fallback_rate) / sum(metric_sample_count), NULL) AS overall_dtmf_fallback_rate,
          if(sum(metric_sample_count) > 0, sum(sum_asr_score) / sum(metric_sample_count), NULL) AS overall_asr_score,

          sum(total_turns) AS total_turns,
          sum(total_barge_in_count) AS total_barge_in_count,
          sum(total_dtmf_turn_count) AS total_dtmf_turn_count

        FROM abl_platform.platform_events_voice_hourly_dest
        WHERE tenant_id = {tenantId:String}
          AND project_id = {projectId:String}
          AND hour >= now() - INTERVAL {hoursBack:UInt32} HOUR
        SETTINGS max_execution_time = 15
      `,
        query_params: { tenantId, projectId, hoursBack },
        format: 'JSONEachRow',
      });

      const rows = await result.json<Record<string, unknown>>();
      const summary: Record<string, unknown> = rows[0] ?? {};

      log.info('Voice analytics summary fetched', {
        projectId,
        tenantId,
        hoursBack,
        totalCalls: summary.total_calls,
      });

      res.json({ success: true, data: summary });
    } catch (error) {
      log.error('Voice analytics summary query failed', {
        error: error instanceof Error ? error.message : String(error),
        projectId: req.params.projectId,
      });
      res.status(500).json({ success: false, error: 'Failed to fetch voice summary' });
    }
  },
);

export default router;

/**
 * ClickHouse insight query helpers for Arch AI read_insights tool.
 *
 * Pure query functions — no tool wiring, no auth context.
 * All queries include tenant_id + project_id for isolation.
 * All use parameterized queries with max_execution_time = 10.
 */
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('arch-ai:insight-queries');

const DB = 'abl_platform';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InsightSummary {
  insightType: string;
  granularity: string;
  avgScore: number;
  minScore: number;
  maxScore: number;
  totalRecords: number;
  failCount: number;
  warnCount: number;
  passCount: number;
  latestEvaluatedAt: string;
}

export interface QualitySnapshot {
  sessionCount: number;
  avgOverallScore: number;
  avgHelpfulness: number;
  avgAccuracy: number;
  avgProfessionalism: number;
  avgInstructionFollowing: number;
  flaggedCount: number;
  flaggedPercent: number;
}

export interface OutcomeBreakdown {
  outcome: string;
  count: number;
  percent: number;
  avgConfidence: number;
}

export interface AgentPerformance {
  agentName: string;
  invocations: number;
  errors: number;
  escalations: number;
  handoffs: number;
  toolCalls: number;
  toolErrors: number;
  avgDurationMs: number;
}

export interface SentimentTrend {
  avgScore: number;
  trajectory: 'improving' | 'declining' | 'stable';
  frustrationRate: number;
  sessionCount: number;
}

export interface ToolPerformanceRow {
  toolName: string;
  callCount: number;
  successRate: number;
  errorRate: number;
  retryRate: number;
  avgLatencyMs: number;
}

type TimeRange = '1h' | '24h' | '7d' | '30d';

interface QueryOptions {
  agentName?: string;
  timeRange?: TimeRange;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a time range to hours for ClickHouse INTERVAL.
 * All queries use INTERVAL {hours} HOUR for consistency — avoids the
 * 1h→1day rounding issue while keeping a single parameterized unit.
 */
function timeRangeToHours(range: TimeRange): number {
  switch (range) {
    case '1h':
      return 1;
    case '24h':
      return 24;
    case '7d':
      return 168;
    case '30d':
      return 720;
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Dispatcher — single entry point for the tool
// ---------------------------------------------------------------------------

type InsightAction =
  | 'overview'
  | 'quality'
  | 'outcomes'
  | 'agent_performance'
  | 'sentiment'
  | 'tool_performance';

export async function queryInsights(
  action: InsightAction,
  tenantId: string,
  projectId: string,
  options?: QueryOptions,
): Promise<{ success: boolean; data?: unknown; error?: { code: string; message: string } }> {
  try {
    const range = options?.timeRange ?? '7d';
    const agentName = options?.agentName;

    switch (action) {
      case 'overview':
        return {
          success: true,
          data: await queryInsightSummary(tenantId, projectId, { timeRange: range }),
        };
      case 'quality':
        return {
          success: true,
          data: await queryQualityScores(tenantId, projectId, { agentName, timeRange: range }),
        };
      case 'outcomes':
        return {
          success: true,
          data: await queryOutcomes(tenantId, projectId, { agentName, timeRange: range }),
        };
      case 'agent_performance':
        return {
          success: true,
          data: await queryAgentPerformance(tenantId, projectId, { agentName, timeRange: range }),
        };
      case 'sentiment':
        return {
          success: true,
          data: await querySentimentTrend(tenantId, projectId, { agentName, timeRange: range }),
        };
      case 'tool_performance':
        return {
          success: true,
          data: await queryToolPerformance(tenantId, projectId, { timeRange: range }),
        };
      default:
        return {
          success: false,
          error: { code: 'INVALID_ACTION', message: `Unknown insight action: ${action}` },
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Insight query failed', { action, tenantId, projectId, error: message });
    return { success: false, error: { code: 'INSIGHT_QUERY_ERROR', message } };
  }
}

// ---------------------------------------------------------------------------
// Query: Insight overview (from insight_results table)
// ---------------------------------------------------------------------------

export async function queryInsightSummary(
  tenantId: string,
  projectId: string,
  options?: { timeRange?: TimeRange },
): Promise<InsightSummary[]> {
  const hours = timeRangeToHours(options?.timeRange ?? '7d');
  const client = getClickHouseClient();

  const result = await client.query({
    query: `
      SELECT
        insight_type,
        granularity,
        avg(score) AS avg_score,
        min(score) AS min_score,
        max(score) AS max_score,
        count() AS total_records,
        countIf(status = 'fail') AS fail_count,
        countIf(status = 'warn') AS warn_count,
        countIf(status = 'pass') AS pass_count,
        max(evaluated_at) AS latest
      FROM ${DB}.insight_results
      WHERE tenant_id = {tenantId:String}
        AND project_id = {projectId:String}
        AND evaluated_at >= now() - INTERVAL {hours:UInt32} HOUR
      GROUP BY insight_type, granularity
      ORDER BY avg_score ASC
      SETTINGS max_execution_time = 10
    `,
    query_params: { tenantId, projectId, hours },
  });

  const rows = ((await result.json()) as { data: Array<Record<string, unknown>> }).data;

  return rows.map((r) => ({
    insightType: String(r.insight_type),
    granularity: String(r.granularity),
    avgScore: round3(Number(r.avg_score)),
    minScore: round3(Number(r.min_score)),
    maxScore: round3(Number(r.max_score)),
    totalRecords: Number(r.total_records),
    failCount: Number(r.fail_count),
    warnCount: Number(r.warn_count),
    passCount: Number(r.pass_count),
    latestEvaluatedAt: String(r.latest),
  }));
}

// ---------------------------------------------------------------------------
// Query: Quality scores (from quality_evaluations table)
// ---------------------------------------------------------------------------

export async function queryQualityScores(
  tenantId: string,
  projectId: string,
  options?: { agentName?: string; timeRange?: TimeRange },
): Promise<QualitySnapshot> {
  const hours = timeRangeToHours(options?.timeRange ?? '7d');
  const client = getClickHouseClient();

  const agentFilter = options?.agentName ? 'WHERE agent_name = {agentName:String}' : '';
  const params: Record<string, unknown> = { tenantId, projectId, hours };
  if (options?.agentName) params.agentName = options.agentName;

  const result = await client.query({
    query: `
      SELECT
        count() AS session_count,
        avg(overall_score) AS avg_overall,
        avg(helpfulness) AS avg_helpfulness,
        avg(accuracy) AS avg_accuracy,
        avg(professionalism) AS avg_professionalism,
        avg(instruction_following) AS avg_instruction_following,
        countIf(flagged = 1) AS flagged_count
      FROM (
        SELECT
          session_id,
          argMax(agent_name, processed_at) AS agent_name,
          argMax(overall_score, processed_at) AS overall_score,
          argMax(helpfulness, processed_at) AS helpfulness,
          argMax(accuracy, processed_at) AS accuracy,
          argMax(professionalism, processed_at) AS professionalism,
          argMax(instruction_following, processed_at) AS instruction_following,
          argMax(flagged, processed_at) AS flagged
        FROM ${DB}.quality_evaluations
        WHERE tenant_id = {tenantId:String}
          AND project_id = {projectId:String}
          AND processed_at >= now() - INTERVAL {hours:UInt32} HOUR
        GROUP BY session_id
      )
      ${agentFilter}
      SETTINGS max_execution_time = 10
    `,
    query_params: params,
  });

  const rows = ((await result.json()) as { data: Array<Record<string, unknown>> }).data;
  const r = rows[0] ?? {};

  const sessionCount = Number(r.session_count) || 0;
  const flaggedCount = Number(r.flagged_count) || 0;

  return {
    sessionCount,
    avgOverallScore: round3(Number(r.avg_overall) || 0),
    avgHelpfulness: round3(Number(r.avg_helpfulness) || 0),
    avgAccuracy: round3(Number(r.avg_accuracy) || 0),
    avgProfessionalism: round3(Number(r.avg_professionalism) || 0),
    avgInstructionFollowing: round3(Number(r.avg_instruction_following) || 0),
    flaggedCount,
    flaggedPercent: sessionCount > 0 ? round3(flaggedCount / sessionCount) : 0,
  };
}

// ---------------------------------------------------------------------------
// Query: Outcome breakdown (from conversation_outcomes table)
// ---------------------------------------------------------------------------

export async function queryOutcomes(
  tenantId: string,
  projectId: string,
  options?: { agentName?: string; timeRange?: TimeRange },
): Promise<OutcomeBreakdown[]> {
  const hours = timeRangeToHours(options?.timeRange ?? '7d');
  const client = getClickHouseClient();

  const agentFilter = options?.agentName ? 'WHERE agent_name = {agentName:String}' : '';
  const params: Record<string, unknown> = { tenantId, projectId, hours };
  if (options?.agentName) params.agentName = options.agentName;

  const result = await client.query({
    query: `
      SELECT
        outcome,
        count() AS cnt,
        avg(confidence) AS avg_confidence
      FROM (
        SELECT
          session_id,
          argMax(agent_name, processed_at) AS agent_name,
          argMax(outcome, processed_at) AS outcome,
          argMax(confidence, processed_at) AS confidence
        FROM ${DB}.conversation_outcomes
        WHERE tenant_id = {tenantId:String}
          AND project_id = {projectId:String}
          AND processed_at >= now() - INTERVAL {hours:UInt32} HOUR
        GROUP BY session_id
      )
      ${agentFilter}
      GROUP BY outcome
      ORDER BY cnt DESC
      SETTINGS max_execution_time = 10
    `,
    query_params: params,
  });

  const rows = ((await result.json()) as { data: Array<Record<string, unknown>> }).data;
  const total = rows.reduce((sum, r) => sum + Number(r.cnt), 0);

  return rows.map((r) => ({
    outcome: String(r.outcome),
    count: Number(r.cnt),
    percent: total > 0 ? round3(Number(r.cnt) / total) : 0,
    avgConfidence: round3(Number(r.avg_confidence) || 0),
  }));
}

// ---------------------------------------------------------------------------
// Query: Agent performance (from materialized view)
// ---------------------------------------------------------------------------

export async function queryAgentPerformance(
  tenantId: string,
  projectId: string,
  options?: { agentName?: string; timeRange?: TimeRange },
): Promise<AgentPerformance[]> {
  const hours = timeRangeToHours(options?.timeRange ?? '7d');
  const client = getClickHouseClient();

  const agentFilter = options?.agentName ? 'AND agent_name = {agentName:String}' : '';
  const params: Record<string, unknown> = { tenantId, projectId, hours };
  if (options?.agentName) params.agentName = options.agentName;

  const result = await client.query({
    query: `
      SELECT
        agent_name,
        sum(invocation_count) AS invocations,
        sum(error_count) AS errors,
        sum(escalation_count) AS escalations,
        sum(handoff_count) AS handoffs,
        sum(tool_call_count) AS tool_calls,
        sum(tool_error_count) AS tool_errors,
        sum(sum_duration_ms) / greatest(sum(invocation_count), 1) AS avg_duration_ms
      FROM ${DB}.platform_events_agent_hourly_dest
      WHERE tenant_id = {tenantId:String}
        AND project_id = {projectId:String}
        AND hour >= now() - INTERVAL {hours:UInt32} HOUR
        ${agentFilter}
      GROUP BY agent_name
      ORDER BY invocations DESC
      SETTINGS max_execution_time = 10
    `,
    query_params: params,
  });

  const rows = ((await result.json()) as { data: Array<Record<string, unknown>> }).data;

  return rows.map((r) => ({
    agentName: String(r.agent_name),
    invocations: Number(r.invocations),
    errors: Number(r.errors),
    escalations: Number(r.escalations),
    handoffs: Number(r.handoffs),
    toolCalls: Number(r.tool_calls),
    toolErrors: Number(r.tool_errors),
    avgDurationMs: Math.round(Number(r.avg_duration_ms)),
  }));
}

// ---------------------------------------------------------------------------
// Query: Sentiment trend (from conversation_sentiment table)
// ---------------------------------------------------------------------------

export async function querySentimentTrend(
  tenantId: string,
  projectId: string,
  options?: { agentName?: string; timeRange?: TimeRange },
): Promise<SentimentTrend> {
  const hours = timeRangeToHours(options?.timeRange ?? '7d');
  const client = getClickHouseClient();

  const agentFilter = options?.agentName ? 'WHERE agent_name = {agentName:String}' : '';
  const params: Record<string, unknown> = { tenantId, projectId, hours };
  if (options?.agentName) params.agentName = options.agentName;

  const result = await client.query({
    query: `
      SELECT
        count() AS session_count,
        avg(avg_sentiment) AS avg_score,
        countIf(frustration_detected = 1) AS frustration_count,
        avgIf(avg_sentiment, processed_at >= now() - INTERVAL {halfHours:UInt32} HOUR) AS recent_avg,
        avgIf(avg_sentiment, processed_at < now() - INTERVAL {halfHours:UInt32} HOUR) AS older_avg
      FROM (
        SELECT
          session_id,
          argMax(agent_name, processed_at) AS agent_name,
          max(processed_at) AS processed_at,
          argMax(avg_sentiment, processed_at) AS avg_sentiment,
          argMax(frustration_detected, processed_at) AS frustration_detected
        FROM ${DB}.conversation_sentiment
        WHERE tenant_id = {tenantId:String}
          AND project_id = {projectId:String}
          AND processed_at >= now() - INTERVAL {hours:UInt32} HOUR
        GROUP BY session_id
      )
      ${agentFilter}
      SETTINGS max_execution_time = 10
    `,
    query_params: { ...params, halfHours: Math.max(1, Math.floor(hours / 2)) },
  });

  const rows = ((await result.json()) as { data: Array<Record<string, unknown>> }).data;
  const r = rows[0] ?? {};

  const sessionCount = Number(r.session_count) || 0;
  const frustrationCount = Number(r.frustration_count) || 0;
  const recentAvg = Number(r.recent_avg) || 0;
  const olderAvg = Number(r.older_avg) || 0;

  let trajectory: 'improving' | 'declining' | 'stable' = 'stable';
  if (sessionCount > 0 && (olderAvg !== 0 || recentAvg !== 0)) {
    const delta = recentAvg - olderAvg;
    if (delta > 0.1) trajectory = 'improving';
    else if (delta < -0.1) trajectory = 'declining';
  }

  return {
    avgScore: round3(Number(r.avg_score) || 0),
    trajectory,
    frustrationRate: sessionCount > 0 ? round3(frustrationCount / sessionCount) : 0,
    sessionCount,
  };
}

// ---------------------------------------------------------------------------
// Query: Tool performance (from materialized view)
// ---------------------------------------------------------------------------

export async function queryToolPerformance(
  tenantId: string,
  projectId: string,
  options?: { timeRange?: TimeRange },
): Promise<ToolPerformanceRow[]> {
  const hours = timeRangeToHours(options?.timeRange ?? '7d');
  const client = getClickHouseClient();
  const result =
    hours <= 24
      ? await client.query({
          query: `
            SELECT
              JSONExtractString(data, 'tool_name') AS tool_name,
              count() AS calls,
              countIf(event_type = 'tool.call.completed' AND has_error = 0) AS successes,
              countIf(has_error = 1) AS errors,
              countIf(event_type = 'tool.call.retried') AS retries,
              sum(duration_ms) / greatest(count(), 1) AS avg_latency
            FROM ${DB}.platform_events
            WHERE tenant_id = {tenantId:String}
              AND project_id = {projectId:String}
              AND timestamp >= now() - INTERVAL {hours:UInt32} HOUR
              AND event_type IN ('tool.call.completed', 'tool.call.failed', 'tool.call.retried')
            GROUP BY tool_name
            ORDER BY calls DESC
            SETTINGS max_execution_time = 10
          `,
          query_params: { tenantId, projectId, hours },
        })
      : await client.query({
          query: `
            SELECT
              tool_name,
              sum(call_count) AS calls,
              sum(success_count) AS successes,
              sum(error_count) AS errors,
              sum(retry_count) AS retries,
              sum(sum_latency_ms) / greatest(sum(call_count), 1) AS avg_latency
            FROM ${DB}.platform_events_tool_daily_dest
            WHERE tenant_id = {tenantId:String}
              AND project_id = {projectId:String}
              AND day >= today() - {dayWindow:UInt32}
            GROUP BY tool_name
            ORDER BY calls DESC
            SETTINGS max_execution_time = 10
          `,
          query_params: {
            tenantId,
            projectId,
            dayWindow: Math.max(0, Math.ceil(hours / 24) - 1),
          },
        });

  const rows = ((await result.json()) as { data: Array<Record<string, unknown>> }).data;

  return rows.map((r) => {
    const calls = Number(r.calls) || 0;
    const successes = Number(r.successes) || 0;
    const errors = Number(r.errors) || 0;
    const retries = Number(r.retries) || 0;

    return {
      toolName: String(r.tool_name),
      callCount: calls,
      successRate: calls > 0 ? round3(successes / calls) : 0,
      errorRate: calls > 0 ? round3(errors / calls) : 0,
      retryRate: calls > 0 ? round3(retries / calls) : 0,
      avgLatencyMs: Math.round(Number(r.avg_latency) || 0),
    };
  });
}

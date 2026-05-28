/**
 * ComputeToolEffectiveness — Restate activity service for quantitative tool analysis.
 *
 * Category 1: Quantitative (ClickHouse queries, no AI cost).
 * Queries ClickHouse traces for tool call spans in a session, computes:
 * - Selection accuracy (successful / total)
 * - Retry rate (retried / total)
 * - Call efficiency (avg duration)
 * - Per-tool breakdowns
 *
 * Config params:
 *   tools?:     Array of tool names to filter (all tools if omitted)
 *   minCalls?:  Minimum calls to include a tool in results (default: 1)
 *
 * Spec reference: T2 S7.3 (selection accuracy, parameter accuracy, retry rate, call efficiency)
 */
import * as restate from '@restatedev/restate-sdk';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import type { PipelineStepContext, StepOutput } from '../types.js';
import type { InsightResult, InsightRecord, InsightStatus } from '../insight-types.js';

const DEFAULT_MIN_CALLS = 1;

function statusFromScore(score: number): InsightStatus {
  if (score >= 0.8) return 'pass';
  if (score >= 0.5) return 'warn';
  return 'fail';
}

export const computeToolEffectivenessService = restate.service({
  name: 'ComputeToolEffectiveness',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();
      const params = (input.config.params ?? {}) as Record<string, unknown>;
      const tools = params.tools as string[] | undefined;
      const minCalls = (params.minCalls as number) ?? DEFAULT_MIN_CALLS;

      if (!input.sessionId) {
        return {
          status: 'fail',
          data: { error: 'ComputeToolEffectiveness requires sessionId in pipeline context' },
          durationMs: Date.now() - startTime,
        };
      }

      try {
        const insight = await ctx.run('compute-tool-effectiveness', async () => {
          const client = getClickHouseClient();

          // Build query for tool call aggregates from traces
          let toolFilter = '';
          const queryParams: Record<string, string | string[]> = {
            tenantId: input.tenantId,
            sessionId: input.sessionId!,
          };

          if (tools && tools.length > 0) {
            toolFilter = `AND JSONExtractString(data, 'toolName') IN ({tools:Array(String)})`;
            queryParams.tools = tools;
          }

          const result = await client.query({
            query: `
              SELECT
                JSONExtractString(data, 'toolName') AS tool_name,
                count() AS total_calls,
                countIf(JSONExtractBool(data, 'success') = true) AS successful_calls,
                countIf(JSONExtractUInt(data, 'retryAttempt') > 0) AS retried_calls,
                avg(duration_ms) AS avg_duration_ms
              FROM abl_platform.platform_events
              WHERE tenant_id = {tenantId:String}
                AND session_id = {sessionId:String}
                AND event_type IN ('tool.call.completed', 'tool.call.failed')
                ${toolFilter}
              GROUP BY tool_name
              HAVING total_calls >= ${minCalls}
              ORDER BY total_calls DESC
              SETTINGS max_execution_time = 30
            `,
            query_params: queryParams,
          });

          const rows = (
            (await result.json()) as {
              data: Array<{
                tool_name: string;
                total_calls: number;
                successful_calls: number;
                retried_calls: number;
                avg_duration_ms: number;
              }>;
            }
          ).data;

          if (rows.length === 0) {
            return {
              insightType: 'tool-effectiveness',
              granularity: 'session' as const,
              score: 1.0,
              status: 'pass' as const,
              dimensions: {
                selectionAccuracy: 1.0,
                retryRate: 0,
                avgDurationMs: 0,
                totalToolCalls: 0,
                toolCount: 0,
              },
              records: [],
            } satisfies InsightResult;
          }

          // Aggregate across all tools
          let totalCalls = 0;
          let totalSuccessful = 0;
          let totalRetried = 0;
          let weightedDuration = 0;
          const records: InsightRecord[] = [];

          for (const row of rows) {
            const calls = Number(row.total_calls);
            const successful = Number(row.successful_calls);
            const retried = Number(row.retried_calls);
            const avgDuration = Number(row.avg_duration_ms);

            totalCalls += calls;
            totalSuccessful += successful;
            totalRetried += retried;
            weightedDuration += avgDuration * calls;

            const toolAccuracy = calls > 0 ? successful / calls : 1.0;
            const toolRetryRate = calls > 0 ? retried / calls : 0;
            const toolScore = toolAccuracy * (1 - toolRetryRate * 0.5);

            records.push({
              agentName: row.tool_name,
              score: Math.round(toolScore * 1000) / 1000,
              status: statusFromScore(toolScore),
              dimensions: {
                toolName: row.tool_name,
                totalCalls: calls,
                successfulCalls: successful,
                retriedCalls: retried,
                accuracy: Math.round(toolAccuracy * 1000) / 1000,
                retryRate: Math.round(toolRetryRate * 1000) / 1000,
                avgDurationMs: Math.round(avgDuration),
              },
            });
          }

          const selectionAccuracy = totalCalls > 0 ? totalSuccessful / totalCalls : 1.0;
          const retryRate = totalCalls > 0 ? totalRetried / totalCalls : 0;
          const avgDurationMs = totalCalls > 0 ? weightedDuration / totalCalls : 0;

          // Overall score: accuracy weighted by retry penalty
          const overallScore = selectionAccuracy * (1 - retryRate * 0.5);

          return {
            insightType: 'tool-effectiveness',
            granularity: 'session' as const,
            score: Math.round(overallScore * 1000) / 1000,
            status: statusFromScore(overallScore),
            dimensions: {
              selectionAccuracy: Math.round(selectionAccuracy * 1000) / 1000,
              retryRate: Math.round(retryRate * 1000) / 1000,
              avgDurationMs: Math.round(avgDurationMs),
              totalToolCalls: totalCalls,
              toolCount: rows.length,
            },
            records,
          } satisfies InsightResult;
        });

        return {
          status: 'success',
          data: insight,
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        return {
          status: 'fail',
          data: { error: error instanceof Error ? error.message : String(error) },
          durationMs: Date.now() - startTime,
        };
      }
    },
  },
});

/** Export the type for use by other Restate services calling this one. */
export type ComputeToolEffectivenessService = typeof computeToolEffectivenessService;

/**
 * StoreInsight -- Restate activity service for persisting InsightResult to ClickHouse.
 *
 * Reads a compute handler's InsightResult from previousSteps, maps fields to
 * the insight_results table columns, and writes via direct ClickHouse insert.
 *
 * Config:
 *   sourceStep?:     Step ID to read InsightResult from (auto-detected if omitted)
 *   retentionDays?:  TTL in days (default: 90)
 */
import * as restate from '@restatedev/restate-sdk';
import { createLogger } from '@abl/compiler/platform';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import type { PipelineStepContext, StepOutput } from '../types.js';
import type { InsightResult, InsightRecord } from '../insight-types.js';

const log = createLogger('store-insight');

const TABLE = 'abl_platform.insight_results';
const DEFAULT_RETENTION_DAYS = 90;

/** ClickHouse DateTime64(3) requires 'YYYY-MM-DD HH:MM:SS.mmm' — no T or Z. */
function toCHDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

/** Parse an ISO string or return the date as ClickHouse-compatible format. */
function toCHDateTimeStr(isoOrDate: string | Date): string {
  const d = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  return toCHDateTime(d);
}

interface InsightRow {
  tenant_id: string;
  project_id: string;
  insight_type: string;
  granularity: string;
  session_id: string | null;
  message_id: string | null;
  span_id: string | null;
  agent_name: string | null;
  score: number;
  status: string;
  dimensions: string;
  pipeline_id: string;
  run_id: string;
  evaluated_at: string;
  event_timestamp: string;
  expires_at: string;
}

function isInsightResult(data: unknown): data is InsightResult {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.insightType === 'string' &&
    typeof d.granularity === 'string' &&
    typeof d.score === 'number'
  );
}

function findInsightSource(
  previousSteps: Record<string, { status: string; data: Record<string, any> }>,
  sourceStep?: string,
): { stepId: string; result: InsightResult } | null {
  if (sourceStep) {
    const step = previousSteps[sourceStep];
    if (!step) return null;
    if (isInsightResult(step.data)) return { stepId: sourceStep, result: step.data };
    return null;
  }

  // Auto-detect: find the last step whose output is an InsightResult
  const entries = Object.entries(previousSteps);
  for (let i = entries.length - 1; i >= 0; i--) {
    const [id, step] = entries[i];
    if (step.status === 'success' && isInsightResult(step.data)) {
      return { stepId: id, result: step.data };
    }
  }
  return null;
}

function buildRow(
  input: PipelineStepContext,
  insight: InsightResult,
  record: InsightRecord | null,
  retentionDays: number,
): InsightRow {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000);

  return {
    tenant_id: input.tenantId,
    project_id: input.projectId ?? '',
    insight_type: insight.insightType,
    granularity: insight.granularity,
    session_id: record?.sessionId ?? input.sessionId ?? null,
    message_id: record?.messageId ?? null,
    span_id: record?.spanId ?? null,
    agent_name: record?.agentName ?? null,
    score: record?.score ?? insight.score,
    status: record?.status ?? insight.status,
    dimensions: JSON.stringify(record?.dimensions ?? insight.dimensions),
    pipeline_id: (input.pipelineInput.pipelineId as string) ?? '',
    run_id: (input.pipelineInput.runId as string) ?? '',
    evaluated_at: toCHDateTime(now),
    event_timestamp: toCHDateTimeStr(
      record?.eventTimestamp ?? (input.pipelineInput.eventTimestamp as string) ?? now.toISOString(),
    ),
    expires_at: toCHDateTime(expiresAt),
  };
}

export const storeInsightService = restate.service({
  name: 'StoreInsight',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();
      const sourceStep = input.config.sourceStep as string | undefined;
      const retentionDays = (input.config.retentionDays as number) ?? DEFAULT_RETENTION_DAYS;
      const sessionId = input.sessionId;
      const runId = input.pipelineInput?.runId as string | undefined;

      log.debug('Store insight executing', {
        sessionId,
        runId,
        pipelineId: input.pipelineId,
        sourceStep: sourceStep ?? 'auto-detect',
      });

      try {
        // Find the InsightResult in previousSteps
        const source = findInsightSource(input.previousSteps, sourceStep);

        if (sourceStep && !input.previousSteps[sourceStep]) {
          return {
            status: 'fail',
            data: {
              error: `Source step '${sourceStep}' not found in previousSteps`,
            },
            durationMs: Date.now() - startTime,
          };
        }

        if (sourceStep && input.previousSteps[sourceStep]?.status === 'fail') {
          return {
            status: 'skipped',
            data: {
              reason: `Source step '${sourceStep}' failed -- skipping storage`,
            },
            durationMs: Date.now() - startTime,
          };
        }

        if (!source) {
          if (sourceStep && input.previousSteps[sourceStep]) {
            return {
              status: 'fail',
              data: {
                error: `Step '${sourceStep}' output missing required 'insightType' field`,
              },
              durationMs: Date.now() - startTime,
            };
          }
          return {
            status: 'fail',
            data: {
              error:
                'No InsightResult found in previousSteps (provide sourceStep config or ensure a compute handler ran)',
            },
            durationMs: Date.now() - startTime,
          };
        }

        const { result: insight } = source;

        // Build rows
        const rows: InsightRow[] = [];
        if (insight.records && insight.records.length > 0) {
          for (const record of insight.records) {
            rows.push(buildRow(input, insight, record, retentionDays));
          }
        } else {
          rows.push(buildRow(input, insight, null, retentionDays));
        }

        // Write to ClickHouse
        const recordsWritten = await ctx.run('store-insight-ch', async () => {
          const client = getClickHouseClient();
          await client.insert({
            table: TABLE,
            values: rows,
            format: 'JSONEachRow',
          });
          return rows.length;
        });

        log.debug('Store insight succeeded', {
          sessionId,
          runId,
          pipelineId: input.pipelineId,
          insightType: insight.insightType,
          granularity: insight.granularity,
          recordsWritten,
          durationMs: Date.now() - startTime,
        });

        return {
          status: 'success',
          data: {
            recordsWritten,
            insightType: insight.insightType,
            granularity: insight.granularity,
          },
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error('Store insight failed', {
          sessionId,
          runId,
          pipelineId: input.pipelineId,
          error: msg,
        });
        return {
          status: 'fail',
          data: {
            error: msg,
          },
          durationMs: Date.now() - startTime,
        };
      }
    },
  },
});

/** Export the type for use by other Restate services calling this one. */
export type StoreInsightService = typeof storeInsightService;

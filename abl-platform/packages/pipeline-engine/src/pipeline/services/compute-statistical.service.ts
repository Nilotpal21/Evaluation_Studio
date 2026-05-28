/**
 * Shared Statistical Analysis Engine
 *
 * Single service handling friction detection, anomaly detection, and drift detection.
 * Exports pure statistical utility functions for reuse.
 */
import * as restate from '@restatedev/restate-sdk';
import type { PipelineStepContext, StepOutput } from '../types.js';
import { resolveContextInput } from '../execution-context.js';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('compute-statistical');

// ---------------------------------------------------------------------------
// Pure Statistical Functions (exported for testing and reuse)
// ---------------------------------------------------------------------------

export function computeZScore(value: number, mean: number, stddev: number): number {
  if (stddev === 0) return 0;
  return (value - mean) / stddev;
}

export function computeSPC(values: number[]): {
  mean: number;
  ucl: number;
  lcl: number;
  outOfControl: number[];
} {
  const n = values.length;
  if (n === 0) return { mean: 0, ucl: 0, lcl: 0, outOfControl: [] };

  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  const ucl = mean + 3 * stddev;
  const lcl = mean - 3 * stddev;

  const outOfControl: number[] = [];
  for (let i = 0; i < n; i++) {
    if (values[i] > ucl || values[i] < lcl) {
      outOfControl.push(i);
    }
  }

  return { mean, ucl, lcl, outOfControl };
}

export function computeIQR(values: number[]): {
  q1: number;
  q3: number;
  iqr: number;
  lowerFence: number;
  upperFence: number;
  outliers: number[];
} {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return { q1: 0, q3: 0, iqr: 0, lowerFence: 0, upperFence: 0, outliers: [] };

  const q1 = sorted[Math.floor(n * 0.25)];
  const q3 = sorted[Math.floor(n * 0.75)];
  const iqr = q3 - q1;
  const lowerFence = q1 - 1.5 * iqr;
  const upperFence = q3 + 1.5 * iqr;

  const outliers = values.filter((v) => v < lowerFence || v > upperFence);

  return { q1, q3, iqr, lowerFence, upperFence, outliers };
}

export function computeLinearRegressionSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }

  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) return 0;

  return (n * sumXY - sumX * sumY) / denominator;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Jaccard similarity between two strings (word-level) */
function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

const REPHRASE_SIMILARITY_THRESHOLD = 0.5;
const ANOMALY_ZSCORE_THRESHOLD = 2.5;

/** Convert a Date (or ISO string) to ClickHouse DateTime64(3) format. */
function toCHDateTime(d: Date | string): string {
  const iso = typeof d === 'string' ? new Date(d).toISOString() : d.toISOString();
  return iso.replace('T', ' ').replace('Z', '');
}

/**
 * User-facing error returned when a ClickHouse query fails. The raw error
 * (which echoes the full SQL) is kept in server logs only — surfacing it in
 * the run viewer is noisy and leaks schema detail.
 */
const CLICKHOUSE_FETCH_FAILED_MESSAGE = 'Unable to fetch data from ClickHouse';

// ---------------------------------------------------------------------------
// Analysis Profiles
// ---------------------------------------------------------------------------

interface AnalysisProfile {
  name: string;
  clickhouseTable: string;
  execute: (ctx: restate.Context, input: PipelineStepContext) => Promise<StepOutput>;
}

function createFrictionProfile(): AnalysisProfile {
  return {
    name: 'Friction Detection',
    clickhouseTable: 'abl_platform.friction_detections',
    execute: async (_ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();
      const conversationData = resolveContextInput(input, 'conversation');
      if (!conversationData) {
        return {
          status: 'fail',
          data: {
            error:
              'Friction detection requires conversation data (from read-conversation or execution context)',
          },
          durationMs: Date.now() - startTime,
        };
      }

      // Support both read-conversation and read-message-window output shapes
      let messages: Array<{ role: string; content: string; timestamp: string }>;
      let metadata: Record<string, unknown>;

      if (conversationData.triggeringMessage && input.config.mode) {
        // read-message-window output: convert to messages array
        const trigger = conversationData.triggeringMessage as {
          role: string;
          content: string;
          messageIndex: number;
          messageId: string;
        };
        const window =
          (conversationData.windowMessages as Array<{
            role: string;
            content: string;
            timestamp: string;
          }>) ?? [];
        const wmeta = (conversationData.metadata as Record<string, unknown>) ?? {};
        messages = [
          ...window,
          { role: trigger.role, content: trigger.content, timestamp: new Date().toISOString() },
        ];
        metadata = wmeta;
      } else {
        messages =
          (conversationData.messages as Array<{
            role: string;
            content: string;
            timestamp: string;
          }>) ?? [];
        metadata = (conversationData.metadata as Record<string, unknown>) ?? {};
      }

      if (messages.length === 0) {
        return {
          status: 'skipped',
          data: { reason: 'No messages found in conversation data' },
          durationMs: Date.now() - startTime,
        };
      }
      const sessionId = input.sessionId ?? (input.pipelineInput.sessionId as string);
      const userMessages = messages.filter((m) => m.role === 'user');

      if (userMessages.length === 0) {
        return {
          status: 'skipped',
          data: { reason: 'No user messages found' },
          durationMs: Date.now() - startTime,
        };
      }

      // Compute rephrase count (consecutive user messages with high Jaccard similarity)
      let rephraseCount = 0;
      for (let i = 1; i < userMessages.length; i++) {
        const sim = jaccardSimilarity(userMessages[i - 1].content, userMessages[i].content);
        if (sim > REPHRASE_SIMILARITY_THRESHOLD) {
          rephraseCount++;
        }
      }

      // Message length trend (linear regression of user message lengths)
      const lengths = userMessages.map((m) => m.content.length);
      const lengthTrend = computeLinearRegressionSlope(lengths);

      // Caps count (messages that are >50% uppercase)
      const capsCount = userMessages.filter((m) => {
        const letters = m.content.replace(/[^a-zA-Z]/g, '');
        if (letters.length === 0) return false;
        const upperCount = letters.replace(/[^A-Z]/g, '').length;
        return upperCount / letters.length > 0.5;
      }).length;

      // Exclamation count
      const exclamationCount = userMessages.filter(
        (m) => m.content.includes('!') || m.content.includes('?!'),
      ).length;

      // Composite friction score (0-1)
      const rephraseNorm = Math.min(rephraseCount / Math.max(userMessages.length - 1, 1), 1);
      const capsNorm = Math.min(capsCount / userMessages.length, 1);
      const exclNorm = Math.min(exclamationCount / userMessages.length, 1);
      const lengthTrendNorm = Math.min(Math.max(lengthTrend / 50, 0), 1); // normalize: 50 chars/msg increase = max

      const frictionScore =
        Math.round(
          (0.4 * rephraseNorm + 0.2 * capsNorm + 0.2 * exclNorm + 0.2 * lengthTrendNorm) * 1000,
        ) / 1000;

      const row = {
        tenant_id: input.tenantId,
        project_id: input.projectId ?? '',
        session_id: sessionId,
        session_started_at: toCHDateTime(messages[0]?.timestamp ?? new Date()),
        agent_name: (metadata.agentName as string) ?? '',
        channel: (metadata.channel as string) ?? '',
        processed_at: toCHDateTime(new Date()),
        friction_score: Math.min(Math.max(frictionScore, 0), 1),
        rephrase_count: rephraseCount,
        message_length_trend: Math.round(lengthTrend * 1000) / 1000,
        turn_count_zscore: 0, // placeholder for cross-session comparison
        caps_count: capsCount,
        exclamation_count: exclamationCount,
        flagged: frictionScore > 0.5 ? 1 : 0,
        processing_ms: Date.now() - startTime,
        run_id: (input.pipelineInput?.runId as string) ?? '',
        pipeline_id: input.pipelineId ?? '',
        pipeline_type: input.pipelineType ?? '',
      };

      // Write to ClickHouse (skipped when store-results handles persistence)
      if (!input.config.skipDirectWrite) {
        await _ctx.run('store-friction-results', async () => {
          const client = getClickHouseClient();
          await client.insert({
            table: 'abl_platform.friction_detections',
            values: [row],
            format: 'JSONEachRow',
          });
        });
      }

      return {
        status: 'success',
        data: {
          friction_score: row.friction_score,
          rephrase_count: rephraseCount,
          caps_count: capsCount,
          exclamation_count: exclamationCount,
          message_length_trend: row.message_length_trend,
          flagged: row.flagged === 1,
        },
        durationMs: Date.now() - startTime,
      };
    },
  };
}

function createAnomalyProfile(): AnalysisProfile {
  return {
    name: 'Anomaly Detection',
    clickhouseTable: 'abl_platform.anomaly_detections',
    execute: async (_ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();
      const metricTable =
        (input.config.metricTable as string) || 'abl_platform.conversation_sentiment';
      const metricColumn = (input.config.metricColumn as string) || 'avg_sentiment';
      const lookbackDays = (input.config.lookbackDays as number) ?? 30;
      const sessionId = input.sessionId ?? (input.pipelineInput.sessionId as string);

      // Query hourly aggregates from the raw table. Aggregating by hour means each
      // hourly run gets a fresh completed bucket — 30 days × 24 hours = 720 data points.
      const timeSeries = await _ctx.run('query-metric-data', async () => {
        const client = getClickHouseClient();
        try {
          const result = await client.query({
            query: `SELECT toStartOfHour(session_started_at) AS period, avg(${metricColumn}) AS value FROM ${metricTable} WHERE tenant_id = '${input.tenantId}' AND project_id = '${input.projectId ?? ''}' AND session_started_at >= now() - toIntervalDay(${lookbackDays}) GROUP BY toStartOfHour(session_started_at) ORDER BY toStartOfHour(session_started_at) ASC`,
            clickhouse_settings: { async_insert: 0 },
            format: 'JSON',
          });
          return ((await result.json()) as { data: Array<{ period: string; value: number }> }).data;
        } catch (err) {
          log.error('Anomaly detection ClickHouse query failed', {
            tenantId: input.tenantId,
            projectId: input.projectId,
            metricTable,
            metricColumn,
            error: err instanceof Error ? err.message : String(err),
          });
          throw new restate.TerminalError(`Anomaly detection: ${CLICKHOUSE_FETCH_FAILED_MESSAGE}`);
        }
      });

      if (!timeSeries || timeSeries.length < 3) {
        return {
          status: 'skipped',
          data: { reason: 'Insufficient data points for anomaly detection' },
          durationMs: Date.now() - startTime,
        };
      }

      const values = timeSeries.map((r) => Number(r.value));
      const lastValue = values[values.length - 1];
      const precedingValues = values.slice(0, -1);

      const mean = precedingValues.reduce((a, b) => a + b, 0) / precedingValues.length;
      const variance =
        precedingValues.reduce((sum, v) => sum + (v - mean) ** 2, 0) / precedingValues.length;
      const stddev = Math.sqrt(variance);

      const zScore = computeZScore(lastValue, mean, stddev);
      const anomalyFlag = Math.abs(zScore) > ANOMALY_ZSCORE_THRESHOLD;

      const spcResult = computeSPC(values);
      const severity =
        Math.abs(zScore) > 4
          ? 'critical'
          : Math.abs(zScore) > 3
            ? 'high'
            : Math.abs(zScore) > 2.5
              ? 'medium'
              : 'low';

      // Try to resolve channel from conversation metadata if available
      const anomalyConvData = resolveContextInput(input, 'conversation');
      const anomalyChannel =
        (anomalyConvData?.metadata as Record<string, unknown> | undefined)?.channel ?? '';

      const row = {
        tenant_id: input.tenantId,
        project_id: input.projectId ?? '',
        session_id: sessionId,
        processed_at: toCHDateTime(new Date()),
        anomaly_flag: anomalyFlag ? 1 : 0,
        severity,
        z_score: Math.round(zScore * 1000) / 1000,
        metric_name: metricColumn,
        metric_value: lastValue,
        expected_range_low: Math.round((mean - 2.5 * stddev) * 1000) / 1000,
        expected_range_high: Math.round((mean + 2.5 * stddev) * 1000) / 1000,
        contributing_factors: anomalyFlag
          ? [`${metricColumn} z-score: ${Math.round(zScore * 100) / 100}`]
          : [],
        spc_out_of_control: spcResult.outOfControl.length,
        channel: anomalyChannel as string,
        processing_ms: Date.now() - startTime,
        run_id: (input.pipelineInput?.runId as string) ?? '',
        pipeline_id: input.pipelineId ?? '',
        pipeline_type: input.pipelineType ?? '',
      };

      if (!input.config.skipDirectWrite) {
        await _ctx.run('store-anomaly-results', async () => {
          const client = getClickHouseClient();
          await client.insert({
            table: 'abl_platform.anomaly_detections',
            values: [row],
            format: 'JSONEachRow',
          });
        });
      }

      return {
        status: 'success',
        data: {
          anomaly_flag: anomalyFlag,
          severity,
          z_score: row.z_score,
          metric_value: lastValue,
          expected_range: [row.expected_range_low, row.expected_range_high],
        },
        durationMs: Date.now() - startTime,
      };
    },
  };
}

function createDriftProfile(): AnalysisProfile {
  return {
    name: 'Drift Detection',
    clickhouseTable: 'abl_platform.drift_detections',
    execute: async (_ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();
      const metricTable =
        (input.config.metricTable as string) || 'abl_platform.quality_evaluations';
      const metricColumn = (input.config.metricColumn as string) || 'overall_score';
      const lookbackDays = (input.config.lookbackDays as number) ?? 60;
      const sessionId = input.sessionId ?? (input.pipelineInput.sessionId as string);

      // Query daily aggregates from the raw table. Split at midpoint: first half = baseline,
      // second half = current window. 60-day default gives 30 days per window.
      const timeSeries = await _ctx.run('query-drift-data', async () => {
        const client = getClickHouseClient();
        try {
          const result = await client.query({
            query: `SELECT toDate(session_started_at) AS day, avg(${metricColumn}) AS value FROM ${metricTable} WHERE tenant_id = '${input.tenantId}' AND project_id = '${input.projectId ?? ''}' AND session_started_at >= now() - toIntervalDay(${lookbackDays}) GROUP BY toDate(session_started_at) ORDER BY toDate(session_started_at) ASC`,
            clickhouse_settings: { async_insert: 0 },
            format: 'JSON',
          });
          return ((await result.json()) as { data: Array<{ day: string; value: number }> }).data;
        } catch (err) {
          log.error('Drift detection ClickHouse query failed', {
            tenantId: input.tenantId,
            projectId: input.projectId,
            metricTable,
            metricColumn,
            error: err instanceof Error ? err.message : String(err),
          });
          throw new restate.TerminalError(`Drift detection: ${CLICKHOUSE_FETCH_FAILED_MESSAGE}`);
        }
      });

      if (!timeSeries || timeSeries.length < 6) {
        return {
          status: 'skipped',
          data: { reason: 'Insufficient data points for drift detection' },
          durationMs: Date.now() - startTime,
        };
      }

      const values = timeSeries.map((r) => Number(r.value));
      const midpoint = Math.floor(values.length / 2);
      const baselineValues = values.slice(0, midpoint);
      const currentValues = values.slice(midpoint);

      const baselineMean = baselineValues.reduce((a, b) => a + b, 0) / baselineValues.length;
      const currentMean = currentValues.reduce((a, b) => a + b, 0) / currentValues.length;

      const driftScore =
        baselineMean !== 0 ? Math.abs(currentMean - baselineMean) / Math.abs(baselineMean) : 0;
      const driftType =
        currentMean > baselineMean ? 'upward' : currentMean < baselineMean ? 'downward' : 'stable';
      const flagged = driftScore > 0.15; // 15% change threshold

      const slope = computeLinearRegressionSlope(values);

      // Try to resolve channel from conversation metadata if available
      const driftConvData = resolveContextInput(input, 'conversation');
      const driftChannel =
        (driftConvData?.metadata as Record<string, unknown> | undefined)?.channel ?? '';

      const row = {
        tenant_id: input.tenantId,
        project_id: input.projectId ?? '',
        session_id: sessionId,
        processed_at: toCHDateTime(new Date()),
        drift_score: Math.round(driftScore * 1000) / 1000,
        drift_type: driftType,
        baseline_mean: Math.round(baselineMean * 1000) / 1000,
        current_mean: Math.round(currentMean * 1000) / 1000,
        trend_slope: Math.round(slope * 1000) / 1000,
        channel: driftChannel as string,
        flagged: flagged ? 1 : 0,
        processing_ms: Date.now() - startTime,
        run_id: (input.pipelineInput?.runId as string) ?? '',
        pipeline_id: input.pipelineId ?? '',
        pipeline_type: input.pipelineType ?? '',
      };

      if (!input.config.skipDirectWrite) {
        await _ctx.run('store-drift-results', async () => {
          const client = getClickHouseClient();
          await client.insert({
            table: 'abl_platform.drift_detections',
            values: [row],
            format: 'JSONEachRow',
          });
        });
      }

      return {
        status: 'success',
        data: {
          drift_score: row.drift_score,
          drift_type: driftType,
          baseline_mean: row.baseline_mean,
          current_mean: row.current_mean,
          flagged,
        },
        durationMs: Date.now() - startTime,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Profile Registry
// ---------------------------------------------------------------------------

const ANALYSIS_PROFILES: Record<string, AnalysisProfile> = {
  friction_detection: createFrictionProfile(),
  anomaly_detection: createAnomalyProfile(),
  drift_detection: createDriftProfile(),
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const computeStatisticalService = restate.service({
  name: 'ComputeStatistical',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();
      const analysisType = input.config.analysisType as string;
      const profile = ANALYSIS_PROFILES[analysisType];

      if (!profile) {
        return {
          status: 'fail',
          data: {
            error: `Unknown analysis type: '${analysisType}'. Available: ${Object.keys(ANALYSIS_PROFILES).join(', ')}`,
          },
          durationMs: Date.now() - startTime,
        };
      }

      log.debug(`Running ${profile.name}`, {
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        analysisType,
      });

      try {
        return await profile.execute(ctx, input);
      } catch (err) {
        // TerminalError = deterministic failure (e.g. ClickHouse syntax error, missing table).
        // Return as a failed step so PipelineRun can finalise the run record correctly
        // rather than suspending indefinitely on retries.
        if (err instanceof restate.TerminalError) {
          return {
            status: 'fail',
            data: { error: err.message },
            durationMs: Date.now() - startTime,
          };
        }
        throw err;
      }
    },
  },
});

export type ComputeStatisticalService = typeof computeStatisticalService;

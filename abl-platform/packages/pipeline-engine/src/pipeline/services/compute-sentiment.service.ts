/**
 * ComputeSentiment — Restate activity service for LLM-based sentiment analysis.
 *
 * Category 2: LLM-powered per-message sentiment scoring with conversation
 * trajectory analysis. Reads conversation data from a prior read-conversation
 * step, calls an LLM for per-message scoring, then computes conversation-level
 * aggregates (trajectory, frustration detection, sentiment shifts).
 *
 * Writes results to:
 *   - abl_platform.message_sentiment   (per-message rows)
 *   - abl_platform.conversation_sentiment (one row per session)
 *
 * Reads from: execution context 'conversation' key or previousSteps fallback
 *
 * Spec reference: T2 S7.1 (per-message sentiment, trajectory, frustration)
 */
import * as restate from '@restatedev/restate-sdk';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import { createLogger, parseJSON } from '@abl/compiler/platform';
import { resolvePipelineLLM } from './llm-client-factory.js';
import { pipelineGenerateText } from './pipeline-llm-call.js';
import type { PipelineStepContext, StepOutput } from '../types.js';
import { resolveContextInput } from '../execution-context.js';
import { SENTIMENT_SYSTEM_PROMPT, buildSentimentUserPrompt } from '../prompts/index.js';

const log = createLogger('compute-sentiment');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MESSAGE_SENTIMENT_TABLE = 'abl_platform.message_sentiment';
const CONVERSATION_SENTIMENT_TABLE = 'abl_platform.conversation_sentiment';

/** Default sentiment shift threshold — overridable via pipeline config. */
const DEFAULT_SHIFT_THRESHOLD = 0.3;

/** Default frustration score threshold — overridable via pipeline config. */
const DEFAULT_FRUSTRATION_THRESHOLD = -0.3;

/** Default confidence score — overridable via pipeline config. */
const DEFAULT_CONFIDENCE_SCORE = 0.85;

/** Default config version — overridden by resolved pipeline config version. */
const DEFAULT_CONFIG_VERSION = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SentimentScore {
  index: number;
  sentiment_score: number;
  sentiment_label: string;
  frustration_detected: boolean;
  frustration_signals: string[];
}

interface MessageSentimentRow {
  tenant_id: string;
  project_id: string;
  session_id: string;
  message_id: string;
  message_at: string;
  processed_at: string;
  role: string;
  agent_name: string;
  channel: string;
  sentiment_score: number;
  sentiment_label: string;
  frustration_detected: number;
  frustration_signals: string[];
  model_id: string;
  config_version: number;
  confidence: number;
  processing_ms: number;
  run_id: string;
  pipeline_id: string;
  pipeline_type: string;
}

interface ConversationSentimentRow {
  tenant_id: string;
  project_id: string;
  session_id: string;
  session_started_at: string;
  processed_at: string;
  agent_name: string;
  channel: string;
  avg_sentiment: number;
  start_sentiment: number;
  end_sentiment: number;
  min_sentiment: number;
  max_sentiment: number;
  sentiment_trajectory: string;
  sentiment_shift_count: number;
  frustration_turn_count: number;
  frustration_detected: number;
  pivot_count: number;
  worst_pivot_at: string | null;
  worst_pivot_delta: number | null;
  model_id: string;
  config_version: number;
  message_count: number;
  processing_ms: number;
  run_id: string;
  pipeline_id: string;
  pipeline_type: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** ClickHouse DateTime64(3) format — no T or Z. */
function toCHDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Determine sentiment trajectory from start/end scores.
 *   - 'improving' if end > start by >= 0.2
 *   - 'declining' if end < start by >= 0.2
 *   - 'stable' otherwise
 */
function computeTrajectory(startScore: number, endScore: number): string {
  const delta = endScore - startScore;
  if (delta >= 0.2) return 'improving';
  if (delta <= -0.2) return 'declining';
  return 'stable';
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const computeSentimentService = restate.service({
  name: 'ComputeSentiment',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();

      // Read conversation data from a prior step or execution context
      const conversationData = resolveContextInput(input, 'conversation');
      if (!conversationData) {
        return {
          status: 'fail',
          data: {
            error:
              'ComputeSentiment requires conversation data (from read-conversation or execution context)',
          },
          durationMs: Date.now() - startTime,
        };
      }

      // Support both read-conversation and read-message-window output shapes
      let messages:
        | Array<{
            messageId: string;
            role: string;
            content: string;
            timestamp: string;
            channel?: string;
          }>
        | undefined;
      let metadata:
        | { agentName?: string; channel?: string; messageCount: number; durationMs?: number }
        | undefined;

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
            messageId: string;
            role: string;
            content: string;
            timestamp: string;
            channel?: string;
          }>) ?? [];
        const wmeta =
          (conversationData.metadata as {
            sessionId?: string;
            agentName?: string;
            channel?: string;
            windowSize?: number;
            totalSessionMessages?: number;
          }) ?? {};
        // Combine window + triggering message (window is in chronological order)
        messages = [
          ...window,
          {
            messageId: trigger.messageId,
            role: trigger.role,
            content: trigger.content,
            timestamp: new Date().toISOString(),
            channel: wmeta.channel,
          },
        ];
        metadata = {
          agentName: wmeta.agentName,
          channel: wmeta.channel,
          messageCount: wmeta.totalSessionMessages ?? messages.length,
        };
      } else {
        messages = conversationData.messages as typeof messages;
        metadata = conversationData.metadata as typeof metadata;
      }

      if (!messages || messages.length === 0) {
        return {
          status: 'skipped',
          data: { reason: 'No messages found in conversation data' },
          durationMs: Date.now() - startTime,
        };
      }

      // Filter to scorable messages (user + assistant only)
      const scorableMessages = messages.filter((m) => m.role === 'user' || m.role === 'assistant');

      // Check for user messages — skip if none
      const hasUserMessages = scorableMessages.some((m) => m.role === 'user');
      if (!hasUserMessages) {
        return {
          status: 'skipped',
          data: { reason: 'No user messages found in conversation' },
          durationMs: Date.now() - startTime,
        };
      }

      const sessionId = input.sessionId ?? (input.pipelineInput.sessionId as string);

      // Read thresholds from pipeline config (merged by ActivityRouter), fall back to defaults
      const SHIFT_THRESHOLD =
        (input.config.shiftThreshold as number | undefined) ?? DEFAULT_SHIFT_THRESHOLD;
      const FRUSTRATION_THRESHOLD =
        (input.config.frustrationThreshold as number | undefined) ?? DEFAULT_FRUSTRATION_THRESHOLD;
      const DEFAULT_CONFIDENCE =
        (input.config.defaultConfidence as number | undefined) ?? DEFAULT_CONFIDENCE_SCORE;
      const CONFIG_VERSION =
        (input.config.configVersion as number | undefined) ?? DEFAULT_CONFIG_VERSION;

      try {
        log.debug('Computing sentiment', {
          tenantId: input.tenantId,
          sessionId,
          messageCount: scorableMessages.length,
        });

        // Build user prompt with messages
        const userPrompt = buildSentimentUserPrompt(scorableMessages);

        // Call LLM for sentiment scoring
        const llmResult = await ctx.run('compute-sentiment-llm', async () => {
          let resolved;
          try {
            resolved = await resolvePipelineLLM(
              input.tenantId,
              input.projectId,
              input.config.model as string | undefined,
            );
          } catch (err) {
            throw new restate.TerminalError(
              `LLM resolution failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          // Scale output tokens with message count — each score entry is ~100-150 tokens
          const estimatedTokens = Math.max(1024, scorableMessages.length * 150);
          return pipelineGenerateText(
            resolved,
            {
              system: SENTIMENT_SYSTEM_PROMPT,
              messages: [{ role: 'user' as const, content: userPrompt }],
              maxOutputTokens: estimatedTokens,
              temperature: 0,
            },
            {
              service: 'compute-sentiment',
              tenantId: input.tenantId,
              projectId: input.projectId,
              sessionId,
            },
          );
        });

        // Parse LLM response (parseJSON strips markdown code fences and extracts JSON)
        let scores: SentimentScore[];
        const parsed = parseJSON<{ scores?: SentimentScore[] }>(llmResult.content);
        if (!parsed) {
          return {
            status: 'fail',
            data: { error: 'Failed to parse sentiment LLM response as JSON' },
            durationMs: Date.now() - startTime,
          };
        }
        scores = parsed.scores ?? [];

        // Build per-message sentiment rows
        const now = new Date();
        const processedAt = toCHDateTime(now);
        const processingMs = Date.now() - startTime;

        const messageSentimentRows: MessageSentimentRow[] = [];
        let totalSentiment = 0;
        let minSentiment = 1.0;
        let maxSentiment = -1.0;
        let frustrationTurnCount = 0;
        let shiftCount = 0;
        let prevScore: number | null = null;
        let worstPivotDelta: number | null = null;
        let worstPivotAt: string | null = null;

        for (let i = 0; i < scorableMessages.length; i++) {
          const msg = scorableMessages[i];
          const scoreEntry = scores.find((s) => s.index === i);

          const sentimentScore = scoreEntry?.sentiment_score ?? 0;
          const sentimentLabel = scoreEntry?.sentiment_label ?? 'neutral';
          const frustrationDetected = scoreEntry?.frustration_detected ?? false;
          const frustrationSignals = scoreEntry?.frustration_signals ?? [];

          totalSentiment += sentimentScore;
          minSentiment = Math.min(minSentiment, sentimentScore);
          maxSentiment = Math.max(maxSentiment, sentimentScore);

          if (frustrationDetected || sentimentScore <= FRUSTRATION_THRESHOLD) {
            frustrationTurnCount++;
          }

          // Track sentiment shifts
          if (prevScore !== null) {
            const delta = sentimentScore - prevScore;
            if (Math.abs(delta) >= SHIFT_THRESHOLD) {
              shiftCount++;
              // Track worst pivot (largest negative shift)
              if (delta < 0 && (worstPivotDelta === null || delta < worstPivotDelta)) {
                worstPivotDelta = delta;
                worstPivotAt = msg.timestamp;
              }
            }
          }
          prevScore = sentimentScore;

          messageSentimentRows.push({
            tenant_id: input.tenantId,
            project_id: input.projectId ?? '',
            session_id: sessionId,
            message_id: msg.messageId,
            message_at: toCHDateTime(new Date(msg.timestamp)),
            processed_at: processedAt,
            role: msg.role,
            agent_name: metadata?.agentName ?? '',
            channel: msg.channel ?? metadata?.channel ?? '',
            sentiment_score: Math.round(sentimentScore * 1000) / 1000,
            sentiment_label: sentimentLabel,
            frustration_detected: frustrationDetected ? 1 : 0,
            frustration_signals: frustrationSignals,
            model_id: llmResult.model,
            config_version: CONFIG_VERSION,
            confidence: DEFAULT_CONFIDENCE,
            processing_ms: processingMs,
            run_id: (input.pipelineInput?.runId as string) ?? '',
            pipeline_id: input.pipelineId ?? '',
            pipeline_type: input.pipelineType ?? '',
          });
        }

        // Compute conversation-level aggregates
        const avgSentiment = totalSentiment / scorableMessages.length;
        const startSentiment = messageSentimentRows[0]?.sentiment_score ?? 0;
        const endSentiment =
          messageSentimentRows[messageSentimentRows.length - 1]?.sentiment_score ?? 0;
        const trajectory = computeTrajectory(startSentiment, endSentiment);
        const anyFrustration = frustrationTurnCount > 0;

        // Count negative-direction pivots
        const pivotCount = messageSentimentRows.reduce((count, _row, idx) => {
          if (idx === 0) return count;
          const delta =
            messageSentimentRows[idx].sentiment_score -
            messageSentimentRows[idx - 1].sentiment_score;
          return delta <= -SHIFT_THRESHOLD ? count + 1 : count;
        }, 0);

        const sessionStartedAt = messages[0]?.timestamp
          ? toCHDateTime(new Date(messages[0].timestamp))
          : processedAt;

        const conversationSentimentRow: ConversationSentimentRow = {
          tenant_id: input.tenantId,
          project_id: input.projectId ?? '',
          session_id: sessionId,
          session_started_at: sessionStartedAt,
          processed_at: processedAt,
          agent_name: metadata?.agentName ?? '',
          channel: metadata?.channel ?? '',
          avg_sentiment: Math.round(avgSentiment * 1000) / 1000,
          start_sentiment: Math.round(startSentiment * 1000) / 1000,
          end_sentiment: Math.round(endSentiment * 1000) / 1000,
          min_sentiment: Math.round(minSentiment * 1000) / 1000,
          max_sentiment: Math.round(maxSentiment * 1000) / 1000,
          sentiment_trajectory: trajectory,
          sentiment_shift_count: shiftCount,
          frustration_turn_count: frustrationTurnCount,
          frustration_detected: anyFrustration ? 1 : 0,
          pivot_count: pivotCount,
          worst_pivot_at: worstPivotAt ? toCHDateTime(new Date(worstPivotAt)) : null,
          worst_pivot_delta:
            worstPivotDelta !== null ? Math.round(worstPivotDelta * 1000) / 1000 : null,
          model_id: llmResult.model,
          config_version: CONFIG_VERSION,
          message_count: scorableMessages.length,
          processing_ms: processingMs,
          run_id: (input.pipelineInput?.runId as string) ?? '',
          pipeline_id: input.pipelineId ?? '',
          pipeline_type: input.pipelineType ?? '',
        };

        // Write to ClickHouse (skipped when store-results handles persistence)
        if (!input.config.skipDirectWrite) {
          log.debug('Writing sentiment results to ClickHouse', {
            tenantId: input.tenantId,
            sessionId,
            messageRows: messageSentimentRows.length,
            trajectory,
          });
          await ctx.run('store-sentiment-results', async () => {
            const client = getClickHouseClient();

            await Promise.all([
              messageSentimentRows.length > 0
                ? client.insert({
                    table: MESSAGE_SENTIMENT_TABLE,
                    values: messageSentimentRows,
                    format: 'JSONEachRow',
                  })
                : Promise.resolve(),
              client.insert({
                table: CONVERSATION_SENTIMENT_TABLE,
                values: [conversationSentimentRow],
                format: 'JSONEachRow',
              }),
            ]);
          });
          log.debug('Sentiment results written to ClickHouse', {
            tenantId: input.tenantId,
            sessionId,
          });
        }

        log.debug('Sentiment analysis complete', {
          tenantId: input.tenantId,
          sessionId,
          messageCount: scorableMessages.length,
          trajectory,
          avgSentiment: Math.round(avgSentiment * 1000) / 1000,
        });

        return {
          status: 'success',
          data: {
            conversationSentiment: conversationSentimentRow,
            messageSentiments: messageSentimentRows,
            inputTokens: llmResult.inputTokens,
            outputTokens: llmResult.outputTokens,
          },
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error('ComputeSentiment failed', {
          tenantId: input.tenantId,
          sessionId,
          error: msg,
        });
        return {
          status: 'fail',
          data: { error: msg },
          durationMs: Date.now() - startTime,
        };
      }
    },
  },
});

/** Export the type for use by other Restate services calling this one. */
export type ComputeSentimentService = typeof computeSentimentService;

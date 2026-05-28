/**
 * ComputeToxicity — Restate activity service for behavioral toxicity scoring.
 *
 * Category 3: Zero-cost detection (no AI/LLM calls).
 * Reads MongoDB messages for a session, scores each message using keyword/pattern
 * matching, and writes results to dedicated ClickHouse tables:
 *   - abl_platform.toxicity_evaluations   (one row per session)
 *   - abl_platform.message_toxicity       (per-message rows)
 *
 * Config params:
 *   threshold?:     Score above which a message is toxic (default: 0.7)
 *   includeAgent?:  Also score assistant messages (default: false)
 *
 * Spec reference: T3 S8.8 (toxicity score, PII detection, jailbreak attempts)
 */
import * as restate from '@restatedev/restate-sdk';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import { createLogger } from '@abl/compiler/platform';
import type { PipelineStepContext, StepOutput } from '../types.js';
import { resolveContextInput } from '../execution-context.js';

const log = createLogger('compute-toxicity');

const DEFAULT_THRESHOLD = 0.7;

// ---------------------------------------------------------------------------
// ClickHouse table constants
// ---------------------------------------------------------------------------

const TOXICITY_TABLE = 'abl_platform.toxicity_evaluations';
const MESSAGE_TOXICITY_TABLE = 'abl_platform.message_toxicity';

// ---------------------------------------------------------------------------
// ClickHouse row interfaces
// ---------------------------------------------------------------------------

interface ToxicityEvaluationRow {
  tenant_id: string;
  project_id: string;
  session_id: string;
  session_started_at: string;
  processed_at: string;
  agent_name: string;
  channel: string;
  avg_toxicity: number;
  max_toxicity: number;
  flagged: number; // 0 or 1
  status: string; // 'pass' | 'warn' | 'fail'
  threshold: number;
  message_count: number;
  model_id: string;
  config_version: number;
  run_id: string;
  pipeline_id: string;
  pipeline_type: string;
  source: string;
  processing_ms: number;
  input_tokens: number;
  output_tokens: number;
}

interface MessageToxicityRow {
  tenant_id: string;
  project_id: string;
  session_id: string;
  message_id: string;
  message_at: string;
  processed_at: string;
  role: string;
  agent_name: string;
  channel: string;
  toxicity_score: number;
  status: string; // 'pass' | 'warn' | 'fail'
  content_length: number;
  run_id: string;
  pipeline_id: string;
  pipeline_type: string;
}

// ---------------------------------------------------------------------------
// Toxicity keyword patterns (weighted)
// ---------------------------------------------------------------------------

interface ToxicPattern {
  pattern: RegExp;
  weight: number;
}

const TOXIC_PATTERNS: ToxicPattern[] = [
  // Profanity/insults — high weight
  { pattern: /\b(idiot|stupid|moron|dumb|fool|incompetent|useless|pathetic)\b/gi, weight: 0.3 },
  // Aggressive language
  { pattern: /\b(hate|terrible|worst|awful|disgusting|horrible|unacceptable)\b/gi, weight: 0.15 },
  // Threats
  { pattern: /\b(sue|lawyer|legal action|report you|fire you|kill)\b/gi, weight: 0.35 },
  // Explicit hostility
  { pattern: /\b(shut up|go away|leave me alone|damn|hell)\b/gi, weight: 0.1 },
  // ALL CAPS (shouting indicator) — if >50% of word chars are uppercase and message > 20 chars
  { pattern: /^[^a-z]*$/g, weight: 0.05 },
  // Excessive punctuation (frustration indicator)
  { pattern: /[!?]{3,}/g, weight: 0.05 },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Score a single message's toxicity (0.0 = safe, 1.0 = maximally toxic).
 * Uses keyword/pattern matching — no AI cost.
 */
function scoreToxicity(content: string): number {
  if (!content || content.trim().length === 0) return 0;

  let totalScore = 0;

  for (const { pattern, weight } of TOXIC_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    const matches = content.match(pattern);
    if (matches && matches.length > 0) {
      // More matches = higher score (diminishing returns via log)
      const matchFactor = Math.min(1, Math.log2(matches.length + 1) / 3);
      totalScore += weight * (0.5 + 0.5 * matchFactor);
    }
  }

  // Clamp to 0.0-1.0
  return Math.min(1.0, Math.max(0.0, totalScore));
}

type ToxicityStatus = 'pass' | 'warn' | 'fail';

function statusFromScore(score: number, threshold: number): ToxicityStatus {
  if (score >= threshold) return 'fail';
  if (score >= threshold * 0.7) return 'warn';
  return 'pass';
}

/** ClickHouse DateTime64(3) format — no T or Z. */
function toCHDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const computeToxicityService = restate.service({
  name: 'ComputeToxicity',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();
      const params = (input.config.params ?? {}) as Record<string, unknown>;
      const threshold = (params.threshold as number) ?? DEFAULT_THRESHOLD;
      const includeAgent = (params.includeAgent as boolean) ?? false;

      if (!input.sessionId) {
        return {
          status: 'fail',
          data: { error: 'ComputeToxicity requires sessionId in pipeline context' },
          durationMs: Date.now() - startTime,
        };
      }

      // Extract conversation data from previous read-conversation step
      const conversationData = resolveContextInput(input, 'conversation');
      const metadata = conversationData?.metadata as
        | { agentName?: string; channel?: string; sessionStartedAt?: string }
        | undefined;
      const agentName = metadata?.agentName ?? '';
      const channel = metadata?.channel ?? '';

      // Use already-decrypted messages from the read-conversation step
      const allMessages = (conversationData?.messages ?? []) as Array<{
        messageId: string;
        role: string;
        content: string;
        timestamp: string;
        channel?: string;
      }>;

      log.info('Input messages from read-conversation step', {
        sessionId: input.sessionId,
        totalMessages: allMessages.length,
        messages: allMessages.map((m) => ({
          messageId: m.messageId,
          role: m.role,
          content: m.content?.substring(0, 200) ?? '[empty]',
          contentLength: m.content?.length ?? 0,
        })),
      });

      try {
        const result = await ctx.run('compute-toxicity', async () => {
          // Filter by role (use already-decrypted messages from previous step)
          const messages = includeAgent
            ? allMessages
            : allMessages.filter((m) => m.role === 'user');

          const now = new Date();
          const processedAt = toCHDateTime(now);
          const processingMs = Date.now() - startTime;

          if (messages.length === 0) {
            // Write empty session row to ClickHouse
            const emptySessionRow: ToxicityEvaluationRow = {
              tenant_id: input.tenantId,
              project_id: input.projectId ?? '',
              session_id: input.sessionId!,
              session_started_at: processedAt,
              processed_at: processedAt,
              agent_name: agentName,
              channel,
              avg_toxicity: 0,
              max_toxicity: 0,
              flagged: 0,
              status: 'pass',
              threshold,
              message_count: 0,
              model_id: '',
              config_version: 1,
              run_id: (input.pipelineInput?.runId as string) ?? '',
              pipeline_id: input.pipelineId ?? '',
              pipeline_type: input.pipelineType ?? '',
              source: 'keyword',
              processing_ms: processingMs,
              input_tokens: 0,
              output_tokens: 0,
            };

            const client = getClickHouseClient();
            await client.insert({
              table: TOXICITY_TABLE,
              values: [emptySessionRow],
              format: 'JSONEachRow',
            });

            return {
              avgToxicity: 0,
              maxToxicity: 0,
              flagged: false,
              messageCount: 0,
              status: 'pass' as const,
              inputTokens: 0,
              outputTokens: 0,
            };
          }

          // Score each message
          const messageToxicityRows: MessageToxicityRow[] = [];
          let totalToxicity = 0;
          let maxToxicity = 0;

          for (const msg of messages) {
            const content = msg.content ?? '';
            const toxicityScore = scoreToxicity(content);
            const msgStatus = statusFromScore(toxicityScore, threshold);

            totalToxicity += toxicityScore;
            maxToxicity = Math.max(maxToxicity, toxicityScore);

            const messageAt = msg.timestamp ? toCHDateTime(new Date(msg.timestamp)) : processedAt;

            log.info('Scored message', {
              messageId: msg.messageId,
              role: msg.role,
              content: content.substring(0, 200),
              toxicityScore: Math.round(toxicityScore * 1000) / 1000,
              status: msgStatus,
            });

            messageToxicityRows.push({
              tenant_id: input.tenantId,
              project_id: input.projectId ?? '',
              session_id: input.sessionId!,
              message_id: String(msg.messageId),
              message_at: messageAt,
              processed_at: processedAt,
              role: msg.role,
              agent_name: agentName,
              channel,
              toxicity_score: Math.round(toxicityScore * 1000) / 1000,
              status: msgStatus,
              content_length: content.length,
              run_id: (input.pipelineInput?.runId as string) ?? '',
              pipeline_id: input.pipelineId ?? '',
              pipeline_type: input.pipelineType ?? '',
            });
          }

          const avgToxicity = totalToxicity / messages.length;
          const sessionStatus = statusFromScore(avgToxicity, threshold);

          const sessionStartedAt = metadata?.sessionStartedAt
            ? toCHDateTime(new Date(metadata.sessionStartedAt))
            : processedAt;

          const sessionRow: ToxicityEvaluationRow = {
            tenant_id: input.tenantId,
            project_id: input.projectId ?? '',
            session_id: input.sessionId!,
            session_started_at: sessionStartedAt,
            processed_at: processedAt,
            agent_name: agentName,
            channel,
            avg_toxicity: Math.round(avgToxicity * 1000) / 1000,
            max_toxicity: Math.round(maxToxicity * 1000) / 1000,
            flagged: sessionStatus !== 'pass' ? 1 : 0,
            status: sessionStatus,
            threshold,
            message_count: messages.length,
            model_id: '',
            config_version: 1,
            run_id: (input.pipelineInput?.runId as string) ?? '',
            pipeline_id: input.pipelineId ?? '',
            pipeline_type: input.pipelineType ?? '',
            source: 'keyword',
            processing_ms: processingMs,
            input_tokens: 0,
            output_tokens: 0,
          };

          // Write to ClickHouse
          log.debug('Writing toxicity results to ClickHouse', {
            tenantId: input.tenantId,
            sessionId: input.sessionId,
            messageRows: messageToxicityRows.length,
            status: sessionStatus,
          });

          const client = getClickHouseClient();

          if (messageToxicityRows.length > 0) {
            await client.insert({
              table: MESSAGE_TOXICITY_TABLE,
              values: messageToxicityRows,
              format: 'JSONEachRow',
            });
          }

          await client.insert({
            table: TOXICITY_TABLE,
            values: [sessionRow],
            format: 'JSONEachRow',
          });

          const output = {
            avgToxicity: Math.round(avgToxicity * 1000) / 1000,
            maxToxicity: Math.round(maxToxicity * 1000) / 1000,
            flagged: sessionStatus !== 'pass',
            messageCount: messages.length,
            status: sessionStatus,
            inputTokens: 0,
            outputTokens: 0,
          };

          log.info('Toxicity output', {
            sessionId: input.sessionId,
            ...output,
            threshold,
            processingMs,
          });

          return output;
        });

        return {
          status: 'success',
          data: result,
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error('ComputeToxicity failed', {
          tenantId: input.tenantId,
          sessionId: input.sessionId,
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
export type ComputeToxicityService = typeof computeToxicityService;

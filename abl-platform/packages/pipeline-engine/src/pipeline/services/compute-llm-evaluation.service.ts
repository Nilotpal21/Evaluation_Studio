/**
 * Config-Driven LLM Evaluation Service
 *
 * Single service handling multiple LLM-based evaluation types via profiles:
 * hallucination, knowledge_gap, guardrail, context_preservation
 *
 * Each profile defines: system/user prompts, output schema, scoring logic,
 * flagging logic, and target ClickHouse table.
 */
import * as restate from '@restatedev/restate-sdk';
import type { PipelineStepContext, StepOutput } from '../types.js';
import { resolveContextInput } from '../execution-context.js';
import { resolvePipelineLLM } from './llm-client-factory.js';
import { pipelineGenerateText } from './pipeline-llm-call.js';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import { createLogger, parseJSON } from '@abl/compiler/platform';
import {
  HALLUCINATION_SYSTEM_PROMPT,
  buildHallucinationUserPrompt,
  KNOWLEDGE_GAP_SYSTEM_PROMPT,
  buildKnowledgeGapUserPrompt,
  GUARDRAIL_SYSTEM_PROMPT,
  buildGuardrailUserPrompt,
  CONTEXT_PRESERVATION_SYSTEM_PROMPT,
  buildContextPreservationUserPrompt,
} from '../prompts/index.js';

const log = createLogger('conversation-analyzer');

/** Convert a Date (or ISO string) to ClickHouse DateTime64(3) format. */
function toCHDateTime(d: Date | string): string {
  const iso = typeof d === 'string' ? new Date(d).toISOString() : d.toISOString();
  return iso.replace('T', ' ').replace('Z', '');
}

// ---------------------------------------------------------------------------
// Evaluation Profile Types
// ---------------------------------------------------------------------------

interface EvaluationProfile {
  name: string;
  systemPrompt: string;
  userPromptBuilder: (transcript: string, metadata: Record<string, unknown>) => string;
  outputFields: string[];
  scoringFn: (parsed: Record<string, unknown>) => number;
  flagFn: (parsed: Record<string, unknown>, config: Record<string, unknown>) => boolean;
  clickhouseTable: string;
}

// ---------------------------------------------------------------------------
// Evaluation Profiles
// ---------------------------------------------------------------------------

const EVALUATION_PROFILES: Record<string, EvaluationProfile> = {
  hallucination: {
    name: 'Hallucination Detection',
    systemPrompt: HALLUCINATION_SYSTEM_PROMPT,
    userPromptBuilder: (transcript) => buildHallucinationUserPrompt(transcript),
    outputFields: [
      'faithfulness_score',
      'claims',
      'unsupported_claims',
      'consistency_index',
      'contradiction_detected',
    ],
    scoringFn: (p) => Number(p.faithfulness_score) || 0,
    flagFn: (p, config) => {
      const threshold = Number(config.flagThreshold) || 0.5;
      return Number(p.faithfulness_score) < threshold;
    },
    clickhouseTable: 'abl_platform.hallucination_evaluations',
  },

  knowledge_gap: {
    name: 'Knowledge Gap Analysis',
    systemPrompt: KNOWLEDGE_GAP_SYSTEM_PROMPT,
    userPromptBuilder: (transcript) => buildKnowledgeGapUserPrompt(transcript),
    outputFields: [
      'retrieval_precision',
      'citation_rate',
      'gap_detected',
      'gap_topics',
      'unused_articles',
      'article_ids_cited',
    ],
    scoringFn: (p) =>
      (Number(p.retrieval_precision) || 0) * 0.5 + (Number(p.citation_rate) || 0) * 0.5,
    flagFn: (p) => p.gap_detected === true,
    clickhouseTable: 'abl_platform.knowledge_gap_evaluations',
  },

  guardrail: {
    name: 'Guardrail Analysis',
    systemPrompt: GUARDRAIL_SYSTEM_PROMPT,
    userPromptBuilder: (transcript) => buildGuardrailUserPrompt(transcript),
    outputFields: [
      'false_positive_score',
      'false_negative_score',
      'bypass_detected',
      'bypass_technique',
      'severity',
      'violation_categories',
    ],
    scoringFn: (p) =>
      1.0 - Math.max(Number(p.false_positive_score) || 0, Number(p.false_negative_score) || 0),
    flagFn: (p, config) => {
      const threshold = Number(config.flagThreshold) || 0.5;
      return (
        Number(p.false_positive_score) > threshold ||
        Number(p.false_negative_score) > threshold ||
        p.bypass_detected === true
      );
    },
    clickhouseTable: 'abl_platform.guardrail_evaluations',
  },

  context_preservation: {
    name: 'Context Preservation Analysis',
    systemPrompt: CONTEXT_PRESERVATION_SYSTEM_PROMPT,
    userPromptBuilder: (transcript) => buildContextPreservationUserPrompt(transcript),
    outputFields: [
      'context_score',
      'lost_context_items',
      'duplication_detected',
      'duplication_count',
      'handoff_count',
    ],
    scoringFn: (p) => Number(p.context_score) || 0,
    flagFn: (p) => Number(p.context_score) < 0.6 || p.duplication_detected === true,
    clickhouseTable: 'abl_platform.context_evaluations',
  },
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const conversationAnalyzerService = restate.service({
  name: 'ConversationAnalyzer',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();

      // 1. Resolve evaluation profile
      const evaluationType = input.config.evaluationType as string;
      const profile = EVALUATION_PROFILES[evaluationType];
      if (!profile) {
        return {
          status: 'fail',
          data: {
            error: `Unknown evaluation type: '${evaluationType}'. Available: ${Object.keys(EVALUATION_PROFILES).join(', ')}`,
          },
          durationMs: Date.now() - startTime,
        };
      }

      // 2. Get conversation data from previous step or execution context
      const conversationData = resolveContextInput(input, 'conversation');
      if (!conversationData) {
        return {
          status: 'fail',
          data: {
            error: `${profile.name} requires conversation data (from read-conversation or execution context)`,
          },
          durationMs: Date.now() - startTime,
        };
      }

      // Support both read-conversation and read-message-window output shapes
      let messages: Array<Record<string, unknown>>;
      let transcript: string;
      let metadata: Record<string, unknown>;

      if (conversationData.triggeringMessage && input.config.mode) {
        // read-message-window output: convert to messages + transcript
        const trigger = conversationData.triggeringMessage as {
          role: string;
          content: string;
          messageIndex: number;
          messageId: string;
        };
        const window = (conversationData.windowMessages as Array<Record<string, unknown>>) ?? [];
        const wmeta = (conversationData.metadata as Record<string, unknown>) ?? {};
        const triggerMsg = {
          messageId: trigger.messageId,
          role: trigger.role,
          content: trigger.content,
          timestamp: new Date().toISOString(),
        };
        messages = [...window, triggerMsg];
        transcript = messages.map((m) => `${m.role}: ${m.content}`).join('\n');
        metadata = wmeta;
      } else {
        messages = (conversationData.messages as Array<Record<string, unknown>>) ?? [];
        transcript = (conversationData.transcript as string) ?? '';
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

      try {
        // 3. Call LLM
        // Client creation errors (unsupported provider, missing credentials) are
        // deterministic — wrap in TerminalError to prevent infinite Restate retries.
        const llmResult = await ctx.run(`evaluate-${evaluationType}`, async () => {
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
          return pipelineGenerateText(
            resolved,
            {
              system: (input.config.systemPromptOverride as string) ?? profile.systemPrompt,
              messages: [
                {
                  role: 'user' as const,
                  content: profile.userPromptBuilder(transcript, metadata),
                },
              ],
              maxOutputTokens: 1024,
              temperature: 0,
            },
            {
              service: 'conversation-analyzer',
              tenantId: input.tenantId,
              projectId: input.projectId,
              sessionId,
            },
          );
        });

        // 4. Parse response (parseJSON strips markdown code fences)
        const parsed = parseJSON<Record<string, unknown>>(llmResult.content);
        if (!parsed) {
          return {
            status: 'fail',
            data: {
              error: `Failed to parse ${profile.name} LLM response as JSON`,
            },
            durationMs: Date.now() - startTime,
          };
        }

        // 5. Compute score and flag
        const score = profile.scoringFn(parsed);
        const flagged = profile.flagFn(parsed, input.config);

        // 6. Build ClickHouse row
        const row: Record<string, unknown> = {
          tenant_id: input.tenantId,
          project_id: input.projectId ?? '',
          session_id: sessionId,
          session_started_at: toCHDateTime((messages[0]?.timestamp as string) ?? new Date()),
          agent_name: (metadata.agentName as string) ?? '',
          channel: (metadata.channel as string) ?? '',
          processed_at: toCHDateTime(new Date()),
          evaluation_type: evaluationType,
          overall_score: score,
          flagged: flagged ? 1 : 0,
          flag_reasons: flagged ? [evaluationType] : [],
          confidence: score,
          model_id: llmResult.model,
          config_version: Number(input.config.configVersion) || 1,
          input_tokens: llmResult.inputTokens,
          output_tokens: llmResult.outputTokens,
          processing_ms: Date.now() - startTime,
          run_id: (input.pipelineInput?.runId as string) ?? '',
          pipeline_id: input.pipelineId ?? '',
          pipeline_type: input.pipelineType ?? '',
          source: input.executionMode === 'realtime' ? 'realtime' : 'batch',
        };

        // Add profile-specific fields (convert booleans to UInt8 for ClickHouse)
        for (const field of profile.outputFields) {
          const val = parsed[field] ?? null;
          row[field] = typeof val === 'boolean' ? (val ? 1 : 0) : val;
        }

        // 7. Write to ClickHouse
        log.debug(`Writing ${evaluationType} result to ${profile.clickhouseTable}`, {
          tenantId: input.tenantId,
          sessionId,
          score,
          flagged,
        });
        // Write to ClickHouse (skipped when store-results handles persistence)
        if (!input.config.skipDirectWrite) {
          await ctx.run(`store-${evaluationType}-results`, async () => {
            const client = getClickHouseClient();
            await client.insert({
              table: profile.clickhouseTable,
              values: [row],
              format: 'JSONEachRow',
            });
          });
          log.debug(`${evaluationType} result written to ClickHouse`, {
            tenantId: input.tenantId,
            sessionId,
          });
        }

        // 8. Return success
        return {
          status: 'success',
          data: {
            ...parsed,
            overall_score: score,
            flagged,
            evaluation_type: evaluationType,
            inputTokens: llmResult.inputTokens,
            outputTokens: llmResult.outputTokens,
          },
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`${profile.name} evaluation failed`, {
          tenantId: input.tenantId,
          sessionId,
          evaluationType,
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

export type ConversationAnalyzerService = typeof conversationAnalyzerService;

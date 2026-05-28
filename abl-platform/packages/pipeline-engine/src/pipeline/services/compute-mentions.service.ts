/**
 * Mention Detection Service
 *
 * Restate activity service that uses LLM to extract structured mentions
 * (competitor, feature request, bug report, channel switch) from conversation text.
 *
 * Exports the pure `parseMentionResponse` function for direct testing.
 */
import * as restate from '@restatedev/restate-sdk';
import { createLogger } from '@abl/compiler/platform';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import { resolvePipelineLLM } from './llm-client-factory.js';
import { pipelineGenerateText } from './pipeline-llm-call.js';
import type { PipelineStepContext, StepOutput } from '../types.js';
import { resolveContextInput } from '../execution-context.js';
import { MENTION_SYSTEM_PROMPT, buildMentionUserPrompt } from '../prompts/index.js';

const log = createLogger('compute-mentions');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MentionResult {
  type: 'competitor' | 'feature_request' | 'bug_report' | 'channel_switch';
  text: string;
  detail: string;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Pure function — exported for testing
// ---------------------------------------------------------------------------

export function parseMentionResponse(text: string): MentionResult[] {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((m: Record<string, unknown>) => m.type && m.text && typeof m.confidence === 'number')
      .map((m: Record<string, unknown>) => ({
        type: m.type as MentionResult['type'],
        text: String(m.text),
        detail: m.detail ? String(m.detail) : '',
        confidence: Number(m.confidence),
      }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const computeMentionsService = restate.service({
  name: 'ComputeMentions',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();
      const tenantId = input.tenantId;
      const projectId = input.projectId;
      const sessionId = input.sessionId ?? (input.pipelineInput.sessionId as string);

      if (!tenantId || !projectId || !sessionId) {
        return {
          status: 'fail',
          data: { error: 'Missing tenantId, projectId, or sessionId' },
          durationMs: Date.now() - startTime,
        };
      }

      try {
        // Get conversation messages from prior step output or execution context
        const conversationData = resolveContextInput(input, 'conversation');
        if (!conversationData) {
          return {
            status: 'fail',
            data: {
              error:
                'Mention detection requires conversation data (from read-conversation or execution context)',
            },
            durationMs: Date.now() - startTime,
          };
        }

        const messages =
          (conversationData.messages as Array<{
            role: string;
            content: string;
          }>) ?? [];

        if (messages.length === 0) {
          return {
            status: 'success',
            data: { mentions: [], mentionCount: 0 },
            durationMs: Date.now() - startTime,
          };
        }

        // Read config fields for mention extraction
        const companyName = input.config.companyName as string | undefined;
        const competitors = input.config.competitors as string[] | undefined;

        // Call LLM to extract mentions
        const mentions = await ctx.run('extract-mentions', async () => {
          let resolved;
          try {
            resolved = await resolvePipelineLLM(
              tenantId,
              projectId,
              input.config.model as string | undefined,
            );
          } catch (err) {
            throw new restate.TerminalError(
              `LLM resolution failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          const conversationText = messages.map((m) => `${m.role}: ${m.content}`).join('\n');

          const llmResult = await pipelineGenerateText(
            resolved,
            {
              system: MENTION_SYSTEM_PROMPT,
              messages: [
                {
                  role: 'user' as const,
                  content: buildMentionUserPrompt(conversationText, { companyName, competitors }),
                },
              ],
              maxOutputTokens: 1024,
              temperature: 0,
            },
            { service: 'compute-mentions', tenantId, projectId, sessionId },
          );

          return parseMentionResponse(llmResult.content);
        });

        // Write mentions to ClickHouse
        if (mentions.length > 0) {
          await ctx.run('write-mentions', async () => {
            const ch = getClickHouseClient();
            await ch.insert({
              table: 'abl_platform.conversation_mentions',
              values: mentions.map((m) => ({
                tenant_id: tenantId,
                project_id: projectId,
                session_id: sessionId,
                processed_at: new Date().toISOString(),
                company_name: companyName ?? '',
                mention_type: m.type,
                mention_text: m.text,
                mention_detail: m.detail,
                confidence: m.confidence,
                channel:
                  (conversationData.metadata as Record<string, unknown> | undefined)?.channel ?? '',
                run_id: (input.pipelineInput?.runId as string) ?? '',
                pipeline_id: input.pipelineId ?? '',
                pipeline_type: input.pipelineType ?? '',
              })),
              format: 'JSONEachRow',
            });
          });
        }

        log.info('Mentions extracted', {
          tenantId,
          projectId,
          sessionId,
          mentionCount: mentions.length,
        });

        return {
          status: 'success',
          data: {
            mentions,
            mentionCount: mentions.length,
            byType: {
              competitor: mentions.filter((m) => m.type === 'competitor').length,
              feature_request: mentions.filter((m) => m.type === 'feature_request').length,
              bug_report: mentions.filter((m) => m.type === 'bug_report').length,
              channel_switch: mentions.filter((m) => m.type === 'channel_switch').length,
            },
          },
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        log.error('Failed to extract mentions', {
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          status: 'fail',
          data: { error: error instanceof Error ? error.message : String(error) },
          durationMs: Date.now() - startTime,
        };
      }
    },
  },
});

export type ComputeMentionsService = typeof computeMentionsService;

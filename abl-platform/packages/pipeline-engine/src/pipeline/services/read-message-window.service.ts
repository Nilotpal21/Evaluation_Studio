/**
 * ReadMessageWindow — Restate activity service for real-time pipeline processing.
 *
 * Lightweight alternative to ReadConversation for per-message triggers.
 * Instead of reading an entire session, it:
 *   1. Extracts the triggering message from the event payload (no DB fetch)
 *   2. Fetches a sliding window of prior messages from ClickHouse
 *   3. Optionally enriches with recent tool call traces
 *   4. Returns total session message count for compute steps
 *
 * Config:
 *   windowSize?:       Number of prior messages to fetch (default: 5)
 *   includeToolCalls?: Enrich with recent tool call traces (default: false)
 */
import * as restate from '@restatedev/restate-sdk';
import { createLogger } from '@abl/compiler/platform';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import { decryptForTenantAuto } from '@agent-platform/shared/encryption';
import type { PipelineStepContext, StepOutput } from '../types.js';
import type { ConversationMessage, ConversationToolCall } from './conversation-reader.js';
import { renderPipelineReadValue } from './pii-boundary.js';

const log = createLogger('read-message-window');

export interface ReadMessageWindowOutput {
  triggeringMessage: {
    role: 'user' | 'assistant';
    content: string;
    messageIndex: number;
    messageId: string;
  };
  windowMessages: ConversationMessage[];
  toolCalls?: ConversationToolCall[];
  metadata: {
    sessionId: string;
    agentName?: string;
    channel?: string;
    windowSize: number;
    totalSessionMessages: number;
  };
}

export const readMessageWindowService = restate.service({
  name: 'ReadMessageWindow',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();

      const sessionId = input.sessionId ?? (input.pipelineInput.sessionId as string | undefined);
      if (!sessionId) {
        return {
          status: 'fail',
          data: { error: 'ReadMessageWindow requires sessionId in pipeline context or input' },
          durationMs: Date.now() - startTime,
        };
      }

      const windowSize = (input.config.windowSize as number) ?? 5;
      const includeToolCalls = (input.config.includeToolCalls as boolean) ?? false;

      // Extract triggering message from event payload (no DB fetch needed)
      const payload = input.pipelineInput.payload as Record<string, unknown> | undefined;
      if (!payload) {
        return {
          status: 'fail',
          data: { error: 'ReadMessageWindow requires payload in pipelineInput' },
          durationMs: Date.now() - startTime,
        };
      }

      const triggeringMessage = {
        role: (payload.role as 'user' | 'assistant') ?? 'user',
        content: await renderPipelineReadValue((payload.content as string) ?? '', {
          tenantId: input.tenantId,
          projectId: input.projectId,
          role: (payload.role as string | undefined) ?? 'user',
        }),
        messageIndex: (payload.messageIndex as number) ?? 0,
        messageId: (payload.messageId as string) ?? '',
      };

      try {
        const result = await ctx.run('read-message-window', async () => {
          const client = getClickHouseClient();

          // Fetch prior messages (sliding window).
          // The messages table is sorted by (tenant_id, session_id, created_at).
          // Use created_at ordering and exclude the triggering message by message_id.
          const windowResult = await client.query({
            query: `
              SELECT message_id, role, content, created_at, channel, metadata
              FROM abl_platform.messages
              WHERE tenant_id = {tenantId:String}
                AND session_id = {sessionId:String}
                AND message_id != {triggeringMessageId:String}
              ORDER BY created_at DESC
              LIMIT {windowSize:UInt32}
              SETTINGS max_execution_time = 30
            `,
            query_params: {
              tenantId: input.tenantId,
              sessionId,
              triggeringMessageId: triggeringMessage.messageId,
              windowSize,
            },
          });

          const windowRows = (
            (await windowResult.json()) as {
              data: Array<{
                message_id: string;
                role: string;
                content: string;
                created_at: string;
                channel: string;
                metadata: string;
              }>;
            }
          ).data;

          // Decrypt window messages
          const windowMessages = (
            await Promise.all(
              windowRows.map(async (row) => {
                let content: string;
                try {
                  content = await decryptForTenantAuto(row.content, input.tenantId);
                } catch (err) {
                  throw new Error(
                    `ReadMessageWindow message content unavailable after decryption for message ${row.message_id}: ${
                      err instanceof Error ? err.message : String(err)
                    }`,
                  );
                }
                return {
                  messageId: row.message_id,
                  role: row.role as 'user' | 'assistant' | 'system' | 'tool',
                  content: await renderPipelineReadValue(content, {
                    tenantId: input.tenantId,
                    projectId: input.projectId,
                    role: row.role,
                  }),
                  timestamp: row.created_at,
                  channel: row.channel || undefined,
                };
              }),
            )
          ).reverse(); // Chronological order

          // Fetch total message count
          const countResult = await client.query({
            query: `
              SELECT count() as total
              FROM abl_platform.messages
              WHERE tenant_id = {tenantId:String}
                AND session_id = {sessionId:String}
              SETTINGS max_execution_time = 30
            `,
            query_params: { tenantId: input.tenantId, sessionId },
          });
          const countRows = ((await countResult.json()) as { data: Array<{ total: string }> }).data;
          const totalSessionMessages = parseInt(countRows[0]?.total ?? '0', 10);

          // Optionally fetch tool calls
          let toolCalls: ConversationToolCall[] | undefined;
          if (includeToolCalls) {
            const traceResult = await client.query({
              query: `
                SELECT agent_name, data, timestamp, duration_ms, has_error
                FROM abl_platform.platform_events
                WHERE tenant_id = {tenantId:String}
                  AND session_id = {sessionId:String}
                  AND event_type IN ('tool.call.completed', 'tool.call.failed')
                ORDER BY timestamp DESC
                LIMIT {windowSize:UInt32}
                SETTINGS max_execution_time = 30
              `,
              query_params: {
                tenantId: input.tenantId,
                sessionId,
                windowSize,
              },
            });
            const traceRows = (
              (await traceResult.json()) as {
                data: Array<{
                  agent_name: string;
                  data: string;
                  timestamp: string;
                  duration_ms: number;
                  has_error: number;
                }>;
              }
            ).data;

            toolCalls = await Promise.all(
              traceRows.map(async (row) => {
                let parsed: Record<string, unknown> = {};
                try {
                  const decrypted = await decryptForTenantAuto(row.data, input.tenantId);
                  parsed = JSON.parse(decrypted);
                } catch {
                  // ignore parse errors
                }
                const toolCall = {
                  toolName: (parsed.toolName as string) ?? 'unknown',
                  arguments: (parsed.arguments as Record<string, unknown>) ?? {},
                  result: parsed.result,
                  success: !row.has_error,
                  errorMessage: parsed.errorMessage as string | undefined,
                  timestamp: row.timestamp,
                  durationMs: row.duration_ms,
                };
                return renderPipelineReadValue(toolCall, {
                  tenantId: input.tenantId,
                  projectId: input.projectId,
                });
              }),
            );
          }

          return { windowMessages, totalSessionMessages, toolCalls };
        });

        const output: ReadMessageWindowOutput = {
          triggeringMessage,
          windowMessages: result.windowMessages,
          toolCalls: result.toolCalls,
          metadata: {
            sessionId,
            agentName: input.pipelineInput.agentName as string | undefined,
            channel: input.pipelineInput.channel as string | undefined,
            windowSize,
            totalSessionMessages: result.totalSessionMessages,
          },
        };

        log.debug('Message window read complete', {
          tenantId: input.tenantId,
          sessionId,
          windowSize: result.windowMessages.length,
          totalMessages: result.totalSessionMessages,
        });

        return {
          status: 'success',
          data: output as unknown as Record<string, any>,
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error('ReadMessageWindow failed', { tenantId: input.tenantId, sessionId, error: msg });
        return {
          status: 'fail',
          data: { error: msg },
          durationMs: Date.now() - startTime,
        };
      }
    },
  },
});

export type ReadMessageWindowService = typeof readMessageWindowService;

/**
 * ReadConversation — Restate activity service for reading conversation data.
 *
 * Uses ConversationReader to fetch and decrypt messages + traces from ClickHouse,
 * then returns transcript, messages, toolCalls, escalations, and metadata.
 *
 * For message-level triggers (message.user, message.agent), the triggering
 * message is extracted directly from the event payload — no DB fetch needed.
 * For session-level triggers (session.ended, manual, etc.), the full session
 * is read from MongoDB as before.
 *
 * Config:
 *   enrichWithTraces?:  Include tool calls and escalation data (default: true)
 *   roles?:             Filter by message roles (default: all)
 *
 * The sessionId is resolved from:
 *   1. input.sessionId (direct pipeline context)
 *   2. input.pipelineInput.sessionId (trigger payload)
 */
import * as restate from '@restatedev/restate-sdk';
import { createLogger } from '@abl/compiler/platform';
import { ConversationReader, DecryptionError } from './conversation-reader.js';
import type { ConversationMessage } from './conversation-reader.js';
import type { PipelineStepContext, StepOutput } from '../types.js';
import { renderPipelineReadValue } from './pii-boundary.js';

const log = createLogger('read-conversation');

/** Map trigger event type to message role. */
const MESSAGE_TRIGGER_ROLES: Record<string, ConversationMessage['role']> = {
  'message.user': 'user',
  'message.agent': 'assistant',
};

const ROLE_LABELS: Record<string, string> = {
  user: 'User',
  assistant: 'Assistant',
};

/**
 * Check whether the trigger is a message-level event and, if so,
 * build a single-message ConversationData directly from the payload.
 */
async function buildFromMessageTrigger(input: PipelineStepContext): Promise<{
  transcript: string;
  messages: ConversationMessage[];
  metadata: { agentName?: string; channel?: string; messageCount: number };
} | null> {
  const eventType = input.pipelineInput.type as string | undefined;
  if (!eventType) return null;

  const role = MESSAGE_TRIGGER_ROLES[eventType];
  if (!role) return null;

  const payload = input.pipelineInput.payload as
    | { messageId?: string; content?: string; messageIndex?: number }
    | undefined;

  if (!payload?.content) {
    return null;
  }

  const safeContent = await renderPipelineReadValue(payload.content, {
    tenantId: input.tenantId,
    projectId: input.projectId,
    role,
  });

  const message: ConversationMessage = {
    messageId: payload.messageId ?? '',
    role,
    content: safeContent,
    timestamp: (input.pipelineInput.timestamp as string) ?? new Date().toISOString(),
    channel: input.pipelineInput.channel as string | undefined,
  };

  const label = ROLE_LABELS[role] ?? role;

  return {
    transcript: `${label}: ${safeContent}`,
    messages: [message],
    metadata: {
      agentName: input.pipelineInput.agentName as string | undefined,
      channel: input.pipelineInput.channel as string | undefined,
      messageCount: 1,
    },
  };
}

export const readConversationService = restate.service({
  name: 'ReadConversation',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();

      // Resolve sessionId from direct context or pipeline input
      const sessionId = input.sessionId ?? (input.pipelineInput.sessionId as string | undefined);

      if (!sessionId) {
        return {
          status: 'fail',
          data: { error: 'ReadConversation requires sessionId in pipeline context or input' },
          durationMs: Date.now() - startTime,
        };
      }

      // ── Message-level trigger: use payload directly (no DB fetch) ──
      const messageTriggerData = await buildFromMessageTrigger(input);
      if (messageTriggerData) {
        log.debug('Using message from trigger payload', {
          tenantId: input.tenantId,
          sessionId,
          eventType: input.pipelineInput.type,
          messageCount: 1,
        });

        return {
          status: 'success',
          data: {
            transcript: messageTriggerData.transcript,
            messages: messageTriggerData.messages,
            toolCalls: [],
            escalations: [],
            metadata: messageTriggerData.metadata,
          },
          durationMs: Date.now() - startTime,
        };
      }

      // ── Session-level trigger: read full session from MongoDB ──
      const enrichWithTraces = (input.config.enrichWithTraces as boolean) ?? true;
      const roles = input.config.roles as string[] | undefined;

      try {
        log.debug('Reading conversation from session', {
          tenantId: input.tenantId,
          sessionId,
          enrichWithTraces,
        });

        const { conversationData, transcript } = await ctx.run('read-conversation', async () => {
          const reader = new ConversationReader({
            tenantId: input.tenantId,
            projectId: input.projectId,
          });
          try {
            const data = await reader.readSession(input.tenantId, sessionId, {
              enrichWithTraces,
              roles,
            });
            return { conversationData: data, transcript: reader.formatTranscript(data) };
          } catch (err) {
            // DecryptionError is deterministic — retrying will never succeed.
            // Wrap in TerminalError so Restate stops retrying this invocation.
            if (err instanceof DecryptionError) {
              throw new restate.TerminalError(err.message);
            }
            throw err;
          }
        });

        log.debug('Conversation read complete', {
          tenantId: input.tenantId,
          sessionId,
          messageCount: conversationData.messages?.length ?? 0,
          hasTranscript: transcript.length > 0,
          transcriptLength: transcript.length,
          toolCallCount: conversationData.toolCalls?.length ?? 0,
          agentName: conversationData.metadata?.agentName,
          channel: conversationData.metadata?.channel,
        });

        return {
          status: 'success',
          data: {
            transcript,
            messages: conversationData.messages,
            toolCalls: conversationData.toolCalls,
            escalations: conversationData.escalations,
            metadata: conversationData.metadata,
          },
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error('ReadConversation failed', { tenantId: input.tenantId, sessionId, error: msg });
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
export type ReadConversationService = typeof readConversationService;

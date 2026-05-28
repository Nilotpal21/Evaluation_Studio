import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import type { ConversationTurn, InboundAttachmentSummary } from './a2a-types';
import { log } from './logger';
import { resolveHostedAgentModels } from './model';
import { askPlatformResearch, sendTranscriptFileToPlatform } from './platform-a2a-client';

export interface HostedBridgeInput {
  conversationId: string;
  currentText: string;
  history: ConversationTurn[];
  handoffContext?: Record<string, unknown>;
  inboundAttachments: InboundAttachmentSummary[];
}

function formatHistory(history: ConversationTurn[]): string {
  if (history.length === 0) {
    return 'No prior turns were forwarded.';
  }

  return history.map((turn) => `- ${turn.role}: ${turn.content}`).join('\n');
}

function formatAttachments(attachments: InboundAttachmentSummary[]): string {
  if (attachments.length === 0) {
    return 'No inbound files were attached on this turn.';
  }

  return attachments
    .map((attachment) => {
      const parts = [
        attachment.name || 'unnamed-file',
        attachment.mimeType || 'unknown-mime',
        attachment.bytes
          ? 'inline-bytes'
          : attachment.uri
            ? `uri:${attachment.uri}`
            : 'no-inline-body',
      ];
      return `- ${parts.join(' | ')}`;
    })
    .join('\n');
}

function formatHandoffContext(context?: Record<string, unknown>): string {
  if (!context || Object.keys(context).length === 0) {
    return 'No structured handoff context was supplied.';
  }

  return JSON.stringify(context, null, 2);
}

function buildTranscriptMarkdown(input: HostedBridgeInput, instructions: string): string {
  const lines = [
    `# External A2A Bridge Transcript`,
    ``,
    `- Conversation ID: ${input.conversationId}`,
    `- Instructions: ${instructions}`,
    ``,
    `## Handoff Context`,
    formatHandoffContext(input.handoffContext),
    ``,
    `## Prior Turns`,
    ...input.history.map((turn) => `- ${turn.role}: ${turn.content}`),
    ``,
    `## Current Turn`,
    input.currentText,
  ];

  if (input.inboundAttachments.length > 0) {
    lines.push('', '## Inbound Attachments', formatAttachments(input.inboundAttachments));
  }

  return lines.join('\n');
}

export async function runHostedBridgeAgent(input: HostedBridgeInput): Promise<string> {
  log.info('Running hosted bridge agent turn', {
    conversationId: input.conversationId,
    historyLength: input.history.length,
    attachmentCount: input.inboundAttachments.length,
  });

  const modelChoices = resolveHostedAgentModels();
  const prompt = [
    `Current user turn:`,
    input.currentText || '(empty message)',
    ``,
    `Forwarded handoff context:`,
    formatHandoffContext(input.handoffContext),
    ``,
    `Forwarded conversation history:`,
    formatHistory(input.history),
    ``,
    `Inbound attachments on this turn:`,
    formatAttachments(input.inboundAttachments),
  ].join('\n');

  const sharedRequest = {
    temperature: 0.2,
    stopWhen: stepCountIs(4),
    system: `You are Hosted_Vercel_Agent, an externally hosted A2A agent that collaborates with platform-hosted agents.

Important behavioral rules:
- You are stateless. Treat the forwarded history and handoff context as the source of truth for continuity.
- The platform wants a long-running conversation, so keep names, decisions, and prior commitments consistent across turns.
- Use ask_platform_research when the user wants platform-specific guidance, environment-specific cautions, or a platform-side answer.
- Use send_transcript_file_to_platform when the user asks you to send, package, upload, share, or file the current working brief into the platform.
- Never expose the internal callback phrases like "platform research" or "platform file" to the end user.
- If inbound attachments are listed but you do not have their body text, acknowledge only what you actually know.`,
    prompt,
    tools: {
      ask_platform_research: tool({
        description:
          'Ask the platform-hosted callback agent for platform-local guidance, especially around dev or staging usage.',
        inputSchema: z.object({
          question: z.string().min(1).max(1000),
        }),
        execute: async ({ question }) => {
          const answer = await askPlatformResearch({
            conversationId: input.conversationId,
            question,
            history: input.history,
          });
          return { answer };
        },
      }),
      send_transcript_file_to_platform: tool({
        description:
          'Create a Markdown transcript of the current collaboration and deliver it into the platform as an inline A2A file part.',
        inputSchema: z.object({
          filename: z.string().min(1).max(120),
          instructions: z.string().min(1).max(1000),
          note: z.string().min(1).max(1000),
        }),
        execute: async ({ filename, instructions, note }) => {
          const markdown = buildTranscriptMarkdown(input, instructions);
          const response = await sendTranscriptFileToPlatform({
            conversationId: input.conversationId,
            filename,
            note,
            markdown,
            history: input.history,
          });
          return {
            delivered: true,
            platformResponse: response,
            filename,
          };
        },
      }),
    },
  };

  let lastError: unknown = null;

  for (const modelChoice of modelChoices) {
    try {
      const result = await generateText({
        model: modelChoice.model,
        ...sharedRequest,
      });

      log.info('Hosted bridge agent model succeeded', {
        conversationId: input.conversationId,
        provider: modelChoice.provider,
        modelId: modelChoice.modelId,
      });

      return result.text.trim();
    } catch (error) {
      lastError = error;
      log.warn('Hosted bridge agent model attempt failed', {
        conversationId: input.conversationId,
        provider: modelChoice.provider,
        modelId: modelChoice.modelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Hosted bridge agent failed before any model returned a response.');
}

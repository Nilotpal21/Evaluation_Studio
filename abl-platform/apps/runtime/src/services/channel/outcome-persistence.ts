import type { ChannelOutcome } from './outcome.js';
import type { ResponseMessageMetadata } from './response-provenance.js';
import { withAgentNameMetadata, type AssistantMessageMetadata } from './message-metadata.js';
import {
  buildPersistedAssistantStructuredContent,
  type PersistedMessageStructuredContent,
} from '../session/persisted-message-content.js';

export interface AssistantPersistenceMessage {
  content: string;
  structuredContent?: PersistedMessageStructuredContent;
  metadata?: AssistantMessageMetadata;
  messageId?: string;
  agentName?: string;
  messageTimestamp?: number;
}

interface BuildAssistantPersistenceMessagesParams {
  outcome: ChannelOutcome;
  responseMetadata?: ResponseMessageMetadata;
  responseMessageId?: string;
  agentName?: string;
  messageTimestamp?: number;
}

function resolveFinalOutputMessageId(outcome: ChannelOutcome): string | undefined {
  if (!outcome.outputMessages?.length) return outcome.finalOutputMessageId;
  if (outcome.finalOutputMessageId) return outcome.finalOutputMessageId;

  return [...outcome.outputMessages]
    .reverse()
    .find((message) => message.phase === 'final' && message.text.trim().length > 0)?.id;
}

export function buildAssistantPersistenceMessages({
  outcome,
  responseMetadata,
  responseMessageId,
  agentName,
  messageTimestamp,
}: BuildAssistantPersistenceMessagesParams): AssistantPersistenceMessage[] {
  const persistedOutputMessages = (outcome.outputMessages ?? [])
    .filter((message) => message.persistToTranscript && message.text.trim().length > 0)
    .sort((left, right) => left.sequence - right.sequence);

  if (persistedOutputMessages.length > 0) {
    const finalOutputMessageId = resolveFinalOutputMessageId(outcome);
    const finalStructuredContent = buildPersistedAssistantStructuredContent(outcome);

    return persistedOutputMessages.map((message) => {
      const isFinalMessage = message.id === finalOutputMessageId;
      const resolvedAgentName = message.agentName ?? agentName;
      const metadata = withAgentNameMetadata(
        isFinalMessage ? responseMetadata : undefined,
        resolvedAgentName,
      );
      return {
        content: message.text,
        ...(isFinalMessage && finalStructuredContent
          ? { structuredContent: finalStructuredContent }
          : {}),
        ...(metadata ? { metadata } : {}),
        messageId: isFinalMessage && responseMessageId ? responseMessageId : message.id,
        agentName: resolvedAgentName,
        ...(messageTimestamp !== undefined
          ? { messageTimestamp: messageTimestamp + message.sequence }
          : {}),
      };
    });
  }

  const structuredContent = buildPersistedAssistantStructuredContent(outcome);
  const metadata = withAgentNameMetadata(responseMetadata, agentName);
  return [
    {
      content: outcome.responseText,
      ...(structuredContent ? { structuredContent } : {}),
      ...(metadata ? { metadata } : {}),
      ...(responseMessageId ? { messageId: responseMessageId } : {}),
      ...(agentName ? { agentName } : {}),
      ...(messageTimestamp !== undefined ? { messageTimestamp } : {}),
    },
  ];
}

import type { ExecutionResult } from '../execution/types.js';
import { buildExecutionResultContentEnvelope } from '../execution/types.js';
import {
  buildPersistedMessageStructuredContent,
  type PersistedMessageStructuredContent,
  type PersistedStructuredMessageEnvelopeV2,
} from '../session/persisted-message-content.js';
import type { ResponseMessageMetadata } from '../channel/response-provenance.js';
import type { MessageAgentPayload } from './types.js';

export interface BuildMessageAgentPayloadInput {
  messageId: string;
  messageIndex: number;
  result: Pick<
    ExecutionResult,
    'response' | 'richContent' | 'actions' | 'voiceConfig' | 'localization' | 'responseMetadata'
  >;
}

export function buildMessageAgentPayload({
  messageId,
  messageIndex,
  result,
}: BuildMessageAgentPayloadInput): MessageAgentPayload {
  const structuredContent: PersistedMessageStructuredContent | undefined =
    buildPersistedMessageStructuredContent(result);
  const contentEnvelope: PersistedStructuredMessageEnvelopeV2 | undefined =
    buildExecutionResultContentEnvelope(result);
  const responseMetadata: ResponseMessageMetadata | undefined = result.responseMetadata;

  return {
    messageId,
    content: result.response,
    messageIndex,
    ...(structuredContent ? { structuredContent } : {}),
    ...(contentEnvelope ? { contentEnvelope } : {}),
    ...(responseMetadata ? { responseMetadata } : {}),
  };
}

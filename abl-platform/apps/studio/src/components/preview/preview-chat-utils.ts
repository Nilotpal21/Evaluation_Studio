import type {
  ActionSet,
  AuthChallengeMessage,
  MessageMetadata,
  MessageContentEnvelope,
  RichContent,
  VoiceConfig,
} from '@agent-platform/web-sdk';
import {
  normalizeActionSet,
  normalizeContentEnvelope,
  normalizeRichContent,
  normalizeVoiceConfig,
} from '@agent-platform/web-sdk';
import type { CsatData } from '../../types';
import { resolveRenderableResponseEndText } from '../../utils/response-end-message';

export type { CsatData };

export interface PreviewChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'thought';
  content: string;
  timestamp: Date;
  metadata?: MessageMetadata;
  richContent?: RichContent;
  actions?: ActionSet;
  authChallenge?: AuthChallengeMessage;
  csatData?: CsatData;
}

interface PreviewResponseEndPayload {
  messageId: string;
  fullText?: string | null;
  text?: string | null;
  contentEnvelope?: MessageContentEnvelope | null;
  voiceConfig?: VoiceConfig | null;
  metadata?: MessageMetadata;
  richContent?: RichContent | null | unknown;
  actions?: ActionSet | null | unknown;
}

interface PreviewToolThoughtEvent {
  id?: string;
  data?: {
    thought?: string;
    reasoning?: string;
    toolName?: string;
    agentName?: string;
    agent?: string;
  };
}

type PreviewAuthChallengePayload = AuthChallengeMessage;

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function buildPreviewAssistantMessage(
  payload: PreviewResponseEndPayload,
  timestamp: Date = new Date(),
): PreviewChatMessage {
  const contentEnvelope = normalizeContentEnvelope(payload.contentEnvelope);
  const voiceConfig = normalizeVoiceConfig(payload.voiceConfig) ?? contentEnvelope?.voiceConfig;
  const richContent = normalizeRichContent(payload.richContent) ?? contentEnvelope?.richContent;
  const actions = normalizeActionSet(payload.actions) ?? contentEnvelope?.actions;
  const content =
    payload.fullText?.trim() ||
    payload.text?.trim() ||
    contentEnvelope?.text?.trim() ||
    resolveRenderableResponseEndText({
      fullText: payload.fullText ?? payload.text,
      voiceConfig,
    });
  const metadata = {
    ...(payload.metadata ?? {}),
    ...(contentEnvelope?.localization ? { localization: contentEnvelope.localization } : {}),
  };

  return {
    id: payload.messageId,
    role: 'assistant',
    content,
    timestamp,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(richContent ? { richContent } : {}),
    ...(actions ? { actions } : {}),
  };
}

export function buildPreviewThoughtMessage(
  event: PreviewToolThoughtEvent,
  timestamp: Date = new Date(),
): PreviewChatMessage | null {
  const content =
    hasNonEmptyString(event.data?.thought) || hasNonEmptyString(event.data?.reasoning)
      ? event.data?.thought || event.data?.reasoning || ''
      : '';

  if (!content) {
    return null;
  }

  return {
    id: event.id || `thought-${timestamp.getTime()}`,
    role: 'thought',
    content,
    timestamp,
    metadata: {
      ...(event.data?.toolName ? { toolName: event.data.toolName } : {}),
      ...(event.data?.agentName || event.data?.agent
        ? { agentName: event.data.agentName || event.data.agent }
        : {}),
      ...(event.id ? { traceIds: [event.id] } : {}),
    },
  };
}

export function buildPreviewAuthChallengeMessage(
  payload: PreviewAuthChallengePayload,
  timestamp: Date = new Date(),
): PreviewChatMessage {
  return {
    id: `auth-challenge-${payload.toolCallId}`,
    role: 'system',
    content: payload.prompt,
    timestamp,
    authChallenge: payload,
    metadata: {
      errorCode: payload.code ?? 'AUTH_JIT_REQUIRED',
      severity: 'warning',
    },
  };
}

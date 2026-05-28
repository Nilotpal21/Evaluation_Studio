import type {
  ActionSet,
  MessageContentEnvelope,
  RichContent,
  VoiceConfig,
} from '@agent-platform/web-sdk';
import type { SessionMessage } from '../types';

export interface ResponseEndMessagePayload {
  fullText?: string | null;
  voiceConfig?: VoiceConfig | null;
  richContent?: RichContent | null;
  actions?: ActionSet | null;
  localization?: MessageContentEnvelope['localization'] | null;
  metadata?: SessionMessage['metadata'];
}

function normalizeText(value: string | null | undefined): string {
  return typeof value === 'string' ? value : '';
}

function normalizeLocalization(
  value: MessageContentEnvelope['localization'] | null | undefined,
): MessageContentEnvelope['localization'] | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

export function getRenderableVoiceText(voiceConfig?: VoiceConfig | null): string {
  return typeof voiceConfig?.plain_text === 'string' ? voiceConfig.plain_text.trim() : '';
}

export function resolveRenderableResponseEndText(payload: ResponseEndMessagePayload): string {
  const fullText = normalizeText(payload.fullText).trim();
  if (fullText.length > 0) {
    return fullText;
  }

  return getRenderableVoiceText(payload.voiceConfig);
}

export function hasRenderableResponseEndPayload(payload: ResponseEndMessagePayload): boolean {
  const resolvedText = resolveRenderableResponseEndText(payload);
  return (
    resolvedText.length > 0 || payload.richContent !== undefined || payload.actions !== undefined
  );
}

export function buildResponseEndContentEnvelope(
  payload: ResponseEndMessagePayload,
): MessageContentEnvelope | undefined {
  const text = resolveRenderableResponseEndText(payload);
  const localization = normalizeLocalization(payload.localization);
  if (
    text.length === 0 &&
    payload.voiceConfig === undefined &&
    payload.richContent === undefined &&
    payload.actions === undefined
  ) {
    return undefined;
  }

  return {
    text,
    ...(payload.voiceConfig ? { voiceConfig: payload.voiceConfig } : {}),
    ...(payload.richContent ? { richContent: payload.richContent } : {}),
    ...(payload.actions ? { actions: payload.actions } : {}),
    ...(localization ? { localization } : {}),
  };
}

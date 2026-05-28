import type { ActionSetIR, RichContentIR, VoiceConfigIR } from '@abl/compiler';
import type { ContentBlock } from '@abl/compiler/platform/llm/types.js';

export interface PersistedMessageContentEnvelopeV1 {
  version: 1;
  format: 'content_blocks';
  blocks: ContentBlock[];
  text: string;
}

export interface PersistedMessageLocalizationOwnershipV1 {
  domain: 'project' | 'platform';
  locale?: string;
  fallbackLocale?: string;
  messageKey?: string;
  catalogId?: string;
}

export interface PersistedStructuredMessageEnvelopeV2 {
  version: 2;
  format: 'message_envelope';
  text: string;
  blocks?: ContentBlock[];
  richContent?: RichContentIR;
  actions?: ActionSetIR;
  voiceConfig?: VoiceConfigIR;
  localization?: PersistedMessageLocalizationOwnershipV1;
}

export interface PersistedMessageStructuredContent {
  blocks?: ContentBlock[];
  richContent?: RichContentIR;
  actions?: ActionSetIR;
  voiceConfig?: VoiceConfigIR;
  localization?: PersistedMessageLocalizationOwnershipV1;
}

export interface PersistedAssistantStructuredContentSource {
  richContent?: RichContentIR | null;
  actions?: ActionSetIR | null;
  voiceConfig?: VoiceConfigIR | null;
  localization?: PersistedMessageLocalizationOwnershipV1;
  usedFallback?: boolean;
}

export type PersistedMessageEnvelope =
  | PersistedMessageContentEnvelopeV1
  | PersistedStructuredMessageEnvelopeV2;

export interface DecodedPersistedMessageContent {
  content: string;
  rawContent?: ContentBlock[];
  envelope?: PersistedMessageEnvelope;
  contentEnvelope?: PersistedStructuredMessageEnvelopeV2;
  encoding: 'plain_text' | 'legacy_json_blocks' | 'envelope_v1' | 'envelope_v2';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTextBlock(block: unknown): block is Extract<ContentBlock, { type: 'text' }> {
  return (
    isRecord(block) &&
    block.type === 'text' &&
    typeof block.text === 'string' &&
    (!('providerMetadata' in block) || isRecord(block.providerMetadata))
  );
}

function isToolUseBlock(block: unknown): block is Extract<ContentBlock, { type: 'tool_use' }> {
  return (
    isRecord(block) &&
    block.type === 'tool_use' &&
    typeof block.id === 'string' &&
    typeof block.name === 'string' &&
    isRecord(block.input) &&
    (!('providerMetadata' in block) || isRecord(block.providerMetadata))
  );
}

function isToolResultBlock(
  block: unknown,
): block is Extract<ContentBlock, { type: 'tool_result' }> {
  return (
    isRecord(block) &&
    block.type === 'tool_result' &&
    typeof block.tool_use_id === 'string' &&
    typeof block.content === 'string' &&
    (!('is_error' in block) || typeof block.is_error === 'boolean')
  );
}

function isImageSource(
  source: unknown,
): source is Extract<Extract<ContentBlock, { type: 'image' }>['source'], object> {
  return (
    isRecord(source) &&
    ((source.type === 'base64' &&
      typeof source.media_type === 'string' &&
      typeof source.data === 'string') ||
      (source.type === 'url' && typeof source.url === 'string'))
  );
}

function isImageBlock(block: unknown): block is Extract<ContentBlock, { type: 'image' }> {
  return (
    isRecord(block) &&
    block.type === 'image' &&
    isImageSource(block.source) &&
    (!('attachmentId' in block) || typeof block.attachmentId === 'string')
  );
}

export function isContentBlockArray(value: unknown): value is ContentBlock[] {
  return (
    Array.isArray(value) &&
    value.every(
      (block) =>
        isTextBlock(block) ||
        isToolUseBlock(block) ||
        isToolResultBlock(block) ||
        isImageBlock(block),
    )
  );
}

function isPersistedMessageContentEnvelopeV1(
  value: unknown,
): value is PersistedMessageContentEnvelopeV1 {
  return (
    isRecord(value) &&
    value.version === 1 &&
    value.format === 'content_blocks' &&
    isContentBlockArray(value.blocks) &&
    typeof value.text === 'string'
  );
}

function isActionOption(
  value: unknown,
): value is NonNullable<ActionSetIR['elements'][number]['options']>[number] {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.label === 'string' &&
    (!('description' in value) || typeof value.description === 'string')
  );
}

function isActionElement(value: unknown): value is ActionSetIR['elements'][number] {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.type === 'button' || value.type === 'select' || value.type === 'input') &&
    typeof value.label === 'string' &&
    (!('value' in value) || typeof value.value === 'string') &&
    (!('description' in value) || typeof value.description === 'string') &&
    (!('options' in value) ||
      (Array.isArray(value.options) && value.options.every((option) => isActionOption(option)))) &&
    (!('input_type' in value) ||
      value.input_type === 'text' ||
      value.input_type === 'number' ||
      value.input_type === 'date' ||
      value.input_type === 'time' ||
      value.input_type === 'email') &&
    (!('placeholder' in value) || typeof value.placeholder === 'string') &&
    (!('required' in value) || typeof value.required === 'boolean')
  );
}

function isActionSetIR(value: unknown): value is ActionSetIR {
  return (
    isRecord(value) &&
    Array.isArray(value.elements) &&
    value.elements.every((element) => isActionElement(element)) &&
    (!('submit_label' in value) || typeof value.submit_label === 'string') &&
    (!('submit_id' in value) || typeof value.submit_id === 'string')
  );
}

function isPersistedMessageLocalizationOwnershipV1(
  value: unknown,
): value is PersistedMessageLocalizationOwnershipV1 {
  return (
    isRecord(value) &&
    (value.domain === 'project' || value.domain === 'platform') &&
    (!('locale' in value) || typeof value.locale === 'string') &&
    (!('fallbackLocale' in value) || typeof value.fallbackLocale === 'string') &&
    (!('messageKey' in value) || typeof value.messageKey === 'string') &&
    (!('catalogId' in value) || typeof value.catalogId === 'string')
  );
}

function isPersistedStructuredMessageEnvelopeV2(
  value: unknown,
): value is PersistedStructuredMessageEnvelopeV2 {
  return (
    isRecord(value) &&
    value.version === 2 &&
    value.format === 'message_envelope' &&
    typeof value.text === 'string' &&
    (!('blocks' in value) || value.blocks === undefined || isContentBlockArray(value.blocks)) &&
    (!('richContent' in value) || value.richContent === undefined || isRecord(value.richContent)) &&
    (!('actions' in value) || value.actions === undefined || isActionSetIR(value.actions)) &&
    (!('voiceConfig' in value) || value.voiceConfig === undefined || isRecord(value.voiceConfig)) &&
    (!('localization' in value) ||
      value.localization === undefined ||
      isPersistedMessageLocalizationOwnershipV1(value.localization))
  );
}

export function contentBlocksToText(blocks: ContentBlock[]): string {
  return blocks
    .flatMap((block) => {
      switch (block.type) {
        case 'text':
          return [block.text];
        case 'tool_result':
          return [block.content];
        default:
          return [];
      }
    })
    .join('\n')
    .trim();
}

export function createPersistedMessageContentEnvelope(
  blocks: ContentBlock[],
): PersistedMessageContentEnvelopeV1 {
  return {
    version: 1,
    format: 'content_blocks',
    blocks,
    text: contentBlocksToText(blocks),
  };
}

function hasEntries<T extends object>(value: T | undefined): value is T {
  return !!value && Object.keys(value).length > 0;
}

function hasActionElements(value: ActionSetIR | undefined): boolean {
  return (
    !!value &&
    (value.elements.length > 0 ||
      typeof value.submit_id === 'string' ||
      typeof value.submit_label === 'string')
  );
}

export function buildPersistedMessageStructuredContent(
  source: PersistedMessageStructuredContent | undefined,
): PersistedMessageStructuredContent | undefined {
  if (!source) {
    return undefined;
  }

  const structuredContent: PersistedMessageStructuredContent = {};
  if (source.blocks && source.blocks.length > 0) {
    structuredContent.blocks = source.blocks;
  }
  if (hasEntries(source.richContent)) {
    structuredContent.richContent = source.richContent;
  }
  if (hasActionElements(source.actions)) {
    structuredContent.actions = source.actions;
  }
  if (hasEntries(source.voiceConfig)) {
    structuredContent.voiceConfig = source.voiceConfig;
  }
  if (source.localization) {
    structuredContent.localization = source.localization;
  }

  return Object.keys(structuredContent).length > 0 ? structuredContent : undefined;
}

export function buildPersistedAssistantStructuredContent(
  source: PersistedAssistantStructuredContentSource,
): PersistedMessageStructuredContent | undefined {
  return buildPersistedMessageStructuredContent({
    richContent: source.richContent ?? undefined,
    actions: source.actions ?? undefined,
    voiceConfig: source.voiceConfig ?? undefined,
    localization: source.usedFallback ? undefined : source.localization,
  });
}

function normalizeStructuredEnvelopeText(
  envelope: PersistedStructuredMessageEnvelopeV2,
  fallbackText: string,
): PersistedStructuredMessageEnvelopeV2 {
  const derivedText =
    envelope.text.trim().length > 0
      ? envelope.text
      : envelope.blocks
        ? contentBlocksToText(envelope.blocks) || fallbackText
        : fallbackText;

  return derivedText === envelope.text ? envelope : { ...envelope, text: derivedText };
}

export function createPersistedStructuredMessageEnvelope(
  text: string,
  structuredContent: PersistedMessageStructuredContent,
): PersistedStructuredMessageEnvelopeV2 | null {
  const blocks =
    structuredContent.blocks && structuredContent.blocks.length > 0
      ? structuredContent.blocks
      : undefined;
  const richContent = hasEntries(structuredContent.richContent)
    ? structuredContent.richContent
    : undefined;
  const actions = hasActionElements(structuredContent.actions)
    ? structuredContent.actions
    : undefined;
  const voiceConfig = hasEntries(structuredContent.voiceConfig)
    ? structuredContent.voiceConfig
    : undefined;
  const localization = structuredContent.localization;

  if (!blocks && !richContent && !actions && !voiceConfig && !localization) {
    return null;
  }

  const normalizedText = text.trim().length > 0 ? text : blocks ? contentBlocksToText(blocks) : '';

  return {
    version: 2,
    format: 'message_envelope',
    text: normalizedText,
    ...(blocks ? { blocks } : {}),
    ...(richContent ? { richContent } : {}),
    ...(actions ? { actions } : {}),
    ...(voiceConfig ? { voiceConfig } : {}),
    ...(localization ? { localization } : {}),
  };
}

export function serializePersistedStructuredMessageEnvelope(
  text: string,
  structuredContent: PersistedMessageStructuredContent,
): string | undefined {
  const envelope = createPersistedStructuredMessageEnvelope(text, structuredContent);
  return envelope ? JSON.stringify(envelope) : undefined;
}

function decodeSerializedMessageEnvelope(
  serializedEnvelope: string,
  fallbackContent: string,
): DecodedPersistedMessageContent | null {
  try {
    const parsed = JSON.parse(serializedEnvelope) as unknown;

    if (isPersistedStructuredMessageEnvelopeV2(parsed)) {
      const envelope = normalizeStructuredEnvelopeText(parsed, fallbackContent);
      return {
        content: envelope.text || fallbackContent,
        ...(envelope.blocks ? { rawContent: envelope.blocks } : {}),
        envelope,
        contentEnvelope: envelope,
        encoding: 'envelope_v2',
      };
    }

    if (isPersistedMessageContentEnvelopeV1(parsed)) {
      const envelope =
        parsed.text.trim().length > 0
          ? parsed
          : {
              ...parsed,
              text: contentBlocksToText(parsed.blocks) || fallbackContent,
            };

      return {
        content: envelope.text || fallbackContent,
        rawContent: envelope.blocks,
        envelope,
        encoding: 'envelope_v1',
      };
    }
  } catch {
    // Invalid envelope payloads should gracefully fall back to the string content.
  }

  return null;
}

export function decodePersistedMessageContent(
  content: string,
  serializedEnvelope?: string | null,
): DecodedPersistedMessageContent {
  if (typeof serializedEnvelope === 'string' && serializedEnvelope.trim().length > 0) {
    const decodedEnvelope = decodeSerializedMessageEnvelope(serializedEnvelope, content);
    if (decodedEnvelope) {
      return decodedEnvelope;
    }
  }

  const trimmed = content.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
    return { content, encoding: 'plain_text' };
  }

  try {
    const parsed = JSON.parse(content) as unknown;

    if (isPersistedMessageContentEnvelopeV1(parsed)) {
      const envelope =
        parsed.text.trim().length > 0
          ? parsed
          : {
              ...parsed,
              text: contentBlocksToText(parsed.blocks),
            };

      return {
        content: envelope.text || content,
        rawContent: envelope.blocks,
        envelope,
        encoding: 'envelope_v1',
      };
    }

    if (isContentBlockArray(parsed)) {
      const envelope = createPersistedMessageContentEnvelope(parsed);
      return {
        content: envelope.text || content,
        rawContent: envelope.blocks,
        envelope,
        encoding: 'legacy_json_blocks',
      };
    }
  } catch {
    // Plain-text content that happens to begin with JSON punctuation should stay untouched.
  }

  return { content, encoding: 'plain_text' };
}

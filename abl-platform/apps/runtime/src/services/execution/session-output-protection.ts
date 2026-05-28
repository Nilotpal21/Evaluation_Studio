import type { ActionSetIR, RichContentIR, VoiceConfigIR } from '@abl/compiler';
import type { ContentBlock } from '@abl/compiler/platform/llm/types.js';
import type { PIIToken } from '@abl/compiler/platform/security/pii-vault.js';
import type { ExecutionResult, RuntimeSession } from './types.js';
import {
  createPersistedStructuredMessageEnvelope,
  type PersistedStructuredMessageEnvelopeV2,
} from '../session/persisted-message-content.js';
import { filterOutputPII } from './output-pii-filter.js';
import { getPIIAuditLogger } from './pii-audit-singleton.js';

export interface SessionOutputProtectionResult {
  deliveryText: string;
  historyText: string;
}

export interface StructuredOutputPayload {
  blocks?: ContentBlock[];
  richContent?: RichContentIR;
  actions?: ActionSetIR;
  voiceConfig?: VoiceConfigIR;
}

export interface StructuredOutputProtectionResult {
  delivery: StructuredOutputPayload;
  history: StructuredOutputPayload;
}

export interface ProtectedExecutionResultForUser {
  result: ExecutionResult;
  historyText: string;
  historyStructuredPayload: StructuredOutputPayload;
  historyContentEnvelope?: PersistedStructuredMessageEnvelopeV2;
}

export type SessionOutputProtectionContext = Pick<
  RuntimeSession,
  | 'id'
  | 'tenantId'
  | 'projectId'
  | 'piiRedactionConfig'
  | 'piiVault'
  | 'piiPatternConfigs'
  | 'piiRecognizerRegistry'
>;

export type SessionOutputEmissionContext = SessionOutputProtectionContext &
  Pick<RuntimeSession, 'conversationHistory'>;

export interface AssistantHistoryTargetEntry {
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
  contentEnvelope?: PersistedStructuredMessageEnvelopeV2;
}

const RICH_CONTENT_PRESERVED_STRING_KEYS = new Set([
  'url',
  'image_url',
  'thumbnail_url',
  'default_action_url',
  'icon_url',
  'mime_type',
  'align',
  'variant',
  'trend',
  'color',
  'type',
  'key',
]);

const ACTIONS_PRESERVED_STRING_KEYS = new Set([
  'id',
  'submit_id',
  'renderId',
  'value',
  'input_type',
  'type',
]);

const VOICE_CONFIG_PRESERVED_STRING_KEYS = new Set(['provider', 'voice_id']);

const CONTENT_BLOCK_PRESERVED_STRING_KEYS = new Set([
  'id',
  'name',
  'type',
  'tool_use_id',
  'attachmentId',
  'media_type',
  'url',
  'data',
]);

function hasStructuredPayload(payload: StructuredOutputPayload): boolean {
  return (
    (payload.blocks !== undefined && payload.blocks.length > 0) ||
    payload.richContent !== undefined ||
    payload.actions !== undefined ||
    payload.voiceConfig !== undefined
  );
}

export function shouldRedactRawOutputPII(
  session: Pick<RuntimeSession, 'piiRedactionConfig'>,
): boolean {
  return (
    session.piiRedactionConfig?.enabled === true && session.piiRedactionConfig.redactOutput === true
  );
}

function auditOutputTokenization(
  session: Pick<RuntimeSession, 'id' | 'tenantId' | 'projectId'>,
  tokens: PIIToken[],
): void {
  if (tokens.length === 0) {
    return;
  }

  const auditLogger = getPIIAuditLogger();
  for (const token of tokens) {
    auditLogger.log({
      tenantId: session.tenantId || '',
      projectId: session.projectId || '',
      sessionId: session.id,
      tokenId: token.id,
      piiType: token.type,
      consumer: 'user',
      action: 'tokenize',
    });
  }
}

export function protectSessionOutputForUser(
  session: SessionOutputProtectionContext,
  text: string,
): SessionOutputProtectionResult {
  if (!text) {
    return { deliveryText: text, historyText: text };
  }

  let deliveryText = text;
  let historyText = text;

  if (session.piiRedactionConfig?.enabled) {
    if (session.piiVault) {
      if (shouldRedactRawOutputPII(session)) {
        const tokenized = session.piiVault.tokenize(text, undefined, {
          confidenceThreshold: session.piiRedactionConfig.confidenceThreshold,
        });
        if (tokenized.tokens.length > 0) {
          historyText = tokenized.text;
          deliveryText = session.piiVault.renderForConsumer(
            tokenized.text,
            'user',
            session.piiPatternConfigs,
          );
          auditOutputTokenization(session, tokenized.tokens);
        } else if (text.includes('{{PII:')) {
          deliveryText = session.piiVault.renderForConsumer(
            text,
            'user',
            session.piiPatternConfigs,
          );
        }
      } else if (text.includes('{{PII:')) {
        deliveryText = session.piiVault.renderForConsumer(text, 'user', session.piiPatternConfigs);
      }
    } else if (shouldRedactRawOutputPII(session)) {
      const piiResult = filterOutputPII(text, session.piiRedactionConfig, {
        patternConfigs: session.piiPatternConfigs,
        recognizerRegistry: session.piiRecognizerRegistry,
      });
      if (piiResult.filtered) {
        deliveryText = piiResult.text;
        historyText = piiResult.text;
      }
    }
  }

  return {
    deliveryText,
    historyText,
  };
}

function protectStructuredValueForUser<T>(
  session: SessionOutputProtectionContext,
  value: T,
  preservedStringKeys: ReadonlySet<string>,
  currentKey?: string,
): { delivery: T; history: T } {
  if (typeof value === 'string') {
    if (currentKey && preservedStringKeys.has(currentKey)) {
      return { delivery: value as T, history: value as T };
    }

    const protectedText = protectSessionOutputForUser(session, value);
    return {
      delivery: protectedText.deliveryText as T,
      history: protectedText.historyText as T,
    };
  }

  if (Array.isArray(value)) {
    const delivery: unknown[] = [];
    const history: unknown[] = [];
    for (const item of value) {
      const protectedItem = protectStructuredValueForUser(
        session,
        item,
        preservedStringKeys,
        currentKey,
      );
      delivery.push(protectedItem.delivery);
      history.push(protectedItem.history);
    }
    return {
      delivery: delivery as T,
      history: history as T,
    };
  }

  if (value && typeof value === 'object') {
    const deliveryEntries: Array<[string, unknown]> = [];
    const historyEntries: Array<[string, unknown]> = [];

    for (const [key, nestedValue] of Object.entries(value)) {
      const protectedNestedValue = protectStructuredValueForUser(
        session,
        nestedValue,
        preservedStringKeys,
        key,
      );
      deliveryEntries.push([key, protectedNestedValue.delivery]);
      historyEntries.push([key, protectedNestedValue.history]);
    }

    return {
      delivery: Object.fromEntries(deliveryEntries) as T,
      history: Object.fromEntries(historyEntries) as T,
    };
  }

  return {
    delivery: value,
    history: value,
  };
}

function transformStructuredValue<T>(
  value: T,
  preservedStringKeys: ReadonlySet<string>,
  transformText: (text: string) => string,
  currentKey?: string,
): T {
  if (typeof value === 'string') {
    if (currentKey && preservedStringKeys.has(currentKey)) {
      return value;
    }

    return transformText(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      transformStructuredValue(item, preservedStringKeys, transformText, currentKey),
    ) as T;
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        transformStructuredValue(nestedValue, preservedStringKeys, transformText, key),
      ]),
    ) as T;
  }

  return value;
}

export function transformStructuredOutputPayload(
  payload: StructuredOutputPayload,
  transformText: (text: string) => string,
): StructuredOutputPayload {
  return {
    ...(payload.blocks
      ? {
          blocks: transformStructuredValue(
            payload.blocks,
            CONTENT_BLOCK_PRESERVED_STRING_KEYS,
            transformText,
          ),
        }
      : {}),
    ...(payload.richContent
      ? {
          richContent: transformStructuredValue(
            payload.richContent,
            RICH_CONTENT_PRESERVED_STRING_KEYS,
            transformText,
          ),
        }
      : {}),
    ...(payload.actions
      ? {
          actions: transformStructuredValue(
            payload.actions,
            ACTIONS_PRESERVED_STRING_KEYS,
            transformText,
          ),
        }
      : {}),
    ...(payload.voiceConfig
      ? {
          voiceConfig: transformStructuredValue(
            payload.voiceConfig,
            VOICE_CONFIG_PRESERVED_STRING_KEYS,
            transformText,
          ),
        }
      : {}),
  };
}

export function protectStructuredOutputForUser(
  session: SessionOutputProtectionContext,
  payload: StructuredOutputPayload,
): StructuredOutputProtectionResult {
  const protectedBlocks = payload.blocks
    ? protectStructuredValueForUser(session, payload.blocks, CONTENT_BLOCK_PRESERVED_STRING_KEYS)
    : undefined;
  const protectedRichContent = payload.richContent
    ? protectStructuredValueForUser(
        session,
        payload.richContent,
        RICH_CONTENT_PRESERVED_STRING_KEYS,
      )
    : undefined;
  const protectedActions = payload.actions
    ? protectStructuredValueForUser(session, payload.actions, ACTIONS_PRESERVED_STRING_KEYS)
    : undefined;
  const protectedVoiceConfig = payload.voiceConfig
    ? protectStructuredValueForUser(
        session,
        payload.voiceConfig,
        VOICE_CONFIG_PRESERVED_STRING_KEYS,
      )
    : undefined;

  return {
    delivery: {
      ...(protectedBlocks ? { blocks: protectedBlocks.delivery } : {}),
      ...(protectedRichContent ? { richContent: protectedRichContent.delivery } : {}),
      ...(protectedActions ? { actions: protectedActions.delivery } : {}),
      ...(protectedVoiceConfig ? { voiceConfig: protectedVoiceConfig.delivery } : {}),
    },
    history: {
      ...(protectedBlocks ? { blocks: protectedBlocks.history } : {}),
      ...(protectedRichContent ? { richContent: protectedRichContent.history } : {}),
      ...(protectedActions ? { actions: protectedActions.history } : {}),
      ...(protectedVoiceConfig ? { voiceConfig: protectedVoiceConfig.history } : {}),
    },
  };
}

export function protectExecutionResultForUser(
  session: SessionOutputProtectionContext,
  result: ExecutionResult,
): ProtectedExecutionResultForUser {
  const protectedText = protectSessionOutputForUser(session, result.response);
  const protectedStructuredPayload = protectStructuredOutputForUser(session, {
    richContent: result.richContent,
    voiceConfig: result.voiceConfig,
    actions: result.actions,
  });

  const action =
    typeof result.action.message === 'string' && result.action.message === result.response
      ? {
          ...result.action,
          message: protectedText.deliveryText,
        }
      : result.action;
  const historyContentEnvelope = hasStructuredPayload(protectedStructuredPayload.history)
    ? (createPersistedStructuredMessageEnvelope(protectedText.historyText, {
        ...(protectedStructuredPayload.history.blocks !== undefined
          ? { blocks: protectedStructuredPayload.history.blocks }
          : {}),
        ...(protectedStructuredPayload.history.richContent !== undefined
          ? { richContent: protectedStructuredPayload.history.richContent }
          : {}),
        ...(protectedStructuredPayload.history.actions !== undefined
          ? { actions: protectedStructuredPayload.history.actions }
          : {}),
        ...(protectedStructuredPayload.history.voiceConfig !== undefined
          ? { voiceConfig: protectedStructuredPayload.history.voiceConfig }
          : {}),
      }) ?? undefined)
    : undefined;

  return {
    result: {
      ...result,
      response: protectedText.deliveryText,
      action,
      richContent: protectedStructuredPayload.delivery.richContent,
      voiceConfig: protectedStructuredPayload.delivery.voiceConfig,
      actions: protectedStructuredPayload.delivery.actions,
    },
    historyText: protectedText.historyText,
    historyStructuredPayload: protectedStructuredPayload.history,
    ...(historyContentEnvelope ? { historyContentEnvelope } : {}),
  };
}

export function emitProtectedExecutionResult(
  session: SessionOutputEmissionContext,
  result: ExecutionResult,
  onChunk?: (chunk: string) => void,
  options: {
    chunkText?: string;
  } = {},
): ProtectedExecutionResultForUser {
  const protectedResult = protectExecutionResultForUser(session, result);
  if (protectedResult.result.response && onChunk) {
    onChunk(options.chunkText ?? protectedResult.result.response);
  }
  if (protectedResult.historyText) {
    session.conversationHistory.push({
      role: 'assistant',
      content: protectedResult.historyText,
      ...(protectedResult.historyContentEnvelope
        ? { contentEnvelope: protectedResult.historyContentEnvelope }
        : {}),
    });
  } else if (protectedResult.historyContentEnvelope) {
    session.conversationHistory.push({
      role: 'assistant',
      content: '',
      contentEnvelope: protectedResult.historyContentEnvelope,
    });
  }
  return protectedResult;
}

export function emitProtectedAssistantMessage(
  session: SessionOutputProtectionContext,
  text: string,
  options: {
    onChunk?: (chunk: string) => void;
    chunkText?: string;
    historyTarget?: AssistantHistoryTargetEntry[];
    historyTextFormatter?: (historyText: string) => string;
    historyMetadata?: Record<string, unknown>;
  } = {},
): SessionOutputProtectionResult {
  const protectedText = protectSessionOutputForUser(session, text);
  if (protectedText.deliveryText && options.onChunk) {
    options.onChunk(options.chunkText ?? protectedText.deliveryText);
  }
  if (protectedText.historyText && options.historyTarget) {
    options.historyTarget.push({
      role: 'assistant',
      content: options.historyTextFormatter
        ? options.historyTextFormatter(protectedText.historyText)
        : protectedText.historyText,
      ...(options.historyMetadata ? { metadata: options.historyMetadata } : {}),
    });
  }
  return protectedText;
}

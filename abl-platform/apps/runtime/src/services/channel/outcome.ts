import type {
  RuntimeSession,
  ExecutionResult,
  ExecutionOutputMessage,
} from '../execution/types.js';
import type { AuthRequirement } from '../../types/index.js';
import type { ResponseMessageMetadata } from './response-provenance.js';
import {
  getChannelBehaviorContract,
  getChannelTypesByBehaviorProfile,
} from '../../channels/channel-behavior-contract.js';
import { getChannelManifest } from '../../channels/manifest.js';
import { AUTH_PREFLIGHT_REQUIRED_CODE } from '../auth-profile/auth-contract.js';
import { PLATFORM_MESSAGES } from './constants.js';
import {
  buildRuntimeErrorEnvelope,
  type RuntimeErrorEnvelope,
} from '../execution/runtime-error-envelope.js';

type SessionDiagnostics = Pick<RuntimeSession, 'toolWarnings' | 'sessionHealth'>;
type RichContentPayload = NonNullable<ExecutionResult['richContent']>;
type RichContentPayloadType = keyof RichContentPayload;

const WEB_NATIVE_RICH_CONTENT_TYPES = [
  'markdown',
  'html',
  'carousel',
  'quick_replies',
  'list',
  'image',
  'video',
  'audio',
  'file',
  'kpi',
  'table',
  'chart',
  'form',
  'progress',
  'feedback',
] as const satisfies ReadonlyArray<RichContentPayloadType>;

const CHANNEL_NATIVE_RICH_CONTENT_TYPES = [
  'adaptive_card',
  'slack',
  'ag_ui',
  'whatsapp',
] as const satisfies ReadonlyArray<RichContentPayloadType>;

const PREVIEW_KEYS = [
  'text',
  'response',
  'message',
  'content',
  'answer',
  'summary',
  'title',
  'subtitle',
  'label',
  'prompt',
  'description',
  'alt',
  'altText',
  'speak',
] as const;

const MAX_PREVIEW_SEGMENTS = 3;
const MAX_PREVIEW_LENGTH = 160;

const CHANNEL_NATIVE_SUMMARY_SURFACES = new Set<string>([
  ...getChannelTypesByBehaviorProfile('sdk_chat'),
  ...getChannelTypesByBehaviorProfile('http_sync'),
  ...getChannelTypesByBehaviorProfile('studio_debug'),
]);

const STRUCTURED_RESPONSE_SUMMARY_SURFACES = new Set<string>([
  ...getChannelTypesByBehaviorProfile('sdk_chat'),
  ...getChannelTypesByBehaviorProfile('studio_debug'),
]);

export type ChannelOutcomeStatus = 'ok' | 'auth_required' | 'timeout' | 'empty_response' | 'error';

export interface ChannelDiagnostic {
  source: 'session_health' | 'tool_warning' | 'outcome' | 'voice_turn_coordinator';
  category: string;
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  errorEnvelope?: RuntimeErrorEnvelope;
}

export interface ChannelOutcome {
  status: ChannelOutcomeStatus;
  responseText: string;
  usedFallback: boolean;
  diagnostics: ChannelDiagnostic[];
  responseMetadata?: ResponseMessageMetadata;
  action?: ExecutionResult['action'];
  voiceConfig?: ExecutionResult['voiceConfig'];
  richContent?: ExecutionResult['richContent'];
  actions?: ExecutionResult['actions'];
  localization?: ExecutionResult['localization'];
  outputMessages?: ExecutionOutputMessage[];
  finalOutputMessageId?: string;
  auth?: {
    pending: AuthRequirement[];
    satisfied: AuthRequirement[];
  };
}

export interface PublicChannelOutcome {
  status: ChannelOutcomeStatus;
  usedFallback: boolean;
  auth?: {
    pending: AuthRequirement[];
    satisfied: AuthRequirement[];
  };
}

export interface ChannelTraceEvent {
  type: 'warning' | 'error';
  data: {
    code: string;
    message: string;
    category: string;
    source: 'channel_outcome';
    errorEnvelope?: RuntimeErrorEnvelope;
  };
}

type ChannelAudience = 'interactive' | 'api' | 'webhook' | 'messaging' | 'voice';

interface BuildExecutionOutcomeParams {
  channelType: string;
  result: Pick<
    ExecutionResult,
    | 'response'
    | 'responseMetadata'
    | 'action'
    | 'voiceConfig'
    | 'richContent'
    | 'actions'
    | 'localization'
    | 'outputMessages'
    | 'finalOutputMessageId'
  >;
  streamedText?: string;
  session?: SessionDiagnostics;
  additionalDiagnostics?: ChannelDiagnostic[];
}

interface BuildAuthRequiredOutcomeParams {
  channelType: string;
  pending: AuthRequirement[];
  satisfied?: AuthRequirement[];
  session?: SessionDiagnostics;
  additionalDiagnostics?: ChannelDiagnostic[];
}

interface BuildErrorOutcomeParams {
  channelType: string;
  error: unknown;
  session?: SessionDiagnostics;
  additionalDiagnostics?: ChannelDiagnostic[];
  traceId?: string;
  agentName?: string;
  toolName?: string;
}

export class ChannelExecutionTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly code = 'CHANNEL_EXECUTION_TIMEOUT';

  constructor(timeoutMs: number) {
    super(`Execution timed out after ${timeoutMs}ms`);
    this.name = 'ChannelExecutionTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

function resolveChannelAudience(channelType: string): ChannelAudience {
  if (channelType === 'http_async') {
    return 'webhook';
  }

  const manifest = getChannelManifest(channelType);
  if (manifest?.isVoice) {
    return 'voice';
  }

  if (manifest?.delivery === 'websocket') {
    return 'interactive';
  }

  if (manifest?.delivery === 'sync_response') {
    return channelType === 'api' || channelType === 'http' ? 'api' : 'messaging';
  }

  if (manifest?.delivery === 'async_queue' || manifest?.delivery === 'direct_send') {
    return 'messaging';
  }

  return 'interactive';
}

function truncatePreview(value: string): string {
  if (value.length <= MAX_PREVIEW_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_PREVIEW_LENGTH - 1)}…`;
}

function looksLikeStructuredPayload(value: string): boolean {
  return value.startsWith('{') || value.startsWith('[');
}

function collectPreviewSegments(
  value: unknown,
  segments: string[],
  allowPlainString: boolean = false,
): void {
  if (segments.length >= MAX_PREVIEW_SEGMENTS || value === null || value === undefined) {
    return;
  }

  if (typeof value === 'string') {
    const normalized = value.trim();
    if (allowPlainString && normalized) {
      segments.push(normalized);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectPreviewSegments(item, segments, allowPlainString);
      if (segments.length >= MAX_PREVIEW_SEGMENTS) {
        return;
      }
    }
    return;
  }

  if (typeof value !== 'object') {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const allowChildString = PREVIEW_KEYS.includes(key as (typeof PREVIEW_KEYS)[number]);

    if (allowChildString && typeof child === 'string' && child.trim()) {
      segments.push(child.trim());
      if (segments.length >= MAX_PREVIEW_SEGMENTS) {
        return;
      }
      continue;
    }

    collectPreviewSegments(child, segments, allowChildString);
    if (segments.length >= MAX_PREVIEW_SEGMENTS) {
      return;
    }
  }
}

function extractStructuredTextPreview(payload: string): string | undefined {
  const trimmed = payload.trim();
  if (!trimmed) {
    return undefined;
  }

  if (!looksLikeStructuredPayload(trimmed)) {
    return truncatePreview(trimmed);
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const segments: string[] = [];
    collectPreviewSegments(parsed, segments);
    if (segments.length > 0) {
      return truncatePreview(segments.join(' • '));
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function getFallbackText(
  channelType: string,
  kind: 'empty_response' | 'timeout' | 'auth_required' | 'error',
): string {
  const audience = resolveChannelAudience(channelType);

  switch (kind) {
    case 'empty_response':
      return audience === 'api' || audience === 'interactive'
        ? PLATFORM_MESSAGES.EMPTY_RESPONSE_DIAGNOSTIC
        : PLATFORM_MESSAGES.EMPTY_RESPONSE_FALLBACK;
    case 'timeout':
      return audience === 'api' || audience === 'interactive'
        ? PLATFORM_MESSAGES.EXECUTION_TIMEOUT_DIAGNOSTIC
        : PLATFORM_MESSAGES.EXECUTION_TIMEOUT_FALLBACK;
    case 'auth_required':
      return audience === 'api' || audience === 'interactive'
        ? PLATFORM_MESSAGES.AUTH_REQUIRED_DIAGNOSTIC
        : PLATFORM_MESSAGES.AUTH_REQUIRED_FALLBACK;
    case 'error':
    default:
      return audience === 'api' || audience === 'interactive'
        ? PLATFORM_MESSAGES.EXECUTION_FAILED_DIAGNOSTIC
        : PLATFORM_MESSAGES.EXECUTION_FAILED_FALLBACK;
  }
}

function buildAuthDiagnosticMessage(pending: AuthRequirement[]): string {
  const labels = pending
    .map((requirement) => requirement.connector || requirement.authProfileRef)
    .filter((label) => label.trim().length > 0);
  if (labels.length === 0) {
    return PLATFORM_MESSAGES.AUTH_REQUIRED_DIAGNOSTIC;
  }
  return `Authorization is required before the agent can continue: ${labels.join(', ')}.`;
}

function hasRichContentValue(
  type: RichContentPayloadType,
  value: RichContentPayload[RichContentPayloadType],
): boolean {
  if (value === undefined || value === null) {
    return false;
  }

  if (typeof value === 'string') {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (type === 'carousel') {
    return (
      typeof value === 'object' &&
      value !== null &&
      'cards' in value &&
      Array.isArray(value.cards) &&
      value.cards.length > 0
    );
  }

  return true;
}

function hasAnyRichContentPayload(richContent?: ExecutionResult['richContent']): boolean {
  if (!richContent) {
    return false;
  }

  return [...WEB_NATIVE_RICH_CONTENT_TYPES, ...CHANNEL_NATIVE_RICH_CONTENT_TYPES].some((type) =>
    hasRichContentValue(type, richContent[type]),
  );
}

function hasRichContentForTypes(
  richContent: ExecutionResult['richContent'],
  types: readonly RichContentPayloadType[],
): boolean {
  if (!richContent) {
    return false;
  }

  return types.some((type) => hasRichContentValue(type, richContent[type]));
}

function hasActionSetPayload(actions?: ExecutionResult['actions']): boolean {
  return Array.isArray(actions?.elements) && actions.elements.length > 0;
}

export function hasRenderableChannelOutcome(
  outcome: Pick<ChannelOutcome, 'responseText' | 'richContent' | 'actions' | 'voiceConfig'>,
): boolean {
  return (
    outcome.responseText.trim().length > 0 ||
    hasAnyRichContentPayload(outcome.richContent) ||
    hasActionSetPayload(outcome.actions) ||
    outcome.voiceConfig !== undefined
  );
}

function buildChannelNativeRichContentSummary(
  richContent?: ExecutionResult['richContent'],
): string | undefined {
  if (!richContent) {
    return undefined;
  }

  const segments: string[] = [];

  for (const type of CHANNEL_NATIVE_RICH_CONTENT_TYPES) {
    const payload = richContent[type];
    if (typeof payload !== 'string' || payload.trim().length === 0) {
      continue;
    }

    const preview = extractStructuredTextPreview(payload);
    if (preview) {
      segments.push(preview);
    }

    if (segments.length >= MAX_PREVIEW_SEGMENTS) {
      break;
    }
  }

  if (segments.length === 0) {
    return undefined;
  }

  return truncatePreview(segments.join(' • '));
}

function normalizeChannelNativeResponse(
  params: BuildExecutionOutcomeParams,
  responseText: string,
  diagnostics: ChannelDiagnostic[],
): { responseText: string; usedFallback: boolean } {
  if (responseText.trim().length > 0 || !CHANNEL_NATIVE_SUMMARY_SURFACES.has(params.channelType)) {
    return { responseText, usedFallback: false };
  }

  const hasWebNativeRichContent = hasRichContentForTypes(
    params.result.richContent,
    WEB_NATIVE_RICH_CONTENT_TYPES,
  );
  const hasChannelNativeRichContent = hasRichContentForTypes(
    params.result.richContent,
    CHANNEL_NATIVE_RICH_CONTENT_TYPES,
  );

  if (!hasChannelNativeRichContent || hasWebNativeRichContent) {
    return { responseText, usedFallback: false };
  }

  diagnostics.push({
    source: 'outcome',
    category: 'response',
    severity: 'warning',
    code: 'CHANNEL_NATIVE_CONTENT_SUMMARY',
    message: PLATFORM_MESSAGES.CHANNEL_NATIVE_CONTENT_SUMMARY_DIAGNOSTIC,
  });

  return {
    responseText:
      buildChannelNativeRichContentSummary(params.result.richContent) ??
      PLATFORM_MESSAGES.CHANNEL_NATIVE_CONTENT_SUMMARY_FALLBACK,
    usedFallback: true,
  };
}

function normalizeStructuredResponseText(
  params: BuildExecutionOutcomeParams,
  responseText: string,
  diagnostics: ChannelDiagnostic[],
): { responseText: string; usedFallback: boolean } {
  const trimmed = responseText.trim();
  if (
    trimmed.length === 0 ||
    !STRUCTURED_RESPONSE_SUMMARY_SURFACES.has(params.channelType) ||
    !looksLikeStructuredPayload(trimmed)
  ) {
    return { responseText, usedFallback: false };
  }

  const preview = extractStructuredTextPreview(trimmed);
  if (!preview || preview === trimmed) {
    return { responseText, usedFallback: false };
  }

  diagnostics.push({
    source: 'outcome',
    category: 'response',
    severity: 'warning',
    code: 'STRUCTURED_RESPONSE_SUMMARY',
    message: PLATFORM_MESSAGES.STRUCTURED_RESPONSE_SUMMARY_DIAGNOSTIC,
  });

  return {
    responseText: preview,
    usedFallback: true,
  };
}

export function collectChannelDiagnostics(
  session?: SessionDiagnostics,
  additionalDiagnostics?: ChannelDiagnostic[],
): ChannelDiagnostic[] {
  const diagnostics: ChannelDiagnostic[] = [...(additionalDiagnostics ?? [])];

  for (const warning of session?.toolWarnings ?? []) {
    diagnostics.push({
      source: 'tool_warning',
      category: 'tool',
      severity: 'warning',
      code: 'TOOL_WARNING',
      message: warning,
    });
  }

  for (const entry of session?.sessionHealth ?? []) {
    diagnostics.push({
      source: 'session_health',
      category: entry.category,
      severity: entry.severity,
      code: entry.code,
      message: entry.message,
    });
  }

  return diagnostics;
}

function hasRenderableExecutionPayload(
  params: BuildExecutionOutcomeParams,
  responseText: string,
): boolean {
  const contract = getChannelBehaviorContract(params.channelType);
  const hasText = responseText.trim().length > 0;
  const hasRichContent = hasAnyRichContentPayload(params.result.richContent);
  const hasActions = hasActionSetPayload(params.result.actions);
  const hasVoiceConfig =
    params.result.voiceConfig !== undefined && (contract?.voiceConfig ?? 'full') !== 'ignored';

  switch (contract?.richContent) {
    case 'actions_only':
      return hasText || hasActions || hasVoiceConfig;
    case 'text_only':
      return hasText || hasVoiceConfig;
    case 'full':
    case 'structured_passthrough':
    case undefined:
    default:
      return hasText || hasRichContent || hasActions || hasVoiceConfig;
  }
}

function getFinalOutputMessageText(
  outputMessages: ExecutionOutputMessage[] | undefined,
  finalOutputMessageId: string | undefined,
): string | undefined {
  if (!outputMessages?.length) return undefined;

  const explicitFinal =
    finalOutputMessageId !== undefined
      ? outputMessages.find((message) => message.id === finalOutputMessageId)
      : undefined;
  if (explicitFinal?.text.trim()) return explicitFinal.text;

  const finalPhase = [...outputMessages]
    .reverse()
    .find((message) => message.phase === 'final' && message.text.trim().length > 0);
  if (finalPhase) return finalPhase.text;

  return [...outputMessages]
    .reverse()
    .find((message) => message.persistToTranscript && message.text.trim().length > 0)?.text;
}

export function buildExecutionOutcome(params: BuildExecutionOutcomeParams): ChannelOutcome {
  const diagnostics = collectChannelDiagnostics(params.session, params.additionalDiagnostics);
  const finalOutputMessageText = getFinalOutputMessageText(
    params.result.outputMessages,
    params.result.finalOutputMessageId,
  );
  const responseBasis =
    finalOutputMessageText ??
    (params.result.response.trim().length > 0
      ? params.result.response
      : (params.streamedText ?? params.result.response ?? ''));
  const structuredResponse = normalizeStructuredResponseText(params, responseBasis, diagnostics);
  const normalizedResponse = normalizeChannelNativeResponse(
    params,
    structuredResponse.responseText,
    diagnostics,
  );
  const responseText = normalizedResponse.responseText;
  const hasRenderablePayload = hasRenderableExecutionPayload(params, responseText);

  if (!hasRenderablePayload) {
    diagnostics.push({
      source: 'outcome',
      category: 'response',
      severity: 'error',
      code: 'EMPTY_RESPONSE',
      message: PLATFORM_MESSAGES.EMPTY_RESPONSE_DIAGNOSTIC,
    });

    return {
      status: 'empty_response',
      responseText: getFallbackText(params.channelType, 'empty_response'),
      usedFallback: true,
      diagnostics,
      responseMetadata: params.result.responseMetadata,
      action: params.result.action,
      voiceConfig: params.result.voiceConfig,
      richContent: params.result.richContent,
      actions: params.result.actions,
      localization: params.result.localization,
      outputMessages: params.result.outputMessages,
      finalOutputMessageId: params.result.finalOutputMessageId,
    };
  }

  return {
    status: 'ok',
    responseText,
    usedFallback: structuredResponse.usedFallback || normalizedResponse.usedFallback,
    diagnostics,
    responseMetadata: params.result.responseMetadata,
    action: params.result.action,
    voiceConfig: params.result.voiceConfig,
    richContent: params.result.richContent,
    actions: params.result.actions,
    localization: params.result.localization,
    outputMessages: params.result.outputMessages,
    finalOutputMessageId: params.result.finalOutputMessageId,
  };
}

export function buildAuthRequiredOutcome(params: BuildAuthRequiredOutcomeParams): ChannelOutcome {
  const diagnostics = collectChannelDiagnostics(params.session, params.additionalDiagnostics);
  diagnostics.push({
    source: 'outcome',
    category: 'auth',
    severity: 'error',
    code: AUTH_PREFLIGHT_REQUIRED_CODE,
    message: buildAuthDiagnosticMessage(params.pending),
  });

  return {
    status: 'auth_required',
    responseText: getFallbackText(params.channelType, 'auth_required'),
    usedFallback: true,
    diagnostics,
    auth: {
      pending: [...params.pending],
      satisfied: [...(params.satisfied ?? [])],
    },
  };
}

export function buildErrorOutcome(params: BuildErrorOutcomeParams): ChannelOutcome {
  const diagnostics = collectChannelDiagnostics(params.session, params.additionalDiagnostics);
  const isTimeout =
    params.error instanceof ChannelExecutionTimeoutError ||
    (params.error instanceof Error && params.error.name === 'AbortError');
  const errorEnvelope = isTimeout
    ? undefined
    : buildRuntimeErrorEnvelope(params.error, {
        traceId: params.traceId,
        agentName: params.agentName,
        toolName: params.toolName,
      });

  diagnostics.push({
    source: 'outcome',
    category: isTimeout ? 'timeout' : (errorEnvelope?.category ?? 'execution'),
    severity: 'error',
    code: isTimeout ? 'EXECUTION_TIMEOUT' : (errorEnvelope?.code ?? 'EXECUTION_FAILED'),
    message: isTimeout
      ? PLATFORM_MESSAGES.EXECUTION_TIMEOUT_DIAGNOSTIC
      : (errorEnvelope?.operator_hint ??
        'The runtime failed before a classified diagnostic was available. Check server logs and surrounding trace events for the raw exception.'),
    ...(errorEnvelope ? { errorEnvelope } : {}),
  });

  return {
    status: isTimeout ? 'timeout' : 'error',
    responseText:
      errorEnvelope?.customer_message ??
      getFallbackText(params.channelType, isTimeout ? 'timeout' : 'error'),
    usedFallback: true,
    diagnostics,
  };
}

export function buildChannelTraceEvent(params: {
  severity: 'warning' | 'error';
  code: string;
  message: string;
  category: string;
  errorEnvelope?: RuntimeErrorEnvelope;
}): ChannelTraceEvent {
  return {
    type: params.severity === 'error' ? 'error' : 'warning',
    data: {
      code: params.code,
      message: params.message,
      category: params.category,
      source: 'channel_outcome',
      ...(params.errorEnvelope ? { errorEnvelope: params.errorEnvelope } : {}),
    },
  };
}

export function buildOutcomeTraceEvent(outcome: ChannelOutcome): ChannelTraceEvent | undefined {
  const diagnostic = [...outcome.diagnostics].reverse().find((entry) => entry.source === 'outcome');
  if (!diagnostic) {
    return undefined;
  }

  return buildChannelTraceEvent({
    severity: diagnostic.severity === 'warning' ? 'warning' : 'error',
    code: diagnostic.code,
    message: diagnostic.message,
    category: diagnostic.category,
    ...(diagnostic.errorEnvelope ? { errorEnvelope: diagnostic.errorEnvelope } : {}),
  });
}

export function toPublicChannelOutcome(outcome: ChannelOutcome): PublicChannelOutcome {
  if (!outcome.auth) {
    return {
      status: outcome.status,
      usedFallback: outcome.usedFallback,
    };
  }

  return {
    status: outcome.status,
    usedFallback: outcome.usedFallback,
    auth: {
      pending: [...outcome.auth.pending],
      satisfied: [...outcome.auth.satisfied],
    },
  };
}

export async function runWithExecutionTimeout<T>(
  execute: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  options?: { signal?: AbortSignal },
): Promise<T> {
  const timeoutController = new AbortController();

  const abortFromParent = () => {
    if (!timeoutController.signal.aborted) {
      timeoutController.abort(
        options?.signal?.reason instanceof Error
          ? options.signal.reason
          : new Error('Execution aborted'),
      );
    }
  };

  if (options?.signal) {
    if (options.signal.aborted) {
      abortFromParent();
    } else {
      options.signal.addEventListener('abort', abortFromParent, { once: true });
    }
  }

  const timeoutHandle = setTimeout(() => {
    if (!timeoutController.signal.aborted) {
      timeoutController.abort(new ChannelExecutionTimeoutError(timeoutMs));
    }
  }, timeoutMs);

  const abortPromise = new Promise<never>((_, reject) => {
    timeoutController.signal.addEventListener(
      'abort',
      () => {
        const reason = timeoutController.signal.reason;
        reject(reason instanceof Error ? reason : new ChannelExecutionTimeoutError(timeoutMs));
      },
      { once: true },
    );
  });

  try {
    return await Promise.race([execute(timeoutController.signal), abortPromise]);
  } finally {
    clearTimeout(timeoutHandle);
    if (options?.signal) {
      options.signal.removeEventListener('abort', abortFromParent);
    }
  }
}

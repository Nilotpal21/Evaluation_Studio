import { scrubTraceEvent } from '../constructs/executors/trace-scrubber.js';
import { scrubSecrets, SENSITIVE_HEADER_NAMES } from '../constructs/executors/scrub-patterns.js';
import type { PIIConsumer, PIIPatternConfig, PIIRenderMode, PIIVault } from './pii-vault.js';
import { getPIIRedactLabel, type PIIType } from './pii-detector.js';

export type PIIBoundaryConsumer =
  | 'session_read'
  | 'pipeline_read'
  | 'pipeline_llm'
  | 'pipeline_action'
  | PIIConsumer
  | (string & {});

export interface PIIRedactionBoundaryConfig {
  enabled: boolean;
  redactInput?: boolean;
  redactOutput?: boolean;
  confidenceThreshold?: number;
}

export interface PIIBoundaryContext {
  piiRedactionConfig?: PIIRedactionBoundaryConfig;
  piiVault?: PIIVault;
  piiPatternConfigs?: PIIPatternConfig[];
}

export interface PIIBoundaryRenderOptions {
  consumer: PIIBoundaryConsumer;
  role?: string;
}

export interface PIIBoundaryMessage {
  role?: string;
  content: string;
  rawContent?: unknown;
  contentEnvelope?: unknown;
  metadata?: unknown;
}

export interface PIIBoundaryTraceEvent {
  data?: unknown;
}

const ORIGINAL_RENDER_MODE: PIIRenderMode = 'original';
const REDACTED_RENDER_MODE: PIIRenderMode = 'redacted';
const TOKENIZED_RENDER_MODE: PIIRenderMode = 'tokenized';
const PII_TOKEN_MARKER_REGEX = /\{\{PII:([A-Za-z0-9_:-]+):([a-f0-9-]+)\}\}/g;
const READ_SURFACE_SECRET_KEY_NAMES: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'pass',
  'secret',
  'secret_key',
  'secretkey',
  'api_key',
  'apikey',
  'api_secret',
  'apisecret',
  'token',
  'access_token',
  'accesstoken',
  'refresh_token',
  'credential',
  'credentials',
  'private_key',
  'privatekey',
  'client_secret',
  'clientsecret',
  'authorization',
  'auth_token',
  'authtoken',
]);

function hasPIITokenMarker(value: string): boolean {
  PII_TOKEN_MARKER_REGEX.lastIndex = 0;
  return PII_TOKEN_MARKER_REGEX.test(value);
}

function replaceUnresolvedPIITokens(value: string): string {
  PII_TOKEN_MARKER_REGEX.lastIndex = 0;
  return value.replace(PII_TOKEN_MARKER_REGEX, (_match, type: string) =>
    getPIIRedactLabel(type as PIIType),
  );
}

function shouldPreserveUnresolvedPIITokens(consumer: PIIBoundaryConsumer): boolean {
  return consumer === 'llm' || consumer === 'pipeline_llm' || consumer === 'pipeline_read';
}

function resolveVaultConsumer(consumer: PIIBoundaryConsumer): PIIConsumer | string {
  if (consumer === 'pipeline_llm' || consumer === 'pipeline_read') {
    return 'llm';
  }
  if (consumer === 'pipeline_action') {
    return 'logs';
  }
  return consumer;
}

function hasPIIPolicy(context?: PIIBoundaryContext): boolean {
  return context?.piiRedactionConfig !== undefined;
}

function isSecretKey(key?: string): boolean {
  if (!key) {
    return false;
  }
  const normalized = key.toLowerCase();
  return SENSITIVE_HEADER_NAMES.has(normalized) || READ_SURFACE_SECRET_KEY_NAMES.has(normalized);
}

function normalizeBoundaryRenderMode(
  consumer: PIIBoundaryConsumer,
  renderMode: PIIRenderMode,
): PIIRenderMode {
  if (consumer === 'llm' || consumer === 'pipeline_llm' || consumer === 'pipeline_read') {
    return TOKENIZED_RENDER_MODE;
  }
  if (consumer === 'session_read' || consumer === 'pipeline_action') {
    return renderMode === ORIGINAL_RENDER_MODE ? REDACTED_RENDER_MODE : renderMode;
  }
  return renderMode;
}

function resolveBoundaryPatternConfigs(
  patternConfigs: PIIPatternConfig[] | undefined,
  consumer: PIIBoundaryConsumer,
): PIIPatternConfig[] | undefined {
  if (!patternConfigs || patternConfigs.length === 0) {
    return patternConfigs;
  }

  return patternConfigs.map((config) => {
    const consumerRule = config.consumerAccess.find((rule) => rule.consumer === consumer);
    const userRule = config.consumerAccess.find((rule) => rule.consumer === 'user');
    const normalizedDefault = normalizeBoundaryRenderMode(consumer, config.defaultRenderMode);
    const consumerAccess = config.consumerAccess.map((rule) =>
      rule.consumer === consumer
        ? { ...rule, renderMode: normalizeBoundaryRenderMode(consumer, rule.renderMode) }
        : rule,
    );

    if (!consumerRule) {
      consumerAccess.push({
        consumer,
        renderMode: userRule
          ? normalizeBoundaryRenderMode(consumer, userRule.renderMode)
          : normalizedDefault,
      });
    }

    return {
      ...config,
      defaultRenderMode: normalizedDefault,
      consumerAccess,
    };
  });
}

function shouldApplyVaultRedaction(
  context: PIIBoundaryContext | undefined,
  role?: string,
  value?: string,
): boolean {
  if (!context?.piiRedactionConfig?.enabled || !context.piiVault) {
    return false;
  }
  if (value && hasPIITokenMarker(value)) {
    return true;
  }
  if (role === 'user') {
    return context.piiRedactionConfig.redactInput !== false;
  }
  if (role === 'assistant') {
    return context.piiRedactionConfig.redactOutput !== false;
  }
  return (
    context.piiRedactionConfig.redactInput !== false ||
    context.piiRedactionConfig.redactOutput !== false
  );
}

function renderTextForPIIBoundary(
  value: string,
  context: PIIBoundaryContext | undefined,
  options: PIIBoundaryRenderOptions,
): string {
  const text = hasPIIPolicy(context)
    ? (scrubSecrets(value) as string)
    : ((scrubTraceEvent({ value }).value as string | undefined) ?? value);

  if (!shouldApplyVaultRedaction(context, options.role, text)) {
    return shouldPreserveUnresolvedPIITokens(options.consumer)
      ? text
      : replaceUnresolvedPIITokens(text);
  }

  const tokenized = context!.piiVault!.tokenize(text, undefined, {
    confidenceThreshold: context!.piiRedactionConfig?.confidenceThreshold,
  });
  const vaultConsumer = resolveVaultConsumer(options.consumer);
  const rendered = context!.piiVault!.renderForConsumer(
    tokenized.tokens.length > 0 ? tokenized.text : text,
    vaultConsumer,
    resolveBoundaryPatternConfigs(context!.piiPatternConfigs, vaultConsumer),
  );

  return shouldPreserveUnresolvedPIITokens(options.consumer)
    ? rendered
    : replaceUnresolvedPIITokens(rendered);
}

function renderUnknownValueForPIIBoundary<T>(
  value: T,
  context: PIIBoundaryContext | undefined,
  options: PIIBoundaryRenderOptions,
  key?: string,
): T {
  if (isSecretKey(key)) {
    return '[REDACTED]' as T;
  }
  if (typeof value === 'string') {
    return renderTextForPIIBoundary(value, context, options) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderUnknownValueForPIIBoundary(item, context, options)) as T;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const recordRole = typeof record.role === 'string' ? record.role : options.role;
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, nestedValue]) => [
        entryKey,
        renderUnknownValueForPIIBoundary(
          nestedValue,
          context,
          entryKey === 'content' || entryKey === 'rawContent'
            ? { ...options, role: recordRole }
            : options,
          entryKey,
        ),
      ]),
    ) as T;
  }
  return value;
}

export function renderValueForPIIBoundary<T>(
  value: T,
  context: PIIBoundaryContext | undefined,
  options: PIIBoundaryRenderOptions,
): T {
  if (hasPIIPolicy(context)) {
    return renderUnknownValueForPIIBoundary(value, context, options);
  }

  const scrubbed = scrubTraceEvent({ value: value as unknown }).value as T;
  return renderUnknownValueForPIIBoundary(scrubbed, context, options);
}

export function renderSessionMessagesForPIIBoundary<T extends PIIBoundaryMessage>(
  messages: T[],
  context: PIIBoundaryContext | undefined,
  consumer: PIIBoundaryConsumer,
): T[] {
  return messages.map((message) => ({
    ...message,
    content: renderTextForPIIBoundary(message.content, context, {
      consumer,
      role: message.role,
    }),
    ...(message.rawContent !== undefined
      ? {
          rawContent: renderValueForPIIBoundary(message.rawContent, context, {
            consumer,
            role: message.role,
          }),
        }
      : {}),
    ...(message.contentEnvelope !== undefined
      ? {
          contentEnvelope: renderValueForPIIBoundary(message.contentEnvelope, context, {
            consumer,
            role: message.role,
          }),
        }
      : {}),
    ...(message.metadata !== undefined
      ? {
          metadata: renderValueForPIIBoundary(message.metadata, context, {
            consumer,
            role: message.role,
          }),
        }
      : {}),
  }));
}

export function renderTraceEventsForPIIBoundary<T extends PIIBoundaryTraceEvent>(
  traceEvents: T[],
  context: PIIBoundaryContext | undefined,
  consumer: PIIBoundaryConsumer,
): T[] {
  return traceEvents.map((event) => ({
    ...event,
    ...(event.data && typeof event.data === 'object'
      ? { data: renderValueForPIIBoundary(event.data, context, { consumer }) }
      : {}),
  }));
}

import type { AgentIR } from '@abl/compiler';
import { DEFAULT_MESSAGES } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import {
  localeAssetConfigKeyToRelativePath,
  parseLocaleAssetPath,
} from '@agent-platform/project-io';
import type { PersistedMessageLocalizationOwnershipV1 } from '../session/persisted-message-content.js';
import type { RuntimeSession, SessionDataStore } from './types.js';
import {
  getCurrentInteractionLanguage,
  getCurrentInteractionLocale,
} from './interaction-context.js';
import { interpolateTemplate } from './value-resolution.js';

const log = createLogger('localized-messages');

interface LocalizationAssetPayload {
  [key: string]: unknown;
}

interface LocalizationBucket {
  shared?: LocalizationAssetPayload;
  assets: Record<string, LocalizationAssetPayload>;
}

export interface SessionLocalizationCatalog {
  version: 1;
  locales: Record<string, LocalizationBucket>;
}

export interface LocalizedMessageResolution {
  text: string;
  localization?: PersistedMessageLocalizationOwnershipV1;
}

interface LocaleResolutionContext {
  candidates: string[];
  requestedLocale?: string;
}

interface CatalogMessageMatch {
  text: string;
  locale: string;
  catalogId: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ensureDataValues(
  sessionData: SessionDataStore | undefined,
): Record<string, unknown> | null {
  if (!sessionData) {
    return null;
  }

  if (isPlainObject(sessionData.values)) {
    return sessionData.values;
  }

  const nextValues: Record<string, unknown> = {};
  sessionData.values = nextValues;
  return nextValues;
}

export function ensureRuntimeSessionDataStore(session: RuntimeSession): SessionDataStore {
  const currentData = session.data as Partial<SessionDataStore> | undefined;
  if (currentData && isPlainObject(currentData.values) && currentData.gatheredKeys instanceof Set) {
    return currentData as SessionDataStore;
  }

  const normalized: SessionDataStore = {
    values: isPlainObject(currentData?.values) ? currentData.values : {},
    gatheredKeys:
      currentData?.gatheredKeys instanceof Set ? currentData.gatheredKeys : new Set<string>(),
  };
  session.data = normalized;
  return normalized;
}

function ensureSessionNamespace(
  sessionData: SessionDataStore | undefined,
): Record<string, unknown> | null {
  const values = ensureDataValues(sessionData);
  if (!values) {
    return null;
  }

  const namespace = values.session;
  if (isPlainObject(namespace)) {
    return namespace;
  }

  const nextNamespace: Record<string, unknown> = {};
  values.session = nextNamespace;
  return nextNamespace;
}

function isLocalizationBucket(value: unknown): value is LocalizationBucket {
  if (!isPlainObject(value)) {
    return false;
  }

  if ('shared' in value && value.shared !== undefined && !isPlainObject(value.shared)) {
    return false;
  }

  return isPlainObject(value.assets);
}

function isSessionLocalizationCatalog(value: unknown): value is SessionLocalizationCatalog {
  if (!isPlainObject(value) || value.version !== 1 || !isPlainObject(value.locales)) {
    return false;
  }

  return Object.values(value.locales).every((bucket) => isLocalizationBucket(bucket));
}

function canonicalizeLocaleCode(value: string): string | null {
  const normalized = value.trim().replace(/_/g, '-');
  if (!normalized) {
    return null;
  }

  try {
    const [canonical] = Intl.getCanonicalLocales(normalized);
    return canonical ?? null;
  } catch {
    return /^[A-Za-z]{2,3}$/.test(normalized) ? normalized.toLowerCase() : null;
  }
}

function sanitizeAssetName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_');
}

function parseLocalizationAssetPayload(
  relativePath: string,
  rawValue: string,
): LocalizationAssetPayload | null {
  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (!isPlainObject(parsed)) {
      return null;
    }

    return parsed;
  } catch (error) {
    log.warn('Skipping invalid locale asset payload during runtime load', {
      relativePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function buildSessionLocalizationCatalog(
  configVariables: Record<string, string> | undefined,
): SessionLocalizationCatalog | undefined {
  if (!configVariables) {
    return undefined;
  }

  const locales: Record<string, LocalizationBucket> = {};

  for (const [key, rawValue] of Object.entries(configVariables)) {
    const relativePath = localeAssetConfigKeyToRelativePath(key);
    if (!relativePath) {
      continue;
    }

    const pathParts = parseLocaleAssetPath(relativePath);
    if (!pathParts) {
      continue;
    }

    const localeCode = canonicalizeLocaleCode(pathParts.localeCode) ?? pathParts.localeCode;
    const payload = parseLocalizationAssetPayload(relativePath, rawValue);
    if (!payload) {
      continue;
    }

    const bucket = (locales[localeCode] ??= {
      assets: {},
    });

    if (pathParts.assetName === '_shared') {
      bucket.shared = payload;
    } else {
      bucket.assets[sanitizeAssetName(pathParts.assetName)] = payload;
    }
  }

  return Object.keys(locales).length > 0 ? { version: 1, locales } : undefined;
}

export function storeSessionLocalizationCatalog(
  sessionData: SessionDataStore | undefined,
  catalog: SessionLocalizationCatalog | undefined,
): void {
  const sessionNamespace = ensureSessionNamespace(sessionData);
  if (!sessionNamespace) {
    return;
  }

  if (!catalog) {
    delete sessionNamespace._localizedMessageCatalog;
    return;
  }

  sessionNamespace._localizedMessageCatalog = catalog;
}

export function storeRuntimeSessionLocalizationCatalog(
  session: RuntimeSession,
  catalog: SessionLocalizationCatalog | undefined,
): void {
  storeSessionLocalizationCatalog(ensureRuntimeSessionDataStore(session), catalog);
}

export function readSessionLocalizationCatalog(
  sessionData: SessionDataStore | undefined,
): SessionLocalizationCatalog | undefined {
  const sessionNamespace = ensureSessionNamespace(sessionData);
  if (!sessionNamespace) {
    return undefined;
  }

  const rawCatalog = sessionNamespace._localizedMessageCatalog;
  if (!isSessionLocalizationCatalog(rawCatalog)) {
    return undefined;
  }

  return rawCatalog;
}

function buildLocaleFallbackChain(value: string): string[] {
  const canonicalLocale = canonicalizeLocaleCode(value);
  if (!canonicalLocale) {
    return [];
  }

  const segments = canonicalLocale.split('-');
  const candidates = new Set<string>();

  for (let length = segments.length; length > 0; length -= 1) {
    const candidate = canonicalizeLocaleCode(segments.slice(0, length).join('-'));
    if (candidate) {
      candidates.add(candidate);
    }
  }

  return [...candidates];
}

function buildLocaleCandidates(sessionData: SessionDataStore): string[] {
  return buildLocaleResolutionContext(sessionData).candidates;
}

function buildLocaleResolutionContext(sessionData: SessionDataStore): LocaleResolutionContext {
  const locale = getCurrentInteractionLocale(sessionData);
  const language = getCurrentInteractionLanguage(sessionData);
  const candidates = new Set<string>();

  if (locale) {
    for (const candidate of buildLocaleFallbackChain(locale)) {
      candidates.add(candidate);
    }
  }

  if (language) {
    for (const candidate of buildLocaleFallbackChain(language)) {
      candidates.add(candidate);
    }
  }

  return {
    candidates: [...candidates],
    requestedLocale: locale ?? language ?? undefined,
  };
}

function buildAssetCandidates(agentName: string, agentIR?: AgentIR | null): string[] {
  const candidates = new Set<string>();

  for (const value of [agentName, agentIR?.metadata?.name]) {
    if (!value) {
      continue;
    }

    candidates.add(value);
    candidates.add(sanitizeAssetName(value));
  }

  return [...candidates].map((candidate) => sanitizeAssetName(candidate));
}

function lookupMessageValue(
  payload: LocalizationAssetPayload | undefined,
  messageKey: string,
): string | undefined {
  if (!payload) {
    return undefined;
  }

  const direct = payload[messageKey];
  if (typeof direct === 'string' && direct.length > 0) {
    return direct;
  }

  const nestedMessages = payload.messages;
  if (isPlainObject(nestedMessages)) {
    const nested = nestedMessages[messageKey];
    if (typeof nested === 'string' && nested.length > 0) {
      return nested;
    }
  }

  return undefined;
}

function buildLocalizationOwnership(params: {
  domain: 'project' | 'platform';
  messageKey: string;
  requestedLocale?: string;
  matchedLocale?: string;
  catalogId?: string;
}): PersistedMessageLocalizationOwnershipV1 {
  return {
    domain: params.domain,
    ...(params.requestedLocale ? { locale: params.requestedLocale } : {}),
    ...(params.matchedLocale && params.matchedLocale !== params.requestedLocale
      ? { fallbackLocale: params.matchedLocale }
      : {}),
    messageKey: params.messageKey,
    ...(params.catalogId ? { catalogId: params.catalogId } : {}),
  };
}

function resolveSessionLocalizedCatalogMessageMatch(input: {
  session: RuntimeSession;
  messageKey: string;
  fallbackMessage?: string;
  agentIR?: AgentIR | null;
  agentName?: string;
}): CatalogMessageMatch | undefined {
  const { session, messageKey } = input;
  const agentIR = input.agentIR ?? session.agentIR;
  const agentName = input.agentName ?? session.agentName;
  const catalog = readSessionLocalizationCatalog(session.data);

  if (catalog) {
    const localeCandidates = buildLocaleResolutionContext(session.data).candidates;
    const assetCandidates = buildAssetCandidates(agentName, agentIR);

    for (const localeCode of localeCandidates) {
      const bucket = catalog.locales[localeCode];
      if (!bucket) {
        continue;
      }

      for (const assetName of assetCandidates) {
        const localized = lookupMessageValue(bucket.assets[assetName], messageKey);
        if (localized) {
          return {
            text: localized,
            locale: localeCode,
            catalogId: assetName,
          };
        }
      }

      const sharedLocalized = lookupMessageValue(bucket.shared, messageKey);
      if (sharedLocalized) {
        return {
          text: sharedLocalized,
          locale: localeCode,
          catalogId: '_shared',
        };
      }
    }
  }

  return undefined;
}

export function resolveSessionLocalizedCatalogMessageWithMetadata(input: {
  session: RuntimeSession;
  messageKey: string;
  agentIR?: AgentIR | null;
  agentName?: string;
}): LocalizedMessageResolution | undefined {
  const catalogMatch = resolveSessionLocalizedCatalogMessageMatch(input);
  if (!catalogMatch) {
    return undefined;
  }

  const localeContext = buildLocaleResolutionContext(input.session.data);
  return {
    text: catalogMatch.text,
    localization: buildLocalizationOwnership({
      domain: 'project',
      messageKey: input.messageKey,
      requestedLocale: localeContext.requestedLocale,
      matchedLocale: catalogMatch.locale,
      catalogId: catalogMatch.catalogId,
    }),
  };
}

export function resolveLocalizedAgentMessageWithMetadata(input: {
  session: RuntimeSession;
  messageKey: string;
  fallbackMessage?: string;
  agentIR?: AgentIR | null;
  agentName?: string;
}): LocalizedMessageResolution {
  const { session, messageKey } = input;
  const agentIR = input.agentIR ?? session.agentIR;
  const fallbackMessage = input.fallbackMessage ?? DEFAULT_MESSAGES[messageKey] ?? '';
  const localeContext = buildLocaleResolutionContext(session.data);
  const localizedCatalogMessage = resolveSessionLocalizedCatalogMessageWithMetadata({
    session,
    messageKey,
    agentIR,
    agentName: input.agentName,
  });

  if (localizedCatalogMessage) {
    return localizedCatalogMessage;
  }

  const agentMessage = agentIR?.messages?.[messageKey];
  if (typeof agentMessage === 'string' && agentMessage.length > 0) {
    return {
      text: agentMessage,
      localization: buildLocalizationOwnership({
        domain: 'project',
        messageKey,
        requestedLocale: localeContext.requestedLocale,
      }),
    };
  }

  return {
    text: fallbackMessage,
    localization:
      fallbackMessage.length > 0
        ? buildLocalizationOwnership({
            domain: 'platform',
            messageKey,
            requestedLocale: localeContext.requestedLocale,
          })
        : undefined,
  };
}

export function resolveLocalizedErrorHandlerResponseWithMetadata(input: {
  session: RuntimeSession;
  resolution: {
    respond?: string;
    handler?: unknown;
  };
}): LocalizedMessageResolution | undefined {
  const defaultHandler = input.session.agentIR?.error_handling?.default_handler;
  const defaultErrorMessage =
    input.session.agentIR?.messages?.error_default || DEFAULT_MESSAGES.error_default;
  const hasExplicitRespond =
    typeof input.resolution.respond === 'string' && input.resolution.respond.length > 0;
  const shouldResolveDefaultErrorMessage =
    (input.resolution.handler === defaultHandler && !hasExplicitRespond) ||
    input.resolution.respond === defaultErrorMessage;

  if (shouldResolveDefaultErrorMessage) {
    return resolveLocalizedAgentMessageWithMetadata({
      session: input.session,
      messageKey: 'error_default',
      fallbackMessage: defaultErrorMessage,
    });
  }

  if (typeof input.resolution.respond !== 'string' || input.resolution.respond.length === 0) {
    return undefined;
  }

  return {
    text: input.resolution.respond,
  };
}

export function resolveLocalizedAgentMessage(input: {
  session: RuntimeSession;
  messageKey: string;
  fallbackMessage?: string;
  agentIR?: AgentIR | null;
  agentName?: string;
}): string {
  return resolveLocalizedAgentMessageWithMetadata(input).text;
}

export function resolveAuthoredLocalizedTemplate(input: {
  session: RuntimeSession;
  messageKey?: string;
  fallbackTemplate?: string;
  agentIR?: AgentIR | null;
  agentName?: string;
}): string {
  const fallbackTemplate = input.fallbackTemplate ?? '';
  if (!input.messageKey) {
    return fallbackTemplate;
  }

  return resolveLocalizedAgentMessage({
    session: input.session,
    agentIR: input.agentIR,
    agentName: input.agentName,
    messageKey: input.messageKey,
    fallbackMessage: fallbackTemplate,
  });
}

export function renderAuthoredLocalizedTemplate(input: {
  session: RuntimeSession;
  messageKey?: string;
  fallbackTemplate?: string;
  values?: Record<string, unknown>;
  agentIR?: AgentIR | null;
  agentName?: string;
}): string {
  return interpolateTemplate(
    resolveAuthoredLocalizedTemplate({
      session: input.session,
      messageKey: input.messageKey,
      fallbackTemplate: input.fallbackTemplate,
      agentIR: input.agentIR,
      agentName: input.agentName,
    }),
    input.values ?? input.session.data.values,
  );
}

export function resolveSessionLocalizedCatalogMessage(input: {
  session: RuntimeSession;
  messageKey: string;
  agentIR?: AgentIR | null;
  agentName?: string;
}): string | undefined {
  return resolveSessionLocalizedCatalogMessageWithMetadata(input)?.text;
}

export function buildLocalizedMessageResolver(
  session: RuntimeSession,
  agentIR?: AgentIR | null,
  agentName?: string,
): (messageKey: string, fallbackMessage?: string) => string {
  return (messageKey: string, fallbackMessage?: string) =>
    resolveLocalizedAgentMessage({
      session,
      agentIR,
      agentName,
      messageKey,
      fallbackMessage,
    });
}

function hasQueuedIntentTemplateVariable(template: string): boolean {
  return /\{\{\s*(?:next_intent|next_intent_display|intent)\s*\}\}/.test(template);
}

export function renderQueuedIntentNoticeMessage(input: {
  intentLabel: string;
  resolveMessage: (messageKey: string, fallbackMessage?: string) => string;
  noticeFallback?: string;
  followUpFallback?: string;
}): string {
  const {
    intentLabel,
    resolveMessage,
    noticeFallback = DEFAULT_MESSAGES.multi_intent_queued_notice,
    followUpFallback = DEFAULT_MESSAGES.multi_intent_queued_follow_up,
  } = input;
  const templateData = {
    next_intent: intentLabel,
    next_intent_display: intentLabel,
    intent: intentLabel,
  };
  const noticeTemplate = resolveMessage('multi_intent_queued_notice', noticeFallback).trim();

  if (noticeTemplate.length === 0) {
    return interpolateTemplate(
      resolveMessage('multi_intent_queued_follow_up', followUpFallback),
      templateData,
    ).trim();
  }

  if (hasQueuedIntentTemplateVariable(noticeTemplate)) {
    return interpolateTemplate(noticeTemplate, templateData).trim();
  }

  const followUpTemplate = resolveMessage('multi_intent_queued_follow_up', followUpFallback);
  const noticePrefix = interpolateTemplate(noticeTemplate, templateData).trim();
  const followUp = interpolateTemplate(followUpTemplate, templateData).trim();

  return [noticePrefix, followUp]
    .filter((part) => part.length > 0)
    .join(' ')
    .trim();
}

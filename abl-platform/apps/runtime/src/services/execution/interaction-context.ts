import { createLogger, detectLanguageFallback } from '@abl/compiler/platform';
import type {
  InteractionContext,
  InteractionContextConfidence,
  InteractionContextInput,
  InteractionContextSource,
  SessionInteractionPreference,
  SessionInteractionState,
} from '@agent-platform/shared-kernel';

const log = createLogger('interaction-context');

const INTERACTION_CONTEXT_SOURCES: ReadonlySet<InteractionContextSource> = new Set([
  'message',
  'session',
  'contact',
  'channel',
  'project',
  'agent',
  'default',
]);

const INTERACTION_CONTEXT_CONFIDENCES: ReadonlySet<InteractionContextConfidence> = new Set([
  'explicit',
  'high',
  'medium',
  'low',
]);

const INTERACTION_CONTEXT_FIELDS = ['language', 'locale', 'timezone'] as const;

type InteractionContextField = (typeof INTERACTION_CONTEXT_FIELDS)[number];

interface SanitizedInteractionContextInput {
  language?: string;
  locale?: string;
  timezone?: string;
}

interface SessionValueStore {
  values: Record<string, unknown>;
}

type InteractionContextInputLike = InteractionContextInput &
  Partial<Pick<SessionInteractionPreference, 'source' | 'confidence' | 'updatedAt'>>;

type ValidationMode = 'sanitize' | 'strict';

interface ParsingLocaleCandidate {
  language?: string | null;
  locale?: string | null;
  source?: InteractionContextSource;
  confidence?: InteractionContextConfidence;
}

interface InteractionContextLayer {
  source: InteractionContextSource;
  confidence: InteractionContextConfidence;
  input?: InteractionContextInputLike;
}

export interface InteractionContextValidationIssue {
  field: InteractionContextField;
  message: string;
}

export interface InteractionContextValidationError {
  code: 'INVALID_INTERACTION_CONTEXT';
  message: string;
  issues: string[];
  fieldIssues: InteractionContextValidationIssue[];
}

export type NormalizeInteractionContextInputResult =
  | {
      success: true;
      data?: InteractionContextInput;
      issues: InteractionContextValidationIssue[];
    }
  | {
      success: false;
      error: InteractionContextValidationError;
    };

export interface ResolveInteractionContextOptions {
  explicit?: InteractionContextInputLike;
  messageHint?: InteractionContextInputLike;
  sessionCurrent?: InteractionContext;
  sessionPreference?: InteractionContextInputLike;
  contactPreference?: InteractionContextInputLike;
  channelHint?: InteractionContextInputLike;
  legacyClientInfo?: InteractionContextInputLike;
  agentDefault?: InteractionContextInputLike;
  projectDefault?: InteractionContextInputLike;
  defaults?: InteractionContextInputLike;
  resolvedAt?: Date;
}

export interface ResolvedInteractionContext {
  current: InteractionContext;
  preference?: SessionInteractionPreference;
  aliases: {
    _language?: string;
    _locale?: string;
    _timezone?: string;
  };
  legacyInputs?: {
    clientInfoLocale?: string;
    clientInfoTimezone?: string;
  };
}

export interface ResolveAndApplyInteractionContextOptions {
  sessionData: SessionValueStore;
  explicit?: InteractionContextInputLike;
  messageHint?: InteractionContextInputLike;
  contactPreference?: InteractionContextInputLike;
  channelHint?: InteractionContextInputLike;
  legacyClientInfo?: InteractionContextInputLike;
  agentDefault?: InteractionContextInputLike;
  projectDefault?: InteractionContextInputLike;
  defaults?: InteractionContextInputLike;
  resolvedAt?: Date;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteractionContextSource(value: unknown): value is InteractionContextSource {
  return (
    typeof value === 'string' && INTERACTION_CONTEXT_SOURCES.has(value as InteractionContextSource)
  );
}

function isInteractionContextConfidence(value: unknown): value is InteractionContextConfidence {
  return (
    typeof value === 'string' &&
    INTERACTION_CONTEXT_CONFIDENCES.has(value as InteractionContextConfidence)
  );
}

function hasInteractionContextValues(input: InteractionContextInput | undefined): boolean {
  return !!(input?.language || input?.locale || input?.timezone);
}

function ensureSessionNamespace(sessionData: SessionValueStore): Record<string, unknown> {
  const namespace = sessionData.values.session;
  if (isPlainObject(namespace)) {
    return namespace;
  }

  const nextNamespace: Record<string, unknown> = {};
  sessionData.values.session = nextNamespace;
  return nextNamespace;
}

const MIN_LANGUAGE_HINT_MESSAGE_LENGTH = 3;
const MIN_LANGUAGE_HINT_CONFIDENCE = 0.6;

function canonicalizeLocale(value: string): string | null {
  try {
    const [canonicalLocale] = Intl.getCanonicalLocales(value);
    return canonicalLocale ?? null;
  } catch {
    return null;
  }
}

function canonicalizeLanguage(value: string): string | null {
  const canonicalLocale = canonicalizeLocale(value);
  if (!canonicalLocale) {
    return null;
  }

  const language = canonicalLocale.split('-')[0]?.toLowerCase();
  return language || null;
}

function canonicalizeTimezone(value: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function localeMatchesLanguage(locale: string | undefined, language: string | undefined): boolean {
  if (!locale || !language) {
    return false;
  }

  return canonicalizeLanguage(locale) === canonicalizeLanguage(language);
}

function resolveParsingLocaleFromCandidate(
  candidate: ParsingLocaleCandidate | undefined,
): string | undefined {
  const locale =
    typeof candidate?.locale === 'string' && candidate.locale.length > 0
      ? candidate.locale
      : undefined;
  const language =
    typeof candidate?.language === 'string' && candidate.language.length > 0
      ? candidate.language
      : undefined;

  if (locale) {
    if (!language || localeMatchesLanguage(locale, language)) {
      return locale;
    }

    if (candidate?.confidence === 'explicit') {
      return locale;
    }
  }

  if (language) {
    return language;
  }

  return locale;
}

function sanitizeInteractionContextInput(
  input: unknown,
  mode: ValidationMode,
): NormalizeInteractionContextInputResult {
  if (input === undefined) {
    return { success: true, issues: [] };
  }

  if (!isPlainObject(input)) {
    const fieldIssues: InteractionContextValidationIssue[] = [
      {
        field: 'language',
        message: 'interactionContext must be an object',
      },
    ];
    if (mode === 'sanitize') {
      return { success: true, issues: fieldIssues };
    }
    return {
      success: false,
      error: {
        code: 'INVALID_INTERACTION_CONTEXT',
        message: 'Invalid interaction context',
        issues: fieldIssues.map((issue) => issue.message),
        fieldIssues,
      },
    };
  }

  const issues: InteractionContextValidationIssue[] = [];
  const normalized: SanitizedInteractionContextInput = {};

  for (const field of INTERACTION_CONTEXT_FIELDS) {
    const rawValue = input[field];
    if (rawValue === undefined) {
      continue;
    }

    if (typeof rawValue !== 'string') {
      issues.push({
        field,
        message: `${field} must be a string`,
      });
      continue;
    }

    const trimmedValue = rawValue.trim();
    if (!trimmedValue) {
      issues.push({
        field,
        message: `${field} must not be empty`,
      });
      continue;
    }

    const canonicalValue =
      field === 'language'
        ? canonicalizeLanguage(trimmedValue)
        : field === 'locale'
          ? canonicalizeLocale(trimmedValue)
          : canonicalizeTimezone(trimmedValue);

    if (!canonicalValue) {
      issues.push({
        field,
        message: `${field} is invalid`,
      });
      continue;
    }

    normalized[field] = canonicalValue;
  }

  if (issues.length > 0 && mode === 'strict') {
    return {
      success: false,
      error: {
        code: 'INVALID_INTERACTION_CONTEXT',
        message: 'Invalid interaction context',
        issues: issues.map((issue) => issue.message),
        fieldIssues: issues,
      },
    };
  }

  return {
    success: true,
    data: hasInteractionContextValues(normalized) ? normalized : undefined,
    issues,
  };
}

function normalizePreferenceMetadata(
  input: InteractionContextInputLike | undefined,
  fallbackSource: InteractionContextSource,
  fallbackConfidence: InteractionContextConfidence,
  fallbackUpdatedAt: string,
): Pick<SessionInteractionPreference, 'source' | 'confidence' | 'updatedAt'> {
  return {
    source: isInteractionContextSource(input?.source) ? input.source : fallbackSource,
    confidence: isInteractionContextConfidence(input?.confidence)
      ? input.confidence
      : fallbackConfidence,
    updatedAt:
      typeof input?.updatedAt === 'string' && input.updatedAt.trim().length > 0
        ? input.updatedAt
        : fallbackUpdatedAt,
  };
}

function pickFieldFromLayers(
  field: InteractionContextField,
  layers: InteractionContextLayer[],
): string | undefined {
  for (const layer of layers) {
    const value = layer.input?.[field];
    if (value) {
      return value;
    }
  }

  return undefined;
}

function parseStoredCurrent(raw: unknown): InteractionContext | undefined {
  if (!isPlainObject(raw)) {
    return undefined;
  }

  const normalized = sanitizeInteractionContextInput(
    {
      language: raw.language,
      locale: raw.locale,
      timezone: raw.timezone,
    },
    'sanitize',
  );
  if (!normalized.success) {
    return undefined;
  }

  return {
    language: normalized.data?.language ?? null,
    locale: normalized.data?.locale ?? null,
    timezone: normalized.data?.timezone ?? null,
    source: isInteractionContextSource(raw.source) ? raw.source : 'default',
    confidence: isInteractionContextConfidence(raw.confidence) ? raw.confidence : 'low',
    resolvedAt:
      typeof raw.resolvedAt === 'string' && raw.resolvedAt.trim().length > 0
        ? raw.resolvedAt
        : new Date(0).toISOString(),
  };
}

function parseStoredPreference(raw: unknown): SessionInteractionPreference | undefined {
  if (!isPlainObject(raw)) {
    return undefined;
  }

  const normalized = sanitizeInteractionContextInput(
    {
      language: raw.language,
      locale: raw.locale,
      timezone: raw.timezone,
    },
    'sanitize',
  );
  if (!normalized.success || !normalized.data) {
    return undefined;
  }

  return {
    ...normalized.data,
    source: isInteractionContextSource(raw.source) ? raw.source : 'session',
    confidence: isInteractionContextConfidence(raw.confidence) ? raw.confidence : 'high',
    updatedAt:
      typeof raw.updatedAt === 'string' && raw.updatedAt.trim().length > 0
        ? raw.updatedAt
        : new Date(0).toISOString(),
  };
}

function getInteractionFieldFromState(
  state: SessionInteractionState | undefined,
  field: InteractionContextField,
): string | undefined {
  const currentValue = state?.current[field];
  if (typeof currentValue === 'string' && currentValue.length > 0) {
    return currentValue;
  }

  const preferenceValue = state?.preference?.[field];
  return typeof preferenceValue === 'string' && preferenceValue.length > 0
    ? preferenceValue
    : undefined;
}

export function mergeInteractionContextInputs(
  ...inputs: Array<InteractionContextInput | undefined>
): InteractionContextInput | undefined {
  const merged: InteractionContextInput = {};

  for (const input of inputs) {
    if (!input) {
      continue;
    }

    if (input.language) {
      merged.language = input.language;
    }
    if (input.locale) {
      merged.locale = input.locale;
    }
    if (input.timezone) {
      merged.timezone = input.timezone;
    }
  }

  return hasInteractionContextValues(merged) ? merged : undefined;
}

function buildSessionInteractionPreference(
  input: InteractionContextInputLike | undefined,
  fallbackSource: InteractionContextSource,
  fallbackConfidence: InteractionContextConfidence,
  resolvedAt: string,
): SessionInteractionPreference | undefined {
  const sanitized = sanitizeInteractionContextInput(input, 'sanitize');
  if (!sanitized.success || !sanitized.data) {
    return undefined;
  }

  return {
    ...sanitized.data,
    ...normalizePreferenceMetadata(input, fallbackSource, fallbackConfidence, resolvedAt),
  };
}

export function extractLegacyAliasInteractionContext(
  sessionData: SessionValueStore,
  mode: ValidationMode = 'sanitize',
): NormalizeInteractionContextInputResult {
  return sanitizeInteractionContextInput(
    {
      language:
        typeof sessionData.values._language === 'string' ? sessionData.values._language : undefined,
      locale:
        typeof sessionData.values._locale === 'string' ? sessionData.values._locale : undefined,
      timezone:
        typeof sessionData.values._timezone === 'string' ? sessionData.values._timezone : undefined,
    },
    mode,
  );
}

export function readSessionInteractionState(
  sessionData: SessionValueStore,
): SessionInteractionState | undefined {
  const sessionNamespace = ensureSessionNamespace(sessionData);
  const rawState = sessionNamespace.interaction ?? sessionNamespace.interactionContext;
  if (!isPlainObject(rawState)) {
    return undefined;
  }

  const current = parseStoredCurrent(rawState.current);
  if (!current) {
    return undefined;
  }

  const preference = parseStoredPreference(rawState.preference);
  return preference ? { current, preference } : { current };
}

export function applyResolvedInteractionContextToSessionData(
  sessionData: SessionValueStore,
  resolved: ResolvedInteractionContext,
): SessionInteractionState {
  const sessionNamespace = ensureSessionNamespace(sessionData);
  const nextState: SessionInteractionState = resolved.preference
    ? {
        current: resolved.current,
        preference: resolved.preference,
      }
    : {
        current: resolved.current,
      };

  sessionNamespace.interaction = nextState;
  sessionNamespace.interactionContext = nextState;

  delete sessionData.values._language;
  delete sessionData.values._locale;
  delete sessionData.values._timezone;
  Object.assign(sessionData.values, buildInteractionContextAliases(nextState));

  return nextState;
}

export function resolveAndApplyInteractionContextToSessionData(
  options: ResolveAndApplyInteractionContextOptions,
): SessionInteractionState {
  const existingState = readSessionInteractionState(options.sessionData);
  const legacyAliasInput = extractLegacyAliasInteractionContext(options.sessionData, 'sanitize');
  const legacySessionPreference = legacyAliasInput.success ? legacyAliasInput.data : undefined;
  const sessionPreference = existingState?.preference
    ? {
        ...(legacySessionPreference ?? {}),
        ...existingState.preference,
      }
    : legacySessionPreference;
  const resolved = resolveInteractionContext({
    explicit: options.explicit,
    messageHint: options.messageHint,
    sessionCurrent: existingState?.current,
    sessionPreference,
    contactPreference: options.contactPreference,
    channelHint: options.channelHint,
    legacyClientInfo: options.legacyClientInfo,
    agentDefault: options.agentDefault,
    projectDefault: options.projectDefault,
    defaults: options.defaults,
    resolvedAt: options.resolvedAt,
  });

  return applyResolvedInteractionContextToSessionData(options.sessionData, resolved);
}

export function getCurrentInteractionContext(
  sessionData: SessionValueStore,
): InteractionContext | undefined {
  return readSessionInteractionState(sessionData)?.current;
}

export function getCurrentInteractionLanguage(
  sessionData: SessionValueStore,
  fallback?: string,
): string | undefined {
  const legacyAliasInput = extractLegacyAliasInteractionContext(sessionData, 'sanitize');
  return (
    getInteractionFieldFromState(readSessionInteractionState(sessionData), 'language') ??
    (legacyAliasInput.success ? legacyAliasInput.data?.language : undefined) ??
    fallback
  );
}

export function getCurrentInteractionLocale(
  sessionData: SessionValueStore,
  fallback?: string,
): string | undefined {
  const legacyAliasInput = extractLegacyAliasInteractionContext(sessionData, 'sanitize');
  return (
    getInteractionFieldFromState(readSessionInteractionState(sessionData), 'locale') ??
    (legacyAliasInput.success ? legacyAliasInput.data?.locale : undefined) ??
    fallback
  );
}

export function getCurrentInteractionParsingLocale(
  sessionData: SessionValueStore,
  fallback?: string,
): string | undefined {
  const state = readSessionInteractionState(sessionData);
  const currentLocale = resolveParsingLocaleFromCandidate(state?.current);
  if (currentLocale) {
    return currentLocale;
  }

  const preferenceLocale = resolveParsingLocaleFromCandidate(state?.preference);
  if (preferenceLocale) {
    return preferenceLocale;
  }

  const legacyAliasInput = extractLegacyAliasInteractionContext(sessionData, 'sanitize');
  return (
    resolveParsingLocaleFromCandidate(
      legacyAliasInput.success
        ? {
            language: legacyAliasInput.data?.language,
            locale: legacyAliasInput.data?.locale,
          }
        : undefined,
    ) ?? fallback
  );
}

export function getCurrentInteractionTimezone(
  sessionData: SessionValueStore,
  fallback?: string,
): string | undefined {
  const legacyAliasInput = extractLegacyAliasInteractionContext(sessionData, 'sanitize');
  return (
    getInteractionFieldFromState(readSessionInteractionState(sessionData), 'timezone') ??
    (legacyAliasInput.success ? legacyAliasInput.data?.timezone : undefined) ??
    fallback
  );
}

export function normalizeInteractionContextInput(
  input: unknown,
  mode: ValidationMode = 'strict',
): NormalizeInteractionContextInputResult {
  return sanitizeInteractionContextInput(input, mode);
}

export function extractInteractionContextFromMetadata(
  metadata: Record<string, unknown> | undefined,
  mode: ValidationMode = 'sanitize',
): NormalizeInteractionContextInputResult {
  const rawInteractionContext = isPlainObject(metadata) ? metadata.interactionContext : undefined;
  return sanitizeInteractionContextInput(
    isPlainObject(rawInteractionContext)
      ? (rawInteractionContext as InteractionContextInputLike)
      : undefined,
    mode,
  );
}

export function extractLegacyClientInfoInteractionContext(
  metadata: Record<string, unknown> | undefined,
  mode: ValidationMode = 'sanitize',
): NormalizeInteractionContextInputResult {
  const clientInfo = isPlainObject(metadata?.clientInfo) ? metadata.clientInfo : undefined;
  return sanitizeInteractionContextInput(
    isPlainObject(clientInfo)
      ? {
          locale: typeof clientInfo.locale === 'string' ? clientInfo.locale : undefined,
          timezone: typeof clientInfo.timezone === 'string' ? clientInfo.timezone : undefined,
        }
      : undefined,
    mode,
  );
}

export function extractInteractionContextFromContactPreferences(
  preferences: Record<string, unknown> | undefined,
  mode: ValidationMode = 'sanitize',
): NormalizeInteractionContextInputResult {
  if (!isPlainObject(preferences)) {
    return { success: true, issues: [] };
  }

  const nested = extractInteractionContextFromMetadata(preferences, mode);
  if (!nested.success) {
    return nested;
  }

  const direct = sanitizeInteractionContextInput(
    {
      language: typeof preferences.language === 'string' ? preferences.language : undefined,
      locale: typeof preferences.locale === 'string' ? preferences.locale : undefined,
      timezone: typeof preferences.timezone === 'string' ? preferences.timezone : undefined,
    },
    mode,
  );
  if (!direct.success) {
    return direct;
  }

  return {
    success: true,
    data: mergeInteractionContextInputs(direct.data, nested.data),
    issues: [...direct.issues, ...nested.issues],
  };
}

export function buildInteractionContextAliases(
  state: SessionInteractionState | undefined,
): ResolvedInteractionContext['aliases'] {
  const current = state?.current;

  return {
    ...(current?.language ? { _language: current.language } : {}),
    ...(current?.locale ? { _locale: current.locale } : {}),
    ...(current?.timezone ? { _timezone: current.timezone } : {}),
  };
}

export function inferInteractionContextFromUserMessage(
  userMessage: string,
  currentLanguage?: string | null,
): InteractionContextInputLike | undefined {
  const trimmedMessage = userMessage.trim();
  if (trimmedMessage.length < MIN_LANGUAGE_HINT_MESSAGE_LENGTH) {
    return undefined;
  }

  const detectedLanguage = detectLanguageFallback(trimmedMessage);
  if (detectedLanguage.confidence < MIN_LANGUAGE_HINT_CONFIDENCE) {
    return undefined;
  }

  const language = canonicalizeLanguage(detectedLanguage.primary);
  if (!language) {
    return undefined;
  }

  const normalizedCurrentLanguage = currentLanguage ? canonicalizeLanguage(currentLanguage) : null;
  if (normalizedCurrentLanguage && normalizedCurrentLanguage === language) {
    return undefined;
  }

  return {
    language,
    source: 'message',
    confidence: detectedLanguage.confidence >= 0.8 ? 'high' : 'medium',
  };
}

function shouldPromoteMessageHintToPreference(input: {
  messageHint?: SessionInteractionPreference;
  sessionCurrent?: InteractionContext;
  sessionPreference?: SessionInteractionPreference;
}): boolean {
  const hintedLanguage = input.messageHint?.language;
  if (!hintedLanguage) {
    return false;
  }

  if (!input.sessionPreference?.language && input.messageHint?.confidence === 'high') {
    return true;
  }

  return (
    input.sessionCurrent?.source === 'message' &&
    input.sessionCurrent.language === hintedLanguage &&
    (input.sessionCurrent.confidence === 'high' || input.messageHint?.confidence === 'high')
  );
}

export function resolveInteractionContext(
  options: ResolveInteractionContextOptions,
): ResolvedInteractionContext {
  const resolvedAtIso = (options.resolvedAt ?? new Date()).toISOString();
  const explicit = sanitizeInteractionContextInput(options.explicit, 'sanitize');
  const messageHint = buildSessionInteractionPreference(
    options.messageHint,
    'message',
    'medium',
    resolvedAtIso,
  );
  const sessionPreference = buildSessionInteractionPreference(
    options.sessionPreference,
    'session',
    'high',
    resolvedAtIso,
  );
  const contactPreference = buildSessionInteractionPreference(
    options.contactPreference,
    'contact',
    'high',
    resolvedAtIso,
  );
  const channelHint = buildSessionInteractionPreference(
    options.channelHint,
    'channel',
    'medium',
    resolvedAtIso,
  );
  const legacyClientInfo = buildSessionInteractionPreference(
    options.legacyClientInfo,
    'channel',
    'low',
    resolvedAtIso,
  );
  const agentDefault = buildSessionInteractionPreference(
    options.agentDefault,
    'agent',
    'medium',
    resolvedAtIso,
  );
  const projectDefault = buildSessionInteractionPreference(
    options.projectDefault,
    'project',
    'medium',
    resolvedAtIso,
  );
  const defaults = buildSessionInteractionPreference(
    options.defaults,
    'default',
    'low',
    resolvedAtIso,
  );

  const layers: InteractionContextLayer[] = [
    {
      source: 'message',
      confidence: 'explicit',
      input: explicit.success ? explicit.data : undefined,
    },
    {
      source: messageHint?.source ?? 'message',
      confidence: messageHint?.confidence ?? 'medium',
      input: messageHint,
    },
    {
      source: sessionPreference?.source ?? 'session',
      confidence: sessionPreference?.confidence ?? 'high',
      input: sessionPreference,
    },
    {
      source: contactPreference?.source ?? 'contact',
      confidence: contactPreference?.confidence ?? 'high',
      input: contactPreference,
    },
    {
      source: channelHint?.source ?? 'channel',
      confidence: channelHint?.confidence ?? 'medium',
      input: channelHint,
    },
    {
      source: legacyClientInfo?.source ?? 'channel',
      confidence: legacyClientInfo?.confidence ?? 'low',
      input: legacyClientInfo,
    },
    {
      source: agentDefault?.source ?? 'agent',
      confidence: agentDefault?.confidence ?? 'medium',
      input: agentDefault,
    },
    {
      source: projectDefault?.source ?? 'project',
      confidence: projectDefault?.confidence ?? 'medium',
      input: projectDefault,
    },
    {
      source: defaults?.source ?? 'default',
      confidence: defaults?.confidence ?? 'low',
      input: defaults,
    },
  ];

  const currentInput: InteractionContextInput = {
    ...(pickFieldFromLayers('language', layers)
      ? { language: pickFieldFromLayers('language', layers) }
      : {}),
    ...(pickFieldFromLayers('locale', layers)
      ? { locale: pickFieldFromLayers('locale', layers) }
      : {}),
    ...(pickFieldFromLayers('timezone', layers)
      ? { timezone: pickFieldFromLayers('timezone', layers) }
      : {}),
  };

  let currentSource: InteractionContextSource = 'default';
  let currentConfidence: InteractionContextConfidence = 'low';

  for (const layer of layers) {
    const input = layer.input;
    if (!input) {
      continue;
    }

    if (
      (currentInput.language && input.language === currentInput.language) ||
      (currentInput.locale && input.locale === currentInput.locale) ||
      (currentInput.timezone && input.timezone === currentInput.timezone)
    ) {
      currentSource = layer.source;
      currentConfidence = layer.confidence;
      break;
    }
  }

  const current: InteractionContext = {
    language: currentInput.language ?? null,
    locale: currentInput.locale ?? null,
    timezone: currentInput.timezone ?? null,
    source: currentSource,
    confidence: currentConfidence,
    resolvedAt: resolvedAtIso,
  };

  const preferenceSeedInput = mergeInteractionContextInputs(
    contactPreference,
    channelHint,
    legacyClientInfo,
    sessionPreference,
  );
  const promoteMessageHint = shouldPromoteMessageHintToPreference({
    messageHint,
    sessionCurrent: options.sessionCurrent,
    sessionPreference,
  });
  const preference =
    explicit.success && explicit.data
      ? buildSessionInteractionPreference(
          mergeInteractionContextInputs(preferenceSeedInput, explicit.data),
          'message',
          'explicit',
          resolvedAtIso,
        )
      : promoteMessageHint && messageHint
        ? buildSessionInteractionPreference(
            mergeInteractionContextInputs(preferenceSeedInput, messageHint),
            'message',
            messageHint.confidence,
            resolvedAtIso,
          )
        : (sessionPreference ??
          buildSessionInteractionPreference(
            mergeInteractionContextInputs(contactPreference, channelHint, legacyClientInfo),
            currentSource,
            currentConfidence,
            resolvedAtIso,
          ));

  const resolved: ResolvedInteractionContext = {
    current,
    ...(preference ? { preference } : {}),
    aliases: buildInteractionContextAliases(
      preference
        ? {
            current,
            preference,
          }
        : { current },
    ),
  };

  if (legacyClientInfo?.locale || legacyClientInfo?.timezone) {
    resolved.legacyInputs = {
      ...(legacyClientInfo.locale ? { clientInfoLocale: legacyClientInfo.locale } : {}),
      ...(legacyClientInfo.timezone ? { clientInfoTimezone: legacyClientInfo.timezone } : {}),
    };
  }

  if (explicit.success && explicit.issues.length > 0) {
    log.debug('Interaction context sanitized invalid explicit values', {
      issues: explicit.issues.map((issue) => issue.message),
    });
  }

  return resolved;
}

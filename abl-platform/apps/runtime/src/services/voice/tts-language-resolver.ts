import { createLogger } from '@abl/compiler/platform';
import { getVoiceProviderDefinition } from '@agent-platform/config';
import { getJambonzProvisioningService } from './jambonz-provisioning.service.js';
import type { JambonzSpeechOptions } from './jambonz-provisioning.service.js';
import { ORPHEUS_DEFAULT_VOICE } from './orpheus-tts.js';
import type { NormalizedSpeechLanguageCode } from './voice-language.js';

const log = createLogger('tts-language-resolver');

const SPEECH_OPTIONS_CACHE_MAX = 64;
const SPEECH_OPTIONS_CACHE_TTL_MS = 5 * 60 * 1000;
const SPEECH_OPTIONS_LOOKUP_TIMEOUT_MS = 1500;

type TtsLanguageResolutionReason =
  | 'no_reported_language'
  | 'already_configured'
  | 'supported'
  | 'unsupported'
  | 'lookup_unavailable';

export interface TtsLanguageResolutionInput {
  ttsVendor?: string;
  ttsVoice?: string;
  configuredLanguage?: string;
  tenantId?: string;
  reportedLanguage?: NormalizedSpeechLanguageCode;
}

export interface TtsLanguageResolution {
  vendor: string;
  configuredLanguage: string;
  configuredVoice?: string;
  effectiveLanguage: string;
  requestedLanguage?: string;
  requestedLocale?: string;
  reason: TtsLanguageResolutionReason;
  diagnosticCode?: string;
  languageChanged: boolean;
}

interface SpeechOptionsCacheEntry {
  expiresAt: number;
  options: JambonzSpeechOptions;
}

const speechOptionsCache = new Map<string, SpeechOptionsCacheEntry>();

function canonicalizeLocale(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  try {
    const [canonicalLocale] = Intl.getCanonicalLocales(value.trim());
    return canonicalLocale;
  } catch {
    return undefined;
  }
}

function canonicalizeLanguage(value: string | undefined): string | undefined {
  const canonicalLocale = canonicalizeLocale(value);
  return canonicalLocale?.split('-')[0]?.toLowerCase();
}

function resolveSpeechOptionsLabel(
  vendor: string,
  tenantId: string | undefined,
): string | undefined {
  if (!tenantId) {
    return undefined;
  }
  return vendor === 'elevenlabs' || vendor === 'cartesia' || vendor.startsWith('custom:')
    ? `t:${tenantId}`
    : undefined;
}

function buildCacheKey(vendor: string, label: string | undefined): string {
  return `${vendor}:${label ?? 'default'}`;
}

function rememberSpeechOptions(cacheKey: string, options: JambonzSpeechOptions): void {
  if (speechOptionsCache.size >= SPEECH_OPTIONS_CACHE_MAX) {
    const oldestKey = speechOptionsCache.keys().next().value as string | undefined;
    if (oldestKey) {
      speechOptionsCache.delete(oldestKey);
    }
  }
  speechOptionsCache.set(cacheKey, {
    expiresAt: Date.now() + SPEECH_OPTIONS_CACHE_TTL_MS,
    options,
  });
}

function getOrpheusSpeechOptions(): JambonzSpeechOptions {
  return {
    tts: [
      {
        code: 'en',
        name: 'English',
        voices: [
          { value: 'autumn', name: 'Autumn' },
          { value: 'diana', name: 'Diana' },
          { value: ORPHEUS_DEFAULT_VOICE, name: 'Hannah' },
          { value: 'austin', name: 'Austin' },
          { value: 'daniel', name: 'Daniel' },
          { value: 'troy', name: 'Troy' },
        ],
      },
    ],
    stt: [],
  };
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error('Speech options lookup timed out'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function getSpeechOptions(
  vendor: string,
  tenantId: string | undefined,
): Promise<JambonzSpeechOptions | undefined> {
  if (vendor === 'custom:orpheus') {
    return getOrpheusSpeechOptions();
  }

  const providerDefinition = getVoiceProviderDefinition(vendor);
  if (providerDefinition?.capabilities.supportsSpeechOptions !== true) {
    return undefined;
  }

  const label = resolveSpeechOptionsLabel(vendor, tenantId);
  const cacheKey = buildCacheKey(vendor, label);
  const cached = speechOptionsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.options;
  }

  const jambonz = getJambonzProvisioningService();
  const options = await withTimeout(
    jambonz.getSupportedLanguagesAndVoices(vendor, { label }),
    SPEECH_OPTIONS_LOOKUP_TIMEOUT_MS,
  );
  rememberSpeechOptions(cacheKey, options);
  return options;
}

function languageRowMatches(
  code: string,
  requestedLanguage: string,
  requestedLocale: string | undefined,
  exact: boolean,
): boolean {
  const canonicalCode = canonicalizeLocale(code);
  if (!canonicalCode) {
    return false;
  }

  if (exact) {
    return !!requestedLocale && canonicalCode.toLowerCase() === requestedLocale.toLowerCase();
  }

  return canonicalizeLanguage(canonicalCode) === requestedLanguage;
}

function rowSupportsVoice(
  row: JambonzSpeechOptions['tts'][number],
  configuredVoice: string | undefined,
): boolean {
  if (!configuredVoice || row.voices.length === 0) {
    return true;
  }

  return row.voices.some((voice) => voice.value === configuredVoice);
}

function findSupportedTtsLanguage(
  options: JambonzSpeechOptions,
  requestedLanguage: string,
  requestedLocale: string | undefined,
  configuredVoice: string | undefined,
): string | undefined {
  const exactRow = options.tts.find(
    (row) =>
      languageRowMatches(row.code, requestedLanguage, requestedLocale, true) &&
      rowSupportsVoice(row, configuredVoice),
  );
  if (exactRow) {
    return exactRow.code;
  }

  const languageRow = options.tts.find(
    (row) =>
      languageRowMatches(row.code, requestedLanguage, requestedLocale, false) &&
      rowSupportsVoice(row, configuredVoice),
  );

  return languageRow?.code;
}

export async function resolveTtsLanguageForVoiceTurn(
  input: TtsLanguageResolutionInput,
): Promise<TtsLanguageResolution> {
  const vendor = input.ttsVendor || 'elevenlabs';
  const configuredLanguage = input.configuredLanguage || 'en';
  const configuredVoice = input.ttsVoice;
  const requestedLanguage = input.reportedLanguage?.language;
  const requestedLocale = input.reportedLanguage?.locale;
  const configuredBaseLanguage = canonicalizeLanguage(configuredLanguage);

  if (!requestedLanguage) {
    return {
      vendor,
      configuredLanguage,
      configuredVoice,
      effectiveLanguage: configuredLanguage,
      reason: 'no_reported_language',
      languageChanged: false,
    };
  }

  if (configuredBaseLanguage === requestedLanguage) {
    return {
      vendor,
      configuredLanguage,
      configuredVoice,
      effectiveLanguage: configuredLanguage,
      requestedLanguage,
      requestedLocale,
      reason: 'already_configured',
      languageChanged: false,
    };
  }

  try {
    const options = await getSpeechOptions(vendor, input.tenantId);
    if (!options) {
      return {
        vendor,
        configuredLanguage,
        configuredVoice,
        effectiveLanguage: configuredLanguage,
        requestedLanguage,
        requestedLocale,
        reason: 'lookup_unavailable',
        diagnosticCode: 'VOICE_TTS_LANGUAGE_CAPABILITY_UNAVAILABLE',
        languageChanged: false,
      };
    }

    const supportedLanguage = findSupportedTtsLanguage(
      options,
      requestedLanguage,
      requestedLocale,
      configuredVoice,
    );
    if (!supportedLanguage) {
      return {
        vendor,
        configuredLanguage,
        configuredVoice,
        effectiveLanguage: configuredLanguage,
        requestedLanguage,
        requestedLocale,
        reason: 'unsupported',
        diagnosticCode: 'VOICE_TTS_LANGUAGE_UNSUPPORTED',
        languageChanged: false,
      };
    }

    return {
      vendor,
      configuredLanguage,
      configuredVoice,
      effectiveLanguage: supportedLanguage,
      requestedLanguage,
      requestedLocale,
      reason: 'supported',
      languageChanged: supportedLanguage !== configuredLanguage,
    };
  } catch (error) {
    log.debug('Keeping configured TTS language after speech-options lookup failure', {
      vendor,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      vendor,
      configuredLanguage,
      configuredVoice,
      effectiveLanguage: configuredLanguage,
      requestedLanguage,
      requestedLocale,
      reason: 'lookup_unavailable',
      diagnosticCode: 'VOICE_TTS_LANGUAGE_CAPABILITY_UNAVAILABLE',
      languageChanged: false,
    };
  }
}

export function clearTtsLanguageResolutionCache(): void {
  speechOptionsCache.clear();
}

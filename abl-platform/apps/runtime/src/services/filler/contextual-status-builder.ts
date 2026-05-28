import {
  getDefaultFillerMessage,
  getFillerMessage,
  type FillerMessageLocaleOptions,
} from './message-pools.js';
import type { FillerSource, StatusOperation } from './types.js';

export interface FillerStatusTextOptions extends FillerMessageLocaleOptions {
  isVoiceChannel: boolean;
  fallbackText?: string;
}

export interface StaticFillerCandidateOptions extends FillerStatusTextOptions {
  operation: StatusOperation;
  recentHistory?: string[];
}

export interface FillerStatusCandidate {
  operation: StatusOperation;
  text: string;
  source: FillerSource;
}

const CHAT_STATUS_MAX_CHARS = 180;
const VOICE_STATUS_MAX_CHARS = 96;
const STATUS_TAG_PATTERN = /<\/?status>/gi;
const UNSAFE_STATUS_PATTERN =
  /\b(agent|api|debug|delegate|endpoint|function|handoff|http|internal|json|llm|model|prompt|request payload|runtime|schema|system|tool|trace|variable|workflow)\b|(?:api|http|json|raw)\s+response/i;
const APOLOGY_STATUS_PATTERN = /\b(?:sorry|apolog(?:y|ies|ize|ise|ized|ised|izing|ising))\b/i;
const RAW_IDENTIFIER_PATTERN =
  /\b[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\b/i;
const QUESTION_MARK_PATTERN = /[?؟？]/u;
const COMPLETE_PHRASE_PATTERN = /(?:[.!?…。！？؟]|\.{3})$/u;
const TRAILING_ELLIPSIS_PATTERN = /\s*(?:\.{3}|…)\s*$/u;
const DEVANAGARI_SENTENCE_LANGUAGES = new Set(['hi', 'mr', 'ne']);
const CJK_SENTENCE_LANGUAGES = new Set(['ja', 'zh']);

function fallbackText(options: FillerStatusTextOptions): string {
  return options.fallbackText ?? getDefaultFillerMessage(options);
}

function compactStatusText(rawText: string): string {
  return rawText
    .replace(STATUS_TAG_PATTERN, '')
    .replace(/\s+/g, ' ')
    .replace(/^["'“”‘’]|["'“”‘’]$/g, '')
    .trim();
}

function resolveLanguageKey(options: FillerMessageLocaleOptions): string | null {
  const candidates = [options.locale, options.language];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }

    const normalized = candidate.trim().replace(/_/g, '-');
    if (!normalized) {
      continue;
    }

    try {
      const [canonical] = Intl.getCanonicalLocales(normalized);
      const languageKey = canonical?.toLowerCase().split('-')[0];
      if (languageKey) {
        return languageKey;
      }
    } catch {
      const languageKey = normalized.split('-')[0]?.toLowerCase();
      if (languageKey) {
        return languageKey;
      }
    }
  }

  return null;
}

function sentenceTerminator(options: FillerMessageLocaleOptions): string {
  const languageKey = resolveLanguageKey(options);
  if (languageKey && CJK_SENTENCE_LANGUAGES.has(languageKey)) {
    return '。';
  }
  if (languageKey && DEVANAGARI_SENTENCE_LANGUAGES.has(languageKey)) {
    return '।';
  }

  return '.';
}

function completePhrase(text: string, options: FillerMessageLocaleOptions): string {
  return COMPLETE_PHRASE_PATTERN.test(text) ? text : `${text}${sentenceTerminator(options)}`;
}

function truncateAtWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const suffix = '...';
  const limit = Math.max(1, maxChars - suffix.length);
  const truncated = text
    .slice(0, limit)
    .replace(/\s+\S*$/, '')
    .trim();
  return `${truncated || text.slice(0, limit).trim()}${suffix}`;
}

export function normalizeFillerStatusText(
  rawText: string,
  options: FillerStatusTextOptions,
): string | null {
  const fallback = fallbackText(options);
  const compact = compactStatusText(rawText);
  if (!compact) {
    return null;
  }

  if (
    QUESTION_MARK_PATTERN.test(compact) ||
    UNSAFE_STATUS_PATTERN.test(compact) ||
    APOLOGY_STATUS_PATTERN.test(compact) ||
    RAW_IDENTIFIER_PATTERN.test(compact)
  ) {
    return fallback;
  }

  if (options.isVoiceChannel) {
    const voiceText = compact.replace(TRAILING_ELLIPSIS_PATTERN, sentenceTerminator(options));
    if (voiceText.length > VOICE_STATUS_MAX_CHARS) {
      return fallback;
    }
    return completePhrase(voiceText, options);
  }

  return completePhrase(truncateAtWordBoundary(compact, CHAT_STATUS_MAX_CHARS), options);
}

export function buildStaticFillerCandidate(
  options: StaticFillerCandidateOptions,
): FillerStatusCandidate {
  const rawText = getFillerMessage(options.operation, options.recentHistory ?? [], undefined, {
    language: options.language,
    locale: options.locale,
    isVoiceChannel: options.isVoiceChannel,
  });
  const text = normalizeFillerStatusText(rawText, options) ?? fallbackText(options);

  return {
    operation: options.operation,
    text,
    source: 'static',
  };
}

/**
 * Pipeline-generated contextual filler messages.
 *
 * Fires a parallel call to the pipeline model (e.g. Qwen3.5-35B) at execution
 * start to generate a contextual status message from the user's query. The
 * result is queued and emitted on the first operation trace event.
 *
 * Priority: pipeline-generated > LLM <status> tags > static fallback pool.
 */

import { generateText, type LanguageModel } from 'ai';
import { createLogger } from '@abl/compiler/platform';
import { BUILT_IN_FILLER_PROMPT_TEMPLATE } from '@agent-platform/shared/prompts/builtin-runtime';
import { dumpLlmTrace } from '../llm/llm-trace.js';

const log = createLogger('pipeline-filler');

const FILLER_TIMEOUT_MS = 2000;
const FILLER_PROMPT_OVERRIDE_TIMEOUT_MS = 8000;
const FILLER_MAX_TOKENS = 30;
const FILLER_PROMPT_OVERRIDE_MAX_TOKENS = 90;
const FILLER_MAX_CHARS = 100;
const FILLER_PROMPT_OVERRIDE_MAX_CHARS = 320;
const CUSTOM_PROMPT_META_REASONING_PATTERN =
  /\b(?:required static sentence|filler paragraph|here is the requested filler response|i should|i need to (?:add|write|include|produce|generate|create|return|respond|proceed))\b/i;
const COMPLETE_PHRASE_PATTERN = /(?:[.!?…。！？؟]|\.{3})$/u;
const TRAILING_ELLIPSIS_PATTERN = /\s*(?:\.{3}|…)\s*$/u;
const ENGLISH_LANGUAGE_KEYS = new Set(['en', 'eng', 'english']);
const DEVANAGARI_SENTENCE_LANGUAGES = new Set(['hi', 'mr', 'ne']);
const CJK_SENTENCE_LANGUAGES = new Set(['ja', 'zh']);
const PROMPT_CONTEXT_PLACEHOLDER_PATTERN =
  /\{(?:languageHint|language|locale|presenceHint|presenceStyle)\}/;

export interface GeneratePipelineFillerOptions {
  promptOverride?: string | null;
  locale?: string;
  language?: string;
  isVoiceChannel?: boolean;
}

function normalizeGeneratedFillerText(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim()
    .replace(/^["'“”‘’]|["'“”‘’]$/g, '');
}

function compactCustomPromptFiller(text: string, maxChars: number): string {
  const hasMetaReasoning = CUSTOM_PROMPT_META_REASONING_PATTERN.test(text);
  if (!hasMetaReasoning && text.length <= maxChars) {
    return text;
  }

  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((sentence) => sentence.trim()) ?? [];
  if (sentences.length === 0) {
    return text;
  }

  const usefulSentences = sentences.filter(
    (sentence) => !CUSTOM_PROMPT_META_REASONING_PATTERN.test(sentence),
  );
  if (hasMetaReasoning && usefulSentences.length === 0) {
    return '';
  }

  const selected: string[] = [];
  for (const sentence of usefulSentences.length > 0 ? usefulSentences : sentences) {
    const candidate = [...selected, sentence].join(' ');
    if (candidate.length <= maxChars) {
      selected.push(sentence);
    }
  }

  return selected.join(' ');
}

function buildLanguageHint(options: GeneratePipelineFillerOptions | undefined): string {
  const parts: string[] = [];
  if (options?.language) {
    parts.push(`language: ${options.language}`);
  }
  if (options?.locale) {
    parts.push(`locale: ${options.locale}`);
  }

  return parts.length > 0 ? `Target ${parts.join(', ')}.` : '';
}

function buildPresenceHint(options: GeneratePipelineFillerOptions | undefined): string {
  if (!options?.isVoiceChannel) {
    return '';
  }

  return [
    'Voice channel: keep the status conversational, brief, and easy to say aloud.',
    'Use light, context-appropriate warmth from the user message, such as calm confidence or gentle reassurance when it clearly fits.',
    'Do not over-apologize, perform empathy, or invent commitments.',
  ].join(' ');
}

function resolveLanguageKey(options: GeneratePipelineFillerOptions | undefined): string | null {
  const candidates = [options?.locale, options?.language];

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

function sentenceTerminator(options: GeneratePipelineFillerOptions | undefined): string {
  const languageKey = resolveLanguageKey(options);
  if (languageKey && CJK_SENTENCE_LANGUAGES.has(languageKey)) {
    return '。';
  }
  if (languageKey && DEVANAGARI_SENTENCE_LANGUAGES.has(languageKey)) {
    return '।';
  }

  return '.';
}

function shouldUseLegacyEllipsis(options: GeneratePipelineFillerOptions | undefined): boolean {
  const languageKey = resolveLanguageKey(options);
  return !languageKey || ENGLISH_LANGUAGE_KEYS.has(languageKey);
}

function completeGeneratedFillerText(
  text: string,
  options: GeneratePipelineFillerOptions | undefined,
): string {
  if (shouldUseLegacyEllipsis(options)) {
    return text.endsWith('...') ? text : text.replace(/[.!]$/, '') + '...';
  }

  const terminator = sentenceTerminator(options);
  if (TRAILING_ELLIPSIS_PATTERN.test(text)) {
    return text.replace(TRAILING_ELLIPSIS_PATTERN, terminator);
  }
  return COMPLETE_PHRASE_PATTERN.test(text) ? text : `${text}${terminator}`;
}

function buildFillerPrompt(userMessage: string, options: GeneratePipelineFillerOptions): string {
  const languageHint = buildLanguageHint(options);
  const presenceHint = buildPresenceHint(options);
  const rawPrompt = options.promptOverride ?? BUILT_IN_FILLER_PROMPT_TEMPLATE;
  const prompt = rawPrompt
    .replace(/\{userMessage\}/g, userMessage)
    .replace(/\{languageHint\}/g, languageHint)
    .replace(/\{language\}/g, options.language ?? '')
    .replace(/\{locale\}/g, options.locale ?? '')
    .replace(/\{presenceHint\}/g, presenceHint)
    .replace(/\{presenceStyle\}/g, 'neutral');

  if (
    typeof options.promptOverride === 'string' &&
    (languageHint || presenceHint) &&
    !PROMPT_CONTEXT_PLACEHOLDER_PATTERN.test(rawPrompt)
  ) {
    return [prompt, languageHint, presenceHint].filter(Boolean).join('\n\n');
  }

  return prompt;
}

/**
 * Generate a contextual filler message using the pipeline model.
 * Returns null if generation fails or times out — caller falls back to static pool.
 */
export async function generatePipelineFiller(
  model: LanguageModel,
  userMessage: string,
  options: GeneratePipelineFillerOptions = {},
): Promise<string | null> {
  const modelId = typeof model === 'string' ? model : model.modelId;

  try {
    const hasPromptOverride = typeof options?.promptOverride === 'string';
    const maxOutputTokens = hasPromptOverride
      ? FILLER_PROMPT_OVERRIDE_MAX_TOKENS
      : FILLER_MAX_TOKENS;
    const maxChars = hasPromptOverride ? FILLER_PROMPT_OVERRIDE_MAX_CHARS : FILLER_MAX_CHARS;
    const timeoutMs = hasPromptOverride ? FILLER_PROMPT_OVERRIDE_TIMEOUT_MS : FILLER_TIMEOUT_MS;
    const prompt = buildFillerPrompt(userMessage, options);

    dumpLlmTrace('request', 'pipeline:filler', modelId, {
      pipelinePhase: 'filler',
      prompt,
      maxOutputTokens,
      temperature: 0,
    });

    const start = Date.now();
    const result = await generateText({
      model,
      prompt,
      maxOutputTokens,
      temperature: 0,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });

    const normalizedText = normalizeGeneratedFillerText(result.text);
    const text = hasPromptOverride
      ? compactCustomPromptFiller(normalizedText, maxChars)
      : normalizedText;
    if (!text || text.length > maxChars || text.toUpperCase() === 'NONE') return null;

    // Preserve custom prompt punctuation; default short fillers keep the legacy ellipsis style.
    const normalized = hasPromptOverride ? text : completeGeneratedFillerText(text, options);
    const latencyMs = Date.now() - start;

    dumpLlmTrace('response', 'pipeline:filler', modelId, {
      pipelinePhase: 'filler',
      latencyMs,
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      rawText: result.text,
      filler: normalized,
    });

    log.debug('Pipeline filler generated', {
      userMessage: userMessage.slice(0, 80),
      filler: normalized,
      latencyMs,
    });

    return normalized;
  } catch (err) {
    log.debug('Pipeline filler generation failed — falling back to static', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Language Detection and Locale Utilities
 *
 * Provides language detection, code-switching detection,
 * and locale-aware processing utilities.
 */

import type { LanguageResult, NLUModelLayerConfig, LLMProvider } from './types.js';
import { renderTemplate, loadPromptTemplate } from './prompt-loader.js';
import { detectLanguageFallback } from './fallbacks.js';
import { parseJSON } from './utils.js';

// =============================================================================
// LANGUAGE DETECTION
// =============================================================================

/**
 * Detect language using LLM with fallback to regex
 */
export async function detectLanguage(
  message: string,
  layerConfig: NLUModelLayerConfig,
): Promise<LanguageResult> {
  try {
    const template = loadPromptTemplate('language');
    const systemPrompt = renderTemplate(template.system, {});

    const response = await layerConfig.provider.chat(
      systemPrompt,
      [{ role: 'user', content: message }],
      {
        model: layerConfig.model,
        timeoutMs: layerConfig.timeoutMs ?? 2000,
      },
    );

    const parsed = parseJSON<{
      primary: string;
      secondary?: string;
      isCodeSwitched?: boolean;
      confidence?: number;
    }>(response);

    if (parsed && parsed.primary) {
      return {
        primary: parsed.primary,
        secondary: parsed.secondary || undefined,
        isCodeSwitched: parsed.isCodeSwitched ?? false,
        confidence: parsed.confidence ?? 0.8,
      };
    }
  } catch {
    // Fall through to regex
  }

  return detectLanguageFallback(message);
}

// =============================================================================
// LANGUAGE SESSION CACHE
// =============================================================================

/**
 * Simple per-session language cache.
 * Language rarely changes mid-conversation, so we cache the first detection.
 */
export class LanguageSessionCache {
  private cache = new Map<string, { language: string; detectedAt: number }>();
  private ttlMs: number;

  constructor(ttlMs: number = 600_000) {
    // 10 minute default TTL
    this.ttlMs = ttlMs;
  }

  get(sessionId: string): string | null {
    const entry = this.cache.get(sessionId);
    if (!entry) return null;
    if (Date.now() - entry.detectedAt > this.ttlMs) {
      this.cache.delete(sessionId);
      return null;
    }
    return entry.language;
  }

  set(sessionId: string, language: string): void {
    this.cache.set(sessionId, { language, detectedAt: Date.now() });
  }

  clear(sessionId: string): void {
    this.cache.delete(sessionId);
  }
}

// =============================================================================
// LOCALE UTILITIES
// =============================================================================

/**
 * Date format preference by locale
 */
export function getDateFormat(locale: string): 'MDY' | 'DMY' | 'YMD' {
  const mdyLocales = ['en-US', 'en'];
  const ymdLocales = ['zh', 'ja', 'ko', 'hu'];

  if (mdyLocales.includes(locale)) return 'MDY';
  if (ymdLocales.some((l) => locale.startsWith(l))) return 'YMD';
  return 'DMY'; // Most of the world uses DMY
}

/**
 * Number decimal separator by locale
 */
export function getDecimalSeparator(locale: string): '.' | ',' {
  const dotLocales = ['en', 'zh', 'ja', 'ko'];
  if (dotLocales.some((l) => locale.startsWith(l))) return '.';
  return ','; // Most of Europe, South America uses comma
}

/**
 * Filter few-shot examples to match the detected language
 */
export function filterExamplesByLanguage(
  examples: Array<{ input: string; output: string; language?: string }>,
  language: string,
): Array<{ input: string; output: string; language?: string }> {
  // First try exact language match
  const matched = examples.filter((e) => e.language === language);
  if (matched.length > 0) return matched;

  // Fall back to all examples (useful when language-tagged examples aren't available)
  return examples;
}

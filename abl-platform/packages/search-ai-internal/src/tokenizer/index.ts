/**
 * Unified Token Counter
 *
 * Provides accurate token counting using tiktoken instead of character-based heuristics.
 * Configurable via TOKENIZER_MODEL environment variable.
 *
 * Usage:
 *   import { countTokens, getTokenizerInfo } from '@agent-platform/search-ai-internal/tokenizer';
 *
 *   const count = countTokens("Some text to count");
 *   const info = getTokenizerInfo();
 */

import tiktoken from 'tiktoken';

// Supported tiktoken models (tiktoken 1.0.x)
export const SUPPORTED_MODELS = {
  cl100k_base: 'GPT-4, GPT-3.5-turbo, text-embedding-ada-002',
  p50k_base: 'GPT-3 (Davinci, Curie, Babbage, Ada)',
  r50k_base: 'GPT-3 (older models)',
} as const;

export type SupportedTokenizerModel = keyof typeof SUPPORTED_MODELS;

// Default model if not specified
const DEFAULT_MODEL: SupportedTokenizerModel = 'cl100k_base';

// Global tokenizer instance (lazy-loaded)
let _tokenizer: ReturnType<typeof tiktoken.get_encoding> | null = null;
let _tokenizerModel: string | null = null;
let _initializationError: Error | null = null;

/**
 * Get or initialize the tiktoken tokenizer.
 *
 * Uses TOKENIZER_MODEL environment variable to select encoding.
 * Falls back to cl100k_base (GPT-4) if not specified.
 */
function getTokenizer(): ReturnType<typeof tiktoken.get_encoding> | null {
  // Get model from environment
  const model = (process.env.TOKENIZER_MODEL || DEFAULT_MODEL) as SupportedTokenizerModel;

  // Return cached tokenizer if model hasn't changed
  if (_tokenizer && _tokenizerModel === model) {
    return _tokenizer;
  }

  // Return null if previous initialization failed
  if (_initializationError && _tokenizerModel === model) {
    return null;
  }

  try {
    // Validate model
    if (!(model in SUPPORTED_MODELS)) {
      console.warn(
        `[Tokenizer] Unknown tokenizer model '${model}', falling back to '${DEFAULT_MODEL}'. ` +
          `Supported models: ${Object.keys(SUPPORTED_MODELS).join(', ')}`,
      );
      _tokenizer = tiktoken.get_encoding(DEFAULT_MODEL);
      _tokenizerModel = DEFAULT_MODEL;
    } else {
      _tokenizer = tiktoken.get_encoding(model);
      _tokenizerModel = model;
    }

    console.log(
      `[Tokenizer] Initialized tiktoken with model: ${_tokenizerModel} (${SUPPORTED_MODELS[_tokenizerModel as SupportedTokenizerModel]})`,
    );

    _initializationError = null;
    return _tokenizer;
  } catch (error) {
    _initializationError = error instanceof Error ? error : new Error(String(error));
    console.error(
      `[Tokenizer] Failed to initialize tiktoken: ${_initializationError.message}\n` +
        'Falling back to character-based estimation (INACCURATE)',
    );
    return null;
  }
}

/**
 * Count tokens in text using tiktoken.
 *
 * Falls back to character-based estimation if tiktoken unavailable.
 *
 * @param text - Text to count tokens for
 * @returns Accurate token count
 *
 * @example
 * ```typescript
 * countTokens("Hello, world!")  // → 4
 * countTokens("This is a longer sentence.")  // → 6
 * ```
 */
export function countTokens(text: string): number {
  if (!text) {
    return 0;
  }

  const tokenizer = getTokenizer();

  if (tokenizer) {
    try {
      const tokens = tokenizer.encode(text);
      return tokens.length;
    } catch (error) {
      console.warn(
        `[Tokenizer] Encoding failed: ${error instanceof Error ? error.message : String(error)}, ` +
          'falling back to character estimate',
      );
      return fallbackCountTokens(text);
    }
  } else {
    // Fallback to character-based estimation
    return fallbackCountTokens(text);
  }
}

/**
 * Fallback character-based token estimation.
 *
 * INACCURATE: Only use when tiktoken unavailable.
 * Assumes ~4 characters per token (rough average for English).
 *
 * @param text - Text to estimate tokens for
 * @returns Estimated token count
 */
function fallbackCountTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Count tokens for multiple texts efficiently.
 *
 * @param texts - Array of text strings
 * @returns Token counts for each text
 *
 * @example
 * ```typescript
 * countTokensBatch(["Hello", "World", "Test"])  // → [1, 1, 1]
 * ```
 */
export function countTokensBatch(texts: string[]): number[] {
  return texts.map((text) => countTokens(text));
}

/**
 * Get information about the current tokenizer configuration.
 *
 * @returns Tokenizer metadata
 *
 * @example
 * ```typescript
 * getTokenizerInfo()
 * // → {
 * //   model: 'cl100k_base',
 * //   description: 'GPT-4, GPT-3.5-turbo, text-embedding-ada-002',
 * //   available: true,
 * //   source: 'environment',
 * //   fallback: false
 * // }
 * ```
 */
export function getTokenizerInfo(): {
  model: string;
  description: string;
  available: boolean;
  source: 'environment' | 'default';
  fallback: boolean;
  error?: string;
} {
  const model = (process.env.TOKENIZER_MODEL || DEFAULT_MODEL) as SupportedTokenizerModel;
  const tokenizer = getTokenizer();

  return {
    model,
    description: SUPPORTED_MODELS[model] || 'Unknown model',
    available: tokenizer !== null,
    source: process.env.TOKENIZER_MODEL ? 'environment' : 'default',
    fallback: tokenizer === null,
    error: _initializationError?.message,
  };
}

/**
 * Cleanup tokenizer resources.
 * Call this on application shutdown.
 */
export function closeTokenizer(): void {
  if (_tokenizer) {
    _tokenizer.free();
    _tokenizer = null;
    _tokenizerModel = null;
  }
}

/**
 * Alias for countTokens() for backward compatibility.
 *
 * @param text - Text to count tokens for
 * @returns Token count
 */
export function estimateTokens(text: string): number {
  return countTokens(text);
}

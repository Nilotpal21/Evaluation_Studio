/**
 * LLM Provider Module
 *
 * Generic LLM provider abstraction that supports:
 * - Multiple providers (Anthropic, OpenAI, LiteLLM, custom)
 * - Streaming responses
 * - Tool use / function calling
 * - Model selection based on complexity
 *
 * Provider-agnostic design allows easy switching between backends.
 */

export * from './types.js';
export * from './provider.js';
export * from './providers/index.js';
export * from './cache.js';
export * from './realtime/index.js';
export { LLMClient } from './provider.js';

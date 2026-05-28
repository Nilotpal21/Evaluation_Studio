/**
 * LLM provider factory.
 *
 * Reads PROVIDER + credential env vars and returns a configured LLMClient.
 */

import type { LLMClient } from '../types.js';
import { createAnthropicClient } from './anthropic.js';
import { createOpenAIClient } from './openai.js';
import { createCustomClient } from './custom.js';

export type ProviderName = 'anthropic' | 'openai' | 'custom';

/**
 * Inspect environment variables and return a configured LLM client.
 *
 * - `PROVIDER=anthropic` (default): requires `ANTHROPIC_API_KEY`.
 * - `PROVIDER=openai`: requires `OPENAI_API_KEY`.
 * - `PROVIDER=custom`: requires `CUSTOM_LLM_BASE_URL`, `CUSTOM_LLM_API_KEY`, `CUSTOM_LLM_MODEL`.
 *
 * Optional `MODEL` env var overrides the default model for anthropic/openai providers.
 *
 * @throws Error with a specific message if required credentials are missing.
 */
export function pickLLMFromEnv(): LLMClient {
  const provider = (process.env.PROVIDER || 'anthropic') as ProviderName;
  const model = process.env.MODEL;

  switch (provider) {
    case 'anthropic': {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY is required when PROVIDER=anthropic');
      }
      return createAnthropicClient(apiKey, model);
    }

    case 'openai': {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY is required when PROVIDER=openai');
      }
      return createOpenAIClient(apiKey, model);
    }

    case 'custom': {
      const baseURL = process.env.CUSTOM_LLM_BASE_URL;
      const apiKey = process.env.CUSTOM_LLM_API_KEY;
      const customModel = model || process.env.CUSTOM_LLM_MODEL;
      if (!baseURL) {
        throw new Error('CUSTOM_LLM_BASE_URL is required when PROVIDER=custom');
      }
      if (!apiKey) {
        throw new Error('CUSTOM_LLM_API_KEY is required when PROVIDER=custom');
      }
      if (!customModel) {
        throw new Error('CUSTOM_LLM_MODEL (or MODEL) is required when PROVIDER=custom');
      }
      return createCustomClient(baseURL, apiKey, customModel);
    }

    default:
      throw new Error(`Unknown PROVIDER: "${provider}". Expected: anthropic, openai, or custom.`);
  }
}

/**
 * LLM Provider Configuration and Utilities
 *
 * Note: As of the Vercel AI SDK migration, provider instantiation now happens
 * in the runtime layer using Vercel AI SDK packages.
 *
 * This file maintains configuration types and utility functions for backward
 * compatibility and shared provider logic.
 *
 * Provider instantiation now happens in:
 * - apps/runtime/src/services/llm/session-llm-client.ts
 */

import type {
  LLMProvider,
  LLMProviderType,
  ProviderConfig,
  ModelTier,
  Message,
  ContentBlock,
  ToolCompletionOptions,
  ToolCompletionResult,
} from './types.js';
import { createLogger } from '../logger.js';
import { canonicalizeLlmProviderName } from '@agent-platform/shared-kernel/llm-provider-identity';

const log = createLogger('llm-provider');

// =============================================================================
// CONFIGURATION HELPERS
// =============================================================================

/**
 * Extract API key from config or environment variable
 */
export function getApiKey(config: { apiKey?: string; apiKeyEnvVar?: string }): string {
  if (config.apiKey) {
    return config.apiKey;
  }

  if (config.apiKeyEnvVar) {
    const key = process.env[config.apiKeyEnvVar];
    if (!key) {
      throw new Error(`API key not found in environment variable: ${config.apiKeyEnvVar}`);
    }
    return key;
  }

  throw new Error('No API key provided in config or environment');
}

/**
 * Sanitize error messages to remove potential API keys
 */
export function sanitizeErrorMessage(error: string): string {
  return error
    .replace(/sk-ant-[a-zA-Z0-9\-_]{10,}/g, 'sk-***') // Anthropic keys (sk-ant-api03-...)
    .replace(/sk-[a-zA-Z0-9\-_]{10,}/g, 'sk-***') // OpenAI keys (sk-proj-..., sk-...)
    .replace(/[?&]key=[a-zA-Z0-9\-_]{10,}/g, '?key=***') // URL key params (Gemini ?key=AIza...)
    .replace(/x-api-key:\s*[a-zA-Z0-9\-_]{10,}/gi, 'x-api-key: ***') // x-api-key header values
    .replace(/[a-f0-9]{32,}/gi, '***') // Generic hex tokens (32+ chars)
    .replace(/Bearer\s+[a-zA-Z0-9\-_\.]+/gi, 'Bearer ***'); // Bearer tokens
}

/**
 * Validate provider configuration
 */
export function validateProviderConfig(config: ProviderConfig): void {
  if (!config.provider) {
    throw new Error('Provider type is required');
  }

  if (!config.apiKey && !config.apiKeyEnvVar) {
    throw new Error('API key or API key environment variable is required');
  }
}

// =============================================================================
// DEFAULT MODEL MAPPINGS
// =============================================================================

/**
 * Default model recommendations by provider and tier
 */
export const DEFAULT_MODEL_MAPPINGS: Record<string, Record<string, string>> = {
  anthropic: {
    fast: 'claude-haiku-4-5-20251022',
    balanced: 'claude-sonnet-4-5-20250514',
    powerful: 'claude-opus-4-7',
    voice: 'claude-sonnet-4-5-20250514',
  },
  openai: {
    fast: 'gpt-4o-mini',
    balanced: 'gpt-4o',
    powerful: 'o1',
    voice: 'gpt-4o-realtime',
  },
  google: {
    fast: 'gemini-2.0-flash-exp',
    balanced: 'gemini-2.5-pro',
    powerful: 'gemini-2.5-pro',
    voice: 'gemini-2.0-flash-exp',
  },
  vertex: {
    fast: 'gemini-2.0-flash',
    balanced: 'gemini-2.5-pro',
    powerful: 'gemini-2.5-pro',
    voice: 'gemini-2.0-flash',
  },
  azure: {
    fast: 'gpt-4o-mini',
    balanced: 'gpt-4o',
    powerful: 'gpt-4o',
    voice: 'gpt-4o-realtime',
  },
  cohere: {
    fast: 'command-r',
    balanced: 'command-r-plus',
    powerful: 'command-r-plus',
    voice: 'command-r',
  },
};

/**
 * Get default model for a provider and tier
 */
export function getDefaultModel(provider: string, tier: string = 'balanced'): string {
  const providerModels = DEFAULT_MODEL_MAPPINGS[canonicalizeLlmProviderName(provider)];
  if (!providerModels) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const model = providerModels[tier];
  if (!model) {
    throw new Error(`Unknown tier: ${tier} for provider: ${provider}`);
  }

  return model;
}

// =============================================================================
// DEPRECATED FUNCTIONS (kept for backward compatibility)
// =============================================================================

/**
 * @deprecated Provider instantiation now happens in SessionLLMClient using Vercel AI SDK.
 * This function is kept for backward compatibility with existing tests.
 */
export function createProvider(config: ProviderConfig): LLMProvider {
  throw new Error(
    'createProvider() is deprecated. ' +
      'Provider instantiation now happens in SessionLLMClient using Vercel AI SDK. ' +
      'See apps/runtime/src/services/llm/session-llm-client.ts',
  );
}

/**
 * @deprecated Provider registration is no longer needed with Vercel AI SDK.
 */
export function registerProvider(type: LLMProviderType, factory: any): void {
  log.warn('registerProvider() is deprecated and has no effect');
}

/**
 * @deprecated No longer needed with Vercel AI SDK.
 */
export function getProviderFactory(type: LLMProviderType): any {
  throw new Error('getProviderFactory() is deprecated');
}

/**
 * @deprecated No longer needed with Vercel AI SDK.
 */
export function setDefaultProvider(config: ProviderConfig): void {
  log.warn('setDefaultProvider() is deprecated and has no effect');
}

/**
 * @deprecated No longer needed with Vercel AI SDK.
 */
export function getDefaultProvider(): LLMProvider {
  throw new Error('getDefaultProvider() is deprecated');
}

// =============================================================================
// LLMClient CLASS (backward compatibility for search-ai workers)
// =============================================================================

/**
 * @deprecated Runtime code should use SessionLLMClient (Vercel AI SDK).
 * This class is preserved for search-ai workers and compiler tests that
 * construct an LLMClient directly with a provider instance or config.
 */
export class LLMClient {
  private provider: LLMProvider;

  constructor(providerOrConfig?: LLMProvider | ProviderConfig) {
    if (!providerOrConfig) {
      this.provider = getDefaultProvider();
    } else if ('provider' in providerOrConfig) {
      this.provider = createProvider(providerOrConfig as ProviderConfig);
    } else {
      this.provider = providerOrConfig as LLMProvider;
    }
  }

  async chat(
    systemPrompt: string,
    messages: Array<{ role: string; content: string | ContentBlock[] }>,
    options: { model: string; timeoutMs?: number; maxTokens?: number },
  ): Promise<string> {
    const result = await this.provider.complete(
      systemPrompt,
      messages.map((m) => ({ role: m.role as Message['role'], content: m.content })),
      {
        model: options.model,
        timeoutMs: options.timeoutMs,
        maxTokens: options.maxTokens,
      },
    );
    return result.text;
  }

  async chatWithTools(
    systemPrompt: string,
    messages: Message[],
    tools: ToolCompletionOptions['tools'],
    options: { model: string; timeoutMs?: number; maxTokens?: number },
  ): Promise<ToolCompletionResult> {
    return this.provider.completeWithTools(systemPrompt, messages, {
      model: options.model,
      timeoutMs: options.timeoutMs,
      maxTokens: options.maxTokens,
      tools,
    });
  }

  async *streamChat(
    systemPrompt: string,
    messages: Array<{ role: string; content: string | ContentBlock[] }>,
    options: { model: string; timeoutMs?: number; maxTokens?: number },
  ): AsyncIterable<string> {
    const stream = this.provider.streamComplete(
      systemPrompt,
      messages.map((m) => ({ role: m.role as Message['role'], content: m.content })),
      {
        model: options.model,
        timeoutMs: options.timeoutMs,
        maxTokens: options.maxTokens,
        stream: true,
      },
    );
    for await (const event of stream) {
      if (event.type === 'text_delta') {
        yield event.text;
      }
    }
  }

  async extractJson(
    systemPrompt: string,
    messages: Array<{ role: string; content: string }>,
    schema: string,
    options: { model: string; timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    if (this.provider.supportsFeature('tools')) {
      return this.extractJsonViaToolUse(systemPrompt, messages, schema, options);
    }
    return this.extractJsonViaPrompt(systemPrompt, messages, schema, options);
  }

  private async extractJsonViaToolUse(
    systemPrompt: string,
    messages: Array<{ role: string; content: string }>,
    schema: string,
    options: { model: string; timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    const { properties, required: requiredFields } = parseSchemaString(schema);

    const tool: ToolCompletionOptions['tools'][0] = {
      name: 'extract_fields',
      description: 'Extract structured data from the conversation',
      input_schema: { type: 'object', properties, required: requiredFields },
    };

    try {
      const result = await this.provider.completeWithTools(
        systemPrompt,
        messages.map((m) => ({ role: m.role as Message['role'], content: m.content })),
        { model: options.model, timeoutMs: options.timeoutMs, tools: [tool], toolChoice: 'any' },
      );

      const toolCall = result.toolCalls?.[0];
      if (toolCall && toolCall.input) {
        return toolCall.input as Record<string, unknown>;
      }
    } catch (err) {
      log.warn('Tool-use extraction failed, falling back to prompt', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Fallback to prompt-based extraction
    return this.extractJsonViaPrompt(systemPrompt, messages, schema, options);
  }

  private async extractJsonViaPrompt(
    systemPrompt: string,
    messages: Array<{ role: string; content: string }>,
    schema: string,
    options: { model: string; timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    const extractionPrompt = `${systemPrompt}\n\nExtract the following fields as JSON:\n${schema}\n\nRespond ONLY with valid JSON.`;
    const result = await this.provider.complete(
      extractionPrompt,
      messages.map((m) => ({ role: m.role as Message['role'], content: m.content })),
      { model: options.model, timeoutMs: options.timeoutMs },
    );
    try {
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    } catch {
      return {};
    }
  }

  getModelForTier(tier: ModelTier): string {
    return this.provider.getModelForTier(tier);
  }

  getProvider(): LLMProvider {
    return this.provider;
  }

  supportsFeature(feature: 'streaming' | 'tools' | 'vision'): boolean {
    return this.provider.supportsFeature(feature);
  }
}

// =============================================================================
// SCHEMA PARSING HELPER
// =============================================================================

/**
 * Parse a JSON schema string into properties and required fields.
 * Used by LLMClient.extractJsonViaToolUse for forced tool use extraction.
 */
export function parseSchemaString(schema: string): {
  properties: Record<string, { type: string; description?: string }>;
  required: string[];
} {
  const properties: Record<string, { type: string; description?: string }> = {};
  const required: string[] = [];

  try {
    const parsed = JSON.parse(schema);
    for (const [key, value] of Object.entries(parsed)) {
      const typeStr = String(value).toLowerCase().trim();
      let mappedType: string;
      switch (typeStr) {
        case 'string':
        case 'string or null':
          mappedType = 'string';
          break;
        case 'number':
        case 'integer':
        case 'number or null':
          mappedType = 'number';
          break;
        case 'boolean':
        case 'boolean or null':
          mappedType = 'boolean';
          break;
        case 'array':
          mappedType = 'array';
          break;
        case 'object':
          mappedType = 'object';
          break;
        default:
          mappedType = 'string';
      }
      properties[key] = { type: mappedType };
      if (!typeStr.includes('or null')) {
        required.push(key);
      }
    }
  } catch {
    log.warn('Failed to parse schema string', { schema });
  }

  return { properties, required };
}

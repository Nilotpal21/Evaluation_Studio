import { z } from 'zod';

/**
 * LLM configuration schema.
 *
 * Reconciles the runtime schema (anthropicApiKey, openaiApiKey, etc.)
 * with PlatformConfig.LLMConfig (provider, apiKey, baseUrl, etc.)
 */
export const LLMConfigSchema = z.object({
  anthropicApiKey: z.string().optional(),
  anthropicBaseUrl: z.string().url().default('https://api.anthropic.com'),
  anthropicVersion: z.string().default('2023-06-01'),
  openaiApiKey: z.string().optional(),
  geminiApiKey: z.string().optional(),
  litellmProxyUrl: z.string().url().optional(),
  defaultModel: z.string().default('claude-sonnet-4-20250514'),
  fastModel: z.string().default('claude-haiku-4-5-20251001'),
  voiceModel: z.string().optional(),
  maxTokens: z.coerce.number().int().positive().default(4096),
  temperature: z.coerce.number().min(0).max(2).default(0.7),
  timeoutMs: z.coerce.number().int().positive().default(30000),
  provider: z
    .enum(['openai', 'anthropic', 'azure', 'bedrock', 'litellm', 'gemini', 'google'])
    .default('anthropic'),
  fallbackModels: z.array(z.string()).default([]),
  cacheEnabled: z.boolean().default(false),
  cacheDir: z.string().optional(),
  cacheTtlMs: z.coerce.number().int().positive().default(3600000),
});

export type LLMConfig = z.infer<typeof LLMConfigSchema>;

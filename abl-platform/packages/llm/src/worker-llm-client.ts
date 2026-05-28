/**
 * Worker LLM Client
 *
 * Lightweight LLM client for SearchAI workers that provides the same
 * `.chat()` interface that services (QuestionSynthesisService,
 * ProgressiveSummarizationService, TreeBuilderService, etc.) expect.
 *
 * Uses Vercel AI SDK via createVercelProvider() internally.
 * Each instance is tied to a specific provider/apiKey/model — workers
 * create one per job using resolved per-index LLM config.
 */

import { generateText, type LanguageModel, type FinishReason } from 'ai';
import { createVercelProvider } from './provider-factory.js';
import { getDefaultModel } from '@abl/compiler/platform/llm/provider.js';
import type { ContentBlock, ModelTier, ToolDefinition } from '@abl/compiler/platform/llm/types.js';
import { convertTools, convertMessages } from './tool-adapters.js';

/** Default timeout for LLM calls in workers (2 minutes). */
const DEFAULT_WORKER_LLM_TIMEOUT_MS = 120_000;

export interface WorkerLLMClientOptions {
  baseUrl?: string;
  useResponsesApi?: boolean;
  authConfig?: Record<string, unknown>;
}

export interface ToolUseResult {
  text: string;
  toolCalls: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
  finishReason: FinishReason;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export class WorkerLLMClient {
  private model: LanguageModel;
  private providerType: string;
  private defaultModelId: string;

  constructor(provider: string, apiKey: string, modelId: string, options?: WorkerLLMClientOptions) {
    this.providerType = provider;
    this.defaultModelId = modelId;
    this.model = createVercelProvider(
      provider,
      apiKey,
      options?.baseUrl,
      modelId,
      options?.useResponsesApi,
      options?.authConfig,
    );
  }

  /**
   * Simple chat completion — matches the interface SearchAI services expect.
   *
   * @param systemPrompt - System prompt
   * @param messages - Conversation messages
   * @param options - Optional model, maxTokens, timeoutMs overrides
   * @returns The model's text response
   */
  async chat(
    systemPrompt: string,
    messages: Array<{ role: string; content: string | ContentBlock[] }>,
    options?: { model?: string; maxTokens?: number; timeoutMs?: number },
  ): Promise<string> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_WORKER_LLM_TIMEOUT_MS;
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);

    try {
      const result = await generateText({
        model: this.model,
        system: systemPrompt,
        messages: messages.map((m) => {
          const role = m.role as 'user' | 'assistant';
          if (role === 'user') {
            return {
              role: 'user' as const,
              content:
                typeof m.content === 'string'
                  ? m.content
                  : this.convertUserContentBlocks(m.content),
            };
          }
          return {
            role: 'assistant' as const,
            content:
              typeof m.content === 'string'
                ? m.content
                : m.content.map((b) => ({
                    type: 'text' as const,
                    text: b.type === 'text' ? b.text : JSON.stringify(b),
                  })),
          };
        }),
        maxOutputTokens: options?.maxTokens,
        maxRetries: 2,
        abortSignal: abortController.signal,
      });

      return result.text;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * Convert platform ContentBlock[] to Vercel AI SDK content format.
   * Handles text, images (base64 and URL), and other content types.
   *
   * CRITICAL FIX: Use Uint8Array for base64 images instead of data URLs.
   * The Vercel AI SDK converts Uint8Array to provider-native format automatically,
   * avoiding data: URL validation errors from some providers.
   */
  private convertUserContentBlocks(
    blocks: ContentBlock[],
  ): Array<{ type: 'text'; text: string } | { type: 'image'; image: Uint8Array | URL }> {
    return blocks.map((block) => {
      if (block.type === 'text') {
        return { type: 'text' as const, text: block.text };
      } else if (block.type === 'image') {
        // Image content from platform format
        if (block.source.type === 'base64') {
          // Convert base64 string to Uint8Array (binary data)
          // The AI SDK handles Uint8Array → provider-native base64 conversion
          // This avoids "URL scheme must be http or https, got data:" errors
          const buffer = Buffer.from(block.source.data, 'base64');
          return {
            type: 'image' as const,
            image: new Uint8Array(buffer),
          };
        } else if (block.source.type === 'url') {
          // For http/https URLs, pass as URL object
          return {
            type: 'image' as const,
            image: new URL(block.source.url),
          };
        }
      }
      // Fallback: stringify unknown block types
      return { type: 'text' as const, text: JSON.stringify(block) };
    });
  }

  /**
   * Chat completion with tool use support.
   *
   * Converts platform ToolDefinition[] to Vercel AI SDK format and returns
   * structured tool call results alongside text. Used by crawler intelligence
   * loop and other services that need LLM-driven tool orchestration.
   *
   * @param systemPrompt - System prompt
   * @param messages - Conversation messages (supports ContentBlock[] for multi-turn tool use)
   * @param tools - Platform ToolDefinition[] to make available to the model
   * @param options - Optional model, maxTokens, timeoutMs, toolChoice overrides
   * @returns ToolUseResult with text, toolCalls, finishReason, and usage
   */
  async chatWithToolUse(
    systemPrompt: string,
    messages: Array<{ role: string; content: string | ContentBlock[] }>,
    tools: ToolDefinition[],
    options?: {
      model?: string;
      maxTokens?: number;
      timeoutMs?: number;
      toolChoice?: 'auto' | 'required' | 'none';
    },
  ): Promise<ToolUseResult> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_WORKER_LLM_TIMEOUT_MS;
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);

    try {
      const result = await generateText({
        model: this.model,
        system: systemPrompt,
        messages: convertMessages(
          messages.map((m) => ({
            role: m.role as 'user' | 'assistant' | 'system' | 'tool',
            content: m.content,
          })),
        ),
        tools: convertTools(tools),
        toolChoice: options?.toolChoice ?? 'auto',
        maxOutputTokens: options?.maxTokens,
        maxRetries: 2,
        abortSignal: abortController.signal,
      });

      return {
        text: result.text || '',
        toolCalls: (result.toolCalls || []).map((tc) => ({
          id: tc.toolCallId,
          name: tc.toolName,
          input: (tc.input as Record<string, unknown>) ?? {},
        })),
        finishReason: result.finishReason,
        usage: result.usage
          ? {
              promptTokens: result.usage.inputTokens ?? 0,
              completionTokens: result.usage.outputTokens ?? 0,
              totalTokens: (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0),
            }
          : undefined,
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * Get the recommended model ID for a given tier using the provider's
   * default model mappings from the compiler.
   */
  getModelForTier(tier: ModelTier): string {
    return getDefaultModel(this.providerType, tier);
  }
}

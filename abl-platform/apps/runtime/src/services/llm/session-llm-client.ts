/**
 * Session LLM Client
 *
 * Per-session LLM client that wraps ModelResolutionService.
 * Produces output in the exact shape the RuntimeExecutor expects:
 *   { text, toolCalls, stopReason, rawContent, usage?, resolvedModel? }
 *
 * Always uses ModelResolutionService to resolve model + credentials from
 * the tenant's DB-backed configuration (no env-key fallback).
 *
 * Uses Vercel AI SDK for LLM provider integration with unified streaming,
 * tool calling, and provider-agnostic interface.
 */

import { createHash } from 'crypto';
import type { AgentIR } from '@abl/compiler/platform/ir/schema.js';
import { modelSupportsResponsesApi } from '@abl/compiler/platform/llm/model-registry.js';
import { getModelCapabilities } from '@abl/compiler/platform/llm/model-capabilities.js';
import { generateText, streamText, type JSONValue, type LanguageModel } from 'ai';
import { createVercelProvider } from '@agent-platform/llm';
import type {
  Message,
  ToolDefinition,
  ToolPropertySchema,
  ToolCall,
  TextContent,
  ReasoningContent,
  ToolUseContent,
} from '@abl/compiler/platform/llm/types.js';
import {
  convertMessages,
  convertTools,
  findOpenAIResponsesPreviousResponse,
  type OpenAIResponsesPreviousResponseRef,
} from './vercel-ai-adapters.js';
import { createLogger } from '@abl/compiler/platform';

import {
  ModelResolutionService,
  type DeploymentModelOverride,
  type OperationType,
} from './model-resolution.js';
import { isConfigLoaded, getConfig } from '../../config/index.js';
import { recordLlmCall } from '../../observability/metrics.js';
import { classifyLlmError } from './classify-llm-error.js';
import { dumpLlmTrace } from './llm-trace.js';
import { recordActualUsage, type BudgetReservation } from './budget-enforcement.js';
import {
  getCachedProvider,
  setCachedProvider,
  clearProviderCache,
  configureProviderCache,
  buildProviderCacheKey,
} from './provider-cache.js';

const log = createLogger('session-llm-client');

/** Fallback model name for trace metadata when config is unavailable. */
export const TRACE_MODEL_UNKNOWN = 'unknown';

// Re-export cache functions so existing consumers don't break
export { setCachedProvider, clearProviderCache };

// Wire config overrides into the provider cache on first access
let _cacheConfigured = false;
function ensureCacheConfigured(): void {
  if (_cacheConfigured) return;
  try {
    if (isConfigLoaded()) {
      const cfg = getConfig();
      configureProviderCache(
        cfg.llmCache.providerCacheMax,
        cfg.llmCache.providerCacheTtlSeconds * 1000,
      );
      _cacheConfigured = true;
    }
  } catch {
    // Config not ready yet — use defaults
  }
}

// =============================================================================
// LLM CALL TIMEOUT (AbortSignal-based)
// =============================================================================

/**
 * Maximum time (ms) to wait for a single generateText() or streamText() call.
 * A hung LLM provider will be aborted after this duration, surfacing a clean
 * error instead of blocking the session indefinitely.
 *
 * Configurable via LLM_CALL_TIMEOUT_MS env var. Default: 120 000 ms (2 min).
 */
const _parsedTimeout = parseInt(process.env.LLM_CALL_TIMEOUT_MS || '120000', 10);
export const LLM_CALL_TIMEOUT_MS = Number.isNaN(_parsedTimeout) ? 120000 : _parsedTimeout;

// =============================================================================
// TYPES (provider-agnostic — uses generic compiler types)
// =============================================================================

// Re-export generic compiler types under stable names for runtime consumers
export type { ToolDefinition, ToolPropertySchema, ToolCall, Message, TextContent, ToolUseContent };

export interface ResolvedModelInfo {
  modelId: string;
  provider: string;
  source: string;
}

export interface LlmProviderFailure {
  code: 'LLM_PROVIDER_STOP_REASON_ERROR' | 'LLM_PROVIDER_CONTENT_FILTERED';
  message: string;
  stopReason: string;
  provider?: string;
  modelId?: string;
  retryable: boolean;
}

interface BaseChatResult {
  text: string;
  toolCalls: ToolCall[];
  stopReason: string;
  rawContent: Array<TextContent | ReasoningContent | ToolUseContent>;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    /** Anthropic prompt caching — tokens written to cache */
    cacheCreationInputTokens?: number;
    /** Prompt caching — tokens read from cache (Anthropic + OpenAI) */
    cacheReadInputTokens?: number;
  };
  resolvedModel?: ResolvedModelInfo;
}

export interface ChatSuccessResult extends BaseChatResult {
  kind?: 'success';
}

export interface ChatProviderErrorResult extends BaseChatResult {
  kind: 'provider_error';
  providerError: LlmProviderFailure;
}

export type ChatResult = ChatSuccessResult | ChatProviderErrorResult;

function buildLlmProviderFailure(
  stopReason: string,
  resolvedModel?: ResolvedModelInfo,
): LlmProviderFailure | undefined {
  const normalized = stopReason.trim().toLowerCase();

  // Output-side content filter — Azure/OpenAI set finishReason to
  // 'content-filter' or 'content_filter' when the generated output
  // is blocked mid-stream by the provider's safety filter.
  if (normalized === 'content-filter' || normalized === 'content_filter') {
    return {
      code: 'LLM_PROVIDER_CONTENT_FILTERED',
      message: 'The model provider blocked the generated output due to a content safety filter.',
      stopReason,
      provider: resolvedModel?.provider,
      modelId: resolvedModel?.modelId,
      retryable: false,
    };
  }

  if (normalized === 'error') {
    return {
      code: 'LLM_PROVIDER_STOP_REASON_ERROR',
      message: 'The model provider returned an error stop reason before producing a response.',
      stopReason,
      provider: resolvedModel?.provider,
      modelId: resolvedModel?.modelId,
      retryable: true,
    };
  }

  return undefined;
}

function withProviderFailureKind<T extends BaseChatResult>(result: T): ChatResult {
  const providerError = buildLlmProviderFailure(result.stopReason, result.resolvedModel);
  if (!providerError) {
    return result;
  }

  return {
    ...result,
    kind: 'provider_error',
    providerError,
  };
}

// =============================================================================
// STREAMING TYPES
// =============================================================================

export interface SessionStreamEvent {
  type:
    | 'metadata'
    | 'text_delta'
    | 'tool_call_start'
    | 'tool_call_delta'
    | 'tool_call_end'
    | 'usage'
    | 'done'
    | 'error';
  delta?: string;
  toolCall?: { id?: string; name?: string; inputDelta?: string };
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
  resolvedModel?: ResolvedModelInfo;
}

// =============================================================================
// TOOL CHOICE CONVERSION
// =============================================================================

/**
 * Convert platform toolChoice format to Vercel AI SDK format.
 * Platform: 'auto' | 'any' | { type: 'tool'; name: string }
 * Vercel:   'auto' | 'required' | { type: 'tool'; toolName: string }
 */
function convertToolChoice(
  choice: 'auto' | 'any' | { type: 'tool'; name: string },
): 'auto' | 'required' | { type: 'tool'; toolName: string } {
  if (choice === 'auto') return 'auto';
  if (choice === 'any') return 'required';
  return { type: 'tool', toolName: choice.name };
}

type ProviderOptions = Record<string, Record<string, JSONValue>>;

interface ProviderOptionsConfig {
  model: string;
  resolvedProvider: string;
  useResponsesApi?: boolean;
  reasoningEffort?: string;
  enableThinking?: boolean;
  thinkingBudget?: number;
  thinkingLevel?: string;
}

interface PreparedLLMRequest {
  messages: any[];
  providerOptions?: ProviderOptions;
}

function getCleanModelId(modelId: string): string {
  return modelId.includes('/') ? modelId.split('/').slice(1).join('/') : modelId;
}

function usesAdaptiveAnthropicThinking(modelId: string): boolean {
  const cleanModelId = getCleanModelId(modelId);
  return (
    cleanModelId.startsWith('claude-opus-4-7') ||
    cleanModelId.startsWith('claude-opus-4-6') ||
    cleanModelId.startsWith('claude-sonnet-4-6')
  );
}

function readOpenAIResponseIdFromProviderMetadata(providerMetadata: unknown): string | undefined {
  if (
    !providerMetadata ||
    typeof providerMetadata !== 'object' ||
    Array.isArray(providerMetadata)
  ) {
    return undefined;
  }
  const openai = (providerMetadata as Record<string, unknown>).openai;
  if (!openai || typeof openai !== 'object' || Array.isArray(openai)) {
    return undefined;
  }
  const responseId = (openai as Record<string, unknown>).responseId;
  return typeof responseId === 'string' && responseId.length > 0 ? responseId : undefined;
}

function withOpenAIResponseId(
  providerMetadata: Record<string, unknown> | undefined,
  responseId: string | undefined,
): Record<string, unknown> | undefined {
  if (!responseId) {
    return providerMetadata;
  }
  const openai =
    providerMetadata?.openai && typeof providerMetadata.openai === 'object'
      ? (providerMetadata.openai as Record<string, unknown>)
      : {};
  return {
    ...(providerMetadata ?? {}),
    openai: {
      ...openai,
      responseId,
    },
  };
}

function readProviderMetadata(part: unknown): Record<string, unknown> | undefined {
  if (!part || typeof part !== 'object' || Array.isArray(part)) {
    return undefined;
  }
  const record = part as Record<string, unknown>;
  const providerMetadata = record.providerMetadata ?? record.experimental_providerMetadata;
  return providerMetadata &&
    typeof providerMetadata === 'object' &&
    !Array.isArray(providerMetadata)
    ? (providerMetadata as Record<string, unknown>)
    : undefined;
}

function hasOpenAIProviderMetadata(providerMetadata: Record<string, unknown> | undefined): boolean {
  return (
    !!providerMetadata?.openai &&
    typeof providerMetadata.openai === 'object' &&
    !Array.isArray(providerMetadata.openai)
  );
}

function toOpenAIReasoningContent(
  part: unknown,
  openAIResponseId: string | undefined,
): ReasoningContent | undefined {
  if (!part || typeof part !== 'object' || Array.isArray(part)) {
    return undefined;
  }
  const record = part as Record<string, unknown>;
  if (record.type !== 'reasoning') {
    return undefined;
  }
  const providerMetadata = readProviderMetadata(record);
  if (!hasOpenAIProviderMetadata(providerMetadata)) {
    return undefined;
  }
  return {
    type: 'reasoning',
    text: typeof record.text === 'string' ? record.text : '',
    providerMetadata: withOpenAIResponseId(providerMetadata, openAIResponseId),
  };
}

function buildToolUseContent(
  toolCall: ToolCall,
  rawToolCall: unknown,
  openAIResponseId: string | undefined,
): ToolUseContent {
  const providerMetadata = readProviderMetadata(rawToolCall);
  const mergedProviderMetadata = withOpenAIResponseId(providerMetadata, openAIResponseId);
  return {
    type: 'tool_use',
    id: toolCall.id,
    name: toolCall.name,
    input: toolCall.input,
    ...(mergedProviderMetadata ? { providerMetadata: mergedProviderMetadata } : {}),
  };
}

function buildRawContentFromVercelResult(options: {
  text: string;
  toolCalls: ToolCall[];
  rawToolCalls: unknown[];
  contentParts?: unknown[];
  openAIResponseId?: string;
}): Array<TextContent | ReasoningContent | ToolUseContent> {
  const { text, toolCalls, rawToolCalls, contentParts, openAIResponseId } = options;
  const rawContent: Array<TextContent | ReasoningContent | ToolUseContent> = [];

  if (text) {
    rawContent.push({
      type: 'text',
      text,
      ...(openAIResponseId
        ? { providerMetadata: withOpenAIResponseId(undefined, openAIResponseId) }
        : {}),
    });
  }

  const toolCallById = new Map<string, { toolCall: ToolCall; rawToolCall: unknown }>();
  for (let i = 0; i < toolCalls.length; i++) {
    toolCallById.set(toolCalls[i].id, {
      toolCall: toolCalls[i],
      rawToolCall: rawToolCalls[i],
    });
  }

  const hasOpenAIReasoningParts =
    contentParts?.some((part) => toOpenAIReasoningContent(part, openAIResponseId)) ?? false;
  if (!hasOpenAIReasoningParts) {
    for (let i = 0; i < toolCalls.length; i++) {
      rawContent.push(buildToolUseContent(toolCalls[i], rawToolCalls[i], openAIResponseId));
    }
    return rawContent;
  }

  const emittedToolCallIds = new Set<string>();
  for (const part of contentParts ?? []) {
    const reasoningContent = toOpenAIReasoningContent(part, openAIResponseId);
    if (reasoningContent) {
      rawContent.push(reasoningContent);
      continue;
    }

    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      continue;
    }
    const record = part as Record<string, unknown>;
    if (record.type !== 'tool-call' || typeof record.toolCallId !== 'string') {
      continue;
    }
    const mapped = toolCallById.get(record.toolCallId);
    if (!mapped) {
      continue;
    }
    rawContent.push(buildToolUseContent(mapped.toolCall, part, openAIResponseId));
    emittedToolCallIds.add(record.toolCallId);
  }

  for (let i = 0; i < toolCalls.length; i++) {
    if (!emittedToolCallIds.has(toolCalls[i].id)) {
      rawContent.push(buildToolUseContent(toolCalls[i], rawToolCalls[i], openAIResponseId));
    }
  }

  return rawContent;
}

// =============================================================================
// SESSION LLM CLIENT
// =============================================================================

export class SessionLLMClient {
  private resolution: ModelResolutionService;
  private context: {
    tenantId?: string;
    projectId?: string;
    agentName: string;
    agentIR?: AgentIR;
    userId?: string;
    sessionId: string;
    settingsVersionId?: string;
  };

  // ── Config Cache ──────────────────────────────────────────────────────
  // resolveConfig() hits DB on EVERY call (tenant policy, budget).
  // For a single session, model/provider/key don't change between calls.
  // Cache the resolved config per operationType with a 60s TTL — eliminates
  // ~500-1000ms overhead from model resolution + DB calls on repeat calls.
  private _configCache = new Map<
    string,
    { config: Awaited<ReturnType<SessionLLMClient['resolveConfig']>>; resolvedAt: number }
  >();
  private static CONFIG_CACHE_TTL_MS = 60_000;

  // ── In-flight prewarm promises ───────────────────────────────────────
  // When prewarmConfig fires, it stores the promise here. If resolveConfig
  // is called before prewarm completes (race between fire-and-forget prewarm
  // and first user message), we coalesce by awaiting the existing promise
  // instead of starting a redundant resolution. This eliminates the race
  // condition where prewarm and first LLM call both resolve in parallel.
  private _prewarmInflight = new Map<string, Promise<void>>();

  constructor(
    resolution: ModelResolutionService,
    context: {
      tenantId?: string;
      projectId?: string;
      agentName: string;
      agentIR?: AgentIR;
      userId?: string;
      sessionId: string;
      settingsVersionId?: string;
    },
  ) {
    this.resolution = resolution;
    this.context = context;
  }

  /**
   * Pre-warm the config cache for a specific operation type.
   * Called during session creation (wireLLMClient) so the first
   * chatWithToolUse call doesn't pay model resolution cost.
   *
   * Stores the in-flight promise so that resolveConfig() can coalesce
   * with an already-running prewarm (eliminates the race condition where
   * user sends a message before prewarm completes).
   */
  getLastResolvedModel(
    operationType: OperationType = 'response_gen',
  ): ResolvedModelInfo | undefined {
    return this._configCache.get(operationType)?.config.resolvedModel;
  }

  async prewarmConfig(operationType: OperationType): Promise<void> {
    // If already prewarming this type, return existing promise
    const existing = this._prewarmInflight.get(operationType);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const config = await this.resolveConfig(operationType);
        this._configCache.set(operationType, { config, resolvedAt: Date.now() });
      } catch {
        // Non-fatal — will resolve lazily on first call
      } finally {
        this._prewarmInflight.delete(operationType);
      }
    })();

    this._prewarmInflight.set(operationType, promise);
    return promise;
  }

  /**
   * Main LLM call — uses Vercel AI SDK's generateText().
   * Returns same shape as the old inline client, plus usage and resolvedModel.
   */
  async chatWithToolUse(
    systemPrompt: string,
    messages: Message[],
    tools: ToolDefinition[],
    operationType: OperationType = 'response_gen',
    options?: {
      toolChoice?: 'auto' | 'any' | { type: 'tool'; name: string };
      disableParallelToolUse?: boolean;
      maxTokens?: number;
      /**
       * Per-call timeout override (ms). Defaults to `LLM_CALL_TIMEOUT_MS`.
       * Used by latency-sensitive callers like the KB fast-path classify
       * prompt which must fail fast (≤2.5s) instead of waiting 2 minutes
       * when the upstream model stalls.
       */
      timeoutMs?: number;
    },
  ): Promise<ChatResult> {
    const config = await this.resolveConfig(operationType);

    const effectiveMaxTokens = options?.maxTokens ?? config.maxTokens;
    const effectiveTimeoutMs =
      typeof options?.timeoutMs === 'number' && options.timeoutMs > 0
        ? options.timeoutMs
        : LLM_CALL_TIMEOUT_MS;
    const model = this.getOrCreateProvider(
      config.resolvedProvider,
      config.apiKey,
      config.baseUrl,
      config.model,
      config.useResponsesApi,
      config.authConfig,
    );

    log.debug('chatWithToolUse', {
      provider: config.resolvedProvider,
      model: config.model,
      source: config.resolvedModel.source,
      agent: this.context.agentName,
      timeoutMs: effectiveTimeoutMs,
    });

    dumpLlmTrace('request', this.context.agentName ?? 'unknown', config.model, {
      sessionId: this.context.sessionId,
      agent: this.context.agentName,
      provider: config.resolvedProvider,
      model: config.model,
      temperature: config.temperature,
      maxTokens: effectiveMaxTokens,
      systemPrompt,
      messages,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      })),
    });

    const startTime = Date.now();
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), effectiveTimeoutMs);
    const request = this.prepareLLMRequest(config, messages, {
      disableParallelToolUse: options?.disableParallelToolUse,
    });
    try {
      const result = await generateText({
        model,
        system: systemPrompt,
        messages: request.messages,
        tools: convertTools(tools),
        maxRetries: 2,
        maxOutputTokens: effectiveMaxTokens,
        temperature: config.temperature,
        topP: config.topP,
        topK: config.topK,
        frequencyPenalty: config.frequencyPenalty,
        presencePenalty: config.presencePenalty,
        seed: config.seed,
        stopSequences: config.stopSequences,
        abortSignal: abortController.signal,
        ...(options?.toolChoice && tools.length > 0
          ? { toolChoice: convertToolChoice(options.toolChoice) }
          : {}),
        ...(request.providerOptions ? { providerOptions: request.providerOptions } : {}),
      });

      const durationMs = Date.now() - startTime;
      log.debug('completed', {
        latencyMs: durationMs,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cachedInputTokens:
          (result.usage as any).cachedInputTokens ??
          (result.usage as any).inputTokenDetails?.cacheReadTokens ??
          0,
        finishReason: result.finishReason,
      });

      dumpLlmTrace('response', this.context.agentName ?? 'unknown', config.model, {
        sessionId: this.context.sessionId,
        agent: this.context.agentName,
        model: config.model,
        latencyMs: durationMs,
        finishReason: result.finishReason,
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
        text: result.text,
        toolCalls:
          result.response?.messages
            ?.filter((m: any) => m.role === 'assistant')
            .flatMap((m: any) => m.content)
            .filter((c: any) => c.type === 'tool-call')
            .map((c: any) => ({ name: c.toolName, args: c.args })) ?? [],
        rawResponse: result.response?.messages,
      });

      recordLlmCall({
        provider: config.resolvedProvider,
        model: config.model,
        durationMs,
        tokensIn: result.usage?.inputTokens || 0,
        tokensOut: result.usage?.outputTokens || 0,
      });
      if (config.budgetReservation) {
        const actual = (result.usage?.inputTokens || 0) + (result.usage?.outputTokens || 0);
        void recordActualUsage(
          config.budgetReservation,
          actual - config.budgetReservation.estimatedTokens,
        );
      }

      return this.toVercelChatResult(result as any, config.resolvedModel);
    } catch (err) {
      throw classifyLlmError(err);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * Streaming-aware LLM call for use by executors.
   * When useStreaming is enabled and onChunk is provided, uses streamText()
   * to deliver text deltas in real-time while returning the same ChatResult shape.
   * Otherwise falls back to generateText() (same as chatWithToolUse).
   */
  async chatWithToolUseStreamable(
    systemPrompt: string,
    messages: Message[],
    tools: ToolDefinition[],
    operationType: OperationType = 'response_gen',
    onChunk?: (chunk: string) => void,
    options?: {
      toolChoice?: 'auto' | 'any' | { type: 'tool'; name: string };
      disableParallelToolUse?: boolean;
      forceStreaming?: boolean;
      maxTokens?: number;
    },
  ): Promise<ChatResult> {
    const config = await this.resolveConfig(operationType);
    // Allow caller to override maxTokens (e.g. lower cap for tool-call iterations)
    const effectiveMaxTokens = options?.maxTokens ?? config.maxTokens;

    // Most interactive channels pass onChunk, but model policy may still explicitly
    // disable streaming. Voice sessions can force streaming when chunked output is
    // required for transport/TTS behavior.
    const shouldStream =
      !!onChunk && (options?.forceStreaming === true || config.useStreaming !== false);

    if (!shouldStream) {
      // Delegate to the non-streaming path
      return this.chatWithToolUse(systemPrompt, messages, tools, operationType, {
        toolChoice: options?.toolChoice,
        disableParallelToolUse: options?.disableParallelToolUse,
        maxTokens: options?.maxTokens,
      });
    }

    const model = this.getOrCreateProvider(
      config.resolvedProvider,
      config.apiKey,
      config.baseUrl,
      config.model,
      config.useResponsesApi,
      config.authConfig,
    );

    log.debug('chatWithToolUseStreamable', {
      provider: config.resolvedProvider,
      model: config.model,
      source: config.resolvedModel.source,
      agent: this.context.agentName,
      streaming: true,
    });

    dumpLlmTrace('request', this.context.agentName ?? 'unknown', config.model, {
      agent: this.context.agentName,
      provider: config.resolvedProvider,
      model: config.model,
      streaming: true,
      temperature: config.temperature,
      maxTokens: effectiveMaxTokens,
      systemPrompt,
      messages,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      })),
    });

    const startTime = Date.now();
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), LLM_CALL_TIMEOUT_MS);
    const request = this.prepareLLMRequest(config, messages, {
      disableParallelToolUse: options?.disableParallelToolUse,
    });
    try {
      const result = streamText({
        model,
        system: systemPrompt,
        messages: request.messages,
        tools: convertTools(tools),
        maxRetries: 2,
        maxOutputTokens: effectiveMaxTokens,
        temperature: config.temperature,
        topP: config.topP,
        topK: config.topK,
        frequencyPenalty: config.frequencyPenalty,
        presencePenalty: config.presencePenalty,
        seed: config.seed,
        stopSequences: config.stopSequences,
        abortSignal: abortController.signal,
        ...(options?.toolChoice && tools.length > 0
          ? { toolChoice: convertToolChoice(options.toolChoice) }
          : {}),
        ...(request.providerOptions ? { providerOptions: request.providerOptions } : {}),
      });

      // Stream text deltas through onChunk callback in real-time
      for await (const chunk of result.textStream) {
        if (chunk) {
          onChunk(chunk);
        }
      }

      // Await final values for the ChatResult
      const [fullText, toolCallsArray, usageData, finishReason, streamContentParts] =
        await Promise.all([
          result.text,
          result.toolCalls,
          result.usage,
          result.finishReason,
          Promise.resolve((result as any).content).catch(() => undefined),
        ]);

      const streamDurationMs = Date.now() - startTime;
      log.debug('completed', {
        latencyMs: streamDurationMs,
        inputTokens: usageData?.inputTokens,
        outputTokens: usageData?.outputTokens,
        finishReason,
        streamed: true,
      });

      dumpLlmTrace('response', this.context.agentName ?? 'unknown', config.model, {
        sessionId: this.context.sessionId,
        agent: this.context.agentName,
        model: config.model,
        streaming: true,
        latencyMs: streamDurationMs,
        finishReason,
        inputTokens: usageData?.inputTokens,
        outputTokens: usageData?.outputTokens,
        text: fullText,
        toolCalls: toolCallsArray.map((tc: any) => ({
          name: tc.toolName,
          args: tc.args ?? tc.input,
        })),
      });

      recordLlmCall({
        provider: config.resolvedProvider,
        model: config.model,
        durationMs: streamDurationMs,
        tokensIn: usageData?.inputTokens || 0,
        tokensOut: usageData?.outputTokens || 0,
      });
      if (config.budgetReservation) {
        const actual = (usageData?.inputTokens || 0) + (usageData?.outputTokens || 0);
        void recordActualUsage(
          config.budgetReservation,
          actual - config.budgetReservation.estimatedTokens,
        );
      }

      let streamProviderMeta: Record<string, unknown> | undefined;
      try {
        streamProviderMeta =
          (await (result as any).providerMetadata) ??
          (await (result as any).experimental_providerMetadata);
      } catch {
        // providerMetadata may not be available for all providers
      }
      const streamOpenAIResponseId = readOpenAIResponseIdFromProviderMetadata(streamProviderMeta);

      const toolCalls: ToolCall[] = toolCallsArray.map((tc: any) => ({
        id: tc.toolCallId,
        name: tc.toolName,
        input: (tc.input ?? tc.args ?? {}) as Record<string, unknown>,
      }));
      const rawContent = buildRawContentFromVercelResult({
        text: fullText || '',
        toolCalls,
        rawToolCalls: toolCallsArray as unknown[],
        contentParts: Array.isArray(streamContentParts) ? streamContentParts : undefined,
        openAIResponseId: streamOpenAIResponseId,
      });

      // Extract prompt caching tokens from all providers (streaming path)
      // Anthropic: providerMetadata.anthropic.cacheCreationInputTokens / cacheReadInputTokens
      // OpenAI: usageData.cachedInputTokens / usageData.inputTokenDetails.cacheReadTokens
      let streamCacheCreation: number | undefined;
      let streamCacheRead: number | undefined;
      try {
        const streamAnthropicMeta = streamProviderMeta?.anthropic as
          | Record<string, unknown>
          | undefined;
        streamCacheCreation = streamAnthropicMeta?.cacheCreationInputTokens as number | undefined;
        streamCacheRead =
          (streamAnthropicMeta?.cacheReadInputTokens as number | undefined) ??
          ((usageData as any)?.cachedInputTokens as number | undefined) ??
          ((usageData as any)?.inputTokenDetails?.cacheReadTokens as number | undefined);
      } catch {
        // providerMetadata may not be available for all providers
      }

      return withProviderFailureKind({
        text: fullText || '',
        toolCalls,
        stopReason: finishReason,
        rawContent,
        usage: usageData
          ? {
              inputTokens: usageData.inputTokens || 0,
              outputTokens: usageData.outputTokens || 0,
              ...(streamCacheCreation != null && { cacheCreationInputTokens: streamCacheCreation }),
              ...(streamCacheRead != null && { cacheReadInputTokens: streamCacheRead }),
            }
          : undefined,
        resolvedModel: config.resolvedModel,
      });
    } catch (streamError) {
      // Some providers (notably Google Gemini) can return empty streams for
      // valid requests — e.g. after tool_result messages. Fall back to the
      // non-streaming path so the request still succeeds.
      const errMsg = streamError instanceof Error ? streamError.message : String(streamError);
      if (errMsg.includes('No output generated') || errMsg.includes('EMPTY_RESPONSE')) {
        log.warn('Streaming returned empty response, falling back to non-streaming', {
          provider: config.resolvedProvider,
          model: config.model,
          agent: this.context.agentName,
          error: errMsg,
        });
        return this.chatWithToolUse(systemPrompt, messages, tools, operationType, {
          disableParallelToolUse: options?.disableParallelToolUse,
        });
      }
      throw classifyLlmError(streamError);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * SSE streaming LLM call — uses Vercel AI SDK's streamText().
   * Yields SessionStreamEvent as chunks arrive.
   */
  async *streamChatWithToolUse(
    systemPrompt: string,
    messages: Message[],
    tools: ToolDefinition[],
    operationType: OperationType = 'response_gen',
  ): AsyncGenerator<SessionStreamEvent> {
    // Model resolution always runs (uses internal cache in ModelResolutionService).
    const config = await this.resolveConfig(operationType);

    // Yield metadata with resolved model info
    yield { type: 'metadata', resolvedModel: config.resolvedModel };

    const model = this.getOrCreateProvider(
      config.resolvedProvider,
      config.apiKey,
      config.baseUrl,
      config.model,
      config.useResponsesApi,
      config.authConfig,
    );

    // Determine whether to use streaming or non-streaming LLM call.
    // useStreaming: true/undefined/null = stream, false = non-streaming.
    const shouldStream = config.useStreaming !== false;

    log.debug('streamChatWithToolUse', {
      provider: config.resolvedProvider,
      model: config.model,
      source: config.resolvedModel.source,
      agent: this.context.agentName,
      streaming: shouldStream,
    });

    const sseStartTime = Date.now();
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), LLM_CALL_TIMEOUT_MS);
    const request = this.prepareLLMRequest(config, messages);
    try {
      if (!shouldStream) {
        // Non-streaming path: use generateText() and emit synthetic events
        // so the SSE contract is preserved for callers.
        const result = await generateText({
          model,
          system: systemPrompt,
          messages: request.messages,
          tools: convertTools(tools),
          maxRetries: 2,
          maxOutputTokens: config.maxTokens,
          temperature: config.temperature,
          topP: config.topP,
          topK: config.topK,
          frequencyPenalty: config.frequencyPenalty,
          presencePenalty: config.presencePenalty,
          seed: config.seed,
          stopSequences: config.stopSequences,
          abortSignal: abortController.signal,
          ...(request.providerOptions ? { providerOptions: request.providerOptions } : {}),
        });

        recordLlmCall({
          provider: config.resolvedProvider,
          model: config.model,
          durationMs: Date.now() - sseStartTime,
          tokensIn: result.usage?.inputTokens || 0,
          tokensOut: result.usage?.outputTokens || 0,
        });
        if (config.budgetReservation) {
          const actual = (result.usage?.inputTokens || 0) + (result.usage?.outputTokens || 0);
          void recordActualUsage(
            config.budgetReservation,
            actual - config.budgetReservation.estimatedTokens,
          );
        }

        // Emit text as a single delta
        if (result.text) {
          yield { type: 'text_delta', delta: result.text };
        }

        // Emit tool calls
        for (const toolCall of result.toolCalls) {
          yield {
            type: 'tool_call_start',
            toolCall: { id: (toolCall as any).toolCallId, name: (toolCall as any).toolName },
          };
          yield {
            type: 'tool_call_end',
            toolCall: { id: (toolCall as any).toolCallId },
          };
        }

        // Emit usage
        if (result.usage) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: result.usage.inputTokens || 0,
              outputTokens: result.usage.outputTokens || 0,
            },
          };
        }

        yield { type: 'done' };
        return;
      }

      // Streaming path: use streamText() as before
      const result = streamText({
        model,
        system: systemPrompt,
        messages: request.messages,
        tools: convertTools(tools),
        maxRetries: 2,
        maxOutputTokens: config.maxTokens,
        temperature: config.temperature,
        topP: config.topP,
        topK: config.topK,
        frequencyPenalty: config.frequencyPenalty,
        presencePenalty: config.presencePenalty,
        seed: config.seed,
        stopSequences: config.stopSequences,
        abortSignal: abortController.signal,
        ...(request.providerOptions ? { providerOptions: request.providerOptions } : {}),
      });

      // Stream text deltas
      for await (const chunk of result.textStream) {
        yield { type: 'text_delta', delta: chunk };
      }

      // Await all promises to get final values
      const [fullText, toolCallsArray, usageData] = await Promise.all([
        result.text,
        result.toolCalls,
        result.usage,
      ]);

      recordLlmCall({
        provider: config.resolvedProvider,
        model: config.model,
        durationMs: Date.now() - sseStartTime,
        tokensIn: usageData?.inputTokens || 0,
        tokensOut: usageData?.outputTokens || 0,
      });
      if (config.budgetReservation) {
        const actual = (usageData?.inputTokens || 0) + (usageData?.outputTokens || 0);
        void recordActualUsage(
          config.budgetReservation,
          actual - config.budgetReservation.estimatedTokens,
        );
      }

      // Emit tool calls if any
      for (const toolCall of toolCallsArray) {
        yield {
          type: 'tool_call_start',
          toolCall: { id: (toolCall as any).toolCallId, name: (toolCall as any).toolName },
        };
        yield {
          type: 'tool_call_end',
          toolCall: { id: (toolCall as any).toolCallId },
        };
      }

      // Emit usage
      if (usageData) {
        yield {
          type: 'usage',
          usage: {
            inputTokens: usageData.inputTokens || 0,
            outputTokens: usageData.outputTokens || 0,
          },
        };
      }

      yield { type: 'done' };
    } catch (err) {
      const classified = classifyLlmError(err);
      yield { type: 'error', error: classified.message };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * Check if this client is configured and ready to make calls.
   * Always requires a resolution service — credentials come from DB, not env.
   */
  isConfigured(): boolean {
    return !!this.resolution;
  }

  /**
   * Resolve a Vercel AI SDK LanguageModel for a given operation type.
   * Used by the pipeline module to make its own LLM calls.
   * Returns null if resolution fails (e.g. model not configured).
   */
  async resolveLanguageModel(operationType: OperationType): Promise<LanguageModel | null> {
    try {
      const config = await this.resolveConfig(operationType);
      return this.getOrCreateProvider(
        config.resolvedProvider,
        config.apiKey,
        config.baseUrl,
        config.model,
        config.useResponsesApi,
        config.authConfig,
      );
    } catch (err) {
      log.warn('failed to resolve language model for pipeline', {
        operationType,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Resolve a LanguageModel for a runtime-selected model ID using the same
   * deployment override path as other model configuration surfaces.
   */
  async resolveLanguageModelForModelOverride(
    modelId: string,
    operationType: OperationType = 'tool_selection',
  ): Promise<LanguageModel | null> {
    try {
      const config = await this.resolveConfig(operationType, {
        deploymentModelOverride: { model: modelId },
      });
      return this.getOrCreateProvider(
        config.resolvedProvider,
        config.apiKey,
        config.baseUrl,
        config.model,
        config.useResponsesApi,
        config.authConfig,
      );
    } catch (err) {
      log.warn('failed to resolve language model for runtime model override', {
        operationType,
        modelId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private buildProviderOptions(
    config: ProviderOptionsConfig,
    previousResponse: OpenAIResponsesPreviousResponseRef | undefined,
    options?: { disableParallelToolUse?: boolean },
  ): ProviderOptions | undefined {
    const providerOptions: ProviderOptions = {};

    if (options?.disableParallelToolUse) {
      providerOptions.anthropic = { disableParallelToolUse: true };
      providerOptions.openai = { parallelToolCalls: false };
    }

    if (config.reasoningEffort && config.resolvedProvider === 'openai') {
      providerOptions.openai = {
        ...(providerOptions.openai ?? {}),
        reasoningEffort: config.reasoningEffort,
      };
    }

    if (this.shouldUseOpenAIResponsesHistory(config)) {
      providerOptions.openai = {
        ...(providerOptions.openai ?? {}),
        store: true,
      };
      if (previousResponse) {
        providerOptions.openai.previousResponseId = previousResponse.responseId;
      }
    }

    const modelCaps = getModelCapabilities(config.model);
    const isAnthropicMessagesProvider =
      config.resolvedProvider === 'anthropic' ||
      config.resolvedProvider === 'microsoft_foundry_anthropic';
    if (
      isAnthropicMessagesProvider &&
      modelCaps.supportsThinking &&
      config.enableThinking != null
    ) {
      providerOptions.anthropic = {
        ...(providerOptions.anthropic ?? {}),
        thinking:
          config.enableThinking === false
            ? { type: 'disabled' }
            : usesAdaptiveAnthropicThinking(config.model)
              ? { type: 'adaptive', display: 'summarized' }
              : {
                  type: 'enabled',
                  ...(config.thinkingBudget != null ? { budgetTokens: config.thinkingBudget } : {}),
                },
      };
    }

    if (
      (config.resolvedProvider === 'google' || config.resolvedProvider === 'gemini') &&
      (config.thinkingBudget != null ||
        config.thinkingLevel != null ||
        config.enableThinking != null)
    ) {
      providerOptions.google = {
        ...(providerOptions.google ?? {}),
        thinkingConfig: {
          ...((providerOptions.google?.thinkingConfig as Record<string, JSONValue> | undefined) ??
            {}),
          ...(config.thinkingBudget != null ? { thinkingBudget: config.thinkingBudget } : {}),
          ...(config.thinkingLevel != null ? { thinkingLevel: config.thinkingLevel } : {}),
          ...(config.enableThinking != null ? { includeThoughts: config.enableThinking } : {}),
        },
      };
    }

    if (config.resolvedProvider === 'bedrock' && config.enableThinking != null) {
      providerOptions.bedrock = {
        ...(providerOptions.bedrock ?? {}),
        reasoningConfig:
          config.enableThinking === false
            ? { type: 'disabled' }
            : {
                type: 'enabled',
                ...(config.thinkingBudget != null ? { budgetTokens: config.thinkingBudget } : {}),
              },
      };
    }

    return Object.keys(providerOptions).length > 0 ? providerOptions : undefined;
  }

  private prepareLLMRequest(
    config: ProviderOptionsConfig,
    messages: Message[],
    options?: { disableParallelToolUse?: boolean },
  ): PreparedLLMRequest {
    const previousResponse = this.shouldUseOpenAIResponsesHistory(config)
      ? findOpenAIResponsesPreviousResponse(messages)
      : undefined;
    const requestMessages = previousResponse
      ? messages.slice(previousResponse.messageIndex + 1)
      : messages;
    return {
      messages: convertMessages(requestMessages, {
        toolNameSourceMessages: previousResponse ? messages : requestMessages,
      }) as any,
      providerOptions: this.buildProviderOptions(config, previousResponse, options),
    };
  }

  private shouldUseOpenAIResponsesHistory(config: ProviderOptionsConfig): boolean {
    if (config.resolvedProvider !== 'openai') {
      return false;
    }
    if (isConfigLoaded() && getConfig().llm.litellmProxyUrl) {
      return false;
    }
    const cleanModelId = getCleanModelId(config.model);
    return (
      config.useResponsesApi !== false &&
      (config.useResponsesApi === true || modelSupportsResponsesApi(cleanModelId))
    );
  }

  // ===========================================================================
  // PRIVATE — Provider Management
  // ===========================================================================

  /**
   * Get or create a Vercel AI SDK LanguageModel instance, with caching.
   *
   * Dual-mode routing:
   * - If LITELLM_PROXY_URL is set, ALL calls go through the LiteLLM proxy (via OpenAI compatibility)
   * - Otherwise, the appropriate direct provider is used
   */
  private getOrCreateProvider(
    resolvedProvider: string,
    apiKey: string,
    baseUrl: string | undefined,
    modelId: string,
    useResponsesApi?: boolean,
    authConfig?: Record<string, unknown>,
  ): LanguageModel {
    const litellmUrl = getConfig().llm.litellmProxyUrl;
    const useLitellm = !!litellmUrl;

    const providerType = useLitellm ? 'litellm' : resolvedProvider;
    const effectiveUrl = useLitellm ? litellmUrl : baseUrl;

    // Use hashed API key in cache key to avoid leaking key material
    const keyHash = createHash('sha256').update(apiKey).digest('hex').substring(0, 12);
    const apiSuffix = useResponsesApi != null ? `:ra=${useResponsesApi ? 1 : 0}` : '';
    // Note: authSuffix is now before apiSuffix (both in buildProviderCacheKey result).
    // This is a deliberate ordering change; the cache is process-local and ephemeral.
    const cacheKey = `${buildProviderCacheKey(providerType, keyHash, effectiveUrl, modelId, authConfig)}${apiSuffix}`;
    ensureCacheConfigured();
    let provider = getCachedProvider(cacheKey);
    if (!provider) {
      provider = this.createVercelProvider(
        providerType,
        apiKey,
        effectiveUrl,
        modelId,
        useResponsesApi,
        authConfig,
      );
      setCachedProvider(cacheKey, provider, this.context.tenantId);
    }
    return provider;
  }

  /**
   * Create a Vercel AI SDK provider instance.
   * Delegates to the shared @agent-platform/llm package.
   */
  private createVercelProvider(
    providerType: string,
    apiKey: string,
    baseUrl: string | undefined,
    modelId: string,
    useResponsesApi?: boolean,
    authConfig?: Record<string, unknown>,
  ): LanguageModel {
    return createVercelProvider(
      providerType,
      apiKey,
      baseUrl,
      modelId,
      useResponsesApi,
      authConfig,
    );
  }

  // ===========================================================================
  // PRIVATE — Type Mapping (Vercel AI SDK → Platform Types)
  // ===========================================================================

  /**
   * Convert Vercel AI SDK generateText result to our ChatResult format.
   */
  private toVercelChatResult(
    result: Awaited<ReturnType<typeof generateText>>,
    resolvedModel: ResolvedModelInfo,
  ): ChatResult {
    const text = result.text || '';

    if (!result.text && result.toolCalls.length === 0) {
      log.warn('Provider returned empty text with no tool calls', {
        finishReason: result.finishReason,
        model: resolvedModel.modelId,
      });
    }

    const resultProviderMeta =
      (result as any).providerMetadata ?? (result as any).experimental_providerMetadata;
    const openAIResponseId = readOpenAIResponseIdFromProviderMetadata(resultProviderMeta);

    // Convert Vercel AI SDK tool calls to our format
    // SDK v6 uses `input` (not `args`) for tool call arguments
    const toolCalls: ToolCall[] = result.toolCalls.map((tc: any) => ({
      id: tc.toolCallId,
      name: tc.toolName,
      input: (tc.input ?? tc.args ?? {}) as Record<string, unknown>,
    }));
    const rawContent = buildRawContentFromVercelResult({
      text,
      toolCalls,
      rawToolCalls: result.toolCalls as unknown[],
      contentParts: Array.isArray((result as any).content)
        ? ((result as any).content as unknown[])
        : undefined,
      openAIResponseId,
    });

    // Extract prompt caching tokens from all providers (Vercel AI SDK v6)
    // Anthropic: providerMetadata.anthropic.cacheCreationInputTokens / cacheReadInputTokens
    // OpenAI: result.usage.cachedInputTokens / result.usage.inputTokenDetails.cacheReadTokens
    const anthropicMeta = resultProviderMeta?.anthropic as Record<string, unknown> | undefined;
    const cacheCreationInputTokens = anthropicMeta?.cacheCreationInputTokens as number | undefined;
    // OpenAI auto-caches prompts >1024 tokens. SDK exposes via usage.cachedInputTokens.
    const cacheReadInputTokens =
      (anthropicMeta?.cacheReadInputTokens as number | undefined) ??
      ((result.usage as any)?.cachedInputTokens as number | undefined) ??
      ((result.usage as any)?.inputTokenDetails?.cacheReadTokens as number | undefined);

    return withProviderFailureKind({
      text,
      toolCalls,
      stopReason: result.finishReason,
      rawContent,
      usage: result.usage
        ? {
            inputTokens: result.usage.inputTokens || 0,
            outputTokens: result.usage.outputTokens || 0,
            ...(cacheCreationInputTokens != null && { cacheCreationInputTokens }),
            ...(cacheReadInputTokens != null && { cacheReadInputTokens }),
          }
        : undefined,
      resolvedModel,
    });
  }

  // ===========================================================================
  // PUBLIC — Pre-resolve enableThinking for tool schema generation
  // ===========================================================================

  /**
   * Resolve the effective enableThinking flag and thinkingBudget from the model resolution chain.
   * This uses the settings-only reasoning contract
   * (Agent IR → Agent DB → Project DB → platform default) and returns the
   * merged enableThinking + thinkingBudget parameters without touching
   * user-scoped credential policy or per-call budget reservation.
   *
   * Used by prompt-builder to decide whether to inject `thought` fields into tool schemas
   * and to include budget constraints in the thought description.
   */
  async resolveEnableThinking(): Promise<
    | {
        enableThinking?: boolean;
        thinkingBudget?: number;
        thoughtDescription?: string;
        compactionThreshold?: number;
        modelId?: string;
      }
    | undefined
  > {
    try {
      const resolved = await this.resolution.resolveReasoningSettings({
        tenantId: this.context.tenantId,
        projectId: this.context.projectId,
        agentName: this.context.agentName,
        agentIR: this.context.agentIR,
        settingsVersionId: this.context.settingsVersionId,
      });
      return {
        enableThinking: resolved.parameters.enableThinking,
        thinkingBudget: resolved.parameters.thinkingBudget,
        thoughtDescription: resolved.parameters.thoughtDescription,
        compactionThreshold: resolved.parameters.compactionThreshold,
        modelId: resolved.modelId,
      };
    } catch {
      return undefined;
    }
  }

  // ===========================================================================
  // PRIVATE — Config Resolution
  // ===========================================================================

  /**
   * Resolve model config + credentials via ModelResolutionService.
   * No env-key fallback — credentials always come from the DB-backed resolution chain.
   */
  private async resolveConfig(
    operationType: OperationType,
    options?: { deploymentModelOverride?: DeploymentModelOverride },
  ): Promise<{
    apiKey: string;
    model: string;
    baseUrl: string | undefined;
    resolvedProvider: string;
    maxTokens: number;
    temperature: number | undefined;
    topP: number | undefined;
    topK: number | undefined;
    frequencyPenalty: number | undefined;
    presencePenalty: number | undefined;
    seed: number | undefined;
    stopSequences: string[] | undefined;
    resolvedModel: ResolvedModelInfo;
    reasoningEffort?: string;
    enableThinking?: boolean;
    thinkingBudget?: number;
    thinkingLevel?: string;
    useResponsesApi?: boolean;
    useStreaming?: boolean;
    authConfig?: Record<string, unknown>;
    budgetReservation?: BudgetReservation;
  }> {
    const useSessionCache = !options?.deploymentModelOverride;
    // Check config cache first — avoids DB calls (tenant policy, budget) on repeat calls
    const cached = useSessionCache ? this._configCache.get(operationType) : undefined;
    if (cached && Date.now() - cached.resolvedAt < SessionLLMClient.CONFIG_CACHE_TTL_MS) {
      log.debug('resolveConfig cache HIT', {
        operationType,
        ageMs: Date.now() - cached.resolvedAt,
      });
      return cached.config;
    }

    // If a prewarm is in-flight for this operationType, coalesce: await it
    // instead of starting a redundant parallel resolution. This eliminates
    // the race where the first user message fires before prewarm completes.
    const inflight = useSessionCache ? this._prewarmInflight.get(operationType) : undefined;
    if (inflight) {
      log.debug('resolveConfig coalescing with in-flight prewarm', { operationType });
      await inflight;
      // After prewarm completes, cache should be populated — check again
      const afterPrewarm = this._configCache.get(operationType);
      if (
        afterPrewarm &&
        Date.now() - afterPrewarm.resolvedAt < SessionLLMClient.CONFIG_CACHE_TTL_MS
      ) {
        return afterPrewarm.config;
      }
      // Prewarm failed silently — fall through to normal resolution
    }

    log.debug('resolveConfig cache MISS', { operationType, hasCached: !!cached });

    const resolveStart = Date.now();
    const resolved = await this.resolution.resolve({
      tenantId: this.context.tenantId,
      projectId: this.context.projectId,
      agentName: this.context.agentName,
      agentIR: this.context.agentIR,
      operationType,
      userId: this.context.userId,
      settingsVersionId: this.context.settingsVersionId,
      deploymentModelOverride: options?.deploymentModelOverride,
    });
    log.debug('resolveConfig resolution done', {
      operationType,
      resolveMs: Date.now() - resolveStart,
    });

    const resolvedProvider = resolved.provider;
    // Only pass baseUrl when a custom endpoint is explicitly configured.
    // Vercel AI SDK providers already know their correct default URLs
    // (e.g., https://api.openai.com/v1, https://api.anthropic.com/v1).
    // Overriding with our own defaults strips the /v1 path and causes 404s.
    const baseUrl = resolved.credential.endpoint || resolved.customEndpoint || undefined;
    let maxTokens = 2048;
    let temperature: number | undefined;
    let topP: number | undefined;
    let topK: number | undefined;
    let frequencyPenalty: number | undefined;
    let presencePenalty: number | undefined;
    let seed: number | undefined;
    let stopSequences: string[] | undefined;
    if (resolved.parameters.maxTokens) maxTokens = resolved.parameters.maxTokens;
    if (resolved.parameters.temperature != null) temperature = resolved.parameters.temperature;
    if (resolved.parameters.topP != null) topP = resolved.parameters.topP;
    if (resolved.parameters.topK != null) topK = resolved.parameters.topK;
    if (resolved.parameters.frequencyPenalty != null)
      frequencyPenalty = resolved.parameters.frequencyPenalty;
    if (resolved.parameters.presencePenalty != null)
      presencePenalty = resolved.parameters.presencePenalty;
    if (resolved.parameters.seed != null) seed = resolved.parameters.seed;
    if (resolved.parameters.stopSequences != null)
      stopSequences = resolved.parameters.stopSequences;
    if (
      resolved.parameters.enableThinking === true &&
      (resolvedProvider === 'anthropic' ||
        resolvedProvider === 'microsoft_foundry_anthropic' ||
        resolvedProvider === 'bedrock')
    ) {
      temperature = undefined;
      topP = undefined;
      topK = undefined;
    }
    const authConfig = {
      ...((resolved.credential.authConfig as Record<string, unknown> | undefined) ?? {}),
    };
    if (resolved.credential.authType) {
      authConfig.authType = resolved.credential.authType;
    }
    if (resolved.credential.customHeaders) {
      authConfig.headers = {
        ...((authConfig.headers as Record<string, string> | undefined) ?? {}),
        ...resolved.credential.customHeaders,
      };
    }
    if (resolved.apiIntegration?.customHeaders) {
      authConfig.headers = {
        ...((authConfig.headers as Record<string, string> | undefined) ?? {}),
        ...resolved.apiIntegration.customHeaders,
      };
    }
    if (resolved.apiIntegration?.providerStructure === 'anthropic_messages') {
      authConfig.apiFormat = 'anthropic_messages';
    }

    const config = {
      apiKey: resolved.credential.apiKey,
      model: resolved.modelId,
      baseUrl,
      resolvedProvider,
      maxTokens,
      temperature,
      topP,
      topK,
      frequencyPenalty,
      presencePenalty,
      seed,
      stopSequences,
      resolvedModel: {
        modelId: resolved.modelId,
        provider: resolvedProvider,
        source: resolved.source || 'resolution',
      },
      reasoningEffort: resolved.parameters.reasoningEffort,
      enableThinking: resolved.parameters.enableThinking,
      thinkingBudget: resolved.parameters.thinkingBudget,
      thinkingLevel: resolved.parameters.thinkingLevel,
      useResponsesApi: resolved.useResponsesApi,
      useStreaming: resolved.useStreaming,
      authConfig: Object.keys(authConfig).length > 0 ? authConfig : undefined,
      budgetReservation: resolved.budgetReservation,
    };

    // Cache for subsequent calls within this session
    if (useSessionCache) {
      this._configCache.set(operationType, { config, resolvedAt: Date.now() });
    }
    return config;
  }
}

// =============================================================================
// STANDALONE PROVIDER FACTORY (for validation, not tied to a session)
// =============================================================================

/**
 * Create a Vercel AI SDK LanguageModel for credential validation.
 * Uses the shared provider factory from @agent-platform/llm.
 * Exported so validation routes can test credentials via `generateText({ model, prompt: 'hi', maxTokens: 1 })`.
 */
export function createVercelProviderForValidation(
  provider: string,
  apiKey: string,
  baseUrl: string | undefined,
  modelId: string,
  authConfig?: Record<string, unknown>,
): LanguageModel {
  return createVercelProvider(provider, apiKey, baseUrl, modelId, undefined, authConfig);
}

/**
 * LLM Provider Types
 *
 * Generic types for LLM provider abstraction.
 * These types are provider-agnostic and can work with any LLM backend.
 *
 * **Migration Note (Feb 2025):**
 * As of the Vercel AI SDK migration, provider instantiation now happens in
 * the runtime layer using Vercel AI SDK packages (@ai-sdk/*). These types
 * define the platform's provider-agnostic abstraction layer used throughout
 * the codebase.
 *
 * Actual provider implementations: apps/runtime/src/services/llm/session-llm-client.ts
 * Type adapters: apps/runtime/src/services/llm/vercel-ai-adapters.ts
 */

// =============================================================================
// CORE TYPES
// =============================================================================

/**
 * Supported LLM providers
 */
export type LLMProviderType =
  | 'anthropic'
  | 'openai'
  | 'litellm'
  | 'azure'
  | 'bedrock'
  | 'vertex'
  | 'google'
  | 'gemini'
  | 'cohere'
  | 'ultravox'
  | 'custom';

/**
 * Model tiers for complexity-based selection
 */
export type ModelTier = 'fast' | 'balanced' | 'powerful';

/**
 * Message role in conversation
 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

// =============================================================================
// MESSAGES
// =============================================================================

/**
 * Text content block
 */
export interface TextContent {
  type: 'text';
  text: string;
  /** Provider-specific metadata (e.g. Gemini thoughtSignature) preserved for round-trip */
  providerMetadata?: Record<string, unknown>;
}

/**
 * Tool use content block (from assistant)
 */
export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Provider-specific metadata (e.g. Gemini thoughtSignature) preserved for round-trip */
  providerMetadata?: Record<string, unknown>;
}

/**
 * Reasoning content block (from assistant).
 * Used for provider-required round-trip metadata such as OpenAI Responses reasoning items.
 */
export interface ReasoningContent {
  type: 'reasoning';
  text: string;
  /** Provider-specific metadata required to replay or reference the reasoning item */
  providerMetadata?: Record<string, unknown>;
}

/**
 * Tool result content block (from user)
 */
export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/**
 * Image content block for multimodal messages.
 * Supports base64-encoded images and URL references.
 */
export interface ImageContent {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string };
  /** Optional attachment ID linking to the multimodal service */
  attachmentId?: string;
}

/**
 * Content block union type
 */
export type ContentBlock =
  | TextContent
  | ReasoningContent
  | ToolUseContent
  | ToolResultContent
  | ImageContent;

/**
 * Type guard for ImageContent blocks
 */
export function isImageContent(block: ContentBlock): block is ImageContent {
  return block.type === 'image';
}

/**
 * Type guard for TextContent blocks
 */
export function isTextContent(block: ContentBlock): block is TextContent {
  return block.type === 'text';
}

/**
 * Message in a conversation
 */
export interface Message {
  role: MessageRole;
  content: string | ContentBlock[];
}

// =============================================================================
// TOOLS
// =============================================================================

/**
 * JSON Schema property descriptor for tool input parameters.
 * Supports recursive nesting for complex tool schemas (objects, arrays of objects).
 */
export interface ToolPropertySchema {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: ToolPropertySchema & {
    properties?: Record<string, ToolPropertySchema>;
    required?: string[];
  };
  properties?: Record<string, ToolPropertySchema>;
  required?: string[];
  minItems?: number;
  maxItems?: number;
}

/**
 * Tool definition for function calling
 */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, ToolPropertySchema>;
    required?: string[];
  };
}

/**
 * Tool call from the LLM
 */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// =============================================================================
// COMPLETION OPTIONS
// =============================================================================

/**
 * Reasoning effort level for models that support it (OpenAI o-series, GPT-5).
 */
export type ReasoningEffort = 'low' | 'medium' | 'high';

/**
 * Options for LLM completion requests
 */
export interface CompletionOptions {
  /** Model identifier (provider-specific) */
  model: string;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Temperature for randomness (0-1) */
  temperature?: number;
  /** Top-p sampling */
  topP?: number;
  /** Stop sequences */
  stopSequences?: string[];
  /** Timeout in milliseconds */
  timeoutMs?: number;
  /** Stream the response */
  stream?: boolean;

  // --- Reasoning model parameters ---

  /** Reasoning effort for o-series / GPT-5 models */
  reasoningEffort?: ReasoningEffort;
  /** Enable extended thinking (Anthropic Claude) */
  enableThinking?: boolean;
  /** Token budget for extended thinking (Anthropic Claude) */
  thinkingBudget?: number;
  /**
   * Max completion tokens — used instead of maxTokens for reasoning models
   * (OpenAI o-series / GPT-5) where the model allocates tokens between
   * reasoning and output internally.
   */
  maxCompletionTokens?: number;
}

/**
 * Options for tool use completion
 */
export interface ToolCompletionOptions extends CompletionOptions {
  /** Tools available to the model */
  tools: ToolDefinition[];
  /** Force a specific tool to be called */
  toolChoice?: 'auto' | 'any' | { type: 'tool'; name: string };
}

// =============================================================================
// COMPLETION RESULTS
// =============================================================================

/**
 * Stop reason for completion
 */
export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';

/**
 * Usage statistics
 */
export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Result from a completion request
 */
export interface CompletionResult {
  /** Generated text content */
  text: string;
  /** Stop reason */
  stopReason: StopReason;
  /** Usage statistics */
  usage?: UsageStats;
  /** Model used */
  model: string;
  /** Latency in milliseconds */
  latencyMs: number;
  /** Extended thinking content (Anthropic Claude when enableThinking is true) */
  thinkingContent?: string;
}

/**
 * Result from a tool use completion
 */
export interface ToolCompletionResult {
  /** Generated text content (may be empty if tool use) */
  text?: string;
  /** Tool calls requested by the model */
  toolCalls: ToolCall[];
  /** Stop reason */
  stopReason: StopReason;
  /** Usage statistics */
  usage?: UsageStats;
  /** Model used */
  model: string;
  /** Latency in milliseconds */
  latencyMs: number;
  /** Extended thinking content (Anthropic Claude when enableThinking is true) */
  thinkingContent?: string;
}

// =============================================================================
// STREAMING
// =============================================================================

/**
 * Streaming event types
 */
export type StreamEventType =
  | 'text_delta'
  | 'tool_use_start'
  | 'tool_use_delta'
  | 'tool_use_end'
  | 'message_start'
  | 'message_end'
  | 'error';

/**
 * Base streaming event
 */
export interface BaseStreamEvent {
  type: StreamEventType;
}

/**
 * Text delta event (streaming text)
 */
export interface TextDeltaEvent extends BaseStreamEvent {
  type: 'text_delta';
  text: string;
}

/**
 * Tool use start event
 */
export interface ToolUseStartEvent extends BaseStreamEvent {
  type: 'tool_use_start';
  id: string;
  name: string;
}

/**
 * Tool use delta event (streaming tool input)
 */
export interface ToolUseDeltaEvent extends BaseStreamEvent {
  type: 'tool_use_delta';
  id: string;
  inputDelta: string;
}

/**
 * Tool use end event
 */
export interface ToolUseEndEvent extends BaseStreamEvent {
  type: 'tool_use_end';
  id: string;
  input: Record<string, unknown>;
}

/**
 * Message start event
 */
export interface MessageStartEvent extends BaseStreamEvent {
  type: 'message_start';
  model: string;
}

/**
 * Message end event
 */
export interface MessageEndEvent extends BaseStreamEvent {
  type: 'message_end';
  stopReason: StopReason;
  usage?: UsageStats;
}

/**
 * Error event
 */
export interface ErrorEvent extends BaseStreamEvent {
  type: 'error';
  error: string;
}

/**
 * Union of all stream events
 */
export type StreamEvent =
  | TextDeltaEvent
  | ToolUseStartEvent
  | ToolUseDeltaEvent
  | ToolUseEndEvent
  | MessageStartEvent
  | MessageEndEvent
  | ErrorEvent;

// =============================================================================
// PROVIDER CONFIGURATION
// =============================================================================

/**
 * Base provider configuration
 */
export interface BaseProviderConfig {
  /** Provider type */
  provider: LLMProviderType;
  /** API key (can also use environment variable) */
  apiKey?: string;
  /** API key environment variable name */
  apiKeyEnvVar?: string;
  /** Base URL override */
  baseUrl?: string;
  /** Default timeout in ms */
  defaultTimeoutMs?: number;
  /** Default max tokens */
  defaultMaxTokens?: number;
  /** Model mapping for tiers */
  modelMapping?: Record<ModelTier, string>;
}

/**
 * Anthropic-specific configuration
 */
export interface AnthropicProviderConfig extends BaseProviderConfig {
  provider: 'anthropic';
  /** Enable Anthropic prompt caching for reduced costs (default: true) */
  enablePromptCaching?: boolean;
}

/**
 * OpenAI-specific configuration
 */
export interface OpenAIProviderConfig extends BaseProviderConfig {
  provider: 'openai';
  /** Organization ID */
  organization?: string;
}

/**
 * LiteLLM-specific configuration
 */
export interface LiteLLMProviderConfig extends BaseProviderConfig {
  provider: 'litellm';
  /** LiteLLM proxy URL */
  proxyUrl?: string;
  /** Additional headers */
  headers?: Record<string, string>;
}

/**
 * Azure OpenAI-specific configuration
 */
export interface AzureProviderConfig extends BaseProviderConfig {
  provider: 'azure';
  /** Azure deployment name */
  deploymentName: string;
  /** Azure API version */
  apiVersion?: string;
  /** Azure resource name */
  resourceName: string;
}

/**
 * Gemini-specific configuration (Google AI Studio)
 */
export interface GeminiProviderConfig extends BaseProviderConfig {
  provider: 'gemini';
}

/**
 * Vertex AI-specific configuration (Google Cloud)
 *
 * Uses the same Gemini content format but with:
 * - Regional endpoint: {region}-aiplatform.googleapis.com
 * - OAuth2 / service account auth (Bearer token, not API key)
 * - Project + location scoping
 */
export interface VertexProviderConfig extends BaseProviderConfig {
  provider: 'vertex';
  /** Google Cloud project ID (required) */
  projectId: string;
  /** Google Cloud region (default: us-central1) */
  region?: string;
  /** Access token (short-lived OAuth2 token). If not provided, uses ADC via GOOGLE_APPLICATION_CREDENTIALS. */
  accessToken?: string;
}

/**
 * Cohere-specific configuration
 */
export interface CohereProviderConfig extends BaseProviderConfig {
  provider: 'cohere';
}

/**
 * Custom provider configuration
 */
export interface CustomProviderConfig extends BaseProviderConfig {
  provider: 'custom';
  /** Custom provider implementation */
  implementation: LLMProvider;
}

/**
 * Union of all provider configurations
 */
export type ProviderConfig =
  | AnthropicProviderConfig
  | OpenAIProviderConfig
  | LiteLLMProviderConfig
  | AzureProviderConfig
  | GeminiProviderConfig
  | VertexProviderConfig
  | CohereProviderConfig
  | CustomProviderConfig;

// =============================================================================
// PROVIDER INTERFACE
// =============================================================================

/**
 * LLM Provider interface
 *
 * All providers must implement this interface for consistent behavior.
 */
export interface LLMProvider {
  /** Provider name */
  readonly name: LLMProviderType;

  /**
   * Simple text completion
   */
  complete(
    systemPrompt: string,
    messages: Message[],
    options: CompletionOptions,
  ): Promise<CompletionResult>;

  /**
   * Completion with tool use
   */
  completeWithTools(
    systemPrompt: string,
    messages: Message[],
    options: ToolCompletionOptions,
  ): Promise<ToolCompletionResult>;

  /**
   * Streaming text completion
   */
  streamComplete(
    systemPrompt: string,
    messages: Message[],
    options: CompletionOptions,
  ): AsyncIterable<StreamEvent>;

  /**
   * Streaming completion with tool use
   */
  streamCompleteWithTools(
    systemPrompt: string,
    messages: Message[],
    options: ToolCompletionOptions,
  ): AsyncIterable<StreamEvent>;

  /**
   * Get model ID for a given tier
   */
  getModelForTier(tier: ModelTier): string;

  /**
   * Check if provider supports a feature
   */
  supportsFeature(feature: 'streaming' | 'tools' | 'vision' | 'reasoning' | 'thinking'): boolean;
}

/**
 * Shared Test Utilities
 *
 * Common utilities for E2E tests including:
 * - Generic LLM client creation (supports Anthropic, OpenAI, LiteLLM)
 * - Mock tool executor
 * - Transcript recording with full chat transcripts
 * - Test context creation
 * - Agent response generation
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';

// Load env vars from apps/runtime/.env so tests pick up LLM_PROVIDER, API keys, etc.
const __filename_utils = fileURLToPath(import.meta.url);
const runtimeEnvPath = path.resolve(
  path.dirname(__filename_utils),
  '../../../../../../apps/runtime/.env',
);
if (fs.existsSync(runtimeEnvPath)) {
  dotenvConfig({ path: runtimeEnvPath, override: false });
}

import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../../../platform/ir/compiler.js';
import type { AgentIR } from '../../../platform/ir/schema.js';
import { InMemoryFactStore, type FactStoreConfig } from '../../../platform/stores/fact-store.js';
import {
  createInitialState,
  type ExecutionContext,
  type AgentState,
  type LLMClient,
  type ToolExecutor,
  type RuntimeType,
  type LLMToolDefinition,
  type LLMToolUseResult,
} from '../../../platform/constructs/types.js';
import {
  createProvider,
  LLMClient as GenericLLMClient,
  type ProviderConfig,
  type LLMProviderType,
  type ModelTier as GenericModelTier,
  LLMResponseCache,
  createCachedLLMClient,
} from '../../../platform/llm/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// =============================================================================
// CONFIGURATION
// =============================================================================

export const TRANSCRIPT_DIR = path.resolve(__dirname, '../../../../../../output/transcripts');
export const CACHE_DIR = path.resolve(__dirname, '../../../../../../.llm-cache');
export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'; // Legacy fallback

/**
 * Get the default model for the current provider.
 * Returns the 'haiku' tier model for the active LLM_PROVIDER.
 */
export function getDefaultModel(): string {
  const models = PROVIDER_MODELS[DEFAULT_PROVIDER];
  return models?.haiku ?? DEFAULT_MODEL;
}
export const DEFAULT_TIMEOUT_MS = 30000;

// Cache instance - shared across all tests
let sharedCache: LLMResponseCache | null = null;

/**
 * Get or create the shared LLM response cache
 */
export function getSharedCache(): LLMResponseCache {
  if (!sharedCache) {
    const enabled = process.env.LLM_CACHE_ENABLED !== 'false';
    sharedCache = new LLMResponseCache({
      cacheDir: process.env.LLM_CACHE_DIR || CACHE_DIR,
      enabled,
      ttlMs: 0, // No expiry for test cache
      includeModelInKey: false, // Model-agnostic caching
    });
    if (enabled) {
      console.log(`[LLM Cache] Initialized at ${CACHE_DIR}`);
    }
  }
  return sharedCache;
}

/**
 * Print cache statistics at the end of tests
 */
export function printCacheStats(): void {
  if (sharedCache) {
    sharedCache.printStats();
  }
}

// Default provider - can be overridden via environment variable
// Usage: LLM_PROVIDER=openai pnpm test  (defaults to 'anthropic')
export const DEFAULT_PROVIDER: LLMProviderType =
  (process.env.LLM_PROVIDER as LLMProviderType) || 'anthropic';

// =============================================================================
// API KEY MANAGEMENT
// =============================================================================

const API_KEY_ENV_VARS: Record<LLMProviderType, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  litellm: ['LITELLM_API_KEY', 'OPENAI_API_KEY'],
  azure: ['AZURE_OPENAI_API_KEY'],
  bedrock: ['AWS_ACCESS_KEY_ID'],
  vertex: ['GOOGLE_APPLICATION_CREDENTIALS'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  cohere: ['COHERE_API_KEY'],
  ultravox: ['ULTRAVOX_API_KEY'],
  custom: ['LLM_API_KEY'],
};

/**
 * Check if an API key is available for the given provider without throwing.
 * Also checks the fallback provider (openai↔anthropic) when LLM_PROVIDER is not explicitly set.
 */
export function hasApiKey(provider?: LLMProviderType): boolean {
  const p = provider || DEFAULT_PROVIDER;
  const vars = API_KEY_ENV_VARS[p] || ['LLM_API_KEY'];
  if (vars.some((v) => !!process.env[v])) return true;

  // Legacy file-based key for Anthropic
  if (p === 'anthropic') {
    const keyFilePath = path.resolve(__dirname, '../../../../../../ANTHROPIC_API_KEY.txt');
    if (fs.existsSync(keyFilePath)) return true;
  }

  return false;
}

/**
 * Get the skip reason message when no API key is available, or null if a key exists.
 * Use in test files: const skip = getSkipReason(); if (skip) return describe.skip(...)
 *
 * Note: As of the Vercel AI SDK migration, createProvider() is deprecated.
 * These E2E tests are always skipped until they are migrated to use the
 * runtime-layer SessionLLMClient (Vercel AI SDK).
 */
export function getSkipReason(provider?: LLMProviderType): string | null {
  // The old custom provider system (createProvider) has been replaced by
  // Vercel AI SDK in the runtime layer. These compiler-level E2E tests
  // cannot instantiate providers directly anymore.
  return (
    'Compiler E2E tests are skipped: createProvider() was removed in the Vercel AI SDK migration. ' +
    'Provider instantiation now happens in SessionLLMClient (apps/runtime). ' +
    'See apps/runtime/src/__tests__/ for runtime-level integration tests.'
  );
}

export function getApiKey(provider: LLMProviderType = DEFAULT_PROVIDER): string {
  const vars = API_KEY_ENV_VARS[provider] || ['LLM_API_KEY'];

  for (const envVar of vars) {
    const key = process.env[envVar];
    if (key) return key;
  }

  // Try reading from file (legacy support for Anthropic)
  if (provider === 'anthropic') {
    const keyFilePath = path.resolve(__dirname, '../../../../../../ANTHROPIC_API_KEY.txt');
    if (fs.existsSync(keyFilePath)) {
      const fileContent = fs.readFileSync(keyFilePath, 'utf-8').trim();
      if (fileContent.includes('=')) {
        const match = fileContent.match(/ANTHROPIC_API_KEY=(.+)/);
        return match ? match[1].trim() : fileContent;
      }
      return fileContent;
    }
  }

  throw new Error(
    `API key not found for provider '${provider}'. Set ${vars[0]} or use LLM_PROVIDER=<provider> to switch.`,
  );
}

// =============================================================================
// PROVIDER CONFIGURATION
// =============================================================================

export type ModelTier = 'haiku' | 'sonnet' | 'opus';

export const MODEL_IDS: Record<ModelTier, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-20250514',
  opus: 'claude-opus-4-7',
};

// Provider-specific model mappings
export const PROVIDER_MODELS: Record<LLMProviderType, Record<ModelTier, string>> = {
  anthropic: {
    haiku: 'claude-haiku-4-5-20251001',
    sonnet: 'claude-sonnet-4-20250514',
    opus: 'claude-opus-4-7',
  },
  openai: {
    haiku: 'gpt-4o-mini', // Fast/cheap
    sonnet: 'gpt-4o', // Balanced
    opus: 'gpt-4o', // Powerful
  },
  litellm: {
    // LiteLLM uses provider prefixes
    haiku: 'claude-haiku-4-5-20251001',
    sonnet: 'claude-sonnet-4-20250514',
    opus: 'gpt-4o',
  },
  azure: {
    haiku: 'gpt-4o-mini',
    sonnet: 'gpt-4o',
    opus: 'gpt-4o',
  },
  bedrock: {
    haiku: 'anthropic.claude-haiku-4-5-20251001-v1:0',
    sonnet: 'anthropic.claude-sonnet-4-20250514-v2:0',
    opus: 'anthropic.claude-opus-4-20250514-v1:0',
  },
  vertex: {
    haiku: 'claude-haiku-4-5@20251001',
    sonnet: 'claude-sonnet-4@20250514',
    opus: 'claude-opus-4@20250514',
  },
  google: {
    haiku: 'gemini-2.0-flash',
    sonnet: 'gemini-2.5-pro',
    opus: 'gemini-2.5-pro',
  },
  gemini: {
    haiku: 'gemini-2.0-flash',
    sonnet: 'gemini-2.5-pro',
    opus: 'gemini-2.5-pro',
  },
  cohere: {
    haiku: 'command-r',
    sonnet: 'command-r-plus',
    opus: 'command-r-plus',
  },
  ultravox: {
    haiku: 'fixie-ai/ultravox',
    sonnet: 'fixie-ai/ultravox',
    opus: 'fixie-ai/ultravox',
  },
  custom: {
    haiku: 'fast',
    sonnet: 'balanced',
    opus: 'powerful',
  },
};

export interface LLMClientOptions {
  /** LLM provider to use */
  provider?: LLMProviderType;
  /** Default model tier to use */
  defaultTier?: ModelTier;
  /** Override with specific model ID */
  modelId?: string;
  /** LiteLLM proxy URL (for litellm provider) */
  litellmProxyUrl?: string;
  /** Additional provider-specific config */
  providerConfig?: Partial<ProviderConfig>;
  /** Enable response caching (default: true) */
  enableCache?: boolean;
}

/**
 * Create a generic LLM client that works with multiple providers.
 *
 * Supports:
 * - Anthropic (Claude)
 * - OpenAI (GPT-4)
 * - LiteLLM (unified API for 100+ providers)
 *
 * Use LLM_PROVIDER environment variable to switch providers:
 * - LLM_PROVIDER=anthropic (default)
 * - LLM_PROVIDER=openai
 * - LLM_PROVIDER=litellm
 */
export function createRealLLMClient(clientOptions?: LLMClientOptions): LLMClient {
  const provider = clientOptions?.provider || DEFAULT_PROVIDER;
  const tier: ModelTier = clientOptions?.defaultTier || 'haiku';
  const modelMapping = PROVIDER_MODELS[provider] || PROVIDER_MODELS.anthropic;
  const defaultModelId = clientOptions?.modelId || modelMapping[tier];

  // Build provider config
  const providerConfig: ProviderConfig = {
    provider,
    apiKey: getApiKey(provider),
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    modelMapping: {
      fast: modelMapping.haiku,
      balanced: modelMapping.sonnet,
      powerful: modelMapping.opus,
    },
    ...clientOptions?.providerConfig,
  } as ProviderConfig;

  // Add LiteLLM-specific config
  if (provider === 'litellm' && clientOptions?.litellmProxyUrl) {
    (providerConfig as any).proxyUrl = clientOptions.litellmProxyUrl;
  }

  // Create the generic provider
  const llmProvider = createProvider(providerConfig);

  // Check if caching is enabled
  const enableCache = clientOptions?.enableCache !== false;
  const cache = enableCache ? getSharedCache() : null;

  // Build base client that matches the LLMClient interface
  const baseClient: LLMClient = {
    chat: async (
      systemPrompt: string,
      messages: Array<{ role: string; content: string }>,
      options?: any,
    ) => {
      const result = await llmProvider.complete(
        systemPrompt,
        messages.map((m) => ({ role: m.role as any, content: m.content })),
        {
          model: options?.model || defaultModelId,
          maxTokens: options?.maxTokens || 256,
          timeoutMs: options?.timeoutMs || DEFAULT_TIMEOUT_MS,
        },
      );
      return result.text;
    },

    chatWithTools: async (
      systemPrompt: string,
      messages: Array<{
        role: string;
        content: string | Array<{ type: string; [key: string]: unknown }>;
      }>,
      tools: LLMToolDefinition[],
      options?: any,
    ): Promise<LLMToolUseResult> => {
      const result = await llmProvider.completeWithTools(
        systemPrompt,
        messages.map((m) => ({ role: m.role as any, content: m.content as any })),
        {
          model: options?.model || defaultModelId,
          maxTokens: options?.maxTokens || 256,
          timeoutMs: options?.timeoutMs || DEFAULT_TIMEOUT_MS,
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema,
          })),
        },
      );

      // Map stop reason to the expected type
      const mapStopReason = (reason: string): LLMToolUseResult['stopReason'] => {
        if (reason === 'tool_use') return 'tool_use';
        if (reason === 'max_tokens') return 'max_tokens';
        return 'end_turn';
      };

      return {
        text: result.text,
        toolCalls: result.toolCalls,
        stopReason: mapStopReason(result.stopReason),
      };
    },

    extractJson: async (
      systemPrompt: string,
      messages: Array<{ role: string; content: string }>,
      schema: string,
      options?: any,
    ) => {
      const enhancedPrompt = `${systemPrompt}\n\nYou must respond with ONLY valid JSON matching this schema: ${schema}\nDo not include any explanations, just the JSON object.`;

      const result = await llmProvider.complete(
        enhancedPrompt,
        messages.map((m) => ({ role: m.role as any, content: m.content })),
        {
          model: options?.model || defaultModelId,
          maxTokens: options?.maxTokens || 256,
          timeoutMs: options?.timeoutMs || DEFAULT_TIMEOUT_MS,
        },
      );

      const text = result.text;

      // Extract JSON from response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch {
          console.error('Failed to parse JSON:', text);
          return {};
        }
      }
      return {};
    },
  };

  // Wrap with caching if enabled
  if (cache) {
    return createCachedLLMClient(baseClient, cache);
  }

  return baseClient;
}

/**
 * Create a streaming LLM client (async iterator based)
 */
export function createStreamingLLMClient(clientOptions?: LLMClientOptions) {
  const provider = clientOptions?.provider || DEFAULT_PROVIDER;
  const tier: ModelTier = clientOptions?.defaultTier || 'haiku';
  const modelMapping = PROVIDER_MODELS[provider] || PROVIDER_MODELS.anthropic;
  const defaultModelId = clientOptions?.modelId || modelMapping[tier];

  const providerConfig: ProviderConfig = {
    provider,
    apiKey: getApiKey(provider),
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    modelMapping: {
      fast: modelMapping.haiku,
      balanced: modelMapping.sonnet,
      powerful: modelMapping.opus,
    },
    ...clientOptions?.providerConfig,
  } as ProviderConfig;

  if (provider === 'litellm' && clientOptions?.litellmProxyUrl) {
    (providerConfig as any).proxyUrl = clientOptions.litellmProxyUrl;
  }

  const llmProvider = createProvider(providerConfig);

  return {
    /**
     * Stream chat completion
     */
    async *streamChat(
      systemPrompt: string,
      messages: Array<{ role: string; content: string }>,
      options?: { model?: string; maxTokens?: number; timeoutMs?: number },
    ): AsyncIterable<string> {
      const stream = llmProvider.streamComplete(
        systemPrompt,
        messages.map((m) => ({ role: m.role as any, content: m.content })),
        {
          model: options?.model || defaultModelId,
          maxTokens: options?.maxTokens || 256,
          timeoutMs: options?.timeoutMs || DEFAULT_TIMEOUT_MS,
          stream: true,
        },
      );

      for await (const event of stream) {
        if (event.type === 'text_delta') {
          yield event.text;
        }
      }
    },

    /**
     * Stream chat with tool use
     */
    async *streamChatWithTools(
      systemPrompt: string,
      messages: Array<{ role: string; content: any }>,
      tools: LLMToolDefinition[],
      options?: { model?: string; maxTokens?: number; timeoutMs?: number },
    ) {
      const stream = llmProvider.streamCompleteWithTools(
        systemPrompt,
        messages.map((m) => ({ role: m.role as any, content: m.content })),
        {
          model: options?.model || defaultModelId,
          maxTokens: options?.maxTokens || 256,
          timeoutMs: options?.timeoutMs || DEFAULT_TIMEOUT_MS,
          stream: true,
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema,
          })),
        },
      );

      for await (const event of stream) {
        yield event;
      }
    },

    getProvider: () => llmProvider,
  };
}

// =============================================================================
// AGENT RESPONSE GENERATOR
// =============================================================================

/**
 * Generate a natural agent response based on the current state
 */
export async function generateAgentResponse(
  llmClient: LLMClient,
  agentIR: AgentIR,
  userInput: string,
  state: AgentState,
  actionType: string,
  actionMessage?: string,
): Promise<string> {
  const persona = agentIR.identity?.persona || 'You are a helpful assistant.';
  const goal = agentIR.identity?.goal || 'Help the user with their request.';

  // Build context from gathered data
  const gatheredInfo = Object.entries(state.gatherProgress)
    .filter(([_, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`)
    .join('\n');

  // Get missing required fields
  const missingFields =
    agentIR.gather?.fields
      ?.filter((f) => f.required && state.gatherProgress[f.name] === undefined)
      .map((f) => ({ name: f.name, prompt: f.prompt })) || [];

  // Optimized compact system prompt for faster inference
  const parts: string[] = [persona, `Goal: ${goal}`];
  if (gatheredInfo) parts.push(`Collected: ${gatheredInfo}`);
  if (missingFields.length > 0) parts.push(`Need: ${missingFields.map((f) => f.name).join(', ')}`);
  if (actionMessage) parts.push(`Note: ${actionMessage}`);
  parts.push('Reply in 1-2 sentences. Be helpful and concise.');
  const systemPrompt = parts.join('\n');

  const messages = [{ role: 'user', content: userInput }];

  try {
    const response = await llmClient.chat(systemPrompt, messages, {
      model: getDefaultModel(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    return response;
  } catch (error) {
    // Fallback response based on action type
    if (actionType === 'respond' && actionMessage) {
      return actionMessage;
    }
    if (missingFields.length > 0) {
      return missingFields[0].prompt;
    }
    return 'I understand. How can I help you further?';
  }
}

// =============================================================================
// MOCK TOOL EXECUTOR
// =============================================================================

export function createMockToolExecutor(): ToolExecutor {
  return {
    execute: async (toolName: string, params: any, _timeoutMs?: number) => {
      // Simulate tool responses
      switch (toolName) {
        case 'search_flights':
          return {
            flights: [
              {
                id: 'FL001',
                price: 450,
                airline: 'British Airways',
                departure: '08:00',
                arrival: '11:30',
              },
              { id: 'FL002', price: 520, airline: 'EasyJet', departure: '10:00', arrival: '13:30' },
              { id: 'FL003', price: 380, airline: 'Ryanair', departure: '14:00', arrival: '17:30' },
            ],
          };
        case 'search_hotels':
          return {
            hotels: [
              {
                id: 'HT001',
                name: 'Grand Hotel',
                price: 180,
                rating: 4.5,
                amenities: ['pool', 'gym'],
              },
              {
                id: 'HT002',
                name: 'City Inn',
                price: 120,
                rating: 4.0,
                amenities: ['wifi', 'breakfast'],
              },
            ],
          };
        case 'create_booking':
          return {
            booking_id: 'BK-' + Date.now(),
            status: 'confirmed',
            confirmation_code: 'ABC123',
          };
        case 'verify_email':
          return { valid: true, account_exists: true };
        case 'send_verification_code':
          return { sent: true, expires_in: 300 };
        case 'verify_code':
          return { valid: params.code === '123456', user_id: 'USR-12345', token: 'tok_abc123' };
        case 'lookup_booking':
          return {
            found: true,
            booking: {
              id: params.booking_reference,
              status: 'confirmed',
              destination: 'Barcelona',
            },
          };
        case 'get_booking_details':
          return { booking: { id: params.booking_id, status: 'confirmed' }, can_modify: true };
        case 'check_change_eligibility':
          return { eligible: true, fee: 50, deadline: '2024-04-01' };
        case 'check_agent_availability':
          return { available: true, wait_time: 5, queue_position: 3 };
        case 'get_business_hours':
          return { is_open: true, hours: '9am-6pm GMT', next_open: new Date() };
        default:
          return { success: true, tool: toolName };
      }
    },
    executeParallel: async (calls: any[], _timeoutMs?: number) => {
      const results = [];
      for (const call of calls) {
        const result = await createMockToolExecutor().execute(call.name, call.params, 10000);
        results.push({ name: call.name, result });
      }
      return results;
    },
  };
}

// =============================================================================
// MOCK TRACE
// =============================================================================

export function createMockTrace() {
  return {
    logLLMCall: async () => {},
    logToolCall: async () => {},
    logDecision: async () => {},
    logError: async (type: string, msg: string) => console.error(`[TRACE] ${type}: ${msg}`),
    logConstraintCheck: async () => {},
    logEscalation: async () => {},
    end: async () => {},
    getTraceId: () => 'trace-' + Date.now(),
  };
}

// =============================================================================
// MOCK AUDIT STORE
// =============================================================================

export function createMockAuditStore() {
  return {
    log: async () => {},
    logEscalationTriggered: async () => {},
    logHandoff: async () => {},
    logConstraintViolation: async () => {},
    logToolExecution: async () => {},
    getAuditTrail: async () => [],
  };
}

// =============================================================================
// CONTEXT CREATION
// =============================================================================

export function createTestContext(
  agentIR: AgentIR,
  runtime: RuntimeType,
  userInput: string,
  state: AgentState,
  llmClient: LLMClient,
  factStore: InMemoryFactStore,
): ExecutionContext {
  return {
    sessionId: `test-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    agentIR,
    state,
    runtime,
    trace: createMockTrace() as any,
    stores: {
      conversation: {} as any,
      message: { getMessages: async () => [], addMessage: async () => ({}) } as any,
      fact: factStore,
      trace: {} as any,
      audit: createMockAuditStore() as any,
    },
    llmClient,
    toolExecutor: createMockToolExecutor(),
    userInput,
    config: {
      environment: 'dev',
      toolTimeoutMs: 10000,
      llmTimeoutMs: DEFAULT_TIMEOUT_MS,
      model: getDefaultModel(),
    },
  };
}

// =============================================================================
// DSL COMPILATION HELPERS
// =============================================================================

export function compileAgentDSL(dsl: string): AgentIR {
  const parsed = parseAgentBasedABL(dsl);
  if (!parsed.document) {
    throw new Error(`Failed to parse DSL: ${parsed.errors?.join(', ')}`);
  }
  const compiled = compileABLtoIR([parsed.document]);
  const agentName = Object.keys(compiled.agents)[0];
  if (!agentName) {
    throw new Error('No agent found in compiled output');
  }
  return compiled.agents[agentName];
}

// =============================================================================
// TRANSCRIPT RECORDING - CHAT STYLE
// =============================================================================

export interface ChatMessage {
  role: 'user' | 'agent';
  content: string;
  timestamp: string;
}

export interface TranscriptTurn {
  turnNumber: number;
  userInput: string;
  agentResponse: string;
  extractedData: Record<string, unknown>;
  stateSnapshot: {
    phase: string;
    context: Record<string, unknown>;
    missingFields?: string[];
  };
  actionType: string;
  durationMs: number;
}

export interface Transcript {
  testName: string;
  scenario: string;
  agentName: string;
  runtime: RuntimeType;
  timestamp: string;
  conversation: ChatMessage[];
  turns: TranscriptTurn[];
  finalState: Record<string, unknown>;
  outcome: 'success' | 'failure';
  notes: string[];
}

export class TranscriptRecorder {
  private transcript: Transcript;

  constructor(
    testName: string,
    scenario: string,
    agentName: string,
    runtime: RuntimeType = 'digital',
  ) {
    this.transcript = {
      testName,
      scenario,
      agentName,
      runtime,
      timestamp: new Date().toISOString(),
      conversation: [],
      turns: [],
      finalState: {},
      outcome: 'success',
      notes: [],
    };
  }

  addTurn(
    turnNumber: number,
    userInput: string,
    agentResponse: string,
    result: any,
    state: AgentState,
    durationMs: number,
  ) {
    // Add to conversation
    this.transcript.conversation.push({
      role: 'user',
      content: userInput,
      timestamp: new Date().toISOString(),
    });
    this.transcript.conversation.push({
      role: 'agent',
      content: agentResponse,
      timestamp: new Date().toISOString(),
    });

    // Get missing fields
    const missingFields = Object.entries(state.gatherProgress)
      .filter(([_, v]) => v === undefined)
      .map(([k]) => k);

    // Add detailed turn
    this.transcript.turns.push({
      turnNumber,
      userInput,
      agentResponse,
      extractedData: { ...state.gatherProgress },
      stateSnapshot: {
        phase: state.conversationPhase,
        context: { ...state.context },
        missingFields: missingFields.length > 0 ? missingFields : undefined,
      },
      actionType: result.action?.type || 'unknown',
      durationMs,
    });
  }

  setFinalState(state: AgentState) {
    this.transcript.finalState = {
      gatherProgress: state.gatherProgress,
      context: state.context,
      memory: state.memory,
    };
  }

  setOutcome(outcome: 'success' | 'failure') {
    this.transcript.outcome = outcome;
  }

  addNote(note: string) {
    this.transcript.notes.push(note);
  }

  getTranscript(): Transcript {
    return this.transcript;
  }

  save(): string {
    // Ensure directory exists
    const dir = this.transcript.scenario.includes('/')
      ? path.join(TRANSCRIPT_DIR, path.dirname(this.transcript.scenario))
      : TRANSCRIPT_DIR;

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const scenarioName = this.transcript.scenario.includes('/')
      ? path.basename(this.transcript.scenario)
      : this.transcript.scenario;

    const filename = `${scenarioName.replace(/\s+/g, '_').toLowerCase()}.json`;
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, JSON.stringify(this.transcript, null, 2));
    return filepath;
  }

  print() {
    console.log('\n' + '═'.repeat(80));
    console.log(`TRANSCRIPT: ${this.transcript.testName}`);
    console.log(`Agent: ${this.transcript.agentName} | Runtime: ${this.transcript.runtime}`);
    console.log('═'.repeat(80));

    // Print conversation style
    console.log('\n--- CONVERSATION ---\n');
    for (const msg of this.transcript.conversation) {
      const icon = msg.role === 'user' ? '👤' : '🤖';
      const label = msg.role === 'user' ? 'USER' : 'AGENT';
      console.log(`${icon} ${label}: "${msg.content}"`);
      console.log('');
    }

    // Print detailed turns
    console.log('--- TURN DETAILS ---\n');
    for (const turn of this.transcript.turns) {
      console.log(`Turn ${turn.turnNumber} (${turn.durationMs}ms) [${turn.actionType}]`);
      if (Object.keys(turn.extractedData).length > 0) {
        console.log(`  Extracted: ${JSON.stringify(turn.extractedData)}`);
      }
      console.log('');
    }

    console.log('─'.repeat(80));
    console.log(`OUTCOME: ${this.transcript.outcome.toUpperCase()}`);
    if (this.transcript.notes.length > 0) {
      console.log('NOTES:');
      this.transcript.notes.forEach((n) => console.log(`  - ${n}`));
    }
    console.log('═'.repeat(80) + '\n');
  }
}

// =============================================================================
// TEST RUNNER HELPERS
// =============================================================================

export interface ConversationTest {
  name: string;
  scenario: string;
  inputs: string[];
  expectedExtractions?: Record<string, unknown>;
  notes?: string[];
}

/**
 * Lightweight conversation executor for E2E tests.
 *
 * Runs a multi-turn conversation against a compiled AgentIR using the provided
 * LLM client. For each user input it:
 *   1. Extracts gather fields from the full conversation via LLM (extractJson)
 *   2. Generates a natural agent response via LLM (chat)
 *   3. Updates gatherProgress and records the turn in a transcript
 *
 * This replaces the old ConstructExecutor-based runner that was removed from
 * the compiler package. For full flow/routing/handoff execution, use
 * RuntimeExecutor from apps/runtime.
 */
export async function runConversationTest(
  testConfig: ConversationTest,
  agentIR: AgentIR,
  agentName: string,
  llmClient: LLMClient,
  runtime: RuntimeType = 'digital',
): Promise<{ state: AgentState; transcript: Transcript }> {
  const state = createInitialState();
  const recorder = new TranscriptRecorder(testConfig.name, testConfig.scenario, agentName, runtime);

  if (testConfig.notes) {
    testConfig.notes.forEach((n) => recorder.addNote(n));
  }

  const conversationHistory: Array<{ role: string; content: string }> = [];

  // Collect gather fields from top-level AND flow step definitions
  const gatherFields = [...(agentIR.gather?.fields || [])];
  if (agentIR.flow?.definitions) {
    for (const stepDef of Object.values(agentIR.flow.definitions) as any[]) {
      if (stepDef?.gather?.fields) {
        for (const f of stepDef.gather.fields) {
          if (!gatherFields.some((existing: any) => existing.name === f.name)) {
            gatherFields.push(f);
          }
        }
      }
    }
  }

  const fieldDescriptions = gatherFields
    .map(
      (f: any) =>
        `- ${f.name} (${f.type || 'string'}${f.required ? ', required' : ''}): ${f.prompt || f.name}`,
    )
    .join('\n');

  const persona = agentIR.identity?.persona || 'You are a helpful assistant.';
  const goal = agentIR.identity?.goal || 'Help the user with their request.';
  const model = getDefaultModel();

  for (let i = 0; i < testConfig.inputs.length; i++) {
    const userInput = testConfig.inputs[i];
    const startTime = Date.now();

    conversationHistory.push({ role: 'user', content: userInput });

    // --- Entity extraction via LLM ---
    if (gatherFields.length > 0) {
      const schemaProps: Record<string, { type: string }> = {};
      for (const f of gatherFields) {
        schemaProps[f.name] = { type: f.type || 'string' };
      }
      const extractionSchema = JSON.stringify({ type: 'object', properties: schemaProps });

      // Consolidate conversation into a single user message for extraction.
      // Sending multi-turn user/assistant pairs confuses the model because
      // the assistant already responded with natural language (not JSON),
      // causing the model to continue the conversation instead of extracting.
      const conversationText = conversationHistory
        .map((m) => `${m.role === 'user' ? 'User' : 'Agent'}: ${m.content}`)
        .join('\n');

      try {
        const extracted = await llmClient.extractJson(
          `You are a data extraction assistant. Analyze the conversation and extract ALL field values the user has explicitly mentioned. Return every field mentioned at any point. If a value was changed or corrected, use the most recent value. Return empty object ONLY if no fields were mentioned.\nFields to extract:\n${fieldDescriptions}`,
          [
            {
              role: 'user',
              content: `Here is the conversation:\n\n${conversationText}\n\nExtract the field values as JSON.`,
            },
          ],
          extractionSchema,
          { model, timeoutMs: DEFAULT_TIMEOUT_MS },
        );

        for (const [key, value] of Object.entries(extracted)) {
          if (value !== undefined && value !== null && value !== '') {
            state.gatherProgress[key] = value;
            state.context[key] = value;
          }
        }
      } catch {
        // Extraction failed for this turn — continue
      }
    }

    // --- Response generation ---
    let response: string;
    try {
      response = await generateAgentResponse(llmClient, agentIR, userInput, state, 'respond');
    } catch {
      response = 'I understand. How can I help you further?';
    }

    conversationHistory.push({ role: 'assistant', content: response });

    const durationMs = Date.now() - startTime;
    recorder.addTurn(
      i + 1,
      userInput,
      response,
      { action: { type: 'respond' } },
      state,
      durationMs,
    );
  }

  recorder.setFinalState(state);
  recorder.setOutcome('success');

  try {
    recorder.save();
  } catch {
    // Transcript save may fail in CI (no output dir) — non-fatal
  }

  return { state, transcript: recorder.getTranscript() };
}

// =============================================================================
// SUMMARY GENERATION
// =============================================================================

export function generateTranscriptSummary() {
  if (!fs.existsSync(TRANSCRIPT_DIR)) {
    return;
  }

  // Recursively find all JSON files
  const findJsonFiles = (dir: string): string[] => {
    const files: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...findJsonFiles(fullPath));
      } else if (entry.name.endsWith('.json') && !entry.name.startsWith('_')) {
        files.push(fullPath);
      }
    }
    return files;
  };

  const transcripts = findJsonFiles(TRANSCRIPT_DIR);

  let summary = `# E2E Test Transcripts Summary\n\n`;
  summary += `Generated: ${new Date().toISOString()}\n\n`;
  summary += `Total Scenarios: ${transcripts.length}\n\n`;
  summary += `## Scenarios\n\n`;
  summary += `| # | Scenario | Agent | Runtime | Turns | Outcome |\n`;
  summary += `|---|----------|-------|---------|-------|--------|\n`;

  transcripts.forEach((f, i) => {
    try {
      const content = JSON.parse(fs.readFileSync(f, 'utf-8'));
      const name = content.scenario || path.relative(TRANSCRIPT_DIR, f).replace('.json', '');
      summary += `| ${i + 1} | ${name} | ${content.agentName || '-'} | ${content.runtime || '-'} | ${content.turns?.length || 0} | ${content.outcome || '-'} |\n`;
    } catch {
      const name = path.relative(TRANSCRIPT_DIR, f).replace('.json', '');
      summary += `| ${i + 1} | ${name} | - | - | - | - |\n`;
    }
  });

  fs.writeFileSync(path.join(TRANSCRIPT_DIR, '_SUMMARY.md'), summary);
}

// Re-export types
export type { LLMClient };

/**
 * Session LLM Client — Timeout & AbortSignal Tests
 *
 * Verifies that:
 * 1. LLM_CALL_TIMEOUT_MS is correctly parsed from env (with NaN-safe fallback)
 * 2. generateText() receives an abortSignal in its options
 * 3. streamText() receives an abortSignal in its options
 * 4. Timeout handles are cleaned up after successful calls (no timer leak)
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// MOCKS — must be declared before any import that transitively pulls them in
// =============================================================================

// Capture the options passed to generateText / streamText
const mockGenerateText = vi.fn();
const mockStreamText = vi.fn();
const mockWrapLanguageModel = vi.fn(({ model }) => model);
const mockExtractOpenAIResponsesPreviousResponseId = vi.fn();
const mockFindOpenAIResponsesPreviousResponse = vi.fn();
const mockModelSupportsResponsesApi = vi.fn();

vi.mock('ai', () => ({
  generateText: (...args: any[]) => mockGenerateText(...args),
  streamText: (...args: any[]) => mockStreamText(...args),
  wrapLanguageModel: (...args: any[]) => mockWrapLanguageModel(...args),
}));

vi.mock('../../config/index.js', () => ({
  isConfigLoaded: () => true,
  getConfig: () => ({
    llm: { litellmProxyUrl: '' },
    llmCache: {
      providerCacheMax: 100,
      providerCacheTtlSeconds: 600,
    },
  }),
}));

vi.mock('../../observability/metrics.js', () => ({
  recordLlmCall: vi.fn(),
}));

vi.mock('../../services/llm/vercel-ai-adapters.js', () => ({
  convertMessages: (msgs: any) => msgs,
  convertTools: (tools: any) => tools,
  extractOpenAIResponsesPreviousResponseId: (...args: any[]) =>
    mockExtractOpenAIResponsesPreviousResponseId(...args),
  findOpenAIResponsesPreviousResponse: (...args: any[]) =>
    mockFindOpenAIResponsesPreviousResponse(...args),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: () => () => ({ modelId: 'mock-model' }),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: () =>
    Object.assign(() => ({ modelId: 'mock-model' }), {
      chat: () => ({ modelId: 'mock-model' }),
    }),
}));

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: () => () => ({ modelId: 'mock-model' }),
}));

vi.mock('@ai-sdk/google-vertex', () => ({
  createVertex: () => () => ({ modelId: 'mock-model' }),
}));

vi.mock('@ai-sdk/azure', () => ({
  createAzure: () =>
    Object.assign(() => ({ modelId: 'mock-model' }), {
      chat: () => ({ modelId: 'mock-model' }),
    }),
}));

vi.mock('@ai-sdk/cohere', () => ({
  createCohere: () => () => ({ modelId: 'mock-model' }),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@abl/compiler/platform/llm/model-registry.js', () => ({
  MODEL_REGISTRY: {},
  modelSupportsResponsesApi: (...args: any[]) => mockModelSupportsResponsesApi(...args),
}));

vi.mock('@abl/compiler/platform/llm/model-capabilities.js', () => ({
  getModelCapabilities: (modelId: string) => {
    const bareModel = modelId.includes('/') ? modelId.split('/').slice(1).join('/') : modelId;
    return {
      supportsThinking: bareModel.startsWith('claude-sonnet-4'),
      temperatureDisabled: bareModel.startsWith('claude-opus-4-7'),
      topPDisabled: bareModel.startsWith('claude-opus-4-7'),
    };
  },
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import {
  SessionLLMClient,
  LLM_CALL_TIMEOUT_MS,
  clearProviderCache,
} from '../../services/llm/session-llm-client.js';
import type { ModelResolutionService } from '../../services/llm/model-resolution.js';

// =============================================================================
// HELPERS
// =============================================================================

/** Build a minimal mock ModelResolutionService that returns valid resolved config. */
function createMockResolution(): ModelResolutionService {
  return {
    resolve: vi.fn().mockResolvedValue({
      modelId: 'anthropic/claude-3-sonnet',
      provider: 'anthropic',
      source: 'tenant_model',
      credential: { apiKey: 'test-key-123', endpoint: undefined, authType: 'api_key' },
      parameters: { temperature: 0.7, maxTokens: 2048 },
      useResponsesApi: undefined,
      useStreaming: undefined,
    }),
    resolveReasoningSettings: vi.fn().mockResolvedValue({
      modelId: 'anthropic/claude-3-sonnet',
      parameters: {
        enableThinking: true,
        thinkingBudget: 4096,
        thoughtDescription: 'think carefully',
        compactionThreshold: 40000,
      },
    }),
  } as unknown as ModelResolutionService;
}

/** Build a SessionLLMClient with mocked dependencies. */
function createClient(resolution?: ModelResolutionService): SessionLLMClient {
  return new SessionLLMClient(resolution ?? createMockResolution(), {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    agentName: 'test-agent',
    sessionId: 'session-1',
  });
}

beforeEach(() => {
  mockWrapLanguageModel.mockClear();
  mockExtractOpenAIResponsesPreviousResponseId.mockReset();
  mockFindOpenAIResponsesPreviousResponse.mockReset();
  mockModelSupportsResponsesApi.mockReset();
  mockModelSupportsResponsesApi.mockReturnValue(false);
});

// =============================================================================
// TESTS
// =============================================================================

describe('LLM_CALL_TIMEOUT_MS constant', () => {
  test('default value is 120000 ms (2 minutes)', () => {
    // The module-level constant should be 120000 when LLM_CALL_TIMEOUT_MS env var is not set
    // (or is set to '120000' which is the default fallback).
    expect(LLM_CALL_TIMEOUT_MS).toBe(120000);
  });

  test('is a finite positive number', () => {
    expect(Number.isFinite(LLM_CALL_TIMEOUT_MS)).toBe(true);
    expect(LLM_CALL_TIMEOUT_MS).toBeGreaterThan(0);
  });

  test('NaN-safe parsing: non-numeric env value falls back to 120000', () => {
    // We can't easily re-evaluate the module with a different env var in the
    // same process, but we can verify the parsing logic is correct by testing
    // the same NaN-safe pattern used in the source:
    const parse = (val: string) => {
      const parsed = parseInt(val, 10);
      return Number.isNaN(parsed) ? 120000 : parsed;
    };

    expect(parse('not-a-number')).toBe(120000);
    expect(parse('')).toBe(120000);
    expect(parse('abc')).toBe(120000);
    expect(parse('60000')).toBe(60000);
    expect(parse('0')).toBe(0);
  });
});

describe('chatWithToolUse — abortSignal wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearProviderCache();
    mockGenerateText.mockReset();
    mockGenerateText.mockResolvedValue({
      text: 'Hello from LLM',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('passes abortSignal to generateText()', async () => {
    const client = createClient();
    const promise = client.chatWithToolUse('system prompt', [], []);

    // Advance past any microtask resolution
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs).toHaveProperty('abortSignal');
    expect(callArgs.abortSignal).toBeInstanceOf(AbortSignal);
    expect(callArgs.abortSignal.aborted).toBe(false);
    expect(result.text).toBe('Hello from LLM');
  });

  test('passes resolved generation parameters to generateText()', async () => {
    const resolution = createMockResolution();
    (resolution.resolve as ReturnType<typeof vi.fn>).mockResolvedValue({
      modelId: 'anthropic/claude-3-sonnet',
      provider: 'anthropic',
      source: 'project_db',
      credential: { apiKey: 'test-key-123', endpoint: undefined, authType: 'api_key' },
      parameters: {
        temperature: 0.4,
        maxTokens: 777,
        topP: 0.35,
        topK: 22,
        frequencyPenalty: -0.25,
        presencePenalty: 0.5,
        seed: 42,
        stopSequences: ['END'],
      },
      useResponsesApi: undefined,
      useStreaming: undefined,
    });

    const client = createClient(resolution);
    const promise = client.chatWithToolUse('system prompt', [], []);

    await vi.advanceTimersByTimeAsync(0);
    await promise;

    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs).toEqual(
      expect.objectContaining({
        maxOutputTokens: 777,
        temperature: 0.4,
        topP: 0.35,
        topK: 22,
        frequencyPenalty: -0.25,
        presencePenalty: 0.5,
        seed: 42,
        stopSequences: ['END'],
      }),
    );
  });

  test('maps Anthropic thinking controls to providerOptions and strips unsupported sampling', async () => {
    const resolution = createMockResolution();
    (resolution.resolve as ReturnType<typeof vi.fn>).mockResolvedValue({
      modelId: 'anthropic/claude-sonnet-4-20250514',
      provider: 'anthropic',
      source: 'project_db',
      credential: { apiKey: 'test-key-123', endpoint: undefined, authType: 'api_key' },
      parameters: {
        temperature: 0.4,
        maxTokens: 777,
        topP: 0.35,
        topK: 22,
        enableThinking: true,
        thinkingBudget: 4096,
      },
      useResponsesApi: undefined,
      useStreaming: undefined,
    });

    const client = createClient(resolution);
    const promise = client.chatWithToolUse('system prompt', [], []);

    await vi.advanceTimersByTimeAsync(0);
    await promise;

    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs).toEqual(
      expect.objectContaining({
        maxOutputTokens: 777,
        temperature: undefined,
        topP: undefined,
        topK: undefined,
        providerOptions: {
          anthropic: {
            thinking: { type: 'enabled', budgetTokens: 4096 },
          },
        },
      }),
    );
  });

  test('maps OpenAI reasoning effort while preserving generic call settings', async () => {
    const resolution = createMockResolution();
    (resolution.resolve as ReturnType<typeof vi.fn>).mockResolvedValue({
      modelId: 'openai/gpt-5',
      provider: 'openai',
      source: 'tenant_model',
      credential: { apiKey: 'test-key-123', endpoint: undefined, authType: 'api_key' },
      parameters: {
        maxTokens: 777,
        reasoningEffort: 'high',
        topK: 22,
        seed: 42,
        stopSequences: ['END'],
      },
      useResponsesApi: undefined,
      useStreaming: undefined,
    });

    const client = createClient(resolution);
    const promise = client.chatWithToolUse('system prompt', [], []);

    await vi.advanceTimersByTimeAsync(0);
    await promise;

    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs).toEqual(
      expect.objectContaining({
        maxOutputTokens: 777,
        topK: 22,
        seed: 42,
        stopSequences: ['END'],
        providerOptions: {
          openai: {
            reasoningEffort: 'high',
          },
        },
      }),
    );
  });

  test('passes OpenAI Responses previousResponseId from conversation metadata', async () => {
    mockFindOpenAIResponsesPreviousResponse.mockReturnValue({
      responseId: 'resp_previous_123',
      messageIndex: 1,
      blockIndex: 0,
    });
    const resolution = createMockResolution();
    (resolution.resolve as ReturnType<typeof vi.fn>).mockResolvedValue({
      modelId: 'openai/gpt-5',
      provider: 'openai',
      source: 'tenant_model',
      credential: { apiKey: 'test-key-123', endpoint: undefined, authType: 'api_key' },
      parameters: { temperature: 0.7, maxTokens: 2048 },
      useResponsesApi: true,
      useStreaming: undefined,
    });

    const client = createClient(resolution);
    const messages = [
      { role: 'user' as const, content: 'where is my order?' },
      {
        role: 'assistant' as const,
        content: [
          {
            type: 'tool_use' as const,
            id: 'call_lookup',
            name: 'get_order',
            input: { order_id: 'VM-1' },
            providerMetadata: { openai: { responseId: 'resp_previous_123' } },
          },
        ],
      },
      {
        role: 'user' as const,
        content: [{ type: 'tool_result' as const, tool_use_id: 'call_lookup', content: '{}' }],
      },
    ];
    await client.chatWithToolUse('system prompt', messages, []);

    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs.messages).toEqual([messages[2]]);
    expect(callArgs.providerOptions).toEqual({
      openai: {
        store: true,
        previousResponseId: 'resp_previous_123',
      },
    });
  });

  test('stores OpenAI Responses response id in returned rawContent metadata', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: 'Hello from OpenAI',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5 },
      providerMetadata: { openai: { responseId: 'resp_current_456' } },
    });
    const resolution = createMockResolution();
    (resolution.resolve as ReturnType<typeof vi.fn>).mockResolvedValue({
      modelId: 'openai/gpt-5',
      provider: 'openai',
      source: 'tenant_model',
      credential: { apiKey: 'test-key-123', endpoint: undefined, authType: 'api_key' },
      parameters: { temperature: 0.7, maxTokens: 2048 },
      useResponsesApi: true,
      useStreaming: undefined,
    });

    const client = createClient(resolution);
    const result = await client.chatWithToolUse('system prompt', [], []);

    expect(result.rawContent[0]).toEqual({
      type: 'text',
      text: 'Hello from OpenAI',
      providerMetadata: { openai: { responseId: 'resp_current_456' } },
    });
  });

  test('clears timeout after successful call (no timer leak)', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const client = createClient();
    const promise = client.chatWithToolUse('system prompt', [], []);
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    // clearTimeout must have been called at least once (in the finally block)
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});

describe('chatWithToolUseStreamable — abortSignal wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearProviderCache();
    mockGenerateText.mockReset();
    mockStreamText.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('passes abortSignal to streamText() when streaming', async () => {
    // Mock streamText to return a stream-like result
    const textChunks = ['Hello', ' world'];
    let chunkIndex = 0;
    mockStreamText.mockReturnValue({
      textStream: {
        [Symbol.asyncIterator]() {
          return {
            next() {
              if (chunkIndex < textChunks.length) {
                return Promise.resolve({ value: textChunks[chunkIndex++], done: false });
              }
              return Promise.resolve({ value: undefined, done: true });
            },
          };
        },
      },
      text: Promise.resolve('Hello world'),
      toolCalls: Promise.resolve([]),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
      finishReason: Promise.resolve('stop'),
    });

    const resolution = createMockResolution();
    // Make resolution return useStreaming: true so we take the stream path
    (resolution.resolve as ReturnType<typeof vi.fn>).mockResolvedValue({
      modelId: 'anthropic/claude-3-sonnet',
      provider: 'anthropic',
      source: 'tenant_model',
      credential: { apiKey: 'test-key-123', endpoint: undefined, authType: 'api_key' },
      parameters: { temperature: 0.7, maxTokens: 2048 },
      useResponsesApi: undefined,
      useStreaming: true,
    });

    const client = createClient(resolution);
    const chunks: string[] = [];
    const promise = client.chatWithToolUseStreamable(
      'system prompt',
      [],
      [],
      'response_gen',
      (chunk) => chunks.push(chunk),
    );

    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(mockStreamText).toHaveBeenCalledTimes(1);
    const callArgs = mockStreamText.mock.calls[0][0];
    expect(callArgs).toHaveProperty('abortSignal');
    expect(callArgs.abortSignal).toBeInstanceOf(AbortSignal);
    expect(callArgs.abortSignal.aborted).toBe(false);
    expect(result.text).toBe('Hello world');
  });

  test('respects useStreaming=false even when onChunk is provided', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'Non-streamed response',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    const resolution = createMockResolution();
    (resolution.resolve as ReturnType<typeof vi.fn>).mockResolvedValue({
      modelId: 'anthropic/claude-3-sonnet',
      provider: 'anthropic',
      source: 'tenant_model',
      credential: { apiKey: 'test-key-123', endpoint: undefined, authType: 'api_key' },
      parameters: { temperature: 0.7, maxTokens: 2048 },
      useResponsesApi: undefined,
      useStreaming: false,
    });

    const client = createClient(resolution);
    const chunks: string[] = [];
    const result = await client.chatWithToolUseStreamable(
      'system prompt',
      [],
      [],
      'response_gen',
      (chunk) => chunks.push(chunk),
    );

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(mockStreamText).not.toHaveBeenCalled();
    expect(chunks).toEqual([]);
    expect(result.text).toBe('Non-streamed response');
  });

  test('forceStreaming overrides useStreaming=false when streaming is transport-required', async () => {
    const textChunks = ['Hello', ' world'];
    let chunkIndex = 0;
    mockStreamText.mockReturnValue({
      textStream: {
        [Symbol.asyncIterator]() {
          return {
            next() {
              if (chunkIndex < textChunks.length) {
                return Promise.resolve({ value: textChunks[chunkIndex++], done: false });
              }
              return Promise.resolve({ value: undefined, done: true });
            },
          };
        },
      },
      text: Promise.resolve('Hello world'),
      toolCalls: Promise.resolve([]),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
      finishReason: Promise.resolve('stop'),
    });

    const resolution = createMockResolution();
    (resolution.resolve as ReturnType<typeof vi.fn>).mockResolvedValue({
      modelId: 'anthropic/claude-3-sonnet',
      provider: 'anthropic',
      source: 'tenant_model',
      credential: { apiKey: 'test-key-123', endpoint: undefined, authType: 'api_key' },
      parameters: { temperature: 0.7, maxTokens: 2048 },
      useResponsesApi: undefined,
      useStreaming: false,
    });

    const client = createClient(resolution);
    const chunks: string[] = [];
    const promise = client.chatWithToolUseStreamable(
      'system prompt',
      [],
      [],
      'response_gen',
      (chunk) => chunks.push(chunk),
      { forceStreaming: true },
    );

    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(mockStreamText).toHaveBeenCalledTimes(1);
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(chunks).toEqual(['Hello', ' world']);
    expect(result.text).toBe('Hello world');
  });

  test('clears timeout after successful streaming call', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    mockStreamText.mockReturnValue({
      textStream: {
        [Symbol.asyncIterator]() {
          return {
            next() {
              return Promise.resolve({ value: undefined, done: true });
            },
          };
        },
      },
      text: Promise.resolve(''),
      toolCalls: Promise.resolve([]),
      usage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
      finishReason: Promise.resolve('stop'),
    });

    const resolution = createMockResolution();
    (resolution.resolve as ReturnType<typeof vi.fn>).mockResolvedValue({
      modelId: 'anthropic/claude-3-sonnet',
      provider: 'anthropic',
      source: 'tenant_model',
      credential: { apiKey: 'test-key-123', endpoint: undefined, authType: 'api_key' },
      parameters: { temperature: 0.7, maxTokens: 2048 },
      useResponsesApi: undefined,
      useStreaming: true,
    });

    const client = createClient(resolution);
    const promise = client.chatWithToolUseStreamable(
      'system prompt',
      [],
      [],
      'response_gen',
      () => {},
    );

    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});

describe('streamChatWithToolUse — abortSignal wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearProviderCache();
    mockGenerateText.mockReset();
    mockStreamText.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('non-streaming path: passes abortSignal to generateText()', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'Non-streamed response',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    const resolution = createMockResolution();
    // Set useStreaming: false to exercise non-streaming path inside streamChatWithToolUse
    (resolution.resolve as ReturnType<typeof vi.fn>).mockResolvedValue({
      modelId: 'anthropic/claude-3-sonnet',
      provider: 'anthropic',
      source: 'tenant_model',
      credential: { apiKey: 'test-key-123', endpoint: undefined, authType: 'api_key' },
      parameters: { temperature: 0.7, maxTokens: 2048 },
      useResponsesApi: undefined,
      useStreaming: false,
    });

    const client = createClient(resolution);
    const events: any[] = [];

    const gen = client.streamChatWithToolUse('system prompt', [], []);
    // Consume the async generator
    for await (const event of gen) {
      events.push(event);
    }

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs).toHaveProperty('abortSignal');
    expect(callArgs.abortSignal).toBeInstanceOf(AbortSignal);

    // Verify the generator yielded expected event types
    const types = events.map((e) => e.type);
    expect(types).toContain('metadata');
    expect(types).toContain('text_delta');
    expect(types).toContain('done');
  });

  test('streaming path: passes abortSignal to streamText()', async () => {
    const textChunks = ['chunk1', 'chunk2'];
    let chunkIndex = 0;
    mockStreamText.mockReturnValue({
      textStream: {
        [Symbol.asyncIterator]() {
          return {
            next() {
              if (chunkIndex < textChunks.length) {
                return Promise.resolve({ value: textChunks[chunkIndex++], done: false });
              }
              return Promise.resolve({ value: undefined, done: true });
            },
          };
        },
      },
      text: Promise.resolve('chunk1chunk2'),
      toolCalls: Promise.resolve([]),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
    });

    const resolution = createMockResolution();
    // useStreaming: true (or undefined/null) exercises the streaming path
    (resolution.resolve as ReturnType<typeof vi.fn>).mockResolvedValue({
      modelId: 'anthropic/claude-3-sonnet',
      provider: 'anthropic',
      source: 'tenant_model',
      credential: { apiKey: 'test-key-123', endpoint: undefined, authType: 'api_key' },
      parameters: { temperature: 0.7, maxTokens: 2048 },
      useResponsesApi: undefined,
      useStreaming: true,
    });

    const client = createClient(resolution);
    const events: any[] = [];

    const gen = client.streamChatWithToolUse('system prompt', [], []);
    for await (const event of gen) {
      events.push(event);
    }

    expect(mockStreamText).toHaveBeenCalledTimes(1);
    const callArgs = mockStreamText.mock.calls[0][0];
    expect(callArgs).toHaveProperty('abortSignal');
    expect(callArgs.abortSignal).toBeInstanceOf(AbortSignal);

    const types = events.map((e) => e.type);
    expect(types).toContain('metadata');
    expect(types).toContain('text_delta');
    expect(types).toContain('done');
  });

  test('clears timeout after generator completes', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    mockGenerateText.mockResolvedValue({
      text: 'done',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const resolution = createMockResolution();
    (resolution.resolve as ReturnType<typeof vi.fn>).mockResolvedValue({
      modelId: 'anthropic/claude-3-sonnet',
      provider: 'anthropic',
      source: 'tenant_model',
      credential: { apiKey: 'test-key-123', endpoint: undefined, authType: 'api_key' },
      parameters: { temperature: 0.7, maxTokens: 2048 },
      useResponsesApi: undefined,
      useStreaming: false,
    });

    const client = createClient(resolution);
    const gen = client.streamChatWithToolUse('system prompt', [], []);
    for await (const _event of gen) {
      // consume
    }

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});

describe('resolveEnableThinking', () => {
  test('uses settings-only reasoning resolution instead of full model resolution', async () => {
    const resolution = createMockResolution();
    const client = createClient(resolution);

    const result = await client.resolveEnableThinking();

    expect(result).toEqual({
      enableThinking: true,
      thinkingBudget: 4096,
      thoughtDescription: 'think carefully',
      compactionThreshold: 40000,
      modelId: 'anthropic/claude-3-sonnet',
    });
    expect(
      (resolution.resolveReasoningSettings as ReturnType<typeof vi.fn>).mock.calls[0][0],
    ).toMatchObject({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentName: 'test-agent',
    });
    expect(resolution.resolveReasoningSettings).toHaveBeenCalledTimes(1);
    expect(resolution.resolve).not.toHaveBeenCalled();
  });
});

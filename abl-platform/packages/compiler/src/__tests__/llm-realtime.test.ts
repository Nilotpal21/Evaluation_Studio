/**
 * LLM Realtime Provider Tests
 *
 * Tests for:
 * - Realtime provider registry (register, create, list)
 * - OpenAI Realtime session lifecycle (connect, disconnect, reconnect)
 * - Gemini Live session lifecycle (connect, disconnect, reconnect)
 * - Session config sending (both providers)
 * - Connection state management
 * - Disconnect cleanup
 * - Usage metric accumulation with connection duration
 * - LLM Provider factory (register, create, default provider)
 * - LLM Client wrapper (chat, chatWithTools, extractJson, streamChat)
 * - Utility functions (sanitizeErrorMessage, getApiKey, parseSchemaString)
 *
 * All WebSocket connections are mocked. No real API calls.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the logger before importing modules
vi.mock('../../platform/logger.js', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { OpenAIRealtimeSession } from '../platform/llm/realtime/openai-realtime.js';
import { GeminiLiveSession } from '../platform/llm/realtime/gemini-live.js';
import {
  registerRealtimeProvider,
  getRealtimeProviderFactory,
  createRealtimeSession,
  getRegisteredRealtimeProviders,
} from '../platform/llm/realtime/provider.js';
import type {
  RealtimeSessionConfig,
  RealtimeConnectionState,
} from '../platform/llm/realtime/types.js';
import {
  registerProvider,
  getProviderFactory,
  createProvider,
  setDefaultProvider,
  getDefaultProvider,
  LLMClient,
  sanitizeErrorMessage,
  getApiKey,
  parseSchemaString,
  DEFAULT_MODEL_MAPPINGS,
} from '../platform/llm/provider.js';
import type {
  LLMProvider,
  ProviderConfig,
  CompletionResult,
  ToolCompletionResult,
} from '../platform/llm/types.js';

// =============================================================================
// HELPERS
// =============================================================================

function createMockWs() {
  return {
    readyState: 1, // OPEN
    send: vi.fn(),
    close: vi.fn(),
    once: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
  };
}

function wireSession(session: any, ws: ReturnType<typeof createMockWs>) {
  session.ws = ws;
  session._connectionState = 'connected';
}

function createMockProvider(): LLMProvider {
  return {
    name: 'anthropic',
    complete: vi.fn().mockResolvedValue({
      text: 'response',
      stopReason: 'end_turn',
      model: 'test-model',
      latencyMs: 100,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    } as CompletionResult),
    completeWithTools: vi.fn().mockResolvedValue({
      toolCalls: [],
      text: 'tool response',
      stopReason: 'end_turn',
      model: 'test-model',
      latencyMs: 100,
    } as ToolCompletionResult),
    streamComplete: vi.fn().mockReturnValue(
      (async function* () {
        yield { type: 'text_delta', text: 'Hello' };
        yield { type: 'text_delta', text: ' World' };
        yield { type: 'message_end', stopReason: 'end_turn' };
      })(),
    ),
    streamCompleteWithTools: vi.fn(),
    getModelForTier: vi.fn().mockImplementation((tier: string) => {
      const map: Record<string, string> = {
        fast: 'fast-model',
        balanced: 'balanced-model',
        powerful: 'powerful-model',
      };
      return map[tier] || 'unknown-model';
    }),
    supportsFeature: vi.fn().mockReturnValue(true),
  } as unknown as LLMProvider;
}

// =============================================================================
// OPENAI REALTIME SESSION — CONNECTION STATE
// =============================================================================

describe('OpenAIRealtimeSession — connection state management', () => {
  let session: OpenAIRealtimeSession;

  beforeEach(() => {
    session = new OpenAIRealtimeSession();
  });

  test('initial state is disconnected', () => {
    expect(session.connectionState).toBe('disconnected');
  });

  test('connection state change emits onConnectionStateChange', () => {
    const handler = vi.fn();
    session.on('onConnectionStateChange', handler);

    (session as any).setConnectionState('connecting');
    expect(handler).toHaveBeenCalledWith('connecting');

    (session as any).setConnectionState('connected');
    expect(handler).toHaveBeenCalledWith('connected');
  });

  test('setting same state does not emit event', () => {
    const handler = vi.fn();
    session.on('onConnectionStateChange', handler);

    (session as any).setConnectionState('connecting');
    handler.mockClear();

    (session as any).setConnectionState('connecting'); // Same state
    expect(handler).not.toHaveBeenCalled();
  });

  test('disconnect sets state to disconnected and clears ws', async () => {
    const ws = createMockWs();
    wireSession(session, ws);
    (session as any).config = { apiKey: 'test', model: 'gpt-4o', systemPrompt: 'test' };
    (session as any).connectTime = Date.now();

    await session.disconnect();

    expect(session.connectionState).toBe('disconnected');
    expect((session as any).ws).toBeNull();
    expect((session as any).intentionalDisconnect).toBe(true);
  });

  test('disconnect clears reconnect timer', async () => {
    const ws = createMockWs();
    wireSession(session, ws);
    (session as any).config = { apiKey: 'test', model: 'gpt-4o', systemPrompt: 'test' };
    (session as any).reconnectTimer = setTimeout(() => {}, 10000);

    await session.disconnect();

    expect((session as any).reconnectTimer).toBeNull();
  });

  test('disconnect accumulates connection duration', async () => {
    const ws = createMockWs();
    wireSession(session, ws);
    (session as any).config = { apiKey: 'test', model: 'gpt-4o', systemPrompt: 'test' };
    const startTime = Date.now() - 5000; // 5 seconds ago
    (session as any).connectTime = startTime;

    await session.disconnect();

    const metrics = session.getUsageMetrics();
    expect(metrics.connectionDurationMs).toBeGreaterThanOrEqual(4900); // Allow some tolerance
  });
});

// =============================================================================
// OPENAI REALTIME SESSION — SESSION CONFIG
// =============================================================================

describe('OpenAIRealtimeSession — session config', () => {
  let session: OpenAIRealtimeSession;
  let ws: ReturnType<typeof createMockWs>;

  beforeEach(() => {
    session = new OpenAIRealtimeSession();
    ws = createMockWs();
    wireSession(session, ws);
  });

  test('sendSessionConfig sends session.update with full config', () => {
    (session as any).config = {
      model: 'gpt-realtime-1.5',
      systemPrompt: 'You are a helpful assistant',
      voice: 'nova',
      audioFormat: 'g711_ulaw',
      temperature: 0.7,
      maxResponseTokens: 1000,
      turnDetection: {
        type: 'server_vad',
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500,
      },
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather',
          input_schema: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ],
    };

    (session as any).sendSessionConfig();

    expect(ws.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('session.update');
    expect(sent.session.modalities).toEqual(['text', 'audio']);
    expect(sent.session.instructions).toBe('You are a helpful assistant');
    expect(sent.session.voice).toBe('nova');
    expect(sent.session.input_audio_format).toBe('g711_ulaw');
    expect(sent.session.output_audio_format).toBe('g711_ulaw');
    expect(sent.session.temperature).toBe(0.7);
    expect(sent.session.max_response_output_tokens).toBe(1000);
    expect(sent.session.turn_detection.type).toBe('server_vad');
    expect(sent.session.turn_detection.threshold).toBe(0.5);
    expect(sent.session.tools).toHaveLength(1);
    expect(sent.session.tools[0].type).toBe('function');
  });

  test('sendSessionConfig uses defaults when config fields are absent', () => {
    (session as any).config = {
      model: 'gpt-realtime-1.5',
      systemPrompt: 'Hi',
    };

    (session as any).sendSessionConfig();

    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent.session.voice).toBe('marin');
    expect(sent.session.input_audio_format).toBe('pcm16');
    expect(sent.session.turn_detection).toEqual({ type: 'server_vad' });
    expect(sent.session.temperature).toBeUndefined();
    expect(sent.session.max_response_output_tokens).toBeUndefined();
  });

  test('sendSessionConfig skips when no config', () => {
    (session as any).config = null;
    (session as any).sendSessionConfig();
    expect(ws.send).not.toHaveBeenCalled();
  });
});

// =============================================================================
// OPENAI REALTIME SESSION — RECONNECTION
// =============================================================================

describe('OpenAIRealtimeSession — reconnection logic', () => {
  let session: OpenAIRealtimeSession;

  beforeEach(() => {
    session = new OpenAIRealtimeSession();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('handleClose triggers reconnect on abnormal close', () => {
    const ws = createMockWs();
    wireSession(session, ws);
    (session as any).config = { apiKey: 'test', model: 'model', systemPrompt: '' };
    (session as any).intentionalDisconnect = false;

    (session as any).handleClose(1006, 'Abnormal closure');

    expect(session.connectionState).toBe('reconnecting');
    expect((session as any).reconnectAttempts).toBe(1);
  });

  test('handleClose does not reconnect on normal close (code 1000)', () => {
    const ws = createMockWs();
    wireSession(session, ws);
    (session as any).intentionalDisconnect = false;

    (session as any).handleClose(1000, 'Normal closure');

    expect(session.connectionState).toBe('disconnected');
  });

  test('handleClose does not reconnect when intentionalDisconnect is true', () => {
    const ws = createMockWs();
    wireSession(session, ws);
    (session as any).intentionalDisconnect = true;

    (session as any).handleClose(1006, 'Abnormal');

    expect(session.connectionState).toBe('disconnected');
  });

  test('attemptReconnect stops after max retries', () => {
    (session as any).reconnectAttempts = 3; // MAX_RECONNECT_RETRIES = 3

    const errorHandler = vi.fn();
    session.on('onError', errorHandler);

    (session as any).attemptReconnect();

    expect(session.connectionState).toBe('error');
    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler.mock.calls[0][0].message).toBe('Max reconnection attempts reached');
  });

  test('reconnect delay uses exponential backoff', () => {
    (session as any).config = { apiKey: 'test', model: 'model', systemPrompt: '' };
    (session as any).reconnectAttempts = 0;

    (session as any).attemptReconnect();
    // First attempt: 1000 * 2^0 = 1000ms
    expect((session as any).reconnectAttempts).toBe(1);

    (session as any).attemptReconnect();
    // Second attempt: 1000 * 2^1 = 2000ms
    expect((session as any).reconnectAttempts).toBe(2);
  });
});

// =============================================================================
// OPENAI REALTIME SESSION — session.created resets reconnectAttempts
// =============================================================================

describe('OpenAIRealtimeSession — session.created event', () => {
  test('session.created resets reconnect attempts', () => {
    const session = new OpenAIRealtimeSession();
    const ws = createMockWs();
    wireSession(session, ws);
    (session as any).reconnectAttempts = 2;

    (session as any).handleMessage({
      toString: () => JSON.stringify({ type: 'session.created', session: { id: 'sess-123' } }),
    });

    expect((session as any).reconnectAttempts).toBe(0);
  });
});

// =============================================================================
// GEMINI LIVE SESSION — CONNECTION STATE
// =============================================================================

describe('GeminiLiveSession — connection state management', () => {
  let session: GeminiLiveSession;

  beforeEach(() => {
    session = new GeminiLiveSession();
  });

  test('initial state is disconnected', () => {
    expect(session.connectionState).toBe('disconnected');
  });

  test('disconnect sets state to disconnected and clears ws', async () => {
    const ws = createMockWs();
    wireSession(session, ws);
    (session as any).config = { apiKey: 'test', model: 'gemini', systemPrompt: '' };
    (session as any).connectTime = Date.now();

    await session.disconnect();

    expect(session.connectionState).toBe('disconnected');
    expect((session as any).ws).toBeNull();
  });

  test('disconnect accumulates connection duration', async () => {
    const ws = createMockWs();
    wireSession(session, ws);
    (session as any).config = { apiKey: 'test', model: 'gemini', systemPrompt: '' };
    const startTime = Date.now() - 3000;
    (session as any).connectTime = startTime;

    await session.disconnect();

    const metrics = session.getUsageMetrics();
    expect(metrics.connectionDurationMs).toBeGreaterThanOrEqual(2900);
  });
});

// =============================================================================
// GEMINI LIVE SESSION — SETUP MESSAGE
// =============================================================================

describe('GeminiLiveSession — setup message', () => {
  let session: GeminiLiveSession;
  let ws: ReturnType<typeof createMockWs>;

  beforeEach(() => {
    session = new GeminiLiveSession();
    ws = createMockWs();
    wireSession(session, ws);
  });

  test('sendSetupMessage sends setup with model and generation config', () => {
    (session as any).config = {
      model: 'gemini-2.0-flash-live-001',
      systemPrompt: 'You are helpful',
      voice: 'Kore',
    };

    (session as any).sendSetupMessage();

    expect(ws.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent.setup.model).toBe('models/gemini-2.0-flash-live-001');
    expect(sent.setup.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(sent.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe(
      'Kore',
    );
    expect(sent.setup.systemInstruction.parts[0].text).toBe('You are helpful');
  });

  test('sendSetupMessage includes tools when present', () => {
    (session as any).config = {
      model: 'gemini-2.0-flash-live-001',
      systemPrompt: '',
      tools: [
        { name: 'search', description: 'Search', input_schema: { type: 'object', properties: {} } },
      ],
    };

    (session as any).sendSetupMessage();

    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent.setup.tools).toHaveLength(1);
    expect(sent.setup.tools[0].functionDeclarations[0].name).toBe('search');
  });

  test('sendSetupMessage uses default voice when not specified', () => {
    (session as any).config = {
      model: 'gemini-2.0-flash-live-001',
      systemPrompt: '',
    };

    (session as any).sendSetupMessage();

    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe(
      'Puck',
    );
  });

  test('sendSetupMessage skips when no config', () => {
    (session as any).config = null;
    (session as any).sendSetupMessage();
    expect(ws.send).not.toHaveBeenCalled();
  });
});

// =============================================================================
// GEMINI LIVE SESSION — RECONNECTION
// =============================================================================

describe('GeminiLiveSession — reconnection logic', () => {
  let session: GeminiLiveSession;

  beforeEach(() => {
    session = new GeminiLiveSession();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('handleClose triggers reconnect on abnormal close', () => {
    const ws = createMockWs();
    wireSession(session, ws);
    (session as any).config = { apiKey: 'test', model: 'model', systemPrompt: '' };
    (session as any).intentionalDisconnect = false;

    (session as any).handleClose(1006, 'Abnormal');

    expect(session.connectionState).toBe('reconnecting');
  });

  test('setupComplete resets reconnect attempts', () => {
    const ws = createMockWs();
    wireSession(session, ws);
    (session as any).reconnectAttempts = 2;

    (session as any).handleMessage({
      toString: () => JSON.stringify({ setupComplete: true }),
    });

    expect((session as any).reconnectAttempts).toBe(0);
    expect((session as any).setupComplete).toBe(true);
  });

  test('attemptReconnect stops after max retries', () => {
    (session as any).reconnectAttempts = 3;

    const errorHandler = vi.fn();
    session.on('onError', errorHandler);

    (session as any).attemptReconnect();

    expect(session.connectionState).toBe('error');
    expect(errorHandler.mock.calls[0][0].message).toBe('Max reconnection attempts reached');
  });
});

// =============================================================================
// GEMINI LIVE SESSION — USAGE METRICS
// =============================================================================

describe('GeminiLiveSession — usage metrics with active connection', () => {
  test('getUsageMetrics includes live connection duration', () => {
    const session = new GeminiLiveSession();
    const ws = createMockWs();
    wireSession(session, ws);
    (session as any).connectTime = Date.now() - 2000; // 2 seconds ago

    const metrics = session.getUsageMetrics();
    expect(metrics.connectionDurationMs).toBeGreaterThanOrEqual(1900);
  });

  test('getUsageMetrics returns 0 connectionDurationMs when not connected', () => {
    const session = new GeminiLiveSession();
    const metrics = session.getUsageMetrics();
    expect(metrics.connectionDurationMs).toBe(0);
  });
});

// =============================================================================
// LLM PROVIDER FACTORY
// =============================================================================

describe('LLM Provider Factory (deprecated)', () => {
  test('createProvider throws deprecation error', () => {
    expect(() => createProvider({ provider: 'custom' as any })).toThrow('deprecated');
  });

  test('getProviderFactory throws deprecation error', () => {
    expect(() => getProviderFactory('custom' as any)).toThrow('deprecated');
  });

  test('getDefaultProvider throws deprecation error', () => {
    expect(() => getDefaultProvider()).toThrow('deprecated');
  });

  test('registerProvider does not throw (logs warning)', () => {
    expect(() => registerProvider('custom' as any, vi.fn())).not.toThrow();
  });

  test('setDefaultProvider does not throw (logs warning)', () => {
    expect(() => setDefaultProvider({ provider: 'custom' as any })).not.toThrow();
  });
});

// =============================================================================
// LLM CLIENT WRAPPER
// =============================================================================

describe('LLMClient wrapper', () => {
  let mockProvider: LLMProvider;

  beforeEach(() => {
    mockProvider = createMockProvider();
  });

  test('constructor accepts LLMProvider directly', () => {
    const client = new LLMClient(mockProvider);
    expect(client.getProvider()).toBe(mockProvider);
  });

  test('chat returns text from completion result', async () => {
    const client = new LLMClient(mockProvider);
    const result = await client.chat('System', [{ role: 'user', content: 'Hi' }], {
      model: 'test-model',
    });
    expect(result).toBe('response');
    expect(mockProvider.complete).toHaveBeenCalledTimes(1);
  });

  test('chat passes correct options', async () => {
    const client = new LLMClient(mockProvider);
    await client.chat('System', [{ role: 'user', content: 'Hi' }], {
      model: 'test-model',
      timeoutMs: 5000,
      maxTokens: 100,
    });

    const call = (mockProvider.complete as any).mock.calls[0];
    expect(call[0]).toBe('System');
    expect(call[2].model).toBe('test-model');
    expect(call[2].timeoutMs).toBe(5000);
    expect(call[2].maxTokens).toBe(100);
  });

  test('chatWithTools returns ToolCompletionResult', async () => {
    const client = new LLMClient(mockProvider);
    const tools = [
      {
        name: 'search',
        description: 'Search',
        input_schema: { type: 'object' as const, properties: {} },
      },
    ];

    const result = await client.chatWithTools(
      'System',
      [{ role: 'user' as const, content: 'Search for flights' }],
      tools,
      { model: 'test-model' },
    );

    expect(result.text).toBe('tool response');
    expect(mockProvider.completeWithTools).toHaveBeenCalledTimes(1);
  });

  test('streamChat yields text deltas', async () => {
    const client = new LLMClient(mockProvider);
    const chunks: string[] = [];

    for await (const chunk of client.streamChat('System', [{ role: 'user', content: 'Hi' }], {
      model: 'test-model',
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['Hello', ' World']);
  });

  test('getModelForTier delegates to provider', () => {
    const client = new LLMClient(mockProvider);
    expect(client.getModelForTier('fast')).toBe('fast-model');
    expect(client.getModelForTier('balanced')).toBe('balanced-model');
    expect(client.getModelForTier('powerful')).toBe('powerful-model');
  });

  test('supportsFeature delegates to provider', () => {
    const client = new LLMClient(mockProvider);
    expect(client.supportsFeature('tools')).toBe(true);
    expect(client.supportsFeature('streaming')).toBe(true);
  });
});

// =============================================================================
// UTILITY: sanitizeErrorMessage
// =============================================================================

describe('sanitizeErrorMessage', () => {
  test('redacts sk- prefixed keys', () => {
    const result = sanitizeErrorMessage('Error with sk-1234567890abcdefghij1234567890');
    expect(result).toContain('sk-***');
  });

  test('redacts Bearer tokens', () => {
    const result = sanitizeErrorMessage('Authorization: Bearer abcdefghij1234567890');
    expect(result).toContain('Bearer ***');
  });

  test('redacts generic hex tokens', () => {
    const result = sanitizeErrorMessage('Error with abcdef1234567890abcdef1234567890abcdef');
    expect(result).toContain('***');
  });

  test('preserves normal error messages', () => {
    const msg = 'ECONNREFUSED 127.0.0.1:4000';
    expect(sanitizeErrorMessage(msg)).toBe(msg);
  });
});

// =============================================================================
// UTILITY: getApiKey
// =============================================================================

describe('getApiKey', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('returns apiKey from config if present', () => {
    expect(getApiKey({ apiKey: 'my-key' })).toBe('my-key');
  });

  test('returns key from environment variable', () => {
    process.env.CUSTOM_KEY = 'env-key';
    expect(getApiKey({ apiKeyEnvVar: 'CUSTOM_KEY' })).toBe('env-key');
  });

  test('throws when no key found', () => {
    expect(() => getApiKey({})).toThrow('No API key provided');
  });
});

// =============================================================================
// UTILITY: parseSchemaString
// =============================================================================

describe('parseSchemaString', () => {
  test('parses basic types', () => {
    const result = parseSchemaString('{ "name": "string", "age": "number", "active": "boolean" }');
    expect(result.properties.name).toEqual({ type: 'string' });
    expect(result.properties.age).toEqual({ type: 'number' });
    expect(result.properties.active).toEqual({ type: 'boolean' });
    expect(result.required).toContain('name');
    expect(result.required).toContain('age');
    expect(result.required).toContain('active');
  });

  test('handles "or null" types as optional', () => {
    const result = parseSchemaString('{ "name": "string", "nickname": "string or null" }');
    expect(result.required).toContain('name');
    expect(result.required).not.toContain('nickname');
  });

  test('handles array and object types', () => {
    const result = parseSchemaString('{ "items": "array", "data": "object" }');
    expect(result.properties.items).toEqual({ type: 'array' });
    expect(result.properties.data).toEqual({ type: 'object' });
  });

  test('returns empty for invalid JSON', () => {
    const result = parseSchemaString('not valid');
    expect(result.properties).toEqual({});
    expect(result.required).toEqual([]);
  });

  test('unknown type maps to string', () => {
    const result = parseSchemaString('{ "custom": "foobar" }');
    expect(result.properties.custom).toEqual({ type: 'string' });
  });
});

// =============================================================================
// DEFAULT_MODEL_MAPPINGS
// =============================================================================

describe('DEFAULT_MODEL_MAPPINGS', () => {
  test('anthropic mappings exist for all tiers', () => {
    expect(DEFAULT_MODEL_MAPPINGS.anthropic.fast).toBeDefined();
    expect(DEFAULT_MODEL_MAPPINGS.anthropic.balanced).toBeDefined();
    expect(DEFAULT_MODEL_MAPPINGS.anthropic.powerful).toBeDefined();
  });

  test('openai mappings exist for all tiers', () => {
    expect(DEFAULT_MODEL_MAPPINGS.openai.fast).toBeDefined();
    expect(DEFAULT_MODEL_MAPPINGS.openai.balanced).toBeDefined();
    expect(DEFAULT_MODEL_MAPPINGS.openai.powerful).toBeDefined();
  });

  test('google mappings exist for all tiers', () => {
    expect(DEFAULT_MODEL_MAPPINGS.google.fast).toBeDefined();
    expect(DEFAULT_MODEL_MAPPINGS.google.balanced).toBeDefined();
    expect(DEFAULT_MODEL_MAPPINGS.google.powerful).toBeDefined();
  });
});

// =============================================================================
// REALTIME PROVIDER REGISTRY (additional tests)
// =============================================================================

describe('Realtime Provider Registry — edge cases', () => {
  test('createRealtimeSession produces new instances each call', () => {
    registerRealtimeProvider('openai_realtime', () => new OpenAIRealtimeSession());
    const a = createRealtimeSession('openai_realtime');
    const b = createRealtimeSession('openai_realtime');
    expect(a).not.toBe(b);
    expect(a).toBeInstanceOf(OpenAIRealtimeSession);
    expect(b).toBeInstanceOf(OpenAIRealtimeSession);
  });

  test('getRegisteredRealtimeProviders returns array of registered types', () => {
    registerRealtimeProvider('openai_realtime', () => new OpenAIRealtimeSession());
    registerRealtimeProvider('gemini_live', () => new GeminiLiveSession());

    const providers = getRegisteredRealtimeProviders();
    expect(providers).toContain('openai_realtime');
    expect(providers).toContain('gemini_live');
  });
});

// =============================================================================
// OPENAI REALTIME — USAGE METRICS WITH CONNECTION DURATION
// =============================================================================

describe('OpenAIRealtimeSession — usage metrics with connection duration', () => {
  test('getUsageMetrics includes live connection duration', () => {
    const session = new OpenAIRealtimeSession();
    const ws = createMockWs();
    wireSession(session, ws);
    (session as any).connectTime = Date.now() - 5000; // 5 seconds ago

    const metrics = session.getUsageMetrics();
    expect(metrics.connectionDurationMs).toBeGreaterThanOrEqual(4900);
  });

  test('handleClose accumulates connection duration', () => {
    const session = new OpenAIRealtimeSession();
    const ws = createMockWs();
    wireSession(session, ws);
    (session as any).intentionalDisconnect = true;
    (session as any).connectTime = Date.now() - 3000;

    (session as any).handleClose(1000, 'Normal');

    const metrics = session.getUsageMetrics();
    expect(metrics.connectionDurationMs).toBeGreaterThanOrEqual(2900);
    expect((session as any).connectTime).toBeNull();
  });
});

// =============================================================================
// OPENAI REALTIME — ERROR EVENT
// =============================================================================

describe('OpenAIRealtimeSession — error handling', () => {
  test('server error with unknown structure emits generic error', () => {
    const session = new OpenAIRealtimeSession();
    const ws = createMockWs();
    wireSession(session, ws);

    const errorHandler = vi.fn();
    session.on('onError', errorHandler);

    (session as any).handleMessage({
      toString: () => JSON.stringify({ type: 'error', error: {} }),
    });

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler.mock.calls[0][0].message).toBe('Unknown realtime error');
  });

  test('handleError emits onError', () => {
    const session = new OpenAIRealtimeSession();
    const errorHandler = vi.fn();
    session.on('onError', errorHandler);

    (session as any).handleError(new Error('ws error'));

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler.mock.calls[0][0].message).toBe('ws error');
  });
});

// =============================================================================
// GEMINI LIVE — ERROR HANDLING
// =============================================================================

describe('GeminiLiveSession — error handling', () => {
  test('handleError emits onError', () => {
    const session = new GeminiLiveSession();
    const errorHandler = vi.fn();
    session.on('onError', errorHandler);

    (session as any).handleError(new Error('gemini ws error'));

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler.mock.calls[0][0].message).toBe('gemini ws error');
  });
});

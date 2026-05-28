/**
 * LiveKit Agent Worker v1.0 — Integration Tests
 *
 * Tests that the agent-worker correctly:
 * 1. Creates a RuntimeBridgeAgent (voice.Agent subclass) with llmNode override
 * 2. Creates an AgentSession with STT, TTS, VAD plugins (no LLM)
 * 3. Connects to a room via @livekit/rtc-node
 * 4. Routes LLM calls through RuntimeLLMAdapter via llmNode()
 * 5. Returns ReadableStream<string> for TTS synthesis
 * 6. Uses v1.0 ChatContext.items with string roles (not numeric enums)
 * 7. Publishes transcript + timing via data channel
 * 8. Validates room participant metadata (S6)
 * 9. Cleans up on shutdown (adapter registry, room disconnect, session close)
 *
 * All LiveKit packages are mocked — tests verify wiring, not network calls.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CallerContext } from '@agent-platform/shared-auth';

// =============================================================================
// MOCK INSTANCES — capture constructor args for assertions
// =============================================================================

const mockSTTInstance = { type: 'deepgram-stt', stream: vi.fn() };
const mockTTSInstance = { type: 'elevenlabs-tts', synthesize: vi.fn() };
const mockVADInstance = { type: 'silero-vad' };

const capturedSTTArgs: any[] = [];
const capturedTTSArgs: any[] = [];
let vadLoadCalled = false;

// Track AgentSession creation
const capturedAgentSessionArgs: any[] = [];
const mockSessionInstance = {
  start: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
};

// Track Room creation
const mockRoomInstance = {
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  localParticipant: {
    publishData: vi.fn().mockResolvedValue(undefined),
  },
};

// Track published data channel messages
const publishedData: any[] = [];
mockRoomInstance.localParticipant.publishData.mockImplementation(async (data: Uint8Array) => {
  publishedData.push(JSON.parse(new TextDecoder().decode(data)));
});
const mockPersistMessage = vi.fn(async () => {});
const mockPersistTurnMetrics = vi.fn(async () => {});

// Track AccessToken creation
const mockTokenInstance = {
  addGrant: vi.fn(),
  toJwt: vi.fn().mockResolvedValue('mock-agent-jwt'),
};

// Track voice.Agent subclass — capture the llmNode override
let capturedAgent: any = null;

// =============================================================================
// MOCK — @livekit/agents (v1.0 API)
// =============================================================================

vi.mock('@livekit/agents', () => {
  // voice.Agent base class mock
  class MockVoiceAgent {
    instructions: string;
    constructor(opts: any) {
      this.instructions = opts?.instructions || '';
      capturedAgent = this; // Capture the LAST created agent (the subclass instance)
    }
    // Base llmNode — should be overridden by RuntimeBridgeAgent
    async llmNode(_chatCtx: any, _toolCtx: any, _modelSettings: any): Promise<any> {
      return null;
    }
  }

  // voice.AgentSession mock
  class MockAgentSession {
    constructor(opts: any) {
      capturedAgentSessionArgs.push(opts);
    }
    start = mockSessionInstance.start;
    close = mockSessionInstance.close;
    on = mockSessionInstance.on;
  }

  // llm.LLM base class mock — used by PipelineLLM extends llmModule.LLM
  class MockLLM {}

  return {
    voice: {
      Agent: MockVoiceAgent,
      AgentSession: MockAgentSession,
    },
    llm: {
      LLM: MockLLM,
    },
    initializeLogger: vi.fn(),
  };
});

// =============================================================================
// MOCK — @livekit/rtc-node
// =============================================================================

vi.mock('@livekit/rtc-node', () => ({
  Room: vi.fn(function Room() {
    return mockRoomInstance;
  }),
}));

// =============================================================================
// MOCK — livekit-server-sdk
// =============================================================================

vi.mock('livekit-server-sdk', () => ({
  AccessToken: vi.fn(function AccessToken() {
    return mockTokenInstance;
  }),
}));

// =============================================================================
// MOCK — @livekit/agents-plugin-deepgram
// =============================================================================

vi.mock('@livekit/agents-plugin-deepgram', () => ({
  STT: vi.fn(function STT(opts: any) {
    capturedSTTArgs.push(opts);
    return mockSTTInstance;
  }),
}));

// =============================================================================
// MOCK — @livekit/agents-plugin-elevenlabs
// =============================================================================

vi.mock('@livekit/agents-plugin-elevenlabs', () => ({
  TTS: vi.fn(function TTS(opts: any) {
    capturedTTSArgs.push(opts);
    return mockTTSInstance;
  }),
}));

// =============================================================================
// MOCK — @livekit/agents-plugin-silero
// =============================================================================

vi.mock('@livekit/agents-plugin-silero', () => ({
  VAD: {
    load: vi.fn(async () => {
      vadLoadCalled = true;
      return mockVADInstance;
    }),
  },
}));

// =============================================================================
// MOCK — RuntimeLLMAdapter
// =============================================================================

const mockAdapterInstance = {
  initialize: vi.fn().mockResolvedValue(undefined),
  chat: vi.fn().mockResolvedValue({ text: 'Agent response', sessionId: 'runtime-session-1' }),
  dispose: vi.fn().mockResolvedValue(undefined),
  resolveSystemMessage: vi.fn(
    async (_messageKey: string, fallbackMessage: string) => fallbackMessage,
  ),
  getConversationBehaviorVoiceRuntimeConfig: vi.fn().mockReturnValue({}),
  getSessionId: vi.fn().mockReturnValue('runtime-session-1'),
  getDbSessionId: vi.fn().mockReturnValue('db-session-1'),
  getTenantId: vi.fn().mockReturnValue('tenant-1'),
  getProjectId: vi.fn().mockReturnValue('proj-1'),
  getSessionDurationMs: vi.fn().mockReturnValue(5000),
};

vi.mock('../../services/voice/livekit/runtime-llm-adapter.js', () => ({
  RuntimeLLMAdapter: vi.fn(function RuntimeLLMAdapter() {
    return mockAdapterInstance;
  }),
}));

// =============================================================================
// MOCK — worker-entry (adapter registry)
// =============================================================================

const registeredAdapters = new Map<string, any>();

vi.mock('../../services/voice/livekit/worker-entry.js', () => ({
  registerAdapter: vi.fn((name: string, adapter: any) => registeredAdapters.set(name, adapter)),
  unregisterAdapter: vi.fn((name: string) => registeredAdapters.delete(name)),
}));

// =============================================================================
// MOCK — config
// =============================================================================

vi.mock('../../config/index.js', () => ({
  getConfig: vi.fn(() => ({
    voice: {
      deepgram: {
        apiKey: 'dg-test-key-123',
        model: 'nova-3',
      },
      elevenLabs: {
        apiKey: 'el-test-key-456',
        voiceId: 'voice-rachel',
        model: 'eleven_turbo_v2',
      },
      livekit: {
        url: 'ws://localhost:7880',
        apiKey: 'lk-api-key',
        apiSecret: 'lk-api-secret',
      },
    },
  })),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// =============================================================================
// MOCK — message persistence queue (no-op)
// =============================================================================

vi.mock('../../services/message-persistence-queue.js', () => ({
  persistMessage: (...args: unknown[]) => mockPersistMessage(...args),
  persistMessageRecord: vi.fn(async () => undefined),
  persistTurnMetrics: (...args: unknown[]) => mockPersistTurnMetrics(...args),
}));

// =============================================================================
// MOCK — trace hooks (no-op)
// =============================================================================

vi.mock('../../services/voice/livekit/livekit-trace-hooks.js', () => ({
  traceLiveKitTurnStart: vi.fn(() => ({ sessionId: 'test', phases: {}, startTime: Date.now() })),
  traceLiveKitSTT: vi.fn(),
  traceLiveKitLLMStart: vi.fn(),
  traceLiveKitLLMEnd: vi.fn(),
  traceLiveKitTTSStart: vi.fn(),
  traceLiveKitTurnComplete: vi.fn(() => ({
    breakdown: {
      totalLatency: 500,
      sttLatency: 100,
      llmLatency: 300,
      ttsLatency: 100,
      ttsFirstChunkLatency: 50,
    },
    report: 'test timing report',
  })),
  traceLiveKitTurnFailed: vi.fn(),
}));

// =============================================================================
// IMPORT UNDER TEST
// =============================================================================

import {
  startAgentInRoom,
  findLastUserMessage,
  createTextStream,
  parseAndValidateMetadata,
} from '../../services/voice/livekit/agent-worker.js';
import { RuntimeLLMAdapter } from '../../services/voice/livekit/runtime-llm-adapter.js';
import type { VoiceServiceFactory } from '../../services/voice/voice-service-factory.js';

// =============================================================================
// MOCK — VoiceServiceFactory (tenant-scoped credentials)
// =============================================================================

const mockVoiceFactory = {
  resolveVoiceCredentials: vi.fn(async () => ({
    stt: { apiKey: 'dg-test-key-123', model: 'nova-3' },
    tts: { apiKey: 'el-test-key-456', voiceId: 'voice-rachel', model: 'eleven_turbo_v2' },
  })),
} as unknown as VoiceServiceFactory;

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Build a mock v1.0 ChatContext with string roles.
 */
function createMockChatContext(messages: Array<{ role: string; content: string }>) {
  return {
    items: messages.map((m) => ({
      role: m.role,
      content: m.content,
      textContent: m.content,
      id: undefined,
    })),
  };
}

async function readStream(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += value;
  }
  return result;
}

// =============================================================================
// TESTS
// =============================================================================

describe('LiveKit Agent Worker v1.0 — Plugin Wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedSTTArgs.length = 0;
    capturedTTSArgs.length = 0;
    capturedAgentSessionArgs.length = 0;
    vadLoadCalled = false;
    registeredAdapters.clear();
    publishedData.length = 0;
    capturedAgent = null;
    mockPersistMessage.mockClear();
    mockPersistTurnMetrics.mockClear();

    // Re-establish publishData mock
    mockRoomInstance.localParticipant.publishData.mockImplementation(async (data: Uint8Array) => {
      publishedData.push(JSON.parse(new TextDecoder().decode(data)));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // 1. startAgentInRoom — full pipeline setup
  // ===========================================================================

  describe('startAgentInRoom pipeline setup', () => {
    async function runStartAgentInRoom(
      metadata?: Partial<{
        sessionId: string;
        projectId: string;
        agentName: string;
        tenantId: string;
        callerContext: CallerContext;
      }>,
    ) {
      return startAgentInRoom(
        {
          livekitUrl: 'ws://localhost:7880',
          apiKey: 'test-key',
          apiSecret: 'test-secret',
        },
        'voice_tenant1_proj1_session1',
        {
          sessionId: metadata?.sessionId || 'session-1',
          projectId: metadata?.projectId || 'proj-1',
          agentName: metadata?.agentName,
          tenantId: metadata?.tenantId || 'tenant-1',
          callerContext: metadata?.callerContext,
        },
        mockVoiceFactory,
      );
    }

    test('connects to room via @livekit/rtc-node', async () => {
      await runStartAgentInRoom();

      expect(mockRoomInstance.connect).toHaveBeenCalledWith(
        'ws://localhost:7880',
        'mock-agent-jwt',
      );
    });

    test('generates agent token with correct grants', async () => {
      await runStartAgentInRoom();

      expect(mockTokenInstance.addGrant).toHaveBeenCalledWith(
        expect.objectContaining({
          room: 'voice_tenant1_proj1_session1',
          roomJoin: true,
          canPublish: true,
          canSubscribe: true,
          canPublishData: true,
        }),
      );
    });

    test('passes caller context through to RuntimeLLMAdapter', async () => {
      const callerContext: CallerContext = {
        tenantId: 'tenant-1',
        channel: 'voice_livekit',
        channelId: 'channel-voice-1',
        customerId: 'customer-voice-1',
        sessionPrincipalId: 'sdk-session-voice-1',
        channelArtifact: 'artifact-hash-voice-1',
        identityTier: 2,
        verificationMethod: 'hmac',
        authScope: 'user',
      };

      await runStartAgentInRoom({ callerContext });

      expect(RuntimeLLMAdapter).toHaveBeenCalledWith(
        expect.objectContaining({
          callerContext,
        }),
      );
    });

    test('Deepgram STT receives apiKey from config', async () => {
      await runStartAgentInRoom();

      expect(capturedSTTArgs.length).toBe(1);
      expect(capturedSTTArgs[0]).toEqual({
        apiKey: 'dg-test-key-123',
        model: 'nova-3',
        language: 'en',
      });
    });

    test('ElevenLabs TTS receives apiKey and voiceId from config', async () => {
      await runStartAgentInRoom();

      expect(capturedTTSArgs.length).toBe(1);
      expect(capturedTTSArgs[0]).toEqual({
        apiKey: 'el-test-key-456',
        voiceId: 'voice-rachel',
        modelId: 'eleven_turbo_v2',
      });
    });

    test('Silero VAD.load() is awaited (async model loading)', async () => {
      await runStartAgentInRoom();

      expect(vadLoadCalled).toBe(true);
    });

    test('AgentSession created with STT, TTS, VAD but NO LLM', async () => {
      await runStartAgentInRoom();

      expect(capturedAgentSessionArgs.length).toBe(1);
      const sessionOpts = capturedAgentSessionArgs[0];

      expect(sessionOpts.stt).toBe(mockSTTInstance);
      expect(sessionOpts.tts).toBe(mockTTSInstance);
      expect(sessionOpts.vad).toBe(mockVADInstance);
      // PipelineLLM satisfies the AgentSession pipeline gate (instanceof LLM check)
      // while our Agent.llmNode() override handles actual inference
      expect(sessionOpts.llm).toBeDefined();
    });

    test('AgentSession.start() called with room and agent', async () => {
      await runStartAgentInRoom();

      expect(mockSessionInstance.start).toHaveBeenCalledWith({
        room: mockRoomInstance,
        agent: expect.any(Object),
      });
    });

    test('Adapter is registered for concurrency tracking', async () => {
      await runStartAgentInRoom();

      expect(registeredAdapters.size).toBe(1);
      expect(registeredAdapters.has('voice_tenant1_proj1_session1')).toBe(true);
    });

    test('RuntimeBridgeAgent created with empty instructions', async () => {
      await runStartAgentInRoom();

      // capturedAgent is the last voice.Agent instance created
      expect(capturedAgent).toBeDefined();
      expect(capturedAgent.instructions).toBe('');
    });

    test('returns ActiveAgentConnection with cleanup function', async () => {
      const connection = await runStartAgentInRoom();

      expect(connection.room).toBe(mockRoomInstance);
      expect(connection.adapter).toBe(mockAdapterInstance);
      expect(typeof connection.cleanup).toBe('function');
    });
  });

  // ===========================================================================
  // 2. llmNode override (bridges ChatContext → RuntimeExecutor → ReadableStream)
  // ===========================================================================

  describe('llmNode override wiring', () => {
    async function getLlmNode() {
      await startAgentInRoom(
        {
          livekitUrl: 'ws://localhost:7880',
          apiKey: 'test-key',
          apiSecret: 'test-secret',
        },
        'voice_tenant1_proj1_session1',
        {
          sessionId: 'session-1',
          projectId: 'proj-1',
          tenantId: 'tenant-1',
        },
        mockVoiceFactory,
      );

      // The capturedAgent has the llmNode override
      expect(capturedAgent).toBeDefined();
      return capturedAgent;
    }

    test('forwards user message to RuntimeLLMAdapter and returns ReadableStream', async () => {
      const agent = await getLlmNode();

      const chatCtx = createMockChatContext([
        { role: 'user', content: 'I want to book a flight to Paris' },
      ]);

      const result = await agent.llmNode(chatCtx, {}, {});

      // Should return a ReadableStream
      expect(result).toBeInstanceOf(ReadableStream);

      // Read the stream content
      const text = await readStream(result);
      expect(text).toBe('Agent response');

      // Verify adapter.chat was called with the user message (+ optional chunk callback)
      expect(mockAdapterInstance.chat).toHaveBeenCalledWith(
        'I want to book a flight to Paris',
        expect.any(Function),
      );
    });

    test('publishes transcript and timing to data channel', async () => {
      const agent = await getLlmNode();

      const chatCtx = createMockChatContext([{ role: 'user', content: 'Hello' }]);

      const stream = await agent.llmNode(chatCtx, {}, {});
      // Drain the stream and wait for background publishData calls to complete
      await readStream(stream);
      await new Promise((r) => setTimeout(r, 50));

      // Should have published transcript + timing
      expect(publishedData.length).toBe(2);
      expect(publishedData[0].type).toBe('transcript');
      expect(publishedData[0].userText).toBe('Hello');
      expect(publishedData[0].agentText).toBe('Agent response');
      expect(publishedData[1].type).toBe('timing');
      expect(publishedData[1].timing.total).toBe(500);
      expect(publishedData[1].timing.stt).toBe(100);
      expect(publishedData[1].timing.llm).toBe(300);
      expect(publishedData[1].timing.tts).toBe(100);
    });

    test('persists assistant turns with canonical response metadata from the adapter', async () => {
      const responseMetadata = {
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1 as const,
          kind: 'llm' as const,
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
      };
      const voiceConfig = { plain_text: 'Agent response for voice playback.' };
      mockAdapterInstance.chat.mockResolvedValueOnce({
        text: 'Agent response',
        sessionId: 'runtime-session-1',
        voiceConfig,
        responseMetadata,
        tokensIn: 12,
        tokensOut: 18,
      });

      const agent = await getLlmNode();
      const chatCtx = createMockChatContext([{ role: 'user', content: 'Hello' }]);

      const stream = await agent.llmNode(chatCtx, {}, {});
      await readStream(stream);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockPersistMessage).toHaveBeenCalledWith(
        'db-session-1',
        'assistant',
        'Agent response for voice playback.',
        'voice',
        'tenant-1',
        undefined,
        undefined,
        'proj-1',
        undefined,
        { voiceConfig },
        responseMetadata,
      );
    });

    test('handles missing user message with fallback ReadableStream', async () => {
      mockAdapterInstance.resolveSystemMessage.mockResolvedValueOnce(
        'Je n’ai pas compris. Pouvez-vous reformuler ?',
      );

      const agent = await getLlmNode();

      // No user messages — only system
      const chatCtx = createMockChatContext([
        { role: 'system', content: 'You are a helpful assistant' },
      ]);

      const result = await agent.llmNode(chatCtx, {}, {});

      // Should return ReadableStream with fallback, not call adapter
      expect(result).toBeInstanceOf(ReadableStream);
      expect(mockAdapterInstance.chat).not.toHaveBeenCalled();
      expect(mockAdapterInstance.resolveSystemMessage).toHaveBeenCalledWith(
        'voice_nomatch',
        expect.any(String),
      );

      const text = await readStream(result);
      expect(text).toBe('Je n’ai pas compris. Pouvez-vous reformuler ?');
    });

    test('handles adapter errors with error ReadableStream', async () => {
      mockAdapterInstance.chat.mockRejectedValueOnce(new Error('LLM timeout'));
      mockAdapterInstance.resolveSystemMessage.mockResolvedValueOnce(
        'Une erreur vocale est survenue. Veuillez reessayer.',
      );

      const agent = await getLlmNode();

      const chatCtx = createMockChatContext([{ role: 'user', content: 'Test message' }]);

      const result = await agent.llmNode(chatCtx, {}, {});

      expect(result).toBeInstanceOf(ReadableStream);

      const text = await readStream(result);
      expect(mockAdapterInstance.resolveSystemMessage).toHaveBeenCalledWith(
        'voice_error',
        expect.any(String),
      );
      expect(text).toBe('Une erreur vocale est survenue. Veuillez reessayer.');
    });

    test('uses string role "user" (not numeric enum) to find messages', async () => {
      const agent = await getLlmNode();

      // Mix of system and user messages with string roles
      const chatCtx = createMockChatContext([
        { role: 'system', content: 'You are an agent' },
        { role: 'user', content: 'First message' },
        { role: 'assistant', content: 'First response' },
        { role: 'user', content: 'Latest message' },
      ]);

      await agent.llmNode(chatCtx, {}, {});

      // Should use the LAST user message (+ optional chunk callback)
      expect(mockAdapterInstance.chat).toHaveBeenCalledWith('Latest message', expect.any(Function));
    });
  });

  // ===========================================================================
  // 3. findLastUserMessage helper
  // ===========================================================================

  describe('findLastUserMessage', () => {
    test('extracts string content from last user message', () => {
      const chatCtx = createMockChatContext([
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
        { role: 'user', content: 'Latest' },
      ]);

      expect(findLastUserMessage(chatCtx)).toBe('Latest');
    });

    test('returns null when no user messages exist', () => {
      const chatCtx = createMockChatContext([{ role: 'system', content: 'System prompt' }]);

      expect(findLastUserMessage(chatCtx)).toBeNull();
    });

    test('returns null for empty chat context', () => {
      expect(findLastUserMessage({ items: [] })).toBeNull();
      expect(findLastUserMessage(null)).toBeNull();
      expect(findLastUserMessage({})).toBeNull();
    });

    test('uses textContent fallback when content is not a string', () => {
      const chatCtx = {
        items: [
          {
            role: 'user',
            content: [{ type: 'audio', data: 'binary' }],
            textContent: 'Transcribed audio text',
          },
        ],
      };

      expect(findLastUserMessage(chatCtx)).toBe('Transcribed audio text');
    });

    test('extracts text from ChatContent array', () => {
      const chatCtx = {
        items: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Part one' },
              { type: 'text', text: 'Part two' },
            ],
          },
        ],
      };

      expect(findLastUserMessage(chatCtx)).toBe('Part one Part two');
    });
  });

  // ===========================================================================
  // 4. createTextStream helper
  // ===========================================================================

  describe('createTextStream', () => {
    test('creates a ReadableStream from a single text value', async () => {
      const stream = createTextStream('Hello world');
      const text = await readStream(stream);
      expect(text).toBe('Hello world');
    });

    test('stream closes after single chunk', async () => {
      const stream = createTextStream('Test');
      const reader = stream.getReader();
      const { value, done } = await reader.read();
      expect(value).toBe('Test');
      expect(done).toBe(false);

      const next = await reader.read();
      expect(next.done).toBe(true);
    });
  });

  // ===========================================================================
  // 5. Metadata Validation (S6)
  // ===========================================================================

  describe('parseAndValidateMetadata (S6)', () => {
    test('valid metadata is parsed correctly', () => {
      const result = parseAndValidateMetadata(
        JSON.stringify({
          sessionId: 'session-abc-123',
          projectId: 'proj-traveldesk',
          agentName: 'Sales_Agent',
          tenantId: 'tenant-dev-001',
        }),
      );

      expect(result).toEqual({
        sessionId: 'session-abc-123',
        projectId: 'proj-traveldesk',
        agentName: 'Sales_Agent',
        tenantId: 'tenant-dev-001',
        deploymentId: undefined,
      });
    });

    test('missing sessionId returns null', () => {
      expect(parseAndValidateMetadata(JSON.stringify({ projectId: 'proj-1' }))).toBeNull();
    });

    test('missing projectId returns null', () => {
      expect(parseAndValidateMetadata(JSON.stringify({ sessionId: 'session-1' }))).toBeNull();
    });

    test('invalid sessionId pattern returns null', () => {
      expect(
        parseAndValidateMetadata(
          JSON.stringify({
            sessionId: '../../../etc/passwd',
            projectId: 'proj-1',
          }),
        ),
      ).toBeNull();
    });

    test('optional agentName and tenantId are undefined when absent', () => {
      const result = parseAndValidateMetadata(
        JSON.stringify({
          sessionId: 'session-1',
          projectId: 'proj-1',
        }),
      );

      expect(result).toEqual({
        sessionId: 'session-1',
        projectId: 'proj-1',
        agentName: undefined,
        tenantId: undefined,
        deploymentId: undefined,
      });
    });

    test('invalid JSON returns null', () => {
      expect(parseAndValidateMetadata('not-json')).toBeNull();
    });

    test('non-object JSON returns null', () => {
      expect(parseAndValidateMetadata('"just a string"')).toBeNull();
    });
  });

  // ===========================================================================
  // 6. Shutdown & Cleanup
  // ===========================================================================

  describe('Shutdown cleanup', () => {
    test('cleanup disposes adapter, closes session, and disconnects room', async () => {
      const connection = await startAgentInRoom(
        {
          livekitUrl: 'ws://localhost:7880',
          apiKey: 'test-key',
          apiSecret: 'test-secret',
        },
        'voice_tenant1_proj1_session1',
        {
          sessionId: 'session-1',
          projectId: 'proj-1',
          tenantId: 'tenant-1',
        },
        mockVoiceFactory,
      );

      // Adapter should be registered
      expect(registeredAdapters.size).toBe(1);

      // Trigger cleanup
      await connection.cleanup();

      // Session should be closed
      expect(mockSessionInstance.close).toHaveBeenCalled();

      // Room should be disconnected
      expect(mockRoomInstance.disconnect).toHaveBeenCalled();

      // Adapter should have been disposed
      expect(mockAdapterInstance.dispose).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // 7. RuntimeLLMAdapter initialization
  // ===========================================================================

  describe('RuntimeLLMAdapter initialization', () => {
    test('adapter receives correct metadata', async () => {
      await startAgentInRoom(
        {
          livekitUrl: 'ws://localhost:7880',
          apiKey: 'test-key',
          apiSecret: 'test-secret',
        },
        'voice_tenant1_proj1_session1',
        {
          sessionId: 'session-abc',
          projectId: 'proj-traveldesk',
          agentName: 'Sales_Agent',
          tenantId: 'tenant-dev-001',
          deploymentId: 'deploy-1',
        },
        mockVoiceFactory,
      );

      expect((RuntimeLLMAdapter as any).mock.calls.length).toBe(1);
      expect((RuntimeLLMAdapter as any).mock.calls[0][0]).toEqual({
        sessionId: 'session-abc',
        projectId: 'proj-traveldesk',
        agentName: 'Sales_Agent',
        tenantId: 'tenant-dev-001',
        deploymentId: 'deploy-1',
      });
    });

    test('adapter.initialize() is called before pipeline starts', async () => {
      await startAgentInRoom(
        {
          livekitUrl: 'ws://localhost:7880',
          apiKey: 'test-key',
          apiSecret: 'test-secret',
        },
        'voice_tenant1_proj1_session1',
        {
          sessionId: 'session-1',
          projectId: 'proj-1',
          tenantId: 'tenant-1',
        },
        mockVoiceFactory,
      );

      expect(mockAdapterInstance.initialize).toHaveBeenCalled();
    });
  });
});

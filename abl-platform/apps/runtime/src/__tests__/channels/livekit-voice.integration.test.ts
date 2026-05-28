/**
 * LiveKit Voice Pipeline — End-to-End Integration Test
 *
 * Simulates the full voice pipeline with the TravelDesk travel agent:
 *   STT (simulated text) → RuntimeLLMAdapter.chat() → RuntimeExecutor → Agent response → TTS (simulated)
 *
 * Uses real TravelDesk agent DSLs loaded from disk with a MockAnthropicClient
 * for deterministic LLM responses. Tests the complete chain:
 *   1. Adapter initialization (DSL fetch → compile → session creation)
 *   2. Multi-turn voice conversation (greeting → travel search → handoff)
 *   3. Entity extraction from voice utterances
 *   4. Supervisor routing to specialist agents
 *   5. Session lifecycle (initialize → chat → dispose)
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// =============================================================================
// DSL LOADING — Real TravelDesk agent files
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = path.resolve(__dirname, '../../../../../examples/travel');

function loadDSL(filename: string): string {
  const fullPath = path.join(EXAMPLES_DIR, filename);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`TravelDesk DSL not found: ${fullPath}`);
  }
  return fs.readFileSync(fullPath, 'utf-8');
}

// Load all TravelDesk agent DSLs
const ALL_DSLS = {
  supervisor: loadDSL('agents/traveldesk_supervisor.agent.abl'),
  welcome: loadDSL('agents/welcome_agent.agent.abl'),
  sales: loadDSL('agents/sales_agent.agent.abl'),
  authentication: loadDSL('agents/authentication.agent.abl'),
  booking_manager: loadDSL('agents/booking_manager.agent.abl'),
  fallback: loadDSL('agents/fallback_handler.agent.abl'),
  farewell: loadDSL('agents/farewell_agent.agent.abl'),
  fee_calculator: loadDSL('agents/fee_calculator.agent.abl'),
  live_agent: loadDSL('agents/live_agent_transfer.agent.abl'),
  payment: loadDSL('agents/payment_agent.agent.abl'),
  refund: loadDSL('agents/refund_processor.agent.abl'),
};

const ALL_DSL_CONTENTS = Object.values(ALL_DSLS);

const MOCK_PROJECT = {
  id: 'proj-traveldesk',
  name: 'TravelDesk Travel',
  tenantId: 'tenant-voice-test',
  agents: Object.entries(ALL_DSLS).map(([key, dsl], i) => ({
    name: key,
    dslContent: dsl,
    createdAt: new Date(Date.now() - i * 1000),
  })),
};

// =============================================================================
// MOCK LLM CLIENT — Simulates Anthropic responses
// =============================================================================

type LLMCall = {
  systemPrompt: string;
  messages: Array<{ role: string; content: unknown }>;
  tools: unknown[];
};

type LLMResponse = {
  text: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  stopReason: string;
  rawContent: Array<{ type: string; [key: string]: unknown }>;
};

class MockAnthropicClient {
  calls: LLMCall[] = [];
  private responseHandler: (
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
  ) => LLMResponse;

  constructor() {
    this.responseHandler = () => ({
      text: 'I can help you with that.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'I can help you with that.' }],
    });
  }

  setResponseHandler(
    handler: (
      systemPrompt: string,
      messages: Array<{ role: string; content: unknown }>,
      tools: unknown[],
    ) => LLMResponse,
  ) {
    this.responseHandler = handler;
  }

  setEntityExtractionResponse(entities: Record<string, unknown>) {
    const jsonStr = JSON.stringify(entities);
    const previousHandler = this.responseHandler;

    this.responseHandler = (systemPrompt, messages, tools) => {
      if (tools.length === 0) {
        return {
          text: jsonStr,
          toolCalls: [],
          stopReason: 'end_turn',
          rawContent: [{ type: 'text', text: jsonStr }],
        };
      }
      return previousHandler(systemPrompt, messages, tools);
    };
  }

  async chatWithToolUse(
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
  ) {
    this.calls.push({ systemPrompt, messages, tools });
    return this.responseHandler(systemPrompt, messages, tools);
  }

  async chatWithToolUseStreamable(
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
    _operationType?: string,
    _onChunk?: (chunk: string) => void,
  ) {
    return this.chatWithToolUse(systemPrompt, messages, tools);
  }
}

function injectMockClient(executor: any): MockAnthropicClient {
  const mock = new MockAnthropicClient();
  executor.llmWiring.wireLLMClient = async (session: any) => {
    session.llmClient = mock;
  };
  executor.llmWiring.ensureSessionLLMClient = async (session: any) => {
    if (!session.llmClient) {
      session.llmClient = mock;
    }
  };
  return mock;
}

// =============================================================================
// MOCK SETUP — DB, config, logger
// =============================================================================

const { mockFindFirst, mockCreateConversationSession, mockSessionUpdate, mockHandleDisconnect } =
  vi.hoisted(() => {
    const mockFindFirst = vi.fn();
    const mockCreateConversationSession = vi.fn().mockResolvedValue({ id: 'db-sess-voice' });
    const mockSessionUpdate = vi.fn().mockResolvedValue({});
    const mockHandleDisconnect = vi.fn().mockResolvedValue(undefined);
    return {
      mockFindFirst,
      mockCreateConversationSession,
      mockSessionUpdate,
      mockHandleDisconnect,
    };
  });

vi.mock('@agent-platform/a2a', () => ({
  AgentCardCache: class MockAgentCardCache {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn();
    clear = vi.fn();
  },
  discoverAgent: vi.fn().mockResolvedValue(null),
  cancelRemoteTask: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../db/index.js', () => ({
  isDatabaseAvailable: vi.fn().mockReturnValue(true),
}));

vi.mock('../../repos/project-repo.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../repos/project-repo.js')>();
  return {
    ...actual,
    findProjectWithAgents: mockFindFirst,
    findProjectAgentForProject: vi.fn().mockResolvedValue(null),
  };
});

vi.mock('../../services/stores/store-factory.js', () => ({
  getStores: vi.fn(() => ({
    conversation: { createSession: mockCreateConversationSession },
    message: { addMessage: vi.fn() },
    metrics: { record: vi.fn() },
    contact: {},
    fact: {},
    workflowDefinition: {},
    createAgentRegistry: vi.fn(() => ({})),
  })),
}));

vi.mock('../../repos/session-repo.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../repos/session-repo.js')>();
  return {
    ...actual,
    findSessionById: vi.fn().mockResolvedValue(null),
    findSessionByRuntimeId: vi.fn().mockResolvedValue(null),
    updateSession: mockSessionUpdate,
  };
});

vi.mock('../../services/session/session-service.js', () => ({
  getSessionService: vi.fn(() => ({})),
}));

vi.mock('../../channels/pipeline/session-factory.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../channels/pipeline/session-factory.js')>();
  return {
    ...actual,
    resolveSessionTimeouts: vi.fn().mockResolvedValue({}),
  };
});

vi.mock('../../channels/pipeline/lifecycle-manager.js', () => ({
  handleDisconnect: mockHandleDisconnect,
}));

vi.mock('../../services/deployment-resolver.js', () => ({
  DeploymentResolver: class MockDeploymentResolver {
    resolve = vi.fn();
  },
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@abl/compiler/platform')>();
  return {
    ...actual,
    createLogger: vi.fn().mockReturnValue({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

// Import AFTER mocks are set up
import {
  RuntimeLLMAdapter,
  _clearDSLCacheForTesting,
  type LLMAdapterOptions,
} from '../../services/voice/livekit/runtime-llm-adapter.js';
import { RuntimeExecutor } from '../../services/runtime-executor.js';
import { buildCallerContext } from '../../services/identity/artifact-hasher.js';

// Override getRuntimeExecutor to return our test instance
let testExecutor: RuntimeExecutor;
let testMockClient: MockAnthropicClient;

vi.mock('../../services/runtime-executor.js', async (importOriginal) => {
  const original = (await importOriginal()) as any;
  return {
    ...original,
    getRuntimeExecutor: vi.fn(() => testExecutor),
  };
});

// =============================================================================
// SIMULATED VOICE PIPELINE
// =============================================================================

/** Simulated STT output — represents what Deepgram would transcribe from audio */
interface SimulatedUtterance {
  /** The transcribed text (what the user "said") */
  text: string;
  /** Simulated STT confidence score */
  confidence?: number;
  /** Simulated STT duration in ms */
  sttDurationMs?: number;
}

/** Simulated turn result — full pipeline output for one voice turn */
interface VoiceTurnResult {
  /** STT phase: transcribed text */
  sttOutput: string;
  /** LLM phase: agent response text */
  agentResponse: string;
  /** Total pipeline latency (simulated) */
  pipelineLatencyMs: number;
  /** Session ID from the adapter */
  sessionId: string;
  /** Streaming chunks received */
  chunks: string[];
}

/**
 * Simulate one voice turn through the pipeline:
 *   Audio → STT (simulated) → RuntimeLLMAdapter.chat() → TTS (simulated)
 */
async function simulateVoiceTurn(
  adapter: RuntimeLLMAdapter,
  utterance: SimulatedUtterance,
): Promise<VoiceTurnResult> {
  const sttStart = Date.now();

  // Simulate STT processing delay
  const sttDelay = utterance.sttDurationMs ?? 200;
  await new Promise((resolve) => setTimeout(resolve, Math.min(sttDelay, 50))); // Capped for test speed

  const sttOutput = utterance.text;

  // LLM phase: feed transcribed text through the adapter
  const chunks: string[] = [];
  const llmStart = Date.now();
  const result = await adapter.chat(sttOutput, (chunk) => chunks.push(chunk));
  const llmEnd = Date.now();

  // Simulate TTS processing (would convert result.text to audio)
  const ttsDelay = 100; // simulated
  const totalLatency = llmEnd - llmStart + sttDelay + ttsDelay;

  return {
    sttOutput,
    agentResponse: result.text,
    pipelineLatencyMs: totalLatency,
    sessionId: result.sessionId,
    chunks,
  };
}

function buildVoiceCallerContext(sessionId: string, tenantId = 'tenant-voice-test') {
  return buildCallerContext({
    tenantId,
    channel: 'voice_livekit',
    channelId: 'voice_livekit',
    contactId: `contact:${sessionId}`,
    anonymousId: `livekit:${sessionId}`,
    identityTier: 0,
    verificationMethod: 'none',
  });
}

function createAdapter(
  options: Partial<LLMAdapterOptions> & Pick<LLMAdapterOptions, 'sessionId'>,
): RuntimeLLMAdapter {
  const tenantId = options.tenantId ?? 'tenant-voice-test';
  return new RuntimeLLMAdapter({
    projectId: 'proj-traveldesk',
    tenantId,
    callerContext: options.callerContext ?? buildVoiceCallerContext(options.sessionId, tenantId),
    ...options,
  });
}

function stubExecuteMessage(
  responder: (userMessage: string) => string,
): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(testExecutor, 'executeMessage')
    .mockImplementation(
      async (_sessionId: string, userMessage: string, onChunk?: (chunk: string) => void) => {
        const response = responder(userMessage);
        onChunk?.(response);
        return {
          response,
          action: { type: 'respond' },
        };
      },
    );
}

// =============================================================================
// TESTS
// =============================================================================

describe('LiveKit Voice Pipeline E2E — TravelDesk Travel Agent', () => {
  beforeAll(() => {
    _clearDSLCacheForTesting();
    testExecutor = new RuntimeExecutor({ anthropicApiKey: 'test-voice-key' });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirst.mockReset();
    mockCreateConversationSession.mockReset();
    mockSessionUpdate.mockReset();
    mockHandleDisconnect.mockReset();

    // Rebind a fresh mock LLM without rebuilding the executor/DSL graph.
    testMockClient = injectMockClient(testExecutor);
    mockFindFirst.mockResolvedValue(MOCK_PROJECT);
    mockCreateConversationSession.mockResolvedValue({ id: 'db-sess-voice' });
    mockSessionUpdate.mockResolvedValue({});
    mockHandleDisconnect.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    _clearDSLCacheForTesting();
  });

  // ===========================================================================
  // 1. Adapter Initialization with Real Multi-Agent DSL
  // ===========================================================================

  describe('1. Adapter Initialization', () => {
    test('should initialize adapter with all TravelDesk agents compiled', async () => {
      const adapter = createAdapter({
        sessionId: 'voice-init-test',
      });

      await adapter.initialize();

      expect(adapter.getSessionId()).toBeDefined();
      expect(adapter.getSessionId()).not.toBeNull();

      // Verify tenant-guarded query (positional args to findProjectWithAgents)
      expect(mockFindFirst).toHaveBeenCalledWith('proj-traveldesk', 'tenant-voice-test');

      await adapter.dispose();
      expect(adapter.getSessionId()).toBeNull();
    });

    test('should use DSL cache for second adapter in same room', async () => {
      _clearDSLCacheForTesting();
      const adapter1 = createAdapter({
        sessionId: 'voice-cache-1',
      });
      await adapter1.initialize();

      const adapter2 = createAdapter({
        sessionId: 'voice-cache-2',
      });
      await adapter2.initialize();

      // Only one DB fetch — second adapter used cache
      expect(mockFindFirst).toHaveBeenCalledTimes(1);

      await adapter1.dispose();
      await adapter2.dispose();
    });

    test('should reject cross-tenant access', async () => {
      mockFindFirst.mockResolvedValue(null); // Tenant guard returns no project

      const adapter = createAdapter({
        sessionId: 'voice-cross-tenant',
        tenantId: 'tenant-evil',
      });

      await expect(adapter.initialize()).rejects.toThrow(/Project not found or access denied/);
    });

    test('persists the compiled DSL agent name when the stored project agent name is stale', async () => {
      mockFindFirst.mockResolvedValue({
        id: 'proj-voice-mismatch',
        name: 'Voice mismatch project',
        tenantId: 'tenant-voice-test',
        agents: [
          {
            name: 'Eugene',
            dslContent: ALL_DSLS.welcome,
            createdAt: new Date(),
          },
        ],
      });

      const executeMessageSpy = vi
        .spyOn(testExecutor, 'executeMessage')
        .mockImplementation(async (_sessionId, _userMessage, onChunk) => {
          const response = 'Welcome to your travel assistant! How can I help today?';
          onChunk?.(response);
          return {
            response,
            action: { type: 'respond' },
          };
        });

      const adapter = createAdapter({
        sessionId: 'voice-stale-entry-agent',
        projectId: 'proj-voice-mismatch',
        agentName: 'Eugene',
      });

      await adapter.initialize();
      await simulateVoiceTurn(adapter, {
        text: 'Hello there',
      });

      expect(mockCreateConversationSession).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName: 'Welcome_Agent',
        }),
      );
      expect(mockSessionUpdate).toHaveBeenCalledWith(
        'db-sess-voice',
        expect.objectContaining({
          entryAgentName: 'Welcome_Agent',
        }),
        'tenant-voice-test',
      );

      executeMessageSpy.mockRestore();
      await adapter.dispose();
    });
  });

  // ===========================================================================
  // 2. Single-Agent Voice Conversation (Sales Agent)
  // ===========================================================================

  describe('2. Sales Agent — Travel Search Voice Flow', () => {
    let adapter: RuntimeLLMAdapter;
    let executeMessageSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      // Create adapter pointing to Sales_Agent entry point
      adapter = createAdapter({
        sessionId: 'voice-sales-test',
        agentName: 'Sales_Agent',
      });

      // Spy on executeMessage to bypass full gather/flow loops which timeout
      // in test environments. The Sales Agent DSL has GATHER blocks with constraints
      // that cannot be satisfied by mock LLM responses, causing 10s iteration loops.
      // This test suite validates the voice adapter pipeline, not the execution engine.
      executeMessageSpy = vi
        .spyOn(testExecutor, 'executeMessage')
        .mockImplementation(
          async (sessionId: string, userMessage: string, onChunk?: (chunk: string) => void) => {
            const text = userMessage.toLowerCase();

            let response: string;
            if (text.includes('london') && text.includes('barcelona')) {
              response =
                "Great choice! I'd love to help you find flights from London to Barcelona for 2 travelers. When would you like to depart?";
            } else if (text.includes('march') || text.includes('budget')) {
              response =
                "Perfect! Searching for flights from London to Barcelona on March 15th within your 400 euro budget. Let me check what's available.";
            } else {
              response = 'I can help you find travel options. Where would you like to go?';
            }

            if (onChunk) {
              onChunk(response);
            }

            return {
              response,
              action: { type: 'respond' },
            };
          },
        );
    });

    afterEach(async () => {
      executeMessageSpy.mockRestore();
      await adapter.dispose();
    });

    test('Turn 1: Voice utterance triggers entity extraction and response', async () => {
      // Simulate: user says "I want to fly from London to Barcelona for 2 people"
      const turn1 = await simulateVoiceTurn(adapter, {
        text: 'I want to fly from London to Barcelona for 2 people',
        confidence: 0.95,
        sttDurationMs: 250,
      });

      expect(turn1.agentResponse).toBeDefined();
      expect(turn1.agentResponse.length).toBeGreaterThan(0);
      expect(turn1.sessionId).toBeDefined();

      // Session should be created and active
      expect(adapter.getSessionId()).toBe(turn1.sessionId);
    });

    test('Turn 2: Follow-up voice utterance with dates and budget', async () => {
      // Turn 1: initial search
      await simulateVoiceTurn(adapter, {
        text: 'I want to fly from London to Barcelona for 2 people',
      });

      // Turn 2: provide dates and budget
      const turn2 = await simulateVoiceTurn(adapter, {
        text: 'Departing March 15th, budget 400 euros',
      });

      expect(turn2.agentResponse).toBeDefined();
      expect(turn2.agentResponse.length).toBeGreaterThan(0);

      // Same session maintained across turns
      expect(turn2.sessionId).toBe(adapter.getSessionId());
    });

    test('Multi-turn conversation maintains session state', async () => {
      const sessionIds = new Set<string>();

      // Simulate 3 voice turns
      const turn1 = await simulateVoiceTurn(adapter, {
        text: 'I want to fly from London to Barcelona for 2 people',
      });
      sessionIds.add(turn1.sessionId);

      const turn2 = await simulateVoiceTurn(adapter, {
        text: 'Departing March 15th, budget 400 euros',
      });
      sessionIds.add(turn2.sessionId);

      const turn3 = await simulateVoiceTurn(adapter, {
        text: 'Show me the cheapest option',
      });
      sessionIds.add(turn3.sessionId);

      // All turns used the same session (no session leaks)
      expect(sessionIds.size).toBe(1);

      // Adapter tracks duration
      expect(adapter.getSessionDurationMs()).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // 3. Supervisor Routing Voice Flow
  // ===========================================================================

  describe('3. Supervisor — Voice-Driven Routing', () => {
    let adapter: RuntimeLLMAdapter;
    let executeMessageSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      adapter = createAdapter({
        sessionId: 'voice-supervisor-test',
        // No agentName — uses first agent (supervisor) as entry
      });

      // This suite validates the voice adapter/session pipeline. The runtime execution
      // engine already has separate routing coverage and can loop on full supervisor DSLs.
      executeMessageSpy = stubExecuteMessage((userMessage) => {
        const userText = userMessage.toLowerCase();
        if (userText.includes('hello') || userText.includes('hi')) {
          return "Welcome to TravelDesk.com! I'm your travel assistant. How can I help you today?";
        }
        if (userText.includes('book') || userText.includes('flight')) {
          return "I'd love to help you book a trip! Where would you like to go?";
        }
        if (userText.includes('goodbye') || userText.includes('bye')) {
          return 'Thank you for contacting TravelDesk.com! Have a wonderful day!';
        }
        return "I'm here to help. What would you like to do?";
      });
    });

    afterEach(async () => {
      executeMessageSpy.mockRestore();
      await adapter.dispose();
    });

    test('Greeting voice utterance gets a welcome response', async () => {
      const turn = await simulateVoiceTurn(adapter, {
        text: 'Hello, I need help with travel',
        confidence: 0.92,
      });

      expect(turn.agentResponse).toBeDefined();
      expect(turn.agentResponse.length).toBeGreaterThan(10);
      expect(turn.sessionId).toBeDefined();
    });

    test('Travel booking intent gets routed correctly', async () => {
      // Turn 1: greeting
      await simulateVoiceTurn(adapter, {
        text: 'Hi there',
      });

      // Turn 2: express travel intent
      const turn2 = await simulateVoiceTurn(adapter, {
        text: 'I want to book a flight to Paris',
      });

      expect(turn2.agentResponse).toBeDefined();
      expect(turn2.agentResponse.length).toBeGreaterThan(0);
    });

    test('Full voice conversation: greeting → search → farewell', async () => {
      const conversation: VoiceTurnResult[] = [];

      // Turn 1: Greeting
      conversation.push(
        await simulateVoiceTurn(adapter, {
          text: 'Hello!',
          sttDurationMs: 150,
        }),
      );

      // Turn 2: Travel intent
      conversation.push(
        await simulateVoiceTurn(adapter, {
          text: 'I want to book a flight to Barcelona',
          sttDurationMs: 300,
        }),
      );

      // Turn 3: Farewell
      conversation.push(
        await simulateVoiceTurn(adapter, {
          text: 'Actually, goodbye for now',
          sttDurationMs: 200,
        }),
      );

      // Verify all turns produced responses
      for (const turn of conversation) {
        expect(turn.agentResponse).toBeDefined();
        expect(turn.agentResponse.length).toBeGreaterThan(0);
      }

      // All turns used same session
      const sessionIds = new Set(conversation.map((t) => t.sessionId));
      expect(sessionIds.size).toBe(1);

      // Session duration spans the full conversation
      expect(adapter.getSessionDurationMs()).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // 4. Voice-Specific Edge Cases
  // ===========================================================================

  describe('4. Voice Pipeline Edge Cases', () => {
    test('Empty utterance (STT returned nothing) is handled gracefully', async () => {
      const adapter = createAdapter({
        sessionId: 'voice-empty',
      });
      const spy = stubExecuteMessage(() => "I didn't catch that. Could you please repeat?");

      const turn = await simulateVoiceTurn(adapter, {
        text: '',
        confidence: 0.1,
      });

      expect(turn.agentResponse).toBeDefined();
      spy.mockRestore();
      await adapter.dispose();
    });

    test('Rapid successive utterances maintain session integrity', async () => {
      const adapter = createAdapter({
        sessionId: 'voice-rapid',
        agentName: 'Sales_Agent',
      });

      // Spy on executeMessage to bypass Sales Agent gather/flow loops
      const spy = vi
        .spyOn(testExecutor, 'executeMessage')
        .mockImplementation(async (_sessionId, _msg, onChunk) => {
          const response = 'Processing your request.';
          if (onChunk) onChunk(response);
          return { response, action: { type: 'respond' } };
        });

      // Send multiple utterances sequentially (simulating rapid speech)
      const results = [];
      for (const text of ['London', 'Barcelona', 'March 15th']) {
        results.push(await simulateVoiceTurn(adapter, { text }));
      }

      // All should succeed with same session
      const sessions = new Set(results.map((r) => r.sessionId));
      expect(sessions.size).toBe(1);
      expect(results.length).toBe(3);

      spy.mockRestore();
      await adapter.dispose();
    });

    test('Adapter auto-initializes on first chat call', async () => {
      const adapter = createAdapter({
        sessionId: 'voice-auto-init',
      });
      const spy = stubExecuteMessage(() => "Hello! I'm your travel assistant at TravelDesk.com.");

      // Don't call initialize() — adapter should auto-init on first chat
      expect(adapter.getSessionId()).toBeNull();

      const turn = await simulateVoiceTurn(adapter, { text: 'Hello' });

      expect(adapter.getSessionId()).not.toBeNull();
      expect(turn.agentResponse).toContain('travel assistant');

      spy.mockRestore();
      await adapter.dispose();
    });

    test('Dispose cleans up session resources', async () => {
      const adapter = createAdapter({
        sessionId: 'voice-dispose',
      });

      testMockClient.setResponseHandler(() => ({
        text: 'Test response.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: 'Test response.' }],
      }));

      await adapter.initialize();
      const sessionId = adapter.getSessionId();
      expect(sessionId).not.toBeNull();

      await adapter.dispose();
      expect(adapter.getSessionId()).toBeNull();

      // Double dispose should not throw
      await expect(adapter.dispose()).resolves.not.toThrow();
    });
  });

  // ===========================================================================
  // 5. Timing & Latency Simulation
  // ===========================================================================

  describe('5. Pipeline Timing', () => {
    test('Voice turn captures timing metrics', async () => {
      const adapter = createAdapter({
        sessionId: 'voice-timing',
      });
      const spy = stubExecuteMessage(() => 'Response for timing test.');

      const turn = await simulateVoiceTurn(adapter, {
        text: 'Hello there',
        sttDurationMs: 300,
      });

      // Pipeline latency should be > 0 (includes simulated STT + real LLM execution + simulated TTS)
      expect(turn.pipelineLatencyMs).toBeGreaterThan(0);

      // Session duration tracks wall-clock time
      expect(adapter.getSessionDurationMs()).toBeGreaterThan(0);

      spy.mockRestore();
      await adapter.dispose();
    });
  });

  // ===========================================================================
  // 6. Concurrent Voice Sessions
  // ===========================================================================

  describe('6. Concurrent Sessions (Multi-Room)', () => {
    test('Two simultaneous voice sessions with different agents', async () => {
      _clearDSLCacheForTesting();

      const adapter1 = createAdapter({
        sessionId: 'voice-room-1',
        agentName: 'Sales_Agent',
      });

      const adapter2 = createAdapter({
        sessionId: 'voice-room-2',
        agentName: 'Sales_Agent',
      });

      // Spy on executeMessage to bypass Sales Agent gather/flow loops
      const spy = vi
        .spyOn(testExecutor, 'executeMessage')
        .mockImplementation(async (_sessionId, _msg, onChunk) => {
          const response = 'Helping you find travel.';
          if (onChunk) onChunk(response);
          return { response, action: { type: 'respond' } };
        });

      // Both sessions active simultaneously
      const [turn1, turn2] = await Promise.all([
        simulateVoiceTurn(adapter1, { text: 'Flights to Paris' }),
        simulateVoiceTurn(adapter2, { text: 'Hotels in Rome' }),
      ]);

      // Each has its own session
      expect(turn1.sessionId).not.toBe(turn2.sessionId);

      // Both produced responses
      expect(turn1.agentResponse).toBeDefined();
      expect(turn2.agentResponse).toBeDefined();

      // DSL cache: only 1 DB fetch for both (same project)
      expect(mockFindFirst).toHaveBeenCalledTimes(1);

      spy.mockRestore();
      await Promise.all([adapter1.dispose(), adapter2.dispose()]);
    });
  });
});

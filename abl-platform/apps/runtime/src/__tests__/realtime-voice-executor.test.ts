/**
 * Realtime Voice Executor Tests
 *
 * Tests the RealtimeVoiceExecutor — the bridge between ABL agent flow
 * (tools, constraints, handoffs, state) and the RealtimeVoiceSession.
 * Uses a lightweight TestRealtimeSession that implements the interface
 * directly (no vi.mock).
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Voice trace + metrics mocks (vi.hoisted to avoid TDZ issues with vi.mock)
// ---------------------------------------------------------------------------
const {
  mockStartRealtimeVoiceTurn,
  mockRecordRealtimeFirstAudioOut,
  mockRecordRealtimeToolCall,
  mockCompleteRealtimeVoiceTurn,
  mockFailRealtimeVoiceTurn,
  mockRecordRealtimeTurnComplete,
  mockRecordRealtimeSessionStart,
  mockRecordRealtimeSessionEnd,
  mockRecordRealtimeInterruption,
} = vi.hoisted(() => {
  const mockStartRealtimeVoiceTurn = vi.fn(() => ({
    turnId: 'trace-turn-id',
    traceId: 'trace-trace-id',
    spanId: 'trace-span-id',
    sessionId: '',
    rootSpan: { setAttribute: vi.fn(), setAttributes: vi.fn(), setStatus: vi.fn(), end: vi.fn() },
    otelContext: {},
    turnStartTime: Date.now(),
    audioDurationInMs: 0,
    audioDurationOutMs: 0,
    toolCallCount: 0,
    toolCallLatencyMs: 0,
    status: 'active' as const,
  }));
  return {
    mockStartRealtimeVoiceTurn,
    mockRecordRealtimeFirstAudioOut: vi.fn(),
    mockRecordRealtimeToolCall: vi.fn(),
    mockCompleteRealtimeVoiceTurn: vi.fn(() => ({
      turnLatency: 100,
      totalDuration: 500,
      toolCallOverhead: 50,
      audioDurationInMs: 0,
      audioDurationOutMs: 0,
    })),
    mockFailRealtimeVoiceTurn: vi.fn(),
    mockRecordRealtimeTurnComplete: vi.fn(),
    mockRecordRealtimeSessionStart: vi.fn(),
    mockRecordRealtimeSessionEnd: vi.fn(),
    mockRecordRealtimeInterruption: vi.fn(),
  };
});

vi.mock('../observability/voice-trace.js', () => ({
  startRealtimeVoiceTurn: mockStartRealtimeVoiceTurn,
  recordRealtimeFirstAudioOut: mockRecordRealtimeFirstAudioOut,
  recordRealtimeToolCall: mockRecordRealtimeToolCall,
  completeRealtimeVoiceTurn: mockCompleteRealtimeVoiceTurn,
  failRealtimeVoiceTurn: mockFailRealtimeVoiceTurn,
}));

vi.mock('../observability/voice-metrics.js', () => ({
  recordRealtimeTurnComplete: mockRecordRealtimeTurnComplete,
  recordRealtimeSessionStart: mockRecordRealtimeSessionStart,
  recordRealtimeSessionEnd: mockRecordRealtimeSessionEnd,
  recordRealtimeInterruption: mockRecordRealtimeInterruption,
}));

import {
  RealtimeVoiceExecutor,
  type RealtimeVoiceExecutorConfig,
  type TranscriptEntry,
  type TurnMetrics,
} from '../services/voice/realtime-voice-executor.js';
import type {
  RealtimeVoiceSession,
  RealtimeVoiceSessionEvents,
  RealtimeSessionConfig,
  RealtimeConnectionState,
  RealtimeUsageMetrics,
  RealtimeToolCall,
  RealtimeTranscript,
  RealtimeVoiceProviderCapabilityProfile,
} from '@abl/compiler/platform/llm/realtime/types.js';
import type { ToolDefinition } from '@abl/compiler/platform/llm/types.js';
import type { AgentIR } from '@abl/compiler/platform/ir/schema.js';
import { REALTIME_VOICE_TURN_TOOL_NAME } from '../services/voice/voice-prompt-profile.js';

const OPENAI_REALTIME_CAPABILITIES = {
  providerType: 'openai_realtime',
  capabilities: {
    supportsPromptRefresh: true,
    supportsToolRefresh: true,
    supportsToolResultInjection: true,
    supportsPartialAssistantTranscript: true,
    supportsProviderTurnDetection: true,
    supportsBargeInSignal: true,
  },
  notes: ['OpenAI Realtime supports prompt and tool refresh.'],
} as const satisfies RealtimeVoiceProviderCapabilityProfile;

// =============================================================================
// TEST SESSION — Lightweight implementation of RealtimeVoiceSession
// =============================================================================

class TestRealtimeSession implements RealtimeVoiceSession {
  readonly providerType = 'openai_realtime' as const;
  connectionState: RealtimeConnectionState = 'disconnected';

  private handlers = new Map<string, Set<Function>>();

  // Call tracking
  connectCalls: RealtimeSessionConfig[] = [];
  disconnectCalls = 0;
  sendAudioCalls: Buffer[] = [];
  cancelResponseCalls = 0;
  submitToolResultCalls: Array<{ callId: string; result: string }> = [];
  updateSystemPromptCalls: string[] = [];
  updateToolsCalls: ToolDefinition[][] = [];
  commitAudioBufferCalls = 0;

  private _usageMetrics: RealtimeUsageMetrics = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    audioDurationInMs: 0,
    audioDurationOutMs: 0,
    turnCount: 0,
    connectionDurationMs: 0,
  };

  getCapabilityProfile(): RealtimeVoiceProviderCapabilityProfile {
    return OPENAI_REALTIME_CAPABILITIES;
  }

  async connect(config: RealtimeSessionConfig): Promise<void> {
    this.connectCalls.push(config);
    this.connectionState = 'connected';
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls++;
    this.connectionState = 'disconnected';
  }

  sendAudio(audio: Buffer): void {
    this.sendAudioCalls.push(audio);
  }

  commitAudioBuffer(): void {
    this.commitAudioBufferCalls++;
  }

  cancelResponse(): void {
    this.cancelResponseCalls++;
  }

  submitToolResult(callId: string, result: string): void {
    this.submitToolResultCalls.push({ callId, result });
  }

  updateSystemPrompt(prompt: string): void {
    this.updateSystemPromptCalls.push(prompt);
  }

  updateTools(tools: ToolDefinition[]): void {
    this.updateToolsCalls.push(tools);
  }

  on<K extends keyof RealtimeVoiceSessionEvents>(
    event: K,
    handler: NonNullable<RealtimeVoiceSessionEvents[K]>,
  ): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as Function);
  }

  off<K extends keyof RealtimeVoiceSessionEvents>(
    event: K,
    handler: NonNullable<RealtimeVoiceSessionEvents[K]>,
  ): void {
    this.handlers.get(event)?.delete(handler as Function);
  }

  getUsageMetrics(): RealtimeUsageMetrics {
    return { ...this._usageMetrics };
  }

  // Test helper: emit events to registered handlers
  emit(event: string, ...args: any[]): void {
    this.handlers.get(event)?.forEach((h) => h(...args));
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function makeAgentIR(overrides?: Partial<AgentIR>): AgentIR {
  return {
    ir_version: '1.0',
    metadata: { name: 'test-agent', version: '1.0.0', description: '', tags: [], source_hash: '' },
    execution: {
      mode: 'reasoning',
      hints: {
        voice_optimized: true,
        requires_persistence: false,
        supports_hitl: false,
        parallel_tools: false,
        complexity: 'simple',
      },
      timeouts: { turn_timeout: 30000, total_timeout: 600000, tool_timeout: 15000 },
    },
    identity: {
      goal: 'Help users book flights',
      persona: 'You are a friendly travel assistant.',
      limitations: ['Do not book hotels', 'Do not process payments directly'],
      system_prompt: { template: '' },
    },
    tools: [
      {
        name: 'search_flights',
        description: 'Search for available flights',
        parameters: [
          { name: 'origin', type: 'string', description: 'Origin city', required: true },
          { name: 'destination', type: 'string', description: 'Destination city', required: true },
          { name: 'date', type: 'string', description: 'Travel date', required: false },
        ],
        returns: { type: 'object' },
        hints: {},
      },
      {
        name: '__handoff__',
        description: 'System handoff tool',
        parameters: [],
        returns: { type: 'string' },
        hints: {},
      },
    ],
    gather: { fields: [], strategy: 'conversational' },
    memory: {
      persistence: 'session',
      context_window: { max_turns: 20, strategy: 'sliding_window' },
    },
    constraints: {
      constraints: [],
      guardrails: [
        {
          name: 'no-pii',
          description: 'Never share PII',
          check: 'no_pii_in_response',
          action: { type: 'respond', message: 'Cannot share PII' },
        },
      ],
    },
    coordination: { handoffs: [], escalation: { enabled: false } },
    completion: { conditions: [], message: '' },
    error_handling: { strategy: 'retry', max_retries: 3, fallback_message: '' },
    ...overrides,
  } as AgentIR;
}

function makeConfig(overrides?: Partial<RealtimeVoiceExecutorConfig>): RealtimeVoiceExecutorConfig {
  return {
    sessionId: 'test-session-1',
    agentIR: makeAgentIR(),
    sessionConfig: {
      model: 'gpt-realtime-1.5',
      systemPrompt: '', // Will be overridden by buildSessionConfig
      apiKey: 'test-api-key',
    },
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('RealtimeVoiceExecutor', () => {
  let session: TestRealtimeSession;
  let executor: RealtimeVoiceExecutor;
  let config: RealtimeVoiceExecutorConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    session = new TestRealtimeSession();
    config = makeConfig();
    executor = new RealtimeVoiceExecutor(session, config);
  });

  // ===========================================================================
  // START
  // ===========================================================================

  describe('start()', () => {
    test('calls session.connect with built config', async () => {
      await executor.start();
      expect(session.connectCalls).toHaveLength(1);
      const sentConfig = session.connectCalls[0];
      expect(sentConfig.model).toBe('gpt-realtime-1.5');
      expect(sentConfig.apiKey).toBe('test-api-key');
    });

    test('system prompt includes persona', async () => {
      await executor.start();
      const prompt = session.connectCalls[0].systemPrompt;
      expect(prompt).toContain('You are a friendly travel assistant.');
    });

    test('system prompt includes goal', async () => {
      await executor.start();
      const prompt = session.connectCalls[0].systemPrompt;
      expect(prompt).toContain('Help users book flights');
    });

    test('system prompt includes limitations', async () => {
      await executor.start();
      const prompt = session.connectCalls[0].systemPrompt;
      expect(prompt).toContain('Do not book hotels');
      expect(prompt).toContain('Do not process payments directly');
    });

    test('system prompt includes canonical voice formatting guidance', async () => {
      await executor.start();
      const prompt = session.connectCalls[0].systemPrompt;
      expect(prompt).toContain('## Response Format (Voice Channel)');
      expect(prompt).toContain('## Realtime Voice Operating Mode');
    });

    test('system prompt falls back to the canonical template when identity is empty', async () => {
      const emptyIR = makeAgentIR({
        identity: { goal: '', persona: '', limitations: [], system_prompt: { template: '' } },
        constraints: { constraints: [], guardrails: [] },
      });
      config = makeConfig({ agentIR: emptyIR });
      executor = new RealtimeVoiceExecutor(session, config);
      await executor.start();
      expect(session.connectCalls[0].systemPrompt).toContain(
        'You are test-agent, an AI assistant.',
      );
      expect(session.connectCalls[0].systemPrompt).toContain('## Realtime Voice Operating Mode');
    });

    test('tools converted from ToolParameter[] to JSON Schema', async () => {
      await executor.start();
      const tools = session.connectCalls[0].tools!;
      const searchFlightsTool = tools.find((tool) => tool.name === 'search_flights');

      expect(searchFlightsTool).toBeDefined();
      expect(searchFlightsTool?.input_schema.type).toBe('object');
      expect(searchFlightsTool?.input_schema.properties).toHaveProperty('origin');
      expect(searchFlightsTool?.input_schema.properties.origin).toEqual({
        type: 'string',
        description: 'Origin city',
      });
      expect(searchFlightsTool?.input_schema.required).toEqual(['origin', 'destination']);
    });

    test('__system_* tools are filtered out', async () => {
      await executor.start();
      const tools = session.connectCalls[0].tools!;
      const systemTools = tools.filter((t: ToolDefinition) => t.name.startsWith('__system_'));
      expect(systemTools).toHaveLength(0);
    });

    test('start is idempotent (second call is no-op)', async () => {
      await executor.start();
      await executor.start();
      expect(session.connectCalls).toHaveLength(1);
    });
  });

  // ===========================================================================
  // STOP
  // ===========================================================================

  describe('stop()', () => {
    test('calls session.disconnect', async () => {
      await executor.start();
      await executor.stop();
      expect(session.disconnectCalls).toBe(1);
    });

    test('stop is idempotent', async () => {
      await executor.start();
      await executor.stop();
      await executor.stop();
      expect(session.disconnectCalls).toBe(1);
    });

    test('stop on never-started executor is no-op', async () => {
      await executor.stop();
      expect(session.disconnectCalls).toBe(0);
    });
  });

  // ===========================================================================
  // AUDIO PROXY
  // ===========================================================================

  describe('sendAudio / cancelResponse', () => {
    test('sendAudio delegates when running', async () => {
      await executor.start();
      const audio = Buffer.from('test-audio');
      executor.sendAudio(audio);
      expect(session.sendAudioCalls).toHaveLength(1);
      expect(session.sendAudioCalls[0]).toBe(audio);
    });

    test('sendAudio is no-op when stopped', () => {
      executor.sendAudio(Buffer.from('test'));
      expect(session.sendAudioCalls).toHaveLength(0);
    });

    test('cancelResponse delegates when running', async () => {
      await executor.start();
      executor.cancelResponse();
      expect(session.cancelResponseCalls).toBe(1);
    });

    test('cancelResponse is no-op when stopped', () => {
      executor.cancelResponse();
      expect(session.cancelResponseCalls).toBe(0);
    });
  });

  // ===========================================================================
  // TOOL CALL HANDLING
  // ===========================================================================

  describe('tool call handling', () => {
    test('tool call routes through toolExecutor and submits result', async () => {
      const toolExecutor = vi.fn().mockResolvedValue('{"flights": []}');
      config = makeConfig({ toolExecutor });
      executor = new RealtimeVoiceExecutor(session, config);
      await executor.start();

      const toolCall: RealtimeToolCall = {
        callId: 'call-1',
        name: 'search_flights',
        arguments: '{"origin":"SFO","destination":"LAX"}',
      };
      session.emit('onToolCall', toolCall);

      // Give async handler time to complete
      await vi.waitFor(() => {
        expect(session.submitToolResultCalls).toHaveLength(1);
      });

      expect(toolExecutor).toHaveBeenCalledWith(
        'search_flights',
        { origin: 'SFO', destination: 'LAX' },
        'test-session-1',
      );
      expect(session.submitToolResultCalls[0]).toEqual({
        callId: 'call-1',
        result: '{"flights": []}',
      });
    });

    test('structured tool results refresh the active agent before submitting the tool result', async () => {
      const transferAgentIR = makeAgentIR({
        metadata: {
          name: 'transfer-agent',
          version: '1.0.0',
          description: '',
          tags: [],
          source_hash: '',
        },
        identity: {
          goal: 'Transfer customer to the right team',
          persona: 'You are the transfer specialist.',
          limitations: [],
          system_prompt: { template: '' },
        },
        tools: [
          {
            name: 'search_hotels',
            description: 'Search hotels for the customer',
            parameters: [
              { name: 'city', type: 'string', description: 'Destination city', required: true },
            ],
            returns: { type: 'object' },
            hints: {},
          },
        ],
      });
      const toolExecutor = vi.fn().mockResolvedValue({
        result: '{"status":"ok"}',
        activeAgentName: 'transfer-agent',
        activeAgentIR: transferAgentIR,
      });
      config = makeConfig({ toolExecutor });
      executor = new RealtimeVoiceExecutor(session, config);
      await executor.start();

      session.emit('onToolCall', {
        callId: 'call-handoff',
        name: 'search_flights',
        arguments: '{"origin":"SFO"}',
      });

      await vi.waitFor(() => {
        expect(session.submitToolResultCalls).toHaveLength(1);
      });

      expect(session.updateSystemPromptCalls.at(-1)).toContain('You are the transfer specialist.');
      expect(session.updateToolsCalls.at(-1)?.map((tool) => tool.name)).toContain('search_hotels');
      expect(session.submitToolResultCalls[0]).toEqual({
        callId: 'call-handoff',
        result: '{"status":"ok"}',
      });
    });

    test('malformed JSON arguments parsed as empty object', async () => {
      const toolExecutor = vi.fn().mockResolvedValue('"ok"');
      config = makeConfig({ toolExecutor });
      executor = new RealtimeVoiceExecutor(session, config);
      await executor.start();

      session.emit('onToolCall', {
        callId: 'call-2',
        name: 'search_flights',
        arguments: 'not-valid-json{',
      });

      await vi.waitFor(() => {
        expect(toolExecutor).toHaveBeenCalledWith('search_flights', {}, 'test-session-1');
      });
    });

    test('constraint check failure overrides tool result', async () => {
      const toolExecutor = vi.fn().mockResolvedValue('{"result":"ok"}');
      const constraintChecker = vi.fn().mockResolvedValue({
        passed: false,
        violations: ['PII detected in output'],
      });
      config = makeConfig({ toolExecutor, constraintChecker });
      executor = new RealtimeVoiceExecutor(session, config);
      await executor.start();

      session.emit('onToolCall', {
        callId: 'call-3',
        name: 'search_flights',
        arguments: '{}',
      });

      await vi.waitFor(() => {
        expect(session.submitToolResultCalls).toHaveLength(1);
      });

      const result = JSON.parse(session.submitToolResultCalls[0].result);
      expect(result.status).toBe('constraint_violation');
      expect(result.violations).toContain('PII detected in output');
    });

    test('constraint check pass preserves tool result', async () => {
      const toolExecutor = vi.fn().mockResolvedValue('{"flights":[]}');
      const constraintChecker = vi.fn().mockResolvedValue({ passed: true, violations: [] });
      config = makeConfig({ toolExecutor, constraintChecker });
      executor = new RealtimeVoiceExecutor(session, config);
      await executor.start();

      session.emit('onToolCall', { callId: 'c-1', name: 'search_flights', arguments: '{}' });

      await vi.waitFor(() => {
        expect(session.submitToolResultCalls).toHaveLength(1);
      });
      expect(session.submitToolResultCalls[0].result).toBe('{"flights":[]}');
    });

    test('toolExecutor throws → error result submitted', async () => {
      const toolExecutor = vi.fn().mockRejectedValue(new Error('DB connection failed'));
      config = makeConfig({ toolExecutor });
      executor = new RealtimeVoiceExecutor(session, config);
      await executor.start();

      session.emit('onToolCall', { callId: 'c-err', name: 'search_flights', arguments: '{}' });

      await vi.waitFor(() => {
        expect(session.submitToolResultCalls).toHaveLength(1);
      });

      const result = JSON.parse(session.submitToolResultCalls[0].result);
      expect(result.status).toBe('error');
      expect(result.message).toBe('DB connection failed');
    });

    test('no toolExecutor → default result', async () => {
      // config without toolExecutor
      config = makeConfig();
      executor = new RealtimeVoiceExecutor(session, config);
      await executor.start();

      session.emit('onToolCall', { callId: 'c-def', name: 'search_flights', arguments: '{}' });

      await vi.waitFor(() => {
        expect(session.submitToolResultCalls).toHaveLength(1);
      });

      const result = JSON.parse(session.submitToolResultCalls[0].result);
      expect(result.status).toBe('ok');
      expect(result.message).toContain('search_flights');
    });

    test('coordinator tool uses the finalized normalized transcript and bypasses legacy constraint checks', async () => {
      const voiceTurnExecutor = vi.fn().mockResolvedValue({
        result: '{"response_text":"Your trip is updated."}',
        activeAgentName: 'test-agent',
        activeAgentIR: config.agentIR,
      });
      const constraintChecker = vi
        .fn()
        .mockResolvedValue({ passed: false, violations: ['blocked'] });
      config = makeConfig({
        voiceTurnExecutor,
        constraintChecker,
        semanticConvergence: {
          family: 'sdk_voice_realtime',
          mode: 'enforce',
          strategy: 'coordinator_tool',
          providerType: 'openai_realtime',
          reason: 'enforce_coordinator_tool',
          notes: ['Coordinator tool is active.'],
        },
      });
      executor = new RealtimeVoiceExecutor(session, config);
      await executor.start();

      session.emit('onNormalizedEvent', {
        type: 'user_transcript_final',
        providerType: 'openai_realtime',
        timestamp: Date.now(),
        payload: { text: 'I need to move my flight to Friday' },
      });
      session.emit('onToolCall', {
        callId: 'voice-turn-call',
        name: REALTIME_VOICE_TURN_TOOL_NAME,
        arguments: JSON.stringify({ utterance: 'paraphrased input' }),
      });

      await vi.waitFor(() => {
        expect(session.submitToolResultCalls).toHaveLength(1);
      });

      expect(voiceTurnExecutor).toHaveBeenCalledWith(
        'I need to move my flight to Friday',
        'test-session-1',
      );
      expect(constraintChecker).not.toHaveBeenCalled();
      expect(session.submitToolResultCalls[0]).toEqual({
        callId: 'voice-turn-call',
        result: '{"response_text":"Your trip is updated."}',
      });
    });
  });

  // ===========================================================================
  // TRANSCRIPT HANDLING
  // ===========================================================================

  describe('transcript handling', () => {
    test('final transcripts are stored', async () => {
      await executor.start();
      session.emit('onTranscript', {
        text: 'hello',
        role: 'user',
        isFinal: true,
      } as RealtimeTranscript);
      const transcripts = executor.getTranscripts();
      expect(transcripts).toHaveLength(1);
      expect(transcripts[0].text).toBe('hello');
      expect(transcripts[0].role).toBe('user');
      expect(transcripts[0].isFinal).toBe(true);
    });

    test('partial transcripts are NOT stored', async () => {
      await executor.start();
      session.emit('onTranscript', {
        text: 'hel',
        role: 'assistant',
        isFinal: false,
      } as RealtimeTranscript);
      expect(executor.getTranscripts()).toHaveLength(0);
    });

    test('partial transcripts trigger onTranscript callback', async () => {
      const onTranscript = vi.fn();
      config = makeConfig({ onTranscript });
      executor = new RealtimeVoiceExecutor(session, config);
      await executor.start();

      session.emit('onTranscript', {
        text: 'hel',
        role: 'assistant',
        isFinal: false,
      } as RealtimeTranscript);
      expect(onTranscript).toHaveBeenCalledTimes(1);
      expect(onTranscript.mock.calls[0][0].text).toBe('hel');
      expect(onTranscript.mock.calls[0][0].isFinal).toBe(false);
    });

    test('turn tracking starts on first user transcript', async () => {
      await executor.start();
      // Send a user transcript to start turn tracking
      session.emit('onTranscript', {
        text: 'hi',
        role: 'user',
        isFinal: true,
      } as RealtimeTranscript);
      // The internal currentTurnId should now be set
      // We verify indirectly through turn end
      session.emit('onTurnEnd', {});
    });
  });

  // ===========================================================================
  // TURN END
  // ===========================================================================

  describe('turn end', () => {
    test('onTurnEnd callback receives TurnMetrics', async () => {
      const onTurnEnd = vi.fn();
      config = makeConfig({ onTurnEnd });
      executor = new RealtimeVoiceExecutor(session, config);
      await executor.start();

      // Start a turn
      session.emit('onTranscript', {
        text: 'hi',
        role: 'user',
        isFinal: true,
      } as RealtimeTranscript);

      // End the turn with usage
      session.emit('onTurnEnd', { inputTokens: 100, outputTokens: 50 });

      expect(onTurnEnd).toHaveBeenCalledTimes(1);
      const metrics: TurnMetrics = onTurnEnd.mock.calls[0][0];
      expect(metrics.turnId).toBeDefined();
      expect(typeof metrics.durationMs).toBe('number');
      expect(metrics.inputTokens).toBe(100);
      expect(metrics.outputTokens).toBe(50);
    });

    test('turn counters reset after emission', async () => {
      const onTurnEnd = vi.fn();
      config = makeConfig({ onTurnEnd });
      executor = new RealtimeVoiceExecutor(session, config);
      await executor.start();

      session.emit('onTranscript', {
        text: 'hi',
        role: 'user',
        isFinal: true,
      } as RealtimeTranscript);
      session.emit('onTurnEnd', {});

      // Second turn
      session.emit('onTranscript', {
        text: 'hello again',
        role: 'user',
        isFinal: true,
      } as RealtimeTranscript);
      session.emit('onTurnEnd', { inputTokens: 200 });

      expect(onTurnEnd).toHaveBeenCalledTimes(2);
      const secondMetrics: TurnMetrics = onTurnEnd.mock.calls[1][0];
      expect(secondMetrics.toolCalls).toBe(0);
      expect(secondMetrics.inputTokens).toBe(200);
    });

    test('turn without user transcript uses random turnId', async () => {
      const onTurnEnd = vi.fn();
      config = makeConfig({ onTurnEnd });
      executor = new RealtimeVoiceExecutor(session, config);
      await executor.start();

      session.emit('onTurnEnd', {});
      expect(onTurnEnd).toHaveBeenCalledTimes(1);
      expect(onTurnEnd.mock.calls[0][0].turnId).toBeDefined();
      expect(onTurnEnd.mock.calls[0][0].durationMs).toBe(0); // no start time
    });

    test('tool calls are counted in turn metrics', async () => {
      const toolExecutor = vi.fn().mockResolvedValue('"ok"');
      const onTurnEnd = vi.fn();
      config = makeConfig({ toolExecutor, onTurnEnd });
      executor = new RealtimeVoiceExecutor(session, config);
      await executor.start();

      session.emit('onTranscript', {
        text: 'find flights',
        role: 'user',
        isFinal: true,
      } as RealtimeTranscript);
      session.emit('onToolCall', { callId: 'c1', name: 'search_flights', arguments: '{}' });
      session.emit('onToolCall', { callId: 'c2', name: 'search_flights', arguments: '{}' });

      // Wait for both tool calls to complete
      await vi.waitFor(() => {
        expect(session.submitToolResultCalls).toHaveLength(2);
      });

      session.emit('onTurnEnd', {});
      expect(onTurnEnd.mock.calls[0][0].toolCalls).toBe(2);
      expect(onTurnEnd.mock.calls[0][0].toolCallLatencyMs).toBeGreaterThanOrEqual(0);
    });

    test('shadow mode records a bypass diagnostic when the coordinator tool is skipped', async () => {
      const onTurnEnd = vi.fn();
      config = makeConfig({
        onTurnEnd,
        semanticConvergence: {
          family: 'sdk_voice_realtime',
          mode: 'shadow',
          strategy: 'coordinator_tool',
          providerType: 'openai_realtime',
          reason: 'shadow_coordinator_tool',
          notes: ['Coordinator tool is active in shadow mode.'],
        },
      });
      executor = new RealtimeVoiceExecutor(session, config);
      await executor.start();

      executor.sendAudio(Buffer.from('hello'));
      session.emit('onTurnEnd', {});

      const metrics: TurnMetrics = onTurnEnd.mock.calls[0][0];
      expect(metrics.semanticConvergence).toMatchObject({
        mode: 'shadow',
        strategy: 'coordinator_tool',
        usedCoordinatorTool: false,
        sawUserAudio: true,
        bypassDetected: true,
      });
    });
  });

  // ===========================================================================
  // HANDOFF
  // ===========================================================================

  describe('handleHandoff', () => {
    test('updates system prompt and tools for new agent', async () => {
      await executor.start();

      const newAgentIR = makeAgentIR({
        metadata: {
          name: 'billing-agent',
          version: '1.0.0',
          description: '',
          tags: [],
          source_hash: '',
        },
        identity: {
          goal: 'Handle billing inquiries',
          persona: 'You are a billing specialist.',
          limitations: [],
          system_prompt: { template: '' },
        },
        tools: [
          {
            name: 'get_balance',
            description: 'Get account balance',
            parameters: [{ name: 'account_id', type: 'string', required: true }],
            returns: { type: 'object' },
            hints: {},
          },
        ],
        constraints: { constraints: [], guardrails: [] },
      });

      executor.handleHandoff(newAgentIR);

      expect(session.updateSystemPromptCalls).toHaveLength(1);
      expect(session.updateSystemPromptCalls[0]).toContain('billing specialist');
      expect(session.updateSystemPromptCalls[0]).toContain('Handle billing inquiries');

      expect(session.updateToolsCalls).toHaveLength(1);
      expect(session.updateToolsCalls[0]?.map((tool) => tool.name)).toContain('get_balance');
      expect(
        session.updateToolsCalls[0]?.filter((tool) => tool.name.startsWith('__system_')),
      ).toHaveLength(0);
    });
  });

  // ===========================================================================
  // ACCESSORS
  // ===========================================================================

  describe('accessors', () => {
    test('getTranscripts returns copy', async () => {
      await executor.start();
      session.emit('onTranscript', {
        text: 'hi',
        role: 'user',
        isFinal: true,
      } as RealtimeTranscript);
      const t1 = executor.getTranscripts();
      const t2 = executor.getTranscripts();
      expect(t1).not.toBe(t2);
      expect(t1).toEqual(t2);
    });

    test('getState returns copy', () => {
      const s1 = executor.getState();
      const s2 = executor.getState();
      expect(s1).not.toBe(s2);
      expect(s1).toEqual(s2);
    });

    test('getUsageMetrics delegates to session', () => {
      const metrics = executor.getUsageMetrics();
      expect(metrics).toEqual(session.getUsageMetrics());
    });

    test('getConnectionState delegates to session', () => {
      expect(executor.getConnectionState()).toBe('disconnected');
    });

    test('getConnectionState reflects session state after start', async () => {
      await executor.start();
      expect(executor.getConnectionState()).toBe('connected');
    });
  });

  // ===========================================================================
  // ERROR HANDLING
  // ===========================================================================

  describe('error handling', () => {
    test('onError callback is triggered', async () => {
      const onError = vi.fn();
      config = makeConfig({ onError });
      executor = new RealtimeVoiceExecutor(session, config);
      await executor.start();

      const error = new Error('connection lost');
      session.emit('onError', error);
      expect(onError).toHaveBeenCalledWith(error);
    });
  });

  // ===========================================================================
  // OTEL TRACING & METRICS INTEGRATION
  // ===========================================================================

  describe('OTEL tracing & metrics', () => {
    test('start() calls recordRealtimeSessionStart', async () => {
      await executor.start();
      expect(mockRecordRealtimeSessionStart).toHaveBeenCalledWith('test-session-1');
    });

    test('stop() calls recordRealtimeSessionEnd with duration', async () => {
      await executor.start();
      await executor.stop();
      expect(mockRecordRealtimeSessionEnd).toHaveBeenCalledWith(
        'test-session-1',
        expect.any(Number),
      );
    });

    test('user transcript starts a realtime voice turn trace', async () => {
      await executor.start();
      session.emit('onTranscript', {
        text: 'hi',
        role: 'user',
        isFinal: true,
      } as RealtimeTranscript);
      expect(mockStartRealtimeVoiceTurn).toHaveBeenCalledWith('test-session-1');
    });

    test('first audio out records TTFB via trace', async () => {
      await executor.start();
      // Start a turn first
      session.emit('onTranscript', {
        text: 'hi',
        role: 'user',
        isFinal: true,
      } as RealtimeTranscript);
      // Emit audio
      session.emit('onAudio', Buffer.from('audio-data'));
      expect(mockRecordRealtimeFirstAudioOut).toHaveBeenCalled();
    });

    test('tool call records trace via recordRealtimeToolCall', async () => {
      const toolExecutor = vi.fn().mockResolvedValue('"ok"');
      config = makeConfig({ toolExecutor });
      executor = new RealtimeVoiceExecutor(session, config);
      await executor.start();

      session.emit('onTranscript', {
        text: 'find flights',
        role: 'user',
        isFinal: true,
      } as RealtimeTranscript);
      session.emit('onToolCall', { callId: 'c1', name: 'search_flights', arguments: '{}' });

      await vi.waitFor(() => {
        expect(session.submitToolResultCalls).toHaveLength(1);
      });

      expect(mockRecordRealtimeToolCall).toHaveBeenCalledWith(
        expect.any(Object),
        'search_flights',
        expect.any(Number),
      );
    });

    test('turn end completes trace turn and includes breakdown in TurnMetrics', async () => {
      const onTurnEnd = vi.fn();
      config = makeConfig({ onTurnEnd });
      executor = new RealtimeVoiceExecutor(session, config);
      await executor.start();

      session.emit('onTranscript', {
        text: 'hi',
        role: 'user',
        isFinal: true,
      } as RealtimeTranscript);
      session.emit('onTurnEnd', { inputTokens: 100, outputTokens: 50 });

      expect(mockCompleteRealtimeVoiceTurn).toHaveBeenCalled();
      expect(mockRecordRealtimeTurnComplete).toHaveBeenCalledWith(
        'test-session-1',
        100, // turnLatency from mock
        50, // toolCallOverhead from mock
      );

      const metrics: TurnMetrics = onTurnEnd.mock.calls[0][0];
      expect(metrics.timingBreakdown).toBeDefined();
      expect(metrics.timingBreakdown?.turnLatency).toBe(100);
      expect(metrics.traceId).toBe('trace-trace-id');
      expect(metrics.spanId).toBe('trace-span-id');
    });

    test('interruption fails the trace turn and records metric', async () => {
      await executor.start();
      session.emit('onTranscript', {
        text: 'hi',
        role: 'user',
        isFinal: true,
      } as RealtimeTranscript);
      session.emit('onInterrupted');

      expect(mockFailRealtimeVoiceTurn).toHaveBeenCalledWith(expect.any(Object), 'barge_in');
      expect(mockRecordRealtimeInterruption).toHaveBeenCalledWith('test-session-1');
    });

    test('stop with active turn fails the turn trace', async () => {
      await executor.start();
      session.emit('onTranscript', {
        text: 'hi',
        role: 'user',
        isFinal: true,
      } as RealtimeTranscript);
      await executor.stop();

      expect(mockFailRealtimeVoiceTurn).toHaveBeenCalledWith(expect.any(Object), 'session_stopped');
    });

    test('audio out without active turn does not record TTFB', async () => {
      await executor.start();
      // No user transcript → no turn trace
      session.emit('onAudio', Buffer.from('audio'));
      expect(mockRecordRealtimeFirstAudioOut).not.toHaveBeenCalled();
    });
  });
});

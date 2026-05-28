import { describe, expect, it, vi } from 'vitest';
import type { AgentIR } from '@abl/compiler';
import type {
  RealtimeConnectionState,
  RealtimeSessionConfig,
  RealtimeUsageMetrics,
  RealtimeVoiceProviderCapabilityProfile,
  RealtimeVoiceSession,
  RealtimeVoiceSessionEvents,
} from '@abl/compiler/platform/llm/realtime/types.js';
import type { ToolDefinition } from '@abl/compiler/platform/llm/types.js';
import { RealtimeVoiceExecutor } from '../../services/voice/realtime-voice-executor.js';
import {
  buildVoicePromptProfile,
  REALTIME_VOICE_TURN_TOOL_NAME,
} from '../../services/voice/voice-prompt-profile.js';
import type { RuntimeSession } from '../../services/execution/types.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../../observability/voice-trace.js', () => ({
  startRealtimeVoiceTurn: vi.fn(() => ({
    turnId: 'trace-turn-id',
    traceId: 'trace-id',
    spanId: 'span-id',
    sessionId: 'voice-session-1',
    rootSpan: { setAttribute: vi.fn(), setAttributes: vi.fn(), setStatus: vi.fn(), end: vi.fn() },
    otelContext: {},
    turnStartTime: Date.now(),
    audioDurationInMs: 0,
    audioDurationOutMs: 0,
    toolCallCount: 0,
    toolCallLatencyMs: 0,
    status: 'active' as const,
  })),
  recordRealtimeFirstAudioOut: vi.fn(),
  recordRealtimeToolCall: vi.fn(),
  completeRealtimeVoiceTurn: vi.fn(),
  failRealtimeVoiceTurn: vi.fn(),
}));

vi.mock('../../observability/voice-metrics.js', () => ({
  recordRealtimeTurnComplete: vi.fn(),
  recordRealtimeSessionStart: vi.fn(),
  recordRealtimeSessionEnd: vi.fn(),
  recordRealtimeInterruption: vi.fn(),
}));

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

const GEMINI_LIVE_CAPABILITIES = {
  providerType: 'gemini_live',
  capabilities: {
    supportsPromptRefresh: false,
    supportsToolRefresh: false,
    supportsToolResultInjection: true,
    supportsPartialAssistantTranscript: true,
    supportsProviderTurnDetection: false,
    supportsBargeInSignal: true,
  },
  notes: ['Gemini Live keeps prompt and tool state immutable after connect.'],
} as const satisfies RealtimeVoiceProviderCapabilityProfile;

class TestRealtimeSession implements RealtimeVoiceSession {
  readonly providerType;
  connectionState: RealtimeConnectionState = 'disconnected';

  connectCalls: RealtimeSessionConfig[] = [];
  disconnectCalls = 0;
  updateSystemPromptCalls: string[] = [];
  updateToolsCalls: ToolDefinition[][] = [];

  private handlers = new Map<string, Set<Function>>();

  constructor(private readonly capabilityProfile: RealtimeVoiceProviderCapabilityProfile) {
    this.providerType = capabilityProfile.providerType;
  }

  getCapabilityProfile(): RealtimeVoiceProviderCapabilityProfile {
    return this.capabilityProfile;
  }

  async connect(config: RealtimeSessionConfig): Promise<void> {
    this.connectCalls.push(config);
    this.connectionState = 'connected';
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls++;
    this.connectionState = 'disconnected';
  }

  sendAudio(): void {}

  commitAudioBuffer(): void {}

  cancelResponse(): void {}

  submitToolResult(): void {}

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
    const handlers = this.handlers.get(event) ?? new Set<Function>();
    handlers.add(handler as Function);
    this.handlers.set(event, handlers);
  }

  off<K extends keyof RealtimeVoiceSessionEvents>(
    event: K,
    handler: NonNullable<RealtimeVoiceSessionEvents[K]>,
  ): void {
    this.handlers.get(event)?.delete(handler as Function);
  }

  getUsageMetrics(): RealtimeUsageMetrics {
    return {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      audioDurationInMs: 0,
      audioDurationOutMs: 0,
      turnCount: 0,
      connectionDurationMs: 0,
    };
  }
}

function makeIR(overrides: Partial<AgentIR> = {}): AgentIR {
  return {
    ir_version: '1.0',
    metadata: {
      name: 'travel_agent',
      version: '1.0.0',
      type: 'agent',
      compiled_at: new Date().toISOString(),
      source_hash: 'source-hash',
      compiler_version: '1.0.0',
    },
    execution: {
      mode: 'reasoning',
      hints: {
        voice_optimized: true,
        requires_persistence: false,
        supports_hitl: false,
        parallel_tools: false,
        complexity: 'simple',
      },
      timeouts: {
        tool_timeout_ms: 30000,
        llm_timeout_ms: 60000,
        session_timeout_ms: 1800000,
      },
    },
    identity: {
      goal: 'Help callers manage travel changes.',
      persona: 'You are a calm travel specialist.',
      limitations: ['Do not invent reservation details.'],
      system_prompt: { template: '', sections: {} },
    },
    tools: [
      {
        name: 'lookup_trip',
        description: 'Find a traveler itinerary',
        parameters: [
          {
            name: 'confirmation_code',
            type: 'string',
            description: 'Traveler confirmation code',
            required: true,
          },
        ],
        returns: { type: 'object' },
        hints: {},
      },
    ],
    gather: { fields: [], strategy: 'llm' },
    memory: { session: [], persistent: [], remember: [], recall: [] },
    constraints: { constraints: [], guardrails: [] },
    coordination: { delegates: [], handoffs: [], escalation: undefined },
    completion: { conditions: [] },
    error_handling: {
      handlers: [],
      default_handler: { type: 'default', then: 'continue' },
    },
    ...overrides,
  } as AgentIR;
}

function makeRuntimeSession(agentIR: AgentIR): RuntimeSession {
  return {
    id: 'voice-session-1',
    agentName: agentIR.metadata.name,
    agentIR,
    compilationOutput: null,
    conversationHistory: [],
    state: {
      gatherProgress: {},
      conversationPhase: 'start',
      context: {},
    },
    data: {
      values: {
        session: {
          channel: 'voice',
        },
      },
      gatheredKeys: new Set<string>(),
    },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    delegateStack: [],
    initialized: false,
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    channelType: 'voice',
    createdAt: new Date(),
    lastActivityAt: new Date(),
  } as RuntimeSession;
}

describe('realtime-voice-executor parity', () => {
  it('starts with the canonical realtime prompt profile and exposes diagnostics', async () => {
    const agentIR = makeIR();
    const runtimeSession = makeRuntimeSession(agentIR);
    const session = new TestRealtimeSession(OPENAI_REALTIME_CAPABILITIES);
    const executor = new RealtimeVoiceExecutor(session, {
      sessionId: runtimeSession.id,
      agentIR,
      runtimeSession,
      sessionConfig: {
        model: 'gpt-realtime-1.5',
        apiKey: 'test-api-key',
        systemPrompt: '',
      },
    });

    await executor.start();

    const expectedProfile = buildVoicePromptProfile({
      sessionId: runtimeSession.id,
      agentIR,
      runtimeSession,
      preferredProfile: 'realtime',
      providerCapabilityProfile: OPENAI_REALTIME_CAPABILITIES,
    });

    expect(session.connectCalls).toHaveLength(1);
    expect(session.connectCalls[0]?.systemPrompt).toBe(expectedProfile.systemPrompt);
    expect(session.connectCalls[0]?.tools).toEqual(expectedProfile.tools);
    expect(executor.getPromptProfileDiagnostics()).toEqual(expectedProfile.diagnostics);
  });

  it('refreshes prompt and tools on handoff when the provider supports mutable realtime state', async () => {
    const agentIR = makeIR();
    const runtimeSession = makeRuntimeSession(agentIR);
    const session = new TestRealtimeSession(OPENAI_REALTIME_CAPABILITIES);
    const executor = new RealtimeVoiceExecutor(session, {
      sessionId: runtimeSession.id,
      agentIR,
      runtimeSession,
      sessionConfig: {
        model: 'gpt-realtime-1.5',
        apiKey: 'test-api-key',
        systemPrompt: '',
      },
    });
    await executor.start();

    const billingAgentIR = makeIR({
      metadata: {
        name: 'billing_agent',
        version: '1.0.0',
        type: 'agent',
        compiled_at: new Date().toISOString(),
        source_hash: 'billing-source-hash',
        compiler_version: '1.0.0',
      },
      identity: {
        goal: 'Handle billing corrections.',
        persona: 'You are a billing specialist.',
        limitations: [],
        system_prompt: { template: '', sections: {} },
      },
      tools: [
        {
          name: 'lookup_invoice',
          description: 'Find a billing invoice',
          parameters: [
            {
              name: 'invoice_id',
              type: 'string',
              description: 'Billing invoice ID',
              required: true,
            },
          ],
          returns: { type: 'object' },
          hints: {},
        },
      ],
    });

    executor.handleHandoff(billingAgentIR);

    const expectedProfile = buildVoicePromptProfile({
      sessionId: runtimeSession.id,
      agentIR: billingAgentIR,
      runtimeSession,
      preferredProfile: 'realtime',
      providerCapabilityProfile: OPENAI_REALTIME_CAPABILITIES,
    });

    expect(session.updateSystemPromptCalls).toEqual([expectedProfile.systemPrompt]);
    expect(session.updateToolsCalls).toEqual([expectedProfile.tools]);
    expect(executor.getPromptProfileDiagnostics()).toEqual(expectedProfile.diagnostics);
  });

  it('keeps immutable providers explicit by skipping mid-call refresh and surfacing immutable diagnostics', async () => {
    const agentIR = makeIR();
    const runtimeSession = makeRuntimeSession(agentIR);
    const session = new TestRealtimeSession(GEMINI_LIVE_CAPABILITIES);
    const executor = new RealtimeVoiceExecutor(session, {
      sessionId: runtimeSession.id,
      agentIR,
      runtimeSession,
      sessionConfig: {
        model: 'gemini-live-2.5',
        apiKey: 'test-api-key',
        systemPrompt: '',
      },
    });
    await executor.start();

    const transferAgentIR = makeIR({
      metadata: {
        name: 'transfer_agent',
        version: '1.0.0',
        type: 'agent',
        compiled_at: new Date().toISOString(),
        source_hash: 'transfer-source-hash',
        compiler_version: '1.0.0',
      },
      identity: {
        goal: 'Transfer the caller to the right specialist.',
        persona: 'You are the transfer specialist.',
        limitations: [],
        system_prompt: { template: '', sections: {} },
      },
    });

    executor.handleHandoff(transferAgentIR);

    expect(session.updateSystemPromptCalls).toHaveLength(0);
    expect(session.updateToolsCalls).toHaveLength(0);
    expect(executor.getPromptProfileDiagnostics()).toMatchObject({
      profile: 'realtime',
      providerType: 'gemini_live',
      promptRefresh: 'immutable',
      toolRefresh: 'immutable',
    });
  });

  it('locks supported realtime providers to the coordinator tool surface when semantic convergence is enabled', async () => {
    const agentIR = makeIR();
    const runtimeSession = makeRuntimeSession(agentIR);
    const session = new TestRealtimeSession(OPENAI_REALTIME_CAPABILITIES);
    const executor = new RealtimeVoiceExecutor(session, {
      sessionId: runtimeSession.id,
      agentIR,
      runtimeSession,
      voiceTurnExecutor: vi.fn().mockResolvedValue({
        result: '{"response_text":"Hello"}',
        activeAgentName: agentIR.metadata.name,
        activeAgentIR: agentIR,
      }),
      semanticConvergence: {
        family: 'sdk_voice_realtime',
        mode: 'enforce',
        strategy: 'coordinator_tool',
        providerType: 'openai_realtime',
        reason: 'enforce_coordinator_tool',
        notes: ['Coordinator tool is active.'],
      },
      sessionConfig: {
        model: 'gpt-realtime-1.5',
        apiKey: 'test-api-key',
        systemPrompt: '',
      },
    });

    await executor.start();

    const expectedProfile = buildVoicePromptProfile({
      sessionId: runtimeSession.id,
      agentIR,
      runtimeSession,
      preferredProfile: 'realtime',
      providerCapabilityProfile: OPENAI_REALTIME_CAPABILITIES,
      semanticConvergencePlan: {
        family: 'sdk_voice_realtime',
        mode: 'enforce',
        strategy: 'coordinator_tool',
        providerType: 'openai_realtime',
        reason: 'enforce_coordinator_tool',
        notes: ['Coordinator tool is active.'],
      },
    });

    expect(session.connectCalls[0]?.tools?.map((tool) => tool.name)).toEqual([
      REALTIME_VOICE_TURN_TOOL_NAME,
    ]);
    expect(executor.getPromptProfileDiagnostics()).toEqual(expectedProfile.diagnostics);

    executor.handleHandoff(
      makeIR({
        metadata: {
          name: 'returns_agent',
          version: '1.0.0',
          type: 'agent',
          compiled_at: new Date().toISOString(),
          source_hash: 'returns-source-hash',
          compiler_version: '1.0.0',
        },
      }),
    );

    expect(session.updateSystemPromptCalls).toHaveLength(0);
    expect(session.updateToolsCalls).toHaveLength(0);
  });
});

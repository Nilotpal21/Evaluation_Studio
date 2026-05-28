import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentIR } from '@abl/compiler/platform/ir/schema.js';
import type { RuntimeSession } from '../../services/execution/types.js';
import type { S2SSessionConfig } from '../../services/voice/s2s/types.js';

const mockBuildLiveVoicePromptSurface = vi.fn();
const mockBuildGrokLlmVerbPayload = vi.fn();
const mockBuildRealtimeLlmVerbPayload = vi.fn();
const mockBuildGoogleRealtimeToolDefinitions = vi.fn();
const mockToRealtimeToolDefinitions = vi.fn();
const mockBuildGoogleToolResponse = vi.fn();
const mockBuildOpenAIToolResponse = vi.fn();
const mockBuildGoogleLlmVerb = vi.fn();

vi.mock('../../services/voice/live-voice-runtime-bridge.js', () => ({
  buildLiveVoicePromptSurface: (...args: unknown[]) => mockBuildLiveVoicePromptSurface(...args),
}));

vi.mock('../../services/voice/korevg/grok-llm-payload.js', () => ({
  buildGrokLlmVerbPayload: (...args: unknown[]) => mockBuildGrokLlmVerbPayload(...args),
}));

vi.mock('../../services/voice/korevg/realtime-llm-payload.js', () => ({
  buildRealtimeLlmVerbPayload: (...args: unknown[]) => mockBuildRealtimeLlmVerbPayload(...args),
}));

vi.mock('../../services/voice/korevg/realtime-tool-definitions.js', () => ({
  buildGoogleRealtimeToolDefinitions: (...args: unknown[]) =>
    mockBuildGoogleRealtimeToolDefinitions(...args),
  toRealtimeToolDefinitions: (...args: unknown[]) => mockToRealtimeToolDefinitions(...args),
}));

vi.mock('../../services/voice/korevg/s2s-google-event-handler.js', () => ({
  buildGoogleToolResponse: (...args: unknown[]) => mockBuildGoogleToolResponse(...args),
  buildOpenAIToolResponse: (...args: unknown[]) => mockBuildOpenAIToolResponse(...args),
}));

vi.mock('../../services/voice/korevg/s2s-llm-verb-builder.js', () => ({
  buildGoogleLlmVerb: (...args: unknown[]) => mockBuildGoogleLlmVerb(...args),
}));

import {
  buildKorevgGoogleInlineHandoffPayload,
  buildKorevgOpenAIHandoffCommands,
  buildKorevgRealtimeBootstrap,
  buildKorevgRealtimePromptState,
  buildKorevgRealtimeToolDispatchPlan,
  isSupportedKorevgRealtimeS2SProvider,
  resolveKorevgRealtimeProviderKind,
} from '../../services/voice/korevg/realtime-provider-adapter.js';

function makeAgentIR(name = 'travel_agent'): AgentIR {
  return {
    metadata: {
      name,
      version: '1.0.0',
      description: '',
      tags: [],
      source_hash: 'hash',
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
        turn_timeout: 30_000,
        total_timeout: 60_000,
        tool_timeout: 30_000,
      },
    },
  } as AgentIR;
}

function makeRuntimeSession(
  overrides: Partial<RuntimeSession> = {},
  sessionValues: Record<string, unknown> = {},
): RuntimeSession {
  return {
    id: overrides.id ?? 'voice-session-1',
    agentName: overrides.agentName ?? 'travel_agent',
    agentIR: overrides.agentIR ?? makeAgentIR(),
    compilationOutput: overrides.compilationOutput ?? {},
    conversationHistory: overrides.conversationHistory ?? [],
    state: overrides.state ?? {
      gatherProgress: {},
      context: {},
      conversationPhase: 'active',
    },
    data: overrides.data ?? {
      values: {
        session: sessionValues,
      },
      gatheredKeys: new Set<string>(),
    },
    executionTreeValues: overrides.executionTreeValues ?? {},
    isComplete: overrides.isComplete ?? false,
    isEscalated: overrides.isEscalated ?? false,
    transferInitiated: overrides.transferInitiated ?? false,
    escalationReason: overrides.escalationReason,
    handoffStack: overrides.handoffStack ?? [],
    delegateStack: overrides.delegateStack ?? [],
    currentFlowStep: overrides.currentFlowStep,
    waitingForInput: overrides.waitingForInput,
    tenantId: overrides.tenantId ?? 'tenant-1',
    projectId: overrides.projectId ?? 'project-1',
    userId: overrides.userId ?? 'user-1',
    createdAt: overrides.createdAt ?? new Date(),
    lastActivityAt: overrides.lastActivityAt ?? new Date(),
    threads: overrides.threads ?? [],
    activeThreadIndex: overrides.activeThreadIndex ?? 0,
    threadStack: overrides.threadStack ?? [],
    ...overrides,
  } as RuntimeSession;
}

function makeS2SConfig(overrides: S2SSessionConfig = {}): S2SSessionConfig {
  return {
    model: 'gpt-realtime',
    voice: 'alloy',
    temperature: 0.8,
    ...overrides,
  };
}

describe('korevg realtime provider adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildLiveVoicePromptSurface.mockReturnValue({
      profile: 'realtime',
      systemPrompt: 'Realtime system prompt',
      tools: [
        {
          name: 'lookup_trip',
          description: 'Find the itinerary',
          input_schema: {
            type: 'object',
            properties: {
              confirmation_code: { type: 'string' },
            },
            required: ['confirmation_code'],
          },
        },
      ],
      diagnostics: {
        profile: 'realtime',
        promptRefresh: 'supported',
        toolRefresh: 'supported',
        capabilityNotes: [],
        usingRuntimeSession: true,
        semanticConvergenceMode: 'off',
        semanticStrategy: 'legacy',
      },
    });
    mockToRealtimeToolDefinitions.mockReturnValue([
      {
        type: 'function',
        name: 'lookup_trip',
        description: 'Find the itinerary',
        parameters: {
          type: 'object',
          properties: {
            confirmation_code: { type: 'string' },
          },
          required: ['confirmation_code'],
        },
      },
    ]);
    mockBuildGoogleRealtimeToolDefinitions.mockReturnValue([
      {
        type: 'function',
        name: 'get_greeting',
        description: 'Return the active greeting',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    ]);
    mockBuildRealtimeLlmVerbPayload.mockReturnValue({
      verb: 'llm',
      vendor: 'openai',
      model: 'gpt-realtime',
    });
    mockBuildGrokLlmVerbPayload.mockReturnValue({
      verb: 'llm',
      vendor: 'openai',
      model: 'grok-realtime',
      llmOptions: {
        session_update: {},
        response_create: {},
      },
    });
    mockBuildGoogleLlmVerb.mockReturnValue({
      verb: 'llm',
      vendor: 'google',
      model: 'gemini-3.1-flash-live-preview',
    });
    mockBuildGoogleToolResponse.mockImplementation((toolCallId: string, payload: unknown) => ({
      provider: 'google',
      toolCallId,
      payload,
    }));
    mockBuildOpenAIToolResponse.mockImplementation((toolCallId: string, payload: unknown) => ({
      provider: 'openai',
      toolCallId,
      payload,
    }));
  });

  it('builds the google prompt state with the Gemini overlay and static google tool definitions', () => {
    const runtimeSession = makeRuntimeSession({}, { s2sModel: 'gemini-3.1-live' });
    const entryAgentIR = makeAgentIR();

    const result = buildKorevgRealtimePromptState({
      sessionId: runtimeSession.id,
      runtimeSession,
      entryAgentIR,
      s2sProvider: 's2s:google',
      includeConversationHistory: true,
    });

    expect(mockBuildLiveVoicePromptSurface).toHaveBeenCalledWith({
      sessionId: runtimeSession.id,
      agentIR: runtimeSession.agentIR,
      runtimeSession,
      preferredProfile: 'realtime',
      providerPromptOverlay: 'gemini_live',
      includeConversationHistory: true,
    });
    expect(mockBuildGoogleRealtimeToolDefinitions).toHaveBeenCalledWith(runtimeSession);
    expect(result.providerKind).toBe('google');
    expect(result.providerPromptOverlay).toBe('gemini_live');
    expect(result.instructions).toBe('Realtime system prompt');
    expect(result.tools).toEqual([
      {
        type: 'function',
        name: 'get_greeting',
        description: 'Return the active greeting',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    ]);
  });

  it('builds the openai bootstrap from the shared prompt surface and realtime tool definitions', () => {
    const runtimeSession = makeRuntimeSession({}, { s2sModel: 'gpt-realtime-1.5' });
    const entryAgentIR = makeAgentIR();

    const result = buildKorevgRealtimeBootstrap({
      sessionId: runtimeSession.id,
      runtimeSession,
      entryAgentIR,
      s2sProvider: 's2s:openai',
      s2sConfig: makeS2SConfig(),
      apiKey: 'test-api-key',
      greetingMessage: 'Welcome back',
    });

    expect(mockBuildRealtimeLlmVerbPayload).toHaveBeenCalledWith({
      apiKey: 'test-api-key',
      instructions: 'Realtime system prompt',
      s2sConfig: makeS2SConfig(),
      tools: [
        {
          type: 'function',
          name: 'lookup_trip',
          description: 'Find the itinerary',
          parameters: {
            type: 'object',
            properties: {
              confirmation_code: { type: 'string' },
            },
            required: ['confirmation_code'],
          },
        },
      ],
      greetingMessage: 'Welcome back',
    });
    expect(result.providerKind).toBe('openai');
    expect(result.providerPromptOverlay).toBe('openai_realtime');
    expect(result.llmVerb).toEqual({
      verb: 'llm',
      vendor: 'openai',
      model: 'gpt-realtime',
    });
  });

  it('passes Gemini activity detection settings into the google bootstrap verb', () => {
    const runtimeSession = makeRuntimeSession({}, { s2sModel: 'gemini-3.1-live' });
    const entryAgentIR = makeAgentIR();
    const s2sConfig = makeS2SConfig({
      provider: 's2s:google',
      model: 'gemini-3.1-live',
      voice: 'Puck',
      startSensitivity: 'START_SENSITIVITY_HIGH',
      endSensitivity: 'END_SENSITIVITY_LOW',
      prefixPadding: 250,
      silenceDuration: 900,
    });

    buildKorevgRealtimeBootstrap({
      sessionId: runtimeSession.id,
      runtimeSession,
      entryAgentIR,
      s2sProvider: 's2s:google',
      s2sConfig,
      apiKey: 'test-api-key',
    });

    expect(mockBuildGoogleLlmVerb).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-3.1-live',
        voice: 'Puck',
        startSensitivity: 'START_SENSITIVITY_HIGH',
        endSensitivity: 'END_SENSITIVITY_LOW',
        prefixPadding: 250,
        silenceDuration: 900,
      }),
    );
  });

  it('builds openai handoff refresh commands with conversation history in the prompt surface', () => {
    const runtimeSession = makeRuntimeSession();
    const entryAgentIR = makeAgentIR();

    const result = buildKorevgOpenAIHandoffCommands({
      sessionId: runtimeSession.id,
      runtimeSession,
      entryAgentIR,
      s2sProvider: 's2s:openai',
      voice: 'nova',
    });

    expect(mockBuildLiveVoicePromptSurface).toHaveBeenCalledWith(
      expect.objectContaining({
        includeConversationHistory: true,
        providerPromptOverlay: 'openai_realtime',
      }),
    );
    expect(result.commands).toEqual([
      {
        type: 'command',
        command: 'llm:update',
        data: {
          type: 'session.update',
          session: {
            instructions: 'Realtime system prompt',
            voice: 'nova',
            tools: [
              {
                type: 'function',
                name: 'lookup_trip',
                description: 'Find the itinerary',
                parameters: {
                  type: 'object',
                  properties: {
                    confirmation_code: { type: 'string' },
                  },
                  required: ['confirmation_code'],
                },
              },
            ],
            tool_choice: 'auto',
          },
        },
      },
    ]);
  });

  it('builds google inline handoff payloads with runtime instructions for immutable sessions', () => {
    const runtimeSession = makeRuntimeSession({}, { s2sModel: 'gemini-3.1-live' });
    const entryAgentIR = makeAgentIR();

    const result = buildKorevgGoogleInlineHandoffPayload({
      sessionId: runtimeSession.id,
      runtimeSession,
      entryAgentIR,
      s2sProvider: 's2s:google',
      activeAgentName: 'Billing_Agent',
    });

    expect(result.payload).toEqual({
      active_agent: 'Billing_Agent',
      continue_current_turn: true,
      runtime_instructions: 'Realtime system prompt',
    });
    expect(result.providerPromptOverlay).toBe('gemini_live');
  });

  it('builds provider-specific tool dispatch with deferred follow-up speech for openai-style sessions', () => {
    const result = buildKorevgRealtimeToolDispatchPlan({
      providerKind: 'openai',
      toolCallId: 'tool-call-1',
      payload: { success: true },
      actionToolSpeech: 'Transferred you to billing.',
      voice: 'alloy',
    });

    expect(result.deferImplicitFollowup).toBe(true);
    expect(result.toolOutputCommand).toEqual({
      type: 'command',
      command: 'llm:tool-output',
      tool_call_id: 'tool-call-1',
      data: {
        provider: 'openai',
        toolCallId: 'tool-call-1',
        payload: {
          success: true,
        },
        defer_response_create: true,
      },
    });
    expect(result.followupCommands).toEqual([
      {
        type: 'command',
        command: 'llm:update',
        data: {
          type: 'response.create',
          response: {
            modalities: ['text', 'audio'],
            instructions:
              'Respond to the caller with exactly this text and nothing else:\nTransferred you to billing.',
            voice: 'alloy',
          },
        },
      },
    ]);
  });

  it('can defer provider follow-up without replacement speech', () => {
    const result = buildKorevgRealtimeToolDispatchPlan({
      providerKind: 'grok',
      toolCallId: 'tool-call-1',
      payload: { success: true },
      deferImplicitFollowup: true,
      actionToolSpeech: null,
    });

    expect(result.deferImplicitFollowup).toBe(true);
    expect(result.toolOutputCommand).toEqual({
      type: 'command',
      command: 'llm:tool-output',
      tool_call_id: 'tool-call-1',
      data: {
        provider: 'openai',
        toolCallId: 'tool-call-1',
        payload: {
          success: true,
        },
        defer_response_create: true,
      },
    });
    expect(result.followupCommands).toEqual([]);
  });

  it('fails closed for unsupported KoreVG realtime S2S providers', () => {
    expect(isSupportedKorevgRealtimeS2SProvider('s2s:openai')).toBe(true);
    expect(isSupportedKorevgRealtimeS2SProvider('s2s:microsoft')).toBe(true);
    expect(isSupportedKorevgRealtimeS2SProvider('s2s:google')).toBe(true);
    expect(isSupportedKorevgRealtimeS2SProvider('s2s:grok')).toBe(true);
    expect(isSupportedKorevgRealtimeS2SProvider('s2s:deepgram')).toBe(false);

    expect(() => resolveKorevgRealtimeProviderKind({ s2sProvider: 's2s:deepgram' })).toThrow(
      'Unsupported KoreVG realtime S2S provider: s2s:deepgram',
    );
  });

  it('maps Azure OpenAI realtime to the OpenAI-compatible KoreVG prompt surface', () => {
    expect(resolveKorevgRealtimeProviderKind({ s2sProvider: 's2s:microsoft' })).toBe('openai');
  });
});

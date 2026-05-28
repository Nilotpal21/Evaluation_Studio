import { describe, expect, it } from 'vitest';
import type { AgentIR } from '@abl/compiler';
import type { RealtimeVoiceProviderCapabilityProfile } from '@abl/compiler/platform/llm/realtime/types.js';
import { buildCanonicalVoicePromptSurface } from '../../services/execution/prompt-builder.js';
import type { RuntimeSession } from '../../services/execution/types.js';
import {
  buildVoicePromptProfile,
  REALTIME_VOICE_TURN_TOOL_NAME,
  resolveVoicePromptProfile,
} from '../../services/voice/voice-prompt-profile.js';

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

function makeSession(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    id: 'voice-session-1',
    agentName: 'travel_agent',
    agentIR: null,
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
    ...overrides,
  } as RuntimeSession;
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
    on_start: {
      voice_config: {
        instructions: 'Sound reassuring and concise on live calls.',
      },
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

describe('voice-prompt-profile', () => {
  it('keeps pipeline packaging aligned with the canonical prompt surface', () => {
    const agentIR = makeIR();
    const runtimeSession = makeSession({ agentIR });
    const canonical = buildCanonicalVoicePromptSurface(runtimeSession);

    const profile = buildVoicePromptProfile({
      sessionId: runtimeSession.id,
      agentIR,
      runtimeSession,
      preferredProfile: 'pipeline',
    });

    expect(profile.profile).toBe('pipeline');
    expect(profile.systemPrompt).toBe(canonical.systemPrompt);
    expect(profile.tools).toEqual(canonical.tools);
    expect(profile.diagnostics).toMatchObject({
      profile: 'pipeline',
      promptRefresh: 'not_applicable',
      toolRefresh: 'not_applicable',
      usingRuntimeSession: true,
    });
  });

  it('wraps canonical prompt/tool inputs with realtime voice instructions and capability diagnostics', () => {
    const agentIR = makeIR();
    const runtimeSession = makeSession({ agentIR });
    const canonical = buildCanonicalVoicePromptSurface(runtimeSession);

    const profile = buildVoicePromptProfile({
      sessionId: runtimeSession.id,
      agentIR,
      runtimeSession,
      providerCapabilityProfile: OPENAI_REALTIME_CAPABILITIES,
    });

    expect(profile.profile).toBe('realtime');
    expect(profile.systemPrompt).toContain(canonical.systemPrompt);
    expect(profile.systemPrompt).toContain('## Realtime Voice Operating Mode');
    expect(profile.tools).toEqual(canonical.tools);
    expect(profile.diagnostics).toMatchObject({
      profile: 'realtime',
      providerType: 'openai_realtime',
      providerPromptOverlay: 'openai_realtime',
      promptRefresh: 'supported',
      toolRefresh: 'supported',
      usingRuntimeSession: true,
    });
  });

  it('can build a realtime prompt surface without an existing runtime session', () => {
    const agentIR = makeIR();

    const profile = buildVoicePromptProfile({
      sessionId: 'synthetic-voice-session',
      agentIR,
      providerCapabilityProfile: GEMINI_LIVE_CAPABILITIES,
    });

    expect(profile.profile).toBe('realtime');
    expect(profile.tools.map((tool) => tool.name)).toContain('lookup_trip');
    expect(profile.systemPrompt).toContain('calm travel specialist');
    expect(profile.systemPrompt).toContain('## Gemini Live Tool Result Contract');
    expect(profile.systemPrompt).toContain('runtime_instructions');
    expect(profile.diagnostics).toMatchObject({
      providerType: 'gemini_live',
      providerPromptOverlay: 'gemini_live',
      promptRefresh: 'immutable',
      toolRefresh: 'immutable',
      usingRuntimeSession: false,
    });
  });

  it('switches realtime voice into the coordinator-tool surface when semantic convergence is enabled', () => {
    const agentIR = makeIR();
    const runtimeSession = makeSession({ agentIR });

    const profile = buildVoicePromptProfile({
      sessionId: runtimeSession.id,
      agentIR,
      runtimeSession,
      providerCapabilityProfile: OPENAI_REALTIME_CAPABILITIES,
      semanticConvergencePlan: {
        family: 'sdk_voice_realtime',
        mode: 'enforce',
        strategy: 'coordinator_tool',
        providerType: 'openai_realtime',
        reason: 'enforce_coordinator_tool',
        notes: ['Coordinator tool is active for realtime semantic convergence.'],
      },
    });

    expect(profile.systemPrompt).toContain('## Canonical Voice Turn Tool');
    expect(profile.tools.map((tool) => tool.name)).toEqual([REALTIME_VOICE_TURN_TOOL_NAME]);
    expect(profile.diagnostics).toMatchObject({
      semanticConvergenceMode: 'enforce',
      semanticStrategy: 'coordinator_tool',
      semanticFamily: 'sdk_voice_realtime',
    });
  });

  it('derives the realtime profile when provider capabilities are present', () => {
    expect(
      resolveVoicePromptProfile({
        providerCapabilityProfile: GEMINI_LIVE_CAPABILITIES,
      }),
    ).toBe('realtime');

    expect(
      resolveVoicePromptProfile({
        preferredProfile: 'pipeline',
        providerCapabilityProfile: OPENAI_REALTIME_CAPABILITIES,
      }),
    ).toBe('pipeline');
  });
});

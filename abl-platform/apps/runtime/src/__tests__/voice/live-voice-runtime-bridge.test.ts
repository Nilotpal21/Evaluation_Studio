import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentIR } from '@abl/compiler/platform/ir/schema.js';
import type { RuntimeExecutor } from '../../services/runtime-executor.js';
import type { RuntimeSession } from '../../services/execution/types.js';

const mockBuildVoicePromptProfile = vi.fn();
const mockExecuteVoiceTurn = vi.fn();
const mockSerializeRealtimeVoiceTurnToolPayload = vi.fn();

vi.mock('../../services/voice/voice-prompt-profile.js', () => ({
  buildVoicePromptProfile: (...args: unknown[]) => mockBuildVoicePromptProfile(...args),
}));

vi.mock('../../services/voice/voice-turn-coordinator.js', () => ({
  executeVoiceTurn: (...args: unknown[]) => mockExecuteVoiceTurn(...args),
  serializeRealtimeVoiceTurnToolPayload: (...args: unknown[]) =>
    mockSerializeRealtimeVoiceTurnToolPayload(...args),
}));

import {
  buildLiveVoicePromptSurface,
  executeLiveVoiceSemanticTurn,
  executeLiveVoiceToolCall,
} from '../../services/voice/live-voice-runtime-bridge.js';

function makeAgentIR(name = 'voice-agent'): AgentIR {
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

function makeRuntimeSession(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    id: overrides.id ?? 'voice-session-1',
    agentName: overrides.agentName ?? 'voice-agent',
    agentIR: overrides.agentIR ?? makeAgentIR(),
    compilationOutput: overrides.compilationOutput ?? {},
    conversationHistory: overrides.conversationHistory ?? [],
    state: overrides.state ?? {
      gatherProgress: {},
      context: {},
      conversationPhase: 'active',
    },
    data: overrides.data ?? {
      values: {},
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

function makeRuntimeExecutor(overrides: Partial<RuntimeExecutor> = {}): RuntimeExecutor {
  return {
    executeRealtimeToolCall: vi.fn(),
    executeMessage: vi.fn(),
    getSession: vi.fn(),
    rehydrateSession: vi.fn(),
    ...overrides,
  } as RuntimeExecutor;
}

describe('live-voice-runtime-bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildVoicePromptProfile.mockReturnValue({
      profile: 'realtime',
      systemPrompt: 'Base prompt',
      tools: [{ name: 'handoff_to_sales', input_schema: { type: 'object', properties: {} } }],
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
    mockSerializeRealtimeVoiceTurnToolPayload.mockImplementation(
      (outcome: { responseText: string }) =>
        JSON.stringify({ response_text: outcome.responseText }),
    );
  });

  test('appends conversation history when building a live realtime prompt surface', () => {
    const runtimeSession = makeRuntimeSession({
      conversationHistory: [
        { role: 'user', content: 'Hello there' },
        { role: 'assistant', content: 'Hi, how can I help?' },
      ],
    });

    const result = buildLiveVoicePromptSurface({
      sessionId: runtimeSession.id,
      agentIR: runtimeSession.agentIR!,
      runtimeSession,
      preferredProfile: 'realtime',
      includeConversationHistory: true,
    });

    expect(mockBuildVoicePromptProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: runtimeSession.id,
        runtimeSession,
        preferredProfile: 'realtime',
      }),
    );
    expect(result.systemPrompt).toContain('Base prompt');
    expect(result.systemPrompt).toContain('## CONVERSATION HISTORY');
    expect(result.systemPrompt).toContain('User: Hello there');
    expect(result.systemPrompt).toContain('Assistant: Hi, how can I help?');
  });

  test('executes live voice tools through the scoped runtime path and syncs the active agent', async () => {
    const nextAgentIR = makeAgentIR('sales-agent');
    const runtimeSession = makeRuntimeSession();
    const runtimeExecutor = makeRuntimeExecutor({
      executeRealtimeToolCall: vi.fn(async () => ({
        result: { response: 'Transferred to sales' },
        activeAgentName: 'sales-agent',
        activeAgentIR: nextAgentIR,
      })),
      getSession: vi.fn(() => runtimeSession),
    });

    const result = await executeLiveVoiceToolCall({
      runtimeExecutor,
      runtimeSession,
      toolName: 'handoff_to_sales',
      input: { message: 'Need billing help' },
      tenantId: 'tenant-1',
      projectId: 'project-1',
    });

    expect(runtimeExecutor.executeRealtimeToolCall).toHaveBeenCalledWith(
      runtimeSession.id,
      'handoff_to_sales',
      { message: 'Need billing help' },
      undefined,
      {
        sessionLocator: {
          kind: 'production',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          sessionId: runtimeSession.id,
        },
      },
    );
    expect(result.rawResult).toEqual({ response: 'Transferred to sales' });
    expect(result.serializedResult).toBe(JSON.stringify({ response: 'Transferred to sales' }));
    expect(result.activeAgentName).toBe('sales-agent');
    expect(result.activeAgentIR).toBe(nextAgentIR);
    expect(runtimeSession.agentName).toBe('sales-agent');
    expect(runtimeSession.agentIR).toBe(nextAgentIR);
  });

  test('executes canonical live voice turns and returns the serialized coordinator payload', async () => {
    const runtimeSession = makeRuntimeSession();
    const runtimeExecutor = makeRuntimeExecutor({
      getSession: vi.fn(() => runtimeSession),
    });
    mockExecuteVoiceTurn.mockResolvedValue({
      outcome: {
        status: 'ok',
        responseText: 'Hello from the coordinator',
        usedFallback: false,
        diagnostics: [],
        action: { type: 'continue' },
      },
      runtimeSession,
      diagnostics: [],
    });

    const result = await executeLiveVoiceSemanticTurn({
      channelType: 'voice_realtime',
      runtimeExecutor,
      runtimeSession,
      utterance: 'Hi there',
      timeoutMs: 30_000,
      promptProfile: 'realtime',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      channelMetadata: {
        channel: 'voice_realtime',
        contentLength: 8,
      },
    });

    expect(mockExecuteVoiceTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: 'voice_realtime',
        sessionId: runtimeSession.id,
        utterance: 'Hi there',
        timeoutMs: 30_000,
        promptProfile: 'realtime',
        executeOptions: {
          sessionLocator: {
            kind: 'production',
            tenantId: 'tenant-1',
            projectId: 'project-1',
            sessionId: runtimeSession.id,
          },
          channelMetadata: {
            channel: 'voice_realtime',
            contentLength: 8,
          },
        },
      }),
    );
    expect(mockSerializeRealtimeVoiceTurnToolPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        responseText: 'Hello from the coordinator',
      }),
      { channelType: 'voice_realtime' },
    );
    expect(result.serializedResult).toBe(
      JSON.stringify({ response_text: 'Hello from the coordinator' }),
    );
    expect(result.activeAgentName).toBe(runtimeSession.agentName);
    expect(result.activeAgentIR).toBe(runtimeSession.agentIR);
  });
});

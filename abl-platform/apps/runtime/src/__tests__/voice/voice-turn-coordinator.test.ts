import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { RuntimeExecutor } from '../../services/runtime-executor.js';
import type { RuntimeSession } from '../../services/execution/types.js';

const mockEvaluateAuthPreflightFromIR = vi.fn();
const mockCreateTokenLookups = vi.fn(() => ({}));

vi.mock('../../services/auth-profile/auth-preflight.js', () => ({
  evaluateAuthPreflightFromIR: (...args: unknown[]) => mockEvaluateAuthPreflightFromIR(...args),
  createTokenLookups: (...args: unknown[]) => mockCreateTokenLookups(...args),
}));

import {
  executeVoiceTurn,
  serializeRealtimeVoiceTurnToolPayload,
} from '../../services/voice/voice-turn-coordinator.js';

function makeRuntimeSession(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    id: overrides.id ?? 'voice-session-1',
    agentName: overrides.agentName ?? 'voice-agent',
    agentIR: overrides.agentIR ?? null,
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
    projectId: overrides.projectId ?? 'proj-1',
    userId: overrides.userId ?? 'user-1',
    createdAt: overrides.createdAt ?? new Date(),
    lastActivityAt: overrides.lastActivityAt ?? new Date(),
    ...overrides,
  } as RuntimeSession;
}

function makeExecutor(overrides: Partial<RuntimeExecutor> = {}): RuntimeExecutor {
  return {
    executeMessage: vi.fn(),
    getSession: vi.fn(),
    rehydrateSession: vi.fn(),
    ...overrides,
  } as RuntimeExecutor;
}

describe('executeVoiceTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEvaluateAuthPreflightFromIR.mockResolvedValue(null);
  });

  test('coordinates canonical pipeline execution and preserves streamed chunks', async () => {
    const runtimeSession = makeRuntimeSession();
    const executor = makeExecutor({
      getSession: vi.fn((sessionId?: string) =>
        sessionId === runtimeSession.id ? runtimeSession : undefined,
      ),
      executeMessage: vi.fn(
        async (
          _sessionId: string,
          _userText: string,
          onChunk?: (chunk: string) => void,
          _onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
          _options?: Record<string, unknown>,
        ) => {
          onChunk?.('Hello ');
          onChunk?.('world');
          return {
            response: 'Hello world',
            action: { type: 'continue' },
            stateUpdates: {},
          };
        },
      ),
    });
    const onChunk = vi.fn();
    const onTraceEvent = vi.fn();

    const result = await executeVoiceTurn({
      channelType: 'voice_livekit',
      executor,
      sessionId: runtimeSession.id,
      utterance: 'Hello there',
      timeoutMs: 30_000,
      promptProfile: 'pipeline',
      onChunk,
      onTraceEvent,
      executeOptions: {
        channelMetadata: {
          channel: 'voice_livekit',
          contentLength: 11,
        },
      },
    });

    expect(executor.executeMessage).toHaveBeenCalledWith(
      runtimeSession.id,
      'Hello there',
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        channelMetadata: {
          channel: 'voice_livekit',
          contentLength: 11,
        },
      }),
    );
    expect(onChunk).toHaveBeenNthCalledWith(1, 'Hello ');
    expect(onChunk).toHaveBeenNthCalledWith(2, 'world');
    expect(result.outcome.status).toBe('ok');
    expect(result.outcome.responseText).toBe('Hello world');
    expect(result.executionResult).toEqual({
      response: 'Hello world',
      action: { type: 'continue' },
      stateUpdates: {},
    });
    expect(result.outcome.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'voice_turn_coordinator',
          code: 'VOICE_PROMPT_PROFILE_PIPELINE',
        }),
      ]),
    );
  });

  test('forwards non-durable interaction context hints to the executor', async () => {
    const runtimeSession = makeRuntimeSession();
    const executor = makeExecutor({
      getSession: vi.fn((sessionId?: string) =>
        sessionId === runtimeSession.id ? runtimeSession : undefined,
      ),
      executeMessage: vi.fn(async () => ({
        response: 'Hola',
        action: { type: 'continue' },
      })),
    });

    await executeVoiceTurn({
      channelType: 'korevg',
      executor,
      sessionId: runtimeSession.id,
      utterance: 'Hola',
      timeoutMs: 30_000,
      promptProfile: 'pipeline',
      executeOptions: {
        interactionContextHint: {
          language: 'es',
          locale: 'es-MX',
        },
      },
    });

    expect(executor.executeMessage).toHaveBeenCalledWith(
      runtimeSession.id,
      'Hola',
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        interactionContextHint: {
          language: 'es',
          locale: 'es-MX',
        },
      }),
    );
  });

  test('returns auth-required fallback without executing when preflight blocks', async () => {
    const runtimeSession = makeRuntimeSession();
    const executor = makeExecutor({
      getSession: vi.fn((sessionId?: string) =>
        sessionId === runtimeSession.id ? runtimeSession : undefined,
      ),
      executeMessage: vi.fn(),
    });
    mockEvaluateAuthPreflightFromIR.mockResolvedValue({
      pending: [
        {
          connector: 'google',
          authProfileRef: 'google-creds',
          connectionMode: 'per_user',
        },
      ],
      satisfied: [],
    });

    const result = await executeVoiceTurn({
      channelType: 'voice_twilio',
      executor,
      sessionId: runtimeSession.id,
      utterance: 'Book a flight',
      timeoutMs: 30_000,
      promptProfile: 'pipeline',
    });

    expect(executor.executeMessage).not.toHaveBeenCalled();
    expect(result.outcome.status).toBe('auth_required');
    expect(result.outcome.responseText).toContain("can't continue");
    expect(result.executionResult).toBeUndefined();
    expect(result.outcome.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'voice_turn_coordinator',
          code: 'VOICE_PROMPT_PROFILE_PIPELINE',
        }),
      ]),
    );
  });

  test('serializes canonical realtime tool payloads with response text and diagnostic codes', () => {
    expect(
      JSON.parse(
        serializeRealtimeVoiceTurnToolPayload(
          {
            status: 'ok',
            responseText: 'Hello **from the coordinator**',
            usedFallback: false,
            diagnostics: [
              {
                source: 'voice_turn_coordinator',
                category: 'voice_runtime',
                severity: 'info',
                code: 'VOICE_PROMPT_PROFILE_REALTIME',
                message: 'Coordinator in realtime mode.',
              },
            ],
            action: { type: 'continue' },
            voiceConfig: {
              instructions: 'Be warm',
              plain_text: 'Hello from the coordinator',
            },
          },
          {
            channelType: 'voice_realtime',
          },
        ),
      ),
    ).toEqual({
      response_text: 'Hello from the coordinator',
      status: 'ok',
      used_fallback: false,
      action_type: 'continue',
      diagnostic_codes: ['VOICE_PROMPT_PROFILE_REALTIME'],
      voice_config: {
        instructions: 'Be warm',
        plain_text: 'Hello from the coordinator',
      },
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_MAX_KOREVG_SESSIONS = 500;
const TEST_SESSION_NEW_TIMEOUT_MS = 25;

const mocks = vi.hoisted(() => {
  const mockResolveConnectionByIdUnsafe = vi.fn();
  const mockResolveChannelConnection = vi.fn();
  const mockCreateSessionFromResolved = vi.fn();
  const mockInitializeSession = vi.fn();
  const mockGetRuntimeExecutor = vi.fn();
  const mockDeploymentResolve = vi.fn();
  const mockGetSessionService = vi.fn(() => ({}));
  const mockExtractIngressToken = vi.fn();
  const mockTokensMatch = vi.fn();
  const mockResolveVoiceCredentials = vi.fn();
  const mockResolveVoiceMode = vi.fn();
  const mockResolveS2SCredentials = vi.fn();
  const mockCreateAndLinkDBSession = vi.fn();
  const mockResolveRequiredContactProductionScope = vi.fn();
  const mockResolveContactIdFromChannelIdentity = vi.fn();
  const mockLinkResolvedContactToSession = vi.fn();
  const mockSendGreeting = vi.fn(async () => undefined);
  const mockKorevgSessionCtor = vi.fn();
  const mockReplayBufferedMessage = vi.fn(async () => undefined);
  const mockTraceStoreAddEvent = vi.fn();
  const mockEmitTraceEventAsAnalytics = vi.fn();
  const mockBuildSystemPrompt = vi.fn(() => 'Updated system prompt');
  const mockBuildTools = vi.fn(() => [
    {
      name: 'handoff_to_Sales_Agent',
      description: 'Route to sales',
      input_schema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
        },
        required: ['message'],
      },
    },
  ]);
  const mockBuildLiveVoicePromptSurface = vi.fn();
  const mockExecuteLiveVoiceToolCall = vi.fn();
  const mockExecuteLiveVoiceSemanticTurn = vi.fn();
  const mockBuildGoogleRealtimeToolDefinitions = vi.fn();
  const mockToRealtimeToolDefinitions = vi.fn();
  const mockPersistMessage = vi.fn();
  const mockPersistTurnMetrics = vi.fn();
  const mockBuildRealtimeLlmVerbPayload = vi.fn(
    ({ s2sConfig }: { s2sConfig?: { voice?: string } } = {}) => {
      const voice = s2sConfig?.voice || 'marin';
      return {
        verb: 'llm',
        model: 'gpt-realtime',
        auth: { apiKey: 'test-key' },
        events: ['session.updated'],
        llmOptions: {
          response_create: {
            modalities: ['text', 'audio'],
            instructions: 'Updated system prompt',
            voice,
          },
          session_update: {
            voice,
            turn_detection: {
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 700,
            },
          },
        },
      };
    },
  );
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  return {
    mockResolveConnectionByIdUnsafe,
    mockResolveChannelConnection,
    mockCreateSessionFromResolved,
    mockInitializeSession,
    mockGetRuntimeExecutor,
    mockDeploymentResolve,
    mockGetSessionService,
    mockExtractIngressToken,
    mockTokensMatch,
    mockResolveVoiceCredentials,
    mockResolveVoiceMode,
    mockResolveS2SCredentials,
    mockCreateAndLinkDBSession,
    mockResolveRequiredContactProductionScope,
    mockResolveContactIdFromChannelIdentity,
    mockLinkResolvedContactToSession,
    mockSendGreeting,
    mockKorevgSessionCtor,
    mockReplayBufferedMessage,
    mockTraceStoreAddEvent,
    mockEmitTraceEventAsAnalytics,
    mockBuildSystemPrompt,
    mockBuildTools,
    mockBuildLiveVoicePromptSurface,
    mockExecuteLiveVoiceToolCall,
    mockExecuteLiveVoiceSemanticTurn,
    mockBuildGoogleRealtimeToolDefinitions,
    mockToRealtimeToolDefinitions,
    mockPersistMessage,
    mockPersistTurnMetrics,
    mockBuildRealtimeLlmVerbPayload,
    mockLogger,
  };
});

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => mocks.mockLogger),
}));

vi.mock('../../channels/connection-resolver.js', () => ({
  resolveConnectionByIdUnsafe: (...args: unknown[]) =>
    mocks.mockResolveConnectionByIdUnsafe(...args),
  resolveChannelConnection: (...args: unknown[]) => mocks.mockResolveChannelConnection(...args),
}));

vi.mock('../../services/runtime-executor.js', () => ({
  getRuntimeExecutor: (...args: unknown[]) => mocks.mockGetRuntimeExecutor(...args),
}));

vi.mock('../../services/deployment-resolver.js', () => ({
  DeploymentResolver: class MockDeploymentResolver {
    resolve = (...args: unknown[]) => mocks.mockDeploymentResolve(...args);
  },
}));

vi.mock('../../repos/project-repo.js', () => ({
  loadConfigVariablesMap: vi.fn(async () => ({})),
}));

vi.mock('../../services/session/session-service.js', () => ({
  getSessionService: (...args: unknown[]) => mocks.mockGetSessionService(...args),
}));

vi.mock('@agent-platform/shared-kernel/security', () => ({
  extractIngressToken: (...args: unknown[]) => mocks.mockExtractIngressToken(...args),
  tokensMatch: (...args: unknown[]) => mocks.mockTokensMatch(...args),
}));

vi.mock('../../services/voice/voice-service-factory.js', () => ({
  VoiceServiceFactory: class MockVoiceServiceFactory {
    resolveVoiceCredentials = (...args: unknown[]) => mocks.mockResolveVoiceCredentials(...args);
    resolveVoiceMode = (...args: unknown[]) => mocks.mockResolveVoiceMode(...args);
    resolveS2SCredentials = (...args: unknown[]) => mocks.mockResolveS2SCredentials(...args);
  },
}));

vi.mock('@agent-platform/shared/encryption', () => ({
  getEncryptionService: vi.fn(() => null),
}));

vi.mock('../../services/voice/korevg/korevg-session.js', () => ({
  KorevgSession: class MockKorevgSession {
    close = vi.fn();
    sendGreeting = (...args: unknown[]) => mocks.mockSendGreeting(...args);
    replayBufferedMessage = (...args: unknown[]) => mocks.mockReplayBufferedMessage(...args);

    constructor(...args: unknown[]) {
      mocks.mockKorevgSessionCtor(...args);
    }
  },
}));

vi.mock('../../services/voice/voice-config-resolver.js', () => ({
  resolveVoiceConfig: vi.fn(() => null),
}));

vi.mock('../../services/trace-store.js', () => ({
  getTraceStore: vi.fn(() => ({
    addEvent: mocks.mockTraceStoreAddEvent,
  })),
}));

vi.mock('../../services/eventstore-singleton.js', () => ({
  getEventStore: vi.fn(() => ({
    emitter: {},
  })),
}));

vi.mock('@abl/eventstore/migration', () => ({
  emitTraceEventAsAnalytics: (...args: unknown[]) => mocks.mockEmitTraceEventAsAnalytics(...args),
}));

vi.mock('../../services/execution/prompt-builder.js', () => ({
  buildSystemPrompt: (...args: unknown[]) => mocks.mockBuildSystemPrompt(...args),
  buildTools: (...args: unknown[]) => mocks.mockBuildTools(...args),
}));

vi.mock('../../services/voice/live-voice-runtime-bridge.js', () => ({
  buildLiveVoicePromptSurface: (...args: unknown[]) =>
    mocks.mockBuildLiveVoicePromptSurface(...args),
  executeLiveVoiceToolCall: (...args: unknown[]) => mocks.mockExecuteLiveVoiceToolCall(...args),
  executeLiveVoiceSemanticTurn: (...args: unknown[]) =>
    mocks.mockExecuteLiveVoiceSemanticTurn(...args),
}));

vi.mock('../../services/voice/s2s/S2SSessionBridge.js', () => ({
  S2SSessionBridge: class MockS2SSessionBridge {},
}));

vi.mock('../../services/voice/korevg/realtime-llm-payload.js', () => ({
  buildRealtimeLlmVerbPayload: (...args: unknown[]) =>
    mocks.mockBuildRealtimeLlmVerbPayload(...args),
}));

vi.mock('../../services/voice/korevg/realtime-tool-definitions.js', () => ({
  buildGoogleRealtimeToolDefinitions: (...args: unknown[]) =>
    mocks.mockBuildGoogleRealtimeToolDefinitions(...args),
  toRealtimeToolDefinitions: (...args: unknown[]) => mocks.mockToRealtimeToolDefinitions(...args),
}));

vi.mock('../../channels/pipeline/session-factory.js', () => ({
  createAndLinkDBSession: (...args: unknown[]) => mocks.mockCreateAndLinkDBSession(...args),
}));

vi.mock('../../services/session/production-contact-scope.js', () => ({
  resolveRequiredContactProductionScope: (...args: unknown[]) =>
    mocks.mockResolveRequiredContactProductionScope(...args),
}));

vi.mock('../../services/identity/channel-contact-linking.js', () => ({
  resolveContactIdFromChannelIdentity: (...args: unknown[]) =>
    mocks.mockResolveContactIdFromChannelIdentity(...args),
  linkResolvedContactToSession: (...args: unknown[]) =>
    mocks.mockLinkResolvedContactToSession(...args),
}));

vi.mock('../../services/message-persistence-queue.js', () => ({
  persistMessage: (...args: unknown[]) => mocks.mockPersistMessage(...args),
  persistMessageRecord: vi.fn(async () => undefined),
  persistTurnMetrics: (...args: unknown[]) => mocks.mockPersistTurnMetrics(...args),
}));

import {
  KorevgRouter,
  applyKorevgVoiceSessionAliases,
  buildKorevgCallerContext,
} from '../../services/voice/korevg/korevg-router.js';
import {
  interruptRealtimeVoiceSession,
  resetRealtimeInterruptionCoordinatorForTests,
} from '../../services/voice/realtime-interruption-coordinator.js';

type MessageHandler = (payload: Buffer) => void | Promise<void>;
type CloseHandler = (code: number, reason: Buffer) => void;

function createMockWebSocket() {
  const messageHandlers = new Set<MessageHandler>();
  const closeHandlers = new Set<CloseHandler>();

  const ws = {
    on: vi.fn((event: string, handler: MessageHandler | CloseHandler) => {
      if (event === 'message') {
        messageHandlers.add(handler as MessageHandler);
      } else if (event === 'close') {
        closeHandlers.add(handler as CloseHandler);
      }
      return ws;
    }),
    off: vi.fn((event: string, handler: MessageHandler | CloseHandler) => {
      if (event === 'message') {
        messageHandlers.delete(handler as MessageHandler);
      } else if (event === 'close') {
        closeHandlers.delete(handler as CloseHandler);
      }
      return ws;
    }),
    send: vi.fn(),
    close: vi.fn(),
    emitMessage(payload: unknown) {
      const buffer = Buffer.isBuffer(payload)
        ? payload
        : Buffer.from(JSON.stringify(payload), 'utf8');
      for (const handler of [...messageHandlers]) {
        void handler(buffer);
      }
    },
    emitClose(code = 1000, reason = 'done') {
      const buffer = Buffer.from(reason, 'utf8');
      for (const handler of [...closeHandlers]) {
        handler(code, buffer);
      }
    },
  };

  return ws;
}

function createConnection(
  overrides: Partial<{
    tenantId: string;
    projectId: string;
    deploymentId: string;
    agentId: string;
    environment: string;
    config: Record<string, unknown>;
  }> = {},
) {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    deploymentId: 'deployment-1',
    agentId: 'agent-supervisor',
    environment: 'prod',
    config: {
      inboundAuthToken: 'voice-secret',
      mode: 'pipeline',
    },
    ...overrides,
  };
}

function createResolvedAgent(
  overrides: Partial<{
    entryAgent: string;
    agents: Record<string, any>;
  }> = {},
) {
  return {
    entryAgent: 'supervisor',
    agents: {
      supervisor: {
        metadata: { name: 'Supervisor' },
        identity: { system_prompt: { template: 'You are helpful.' } },
        tools: [],
      },
    },
    ...overrides,
  };
}

function createRuntimeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'runtime-session-1',
    agentName: 'supervisor',
    agentIR: {},
    conversationHistory: [],
    data: { values: {} },
    state: {
      gatherProgress: {},
      context: {},
      conversationPhase: 'active',
    },
    handoffStack: [],
    delegateStack: [],
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    _effectiveConfig: {},
    toolExecutor: { execute: vi.fn() },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error('Timed out waiting for KoreVG realtime bootstrap condition');
}

async function flushAsync() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function expectedRealtimeAssistantMetadata() {
  return {
    isLlmGenerated: true,
    responseProvenance: {
      schemaVersion: 1,
      kind: 'llm',
      disclaimerRequired: true,
      usedLlmInternally: true,
    },
  };
}

describe('KorevgRouter', () => {
  const routers = new Set<KorevgRouter>();
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'test';
    resetRealtimeInterruptionCoordinatorForTests();

    mocks.mockGetRuntimeExecutor.mockReturnValue({
      createSessionFromResolved: mocks.mockCreateSessionFromResolved,
      initializeSession: mocks.mockInitializeSession,
      executeRealtimeToolCall: vi.fn(),
    });
    mocks.mockCreateSessionFromResolved.mockReturnValue(createRuntimeSession());
    mocks.mockResolveConnectionByIdUnsafe.mockResolvedValue(createConnection());
    mocks.mockResolveChannelConnection.mockResolvedValue(null);
    mocks.mockDeploymentResolve.mockResolvedValue(createResolvedAgent());
    mocks.mockExtractIngressToken.mockReturnValue('voice-secret');
    mocks.mockTokensMatch.mockReturnValue(true);
    mocks.mockResolveVoiceCredentials.mockResolvedValue({
      stt: { apiKey: 'deepgram-key', model: 'nova-3' },
      tts: { apiKey: 'elevenlabs-key', voiceId: 'Bella' },
    });
    mocks.mockResolveVoiceMode.mockResolvedValue('pipeline');
    mocks.mockResolveS2SCredentials.mockResolvedValue({
      credentials: { apiKey: 's2s-key', config: {} },
    });
    mocks.mockCreateAndLinkDBSession.mockResolvedValue({
      dbSessionId: 'db-session-1',
    });
    mocks.mockResolveRequiredContactProductionScope.mockImplementation(
      async ({
        tenantId,
        projectId,
        sessionId,
        channelId,
        environment,
        source,
        authType,
        callerContext,
      }: {
        tenantId?: string;
        projectId?: string;
        sessionId?: string;
        channelId?: string;
        environment?: string;
        source: string;
        authType: string;
        callerContext?: Record<string, unknown>;
      }) => {
        const resolvedCallerContext = {
          ...(callerContext || {}),
          tenantId: tenantId ?? 'tenant-1',
          channel: (callerContext?.channel as string | undefined) ?? 'korevg',
          channelId: channelId ?? (callerContext?.channelId as string | undefined) ?? 'conn-1',
          anonymousId:
            (callerContext?.anonymousId as string | undefined) ??
            `korevg:${sessionId ?? 'runtime-session-1'}`,
          identityTier: (callerContext?.identityTier as number | undefined) ?? 0,
          verificationMethod: (callerContext?.verificationMethod as string | undefined) ?? 'none',
          contactId: (callerContext?.contactId as string | undefined) ?? 'contact-korevg-scope-1',
        };

        return {
          callerContext: resolvedCallerContext,
          scope: {
            kind: 'production' as const,
            tenantId: tenantId ?? 'tenant-1',
            projectId: projectId ?? 'project-1',
            sessionId: sessionId ?? 'runtime-session-1',
            channelId: channelId ?? 'conn-1',
            environment: environment ?? 'prod',
            source,
            authType,
            traceId: 'trace-korevg',
            actor: {
              kind: 'contact' as const,
              contactId: resolvedCallerContext.contactId,
            },
            subject: {
              kind: 'contact' as const,
              contactId: resolvedCallerContext.contactId,
            },
            identityEvidence: {
              identityTier: resolvedCallerContext.identityTier,
              verificationMethod: resolvedCallerContext.verificationMethod,
              artifacts: [],
            },
            callerContext: resolvedCallerContext,
          },
        };
      },
    );
    mocks.mockResolveContactIdFromChannelIdentity.mockResolvedValue(undefined);
    mocks.mockLinkResolvedContactToSession.mockResolvedValue(undefined);
    mocks.mockSendGreeting.mockResolvedValue(undefined);
    mocks.mockInitializeSession.mockResolvedValue({
      response: '',
      action: { type: 'continue' },
    });
    mocks.mockToRealtimeToolDefinitions.mockImplementation(
      (
        tools: Array<{
          name: string;
          description?: string;
          input_schema?: {
            type?: 'object';
            properties?: Record<string, unknown>;
            required?: string[];
          };
        }>,
      ) =>
        tools.map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description || '',
          parameters: {
            type: 'object',
            properties: tool.input_schema?.properties || {},
            required: tool.input_schema?.required || [],
          },
        })),
    );
    mocks.mockBuildGoogleRealtimeToolDefinitions.mockImplementation((runtimeSession: unknown) =>
      mocks.mockToRealtimeToolDefinitions(mocks.mockBuildTools(runtimeSession)),
    );
    mocks.mockBuildLiveVoicePromptSurface.mockImplementation(
      ({
        runtimeSession,
      }: {
        runtimeSession?: { agentName?: string; agentIR?: unknown } | null;
      }) => ({
        profile: 'realtime',
        systemPrompt: mocks.mockBuildSystemPrompt(runtimeSession),
        tools: mocks.mockBuildTools(runtimeSession),
        diagnostics: {
          profile: 'realtime',
          promptRefresh: 'supported',
          toolRefresh: 'supported',
          capabilityNotes: [],
          usingRuntimeSession: true,
          semanticConvergenceMode: 'off',
          semanticStrategy: 'legacy',
        },
      }),
    );
    mocks.mockExecuteLiveVoiceToolCall.mockImplementation(
      async ({
        runtimeExecutor,
        runtimeSession,
        toolName,
        input,
        tenantId,
        projectId,
        onTraceEvent,
      }: {
        runtimeExecutor: {
          executeRealtimeToolCall: (
            sessionId: string,
            toolName: string,
            input: Record<string, unknown>,
            onTraceEvent?: (...args: unknown[]) => unknown,
            options?: { sessionLocator?: Record<string, unknown> },
          ) => Promise<{
            result: unknown;
            activeAgentName: string;
            activeAgentIR: unknown;
          }>;
        };
        runtimeSession: { id: string; agentName?: string; agentIR?: unknown };
        toolName: string;
        input: Record<string, unknown>;
        tenantId?: string;
        projectId?: string;
        onTraceEvent?: (...args: unknown[]) => unknown;
      }) => {
        const toolExecution = await runtimeExecutor.executeRealtimeToolCall(
          runtimeSession.id,
          toolName,
          input,
          onTraceEvent,
          {
            sessionLocator: {
              kind: 'production',
              tenantId,
              projectId,
              sessionId: runtimeSession.id,
            },
          },
        );

        runtimeSession.agentName = toolExecution.activeAgentName;
        runtimeSession.agentIR = toolExecution.activeAgentIR;

        return {
          rawResult: toolExecution.result,
          serializedResult:
            typeof toolExecution.result === 'string'
              ? toolExecution.result
              : JSON.stringify(toolExecution.result ?? null),
          activeAgentName: toolExecution.activeAgentName,
          activeAgentIR: toolExecution.activeAgentIR,
          runtimeSession,
        };
      },
    );
    mocks.mockExecuteLiveVoiceSemanticTurn.mockImplementation(
      async ({
        runtimeSession,
        utterance,
      }: {
        runtimeSession: { agentName?: string; agentIR?: unknown };
        utterance: string;
      }) => ({
        outcome: {
          status: 'ok',
          responseText: utterance,
          usedFallback: false,
          diagnostics: [],
          action: { type: 'continue' },
        },
        executionResult: {
          response: utterance,
          action: { type: 'continue' },
        },
        serializedResult: JSON.stringify({ response_text: utterance }),
        activeAgentName: runtimeSession.agentName || 'unknown',
        activeAgentIR: runtimeSession.agentIR || null,
        runtimeSession,
      }),
    );
  });

  afterEach(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    for (const router of routers) {
      await router.shutdown();
    }
    routers.clear();
  });

  function createRouter() {
    const router = new KorevgRouter({
      baseUrl: 'http://runtime.local',
      sessionNewTimeoutMs: TEST_SESSION_NEW_TIMEOUT_MS,
    });
    routers.add(router);
    return router;
  }

  it('builds a weak provider-verified caller context by default for telephony caller metadata', () => {
    const callerContext = buildKorevgCallerContext({
      tenantId: 'tenant-1',
      channelId: 'conn-1',
      caller: '+15550001',
      connectionConfig: {},
    });

    expect(callerContext).toMatchObject({
      tenantId: 'tenant-1',
      channel: 'korevg',
      channelId: 'conn-1',
      anonymousId: '+15550001',
      identityTier: 1,
      verificationMethod: 'provider',
      channelArtifactType: 'caller_id',
    });
    expect(callerContext.channelArtifact).toMatch(/^[0-9a-f]{64}$/);
  });

  it('promotes telephony caller metadata to tier 2 when the connection is configured as strong provider verification', () => {
    const callerContext = buildKorevgCallerContext({
      tenantId: 'tenant-1',
      channelId: 'conn-1',
      caller: '+15550001',
      connectionConfig: {
        identityVerification: {
          providerVerificationStrength: 'strong',
        },
      },
    });

    expect(callerContext).toMatchObject({
      tenantId: 'tenant-1',
      channel: 'korevg',
      channelId: 'conn-1',
      anonymousId: '+15550001',
      identityTier: 2,
      verificationMethod: 'provider',
      channelArtifactType: 'caller_id',
    });
  });

  it('seeds KoreVG caller aliases without overwriting authored session values', () => {
    const runtimeSession = createRuntimeSession({
      id: 'runtime-session-alias',
      callerContext: {
        anonymousId: '+15550001',
        sessionPrincipalId: '+15550001',
      },
      data: {
        values: {
          caller_ani: '+15559999',
          session: {
            calledNumber: '+15550002',
          },
        },
      },
    }) as any;
    runtimeSession.threads = [
      {
        data: {
          values: {
            session: {
              calledNumber: '+15550003',
            },
          },
        },
      },
    ];

    applyKorevgVoiceSessionAliases(runtimeSession);

    expect(runtimeSession.data.values).toMatchObject({
      caller_ani: '+15559999',
      dnis: '+15550002',
      session_id: 'runtime-session-alias',
    });
    expect(runtimeSession.threads[0].data.values).toMatchObject({
      caller_ani: '+15550001',
      dnis: '+15550003',
      session_id: 'runtime-session-alias',
    });
  });

  it('does not seed caller_ani from a call SID placeholder before KoreVG sends caller number', () => {
    const runtimeSession = createRuntimeSession({
      id: 'runtime-session-placeholder',
      callerContext: {
        anonymousId: '273b8fb8-9e85-470d-a3d8-cd2dcfc8a3fd',
        sessionPrincipalId: '273b8fb8-9e85-470d-a3d8-cd2dcfc8a3fd',
      },
      data: {
        values: {
          session: {
            calledNumber: '+15550002',
          },
        },
      },
    }) as any;

    applyKorevgVoiceSessionAliases(runtimeSession);

    expect(runtimeSession.data.values.caller_ani).toBeUndefined();
    expect(runtimeSession.data.values).toMatchObject({
      dnis: '+15550002',
      session_id: 'runtime-session-placeholder',
    });
  });

  it('replaces a non-phone caller_ani placeholder when KoreVG later sends a caller number', () => {
    const runtimeSession = createRuntimeSession({
      id: 'runtime-session-replace-placeholder',
      callerContext: {
        anonymousId: '+13214713835',
        sessionPrincipalId: '+13214713835',
      },
      data: {
        values: {
          caller_ani: '273b8fb8-9e85-470d-a3d8-cd2dcfc8a3fd',
          session: {
            calledNumber: '+15550002',
          },
        },
      },
    }) as any;

    applyKorevgVoiceSessionAliases(runtimeSession);

    expect(runtimeSession.data.values).toMatchObject({
      caller_ani: '+13214713835',
      dnis: '+15550002',
      session_id: 'runtime-session-replace-placeholder',
    });
  });

  it('falls back safely when KoreVG caller alias inputs are malformed', () => {
    const runtimeSession = createRuntimeSession({
      callerContext: {
        anonymousId: { value: '+15550001' },
      },
      data: {
        values: {
          session: 'not-an-object',
        },
      },
    }) as any;

    applyKorevgVoiceSessionAliases(runtimeSession, undefined);

    expect(runtimeSession.data.values).toEqual({
      session: 'not-an-object',
      session_id: 'runtime-session-1',
    });
  });

  it('rejects malformed Korevg websocket URLs', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();

    await (router as any).handleConnection(ws, { url: '/ws/not-korevg/conn-1' });

    expect(ws.close).toHaveBeenCalledWith(1008, 'Invalid URL format');
  });

  it('rejects new calls when the router is already at capacity', async () => {
    const router = createRouter();
    const sessions = new Map<string, { close: () => void }>();
    for (let i = 0; i < TEST_MAX_KOREVG_SESSIONS; i += 1) {
      sessions.set(`session-${i}`, { close: vi.fn() });
    }
    (router as any).sessions = sessions;

    const ws = createMockWebSocket();

    await (router as any).handleConnection(ws, { url: '/ws/korevg/conn-1' });

    expect(ws.close).toHaveBeenCalledWith(1008, 'Server at capacity');
    expect(mocks.mockResolveConnectionByIdUnsafe).not.toHaveBeenCalled();
  });

  it('rejects calls when no Korevg channel connection can be resolved', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    mocks.mockResolveConnectionByIdUnsafe.mockResolvedValue(null);
    mocks.mockResolveChannelConnection.mockResolvedValue(null);

    await (router as any).handleConnection(ws, { url: '/ws/korevg/missing-conn' });

    expect(ws.close).toHaveBeenCalledWith(1008, 'Channel not configured');
  });

  it('requires the configured ingress token when the connection is protected', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    mocks.mockExtractIngressToken.mockReturnValue(null);

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1',
      headers: {},
    });

    expect(ws.close).toHaveBeenCalledWith(1008, 'Authentication required');
  });

  it('rejects Korevg calls with an invalid ingress token', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    mocks.mockExtractIngressToken.mockReturnValue('wrong-token');
    mocks.mockTokensMatch.mockReturnValue(false);

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?token=wrong-token',
      headers: {},
    });

    expect(ws.close).toHaveBeenCalledWith(1008, 'Unauthorized request');
  });

  it('fails fast when deployment resolution does not produce an entry agent IR', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    mocks.mockDeploymentResolve.mockResolvedValue(
      createResolvedAgent({
        agents: {},
      }),
    );

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor',
      headers: {},
    });

    expect(ws.close).toHaveBeenCalledWith(1011, 'Agent configuration error');
  });

  it('downgrades realtime bootstrap to pipeline when no explicit s2s provider is configured', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const runtimeSession = createRuntimeSession();
    mocks.mockResolveVoiceMode.mockResolvedValue('realtime');
    mocks.mockCreateSessionFromResolved.mockReturnValue(runtimeSession);

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor',
      headers: {},
    });

    expect(mocks.mockResolveS2SCredentials).not.toHaveBeenCalled();
    expect(mocks.mockKorevgSessionCtor).toHaveBeenCalledTimes(1);
    expect(runtimeSession.data.values.session).toMatchObject({
      channel: 'voice',
      voiceMode: 'pipeline',
    });
    expect((runtimeSession.data.values.session as Record<string, unknown>)?.s2sProvider).toBe(
      undefined,
    );
    expect(ws.close).not.toHaveBeenCalledWith(1011, 'S2S credentials not configured');
  });

  it('bootstraps pipeline calls from session:new and sends the greeting after answering', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const connectionPromise = deferred<ReturnType<typeof createConnection>>();
    const resolved = createResolvedAgent();
    const runtimeSession = createRuntimeSession();

    mocks.mockDeploymentResolve.mockResolvedValue(resolved);
    mocks.mockCreateSessionFromResolved.mockReturnValue(runtimeSession);
    mocks.mockResolveConnectionByIdUnsafe.mockReturnValue(connectionPromise.promise);

    const setupPromise = (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor&caller=%2B15550001&called=%2B15550002',
      headers: {},
    });

    ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-1',
      call_sid: 'call-1',
      data: {
        from: '+15550001',
        to: '+15550002',
      },
    });

    connectionPromise.resolve(createConnection());
    await setupPromise;

    expect(mocks.mockCreateSessionFromResolved).toHaveBeenCalledWith(
      resolved,
      expect.objectContaining({
        channelType: 'voice',
        deploymentId: 'deployment-1',
        scope: expect.objectContaining({
          kind: 'production',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          sessionId: expect.any(String),
          source: 'korevg_voice',
          authType: 'korevg_ws',
          callerContext: expect.objectContaining({
            tenantId: 'tenant-1',
            channel: 'korevg',
            channelId: 'conn-1',
            anonymousId: '+15550001',
            identityTier: 1,
            verificationMethod: 'provider',
            channelArtifactType: 'caller_id',
          }),
        }),
      }),
    );
    expect(mocks.mockKorevgSessionCtor).toHaveBeenCalledTimes(1);
    expect(mocks.mockKorevgSessionCtor).toHaveBeenCalledWith(
      ws,
      expect.objectContaining({
        projectId: 'project-1',
        agentId: 'agent-supervisor',
        deploymentId: 'deployment-1',
        sessionId: 'runtime-session-1',
        callSid: expect.any(String),
        streamId: 'conn-1',
        caller: '+15550001',
        called: '+15550002',
        sttModel: 'nova-3',
        tenantId: 'tenant-1',
        agentName: 'supervisor',
        callerContext: expect.objectContaining({
          tenantId: 'tenant-1',
          channel: 'korevg',
          channelId: 'conn-1',
          anonymousId: '+15550001',
          identityTier: 1,
          verificationMethod: 'provider',
          channelArtifactType: 'caller_id',
        }),
        callInfo: expect.objectContaining({
          callSid: 'call-1',
          from: '+15550001',
          to: '+15550002',
        }),
      }),
      expect.objectContaining({
        createSessionFromResolved: mocks.mockCreateSessionFromResolved,
      }),
    );
    expect(mocks.mockSendGreeting).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'ack',
        msgid: 'msg-1',
        data: [{ verb: 'answer' }],
      }),
    );
    expect(ws.send.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.mockSendGreeting.mock.invocationCallOrder[0],
    );
    expect(router.getSessionCount()).toBe(1);
  });

  it('extracts ANI from KoreVG SIP headers when session:new has no top-level from', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const connectionPromise = deferred<ReturnType<typeof createConnection>>();
    const resolved = createResolvedAgent();
    const runtimeSession = createRuntimeSession();

    mocks.mockDeploymentResolve.mockResolvedValue(resolved);
    mocks.mockCreateSessionFromResolved.mockReturnValue(runtimeSession);
    mocks.mockResolveConnectionByIdUnsafe.mockReturnValue(connectionPromise.promise);

    const setupPromise = (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor&callSid=call-1&calledNumber=%2B15550002',
      headers: {},
    });

    ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-sip-ani',
      call_sid: 'call-1',
      data: {
        sip: {
          headers: {
            from: '<sip:+15550001@23.21.52.56:5060>;tag=abc',
            to: '<sip:+15550002@23.21.52.56:5060>',
            'call-id': 'sip-call-id-1',
            'user-agent': 'Twilio Gateway',
          },
        },
      },
    });

    connectionPromise.resolve(createConnection());
    await setupPromise;

    expect(mocks.mockCreateSessionFromResolved).toHaveBeenCalledWith(
      resolved,
      expect.objectContaining({
        scope: expect.objectContaining({
          callerContext: expect.objectContaining({
            anonymousId: '+15550001',
            identityTier: 1,
            verificationMethod: 'provider',
            channelArtifactType: 'caller_id',
          }),
        }),
      }),
    );
    expect(mocks.mockKorevgSessionCtor).toHaveBeenCalledWith(
      ws,
      expect.objectContaining({
        caller: '+15550001',
        called: '+15550002',
        callerContext: expect.objectContaining({
          anonymousId: '+15550001',
          identityTier: 1,
          verificationMethod: 'provider',
          channelArtifactType: 'caller_id',
        }),
        callInfo: expect.objectContaining({
          callSid: 'call-1',
          from: '+15550001',
          to: '+15550002',
          sipFrom: '<sip:+15550001@23.21.52.56:5060>;tag=abc',
        }),
      }),
      expect.any(Object),
    );
    expect(runtimeSession.data.values.session).toEqual(
      expect.objectContaining({
        anonymousId: '+15550001',
        sessionPrincipalId: '+15550001',
        calledNumber: '+15550002',
        rawCallerId: '<sip:+15550001@23.21.52.56:5060>;tag=abc',
        rawFrom: '<sip:+15550001@23.21.52.56:5060>;tag=abc',
        rawCalledNumber: '<sip:+15550002@23.21.52.56:5060>',
        rawTo: '<sip:+15550002@23.21.52.56:5060>',
      }),
    );
  });

  it('falls back safely when KoreVG session:new caller metadata is malformed', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const connectionPromise = deferred<ReturnType<typeof createConnection>>();
    const resolved = createResolvedAgent();
    const runtimeSession = createRuntimeSession();

    mocks.mockDeploymentResolve.mockResolvedValue(resolved);
    mocks.mockCreateSessionFromResolved.mockReturnValue(runtimeSession);
    mocks.mockResolveConnectionByIdUnsafe.mockReturnValue(connectionPromise.promise);

    const setupPromise = (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor&callSid=call-1&caller=%2B15550009&calledNumber=%2B15550010',
      headers: {},
    });

    ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-malformed-ani',
      call_sid: 'call-1',
      data: {
        from: { displayName: 'not-a-phone' },
        to: ['also-not-a-phone'],
        sip: 'not-an-object',
        sip_headers: 'not-an-object',
      },
    });

    connectionPromise.resolve(createConnection());
    await setupPromise;

    expect(mocks.mockCreateSessionFromResolved).toHaveBeenCalledWith(
      resolved,
      expect.objectContaining({
        scope: expect.objectContaining({
          callerContext: expect.objectContaining({
            anonymousId: '+15550009',
            identityTier: 1,
            verificationMethod: 'provider',
            channelArtifactType: 'caller_id',
          }),
        }),
      }),
    );
    expect(mocks.mockKorevgSessionCtor).toHaveBeenCalledWith(
      ws,
      expect.objectContaining({
        caller: '+15550009',
        called: '+15550010',
        callerContext: expect.objectContaining({
          anonymousId: '+15550009',
          identityTier: 1,
          verificationMethod: 'provider',
          channelArtifactType: 'caller_id',
        }),
        callInfo: expect.objectContaining({
          callSid: 'call-1',
          from: undefined,
          to: undefined,
        }),
      }),
      expect.any(Object),
    );
    expect(runtimeSession.data.values.session).toEqual(
      expect.objectContaining({
        anonymousId: '+15550009',
        sessionPrincipalId: '+15550009',
        calledNumber: '+15550010',
        rawCallerId: '+15550009',
        rawFrom: '+15550009',
        rawCalledNumber: '+15550010',
        rawTo: '+15550010',
      }),
    );
  });

  it('buffers pipeline session:new during bootstrap handoff and replays later non-bootstrap messages once', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const runtimeSession = createRuntimeSession();
    const voiceMode = deferred<'pipeline'>();

    mocks.mockCreateSessionFromResolved.mockReturnValue(runtimeSession);
    mocks.mockResolveVoiceMode.mockReturnValueOnce(voiceMode.promise);

    const setupPromise = (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor&caller=%2B15550001&called=%2B15550002',
      headers: {},
    });

    await waitForCondition(() => mocks.mockResolveVoiceMode.mock.calls.length > 0, 15000);

    ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-handoff',
      call_sid: 'call-handoff',
      data: {
        from: '+15550001',
        to: '+15550002',
      },
    });
    ws.emitMessage({
      type: 'verb:status',
      msgid: 'msg-status',
      call_sid: 'call-handoff',
      data: { event: 'start-playback' },
    });

    voiceMode.resolve('pipeline');
    await setupPromise;

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'ack',
        msgid: 'msg-handoff',
        data: [{ verb: 'answer' }],
      }),
    );
    expect(mocks.mockSendGreeting).toHaveBeenCalledTimes(1);
    expect(mocks.mockReplayBufferedMessage).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mocks.mockReplayBufferedMessage.mock.calls[0][0].toString())).toMatchObject({
      type: 'verb:status',
      msgid: 'msg-status',
    });
  });

  it('sends the realtime answer + pause + llm ack only after session:new arrives', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const runtimeSession = createRuntimeSession();

    mocks.mockResolveVoiceMode.mockResolvedValue('realtime');
    mocks.mockCreateSessionFromResolved.mockReturnValue(runtimeSession);
    mocks.mockResolveConnectionByIdUnsafe.mockResolvedValue(
      createConnection({
        config: {
          inboundAuthToken: 'voice-secret',
          mode: 'realtime',
          s2sProvider: 's2s:openai',
          s2sModel: 'gpt-realtime',
          s2sVoice: 'cedar',
        },
      }),
    );

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor',
      headers: {},
    });

    expect(mocks.mockKorevgSessionCtor).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();

    ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-rt',
      call_sid: 'call-rt',
      data: {
        from: '+15550003',
        to: '+15550004',
      },
    });

    const realtimeAck = JSON.parse(ws.send.mock.calls[0][0]);
    expect(realtimeAck).toMatchObject({
      type: 'ack',
      msgid: 'msg-rt',
      data: [
        { verb: 'answer' },
        { verb: 'pause', length: 1 },
        {
          verb: 'llm',
          model: 'gpt-realtime',
          auth: { apiKey: 'test-key' },
          events: ['session.updated'],
          llmOptions: {
            session_update: {
              voice: 'cedar',
              turn_detection: {
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 700,
              },
            },
          },
        },
      ],
    });
    await waitForCondition(() => mocks.mockCreateAndLinkDBSession.mock.calls.length > 0);
    expect(mocks.mockCreateAndLinkDBSession).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        sessionId: 'runtime-session-1',
        anonymousId: '+15550003',
        identityTier: 1,
        verificationMethod: 'provider',
        channelId: 'conn-1',
        channelArtifactType: 'caller_id',
        callerNumber: '+15550003',
      }),
    );
    expect(runtimeSession.data.values.session).toEqual(
      expect.objectContaining({
        anonymousId: '+15550003',
        sessionPrincipalId: '+15550003',
      }),
    );
    expect(router.getSessionCount()).toBe(1);
  });

  it('exposes KoreVG caller ANI aliases before the first realtime prompt is built', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const runtimeSession = createRuntimeSession();

    mocks.mockResolveVoiceMode.mockResolvedValue('realtime');
    mocks.mockCreateSessionFromResolved.mockReturnValue(runtimeSession);
    mocks.mockResolveConnectionByIdUnsafe.mockResolvedValue(
      createConnection({
        config: {
          inboundAuthToken: 'voice-secret',
          mode: 'realtime',
          s2sProvider: 's2s:openai',
          s2sModel: 'gpt-realtime',
          s2sVoice: 'cedar',
        },
      }),
    );

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor',
      headers: {},
    });

    ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-rt-ani-context',
      call_sid: 'call-rt-ani-context',
      data: {
        from: '+13214713835',
        to: '+19014607132',
      },
    });

    await waitForCondition(() => mocks.mockBuildLiveVoicePromptSurface.mock.calls.length > 0);

    expect(mocks.mockBuildLiveVoicePromptSurface).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeSession: expect.objectContaining({
          data: expect.objectContaining({
            values: expect.objectContaining({
              caller_ani: '+13214713835',
              dnis: '+19014607132',
              session_id: 'runtime-session-1',
              session: expect.objectContaining({
                anonymousId: '+13214713835',
                sessionPrincipalId: '+13214713835',
                calledNumber: '+19014607132',
              }),
            }),
          }),
        }),
      }),
    );
    expect(runtimeSession.data.values.caller_ani).toBe('+13214713835');
    expect(runtimeSession.data.values.dnis).toBe('+19014607132');
    expect(runtimeSession.data.values.session_id).toBe('runtime-session-1');
  });

  it('preserves KoreVG caller ANI aliases in realtime handoff prompt refreshes', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const runtimeSession = createRuntimeSession({ agentName: 'CignaRouter' });
    const executeRealtimeToolCall = vi.fn().mockImplementation(async () => {
      runtimeSession.agentName = 'CAIAuth_Specialist';
      runtimeSession.agentIR = { metadata: { name: 'CAIAuth_Specialist' } };
      runtimeSession.data = {
        values: {
          handoff_from: 'CignaRouter',
          session: {
            channel: 'voice',
          },
        },
        gatheredKeys: new Set(),
      };
      runtimeSession.threads = [
        {
          data: runtimeSession.data,
        },
      ];

      return {
        result: { success: true },
        activeAgentName: 'CAIAuth_Specialist',
        activeAgentIR: runtimeSession.agentIR,
      };
    });

    mocks.mockResolveVoiceMode.mockResolvedValue('realtime');
    mocks.mockCreateSessionFromResolved.mockReturnValue(runtimeSession);
    mocks.mockGetRuntimeExecutor.mockReturnValue({
      createSessionFromResolved: mocks.mockCreateSessionFromResolved,
      executeRealtimeToolCall,
    });
    mocks.mockResolveConnectionByIdUnsafe.mockResolvedValue(
      createConnection({
        config: {
          inboundAuthToken: 'voice-secret',
          mode: 'realtime',
          s2sProvider: 's2s:openai',
          s2sModel: 'gpt-realtime',
          s2sVoice: 'cedar',
        },
      }),
    );

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-CignaRouter',
      headers: {},
    });

    ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-rt-handoff-ani',
      call_sid: 'call-rt-handoff-ani',
      data: {
        from: '+13214713835',
        to: '+19014607132',
      },
    });
    ws.emitMessage({
      type: 'llm:event',
      msgid: 'msg-rt-handoff-args',
      data: {
        type: 'response.function_call_arguments.done',
        call_id: 'call-handoff-ani',
        arguments: '{"reason":"auth required","message":"check my prescription"}',
      },
    });
    ws.emitMessage({
      type: 'llm:tool-call',
      msgid: 'msg-rt-handoff-tool',
      data: {
        name: 'handoff_to_CAIAuth_Specialist',
        call_id: 'call-handoff-ani',
        arguments: '{}',
      },
    });

    await waitForCondition(
      () =>
        executeRealtimeToolCall.mock.calls.length > 0 &&
        mocks.mockBuildLiveVoicePromptSurface.mock.calls.length >= 3,
    );
    await flushAsync();

    expect(runtimeSession.data.values.caller_ani).toBe('+13214713835');
    expect(runtimeSession.data.values.dnis).toBe('+19014607132');
    expect(runtimeSession.data.values.session_id).toBe('runtime-session-1');
    expect(mocks.mockBuildLiveVoicePromptSurface).toHaveBeenLastCalledWith(
      expect.objectContaining({
        runtimeSession: expect.objectContaining({
          agentName: 'CAIAuth_Specialist',
          data: expect.objectContaining({
            values: expect.objectContaining({
              caller_ani: '+13214713835',
              dnis: '+19014607132',
            }),
          }),
        }),
      }),
    );
  });

  it('buffers realtime session:new during bootstrap handoff and sends one initial ack', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const voiceMode = deferred<'realtime'>();

    mocks.mockResolveVoiceMode.mockReturnValueOnce(voiceMode.promise);
    mocks.mockResolveConnectionByIdUnsafe.mockResolvedValue(
      createConnection({
        config: {
          inboundAuthToken: 'voice-secret',
          mode: 'realtime',
          s2sProvider: 's2s:openai',
          s2sModel: 'gpt-realtime',
          s2sVoice: 'cedar',
        },
      }),
    );

    const setupPromise = (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor',
      headers: {},
    });

    await waitForCondition(() => mocks.mockResolveVoiceMode.mock.calls.length > 0, 15000);

    ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-rt-handoff',
      call_sid: 'call-rt-handoff',
      data: {
        from: '+15550003',
        to: '+15550004',
      },
    });

    voiceMode.resolve('realtime');
    await setupPromise;

    const initialAcks = ws.send.mock.calls
      .map(([payload]) => JSON.parse(payload))
      .filter((payload) => payload.type === 'ack' && payload.msgid === 'msg-rt-handoff');
    expect(initialAcks).toHaveLength(1);
    expect(initialAcks[0].data).toEqual(
      expect.arrayContaining([expect.objectContaining({ verb: 'answer' })]),
    );
    expect(router.getSessionCount()).toBe(1);
  });

  it('feeds shared prompt-builder instructions into realtime S2S bootstrap payloads', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const runtimeSession = createRuntimeSession({
      agentIR: {
        identity: {
          goal: 'Route callers quickly.',
          persona: 'You are a calm voice concierge.',
          limitations: ['Never promise unavailable bookings.'],
        },
      },
    });

    mocks.mockResolveVoiceMode.mockResolvedValue('realtime');
    mocks.mockResolveConnectionByIdUnsafe.mockResolvedValue(
      createConnection({
        config: {
          inboundAuthToken: 'voice-secret',
          mode: 'realtime',
          s2sProvider: 's2s:openai',
          s2sModel: 'gpt-realtime',
        },
      }),
    );
    mocks.mockCreateSessionFromResolved.mockReturnValue(runtimeSession);

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor',
      headers: {},
    });

    await ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-rt-shared-prompt',
      call_sid: 'call-rt-shared-prompt',
      data: {
        from: '+15550013',
        to: '+15550014',
      },
    });

    expect(mocks.mockBuildSystemPrompt).toHaveBeenCalledWith(runtimeSession);
    expect(mocks.mockBuildRealtimeLlmVerbPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        instructions: 'Updated system prompt',
      }),
    );
    expect(mocks.mockLogger.debug).toHaveBeenCalledWith(
      '[S2S] Built initial realtime instructions from shared prompt builder',
      expect.objectContaining({
        instructionsLength: 'Updated system prompt'.length,
        hasRemainingTemplates: false,
      }),
    );
  });

  it('links a resolved contact when realtime KoreVG bootstrap resolves one', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();

    mocks.mockResolveVoiceMode.mockResolvedValue('realtime');
    mocks.mockResolveConnectionByIdUnsafe.mockResolvedValue(
      createConnection({
        config: {
          inboundAuthToken: 'voice-secret',
          mode: 'realtime',
          s2sProvider: 's2s:openai',
          s2sModel: 'gpt-realtime',
        },
      }),
    );
    mocks.mockResolveContactIdFromChannelIdentity.mockResolvedValue('contact-korevg-1');

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor',
      headers: {},
    });

    ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-rt-contact',
      call_sid: 'call-rt-contact',
      data: {
        from: '+15550003',
        to: '+15550004',
      },
    });

    await waitForCondition(() => mocks.mockCreateAndLinkDBSession.mock.calls.length > 0);
    expect(mocks.mockCreateAndLinkDBSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'runtime-session-1',
        contactId: 'contact-korevg-1',
      }),
    );
    expect(mocks.mockLinkResolvedContactToSession).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        channelType: 'korevg',
        channelId: 'conn-1',
        sessionId: 'runtime-session-1',
        contactId: 'contact-korevg-1',
      }),
    );
  });

  it('executes OpenAI realtime handoff tool calls without deferring the silent follow-up', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const runtimeSession = createRuntimeSession({ agentName: 'supervisor' });
    const executeRealtimeToolCall = vi.fn().mockResolvedValue({
      result: {
        success: true,
        response: "I'm transferring you to Sales Agent now.",
      },
      activeAgentName: 'Sales_Agent',
      activeAgentIR: { id: 'sales-agent-ir' },
    });
    mocks.mockBuildTools
      .mockReturnValueOnce([
        {
          name: 'handoff_to_Sales_Agent',
          description: 'Route to sales',
          input_schema: {
            type: 'object',
            properties: {
              message: { type: 'string' },
            },
            required: ['message'],
          },
        },
      ])
      .mockReturnValueOnce([
        {
          name: '__return_to_parent__',
          description: 'Return to your supervisor',
          input_schema: {
            type: 'object',
            properties: {
              reason: { type: 'string' },
              message: { type: 'string' },
            },
            required: ['reason', 'message'],
          },
        },
        {
          name: 'handoff_to_Sales_Agent',
          description: 'Route to sales',
          input_schema: {
            type: 'object',
            properties: {
              message: { type: 'string' },
            },
            required: ['message'],
          },
        },
      ]);

    mocks.mockResolveVoiceMode.mockResolvedValue('realtime');
    mocks.mockResolveConnectionByIdUnsafe.mockResolvedValue(
      createConnection({
        config: {
          inboundAuthToken: 'voice-secret',
          mode: 'realtime',
          s2sProvider: 's2s:openai',
          s2sModel: 'gpt-realtime',
        },
      }),
    );
    mocks.mockGetRuntimeExecutor.mockReturnValue({
      createSessionFromResolved: mocks.mockCreateSessionFromResolved,
      executeRealtimeToolCall,
    });
    mocks.mockCreateSessionFromResolved.mockReturnValue(runtimeSession);

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor',
      headers: {},
    });

    ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-rt',
      call_sid: 'call-rt',
      data: {
        from: '+15550003',
        to: '+15550004',
      },
    });

    ws.emitMessage({
      type: 'llm:event',
      msgid: 'msg-args',
      data: {
        type: 'response.function_call_arguments.done',
        call_id: 'call-123',
        arguments: '{"message":"book a hotel"}',
      },
    });

    ws.emitMessage({
      type: 'llm:tool-call',
      msgid: 'msg-tool',
      data: {
        name: 'handoff_to_Sales_Agent',
        call_id: 'call-123',
        arguments: '{}',
      },
    });

    await flushAsync();

    expect(executeRealtimeToolCall).toHaveBeenCalledWith(
      'runtime-session-1',
      'handoff_to_Sales_Agent',
      { message: 'book a hotel' },
      expect.any(Function),
      expect.objectContaining({
        sessionLocator: expect.objectContaining({
          kind: 'production',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          sessionId: 'runtime-session-1',
        }),
      }),
    );

    expect(runtimeSession.agentName).toBe('Sales_Agent');
    expect(runtimeSession.agentIR).toEqual({ id: 'sales-agent-ir' });

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'ack', msgid: 'msg-tool' }));
    const handoffSessionUpdate = ws.send.mock.calls
      .map(([payload]) => JSON.parse(payload as string))
      .find(
        (payload) =>
          payload?.type === 'command' &&
          payload?.command === 'llm:update' &&
          payload?.data?.type === 'session.update',
      );
    expect(handoffSessionUpdate).toEqual(
      expect.objectContaining({
        type: 'command',
        command: 'llm:update',
        data: {
          type: 'session.update',
          session: expect.objectContaining({
            instructions: 'Updated system prompt',
            tools: expect.arrayContaining([
              {
                type: 'function',
                name: 'handoff_to_Sales_Agent',
                description: 'Route to sales',
                parameters: {
                  type: 'object',
                  properties: {
                    message: { type: 'string' },
                  },
                  required: ['message'],
                },
              },
            ]),
            tool_choice: 'auto',
          }),
        },
      }),
    );
    const handoffToolOutput = ws.send.mock.calls
      .map(([payload]) => JSON.parse(payload as string))
      .find(
        (payload) =>
          payload?.type === 'command' &&
          payload?.command === 'llm:tool-output' &&
          payload?.tool_call_id === 'call-123',
      );
    expect(handoffToolOutput).toEqual(
      expect.objectContaining({
        type: 'command',
        command: 'llm:tool-output',
        tool_call_id: 'call-123',
        data: {
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: 'call-123',
            output: JSON.stringify({ success: true }),
          },
        },
      }),
    );
    expect(handoffToolOutput?.data).not.toHaveProperty('defer_response_create');
    const handoffResponseCreate = ws.send.mock.calls
      .map(([payload]) => JSON.parse(payload as string))
      .find(
        (payload) =>
          payload?.type === 'command' &&
          payload?.command === 'llm:update' &&
          payload?.data?.type === 'response.create',
      );
    expect(handoffResponseCreate).toBeUndefined();
  });

  it('updates OpenAI realtime live session back to the supervisor after return-to-parent', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const runtimeSession = createRuntimeSession({ agentName: 'supervisor' });
    const executeRealtimeToolCall = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          success: true,
          response: "I'm transferring you to Sales Agent now.",
        },
        activeAgentName: 'Sales_Agent',
        activeAgentIR: { id: 'sales-agent-ir' },
      })
      .mockResolvedValueOnce({
        result: 'Back with the supervisor.',
        activeAgentName: 'supervisor',
        activeAgentIR: { id: 'supervisor-ir' },
      });

    mocks.mockBuildSystemPrompt.mockImplementation((session?: { agentName?: string }) =>
      session?.agentName === 'Sales_Agent'
        ? 'Sales agent realtime prompt'
        : 'Supervisor realtime prompt',
    );
    mocks.mockBuildTools.mockImplementation((session?: { agentName?: string }) =>
      session?.agentName === 'Sales_Agent'
        ? [
            {
              name: '__return_to_parent__',
              description: 'Return to your supervisor',
              input_schema: {
                type: 'object',
                properties: {
                  reason: { type: 'string' },
                  message: { type: 'string' },
                },
                required: ['reason', 'message'],
              },
            },
          ]
        : [
            {
              name: 'handoff_to_Sales_Agent',
              description: 'Route to sales',
              input_schema: {
                type: 'object',
                properties: {
                  message: { type: 'string' },
                },
                required: ['message'],
              },
            },
          ],
    );
    mocks.mockResolveVoiceMode.mockResolvedValue('realtime');
    mocks.mockResolveConnectionByIdUnsafe.mockResolvedValue(
      createConnection({
        config: {
          inboundAuthToken: 'voice-secret',
          mode: 'realtime',
          s2sProvider: 's2s:openai',
          s2sModel: 'gpt-realtime',
        },
      }),
    );
    mocks.mockGetRuntimeExecutor.mockReturnValue({
      createSessionFromResolved: mocks.mockCreateSessionFromResolved,
      executeRealtimeToolCall,
    });
    mocks.mockCreateSessionFromResolved.mockReturnValue(runtimeSession);

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor',
      headers: {},
    });

    ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-rt',
      call_sid: 'call-rt',
      data: {
        from: '+15550003',
        to: '+15550004',
      },
    });

    ws.emitMessage({
      type: 'llm:event',
      msgid: 'msg-handoff-args',
      data: {
        type: 'response.function_call_arguments.done',
        call_id: 'call-handoff',
        arguments: '{"message":"book a hotel"}',
      },
    });

    ws.emitMessage({
      type: 'llm:tool-call',
      msgid: 'msg-handoff-tool',
      data: {
        name: 'handoff_to_Sales_Agent',
        call_id: 'call-handoff',
        arguments: '{}',
      },
    });

    await flushAsync();

    ws.emitMessage({
      type: 'llm:event',
      msgid: 'msg-return-args',
      data: {
        type: 'response.function_call_arguments.done',
        call_id: 'call-return',
        arguments: '{"reason":"done","message":"continue from supervisor"}',
      },
    });

    ws.emitMessage({
      type: 'llm:tool-call',
      msgid: 'msg-return-tool',
      data: {
        name: '__return_to_parent__',
        call_id: 'call-return',
        arguments: '{}',
      },
    });

    await flushAsync();

    expect(executeRealtimeToolCall).toHaveBeenNthCalledWith(
      1,
      'runtime-session-1',
      'handoff_to_Sales_Agent',
      { message: 'book a hotel' },
      expect.any(Function),
      expect.any(Object),
    );
    expect(executeRealtimeToolCall).toHaveBeenNthCalledWith(
      2,
      'runtime-session-1',
      '__return_to_parent__',
      { reason: 'done', message: 'continue from supervisor' },
      expect.any(Function),
      expect.any(Object),
    );
    expect(runtimeSession.agentName).toBe('supervisor');
    expect(runtimeSession.agentIR).toEqual({ id: 'supervisor-ir' });

    const sessionUpdates = ws.send.mock.calls
      .map(([payload]) => JSON.parse(payload as string))
      .filter(
        (payload) =>
          payload?.type === 'command' &&
          payload?.command === 'llm:update' &&
          payload?.data?.type === 'session.update',
      );
    expect(sessionUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            session: expect.objectContaining({
              instructions: 'Sales agent realtime prompt',
              tools: expect.arrayContaining([
                expect.objectContaining({ name: '__return_to_parent__' }),
              ]),
            }),
          }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            session: expect.objectContaining({
              instructions: 'Supervisor realtime prompt',
              tools: expect.arrayContaining([
                expect.objectContaining({ name: 'handoff_to_Sales_Agent' }),
              ]),
            }),
          }),
        }),
      ]),
    );
  });

  it('sends the S2S realtime ack for OpenAI bootstrap without waiting on runtime session prime', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const runtimeSession = createRuntimeSession({ initialized: false });

    mocks.mockResolveVoiceMode.mockResolvedValue('realtime');
    mocks.mockResolveConnectionByIdUnsafe.mockResolvedValue(
      createConnection({
        config: {
          inboundAuthToken: 'voice-secret',
          mode: 'realtime',
          s2sProvider: 's2s:openai',
          s2sModel: 'gpt-realtime',
        },
      }),
    );
    mocks.mockCreateSessionFromResolved.mockReturnValue(runtimeSession);

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor',
      headers: {},
    });

    ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-prime-openai',
      call_sid: 'call-prime-openai',
      data: {
        from: '+15550003',
        to: '+15550004',
      },
    });

    await waitForCondition(() => ws.send.mock.calls.length > 0);

    const bootstrapAck = JSON.parse(ws.send.mock.calls[0][0]);
    expect(bootstrapAck).toMatchObject({
      type: 'ack',
      msgid: 'msg-prime-openai',
    });
    expect(bootstrapAck.data[2].events).toContain('session.updated');
    expect(bootstrapAck.data[2].llmOptions.response_create).toMatchObject({
      modalities: ['text', 'audio'],
      instructions: 'Updated system prompt',
      voice: 'marin',
    });
    ws.emitMessage({
      type: 'llm:event',
      msgid: 'msg-openai-event',
      data: {
        type: 'response.created',
      },
    });

    await flushAsync();
    expect(mocks.mockInitializeSession).not.toHaveBeenCalled();
    expect(ws.send.mock.calls).toHaveLength(2);
    expect(JSON.parse(ws.send.mock.calls[1][0])).toMatchObject({
      type: 'ack',
      msgid: 'msg-openai-event',
    });
  });

  it('registers OpenAI realtime sessions with the shared interruption coordinator', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const runtimeSession = createRuntimeSession({ agentName: 'supervisor' });

    mocks.mockResolveVoiceMode.mockResolvedValue('realtime');
    mocks.mockResolveConnectionByIdUnsafe.mockResolvedValue(
      createConnection({
        config: {
          inboundAuthToken: 'voice-secret',
          mode: 'realtime',
          s2sProvider: 's2s:openai',
          s2sModel: 'gpt-realtime',
        },
      }),
    );
    mocks.mockGetRuntimeExecutor.mockReturnValue({
      createSessionFromResolved: mocks.mockCreateSessionFromResolved,
      executeRealtimeToolCall: vi.fn(),
    });
    mocks.mockCreateSessionFromResolved.mockReturnValue(runtimeSession);

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor',
      headers: {},
    });

    ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-rt-int',
      call_sid: 'call-rt-int',
      data: {
        from: '+15550100',
        to: '+15550101',
      },
    });

    await flushAsync();
    ws.send.mockClear();

    expect(
      interruptRealtimeVoiceSession('runtime-session-1', {
        tenantId: 'tenant-1',
        reason: 'typed_interrupt',
      }),
    ).toEqual({
      interrupted: 1,
      acknowledgements: 0,
    });

    expect(ws.send).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({
        type: 'command',
        command: 'tts:clear',
      }),
    );
    expect(ws.send).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({
        type: 'command',
        command: 'llm:update',
        data: {
          type: 'response.cancel',
        },
      }),
    );

    ws.emitClose();

    expect(
      interruptRealtimeVoiceSession('runtime-session-1', {
        tenantId: 'tenant-1',
        reason: 'typed_interrupt',
      }),
    ).toEqual({
      interrupted: 0,
      acknowledgements: 0,
    });
  });

  it('waits for the runtime session prime before sending Google START_SESSION', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const initGate = deferred<{
      response: string;
      action: { type: 'continue' };
    }>();
    const runtimeSession = createRuntimeSession({ initialized: false });

    mocks.mockResolveVoiceMode.mockResolvedValue('realtime');
    mocks.mockResolveConnectionByIdUnsafe.mockResolvedValue(
      createConnection({
        config: {
          inboundAuthToken: 'voice-secret',
          mode: 'realtime',
          s2sProvider: 's2s:google',
          s2sModel: 'gemini-live-2.5-flash-preview',
        },
      }),
    );
    mocks.mockCreateSessionFromResolved.mockReturnValue(runtimeSession);
    mocks.mockInitializeSession.mockImplementation(async () => {
      const result = await initGate.promise;
      runtimeSession.initialized = true;
      return result;
    });

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor',
      headers: {},
    });

    ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-prime-google',
      call_sid: 'call-prime-google',
      data: {
        from: '+15550003',
        to: '+15550004',
      },
    });

    await waitForCondition(() => ws.send.mock.calls.length > 0);

    ws.emitMessage({
      type: 'llm:event',
      msgid: 'msg-google-event',
      data: {
        type: 'session.connected',
      },
    });

    await flushAsync();
    expect(
      ws.send.mock.calls.some((call) => {
        const payload = JSON.parse(call[0]);
        return (
          payload?.command === 'llm:update' &&
          payload?.data?.realtimeInput?.text === 'START_SESSION'
        );
      }),
    ).toBe(false);

    initGate.resolve({
      response: '',
      action: { type: 'continue' },
    });

    await waitForCondition(() =>
      ws.send.mock.calls.some((call) => {
        const payload = JSON.parse(call[0]);
        return (
          payload?.command === 'llm:update' &&
          payload?.data?.realtimeInput?.text === 'START_SESSION'
        );
      }),
    );
  });

  it('returns the initialized greeting for Google after runtime session prime', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const runtimeSession = createRuntimeSession({
      initialized: false,
      agentIR: {
        messages: {
          welcome: 'Thank you for calling Spectrum. How can I assist you today?',
        },
      },
    });

    mocks.mockResolveVoiceMode.mockResolvedValue('realtime');
    mocks.mockResolveConnectionByIdUnsafe.mockResolvedValue(
      createConnection({
        config: {
          inboundAuthToken: 'voice-secret',
          mode: 'realtime',
          s2sProvider: 's2s:google',
          s2sModel: 'gemini-live-2.5-flash-preview',
        },
      }),
    );
    mocks.mockCreateSessionFromResolved.mockReturnValue(runtimeSession);
    mocks.mockInitializeSession.mockImplementation(async () => {
      runtimeSession.initialized = true;
      return {
        response: 'Welcome back. I have your details ready and can help with your appointment.',
        action: { type: 'continue' },
      };
    });

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor',
      headers: {},
    });

    ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-google-greeting',
      call_sid: 'call-google-greeting',
      data: {
        from: '+15550003',
        to: '+15550004',
      },
    });

    await waitForCondition(() => ws.send.mock.calls.length > 0);
    ws.emitMessage({
      type: 'llm:event',
      msgid: 'msg-google-greeting-connected',
      data: {
        type: 'session.connected',
      },
    });

    await waitForCondition(() =>
      ws.send.mock.calls.some((call) => {
        const payload = JSON.parse(call[0]);
        return (
          payload?.command === 'llm:update' &&
          payload?.data?.realtimeInput?.text === 'START_SESSION'
        );
      }),
    );

    ws.emitMessage({
      type: 'llm:tool-call',
      msgid: 'msg-google-tool',
      data: {
        type: 'toolCall',
        functionCalls: [
          {
            id: 'call-greeting',
            name: 'get_greeting',
            args: {},
          },
        ],
      },
    });

    await flushAsync();

    const greetingToolOutput = ws.send.mock.calls
      .map((call) => JSON.parse(call[0]))
      .find(
        (payload) =>
          payload?.command === 'llm:tool-output' && payload?.tool_call_id === 'call-greeting',
      );

    expect(greetingToolOutput).toBeDefined();
    const greetingResult = JSON.parse(
      greetingToolOutput.data.toolResponse.functionResponses[0].response.result,
    ) as {
      text: string;
      runtime_instructions?: string;
    };
    expect(greetingResult.text).toBe(
      'Welcome back. I have your details ready and can help with your appointment.',
    );
    expect(greetingResult.runtime_instructions).toEqual(expect.any(String));
    expect(greetingResult.runtime_instructions?.length ?? 0).toBeGreaterThan(0);

    ws.emitMessage({
      type: 'llm:tool-call',
      msgid: 'msg-google-tool-repeat',
      data: {
        type: 'toolCall',
        functionCalls: [
          {
            id: 'call-greeting-repeat',
            name: 'get_greeting',
            args: {},
          },
        ],
      },
    });

    await flushAsync();

    const repeatedGreetingToolOutput = ws.send.mock.calls
      .map((call) => JSON.parse(call[0]))
      .find(
        (payload) =>
          payload?.command === 'llm:tool-output' &&
          payload?.tool_call_id === 'call-greeting-repeat',
      );

    expect(repeatedGreetingToolOutput).toBeDefined();
    const repeatedGreetingResult = JSON.parse(
      repeatedGreetingToolOutput.data.toolResponse.functionResponses[0].response.result,
    ) as {
      text?: string;
      runtime_instructions?: string;
    };
    expect(repeatedGreetingResult.text).toBeUndefined();
    expect(repeatedGreetingResult.runtime_instructions).toEqual(expect.any(String));
    expect(repeatedGreetingResult.runtime_instructions?.length ?? 0).toBeGreaterThan(0);
  });

  it('returns inline runtime instructions for Gemini handoff tool calls', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const executeRealtimeToolCall = vi.fn().mockResolvedValue({
      result: {
        success: true,
        response: 'Welcome to your travel assistant!',
      },
      activeAgentName: 'Sales_Agent',
      activeAgentIR: { id: 'sales-agent-ir' },
    });

    mocks.mockResolveVoiceMode.mockResolvedValue('realtime');
    mocks.mockResolveConnectionByIdUnsafe.mockResolvedValue(
      createConnection({
        config: {
          inboundAuthToken: 'voice-secret',
          mode: 'pipeline',
          s2sProvider: 's2s:google',
          s2sModel: 'gemini-live-2.5-flash-preview',
        },
      }),
    );
    mocks.mockGetRuntimeExecutor.mockReturnValue({
      createSessionFromResolved: mocks.mockCreateSessionFromResolved,
      executeRealtimeToolCall,
    });

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor',
      headers: {},
    });

    ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-gemini',
      call_sid: 'call-gemini',
      data: {
        from: '+15551111',
        to: '+15552222',
      },
    });

    ws.emitMessage({
      type: 'llm:tool-call',
      msgid: 'msg-tool',
      data: {
        type: 'toolCall',
        functionCalls: [
          {
            id: 'call-2',
            name: 'handoff_to_Welcome_Agent',
            args: '{"message":"hi"}',
          },
        ],
      },
    });

    await flushAsync();

    expect(executeRealtimeToolCall).toHaveBeenCalledWith(
      'runtime-session-1',
      'handoff_to_Welcome_Agent',
      { message: 'hi' },
      expect.any(Function),
      expect.objectContaining({
        sessionLocator: expect.objectContaining({
          kind: 'production',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          sessionId: 'runtime-session-1',
        }),
      }),
    );

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'ack', msgid: 'msg-tool' }));
    const toolOutput = ws.send.mock.calls
      .map((call) => JSON.parse(call[0]))
      .find(
        (payload) => payload?.command === 'llm:tool-output' && payload?.tool_call_id === 'call-2',
      );

    expect(toolOutput).toBeDefined();
    const toolResult = JSON.parse(
      toolOutput.data.toolResponse.functionResponses[0].response.result,
    ) as {
      text?: string;
      runtime_instructions?: string;
      active_agent?: string;
      continue_current_turn?: boolean;
    };
    expect(toolResult.text).toBeUndefined();
    expect(toolResult.active_agent).toBe('Sales_Agent');
    expect(toolResult.continue_current_turn).toBe(true);
    expect(toolResult.runtime_instructions).toEqual(expect.any(String));
    expect(toolResult.runtime_instructions?.length ?? 0).toBeGreaterThan(0);
  });

  it('emits voice_stt, voice_tts, and voice_turn traces for snake_case Gemini events', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const mockAddMessage = vi.fn();
    const assistantMetadata = expectedRealtimeAssistantMetadata();

    mocks.mockResolveVoiceMode.mockResolvedValue('realtime');
    mocks.mockResolveConnectionByIdUnsafe.mockResolvedValue(
      createConnection({
        config: {
          inboundAuthToken: 'voice-secret',
          mode: 'realtime',
          s2sProvider: 's2s:google',
          s2sModel: 'gemini-live-2.5-flash-preview',
        },
      }),
    );
    mocks.mockGetRuntimeExecutor.mockReturnValue({
      createSessionFromResolved: mocks.mockCreateSessionFromResolved,
      initializeSession: mocks.mockInitializeSession,
      executeRealtimeToolCall: vi.fn(),
      addMessage: mockAddMessage,
    });

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor',
      headers: {},
    });

    ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-gemini-session',
      call_sid: 'call-gemini-session',
      data: {
        from: '+15551111',
        to: '+15552222',
      },
    });

    await waitForCondition(() => mocks.mockCreateAndLinkDBSession.mock.calls.length > 0);
    await waitForCondition(() => ws.send.mock.calls.length > 0);
    ws.emitMessage({
      type: 'llm:event',
      msgid: 'msg-gemini-connected',
      data: {
        type: 'session.connected',
      },
    });
    await waitForCondition(() =>
      ws.send.mock.calls.some((call) => {
        const payload = JSON.parse(call[0]);
        return (
          payload?.command === 'llm:update' &&
          payload?.data?.realtimeInput?.text === 'START_SESSION'
        );
      }),
    );

    await waitForCondition(() =>
      mocks.mockTraceStoreAddEvent.mock.calls.some(
        ([, event]) => (event as { type?: string }).type === 'voice_session_start',
      ),
    );

    await flushAsync();
    mocks.mockTraceStoreAddEvent.mockClear();
    mocks.mockEmitTraceEventAsAnalytics.mockClear();

    ws.emitMessage({
      type: 'llm:event',
      msgid: 'msg-gemini-user',
      data: {
        server_content: {
          input_transcription: {
            text: 'When is my appointment?',
          },
        },
      },
    });

    await waitForCondition(
      () =>
        mocks.mockTraceStoreAddEvent.mock.calls.some(
          ([, event]) => (event as { type?: string }).type === 'voice_stt',
        ),
      10_000,
    );

    ws.emitMessage({
      type: 'llm:event',
      msgid: 'msg-gemini-assistant',
      data: {
        server_content: {
          model_turn: {
            parts: [{ text: 'Your appointment is scheduled for tomorrow.' }],
          },
          turn_complete: true,
        },
      },
    });

    await waitForCondition(
      () =>
        mocks.mockTraceStoreAddEvent.mock.calls.some(
          ([, event]) => (event as { type?: string }).type === 'voice_turn',
        ),
      10_000,
    );

    const emittedTraceTypes = mocks.mockTraceStoreAddEvent.mock.calls.map(
      ([, event]) => (event as { type?: string }).type,
    );
    expect(emittedTraceTypes).toEqual(
      expect.arrayContaining(['voice_stt', 'voice_tts', 'voice_turn']),
    );

    const voiceTurnCall = mocks.mockTraceStoreAddEvent.mock.calls.find(
      ([, event]) => (event as { type?: string }).type === 'voice_turn',
    );
    expect(voiceTurnCall?.[1]).toEqual(
      expect.objectContaining({
        type: 'voice_turn',
        data: expect.objectContaining({
          userInput: 'When is my appointment?',
          assistantResponse: 'Your appointment is scheduled for tomorrow.',
          s2sProvider: 's2s:google',
        }),
      }),
    );

    const analyticsTypes = mocks.mockEmitTraceEventAsAnalytics.mock.calls.map(
      ([, payload]) => (payload as { type?: string }).type,
    );
    expect(analyticsTypes).toEqual(
      expect.arrayContaining(['voice_stt', 'voice_tts', 'voice_turn']),
    );
    expect(mockAddMessage).toHaveBeenCalledWith(
      'runtime-session-1',
      'assistant',
      'Your appointment is scheduled for tomorrow.',
      assistantMetadata,
    );
    expect(mocks.mockPersistMessage).toHaveBeenCalledWith(
      'db-session-1',
      'assistant',
      'Your appointment is scheduled for tomorrow.',
      'voice',
      'tenant-1',
      undefined,
      undefined,
      'project-1',
      expect.any(Number),
      undefined,
      assistantMetadata,
    );
  });

  it('marks generic S2S assistant transcripts as LLM-generated in runtime and persistence', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const mockAddMessage = vi.fn();
    const assistantMetadata = expectedRealtimeAssistantMetadata();

    mocks.mockResolveVoiceMode.mockResolvedValue('realtime');
    mocks.mockResolveConnectionByIdUnsafe.mockResolvedValue(
      createConnection({
        config: {
          inboundAuthToken: 'voice-secret',
          mode: 'realtime',
          s2sProvider: 's2s:openai',
          s2sModel: 'gpt-realtime',
        },
      }),
    );
    mocks.mockGetRuntimeExecutor.mockReturnValue({
      createSessionFromResolved: mocks.mockCreateSessionFromResolved,
      initializeSession: mocks.mockInitializeSession,
      executeRealtimeToolCall: vi.fn(),
      addMessage: mockAddMessage,
    });

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor',
      headers: {},
    });

    ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-openai-session',
      call_sid: 'call-openai-session',
      data: {
        from: '+15551111',
        to: '+15552222',
      },
    });

    await waitForCondition(() => mocks.mockCreateAndLinkDBSession.mock.calls.length > 0);

    ws.emitMessage({
      type: 'llm:event',
      msgid: 'msg-openai-assistant',
      data: {
        type: 'response.audio_transcript.done',
        transcript: 'Here is the answer.',
      },
    });

    await waitForCondition(() =>
      mocks.mockPersistMessage.mock.calls.some(
        ([, role, content]) => role === 'assistant' && content === 'Here is the answer.',
      ),
    );

    expect(mockAddMessage).toHaveBeenCalledWith(
      'runtime-session-1',
      'assistant',
      'Here is the answer.',
      assistantMetadata,
    );
    expect(mocks.mockPersistMessage).toHaveBeenCalledWith(
      'db-session-1',
      'assistant',
      'Here is the answer.',
      'voice',
      'tenant-1',
      undefined,
      undefined,
      'project-1',
      expect.any(Number),
      undefined,
      assistantMetadata,
    );
  });

  it('emits a voice_realtime_tool_call trace event for S2S tool calls', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const executeRealtimeToolCall = vi.fn().mockResolvedValue({
      result: {
        success: true,
        response: 'Welcome to your travel assistant!',
      },
      activeAgentName: 'Sales_Agent',
      activeAgentIR: { id: 'sales-agent-ir' },
    });

    mocks.mockResolveVoiceMode.mockResolvedValue('realtime');
    mocks.mockResolveConnectionByIdUnsafe.mockResolvedValue(
      createConnection({
        config: {
          inboundAuthToken: 'voice-secret',
          mode: 'realtime',
          s2sProvider: 's2s:openai',
          s2sModel: 'gpt-realtime',
        },
      }),
    );
    mocks.mockGetRuntimeExecutor.mockReturnValue({
      createSessionFromResolved: mocks.mockCreateSessionFromResolved,
      executeRealtimeToolCall,
    });

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor',
      headers: {},
    });

    ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-rt',
      call_sid: 'call-rt',
      data: {
        from: '+15550003',
        to: '+15550004',
      },
    });

    ws.emitMessage({
      type: 'llm:event',
      msgid: 'msg-args',
      data: {
        type: 'response.function_call_arguments.done',
        call_id: 'call-123',
        arguments: '{"message":"book a hotel"}',
      },
    });

    ws.emitMessage({
      type: 'llm:tool-call',
      msgid: 'msg-tool',
      data: {
        name: 'handoff_to_Sales_Agent',
        call_id: 'call-123',
        arguments: '{}',
      },
    });

    await flushAsync();

    const toolTraceCall = mocks.mockTraceStoreAddEvent.mock.calls.find(
      ([, event]) => (event as { type?: string }).type === 'voice_realtime_tool_call',
    );
    const canonicalToolCall = mocks.mockTraceStoreAddEvent.mock.calls.find(
      ([, event]) => (event as { type?: string }).type === 'tool_call',
    );

    expect(toolTraceCall).toBeDefined();
    expect(canonicalToolCall).toBeDefined();
    expect(toolTraceCall?.[0]).toBe('runtime-session-1');
    expect(toolTraceCall?.[1]).toMatchObject({
      type: 'voice_realtime_tool_call',
      sessionId: 'runtime-session-1',
      agentName: 'supervisor',
      data: {
        turn: 1,
        toolName: 'handoff_to_Sales_Agent',
        toolCallId: 'call-123',
        arguments: { message: 'book a hotel' },
        provider: 's2s:openai',
        channel: 'voice',
        tenantId: 'tenant-1',
        sourceAgent: 'supervisor',
        targetAgent: 'Sales_Agent',
      },
    });
    expect((toolTraceCall?.[1] as { durationMs?: number }).durationMs).toEqual(expect.any(Number));

    const storedTraceEvents = mocks.mockTraceStoreAddEvent.mock.calls.map(([, event]) => event);
    const agentEnterEvents = storedTraceEvents.filter(
      (event) => (event as { type?: string }).type === 'agent_enter',
    );
    const agentExitEvents = storedTraceEvents.filter(
      (event) => (event as { type?: string }).type === 'agent_exit',
    );

    expect(agentEnterEvents).toEqual([
      expect.objectContaining({
        sessionId: 'runtime-session-1',
        agentName: 'supervisor',
        data: expect.objectContaining({
          agentName: 'supervisor',
          trigger: 'realtime_tool_call',
          messageSource: 'voice',
          channel: 'voice',
          modality: 'realtime_voice',
        }),
      }),
      expect.objectContaining({
        sessionId: 'runtime-session-1',
        agentName: 'Sales_Agent',
        data: expect.objectContaining({
          agentName: 'Sales_Agent',
          trigger: 'handoff',
          messageSource: 'voice',
          channel: 'voice',
          modality: 'realtime_voice',
        }),
      }),
    ]);
    expect(toolTraceCall?.[1]).toMatchObject({
      parentSpanId: (agentEnterEvents[0] as { spanId?: string }).spanId,
      agentRunId: (agentEnterEvents[0] as { spanId?: string }).spanId,
      data: expect.objectContaining({
        parentSpanId: (agentEnterEvents[0] as { spanId?: string }).spanId,
        agentRunId: (agentEnterEvents[0] as { spanId?: string }).spanId,
      }),
    });
    expect(canonicalToolCall?.[1]).toMatchObject({
      type: 'tool_call',
      sessionId: 'runtime-session-1',
      agentName: 'supervisor',
      parentSpanId: (agentEnterEvents[0] as { spanId?: string }).spanId,
      agentRunId: (agentEnterEvents[0] as { spanId?: string }).spanId,
      data: expect.objectContaining({
        toolName: 'handoff_to_Sales_Agent',
        input: { message: 'book a hotel' },
        status: 'success',
        channel: 'voice',
        modality: 'realtime_voice',
        sourceAgent: 'supervisor',
        targetAgent: 'Sales_Agent',
        voiceTraceEventId: (toolTraceCall?.[1] as { id?: string }).id,
      }),
    });
    expect(agentExitEvents).toEqual([
      expect.objectContaining({
        sessionId: 'runtime-session-1',
        agentName: 'supervisor',
        data: expect.objectContaining({
          agentName: 'supervisor',
          nextAgent: 'Sales_Agent',
          result: 'handoff',
          channel: 'voice',
          modality: 'realtime_voice',
        }),
      }),
    ]);
  });

  it('emits a canonical llm_call trace when an S2S realtime response completes', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();

    mocks.mockResolveVoiceMode.mockResolvedValue('realtime');
    mocks.mockResolveConnectionByIdUnsafe.mockResolvedValue(
      createConnection({
        config: {
          inboundAuthToken: 'voice-secret',
          mode: 'realtime',
          s2sProvider: 's2s:openai',
          s2sModel: 'gpt-realtime',
          s2sVoice: 'alloy',
        },
      }),
    );

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor',
      headers: {},
    });

    ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-rt',
      call_sid: 'call-rt',
      data: {
        from: '+15550003',
        to: '+15550004',
      },
    });

    await waitForCondition(() => mocks.mockCreateAndLinkDBSession.mock.calls.length > 0);

    const responseDone = {
      type: 'llm:event',
      msgid: 'msg-response-done',
      data: {
        type: 'response.done',
        response: {
          id: 'resp-123',
          usage: {
            input_tokens: 42,
            output_tokens: 9,
            total_tokens: 51,
          },
        },
      },
    };

    ws.emitMessage(responseDone);
    ws.emitMessage({ ...responseDone, msgid: 'msg-response-done-duplicate' });

    await waitForCondition(() =>
      mocks.mockTraceStoreAddEvent.mock.calls.some(
        ([, event]) => (event as { type?: string }).type === 'llm_call',
      ),
    );
    await flushAsync();

    const llmTraceCalls = mocks.mockTraceStoreAddEvent.mock.calls.filter(
      ([, event]) => (event as { type?: string }).type === 'llm_call',
    );
    expect(llmTraceCalls).toHaveLength(1);
    expect(llmTraceCalls[0]?.[0]).toBe('runtime-session-1');
    expect(llmTraceCalls[0]?.[1]).toMatchObject({
      type: 'llm_call',
      sessionId: 'runtime-session-1',
      agentName: 'supervisor',
      data: {
        model: 'gpt-realtime',
        provider: 'openai',
        s2sProvider: 's2s:openai',
        modality: 'realtime_voice',
        responseId: 'resp-123',
        channel: 'voice',
        tenantId: 'tenant-1',
        tokensIn: 42,
        tokensOut: 9,
        totalTokens: 51,
        usage: {
          inputTokens: 42,
          outputTokens: 9,
          totalTokens: 51,
        },
        request: {
          model: 'gpt-realtime',
          provider: 'openai',
          modality: 'realtime_voice',
          toolCount: 1,
          voice: 'alloy',
        },
        response: {
          status: 'completed',
          responseId: 'resp-123',
        },
      },
    });

    await waitForCondition(() =>
      mocks.mockEmitTraceEventAsAnalytics.mock.calls.some(
        ([, event]) => (event as { type?: string }).type === 'llm_call',
      ),
    );
    const platformEventCall = mocks.mockEmitTraceEventAsAnalytics.mock.calls.find(
      ([, event]) => (event as { type?: string }).type === 'llm_call',
    );
    expect(platformEventCall?.[2]).toMatchObject({
      typeMap: {
        llm_call: 'llm.call.completed',
      },
    });

    expect(mocks.mockPersistTurnMetrics).toHaveBeenCalledWith(
      expect.objectContaining({
        dbSessionId: 'db-session-1',
        tenantId: 'tenant-1',
        tokensIn: 42,
        tokensOut: 9,
        traceEventCount: 1,
      }),
    );
  });

  it('rejects unsupported Deepgram realtime providers at bootstrap', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();

    mocks.mockResolveVoiceMode.mockResolvedValue('realtime');
    mocks.mockResolveConnectionByIdUnsafe.mockResolvedValue(
      createConnection({
        config: {
          inboundAuthToken: 'voice-secret',
          mode: 'realtime',
          s2sProvider: 's2s:deepgram',
          s2sModel: 'aura-asteria-en',
          s2sThinkProviderType: 'open_ai',
          s2sThinkModel: 'gpt-4o-mini',
        },
      }),
    );

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor',
      headers: {},
    });

    ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-dg-session',
      call_sid: 'call-dg',
      data: {
        from: '+15550003',
        to: '+15550004',
      },
    });

    await flushAsync();

    expect(ws.close).toHaveBeenCalledWith(1011, 'S2S provider not supported');
    expect(mocks.mockTraceStoreAddEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'voice_turn' }),
    );
  });

  it('rejects unsupported ElevenLabs realtime providers at bootstrap', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const executeRealtimeToolCall = vi.fn().mockResolvedValue({
      result: {
        success: true,
        response: 'Let me transfer you to the reservations specialist.',
      },
      activeAgentName: 'Sales_Agent',
      activeAgentIR: { id: 'sales-agent-ir' },
    });

    mocks.mockResolveVoiceMode.mockResolvedValue('realtime');
    mocks.mockResolveConnectionByIdUnsafe.mockResolvedValue(
      createConnection({
        config: {
          inboundAuthToken: 'voice-secret',
          mode: 'realtime',
          s2sProvider: 's2s:elevenlabs',
          s2sAgentId: 'agent_123',
        },
      }),
    );
    mocks.mockGetRuntimeExecutor.mockReturnValue({
      createSessionFromResolved: mocks.mockCreateSessionFromResolved,
      initializeSession: mocks.mockInitializeSession,
      executeRealtimeToolCall,
    });

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor',
      headers: {},
    });

    ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-el-session',
      call_sid: 'call-el',
      data: {
        from: '+15550003',
        to: '+15550004',
      },
    });

    await flushAsync();

    const sentMessages = ws.send.mock.calls.map(([payload]) => JSON.parse(payload));
    expect(ws.close).toHaveBeenCalledWith(1011, 'S2S provider not supported');
    expect(executeRealtimeToolCall).not.toHaveBeenCalled();
    expect(
      sentMessages.some(
        (message) => message?.command === 'llm:update' && message?.data?.type === 'session.update',
      ),
    ).toBe(false);
  });

  it('clears all tracked sessions during shutdown', async () => {
    const router = createRouter();
    (router as any).sessions.set('session-1', { close: vi.fn() });
    (router as any).sessions.set('session-2', { close: vi.fn() });

    await router.shutdown();
    routers.delete(router);

    expect(router.getSessionCount()).toBe(0);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const mockResolveConnectionByIdUnsafe = vi.fn();
  const mockResolveChannelConnection = vi.fn();
  const mockCreateSessionFromResolved = vi.fn();
  const mockGetRuntimeExecutor = vi.fn();
  const mockAddMessage = vi.fn();
  const mockDeploymentResolve = vi.fn();
  const mockGetSessionService = vi.fn(() => ({}));
  const mockExtractIngressToken = vi.fn();
  const mockTokensMatch = vi.fn();
  const mockResolveVoiceCredentials = vi.fn();
  const mockResolveVoiceMode = vi.fn();
  const mockResolveS2SCredentials = vi.fn();
  const mockCreateAndLinkDBSession = vi.fn();
  const mockResolveContactIdFromChannelIdentity = vi.fn();
  const mockLinkResolvedContactToSession = vi.fn();
  const mockResolveRequiredContactProductionScope = vi.fn();
  const mockTraceStoreAddEvent = vi.fn();
  const mockEmitTraceEventAsAnalytics = vi.fn();
  const mockBuildSystemPrompt = vi.fn();
  const mockBuildTools = vi.fn();
  const mockBuildLiveVoicePromptSurface = vi.fn();
  const mockExecuteLiveVoiceToolCall = vi.fn();
  const mockExecuteLiveVoiceSemanticTurn = vi.fn();
  const mockBuildRealtimeLlmVerbPayload = vi.fn();
  const mockBuildGrokLlmVerbPayload = vi.fn();
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
    mockGetRuntimeExecutor,
    mockAddMessage,
    mockDeploymentResolve,
    mockGetSessionService,
    mockExtractIngressToken,
    mockTokensMatch,
    mockResolveVoiceCredentials,
    mockResolveVoiceMode,
    mockResolveS2SCredentials,
    mockCreateAndLinkDBSession,
    mockResolveContactIdFromChannelIdentity,
    mockLinkResolvedContactToSession,
    mockResolveRequiredContactProductionScope,
    mockTraceStoreAddEvent,
    mockEmitTraceEventAsAnalytics,
    mockBuildSystemPrompt,
    mockBuildTools,
    mockBuildLiveVoicePromptSurface,
    mockExecuteLiveVoiceToolCall,
    mockExecuteLiveVoiceSemanticTurn,
    mockBuildRealtimeLlmVerbPayload,
    mockBuildGrokLlmVerbPayload,
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

vi.mock('../../services/voice/korevg/grok-llm-payload.js', () => ({
  buildGrokLlmVerbPayload: (...args: unknown[]) => mocks.mockBuildGrokLlmVerbPayload(...args),
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

import { KorevgRouter } from '../../services/voice/korevg/korevg-router.js';

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
    async emitMessage(payload: unknown) {
      const buffer = Buffer.isBuffer(payload)
        ? payload
        : Buffer.from(JSON.stringify(payload), 'utf8');
      for (const handler of [...messageHandlers]) {
        await handler(buffer);
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

function createConnection() {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    deploymentId: 'deployment-1',
    agentId: 'agent-supervisor',
    environment: 'prod',
    config: {
      inboundAuthToken: 'voice-secret',
      mode: 'pipeline',
      s2sProvider: 's2s:grok',
      s2sModel: 'grok-4-1-fast-non-reasoning',
      s2sVoice: 'ara',
    },
  };
}

function createResolvedAgent() {
  return {
    entryAgent: 'supervisor',
    agents: {
      supervisor: {
        metadata: { name: 'Supervisor' },
        identity: { system_prompt: { template: 'You are helpful.' } },
        tools: [],
      },
      Sales_Agent: {
        metadata: { name: 'Sales Agent' },
        identity: { system_prompt: { template: 'You book hotels.' } },
        tools: [],
      },
    },
  };
}

function createRuntimeSession() {
  return {
    id: 'runtime-session-1',
    channelType: 'voice',
    agentName: 'supervisor',
    agentIR: {
      metadata: { name: 'Supervisor' },
    },
    _effectiveConfig: {},
    conversationHistory: [{ role: 'user', content: 'book a hotel' }],
    data: {
      values: {},
      gatheredKeys: new Set<string>(),
    },
    toolExecutor: { execute: vi.fn() },
  };
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

  throw new Error('Timed out waiting for Grok KoreVG condition');
}

function parseMessages(ws: ReturnType<typeof createMockWebSocket>) {
  return ws.send.mock.calls.map(([payload]) => JSON.parse(payload as string));
}

describe('KorevgRouter Grok realtime handoff', () => {
  const routers = new Set<KorevgRouter>();
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'test';

    mocks.mockGetRuntimeExecutor.mockReturnValue({
      createSessionFromResolved: mocks.mockCreateSessionFromResolved,
      executeRealtimeToolCall: vi.fn(),
      addMessage: mocks.mockAddMessage,
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
    mocks.mockResolveVoiceMode.mockResolvedValue('realtime');
    mocks.mockResolveS2SCredentials.mockResolvedValue({
      credentials: { apiKey: 'xai-test-key', config: {} },
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
            (callerContext?.anonymousId as string | undefined) ?? `korevg:${sessionId ?? 'call'}`,
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
    mocks.mockBuildSystemPrompt.mockImplementation(
      (session: { agentName?: string }) =>
        `Updated system prompt for ${session.agentName ?? 'unknown'}`,
    );
    mocks.mockBuildTools.mockImplementation(() => [
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
    mocks.mockBuildLiveVoicePromptSurface.mockImplementation(
      ({
        runtimeSession,
      }: {
        runtimeSession?: { agentName?: string; agentIR?: { metadata?: { name?: string } } | null };
      }) => ({
        profile: 'realtime',
        systemPrompt: `Updated system prompt for ${
          runtimeSession?.agentName || runtimeSession?.agentIR?.metadata?.name || 'unknown'
        }`,
        tools: [
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
            activeAgentIR: { metadata: { name: string } };
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
        runtimeSession: { agentName?: string; agentIR?: { metadata?: { name?: string } } | null };
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
    mocks.mockBuildRealtimeLlmVerbPayload.mockImplementation(() => ({
      verb: 'llm',
      vendor: 'openai',
      model: 'gpt-realtime',
      auth: { apiKey: 'test-key' },
      llmOptions: {
        session_update: {
          instructions: 'unused',
          voice: 'marin',
          turn_detection: {
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 700,
          },
        },
      },
    }));
    mocks.mockBuildGrokLlmVerbPayload.mockImplementation(
      ({
        s2sConfig,
        includeResponseCreate = true,
        handoffContext,
      }: {
        s2sConfig: { model?: string; voice?: string };
        includeResponseCreate?: boolean;
        handoffContext?: string;
      }) => ({
        verb: 'llm',
        vendor: 'grok',
        model: s2sConfig.model || 'grok-fallback',
        auth: { apiKey: 'xai-test-key' },
        llmOptions: {
          session_update: {
            instructions: 'Updated system prompt',
            voice: s2sConfig.voice || 'ara',
            turn_detection: {
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
            },
          },
          response_create: {
            modalities: ['text', 'audio'],
            instructions: handoffContext || (includeResponseCreate ? 'Say hello' : 'Continue'),
          },
        },
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
    const router = new KorevgRouter({ baseUrl: 'http://runtime.local' });
    routers.add(router);
    return router;
  }

  it('stores Grok S2S metadata and updates the live session inline after handoff speech completes', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const runtimeSession = createRuntimeSession();
    const executeRealtimeToolCall = vi.fn().mockResolvedValue({
      result: {
        success: true,
        response: "I'm transferring you to Sales Agent now.",
      },
      activeAgentName: 'Sales_Agent',
      activeAgentIR: { metadata: { name: 'Sales Agent' } },
    });

    mocks.mockGetRuntimeExecutor.mockReturnValue({
      createSessionFromResolved: mocks.mockCreateSessionFromResolved,
      executeRealtimeToolCall,
      addMessage: mocks.mockAddMessage,
    });
    mocks.mockCreateSessionFromResolved.mockReturnValue(runtimeSession);

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor',
      headers: {},
    });

    await ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-session',
      call_sid: 'call-grok',
      data: {
        from: '+15550003',
        to: '+15550004',
      },
    });

    await waitForCondition(
      () =>
        (runtimeSession.data.values.session as Record<string, unknown> | undefined)?.s2sProvider ===
        's2s:grok',
    );

    expect(runtimeSession.data.values.session).toMatchObject({
      channel: 'voice',
      voiceMode: 'realtime',
      s2sProvider: 's2s:grok',
      s2sModel: 'grok-4-1-fast-non-reasoning',
      s2sVoice: 'ara',
    });

    await ws.emitMessage({
      type: 'llm:tool-call',
      msgid: 'msg-tool',
      data: {
        name: 'handoff_to_Sales_Agent',
        tool_call_id: 'call-123',
        args: {
          message: 'book a hotel',
        },
      },
    });

    await waitForCondition(() => executeRealtimeToolCall.mock.calls.length > 0);

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

    const postToolMessages = parseMessages(ws);
    expect(postToolMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'ack', msgid: 'msg-tool' }),
        expect.objectContaining({
          type: 'command',
          command: 'llm:tool-output',
          tool_call_id: 'call-123',
        }),
      ]),
    );
    expect(
      postToolMessages.filter(
        (message) =>
          message?.type === 'command' &&
          message?.command === 'llm:update' &&
          message?.data?.type === 'response.create',
      ),
    ).toHaveLength(0);
    expect(
      postToolMessages.filter(
        (message) =>
          message?.type === 'command' &&
          message?.command === 'llm:update' &&
          message?.data?.type === 'session.update',
      ),
    ).toHaveLength(0);
    const silentToolOutput = postToolMessages.find(
      (message) => message?.command === 'llm:tool-output' && message?.tool_call_id === 'call-123',
    );
    expect(silentToolOutput?.data).toEqual(
      expect.objectContaining({
        defer_response_create: true,
        item: expect.objectContaining({
          output: JSON.stringify({ success: true }),
        }),
      }),
    );
    expect(silentToolOutput?.data?.item?.output).not.toContain('connecting');
    expect(silentToolOutput?.data?.item?.output).not.toContain('Sales Agent');

    await ws.emitMessage({
      type: 'llm:event',
      msgid: 'msg-transcript',
      data: {
        type: 'response.output_audio_transcript.done',
        response_id: 'resp-handoff-1',
      },
    });

    await ws.emitMessage({
      type: 'llm:event',
      msgid: 'msg-done',
      data: {
        type: 'response.done',
        response_id: 'resp-handoff-1',
        response: {
          id: 'resp-handoff-1',
        },
      },
    });

    await waitForCondition(() =>
      parseMessages(ws).some(
        (message) =>
          message?.type === 'command' &&
          message?.command === 'llm:update' &&
          message?.data?.type === 'session.update',
      ),
    );

    const finalMessages = parseMessages(ws);
    expect(finalMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'command',
          command: 'llm:update',
          data: expect.objectContaining({
            type: 'session.update',
            session: expect.objectContaining({
              instructions: 'Updated system prompt',
              voice: 'ara',
            }),
          }),
        }),
        expect.objectContaining({
          type: 'command',
          command: 'llm:update',
          data: expect.objectContaining({
            type: 'response.create',
            response: expect.objectContaining({
              instructions: expect.stringContaining('The customer previously said:'),
            }),
          }),
        }),
      ]),
    );
    expect(
      finalMessages.filter(
        (message) => message?.type === 'command' && message?.command === 'redirect',
      ),
    ).toHaveLength(0);
    expect(mocks.mockBuildGrokLlmVerbPayload).toHaveBeenCalledTimes(2);
    expect(mocks.mockBuildGrokLlmVerbPayload).toHaveBeenLastCalledWith(
      expect.objectContaining({
        includeResponseCreate: false,
        handoffContext: expect.stringContaining('book a hotel'),
        internalHandoffSpeech: 'silent',
      }),
    );
    const handoffBuildCall = mocks.mockBuildGrokLlmVerbPayload.mock.calls.at(-1)?.[0] as
      | { handoffContext?: string }
      | undefined;
    expect(handoffBuildCall?.handoffContext).not.toMatch(/\btransfer|transferred|handoff\b/i);
    expect(handoffBuildCall?.handoffContext).not.toContain('Acknowledge');
  });

  it('does not repeat authored internal handoff speech after the live Grok session swap', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const runtimeSession = createRuntimeSession();
    runtimeSession._effectiveConfig = {
      conversationBehavior: {
        speaking: {
          handoffs: {
            internal: 'brief',
          },
        },
        sourceChain: ['agent'],
        capabilityDrops: [],
      },
    };
    const executeRealtimeToolCall = vi.fn().mockResolvedValue({
      result: {
        success: true,
        response: "I'm connecting you to Sales Agent now.",
      },
      activeAgentName: 'Sales_Agent',
      activeAgentIR: { metadata: { name: 'Sales Agent' } },
    });

    mocks.mockGetRuntimeExecutor.mockReturnValue({
      createSessionFromResolved: mocks.mockCreateSessionFromResolved,
      executeRealtimeToolCall,
      addMessage: mocks.mockAddMessage,
    });
    mocks.mockCreateSessionFromResolved.mockReturnValue(runtimeSession);

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor',
      headers: {},
    });

    await ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-session',
      call_sid: 'call-grok',
      data: {
        from: '+15550003',
        to: '+15550004',
      },
    });

    await ws.emitMessage({
      type: 'llm:tool-call',
      msgid: 'msg-tool',
      data: {
        name: 'handoff_to_Sales_Agent',
        tool_call_id: 'call-123',
        args: {
          message: 'book a hotel',
        },
      },
    });

    await waitForCondition(() => executeRealtimeToolCall.mock.calls.length > 0);

    const postToolMessages = parseMessages(ws);
    expect(postToolMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'command',
          command: 'llm:update',
          data: expect.objectContaining({
            type: 'response.create',
            response: expect.objectContaining({
              instructions: expect.stringContaining("I'm connecting you to Sales Agent now."),
            }),
          }),
        }),
      ]),
    );

    await ws.emitMessage({
      type: 'llm:event',
      msgid: 'msg-transcript',
      data: {
        type: 'response.output_audio_transcript.done',
        response_id: 'resp-brief-handoff',
      },
    });

    await ws.emitMessage({
      type: 'llm:event',
      msgid: 'msg-done',
      data: {
        type: 'response.done',
        response_id: 'resp-brief-handoff',
        response: {
          id: 'resp-brief-handoff',
        },
      },
    });

    await waitForCondition(() => mocks.mockBuildGrokLlmVerbPayload.mock.calls.length >= 2);

    expect(mocks.mockBuildGrokLlmVerbPayload).toHaveBeenLastCalledWith(
      expect.objectContaining({
        includeResponseCreate: false,
        internalHandoffSpeech: 'silent',
      }),
    );
  });

  it('keeps same-session Grok handoff prompt clean and does not restart on later verb hooks', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const runtimeSession = createRuntimeSession();
    runtimeSession.conversationHistory = [
      { role: 'user', content: 'book a hotel in goa' },
      { role: 'assistant', content: 'Sure, I can help with that.' },
      { role: 'user', content: 'for two nights' },
    ];

    const executeRealtimeToolCall = vi.fn().mockResolvedValue({
      result: {
        success: true,
        response: "I'm transferring you to Sales Agent now.",
      },
      activeAgentName: 'Sales_Agent',
      activeAgentIR: { metadata: { name: 'Sales Agent' } },
    });

    mocks.mockGetRuntimeExecutor.mockReturnValue({
      createSessionFromResolved: mocks.mockCreateSessionFromResolved,
      executeRealtimeToolCall,
      addMessage: mocks.mockAddMessage,
    });
    mocks.mockCreateSessionFromResolved.mockReturnValue(runtimeSession);

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor',
      headers: {},
    });

    await ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-session',
      call_sid: 'call-grok',
      data: {
        from: '+15550003',
        to: '+15550004',
      },
    });

    await ws.emitMessage({
      type: 'llm:tool-call',
      msgid: 'msg-tool',
      data: {
        name: 'handoff_to_Sales_Agent',
        tool_call_id: 'call-321',
        args: {
          message: 'book a hotel in goa for two nights',
        },
      },
    });

    await waitForCondition(() => executeRealtimeToolCall.mock.calls.length > 0);

    await ws.emitMessage({
      type: 'llm:event',
      msgid: 'msg-transcript',
      data: {
        type: 'response.output_audio_transcript.done',
        response_id: 'resp-handoff-2',
      },
    });

    await ws.emitMessage({
      type: 'llm:event',
      msgid: 'msg-done',
      data: {
        type: 'response.done',
        response_id: 'resp-handoff-2',
        response: {
          id: 'resp-handoff-2',
        },
      },
    });

    await waitForCondition(() => mocks.mockBuildGrokLlmVerbPayload.mock.calls.length >= 2);

    const handoffBuildCall = mocks.mockBuildGrokLlmVerbPayload.mock.calls.at(-1)?.[0] as
      | { instructions?: string; includeResponseCreate?: boolean; handoffContext?: string }
      | undefined;

    expect(handoffBuildCall).toBeDefined();
    expect(handoffBuildCall?.includeResponseCreate).toBe(false);
    expect(handoffBuildCall?.instructions).toBe('Updated system prompt for Sales_Agent');
    expect(handoffBuildCall?.instructions).not.toContain('## CONVERSATION HISTORY');
    expect(handoffBuildCall?.instructions).not.toContain('book a hotel in goa');
    expect(handoffBuildCall?.handoffContext).toContain('book a hotel in goa');
    expect(handoffBuildCall?.handoffContext).toContain('for two nights');
    expect(handoffBuildCall?.handoffContext).not.toMatch(/\btransfer|transferred|handoff\b/i);
    expect(handoffBuildCall?.handoffContext).not.toContain('Acknowledge');

    const messageCountBeforeHook = parseMessages(ws).length;
    const buildCallCountBeforeHook = mocks.mockBuildGrokLlmVerbPayload.mock.calls.length;

    await ws.emitMessage({
      type: 'verb:hook',
      msgid: 'msg-hook',
      hook: '/llm-event',
      data: {
        completion_reason: 'normal conversation end',
      },
    });

    const messagesAfterHook = parseMessages(ws);
    expect(messagesAfterHook).toHaveLength(messageCountBeforeHook + 1);
    expect(messagesAfterHook.at(-1)).toEqual({ type: 'ack', msgid: 'msg-hook' });
    expect(mocks.mockBuildGrokLlmVerbPayload).toHaveBeenCalledTimes(buildCallCountBeforeHook);
  });

  it('captures xAI input transcription events into runtime conversation history', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const runtimeSession = createRuntimeSession();
    runtimeSession.conversationHistory = [];

    mocks.mockGetRuntimeExecutor.mockReturnValue({
      createSessionFromResolved: mocks.mockCreateSessionFromResolved,
      executeRealtimeToolCall: vi.fn(),
      addMessage: mocks.mockAddMessage,
    });
    mocks.mockCreateSessionFromResolved.mockReturnValue(runtimeSession);
    mocks.mockAddMessage.mockImplementation((sessionId: string, role: string, content: string) => {
      if (sessionId === runtimeSession.id) {
        runtimeSession.conversationHistory.push({ role, content });
      }
    });

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor',
      headers: {},
    });

    await ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-session',
      call_sid: 'call-grok',
      data: {
        from: '+15550003',
        to: '+15550004',
      },
    });

    await ws.emitMessage({
      type: 'llm:event',
      msgid: 'msg-user',
      data: {
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'i need a hotel in paris',
      },
    });

    expect(mocks.mockAddMessage).toHaveBeenCalledWith(
      'runtime-session-1',
      'user',
      'i need a hotel in paris',
      undefined,
    );
    expect(runtimeSession.conversationHistory).toEqual([
      { role: 'user', content: 'i need a hotel in paris' },
    ]);
  });

  it('rebuilds Grok handoff context from the tool-call message when no user transcript history exists yet', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const runtimeSession = createRuntimeSession();
    runtimeSession.conversationHistory = [];

    const executeRealtimeToolCall = vi.fn().mockResolvedValue({
      result: {
        success: true,
        response: 'Transferring you now.',
      },
      activeAgentName: 'Sales_Agent',
      activeAgentIR: { metadata: { name: 'Sales Agent' } },
    });

    mocks.mockGetRuntimeExecutor.mockReturnValue({
      createSessionFromResolved: mocks.mockCreateSessionFromResolved,
      executeRealtimeToolCall,
      addMessage: mocks.mockAddMessage,
    });
    mocks.mockCreateSessionFromResolved.mockReturnValue(runtimeSession);
    mocks.mockAddMessage.mockImplementation((sessionId: string, role: string, content: string) => {
      if (sessionId === runtimeSession.id) {
        runtimeSession.conversationHistory.push({ role, content });
      }
    });

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor',
      headers: {},
    });

    await ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-session',
      call_sid: 'call-grok',
      data: {
        from: '+15550003',
        to: '+15550004',
      },
    });

    await ws.emitMessage({
      type: 'llm:tool-call',
      msgid: 'msg-tool',
      data: {
        name: 'handoff_to_Sales_Agent',
        tool_call_id: 'call-124',
        args: {
          message: 'book a hotel in paris for two nights',
        },
      },
    });

    await waitForCondition(() => executeRealtimeToolCall.mock.calls.length > 0);

    await ws.emitMessage({
      type: 'llm:event',
      msgid: 'msg-assistant',
      data: {
        type: 'response.output_audio_transcript.done',
        response_id: 'resp-handoff-context',
        transcript: 'Transferring you now.',
      },
    });

    await ws.emitMessage({
      type: 'llm:event',
      msgid: 'msg-done',
      data: {
        type: 'response.done',
        response_id: 'resp-handoff-context',
        response: {
          id: 'resp-handoff-context',
        },
      },
    });

    await waitForCondition(() => mocks.mockBuildGrokLlmVerbPayload.mock.calls.length >= 2);

    expect(mocks.mockBuildGrokLlmVerbPayload).toHaveBeenLastCalledWith(
      expect.objectContaining({
        includeResponseCreate: false,
        handoffContext: expect.stringContaining('The customer previously said:'),
      }),
    );
    expect(mocks.mockBuildGrokLlmVerbPayload).toHaveBeenLastCalledWith(
      expect.objectContaining({
        handoffContext: expect.stringContaining('book a hotel in paris for two nights'),
      }),
    );
    const handoffBuildCall = mocks.mockBuildGrokLlmVerbPayload.mock.calls.at(-1)?.[0] as
      | { handoffContext?: string }
      | undefined;
    expect(handoffBuildCall?.handoffContext).not.toMatch(/\btransfer|transferred|handoff\b/i);
    expect(handoffBuildCall?.handoffContext).not.toContain('Acknowledge');
  });

  it('updates the live session when the transfer response completes before handoff scheduling finishes', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const runtimeSession = createRuntimeSession();
    runtimeSession.conversationHistory = [];

    let resolveToolExecution:
      | ((value: {
          result: { success: boolean; response: string };
          activeAgentName: string;
          activeAgentIR: { metadata: { name: string } };
        }) => void)
      | null = null;

    const executeRealtimeToolCall = vi.fn(
      () =>
        new Promise<{
          result: { success: boolean; response: string };
          activeAgentName: string;
          activeAgentIR: { metadata: { name: string } };
        }>((resolve) => {
          resolveToolExecution = resolve;
        }),
    );

    mocks.mockGetRuntimeExecutor.mockReturnValue({
      createSessionFromResolved: mocks.mockCreateSessionFromResolved,
      executeRealtimeToolCall,
      addMessage: mocks.mockAddMessage,
    });
    mocks.mockCreateSessionFromResolved.mockReturnValue(runtimeSession);
    mocks.mockAddMessage.mockImplementation((sessionId: string, role: string, content: string) => {
      if (sessionId === runtimeSession.id) {
        runtimeSession.conversationHistory.push({ role, content });
      }
    });

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor',
      headers: {},
    });

    await ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-session',
      call_sid: 'call-grok',
      data: {
        from: '+15550003',
        to: '+15550004',
      },
    });

    const toolCallPromise = ws.emitMessage({
      type: 'llm:tool-call',
      msgid: 'msg-tool',
      data: {
        name: 'handoff_to_Sales_Agent',
        tool_call_id: 'call-race',
        args: {
          message: 'book a hotel in goa',
        },
      },
    });

    await waitForCondition(() => executeRealtimeToolCall.mock.calls.length > 0);

    await ws.emitMessage({
      type: 'llm:event',
      msgid: 'msg-transcript-race',
      data: {
        type: 'response.output_audio_transcript.done',
        response_id: 'resp-transfer-1',
        transcript: 'Transferring you now.',
      },
    });

    await ws.emitMessage({
      type: 'llm:event',
      msgid: 'msg-done-race',
      data: {
        type: 'response.done',
        response_id: 'resp-transfer-1',
        response: {
          id: 'resp-transfer-1',
        },
      },
    });

    resolveToolExecution?.({
      result: {
        success: true,
        response: 'Transferring you now.',
      },
      activeAgentName: 'Sales_Agent',
      activeAgentIR: { metadata: { name: 'Sales Agent' } },
    });

    await toolCallPromise;

    const postToolMessages = parseMessages(ws);
    expect(postToolMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'ack', msgid: 'msg-done-race' }),
        expect.objectContaining({
          type: 'command',
          command: 'llm:update',
          data: expect.objectContaining({
            type: 'session.update',
          }),
        }),
        expect.objectContaining({
          type: 'command',
          command: 'llm:update',
          data: expect.objectContaining({
            type: 'response.create',
          }),
        }),
      ]),
    );
    expect(
      postToolMessages.filter(
        (message) => message?.type === 'command' && message?.command === 'redirect',
      ),
    ).toHaveLength(0);
    expect(mocks.mockBuildGrokLlmVerbPayload).toHaveBeenLastCalledWith(
      expect.objectContaining({
        includeResponseCreate: false,
        handoffContext: expect.stringContaining('book a hotel in goa'),
      }),
    );
  });
});

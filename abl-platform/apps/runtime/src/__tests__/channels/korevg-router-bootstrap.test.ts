import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const mockResolveConnectionByIdUnsafe = vi.fn();
  const mockResolveChannelConnection = vi.fn();
  const mockCreateSessionFromResolved = vi.fn();
  const mockInitializeSession = vi.fn();
  const mockEndSession = vi.fn();
  const mockGetRuntimeExecutor = vi.fn();
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
  const mockFindAgentModelConfig = vi.fn();
  const mockLoadConfigVariablesMap = vi.fn();
  const mockPersistMessage = vi.fn().mockResolvedValue(undefined);
  const mockPersistTurnMetrics = vi.fn().mockResolvedValue(undefined);
  const mockEmitTraceEventAsAnalytics = vi.fn();
  const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
  const mockTraceAddEvent = vi.fn(
    (_sessionId: string, event: { type: string; data: Record<string, unknown> }) => {
      traceEvents.push(event);
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
    mockEndSession,
    mockGetRuntimeExecutor,
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
    mockFindAgentModelConfig,
    mockLoadConfigVariablesMap,
    mockPersistMessage,
    mockPersistTurnMetrics,
    mockEmitTraceEventAsAnalytics,
    traceEvents,
    mockTraceAddEvent,
    mockLogger,
  };
});

vi.mock('@abl/compiler/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@abl/compiler/platform')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mocks.mockLogger),
  };
});

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
    addEvent: mocks.mockTraceAddEvent,
    getEvents: vi.fn(() => mocks.traceEvents),
    removeSession: vi.fn(),
    stop: vi.fn(),
  })),
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

vi.mock('../../repos/llm-resolution-repo.js', () => ({
  findAgentModelConfig: (...args: unknown[]) => mocks.mockFindAgentModelConfig(...args),
}));

vi.mock('../../repos/project-repo.js', () => ({
  loadConfigVariablesMap: (...args: unknown[]) => mocks.mockLoadConfigVariablesMap(...args),
}));

vi.mock('../../services/eventstore-singleton.js', () => ({
  getEventStore: vi.fn(() => null),
}));

vi.mock('@abl/eventstore/migration', () => ({
  emitTraceEventAsAnalytics: (...args: unknown[]) => mocks.mockEmitTraceEventAsAnalytics(...args),
}));

import {
  KorevgRouter,
  _extractInitialGreetingForTesting,
  _resolveVoiceEntryAgentForTesting,
} from '../../services/voice/korevg/korevg-router.js';
import {
  buildSessionLocalizationCatalog,
  storeSessionLocalizationCatalog,
} from '../../services/execution/localized-messages.js';
import { KorevgSession } from '../../services/voice/korevg/korevg-session.js';

type MessageHandler = (payload: Buffer) => void | Promise<void>;
type CloseHandler = (code: number, reason: Buffer) => void;
type ErrorHandler = (error: Error) => void;

function createMockWebSocket() {
  const messageHandlers = new Set<MessageHandler>();
  const closeHandlers = new Set<CloseHandler>();
  const errorHandlers = new Set<ErrorHandler>();

  const ws = {
    readyState: 1,
    on: vi.fn((event: string, handler: MessageHandler | CloseHandler | ErrorHandler) => {
      if (event === 'message') {
        messageHandlers.add(handler as MessageHandler);
      } else if (event === 'close') {
        closeHandlers.add(handler as CloseHandler);
      } else if (event === 'error') {
        errorHandlers.add(handler as ErrorHandler);
      }
      return ws;
    }),
    off: vi.fn((event: string, handler: MessageHandler | CloseHandler | ErrorHandler) => {
      if (event === 'message') {
        messageHandlers.delete(handler as MessageHandler);
      } else if (event === 'close') {
        closeHandlers.delete(handler as CloseHandler);
      } else if (event === 'error') {
        errorHandlers.delete(handler as ErrorHandler);
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
    emitError(error: Error) {
      for (const handler of [...errorHandlers]) {
        handler(error);
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
    },
  };
}

function createResolvedAgent(overrides?: Record<string, unknown>) {
  return {
    entryAgent: 'supervisor',
    compilationOutput: {
      entry_agent: 'supervisor',
    },
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

const OVERSIZED_SESSION_METADATA = {
  big: 'x'.repeat(70_000),
};

function createRuntimeSession(overrides?: Record<string, unknown>) {
  return {
    id: 'runtime-session-1',
    agentName: 'supervisor',
    agentIR: {
      metadata: { name: 'supervisor' },
      identity: { system_prompt: { template: 'You are helpful.' } },
      tools: [],
    },
    _effectiveConfig: {},
    data: {
      values: {},
    },
    conversationHistory: [],
    toolExecutor: { execute: vi.fn() },
    ...overrides,
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

  throw new Error('Timed out waiting for KoreVG bootstrap condition');
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

describe('KorevgRouter greeting localization', () => {
  it('extracts localized greetings from locale assets before raw agent messages', () => {
    const session = {
      agentName: 'WelcomeAgent',
      agentIR: {
        metadata: { name: 'WelcomeAgent' },
        messages: {
          welcome: 'Welcome in English',
        },
      },
      data: {
        values: {
          _locale: 'fr-CA',
        },
        gatheredKeys: new Set<string>(),
      },
    } as any;

    storeSessionLocalizationCatalog(
      session.data,
      buildSessionLocalizationCatalog({
        'locale:fr/welcomeagent.json': JSON.stringify({
          welcome: 'Bienvenue en francais',
        }),
      }),
    );

    expect(_extractInitialGreetingForTesting(session)).toBe('Bienvenue en francais');
  });
});

describe('KorevgRouter bootstrap with real KorevgSession', () => {
  const routers = new Set<KorevgRouter>();
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.traceEvents.length = 0;
    process.env.NODE_ENV = 'test';

    mocks.mockGetRuntimeExecutor.mockReturnValue({
      createSessionFromResolved: mocks.mockCreateSessionFromResolved,
      initializeSession: mocks.mockInitializeSession,
      endSession: mocks.mockEndSession,
      getSession: vi.fn(() => createRuntimeSession()),
    });
    mocks.mockCreateSessionFromResolved.mockReturnValue(createRuntimeSession());
    mocks.mockDeploymentResolve.mockResolvedValue(createResolvedAgent());
    mocks.mockResolveConnectionByIdUnsafe.mockResolvedValue(createConnection());
    mocks.mockResolveChannelConnection.mockResolvedValue(null);
    mocks.mockExtractIngressToken.mockReturnValue('voice-secret');
    mocks.mockTokensMatch.mockReturnValue(true);
    mocks.mockResolveVoiceCredentials.mockResolvedValue({
      stt: { apiKey: 'deepgram-key', model: 'nova-3' },
      tts: { apiKey: 'elevenlabs-key', voiceId: 'Bella' },
    });
    mocks.mockResolveVoiceMode.mockResolvedValue('pipeline');
    mocks.mockResolveS2SCredentials.mockResolvedValue(null);
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
    mocks.mockFindAgentModelConfig.mockResolvedValue({ useStreaming: true });
    mocks.mockLoadConfigVariablesMap.mockResolvedValue({});
    mocks.mockInitializeSession.mockImplementation(
      async (
        _sessionId: string,
        onChunk?: (chunk: string) => void,
        _onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
      ) => {
        const responseMetadata = {
          isLlmGenerated: true,
          responseProvenance: {
            schemaVersion: 1 as const,
            kind: 'llm' as const,
            disclaimerRequired: true,
            usedLlmInternally: true,
          },
        };
        onChunk?.('Hello from init result.');
        return {
          response: 'Hello from init result.',
          action: { type: 'continue' },
          responseMetadata,
        };
      },
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

  it('captures session:new early, creates a real KorevgSession, and buffers the greeting after the answer ack', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const connectionPromise = deferred<ReturnType<typeof createConnection>>();

    mocks.mockResolveConnectionByIdUnsafe.mockReturnValue(connectionPromise.promise);

    const setupPromise = (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor&caller=%2B15550001&called=%2B15550002',
      headers: {},
    });

    await ws.emitMessage({
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

    await waitForCondition(() => ws.send.mock.calls.length >= 2);
    await waitForCondition(() =>
      mocks.traceEvents.some((event) => event.type === 'voice_session_start'),
    );
    await waitForCondition(() => mocks.mockPersistMessage.mock.calls.length >= 1);

    const session = Array.from((router as any).sessions.values())[0];

    expect(session).toBeInstanceOf(KorevgSession);
    expect(mocks.mockCreateSessionFromResolved).toHaveBeenCalledWith(
      createResolvedAgent(),
      expect.objectContaining({
        channelType: 'voice',
        deploymentId: 'deployment-1',
        scope: expect.objectContaining({
          kind: 'production',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          sessionId: expect.any(String),
          source: 'korevg_voice',
        }),
      }),
    );
    expect(mocks.mockInitializeSession).toHaveBeenCalledWith(
      'runtime-session-1',
      expect.any(Function),
      expect.any(Function),
    );
    expect(mocks.mockFindAgentModelConfig).toHaveBeenCalledWith(
      'project-1',
      'supervisor',
      'tenant-1',
    );
    expect(ws.send.mock.invocationCallOrder[0]).toBeLessThan(ws.send.mock.invocationCallOrder[1]);

    const answerAck = JSON.parse(ws.send.mock.calls[0][0]);
    expect(answerAck).toEqual({
      type: 'ack',
      msgid: 'msg-1',
      data: [{ verb: 'answer' }],
    });

    const greetingRedirect = JSON.parse(ws.send.mock.calls[1][0]);
    expect(greetingRedirect).toMatchObject({
      type: 'command',
      command: 'redirect',
    });
    expect(greetingRedirect.data[0]).toMatchObject({
      verb: 'config',
      ttsStream: { enable: true },
    });
    expect(greetingRedirect.data).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ verb: 'say' })]),
    );

    expect((session as any).ttsBuffer).toEqual(['Hello from init result.']);
    expect(mocks.mockPersistMessage).toHaveBeenCalledWith(
      'db-session-1',
      'assistant',
      'Hello from init result.',
      'voice',
      'tenant-1',
      undefined,
      undefined,
      'project-1',
      undefined,
      undefined,
      {
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1,
          kind: 'llm',
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
      },
    );
    expect(mocks.traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'voice_session_start',
          data: expect.objectContaining({
            callSid: 'call-1',
            caller: '+15550001',
            called: '+15550002',
            ttsVendor: expect.any(String),
            sttVendor: 'deepgram',
          }),
        }),
      ]),
    );
  });

  it('hydrates the runtime session localization catalog during voice bootstrap', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const runtimeSession = createRuntimeSession();
    mocks.mockCreateSessionFromResolved.mockReturnValue(runtimeSession);
    mocks.mockLoadConfigVariablesMap.mockResolvedValueOnce({
      'locale:fr/_shared.json': JSON.stringify({
        greet_new_visitor: 'Bonjour depuis le catalogue.',
      }),
    });

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor&caller=%2B15550001&called=%2B15550002',
      headers: {},
    });

    await ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-locale',
      call_sid: 'call-locale',
      data: {
        from: '+15550001',
        to: '+15550002',
      },
    });

    const catalog = (
      runtimeSession.data.values.session as {
        _localizedMessageCatalog?: {
          locales?: Record<string, { shared?: { greet_new_visitor?: string } }>;
        };
      }
    )._localizedMessageCatalog;

    expect(catalog?.locales?.fr?.shared?.greet_new_visitor).toBe('Bonjour depuis le catalogue.');
  });

  it('forwards configured alternative ASR languages into the KoreVG recognizer config', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const connectionPromise = deferred<ReturnType<typeof createConnection>>();
    mocks.mockResolveConnectionByIdUnsafe.mockReturnValue(connectionPromise.promise);
    const connection = {
      ...createConnection(),
      config: {
        inboundAuthToken: 'voice-secret',
        mode: 'pipeline',
        asrVendor: 'microsoft',
        asrLanguage: 'en-US',
        asrAlternativeLanguages: ['zh-CN', 'es-MX'],
      },
    };

    const setupPromise = (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor&caller=%2B15550001&called=%2B15550002',
      headers: {},
    });

    await ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-alt-languages',
      call_sid: 'call-alt-languages',
      data: {
        from: '+15550001',
        to: '+15550002',
      },
    });

    connectionPromise.resolve(connection);
    await setupPromise;
    await waitForCondition(() => ws.send.mock.calls.length >= 2);

    const greetingRedirect = JSON.parse(ws.send.mock.calls[1][0]);
    expect(greetingRedirect.data[0]).toMatchObject({
      verb: 'config',
      recognizer: {
        vendor: 'microsoft',
        language: 'en-US',
        altLanguages: ['zh-CN', 'es-MX'],
      },
    });
  });

  it('links a resolved contact during pipeline bootstrap when KorevgSession creates the DB session', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();

    mocks.mockResolveContactIdFromChannelIdentity.mockResolvedValue('contact-korevg-pipeline-1');

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor&caller=%2B15550011&called=%2B15550012',
      headers: {},
    });

    await ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-contact',
      call_sid: 'call-contact',
      data: {
        from: '+15550011',
        to: '+15550012',
      },
    });

    await waitForCondition(() => mocks.mockCreateAndLinkDBSession.mock.calls.length > 0);

    expect(mocks.mockCreateAndLinkDBSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'runtime-session-1',
        contactId: 'contact-korevg-pipeline-1',
      }),
    );
    expect(mocks.mockLinkResolvedContactToSession).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        channelType: 'korevg',
        sessionId: 'runtime-session-1',
        contactId: 'contact-korevg-pipeline-1',
      }),
    );
  });

  it('uses the runtime-selected DSL agent IR when the requested voice entry agent is stale', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();

    mocks.mockDeploymentResolve.mockResolvedValue(
      createResolvedAgent({
        entryAgent: 'Eugene',
        compilationOutput: {
          entry_agent: 'BankingVirtualAssistant',
        },
        agents: {
          BankingVirtualAssistant: {
            metadata: { name: 'BankingVirtualAssistant' },
            identity: { system_prompt: { template: 'You are helpful.' } },
            tools: [],
          },
        },
      }),
    );
    mocks.mockCreateSessionFromResolved.mockReturnValue(
      createRuntimeSession({
        agentName: 'Eugene',
        agentIR: {
          metadata: { name: 'BankingVirtualAssistant' },
          identity: { system_prompt: { template: 'You are helpful.' } },
          tools: [],
        },
      }),
    );

    await (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-Eugene&caller=%2B15550021&called=%2B15550022',
      headers: {},
    });

    await ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-mismatch',
      call_sid: 'call-mismatch',
      data: {
        from: '+15550021',
        to: '+15550022',
      },
    });

    await waitForCondition(() => mocks.mockResolveVoiceMode.mock.calls.length > 0);

    expect(mocks.mockResolveVoiceMode).toHaveBeenCalledWith(
      expect.objectContaining({
        agentIR: expect.objectContaining({
          metadata: expect.objectContaining({
            name: 'BankingVirtualAssistant',
          }),
        }),
      }),
    );
    expect(mocks.mockLogger.warn).toHaveBeenCalledWith(
      '[VOICE_MODE] Entry agent mismatch resolved for voice bootstrap',
      expect.objectContaining({
        requestedEntryAgent: 'Eugene',
        resolvedEntryAgent: 'BankingVirtualAssistant',
        resolvedBy: 'runtime_session',
      }),
    );
    expect(ws.close).not.toHaveBeenCalledWith(1011, 'Agent configuration error');
  });

  it('fails closed when KoreVG bootstrap URL metadata is oversized', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();

    await (router as any).handleConnection(ws, {
      url: `/ws/korevg/conn-1?agentId=agent-supervisor&sessionMetadata=${encodeURIComponent(JSON.stringify(OVERSIZED_SESSION_METADATA))}`,
      headers: {},
    });

    expect(ws.close).toHaveBeenCalledWith(1008, 'Invalid session metadata');
    expect(mocks.mockCreateSessionFromResolved).not.toHaveBeenCalled();
  });

  it('fails closed when early session:new metadata is oversized before bootstrap completes', async () => {
    const router = createRouter();
    const ws = createMockWebSocket();
    const connectionPromise = deferred<ReturnType<typeof createConnection>>();

    mocks.mockResolveConnectionByIdUnsafe.mockReturnValue(connectionPromise.promise);

    const setupPromise = (router as any).handleConnection(ws, {
      url: '/ws/korevg/conn-1?agentId=agent-supervisor',
      headers: {},
    });

    await ws.emitMessage({
      type: 'session:new',
      msgid: 'msg-metadata-invalid',
      call_sid: 'call-invalid-metadata',
      data: {
        sessionMetadata: OVERSIZED_SESSION_METADATA,
      },
    });

    connectionPromise.resolve(createConnection());
    await setupPromise;

    expect(ws.close).toHaveBeenCalledWith(1008, 'Invalid session metadata');
    expect(mocks.mockCreateSessionFromResolved).not.toHaveBeenCalled();
  });
});

describe('resolveVoiceEntryAgent', () => {
  it('prefers the requested entry agent when it exists in resolved agents', () => {
    const requestedAgentIR = {
      metadata: { name: 'Supervisor' },
      identity: { system_prompt: { template: 'You are helpful.' } },
      tools: [],
    };

    expect(
      _resolveVoiceEntryAgentForTesting({
        requestedEntryAgent: 'supervisor',
        compilationEntryAgent: 'supervisor',
        resolvedAgents: {
          supervisor: requestedAgentIR,
        },
        runtimeAgentIR: {
          metadata: { name: 'supervisor' },
          identity: { system_prompt: { template: 'Stale runtime IR' } },
          tools: [],
        },
      }),
    ).toEqual({
      agentIR: requestedAgentIR,
      agentName: 'supervisor',
      resolvedBy: 'requested',
    });
  });

  it('uses the runtime-selected DSL identity only when it exists in resolved agents', () => {
    const resolvedRuntimeAgentIR = {
      metadata: { name: 'BankingVirtualAssistant' },
      identity: { system_prompt: { template: 'Resolved runtime IR' } },
      tools: [],
    };
    const runtimeSessionAgentIR = {
      metadata: { name: 'BankingVirtualAssistant' },
      identity: { system_prompt: { template: 'Orphaned runtime snapshot' } },
      tools: [],
    };

    expect(
      _resolveVoiceEntryAgentForTesting({
        requestedEntryAgent: 'Eugene',
        compilationEntryAgent: undefined,
        resolvedAgents: {
          BankingVirtualAssistant: resolvedRuntimeAgentIR,
        },
        runtimeAgentIR: runtimeSessionAgentIR,
      }),
    ).toEqual({
      agentIR: resolvedRuntimeAgentIR,
      agentName: 'BankingVirtualAssistant',
      resolvedBy: 'runtime_session',
    });
  });

  it('falls back to the compiled entry agent when the requested name is stale', () => {
    const compiledEntryAgentIR = {
      metadata: { name: 'BankingVirtualAssistant' },
      identity: { system_prompt: { template: 'Compiled entry IR' } },
      tools: [],
    };

    expect(
      _resolveVoiceEntryAgentForTesting({
        requestedEntryAgent: 'Eugene',
        compilationEntryAgent: 'BankingVirtualAssistant',
        resolvedAgents: {
          BankingVirtualAssistant: compiledEntryAgentIR,
        },
        runtimeAgentIR: null,
      }),
    ).toEqual({
      agentIR: compiledEntryAgentIR,
      agentName: 'BankingVirtualAssistant',
      resolvedBy: 'compilation_entry',
    });
  });

  it('falls back to the sole compiled agent when there is only one valid candidate', () => {
    const soleAgentIR = {
      metadata: { name: 'BankingVirtualAssistant' },
      identity: { system_prompt: { template: 'Only agent IR' } },
      tools: [],
    };

    expect(
      _resolveVoiceEntryAgentForTesting({
        requestedEntryAgent: 'Eugene',
        compilationEntryAgent: undefined,
        resolvedAgents: {
          BankingVirtualAssistant: soleAgentIR,
        },
        runtimeAgentIR: {
          metadata: { name: 'OrphanedRuntimeAgent' },
          identity: { system_prompt: { template: 'Orphaned runtime IR' } },
          tools: [],
        },
      }),
    ).toEqual({
      agentIR: soleAgentIR,
      agentName: 'BankingVirtualAssistant',
      resolvedBy: 'single_agent',
    });
  });

  it('uses fuzzy matching when compiled agent keys include a namespace suffix', () => {
    const fuzzyAgentIR = {
      metadata: { name: 'tenant_BankingVirtualAssistant' },
      identity: { system_prompt: { template: 'Namespaced agent IR' } },
      tools: [],
    };

    expect(
      _resolveVoiceEntryAgentForTesting({
        requestedEntryAgent: 'BankingVirtualAssistant',
        compilationEntryAgent: undefined,
        resolvedAgents: {
          tenant_BankingVirtualAssistant: fuzzyAgentIR,
          OtherAgent: {
            metadata: { name: 'OtherAgent' },
            identity: { system_prompt: { template: 'Other agent IR' } },
            tools: [],
          },
        },
        runtimeAgentIR: null,
      }),
    ).toEqual({
      agentIR: fuzzyAgentIR,
      agentName: 'tenant_BankingVirtualAssistant',
      resolvedBy: 'fuzzy',
    });
  });

  it('uses fuzzy matching for case-only agent name drift', () => {
    const caseMismatchAgentIR = {
      metadata: { name: 'Supervisor' },
      identity: { system_prompt: { template: 'Supervisor agent IR' } },
      tools: [],
    };

    expect(
      _resolveVoiceEntryAgentForTesting({
        requestedEntryAgent: 'supervisor',
        compilationEntryAgent: undefined,
        resolvedAgents: {
          Supervisor: caseMismatchAgentIR,
          LoanAssistant: {
            metadata: { name: 'LoanAssistant' },
            identity: { system_prompt: { template: 'Loan assistant IR' } },
            tools: [],
          },
        },
        runtimeAgentIR: null,
      }),
    ).toEqual({
      agentIR: caseMismatchAgentIR,
      agentName: 'Supervisor',
      resolvedBy: 'fuzzy',
    });
  });

  it('returns null when there is no valid way to reconcile the entry agent identity', () => {
    expect(
      _resolveVoiceEntryAgentForTesting({
        requestedEntryAgent: 'Eugene',
        compilationEntryAgent: 'Supervisor',
        resolvedAgents: {
          BankingVirtualAssistant: {
            metadata: { name: 'BankingVirtualAssistant' },
            identity: { system_prompt: { template: 'Banking agent IR' } },
            tools: [],
          },
          LoanAssistant: {
            metadata: { name: 'LoanAssistant' },
            identity: { system_prompt: { template: 'Loan agent IR' } },
            tools: [],
          },
        },
        runtimeAgentIR: {
          metadata: { name: 'OrphanedRuntimeAgent' },
          identity: { system_prompt: { template: 'Orphaned runtime IR' } },
          tools: [],
        },
      }),
    ).toBeNull();
  });
});

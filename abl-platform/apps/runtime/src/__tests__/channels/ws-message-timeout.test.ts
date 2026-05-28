/**
 * WebSocket Message Processing Timeout Tests
 *
 * Tests the timeout wrapper pattern used in the WS message handler and the
 * WS_MESSAGE_TIMEOUT_MS constant. The timeout wrapper uses a fail-closed
 * timer to cancel the active execution, send an error to the client, and
 * close the socket when message processing exceeds the deadline.
 *
 * The integration point (sdk-handler.ts ws.on('message')) is tested through
 * a full connection flow with a deferred LLM queue promise to control timing.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { signSDKSessionToken } from '@agent-platform/shared-auth';

// =============================================================================
// MOCK DECLARATIONS — must come before any import that pulls them in
// =============================================================================

const mockGetRuntimeExecutor = vi.fn() as any;
const mockGetSessionService = vi.fn() as any;
const mockPersistMessage = vi.fn(async () => {}) as any;
const mockPersistTurnMetrics = vi.fn(async () => {}) as any;
const mockResolveVoiceSession = vi.fn() as any;
const mockServerApp: { locals: Record<string, any> } = { locals: {} };
const mockFindSDKChannelById = vi.fn(async () => null) as any;
const mockFindPublicApiKey = vi.fn(async () => null) as any;
const mockFindWidgetConfig = vi.fn(async () => null) as any;
const mockUpdateSDKChannel = vi.fn(async () => null) as any;
const mockFindDeploymentById = vi.fn(async () => null) as any;
const mockFindActiveDeployment = vi.fn(async () => null) as any;

vi.mock('../../services/runtime-executor.js', () => ({
  getRuntimeExecutor: (...args: any[]) => mockGetRuntimeExecutor(...args),
  compileToResolvedAgent: vi.fn(async () => undefined),
  resolveProjectTools: vi.fn(async () => undefined),
}));

vi.mock('../../services/llm/session-llm-client.js', () => ({
  TRACE_MODEL_UNKNOWN: 'unknown-model',
}));

/**
 * Deferred promise for the LLM queue — lets tests control when the LLM
 * response resolves, enabling precise timeout testing.
 */
let llmQueueResolve: (value: any) => void;
let llmQueuePromise: Promise<any>;

function resetLLMQueuePromise() {
  llmQueuePromise = new Promise((resolve) => {
    llmQueueResolve = resolve;
  });
}

const mockEnqueueLLMRequest = vi.fn(() => llmQueuePromise) as any;

vi.mock('../../services/llm/llm-queue.js', () => ({
  enqueueLLMRequest: (
    sessionId: string,
    message: string,
    onChunk?: (chunk: string) => void,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
    tenantId?: string,
    execOptions?: { signal?: AbortSignal },
  ) => mockEnqueueLLMRequest(sessionId, message, onChunk, onTraceEvent, tenantId, execOptions),
  BackpressureError: class BackpressureError extends Error {
    constructor(msg?: string) {
      super(msg || 'backpressure');
      this.name = 'BackpressureError';
    }
  },
  isLLMQueueEnabled: vi.fn(() => true),
}));

vi.mock('../../db/index.js', () => ({
  isDatabaseAvailable: vi.fn(() => false),
}));

const TEST_JWT_SECRET = 'test-jwt-secret-for-ws-timeout';
const TEST_SDK_SESSION_SIGNING_SECRET = 'test-sdk-session-signing-secret-for-ws-timeout';
const TEST_SDK_BOOTSTRAP_SIGNING_SECRET = 'test-sdk-bootstrap-signing-secret-for-ws-timeout';

vi.mock('../../config/index.js', () => ({
  getConfig: vi.fn(() => ({
    env: 'test',
    jwt: { secret: 'test-jwt-secret-for-ws-timeout' },
    auth: {
      sdk: {
        sessionSigningSecret: TEST_SDK_SESSION_SIGNING_SECRET,
        bootstrapSigningSecret: TEST_SDK_BOOTSTRAP_SIGNING_SECRET,
      },
    },
    llm: { provider: 'openai', defaultModel: 'gpt-4o-mini' },
    security: { superAdminUserIds: [] },
    channelLifecycle: {
      web_chat: { defaultDisposition: 'abandoned', disconnectBehavior: 'detach' },
      api: { defaultDisposition: 'completed', disconnectBehavior: 'end' },
    },
  })),
}));

vi.mock('../../middleware/auth.js', () => ({
  SDK_TOKEN_ISSUER: 'agent-platform',
  SDK_TOKEN_AUDIENCE: 'sdk-session',
  extractUserIdFromToken: vi.fn(),
}));

vi.mock('../../services/stores/store-factory.js', () => ({
  getStores: vi.fn(() => ({
    conversation: {
      createSession: vi.fn(async () => ({ id: 'db-session-1' })),
      getSession: vi.fn(async () => null),
      updateSession: vi.fn(async () => ({})),
      endSession: vi.fn(async () => {}),
    },
  })),
}));

vi.mock('../../repos/session-repo.js', () => ({
  findSessionById: vi.fn(async () => null),
  findSessionByRuntimeId: vi.fn(async () => null),
  updateSession: vi.fn(async () => ({})),
}));

vi.mock('../../repos/project-repo.js', () => ({
  findProjectWithAgents: vi.fn(async () => null),
  findProjectAgentForProject: vi.fn(async () => null),
}));

vi.mock('../../repos/channel-repo.js', () => ({
  findPublicApiKey: (...args: any[]) => mockFindPublicApiKey(...args),
  findSDKChannelById: (...args: any[]) => mockFindSDKChannelById(...args),
  findWidgetConfig: (...args: any[]) => mockFindWidgetConfig(...args),
  updateSDKChannel: (...args: any[]) => mockUpdateSDKChannel(...args),
}));

vi.mock('../../repos/deployment-repo.js', () => ({
  findActiveDeployment: (...args: any[]) => mockFindActiveDeployment(...args),
  findDeploymentById: (...args: any[]) => mockFindDeploymentById(...args),
}));

vi.mock('../../services/deployment-resolver.js', () => ({
  DeploymentResolver: class MockDeploymentResolver {
    resolve = vi.fn(async () => ({
      entryAgent: 'test_agent',
      agents: {},
      compilationOutput: { agents: {} },
      sourceHash: 'abc',
      versionInfo: { versions: { test_agent: 1 }, environment: 'dev' },
    }));
  },
  mergeWorkingCopyModules: vi.fn(async (working: unknown) => working),
}));

vi.mock('../../services/session/session-service.js', () => ({
  getSessionService: (...args: any[]) => mockGetSessionService(...args),
}));

vi.mock('../../services/message-persistence-queue.js', () => ({
  persistMessage: (...args: any[]) => mockPersistMessage(...args),
  persistMessageRecord: vi.fn(async () => {}),
  persistTurnMetrics: (...args: any[]) => mockPersistTurnMetrics(...args),
  flushMessageQueue: vi.fn(async () => {}),
}));

vi.mock('../../services/voice/deepgram-service.js', () => ({
  getDeepgramService: vi.fn(() => ({
    isConfigured: vi.fn(() => false),
    createConnection: vi.fn(),
  })),
}));

vi.mock('../../services/voice/elevenlabs-service.js', () => ({
  getElevenLabsService: vi.fn(() => ({
    isConfigured: vi.fn(() => false),
  })),
}));

vi.mock('../../services/voice/voice-service-factory.js', () => ({}));

vi.mock('../../services/voice/voice-session-resolver.js', () => ({
  resolveVoiceSession: (...args: any[]) => mockResolveVoiceSession(...args),
}));

vi.mock('../../server.js', () => ({
  app: mockServerApp,
}));

vi.mock('../../observability/voice-trace.js', () => ({
  startVoiceTurn: vi.fn(),
  getActiveVoiceTurn: vi.fn(),
  startSTTPhase: vi.fn(),
  completeSTTPhase: vi.fn(),
  startLLMPhase: vi.fn(),
  completeLLMPhase: vi.fn(),
  startTTSPhase: vi.fn(),
  recordTTSFirstChunk: vi.fn(),
  completeTTSPhase: vi.fn(),
  completeVoiceTurn: vi.fn(),
  failVoiceTurn: vi.fn(),
  createTimingReportEvent: vi.fn(),
}));

vi.mock('../../services/stores/clickhouse-message-store.js', () => ({
  ClickHouseMessageStore: vi.fn(),
}));

vi.mock('../../services/stores/clickhouse-metrics-store.js', () => ({
  ClickHouseMetricsStore: vi.fn(),
}));

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: vi.fn(),
}));

vi.mock('@agent-platform/shared/encryption', () => ({
  getEncryptionService: vi.fn(),
}));

vi.mock('../../observability/metrics.js', () => ({
  recordWsRateLimitRejection: vi.fn(),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  checkSessionMessageRate: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock('../../services/trace-store.js', () => ({
  getTraceStore: vi.fn().mockReturnValue({ addEvent: vi.fn() }),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// =============================================================================
// IMPORT UNDER TEST (after all mocks)
// =============================================================================

import { handleSDKConnection, sdkClients } from '../../websocket/sdk-handler.js';
import { WS_MESSAGE_TIMEOUT_MS } from '../../services/channel/constants.js';

// =============================================================================
// HELPERS
// =============================================================================

class MockWebSocket extends EventEmitter {
  OPEN = 1 as const;
  readyState = 1;
  send = vi.fn();
  close = vi.fn((_code?: number, _reason?: string) => {
    this.readyState = 3;
  });

  simulateMessage(data: string) {
    this.emit('message', Buffer.from(data));
  }
}

function makeReq(
  params: { token?: string; queryToken?: string; protocolHeader?: string } = {},
): any {
  const query = new URLSearchParams();
  if (params.queryToken) query.set('token', params.queryToken);
  const qs = query.toString();
  const protocolHeader =
    params.protocolHeader ?? (params.token ? `sdk-auth, ${params.token}` : undefined);
  return {
    url: `/ws/sdk${qs ? `?${qs}` : ''}`,
    headers: {
      host: 'localhost:3112',
      ...(protocolHeader ? { 'sec-websocket-protocol': protocolHeader } : {}),
    },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

function createSDKToken(overrides: Record<string, any> = {}): string {
  return signSDKSessionToken(
    {
      type: 'sdk_session',
      source: 'sdk',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      channelId: 'channel-1',
      sessionId: 'sdk-session-1',
      permissions: ['session:send_message', 'session:voice'],
      bootstrapType: 'public_key',
      bootstrapKeyId: 'pk-1',
      ...overrides,
    },
    TEST_SDK_SESSION_SIGNING_SECRET,
    { expiresIn: '1h' },
  );
}

function makeMockExecutor() {
  return {
    isConfigured: vi.fn(() => true),
    createSessionFromResolved: vi.fn(),
    executeMessage: vi.fn(async () => ({
      response: 'ok',
      action: { type: 'continue' },
      stateUpdates: { gatherProgress: {}, context: {}, conversationPhase: 'active' },
    })),
    getSession: vi.fn(() => undefined),
    endSession: vi.fn(),
    detachSession: vi.fn(),
    ensureLLMReady: vi.fn(async () => {}),
    saveSessionSnapshot: vi.fn(async () => {}),
    checkSessionQuota: vi.fn(),
    releaseSessionSlot: vi.fn(),
  };
}

function getSentMessages(ws: MockWebSocket): any[] {
  return ws.send.mock.calls.map((call) => JSON.parse(String(call[0])));
}

function findAllOfType(ws: MockWebSocket, type: string, message?: string): any[] {
  const msgs = getSentMessages(ws).filter((m: any) => m.type === type);
  if (message !== undefined) return msgs.filter((m: any) => m.message === message);
  return msgs;
}

// =============================================================================
// TESTS
// =============================================================================

describe('WS_MESSAGE_TIMEOUT_MS constant', () => {
  test('defaults to 90000ms (90 seconds)', () => {
    expect(WS_MESSAGE_TIMEOUT_MS).toBe(90_000);
  });

  test('is a positive finite number', () => {
    expect(Number.isFinite(WS_MESSAGE_TIMEOUT_MS)).toBe(true);
    expect(WS_MESSAGE_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('WebSocket message processing timeout — fail-closed wrapper', () => {
  /**
   * These tests verify the timer-based timeout wrapper directly,
   * independent of the full WebSocket connection flow.
   */

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('timeout fires when operation exceeds the deadline', async () => {
    const logError = vi.fn();
    const sendError = vi.fn();
    const closeSocket = vi.fn();

    let timedOut = false;
    const messagePromise = new Promise<void>(() => {
      // Never resolves — simulates a hung LLM call
    });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      logError('Message processing timeout');
      sendError('Request timed out');
      closeSocket('Request timed out');
    }, WS_MESSAGE_TIMEOUT_MS);

    void messagePromise
      .catch((err) => {
        if (timedOut) {
          return;
        }
        logError(err.message);
        sendError('Failed to process message');
      })
      .finally(() => {
        clearTimeout(timeoutHandle);
      });

    // Before timeout — no error
    await vi.advanceTimersByTimeAsync(WS_MESSAGE_TIMEOUT_MS - 1);
    expect(logError).not.toHaveBeenCalled();
    expect(sendError).not.toHaveBeenCalled();
    expect(closeSocket).not.toHaveBeenCalled();

    // After timeout fires
    await vi.advanceTimersByTimeAsync(2);
    expect(logError).toHaveBeenCalledWith('Message processing timeout');
    expect(sendError).toHaveBeenCalledWith('Request timed out');
    expect(closeSocket).toHaveBeenCalledWith('Request timed out');
  });

  test('no timeout error when operation completes before deadline', async () => {
    const sendError = vi.fn();
    const closeSocket = vi.fn();

    let timedOut = false;
    const messagePromise = Promise.resolve();

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      sendError('Request timed out');
      closeSocket('Request timed out');
    }, WS_MESSAGE_TIMEOUT_MS);

    void messagePromise
      .catch(() => {
        if (timedOut) {
          return;
        }
        sendError('Failed to process message');
      })
      .finally(() => {
        clearTimeout(timeoutHandle);
      });

    // Advance past timeout — but messagePromise already resolved
    await vi.advanceTimersByTimeAsync(WS_MESSAGE_TIMEOUT_MS + 1000);
    expect(sendError).not.toHaveBeenCalled();
    expect(closeSocket).not.toHaveBeenCalled();
  });

  test('late operation errors do not emit a second user-visible error after timeout', async () => {
    const logError = vi.fn();
    const sendError = vi.fn();
    const closeSocket = vi.fn();

    let timedOut = false;
    let rejectMessagePromise!: (error: Error) => void;
    const messagePromise = new Promise<void>((_resolve, reject) => {
      rejectMessagePromise = reject;
    });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      logError('Message processing timeout');
      sendError('Request timed out');
      closeSocket('Request timed out');
    }, WS_MESSAGE_TIMEOUT_MS);

    void messagePromise
      .catch((err) => {
        if (timedOut) {
          return;
        }
        logError(err.message);
        sendError('Failed to process message');
      })
      .finally(() => {
        clearTimeout(timeoutHandle);
      });

    await vi.advanceTimersByTimeAsync(WS_MESSAGE_TIMEOUT_MS + 1);
    rejectMessagePromise(new Error('LLM provider down'));
    await vi.advanceTimersByTimeAsync(0);

    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith('Message processing timeout');
    expect(sendError).toHaveBeenCalledTimes(1);
    expect(sendError).toHaveBeenCalledWith('Request timed out');
    expect(closeSocket).toHaveBeenCalledWith('Request timed out');
  });
});

describe('WebSocket message processing timeout — integration', () => {
  let ws: MockWebSocket;

  beforeEach(async () => {
    vi.clearAllMocks();
    sdkClients.clear();
    mockPersistMessage.mockClear();
    mockPersistTurnMetrics.mockClear();
    mockResolveVoiceSession.mockReset();
    mockServerApp.locals = {};
    mockFindSDKChannelById.mockResolvedValue({
      id: 'channel-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      isActive: true,
      publicApiKeyId: 'pk-1',
      deploymentId: null,
      environment: null,
      followEnvironment: false,
    });
    mockFindPublicApiKey.mockResolvedValue({
      id: 'pk-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      isActive: true,
      permissions: { chat: true, voice: true },
    });
    mockFindWidgetConfig.mockResolvedValue({ chatEnabled: true, voiceEnabled: true });
    mockFindDeploymentById.mockResolvedValue(null);
    mockFindActiveDeployment.mockResolvedValue(null);
    mockUpdateSDKChannel.mockResolvedValue(null);

    ws = new MockWebSocket();
    const executor = makeMockExecutor();
    mockGetRuntimeExecutor.mockReturnValue(executor);
    mockGetSessionService.mockReturnValue({
      isDistributed: vi.fn(() => false),
      store: {},
    });

    resetLLMQueuePromise();
    mockEnqueueLLMRequest.mockReset();
    mockEnqueueLLMRequest.mockImplementation(() => llmQueuePromise);

    // Connect client (real timers during connection — no timer conflicts)
    const token = createSDKToken();
    await handleSDKConnection(ws as any, makeReq({ token }));

    // Clear messages from connection phase
    ws.send.mockClear();

    // NOW activate fake timers for the timeout tests
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('sends timeout error to client and closes the socket when chat message processing hangs', async () => {
    // Send a chat message — the LLM queue will never resolve
    ws.simulateMessage(JSON.stringify({ type: 'chat_message', text: 'hello', messageId: 'msg-1' }));

    // Let microtasks settle (message handler async code before the queue await)
    await vi.advanceTimersByTimeAsync(100);

    // Before timeout — no timeout error
    const earlyErrors = findAllOfType(ws, 'error', 'Request timed out');
    expect(earlyErrors.length).toBe(0);

    // Advance to trigger timeout
    await vi.advanceTimersByTimeAsync(WS_MESSAGE_TIMEOUT_MS);

    // Timeout error should be sent
    const timeoutErrors = findAllOfType(ws, 'error', 'Request timed out');
    expect(timeoutErrors.length).toBe(1);
    expect(ws.close).toHaveBeenCalledWith(4011, 'Request timed out');
    const execOptions = mockEnqueueLLMRequest.mock.calls[0]?.[5] as
      | { signal?: AbortSignal }
      | undefined;
    expect(execOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(execOptions?.signal?.aborted).toBe(true);

    // Clean up
    llmQueueResolve({
      response: 'late',
      action: { type: 'continue' },
      stateUpdates: { gatherProgress: {}, context: {}, conversationPhase: 'active' },
    });
    await vi.advanceTimersByTimeAsync(0);
  });

  test('no timeout error when chat completes quickly', async () => {
    // Override to resolve fast
    mockEnqueueLLMRequest.mockImplementation(async () => ({
      response: 'fast',
      action: { type: 'continue' },
      stateUpdates: { gatherProgress: {}, context: {}, conversationPhase: 'active' },
    }));

    ws.simulateMessage(JSON.stringify({ type: 'chat_message', text: 'hi', messageId: 'msg-2' }));

    // Let processing complete
    await vi.advanceTimersByTimeAsync(500);

    // Advance past timeout — no error should appear
    await vi.advanceTimersByTimeAsync(WS_MESSAGE_TIMEOUT_MS + 1000);

    const timeoutErrors = findAllOfType(ws, 'error', 'Request timed out');
    expect(timeoutErrors.length).toBe(0);
  });

  test('suppresses late response frames after timeout closes the socket', async () => {
    ws.simulateMessage(JSON.stringify({ type: 'chat_message', text: 'slow', messageId: 'msg-3' }));

    // Advance past timeout
    await vi.advanceTimersByTimeAsync(WS_MESSAGE_TIMEOUT_MS + 100);

    expect(ws.close).toHaveBeenCalledWith(4011, 'Request timed out');
    expect(mockEnqueueLLMRequest).toHaveBeenCalled();

    const responseStartCountBeforeResolve = findAllOfType(ws, 'response_start').length;
    const responseChunkCountBeforeResolve = findAllOfType(ws, 'response_chunk').length;
    const responseEndCountBeforeResolve = findAllOfType(ws, 'response_end').length;

    // response_start is emitted when the request is accepted; the fail-closed
    // guarantee is that no additional response frames leak after timeout/close.
    llmQueueResolve({
      response: 'late',
      action: { type: 'continue' },
      stateUpdates: { gatherProgress: {}, context: {}, conversationPhase: 'active' },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(findAllOfType(ws, 'response_start').length).toBe(responseStartCountBeforeResolve);
    expect(findAllOfType(ws, 'response_chunk').length).toBe(responseChunkCountBeforeResolve);
    expect(findAllOfType(ws, 'response_end').length).toBe(responseEndCountBeforeResolve);
    expect(responseChunkCountBeforeResolve).toBe(0);
    expect(responseEndCountBeforeResolve).toBe(0);
    expect(mockPersistMessage).not.toHaveBeenCalled();
    expect(mockPersistTurnMetrics).not.toHaveBeenCalled();
  });

  test('suppresses late voice token responses after timeout before provider lookup completes', async () => {
    ws.close.mockImplementation(() => undefined);

    let resolveTwilioService!: (service: any) => void;
    const generateAccessToken = vi.fn(async () => 'late-voice-token');
    const getTwilioService = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveTwilioService = resolve;
        }),
    );

    mockServerApp.locals.voiceServiceFactory = {
      getTwilioService,
    };

    ws.simulateMessage(JSON.stringify({ type: 'voice_token_request' }));
    await vi.waitFor(() => {
      expect(getTwilioService).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(WS_MESSAGE_TIMEOUT_MS + 1);

    expect(findAllOfType(ws, 'error', 'Request timed out').length).toBe(1);
    expect(ws.close).toHaveBeenCalledWith(4011, 'Request timed out');

    resolveTwilioService({
      isConfigured: vi.fn(() => true),
      generateAccessToken,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(generateAccessToken).not.toHaveBeenCalled();
    expect(findAllOfType(ws, 'voice_token').length).toBe(0);
  });

  test('suppresses late voice start side effects after timeout and stops the executor', async () => {
    ws.close.mockImplementation(() => undefined);

    let resolveStart!: () => void;
    const start = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const stop = vi.fn(async () => {});
    const realtimeExecutor: {
      config: Record<string, any>;
      start: typeof start;
      stop: typeof stop;
      cancelResponse: ReturnType<typeof vi.fn>;
    } = {
      config: {},
      start,
      stop,
      cancelResponse: vi.fn(),
    };

    mockResolveVoiceSession.mockResolvedValue({
      mode: 'realtime',
      executor: realtimeExecutor,
    });

    ws.simulateMessage(JSON.stringify({ type: 'voice_start' }));

    await vi.waitFor(() => {
      expect(start).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(WS_MESSAGE_TIMEOUT_MS + 1);

    expect(findAllOfType(ws, 'error', 'Request timed out').length).toBe(1);

    await realtimeExecutor.config.onTurnEnd?.({
      inputTokens: 3,
      outputTokens: 5,
      traceId: 'trace-late-voice',
    });

    expect(findAllOfType(ws, 'trace_event').length).toBe(0);
    expect(mockPersistMessage).not.toHaveBeenCalled();
    expect(mockPersistTurnMetrics).not.toHaveBeenCalled();

    resolveStart();
    await vi.advanceTimersByTimeAsync(0);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(findAllOfType(ws, 'voice_started').length).toBe(0);
  });

  test('suppresses late voice stop acknowledgements after timeout', async () => {
    ws.close.mockImplementation(() => undefined);

    let resolveStop!: () => void;
    const stop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStop = resolve;
        }),
    );

    const clientState = sdkClients.get(ws as any);
    if (!clientState) {
      throw new Error('expected SDK client state to exist');
    }
    clientState.voiceMode = 'realtime';
    clientState.realtimeExecutor = {
      stop,
      cancelResponse: vi.fn(),
    } as any;

    ws.simulateMessage(JSON.stringify({ type: 'voice_stop' }));

    await vi.advanceTimersByTimeAsync(WS_MESSAGE_TIMEOUT_MS + 1);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(findAllOfType(ws, 'error', 'Request timed out').length).toBe(1);

    resolveStop();
    await vi.advanceTimersByTimeAsync(0);

    expect(findAllOfType(ws, 'voice_stopped').length).toBe(0);
  });
});

/**
 * WebSocket handler — emitChannelResponseSent flush wiring tests
 *
 * Verifies that the handler.ts finally block calls emitChannelResponseSent
 * after executeMessage completes (both success and error paths), and that
 * a flush failure does not propagate to the WS response.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// =============================================================================
// MOCK DECLARATIONS — must come before any import that pulls them in
// =============================================================================

const mockEmitChannelResponseSent = vi.fn();
vi.mock('../../../services/channel-trace-utils.js', () => ({
  emitChannelResponseSent: (...args: any[]) => mockEmitChannelResponseSent(...args),
}));

const mockGetRuntimeExecutor = vi.fn();
const mockCompileToResolvedAgent = vi.fn();
vi.mock('../../../services/runtime-executor.js', () => ({
  getRuntimeExecutor: (...args: any[]) => mockGetRuntimeExecutor(...args),
  compileToResolvedAgent: (...args: any[]) => mockCompileToResolvedAgent(...args),
  resolveProjectTools: vi.fn(async () => []),
}));

vi.mock('../../../services/project-working-copy-compiler.js', () => ({
  buildProjectWorkingCopyAgentSources: vi.fn((agents: any[]) => agents),
  compileProjectWorkingCopy: vi.fn(async () => ({
    resolved: mockCompileToResolvedAgent(),
    configVariables: {},
  })),
  normalizeProjectWorkingCopyLibraryRef: vi.fn(() => undefined),
  extractSearchInstructionsFromDsl: vi.fn(() => new Map()),
}));

vi.mock('../../../services/dsl-utils.js', () => ({
  buildAgentDetails: vi.fn(),
}));

vi.mock('../../../services/trace-emitter.js', () => ({
  createTraceEmitter: vi.fn(() => ({
    logAgentEnter: vi.fn(),
    logAgentExit: vi.fn(),
    logLLMCall: vi.fn(),
    logError: vi.fn(),
    logUserMessage: vi.fn(),
    logAgentResponse: vi.fn(),
    logSessionUpdated: vi.fn(),
    getCurrentSpanId: vi.fn(() => 'span-123'),
  })),
}));

const mockGetTraceStore = vi.fn();
vi.mock('../../../services/trace-store.js', () => ({
  getTraceStore: (...args: any[]) => mockGetTraceStore(...args),
}));

vi.mock('../../../services/llm/session-llm-client.js', () => ({
  TRACE_MODEL_UNKNOWN: 'unknown-model',
}));

const mockEnqueueLLMRequest = vi.fn(async () => ({
  response: 'Hello world',
  action: { type: 'continue' },
  stateUpdates: { gatherProgress: {}, context: {}, conversationPhase: 'active' },
}));
vi.mock('../../../services/llm/llm-queue.js', () => ({
  enqueueLLMRequest: (...args: any[]) => mockEnqueueLLMRequest(...args),
  BackpressureError: class BackpressureError extends Error {
    constructor(msg?: string) {
      super(msg || 'backpressure');
      this.name = 'BackpressureError';
    }
  },
  isLLMQueueEnabled: vi.fn(() => true),
}));

vi.mock('../../../services/llm/model-router.js', () => ({
  getModelCapabilities: vi.fn(() => ({})),
  calculateCost: vi.fn(() => 0),
  hasKnownPricing: vi.fn(() => false),
}));

const mockIsDatabaseAvailable = vi.fn(() => false);
vi.mock('../../../db/index.js', () => ({
  isDatabaseAvailable: (...args: any[]) => mockIsDatabaseAvailable(...args),
}));

const mockIsConfigLoaded = vi.fn(() => false);
const mockGetConfig = vi.fn(() => ({
  llm: { provider: 'openai', fastModel: 'gpt-4o-mini' },
  security: { superAdminUserIds: [] },
  channelLifecycle: {
    web_debug: { defaultDisposition: 'completed', disconnectBehavior: 'detach' },
  },
}));
vi.mock('../../../config/loader.js', () => ({
  isConfigLoaded: (...args: any[]) => mockIsConfigLoaded(...args),
  getConfig: (...args: any[]) => mockGetConfig(...args),
}));

const mockExtractUserIdFromToken = vi.fn();
vi.mock('../../../middleware/auth.js', () => ({
  extractVerifiedUserTokenClaims: (...args: any[]) => {
    const userId = mockExtractUserIdFromToken(...args);
    return userId ? { userId, tenantId: 'tenant-test' } : null;
  },
  writeAccessDeniedAuditLog: vi.fn(),
}));

vi.mock('../../../services/permission-resolution.js', () => ({
  clearPermissionCache: vi.fn(),
  resolveEffectivePermissions: vi.fn(async () => []),
}));

vi.mock('../../../services/deployment-resolver.js', () => ({
  DeploymentResolver: vi.fn(),
  mergeWorkingCopyModules: vi.fn(async (working: unknown) => working),
}));

vi.mock('../../../services/session/session-service.js', () => ({
  getSessionService: vi.fn(),
}));

vi.mock('../../../services/stores/store-factory.js', () => ({
  getStores: vi.fn(() => ({
    conversation: {
      createSession: vi.fn(async () => ({ id: 'db-session-1' })),
      endSession: vi.fn(async () => {}),
    },
  })),
}));

const mockResolveTenantMembership = vi.fn(async () => null);
const mockResolveDefaultTenant = vi.fn(async () => null);
const mockFindProjectByIdAndTenant = vi.fn(async () => ({
  id: 'proj-load',
  tenantId: 'tenant-test',
}));
vi.mock('../../../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  resolveTenantMembership: (...args: any[]) => mockResolveTenantMembership(...args),
  resolveDefaultTenant: (...args: any[]) => mockResolveDefaultTenant(...args),
}));

vi.mock('../../../repos/project-repo.js', () => ({
  findProjectById: vi.fn(async () => null),
  findProjectByIdAndTenant: (...args: any[]) => mockFindProjectByIdAndTenant(...args),
  findProjectAgentByPath: vi.fn(async () => null),
  findProjectAgentByName: vi.fn(async () => null),
  findProjectAgentForProject: vi.fn(async () => null),
  findProjectAgentsForProject: vi.fn(async () => []),
  findProjectWithAgents: vi.fn(async () => null),
  loadConfigVariablesMap: vi.fn(async () => ({})),
}));

vi.mock('../../../repos/session-repo.js', () => ({
  findSessionById: vi.fn(async () => null),
  updateSession: vi.fn(async () => ({})),
  incrementSessionTokens: vi.fn(async () => ({})),
  findSessionByRuntimeId: vi.fn(async () => null),
  findMessagesForSession: vi.fn(async () => []),
}));

vi.mock('../../../services/message-persistence-queue.js', () => ({
  persistMessage: vi.fn(async () => {}),
  persistMessageRecord: vi.fn(async () => {}),
  persistTurnMetrics: vi.fn(async () => {}),
  flushMessageQueue: vi.fn(async () => {}),
}));

vi.mock('../../../services/audit-helpers.js', () => ({
  auditContextInjected: vi.fn(async () => {}),
  auditToolMockSet: vi.fn(async () => {}),
  auditTestSessionCreated: vi.fn(async () => {}),
}));

vi.mock('../../../services/identity/artifact-hasher.js', () => ({
  buildCallerContext: vi.fn(() => ({
    tenantId: 'debug',
    channel: 'web_debug',
    initiatedById: undefined,
    identityTier: 0,
    verificationMethod: 'none',
  })),
}));

vi.mock('../../../services/execution/mock-tool-executor.js', () => ({
  MockToolExecutor: vi.fn(),
}));

vi.mock('../../../observability/metrics.js', () => ({
  incrementActiveSessions: vi.fn(),
  decrementActiveSessions: vi.fn(),
}));

vi.mock('../../../channels/pipeline/session-factory.js', () => ({
  resolveSessionTimeouts: vi.fn(async () => ({})),
}));

vi.mock('../../../services/tenant-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/tenant-config.js')>();
  return {
    ...actual,
    getTenantConfigService: vi.fn(() => ({
      getConfigAsync: vi.fn(async () => ({
        security: { scrubPII: true },
        limits: { messageRetentionDays: 30 },
      })),
      getProjectConfig: vi.fn(async () => null),
    })),
  };
});

vi.mock('../../../services/execution/coordinator-singleton.js', () => ({
  getExecutionCoordinator: vi.fn(() => null),
  isCoordinatorAvailable: vi.fn(() => false),
}));

vi.mock('../../../services/auth-profile/auth-preflight.js', () => ({
  checkAuthPreflightFromIR: vi.fn(async () => ({ pending: [], satisfied: [] })),
  evaluateAuthPreflightFromIR: vi.fn(async () => ({ pending: [], satisfied: [] })),
  hasActiveAuthGateAsync: vi.fn(async () => false),
  queueMessageBehindAuthGateAsync: vi.fn(async () => false),
  reconcileAuthGateWithEvaluationAsync: vi.fn(async () => {}),
  cleanupAuthGateAsync: vi.fn(async () => {}),
  createTokenLookups: vi.fn(() => ({})),
}));

vi.mock('../../../services/auth-profile/paused-execution-store.js', () => ({
  getPausedExecutionStore: vi.fn(() => ({
    cleanupSession: vi.fn(async () => {}),
  })),
}));

vi.mock('../../../services/tool-oauth-service-singleton.js', () => ({
  getToolOAuthService: vi.fn(() => null),
}));

vi.mock('../../../services/auth-profile/auth-profile-oauth-resolver.js', () => ({
  AUTH_PROFILE_OAUTH_PROVIDER_ID: 'auth-profile-oauth',
}));

vi.mock('../../../services/oauth-callback-url.js', () => ({
  buildRuntimeOAuthCallbackUri: vi.fn(() => 'http://localhost:3112/oauth/callback'),
}));

vi.mock('../../../services/metadata/custom-dimensions.js', () => ({
  validateDimensions: vi.fn(() => ({ valid: true, errors: [] })),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@abl/compiler/platform/observability', () => ({
  runWithObservabilityContext: vi.fn((_ctx: any, fn: () => any) => fn()),
  getCurrentTraceId: vi.fn(() => undefined),
}));

// =============================================================================
// IMPORT UNDER TEST (after all mocks)
// =============================================================================

import { handleConnection } from '../../../websocket/handler.js';

// =============================================================================
// HELPERS
// =============================================================================

class MockWebSocket extends EventEmitter {
  OPEN = 1 as const;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();

  simulateMessage(data: string) {
    this.emit('message', Buffer.from(data));
  }
}

function makeReq(params: { token?: string; tenantId?: string } = {}): any {
  return {
    url: '/ws',
    headers: {
      host: 'localhost:3112',
      ...(params.token ? { 'sec-websocket-protocol': `web-debug-auth, ${params.token}` } : {}),
    },
  };
}

function makeRuntimeSession(overrides: Record<string, any> = {}): any {
  return {
    id: overrides.id ?? 'session-001',
    agentName: overrides.agentName ?? 'test_agent',
    agentIR: overrides.agentIR ?? null,
    compilationOutput: null,
    conversationHistory: overrides.conversationHistory ?? [],
    state: {
      gatherProgress: {},
      context: {},
      conversationPhase: 'active',
      ...(overrides.state ?? {}),
    },
    data: {},
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    initialized: true,
    currentFlowStep: overrides.currentFlowStep,
    versionInfo: overrides.versionInfo,
    tenantId: overrides.tenantId,
    configHash: overrides.configHash,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    ...overrides,
  };
}

function makeMockExecutor(overrides: Record<string, any> = {}) {
  return {
    isConfigured: vi.fn(() => true),
    createSessionFromResolved: vi.fn(() => makeRuntimeSession()),
    executeMessage: vi.fn(async (_id: string, _text: string, onChunk: (c: string) => void) => {
      onChunk('Hello ');
      onChunk('world');
      return {
        response: 'Hello world',
        action: { type: 'continue' },
        stateUpdates: { gatherProgress: {}, context: {}, conversationPhase: 'active' },
      };
    }),
    getSession: vi.fn(() => undefined),
    endSession: vi.fn(),
    detachSession: vi.fn(),
    addMessage: vi.fn(),
    initializeSession: vi.fn(async () => null),
    rehydrateSession: vi.fn(async () => null),
    saveSessionSnapshot: vi.fn(async () => {}),
    checkSessionQuota: vi.fn(),
    releaseSessionSlot: vi.fn(),
    ...overrides,
  };
}

function makeMockTraceStore() {
  return {
    addEvent: vi.fn(),
    setSessionAgent: vi.fn(),
    clearSession: vi.fn(),
    unsubscribeAll: vi.fn(),
    subscribe: vi.fn(async () => ({ success: true, eventCount: 0 })),
    unsubscribe: vi.fn(),
    getActiveSessions: vi.fn(() => []),
    getSessionInfo: vi.fn(() => null),
  };
}

function getSentMessages(ws: MockWebSocket): any[] {
  return ws.send.mock.calls.map(([raw]: [string]) => JSON.parse(raw));
}

function findSentMessage(ws: MockWebSocket, type: string): any | undefined {
  return getSentMessages(ws).find((m: any) => m.type === type);
}

async function waitForAuthenticatedConnection(ws: MockWebSocket): Promise<void> {
  await vi.waitFor(() => {
    expect(findSentMessage(ws, 'info')).toBeDefined();
  });
}

/**
 * Load an agent so clientState.runtimeSession is set, allowing send_message
 * to reach the executeMessage / emitChannelResponseSent code path.
 */
async function loadAgentOnConnection(
  ws: MockWebSocket,
  executor: ReturnType<typeof makeMockExecutor>,
  sessionOverrides: Record<string, any> = {},
): Promise<any> {
  await waitForAuthenticatedConnection(ws);
  ws.send.mockClear();

  const { findProjectAgentByPath } = await import('../../../repos/project-repo.js');
  (findProjectAgentByPath as any).mockResolvedValue({
    id: 'agent-db-load',
    name: 'test_agent',
    dslContent: 'AGENT test_agent\nROLE: Test helper\nGOAL: Help',
    projectId: 'proj-load',
  });

  const { buildAgentDetails } = await import('../../../services/dsl-utils.js');
  (buildAgentDetails as any).mockReturnValue({
    id: 'test_agent',
    name: 'test_agent',
    type: 'agent',
    mode: 'reasoning',
    toolCount: 0,
    gatherFieldCount: 0,
    isSupervisor: false,
    dsl: 'AGENT test_agent\nROLE: Test helper\nGOAL: Help',
  });

  const session = makeRuntimeSession({
    id: 'sess-preloaded',
    tenantId: 'tenant-test',
    userId: 'user-1',
    ...sessionOverrides,
  });
  executor.createSessionFromResolved.mockReturnValue(session);
  mockCompileToResolvedAgent.mockReturnValue({
    agents: {},
    entryAgent: 'test_agent',
    compilationOutput: { agents: {} },
    sourceHash: 'h',
    versionInfo: { versions: {} },
  });

  mockIsDatabaseAvailable.mockReturnValue(true);

  ws.simulateMessage(
    JSON.stringify({ type: 'load_agent', agentPath: 'test_agent', projectId: 'proj-load' }),
  );

  await vi.waitFor(() => {
    expect(findSentMessage(ws, 'agent_loaded')).toBeDefined();
  });

  ws.send.mockClear();

  return session;
}

// =============================================================================
// SHARED SETUP
// =============================================================================

let ws: MockWebSocket;
let traceStore: ReturnType<typeof makeMockTraceStore>;
let executor: ReturnType<typeof makeMockExecutor>;

beforeEach(() => {
  vi.clearAllMocks();

  ws = new MockWebSocket();
  traceStore = makeMockTraceStore();
  executor = makeMockExecutor();

  mockGetRuntimeExecutor.mockReturnValue(executor);
  mockGetTraceStore.mockReturnValue(traceStore);
  mockIsDatabaseAvailable.mockReturnValue(true);
  mockIsConfigLoaded.mockReturnValue(false);
  mockExtractUserIdFromToken.mockReturnValue('user-1');
  mockResolveTenantMembership.mockResolvedValue({
    role: 'ADMIN',
    customRoleId: null,
    orgId: undefined,
  });
  mockResolveDefaultTenant.mockResolvedValue({
    tenantId: 'tenant-test',
    role: 'ADMIN',
    customRoleId: null,
    orgId: undefined,
  });
  mockFindProjectByIdAndTenant.mockResolvedValue({
    id: 'proj-load',
    tenantId: 'tenant-test',
  });

  mockEnqueueLLMRequest.mockImplementation(async () => ({
    response: 'Hello world',
    action: { type: 'continue' },
    stateUpdates: { gatherProgress: {}, context: {}, conversationPhase: 'active' },
  }));
});

// =============================================================================
// TESTS
// =============================================================================

describe('handler.ts — emitChannelResponseSent flush wiring', () => {
  test('calls emitChannelResponseSent after executeMessage succeeds', async () => {
    mockExtractUserIdFromToken.mockReturnValue('user-1');
    handleConnection(ws as any, makeReq({ token: 'tok' }));

    await loadAgentOnConnection(ws, executor);

    executor.isConfigured.mockReturnValue(true);

    ws.simulateMessage(
      JSON.stringify({
        type: 'send_message',
        sessionId: 'sess-preloaded',
        text: 'hello',
      }),
    );

    await vi.waitFor(() => {
      expect(findSentMessage(ws, 'response_end')).toBeDefined();
    });

    expect(mockEmitChannelResponseSent).toHaveBeenCalledTimes(1);
  });

  test('passes channel "ws" and a positive durationMs', async () => {
    mockExtractUserIdFromToken.mockReturnValue('user-1');
    handleConnection(ws as any, makeReq({ token: 'tok' }));

    await loadAgentOnConnection(ws, executor);
    executor.isConfigured.mockReturnValue(true);

    ws.simulateMessage(
      JSON.stringify({
        type: 'send_message',
        sessionId: 'sess-preloaded',
        text: 'hello',
      }),
    );

    await vi.waitFor(() => {
      expect(mockEmitChannelResponseSent).toHaveBeenCalled();
    });

    const [sessionId, channel, durationMs] = mockEmitChannelResponseSent.mock.calls[0];
    expect(sessionId).toBe('sess-preloaded');
    expect(channel).toBe('ws');
    expect(durationMs).toBeGreaterThanOrEqual(0);
  });

  test('passes tenantId and projectId from client state', async () => {
    mockExtractUserIdFromToken.mockReturnValue('user-1');
    handleConnection(ws as any, makeReq({ token: 'tok' }));

    await loadAgentOnConnection(ws, executor, {
      tenantId: 'tenant-abc',
    });
    executor.isConfigured.mockReturnValue(true);

    ws.simulateMessage(
      JSON.stringify({
        type: 'send_message',
        sessionId: 'sess-preloaded',
        text: 'hello',
      }),
    );

    await vi.waitFor(() => {
      expect(mockEmitChannelResponseSent).toHaveBeenCalled();
    });

    const opts = mockEmitChannelResponseSent.mock.calls[0][3];
    // tenantId comes from clientState, which is set during loadAgent
    expect(opts).toHaveProperty('tenantId');
    expect(opts).toHaveProperty('projectId');
  });

  test('calls emitChannelResponseSent even when executeMessage throws', async () => {
    mockExtractUserIdFromToken.mockReturnValue('user-1');
    handleConnection(ws as any, makeReq({ token: 'tok' }));

    await loadAgentOnConnection(ws, executor);
    executor.isConfigured.mockReturnValue(true);
    mockEnqueueLLMRequest.mockRejectedValue(new Error('LLM timeout'));

    ws.simulateMessage(
      JSON.stringify({
        type: 'send_message',
        sessionId: 'sess-preloaded',
        text: 'fail please',
      }),
    );

    await vi.waitFor(() => {
      // The handler catches the error and sends an error response_end
      expect(findSentMessage(ws, 'response_end')).toBeDefined();
    });

    // The finally block should still have called emitChannelResponseSent
    expect(mockEmitChannelResponseSent).toHaveBeenCalledTimes(1);
    expect(mockEmitChannelResponseSent.mock.calls[0][1]).toBe('ws');
  });

  test('flush failure does not propagate to the WS response', async () => {
    mockExtractUserIdFromToken.mockReturnValue('user-1');
    handleConnection(ws as any, makeReq({ token: 'tok' }));

    await loadAgentOnConnection(ws, executor);
    executor.isConfigured.mockReturnValue(true);

    // Make emitChannelResponseSent throw
    mockEmitChannelResponseSent.mockImplementation(() => {
      throw new Error('EventStore down');
    });

    ws.simulateMessage(
      JSON.stringify({
        type: 'send_message',
        sessionId: 'sess-preloaded',
        text: 'hello',
      }),
    );

    await vi.waitFor(() => {
      expect(findSentMessage(ws, 'response_end')).toBeDefined();
    });

    // The response should complete normally — no error message from the flush failure
    const errorMsg = getSentMessages(ws).find(
      (m: any) => m.type === 'error' && m.message?.includes('EventStore'),
    );
    expect(errorMsg).toBeUndefined();

    // Confirm the flush was attempted
    expect(mockEmitChannelResponseSent).toHaveBeenCalled();
  });

  test('passes configHash from runtimeSession when available', async () => {
    mockExtractUserIdFromToken.mockReturnValue('user-1');
    handleConnection(ws as any, makeReq({ token: 'tok' }));

    await loadAgentOnConnection(ws, executor, {
      configHash: 'abc123hash',
    });
    executor.isConfigured.mockReturnValue(true);

    ws.simulateMessage(
      JSON.stringify({
        type: 'send_message',
        sessionId: 'sess-preloaded',
        text: 'hello',
      }),
    );

    await vi.waitFor(() => {
      expect(mockEmitChannelResponseSent).toHaveBeenCalled();
    });

    const opts = mockEmitChannelResponseSent.mock.calls[0][3];
    expect(opts).toHaveProperty('configHash', 'abc123hash');
  });
});

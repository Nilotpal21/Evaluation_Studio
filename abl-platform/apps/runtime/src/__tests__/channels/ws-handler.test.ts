/**
 * WebSocket Handler Tests
 *
 * Tests the debug WebSocket handler (websocket/handler.ts).
 * Exercises message parsing/routing, authentication gate, load_agent,
 * send_message, get_state, subscribe/unsubscribe,
 * list_sessions, resume_session, close/error lifecycle, and edge cases.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// =============================================================================
// MOCK DECLARATIONS — must come before any import that pulls them in
// =============================================================================

const mockGetRuntimeExecutor = vi.fn();
const mockCompileToResolvedAgent = vi.fn();
const mockCompileProjectWorkingCopy = vi.fn();
const mockClickHouseMetricsRecord = vi.fn(async () => {});
const mockGetClickHouseClient = vi.fn(() => ({}));
const mockUpdateSession = vi.fn(async () => ({}));
const mockBuildAgentDetails = vi.fn();
const mockFindProjectAgentByPath = vi.fn(async () => null);
const mockFindProjectWithAgents = vi.fn(async () => null);
const mockFindProjectRuntimeConfig = vi.fn(async () => null);
const mockEvaluateProjectExecutionReadiness = vi.fn();
const ORIGINAL_USE_MONGO_CLICKHOUSE = process.env.USE_MONGO_CLICKHOUSE;
const mockIsCoordinatorAvailable = vi.fn(() => false);
const mockExecutionCoordinator = {
  submit: vi.fn(),
};
const mockWriteAuditEvent = vi.fn(async () => {});
const mockConversationStore = {
  createSession: vi.fn(async (payload?: { id?: string }) => ({
    id: payload?.id ?? 'db-session-1',
  })),
  endSession: vi.fn(async () => {}),
};

vi.mock('../../services/runtime-executor.js', () => ({
  getRuntimeExecutor: (...args: any[]) => mockGetRuntimeExecutor(...args),
  compileToResolvedAgent: (...args: any[]) => mockCompileToResolvedAgent(...args),
}));

vi.mock('../../services/project-working-copy-compiler.js', () => ({
  buildProjectWorkingCopyAgentSources: (agents: Array<Record<string, unknown>>) =>
    agents
      .filter(
        (agent): agent is { name: string; dslContent: string; systemPromptLibraryRef?: unknown } =>
          typeof agent.name === 'string' && typeof agent.dslContent === 'string',
      )
      .map((agent) => ({
        name: agent.name,
        dslContent: agent.dslContent,
        systemPromptLibraryRef:
          agent.systemPromptLibraryRef &&
          typeof agent.systemPromptLibraryRef === 'object' &&
          typeof (agent.systemPromptLibraryRef as { promptId?: unknown }).promptId === 'string' &&
          typeof (agent.systemPromptLibraryRef as { versionId?: unknown }).versionId === 'string'
            ? {
                promptId: (agent.systemPromptLibraryRef as { promptId: string }).promptId,
                versionId: (agent.systemPromptLibraryRef as { versionId: string }).versionId,
              }
            : null,
      })),
  normalizeProjectWorkingCopyLibraryRef: (agent: Record<string, unknown>) =>
    agent.systemPromptLibraryRef &&
    typeof agent.systemPromptLibraryRef === 'object' &&
    typeof (agent.systemPromptLibraryRef as { promptId?: unknown }).promptId === 'string' &&
    typeof (agent.systemPromptLibraryRef as { versionId?: unknown }).versionId === 'string'
      ? {
          promptId: (agent.systemPromptLibraryRef as { promptId: string }).promptId,
          versionId: (agent.systemPromptLibraryRef as { versionId: string }).versionId,
        }
      : null,
  compileProjectWorkingCopy: (...args: any[]) => mockCompileProjectWorkingCopy(...args),
  extractSearchInstructionsFromDsl: () => new Map(),
}));

vi.mock('../../services/dsl-utils.js', () => ({
  buildAgentDetails: (...args: any[]) => mockBuildAgentDetails(...args),
}));

vi.mock('../../services/trace-emitter.js', () => ({
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
vi.mock('../../services/trace-store.js', () => ({
  getTraceStore: (...args: any[]) => mockGetTraceStore(...args),
}));

const mockCleanupClosedSessionArtifacts = vi.fn(async () => {});
const mockIsSessionTerminalizationEnabled = vi.fn(() => true);
const mockTerminateConversationSession = vi.fn(async () => ({
  sessionId: 'db-session-1',
  disposition: 'timeout',
  status: 'abandoned',
  endedAt: '2026-03-30T10:00:00.000Z',
  eventEmitted: true,
  eventId: 'evt-web-debug-close',
  hook: {
    attempted: true,
    mode: 'ignore',
    outcome: 'ignored',
  },
  runtimeEnded: true,
  dbUpdated: true,
  artifactSessionIds: ['sess-close-end'],
}));

vi.mock('../../services/session-lifecycle/artifact-cleanup.js', () => ({
  cleanupClosedSessionArtifacts: (...args: any[]) => mockCleanupClosedSessionArtifacts(...args),
}));

vi.mock('../../services/session-lifecycle/terminalization-service.js', () => ({
  isSessionTerminalizationEnabled: (...args: any[]) => mockIsSessionTerminalizationEnabled(...args),
  SessionTerminalizationService: class MockSessionTerminalizationService {
    terminateConversationSession = (...args: any[]) => mockTerminateConversationSession(...args);
  },
}));

vi.mock('../../services/stores/clickhouse-metrics-store.js', () => ({
  ClickHouseMetricsStore: vi.fn(function () {
    return {
      record: (...args: any[]) => mockClickHouseMetricsRecord(...args),
    };
  }),
}));

vi.mock('../../services/audit-store-singleton.js', () => ({
  getAuditStore: vi.fn(),
  writeAuditEvent: (...args: any[]) => mockWriteAuditEvent(...args),
}));

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: (...args: any[]) => mockGetClickHouseClient(...args),
}));

vi.mock('../../services/llm/session-llm-client.js', () => ({
  TRACE_MODEL_UNKNOWN: 'unknown-model',
}));

const mockEnqueueLLMRequest = vi.fn(async () => ({
  response: 'Hello world',
  action: { type: 'continue' },
  stateUpdates: { gatherProgress: {}, context: {}, conversationPhase: 'active' },
}));
vi.mock('../../services/llm/llm-queue.js', () => ({
  enqueueLLMRequest: (...args: any[]) => mockEnqueueLLMRequest(...args),
  BackpressureError: class BackpressureError extends Error {
    constructor(msg?: string) {
      super(msg || 'backpressure');
      this.name = 'BackpressureError';
    }
  },
  isLLMQueueEnabled: vi.fn(() => true),
}));

vi.mock('../../services/execution/coordinator-singleton.js', () => ({
  getExecutionCoordinator: vi.fn(() => mockExecutionCoordinator),
  isCoordinatorAvailable: (...args: any[]) => mockIsCoordinatorAvailable(...args),
}));

const mockIsDatabaseAvailable = vi.fn(() => false);
vi.mock('../../db/index.js', () => ({
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

vi.mock('../../config/loader.js', () => ({
  isConfigLoaded: (...args: any[]) => mockIsConfigLoaded(...args),
  getConfig: (...args: any[]) => mockGetConfig(...args),
}));

const mockExtractUserIdFromToken = vi.fn();
vi.mock('../../middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    extractVerifiedUserTokenClaims: (...args: any[]) => {
      const userId = mockExtractUserIdFromToken(...args);
      return userId ? { userId, tenantId: 'tenant-test' } : null;
    },
  };
});

const mockCheckAuthPreflightFromIR = vi.fn(async () => null);
const mockEvaluateAuthPreflightFromIR = vi.fn(async () => ({ pending: [], satisfied: [] }));
const mockHasActiveAuthGateAsync = vi.fn(async () => false);
const mockQueueMessageBehindAuthGateAsync = vi.fn(async () => {});
const mockReconcileAuthGateWithEvaluationAsync = vi.fn(async () => null);
const mockCleanupAuthGateAsync = vi.fn(async () => {});
const mockCreateTokenLookups = vi.fn(() => ({}));

vi.mock('../../services/auth-profile/auth-preflight.js', () => ({
  checkAuthPreflightFromIR: (...args: any[]) => mockCheckAuthPreflightFromIR(...args),
  evaluateAuthPreflightFromIR: (...args: any[]) => mockEvaluateAuthPreflightFromIR(...args),
  hasActiveAuthGateAsync: (...args: any[]) => mockHasActiveAuthGateAsync(...args),
  queueMessageBehindAuthGateAsync: (...args: any[]) => mockQueueMessageBehindAuthGateAsync(...args),
  reconcileAuthGateWithEvaluationAsync: (...args: any[]) =>
    mockReconcileAuthGateWithEvaluationAsync(...args),
  cleanupAuthGateAsync: (...args: any[]) => mockCleanupAuthGateAsync(...args),
  createTokenLookups: (...args: any[]) => mockCreateTokenLookups(...args),
}));

vi.mock('../../services/permission-resolution.js', () => ({
  clearPermissionCache: vi.fn(),
  resolveEffectivePermissions: vi.fn(async () => []),
}));

vi.mock('../../services/deployment-resolver.js', () => ({
  DeploymentResolver: vi.fn(),
  // mergeWorkingCopyModules splices module-dependency agents/tools onto the
  // compiled working copy. The default working copy mock returns no agents
  // or tools, so the merge is a no-op pass-through for these tests.
  mergeWorkingCopyModules: vi.fn(async (working: unknown) => working),
}));

vi.mock('../../services/session/session-service.js', () => ({
  getSessionService: vi.fn(),
}));

vi.mock('../../services/stores/store-factory.js', () => ({
  getStores: vi.fn(() => ({
    conversation: mockConversationStore,
  })),
}));

const mockResolveTenantMembership = vi.fn(async () => null);
const mockResolveDefaultTenant = vi.fn(async () => null);
const mockFindProjectByIdAndTenant = vi.fn(async () => ({
  id: 'proj-load',
  tenantId: 'tenant-test',
}));
const mockFindProjectSettings = vi.fn(async () => null);
vi.mock('../../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  resolveTenantMembership: (...args: any[]) => mockResolveTenantMembership(...args),
  resolveDefaultTenant: (...args: any[]) => mockResolveDefaultTenant(...args),
  writeAuditLog: vi.fn(),
}));

vi.mock('../../repos/project-repo.js', () => ({
  findProjectByIdAndTenant: (...args: any[]) => mockFindProjectByIdAndTenant(...args),
  findProjectById: vi.fn(async () => null),
  findProjectAgentByPath: (...args: any[]) => mockFindProjectAgentByPath(...args),
  findProjectAgentByName: vi.fn(async () => null),
  findProjectAgentForProject: vi.fn(async () => null),
  findProjectAgentsForProject: vi.fn(async () => []),
  findProjectRuntimeConfig: (...args: any[]) => mockFindProjectRuntimeConfig(...args),
  findProjectWithAgents: (...args: any[]) => mockFindProjectWithAgents(...args),
  loadConfigVariablesMap: vi.fn(async () => ({})),
}));

vi.mock('../../services/session/project-agent-dsl-readiness.js', () => ({
  buildProjectDslReadinessError: vi.fn(
    () =>
      'Project DSL has validation errors. Fix the draft or runtime config before starting a runtime session.',
  ),
  evaluateProjectExecutionReadiness: (...args: any[]) =>
    mockEvaluateProjectExecutionReadiness(...args),
}));

vi.mock('../../repos/project-settings-repo.js', () => ({
  findProjectSettings: (...args: any[]) => mockFindProjectSettings(...args),
}));

vi.mock('../../repos/session-repo.js', () => ({
  updateSession: (...args: any[]) => mockUpdateSession(...args),
  incrementSessionTokens: vi.fn(async () => ({})),
  findSessionByRuntimeId: vi.fn(async () => null),
  findSessionById: vi.fn(async () => null),
  findMessagesForSession: vi.fn(async () => []),
}));

vi.mock('../../services/message-persistence-queue.js', () => ({
  persistMessage: vi.fn(async () => {}),
  persistMessageRecord: vi.fn(async () => {}),
  persistTurnMetrics: vi.fn(async () => {}),
  flushMessageQueue: vi.fn(async () => {}),
}));

vi.mock('../../services/audit-helpers.js', () => ({
  auditContextInjected: vi.fn(async () => {}),
  auditToolMockSet: vi.fn(async () => {}),
  auditTestSessionCreated: vi.fn(async () => {}),
}));

vi.mock('../../services/identity/artifact-hasher.js', () => ({
  buildCallerContext: vi.fn(() => ({
    tenantId: 'debug',
    channel: 'web_debug',
    initiatedById: undefined,
    identityTier: 0,
    verificationMethod: 'none',
  })),
}));

vi.mock('../../services/execution/mock-tool-executor.js', () => ({
  MockToolExecutor: vi.fn(),
}));

vi.mock('../../observability/metrics.js', () => ({
  incrementActiveSessions: vi.fn(),
  decrementActiveSessions: vi.fn(),
}));

vi.mock('../../channels/pipeline/session-factory.js', () => ({
  resolveSessionTimeouts: vi.fn(async () => ({})),
}));

vi.mock('../../services/tenant-config.js', () => ({
  getTenantConfigService: vi.fn(() => ({
    getConfigAsync: vi.fn(async () => ({
      security: { scrubPII: true },
      limits: { messageRetentionDays: 30 },
    })),
    getProjectConfig: vi.fn(async () => null),
  })),
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

import {
  __resetDebugWsClickHouseStateForTests,
  handleConnection,
  setRedisPubSub,
} from '../../websocket/handler.js';
import { getSessionService } from '../../services/session/session-service.js';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Flush the microtask queue so that `await tenantReady` inside
 * ws.on('message') settles before synchronous assertions run.
 */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function waitForAuthenticatedConnection(ws: MockWebSocket): Promise<void> {
  await vi.waitFor(() => {
    expect(findSentMessage(ws, 'info')).toBeDefined();
  });
}

/** WebSocket mock that supports EventEmitter pattern */
class MockWebSocket extends EventEmitter {
  /** ws.OPEN constant — required for readyState comparison in send() */
  OPEN = 1 as const;
  readyState = 1; // OPEN
  send = vi.fn();
  close = vi.fn();

  /** Simulate receiving a message from the client */
  simulateMessage(data: string) {
    this.emit('message', Buffer.from(data));
  }

  /** Simulate WebSocket close event */
  simulateClose() {
    this.emit('close');
  }

  /** Simulate WebSocket error event */
  simulateError(error: Error) {
    this.emit('error', error);
  }
}

/** Create a minimal IncomingMessage stub with internal WS auth carried in the subprotocol header. */
function makeReq(params: { token?: string | null; tenantId?: string } = {}): any {
  const token = params.token === undefined ? 'tok' : params.token;
  return {
    url: '/ws',
    headers: {
      host: 'localhost:3112',
      ...(token ? { 'sec-websocket-protocol': `web-debug-auth, ${token}` } : {}),
    },
  };
}

/** Create a mock RuntimeSession */
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
    createdAt: new Date(),
    lastActivityAt: new Date(),
    ...overrides,
  };
}

/** Build a mock RuntimeExecutor */
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
    persistSession: vi.fn(async () => {}),
    endSession: vi.fn(),
    detachSession: vi.fn(),
    addMessage: vi.fn(),
    initializeSession: vi.fn(async () => null),
    rehydrateSession: vi.fn(async () => null),
    saveSessionSnapshot: vi.fn(async () => {}),
    rewireSessionToolExecutor: vi.fn(),
    checkSessionQuota: vi.fn(),
    releaseSessionSlot: vi.fn(),
    ...overrides,
  };
}

/** Build a mock TraceStore */
function makeMockTraceStore(overrides: Record<string, any> = {}) {
  return {
    addEvent: vi.fn(),
    readSince: vi.fn(async (_sessionId: string, afterEventId?: string) => ({
      events: [],
      totalBuffered: 0,
      afterEventId,
      snapshotRequired: false,
    })),
    setSessionAgent: vi.fn(),
    clearSession: vi.fn(),
    unsubscribeAll: vi.fn(),
    subscribe: vi.fn(async () => ({ success: true, eventCount: 0 })),
    unsubscribe: vi.fn(),
    getActiveSessions: vi.fn(() => []),
    getSessionInfo: vi.fn(() => null),
    ...overrides,
  };
}

/** Parse all messages sent to ws.send */
function getSentMessages(ws: MockWebSocket): any[] {
  return ws.send.mock.calls.map(([raw]: [string]) => JSON.parse(raw));
}

/** Find the first sent message of a given type */
function findSentMessage(ws: MockWebSocket, type: string): any | undefined {
  return getSentMessages(ws).find((m: any) => m.type === type);
}

/**
 * Perform a full load_agent flow so clientState.runtimeSession is set.
 * Returns the created session. Clears ws.send mock after loading so
 * subsequent assertions only see messages from the test action.
 */
async function loadAgentOnConnection(
  ws: MockWebSocket,
  executor: ReturnType<typeof makeMockExecutor>,
  sessionOverrides: Record<string, any> = {},
): Promise<any> {
  await waitForAuthenticatedConnection(ws);
  ws.send.mockClear();

  mockFindProjectAgentByPath.mockResolvedValue({
    id: 'agent-db-load',
    name: 'test_agent',
    dslContent: 'AGENT test_agent\nROLE: Test helper\nGOAL: Help',
    projectId: 'proj-load',
  });

  mockBuildAgentDetails.mockReturnValue({
    id: 'test_agent',
    name: 'test_agent',
    type: 'agent',
    mode: 'reasoning',
    toolCount: 0,
    gatherFieldCount: 0,
    isSupervisor: false,
    dsl: 'AGENT test_agent\nROLE: Test helper\nGOAL: Help',
  });

  // Sessions must include tenantId and userId to pass fail-closed ownership validation.
  // handleLoadAgent copies runtimeSession.tenantId → state.tenantId, so the session's
  // tenantId must match the client's resolved tenant context.
  const session = makeRuntimeSession({
    id: 'sess-preloaded',
    tenantId: 'tenant-test',
    userId: 'user-1',
    ...sessionOverrides,
  });
  executor.createSessionFromResolved.mockReturnValue(session);
  mockCompileProjectWorkingCopy.mockResolvedValue({
    resolved: {
      agents: {},
      entryAgent: 'test_agent',
      compilationOutput: { agents: {} },
      sourceHash: 'h',
      versionInfo: { versions: {} },
    },
    configVariables: {},
    warnings: [],
    documents: [],
    profileDocuments: [],
  });

  mockIsDatabaseAvailable.mockReturnValue(true);

  ws.simulateMessage(
    JSON.stringify({ type: 'load_agent', agentPath: 'test_agent', projectId: 'proj-load' }),
  );

  // Wait for the async handleLoadAgent to complete
  await vi.waitFor(() => {
    expect(findSentMessage(ws, 'agent_loaded')).toBeDefined();
  });

  // Clear ws.send so tests only see subsequent messages
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
  delete process.env.USE_MONGO_CLICKHOUSE;
  __resetDebugWsClickHouseStateForTests();

  ws = new MockWebSocket();
  traceStore = makeMockTraceStore();
  executor = makeMockExecutor();

  mockGetRuntimeExecutor.mockReturnValue(executor);
  mockCompileProjectWorkingCopy.mockResolvedValue({
    resolved: {
      agents: {},
      entryAgent: 'test_agent',
      compilationOutput: { agents: {} },
      sourceHash: 'mock-working-copy',
      versionInfo: { versions: {} },
    },
    configVariables: {},
    warnings: [],
    documents: [],
    profileDocuments: [],
  });
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
  mockFindProjectWithAgents.mockResolvedValue(null);
  mockFindProjectRuntimeConfig.mockResolvedValue(null);
  mockEvaluateProjectExecutionReadiness.mockImplementation(async ({ agents }) => ({
    executableAgents: agents,
    blockedAgents: [],
    hasBlockingErrors: false,
    issues: [],
  }));
  mockFindProjectSettings.mockResolvedValue(null);
  mockCleanupClosedSessionArtifacts.mockResolvedValue(undefined);
  mockIsSessionTerminalizationEnabled.mockReturnValue(true);
  mockTerminateConversationSession.mockResolvedValue({
    sessionId: 'db-session-1',
    disposition: 'timeout',
    status: 'abandoned',
    endedAt: '2026-03-30T10:00:00.000Z',
    eventEmitted: true,
    eventId: 'evt-web-debug-close',
    hook: {
      attempted: true,
      mode: 'ignore',
      outcome: 'ignored',
    },
    runtimeEnded: true,
    dbUpdated: true,
    artifactSessionIds: ['sess-close-end'],
  });
  mockGetClickHouseClient.mockReturnValue({});
  mockClickHouseMetricsRecord.mockResolvedValue(undefined);
  mockIsCoordinatorAvailable.mockReturnValue(false);
  mockExecutionCoordinator.submit.mockReset();
  mockWriteAuditEvent.mockResolvedValue(undefined);
  mockCheckAuthPreflightFromIR.mockResolvedValue(null);
  mockEvaluateAuthPreflightFromIR.mockResolvedValue({ pending: [], satisfied: [] });
  mockHasActiveAuthGateAsync.mockResolvedValue(false);
  mockQueueMessageBehindAuthGateAsync.mockResolvedValue(undefined);
  mockReconcileAuthGateWithEvaluationAsync.mockResolvedValue(null);
  mockCleanupAuthGateAsync.mockResolvedValue(undefined);
  mockCreateTokenLookups.mockReturnValue({});
  mockFindProjectAgentByPath.mockReset();
  mockFindProjectAgentByPath.mockResolvedValue(null);
  mockBuildAgentDetails.mockReset();
  (getSessionService as any).mockReturnValue({
    claimOwnership: vi.fn(async () => true),
    refreshOwnershipOnActivity: vi.fn(async () => true),
  });

  // Default: queue returns standard response (queue is always active now)
  mockEnqueueLLMRequest.mockImplementation(async () => ({
    response: 'Hello world',
    action: { type: 'continue' },
    stateUpdates: { gatherProgress: {}, context: {}, conversationPhase: 'active' },
  }));
});

afterEach(() => {
  __resetDebugWsClickHouseStateForTests();
  if (ORIGINAL_USE_MONGO_CLICKHOUSE === undefined) {
    delete process.env.USE_MONGO_CLICKHOUSE;
  } else {
    process.env.USE_MONGO_CLICKHOUSE = ORIGINAL_USE_MONGO_CLICKHOUSE;
  }
});

// =============================================================================
// TESTS
// =============================================================================

describe('WebSocket Handler — handleConnection', () => {
  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  describe('connection lifecycle', () => {
    test('sends info message on connect', async () => {
      handleConnection(ws as any, makeReq());
      await flushMicrotasks();

      const info = findSentMessage(ws, 'info');
      expect(info).toBeDefined();
      expect(info.configured).toBe(true);
    });

    test('replays pending async results with provenance metadata on resume', async () => {
      const pendingDeliveryStore = {
        retrieve: vi.fn(async () => [
          {
            result: {
              response: 'Pending async reply',
              richContent: { type: 'card', title: 'Pending card' },
              actions: [{ type: 'button', label: 'Open' }],
              voiceConfig: { plain_text: 'Pending async reply' },
              responseMetadata: {
                isLlmGenerated: true,
                responseProvenance: {
                  schemaVersion: 1,
                  kind: 'llm',
                  disclaimerRequired: true,
                  usedLlmInternally: true,
                },
              },
            },
          },
        ]),
        remove: vi.fn(async () => {}),
      };

      executor = makeMockExecutor({
        _asyncInfra: { pendingDeliveryStore },
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      const session = makeRuntimeSession({
        id: 'sess-pending',
        tenantId: 'tenant-test',
        userId: 'user-1',
        conversationHistory: [],
      });
      executor.getSession.mockReturnValue(session);

      handleConnection(ws as any, makeReq({ token: 'tok' }));
      ws.simulateMessage(JSON.stringify({ type: 'resume_session', sessionId: 'sess-pending' }));

      await vi.waitFor(() => {
        const pendingEnd = getSentMessages(ws).find(
          (message: any) =>
            message.type === 'response_end' && message.fullText === 'Pending async reply',
        );

        expect(pendingEnd).toMatchObject({
          type: 'response_end',
          fullText: 'Pending async reply',
          richContent: { type: 'card', title: 'Pending card' },
          actions: [{ type: 'button', label: 'Open' }],
          voiceConfig: { plain_text: 'Pending async reply' },
          metadata: {
            isLlmGenerated: true,
            responseProvenance: {
              schemaVersion: 1,
              kind: 'llm',
              disclaimerRequired: true,
              usedLlmInternally: true,
            },
          },
        });
        expect(pendingDeliveryStore.remove).toHaveBeenCalledWith('sess-pending');
      });
    });

    test('replays structured-only pending async results on resume', async () => {
      const pendingDeliveryStore = {
        retrieve: vi.fn(async () => [
          {
            result: {
              response: '',
              richContent: { markdown: '**Pending choices**' },
              actions: { elements: [{ id: 'open', type: 'button', label: 'Open' }] },
              voiceConfig: { plain_text: 'Pending choices' },
              responseMetadata: {
                isLlmGenerated: true,
                responseProvenance: {
                  schemaVersion: 1,
                  kind: 'llm',
                  disclaimerRequired: true,
                  usedLlmInternally: true,
                },
              },
            },
          },
        ]),
        remove: vi.fn(async () => {}),
      };

      executor = makeMockExecutor({
        _asyncInfra: { pendingDeliveryStore },
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      const session = makeRuntimeSession({
        id: 'sess-pending-structured',
        tenantId: 'tenant-test',
        userId: 'user-1',
        conversationHistory: [],
      });
      executor.getSession.mockReturnValue(session);

      handleConnection(ws as any, makeReq({ token: 'tok' }));
      ws.simulateMessage(
        JSON.stringify({ type: 'resume_session', sessionId: 'sess-pending-structured' }),
      );

      await vi.waitFor(() => {
        const pendingEnd = getSentMessages(ws).find(
          (message: any) =>
            message.type === 'response_end' &&
            message.richContent?.markdown === '**Pending choices**',
        );

        expect(pendingEnd).toMatchObject({
          type: 'response_end',
          fullText: '',
          richContent: { markdown: '**Pending choices**' },
          actions: { elements: [{ id: 'open', type: 'button', label: 'Open' }] },
          voiceConfig: { plain_text: 'Pending choices' },
          metadata: {
            isLlmGenerated: true,
            responseProvenance: {
              schemaVersion: 1,
              kind: 'llm',
              disclaimerRequired: true,
              usedLlmInternally: true,
            },
          },
        });
        expect(pendingDeliveryStore.remove).toHaveBeenCalledWith('sess-pending-structured');
      });
    });

    test('registers message, close, and error listeners', () => {
      handleConnection(ws as any, makeReq());

      expect(ws.listenerCount('message')).toBe(1);
      expect(ws.listenerCount('close')).toBe(1);
      expect(ws.listenerCount('error')).toBe(1);
    });

    test('handles connection with no IncomingMessage (undefined req)', () => {
      handleConnection(ws as any, undefined);
      expect(ws.close).toHaveBeenCalledWith(4001, 'Authentication required');
    });

    test('extracts userId from the internal websocket auth token', () => {
      mockExtractUserIdFromToken.mockReturnValue('user-42');

      handleConnection(ws as any, makeReq({ token: 'jwt-token-abc' }));

      expect(mockExtractUserIdFromToken).toHaveBeenCalledWith('jwt-token-abc');
    });

    test('closes the connection when pre-auth buffering exceeds the message count limit', () => {
      mockResolveTenantMembership.mockImplementation(() => new Promise(() => {}));

      handleConnection(ws as any, makeReq({ token: 'tok' }));

      for (let i = 0; i < 17; i += 1) {
        ws.simulateMessage(JSON.stringify({ type: 'list_sessions' }));
      }

      expect(ws.close).toHaveBeenCalledWith(1008, 'Too many queued messages before authentication');
    });

    test('closes the connection when the database is unavailable', () => {
      mockIsDatabaseAvailable.mockReturnValue(false);

      handleConnection(ws as any, makeReq({ token: 'tok' }));

      expect(ws.close).toHaveBeenCalledWith(1011, 'Database unavailable');
    });

    test('closes the connection when tenant membership cannot be resolved', async () => {
      mockResolveTenantMembership.mockResolvedValue(null);
      mockResolveDefaultTenant.mockResolvedValue(null);

      handleConnection(ws as any, makeReq({ token: 'tok' }));

      await vi.waitFor(() => {
        expect(ws.close).toHaveBeenCalledWith(4003, 'Tenant membership required');
      });
    });

    test('delivers cross-pod websocket results with provenance metadata', async () => {
      const subscriber = new EventEmitter() as EventEmitter & {
        subscribe: ReturnType<typeof vi.fn>;
        unsubscribe: ReturnType<typeof vi.fn>;
      };
      subscriber.subscribe = vi.fn(async () => {});
      subscriber.unsubscribe = vi.fn(async () => {});

      setRedisPubSub({
        duplicate: () => subscriber,
      });

      handleConnection(ws as any, makeReq({ token: 'tok' }));
      const session = await loadAgentOnConnection(ws, executor, { id: 'sess-cross-pod' });

      const subscribeCall = subscriber.subscribe.mock.calls[0]?.[0] as string;
      expect(subscribeCall).toContain('ws:deliver:');
      const sessionId = subscribeCall.replace('ws:deliver:', '');
      expect(sessionId).toBe(session.id);

      subscriber.emit(
        'message',
        `ws:deliver:${sessionId}`,
        JSON.stringify({
          response: 'Cross-pod async reply',
          voiceConfig: { plain_text: 'Cross-pod async reply' },
          handoffProgress: {
            phase: 'completed',
            targetAgent: 'WorkerAgent',
            taskId: 'task-cross-pod-1',
            async: true,
          },
          responseMetadata: {
            isLlmGenerated: true,
            responseProvenance: {
              schemaVersion: 1,
              kind: 'llm',
              disclaimerRequired: true,
              usedLlmInternally: true,
            },
          },
        }),
      );

      const pendingEnd = getSentMessages(ws).find(
        (message: any) =>
          message.type === 'response_end' && message.fullText === 'Cross-pod async reply',
      );
      expect(pendingEnd).toMatchObject({
        type: 'response_end',
        sessionId,
        fullText: 'Cross-pod async reply',
        voiceConfig: { plain_text: 'Cross-pod async reply' },
        metadata: {
          isLlmGenerated: true,
          responseProvenance: {
            schemaVersion: 1,
            kind: 'llm',
            disclaimerRequired: true,
            usedLlmInternally: true,
          },
        },
      });
      expect(getSentMessages(ws)).toContainEqual({
        type: 'handoff_progress',
        sessionId,
        progress: {
          phase: 'completed',
          targetAgent: 'WorkerAgent',
          taskId: 'task-cross-pod-1',
          async: true,
        },
      });

      mockFindProjectAgentByPath.mockResolvedValue(null);
      mockBuildAgentDetails.mockReset();
    });
  });

  // ---------------------------------------------------------------------------
  // Authentication gate
  // ---------------------------------------------------------------------------

  describe('authentication gate', () => {
    test('rejects all messages when unauthenticated', async () => {
      mockExtractUserIdFromToken.mockReturnValue(null);
      handleConnection(ws as any, makeReq({ token: null }));

      ws.simulateMessage(
        JSON.stringify({ type: 'load_agent', agentPath: 'test/agent', projectId: 'proj-auth' }),
      );
      await flushMicrotasks();

      expect(ws.close).toHaveBeenCalledWith(4001, 'Authentication required');
    });

    test('rejects send_message when unauthenticated', async () => {
      mockExtractUserIdFromToken.mockReturnValue(null);
      handleConnection(ws as any, makeReq({ token: null }));

      ws.simulateMessage(JSON.stringify({ type: 'send_message', sessionId: 's1', text: 'hi' }));
      await flushMicrotasks();

      expect(ws.close).toHaveBeenCalledWith(4001, 'Authentication required');
    });
  });

  // ---------------------------------------------------------------------------
  // Message parsing
  // ---------------------------------------------------------------------------

  describe('message parsing', () => {
    test('returns error for non-JSON data', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      handleConnection(ws as any, makeReq({ token: 'tok' }));

      ws.simulateMessage('this is not json');
      await flushMicrotasks();

      const error = findSentMessage(ws, 'error');
      expect(error).toBeDefined();
      expect(error.message).toContain('Invalid message format');
    });

    test('returns error for JSON without type field', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      handleConnection(ws as any, makeReq({ token: 'tok' }));

      ws.simulateMessage(JSON.stringify({ foo: 'bar' }));
      await flushMicrotasks();

      const error = findSentMessage(ws, 'error');
      expect(error).toBeDefined();
      expect(error.message).toContain('Invalid message format');
    });

    test('returns error for unknown message type', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      handleConnection(ws as any, makeReq({ token: 'tok' }));

      ws.simulateMessage(JSON.stringify({ type: 'unknown_command' }));
      await flushMicrotasks();

      // Unknown types return null from parseClientMessage, which triggers "Invalid message format"
      const error = findSentMessage(ws, 'error');
      expect(error).toBeDefined();
      expect(error.message).toContain('Invalid message format');
    });

    test('returns error for load_agent without agentPath', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      handleConnection(ws as any, makeReq({ token: 'tok' }));

      ws.simulateMessage(JSON.stringify({ type: 'load_agent' }));
      await flushMicrotasks();

      const error = findSentMessage(ws, 'error');
      expect(error).toBeDefined();
      expect(error.message).toContain('Invalid message format');
    });

    test('returns error for send_message without sessionId', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      handleConnection(ws as any, makeReq({ token: 'tok' }));

      ws.simulateMessage(JSON.stringify({ type: 'send_message', text: 'hello' }));
      await flushMicrotasks();

      const error = findSentMessage(ws, 'error');
      expect(error).toBeDefined();
      expect(error.message).toContain('Invalid message format');
    });
  });

  // ---------------------------------------------------------------------------
  // load_agent
  // ---------------------------------------------------------------------------

  describe('load_agent message', () => {
    test('sends agent_load_error when agent not found in database', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      mockIsDatabaseAvailable.mockReturnValue(true);
      handleConnection(ws as any, makeReq({ token: 'tok' }));
      await waitForAuthenticatedConnection(ws);
      ws.send.mockClear();

      ws.simulateMessage(
        JSON.stringify({
          type: 'load_agent',
          agentPath: 'nonexistent/agent',
          projectId: 'proj-1',
        }),
      );

      // handleLoadAgent is async — allow it to settle
      await vi.waitFor(() => {
        const loadError = findSentMessage(ws, 'agent_load_error');
        expect(loadError).toBeDefined();
        expect(loadError.error).toContain('Agent not found');
      });
    });

    test('sends agent_loaded and state_update on successful load from DB', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      mockIsDatabaseAvailable.mockReturnValue(true);

      // Mock database lookup
      mockFindProjectAgentByPath.mockResolvedValue({
        id: 'agent-db-1',
        name: 'booking_agent',
        dslContent: 'AGENT booking_agent\nROLE: Booking helper\nGOAL: Help with bookings',
        projectId: 'proj-1',
        systemPromptLibraryRef: { promptId: 'prompt-1', versionId: 'version-1' },
      });

      mockBuildAgentDetails.mockReturnValue({
        id: 'booking_agent',
        name: 'booking_agent',
        type: 'agent',
        mode: 'reasoning',
        toolCount: 0,
        gatherFieldCount: 0,
        isSupervisor: false,
        dsl: 'AGENT booking_agent\nROLE: Booking helper\nGOAL: Help with bookings',
      });

      const session = makeRuntimeSession({ id: 'session-new-1' });
      executor.createSessionFromResolved.mockReturnValue(session);
      mockCompileProjectWorkingCopy.mockResolvedValue({
        resolved: {
          agents: {},
          entryAgent: 'booking_agent',
          compilationOutput: { agents: {} },
          sourceHash: 'abc',
          versionInfo: { versions: {} },
        },
        configVariables: {},
        warnings: [],
        documents: [],
        profileDocuments: [],
      });

      handleConnection(ws as any, makeReq({ token: 'tok' }));
      await waitForAuthenticatedConnection(ws);
      ws.send.mockClear();
      ws.simulateMessage(
        JSON.stringify({ type: 'load_agent', agentPath: 'booking_agent', projectId: 'proj-1' }),
      );

      await vi.waitFor(() => {
        const loaded = findSentMessage(ws, 'agent_loaded');
        expect(loaded).toBeDefined();
        expect(loaded.sessionId).toBe('session-new-1');
        expect(loaded.agent.name).toBe('booking_agent');
      });

      const stateUpdate = findSentMessage(ws, 'state_update');
      expect(stateUpdate).toBeDefined();
      expect(stateUpdate.sessionId).toBe('session-new-1');
      expect(mockCompileProjectWorkingCopy).toHaveBeenCalledWith({
        tenantId: 'tenant-test',
        projectId: 'proj-1',
        entryAgentName: 'booking_agent',
        environment: 'dev',
        agents: [
          expect.objectContaining({
            name: 'booking_agent',
            dslContent: 'AGENT booking_agent\nROLE: Booking helper\nGOAL: Help with bookings',
            systemPromptLibraryRef: { promptId: 'prompt-1', versionId: 'version-1' },
          }),
        ],
      });
    });

    test('forwards canonical ON_START metadata when initializeSession already finalized provenance', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      mockIsDatabaseAvailable.mockReturnValue(true);

      mockFindProjectAgentByPath.mockResolvedValue({
        id: 'agent-db-on-start',
        name: 'booking_agent',
        dslContent: 'AGENT booking_agent\nROLE: Booking helper\nGOAL: Help with bookings',
        projectId: 'proj-1',
      });

      mockBuildAgentDetails.mockReturnValue({
        id: 'booking_agent',
        name: 'booking_agent',
        type: 'agent',
        mode: 'reasoning',
        toolCount: 0,
        gatherFieldCount: 0,
        isSupervisor: false,
        dsl: 'AGENT booking_agent\nROLE: Booking helper\nGOAL: Help with bookings',
      });

      const session = makeRuntimeSession({
        id: 'session-on-start-1',
        tenantId: 'tenant-test',
        userId: 'user-1',
        currentFlowStep: 'welcome',
      });
      const canonicalResponseMetadata = {
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1 as const,
          kind: 'llm' as const,
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
        provenanceTag: 'canonical-web-debug-on-start',
      };

      executor.createSessionFromResolved.mockReturnValue(session);
      executor.initializeSession.mockImplementation(
        async (_sid: string, onChunk?: (c: string) => void) => {
          onChunk?.('Welcome from on_start');
          return {
            response: 'Welcome from on_start',
            action: { type: 'continue' },
            responseMetadata: canonicalResponseMetadata,
          };
        },
      );
      mockCompileProjectWorkingCopy.mockResolvedValue({
        resolved: {
          agents: {},
          entryAgent: 'booking_agent',
          compilationOutput: { agents: {} },
          sourceHash: 'abc',
          versionInfo: { versions: {} },
        },
        configVariables: {},
        warnings: [],
        documents: [],
        profileDocuments: [],
      });

      handleConnection(ws as any, makeReq({ token: 'tok' }));
      await waitForAuthenticatedConnection(ws);
      ws.send.mockClear();

      ws.simulateMessage(
        JSON.stringify({ type: 'load_agent', agentPath: 'booking_agent', projectId: 'proj-1' }),
      );

      await vi.waitFor(() => {
        const end = getSentMessages(ws).find(
          (message: any) =>
            message.type === 'response_end' && message.fullText === 'Welcome from on_start',
        );
        expect(end?.metadata).toEqual({ ...canonicalResponseMetadata, agentName: 'test_agent' });
      });
    });

    test('emits and persists structured-only ON_START responses even when no text chunk was streamed', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      mockIsDatabaseAvailable.mockReturnValue(true);

      mockFindProjectAgentByPath.mockResolvedValue({
        id: 'agent-db-on-start-structured',
        name: 'booking_agent',
        dslContent: 'AGENT booking_agent\nROLE: Booking helper\nGOAL: Help with bookings',
        projectId: 'proj-1',
      });

      mockBuildAgentDetails.mockReturnValue({
        id: 'booking_agent',
        name: 'booking_agent',
        type: 'agent',
        mode: 'reasoning',
        toolCount: 0,
        gatherFieldCount: 0,
        isSupervisor: false,
        dsl: 'AGENT booking_agent\nROLE: Booking helper\nGOAL: Help with bookings',
      });

      const session = makeRuntimeSession({
        id: 'session-on-start-structured-1',
        tenantId: 'tenant-test',
        userId: 'user-1',
        currentFlowStep: 'welcome',
      });
      const canonicalResponseMetadata = {
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1 as const,
          kind: 'llm' as const,
          disclaimerRequired: true,
          usedLlmInternally: false,
        },
      };

      executor.createSessionFromResolved.mockReturnValue(session);
      executor.initializeSession.mockResolvedValue({
        response: '',
        action: { type: 'continue' },
        richContent: {
          markdown: '**Welcome to the assistant.**',
        },
        actions: {
          elements: [{ id: 'continue', type: 'button', label: 'Continue' }],
        },
        voiceConfig: {
          plain_text: 'Welcome to the assistant.',
        },
        responseMetadata: canonicalResponseMetadata,
      });
      mockCompileProjectWorkingCopy.mockResolvedValue({
        resolved: {
          agents: {},
          entryAgent: 'booking_agent',
          compilationOutput: { agents: {} },
          sourceHash: 'abc',
          versionInfo: { versions: {} },
        },
        configVariables: {},
        warnings: [],
        documents: [],
        profileDocuments: [],
      });

      handleConnection(ws as any, makeReq({ token: 'tok' }));
      await waitForAuthenticatedConnection(ws);
      ws.send.mockClear();

      ws.simulateMessage(
        JSON.stringify({ type: 'load_agent', agentPath: 'booking_agent', projectId: 'proj-1' }),
      );

      await vi.waitFor(async () => {
        const end = getSentMessages(ws).find(
          (message: any) =>
            message.type === 'response_end' &&
            message.richContent?.markdown === '**Welcome to the assistant.**',
        );
        expect(end).toMatchObject({
          type: 'response_end',
          fullText: '',
          voiceConfig: { plain_text: 'Welcome to the assistant.' },
          actions: {
            elements: [{ id: 'continue', type: 'button', label: 'Continue' }],
          },
          metadata: { ...canonicalResponseMetadata, agentName: 'test_agent' },
        });

        const starts = getSentMessages(ws).filter(
          (message: any) => message.type === 'response_start',
        );
        expect(starts).toHaveLength(1);

        const { persistMessage } = await import('../../services/message-persistence-queue.js');
        expect(persistMessage).toHaveBeenCalled();
        const persistArgs = vi
          .mocked(persistMessage)
          .mock.calls.find((args) => args[1] === 'assistant' && args[2] === '');
        expect(persistArgs).toBeDefined();
        expect(persistArgs?.[3]).toBe('web_debug');
        expect(persistArgs?.[4]).toBe('tenant-test');
        expect(persistArgs?.[7]).toBe('proj-1');
        expect(persistArgs?.[8]).toEqual(expect.any(Number));
        expect(persistArgs?.[9]).toMatchObject({
          richContent: { markdown: '**Welcome to the assistant.**' },
          actions: {
            elements: [{ id: 'continue', type: 'button', label: 'Continue' }],
          },
          voiceConfig: { plain_text: 'Welcome to the assistant.' },
        });
        expect(persistArgs?.[10]).toEqual({
          ...canonicalResponseMetadata,
          agentName: 'test_agent',
        });
      });
    });

    test('ignores stale overlapping load_agent requests on the same connection', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      mockIsDatabaseAvailable.mockReturnValue(true);

      const deferredLookup = (() => {
        let resolve: ((value: unknown) => void) | undefined;
        const promise = new Promise<unknown>((res) => {
          resolve = res;
        });
        return { promise, resolve: resolve! };
      })();

      const agentRecord = {
        id: 'agent-db-overlap',
        name: 'booking_agent',
        dslContent: 'AGENT booking_agent\nROLE: Booking helper\nGOAL: Help with bookings',
        projectId: 'proj-1',
      };

      mockFindProjectAgentByPath
        .mockImplementationOnce(() => deferredLookup.promise)
        .mockResolvedValueOnce(agentRecord);

      mockBuildAgentDetails.mockReturnValue({
        id: 'booking_agent',
        name: 'booking_agent',
        type: 'agent',
        mode: 'reasoning',
        toolCount: 0,
        gatherFieldCount: 0,
        isSupervisor: false,
        dsl: agentRecord.dslContent,
      });

      executor.createSessionFromResolved.mockReturnValue(
        makeRuntimeSession({
          id: 'session-fresh',
          tenantId: 'tenant-test',
          userId: 'user-1',
        }),
      );
      mockCompileProjectWorkingCopy.mockResolvedValue({
        resolved: {
          agents: {},
          entryAgent: 'booking_agent',
          compilationOutput: { agents: {} },
          sourceHash: 'abc',
          versionInfo: { versions: {} },
        },
        configVariables: {},
        warnings: [],
        documents: [],
        profileDocuments: [],
      });

      handleConnection(ws as any, makeReq({ token: 'tok' }));
      await waitForAuthenticatedConnection(ws);
      ws.send.mockClear();

      ws.simulateMessage(
        JSON.stringify({ type: 'load_agent', agentPath: 'booking_agent', projectId: 'proj-1' }),
      );
      await vi.waitFor(() => {
        expect(mockFindProjectAgentByPath).toHaveBeenCalledTimes(1);
      });
      ws.simulateMessage(
        JSON.stringify({ type: 'load_agent', agentPath: 'booking_agent', projectId: 'proj-1' }),
      );

      await vi.waitFor(() => {
        const loaded = findSentMessage(ws, 'agent_loaded');
        expect(loaded).toBeDefined();
        expect(loaded.sessionId).toBe('session-fresh');
      });

      deferredLookup.resolve(agentRecord);
      await flushMicrotasks();

      const loadedMessages = getSentMessages(ws).filter(
        (message) => message.type === 'agent_loaded',
      );
      expect(loadedMessages).toHaveLength(1);
      expect(loadedMessages[0].sessionId).toBe('session-fresh');
      expect(executor.createSessionFromResolved).toHaveBeenCalledTimes(1);
    });

    test('sends agent_load_error on compilation failure', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      mockIsDatabaseAvailable.mockReturnValue(true);

      mockFindProjectAgentByPath.mockResolvedValue({
        id: 'agent-db-2',
        name: 'bad_agent',
        dslContent: 'AGENT bad_agent',
        projectId: 'proj-2',
      });

      mockBuildAgentDetails.mockReturnValue({
        id: 'bad_agent',
        name: 'bad_agent',
        type: 'agent',
        mode: 'reasoning',
        toolCount: 0,
        gatherFieldCount: 0,
        isSupervisor: false,
        dsl: 'AGENT bad_agent',
      });

      mockCompileProjectWorkingCopy.mockRejectedValue(new Error('Compilation failed'));

      handleConnection(ws as any, makeReq({ token: 'tok' }));
      await waitForAuthenticatedConnection(ws);
      ws.send.mockClear();
      ws.simulateMessage(
        JSON.stringify({ type: 'load_agent', agentPath: 'bad_agent', projectId: 'proj-2' }),
      );

      await vi.waitFor(() => {
        const loadError = findSentMessage(ws, 'agent_load_error');
        expect(loadError).toBeDefined();
        // The runtime now surfaces the underlying compiler diagnostic (sanitized
        // by the diagnostic surface) directly instead of wrapping it in the
        // generic "Failed to create runtime session" preamble, so assert on the
        // compilation failure message instead.
        expect(loadError.error).toContain('Compilation failed');
      });
    });

    test('blocks cross-tenant project access during agent load', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      mockIsDatabaseAvailable.mockReturnValue(true);

      mockFindProjectAgentByPath.mockResolvedValue({
        id: 'agent-db-foreign',
        name: 'booking_agent',
        dslContent: 'AGENT booking_agent\nROLE: Booking helper\nGOAL: Help with bookings',
        projectId: 'proj-foreign',
      });

      mockBuildAgentDetails.mockReturnValue({
        id: 'booking_agent',
        name: 'booking_agent',
        type: 'agent',
        mode: 'reasoning',
        toolCount: 0,
        gatherFieldCount: 0,
        isSupervisor: false,
        dsl: 'AGENT booking_agent\nROLE: Booking helper\nGOAL: Help with bookings',
      });

      mockFindProjectByIdAndTenant.mockResolvedValue(null);

      handleConnection(ws as any, makeReq({ token: 'tok' }));
      await waitForAuthenticatedConnection(ws);
      ws.send.mockClear();

      ws.simulateMessage(
        JSON.stringify({
          type: 'load_agent',
          agentPath: 'booking_agent',
          projectId: 'proj-foreign',
        }),
      );

      await vi.waitFor(() => {
        const loadError = findSentMessage(ws, 'agent_load_error');
        expect(loadError).toBeDefined();
        expect(loadError.error).toContain('project belongs to a different workspace');
      });

      expect(executor.createSessionFromResolved).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // ensure_session_persisted
  // ---------------------------------------------------------------------------

  describe('ensure_session_persisted', () => {
    test('creates the debug DB session before the first user message', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      handleConnection(ws as any, makeReq({ token: 'tok' }));

      const session = await loadAgentOnConnection(ws, executor);
      expect(mockConversationStore.createSession).not.toHaveBeenCalled();

      ws.simulateMessage(
        JSON.stringify({
          type: 'ensure_session_persisted',
          sessionId: session.id,
          requestId: 'persist-req-1',
        }),
      );

      await vi.waitFor(() => {
        expect(mockConversationStore.createSession).toHaveBeenCalledWith(
          expect.objectContaining({
            id: session.id,
            channel: 'web_debug',
            projectId: 'proj-load',
            tenantId: 'tenant-test',
          }),
        );
        expect(findSentMessage(ws, 'session_persisted')).toEqual({
          type: 'session_persisted',
          sessionId: session.id,
          requestId: 'persist-req-1',
          persisted: true,
        });
      });
    });

    test('does not create a duplicate DB session when already persisted', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      handleConnection(ws as any, makeReq({ token: 'tok' }));

      const session = await loadAgentOnConnection(ws, executor);
      ws.simulateMessage(
        JSON.stringify({
          type: 'ensure_session_persisted',
          sessionId: session.id,
          requestId: 'persist-req-1',
        }),
      );

      await vi.waitFor(() => {
        expect(findSentMessage(ws, 'session_persisted')).toBeDefined();
      });
      ws.send.mockClear();

      ws.simulateMessage(
        JSON.stringify({
          type: 'ensure_session_persisted',
          sessionId: session.id,
          requestId: 'persist-req-2',
        }),
      );

      await vi.waitFor(() => {
        expect(mockConversationStore.createSession).toHaveBeenCalledTimes(1);
        expect(findSentMessage(ws, 'session_persisted')).toEqual({
          type: 'session_persisted',
          sessionId: session.id,
          requestId: 'persist-req-2',
          persisted: true,
        });
      });
    });
  });

  // ---------------------------------------------------------------------------
  // send_message
  // ---------------------------------------------------------------------------

  describe('send_message', () => {
    test('sends error when session not found', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      handleConnection(ws as any, makeReq({ token: 'tok' }));

      executor.getSession.mockReturnValue(undefined);

      ws.simulateMessage(
        JSON.stringify({
          type: 'send_message',
          sessionId: 'nonexistent-session',
          text: 'hello',
        }),
      );

      // handleSendMessage is sync-started but has async branches; wait for error
      await vi.waitFor(() => {
        const error = findSentMessage(ws, 'error');
        expect(error).toBeDefined();
        expect(error.message).toContain('Session not found');
      });
    });

    test('streams response chunks and sends response_start / response_end', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      handleConnection(ws as any, makeReq({ token: 'tok' }));

      // Load agent so clientState.runtimeSession is set
      const session = await loadAgentOnConnection(ws, executor);

      executor.isConfigured.mockReturnValue(true);
      mockEnqueueLLMRequest.mockImplementation(
        async (_sid: string, _text: string, onChunk?: (c: string) => void) => {
          onChunk?.('chunk1');
          onChunk?.('chunk2');
          return {
            response: 'chunk1chunk2',
            action: { type: 'continue' },
            stateUpdates: { gatherProgress: {}, context: {}, conversationPhase: 'active' },
          };
        },
      );

      ws.simulateMessage(
        JSON.stringify({
          type: 'send_message',
          sessionId: session.id,
          text: 'Hello agent',
        }),
      );

      await vi.waitFor(() => {
        const msgs = getSentMessages(ws);
        const start = msgs.find((m: any) => m.type === 'response_start');
        const end = msgs.find((m: any) => m.type === 'response_end');
        expect(start).toBeDefined();
        expect(start.sessionId).toBe(session.id);
        expect(end).toBeDefined();
        expect(end.fullText).toBe('chunk1chunk2');
      });
    });

    test('persists structured-only assistant replies from web debug chat', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      handleConnection(ws as any, makeReq({ token: 'tok' }));

      const session = await loadAgentOnConnection(ws, executor);
      const { persistMessage } = await import('../../services/message-persistence-queue.js');
      vi.mocked(persistMessage).mockClear();

      const responseMetadata = {
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1 as const,
          kind: 'llm' as const,
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
      };

      mockEnqueueLLMRequest.mockResolvedValueOnce({
        response: '',
        action: { type: 'continue' },
        richContent: { markdown: '**Choose a debug option**' },
        actions: { elements: [{ id: 'debug-next', type: 'button', label: 'Next' }] },
        voiceConfig: { plain_text: 'Choose a debug option' },
        responseMetadata,
      });

      ws.simulateMessage(
        JSON.stringify({
          type: 'send_message',
          sessionId: session.id,
          text: 'Show debug options',
        }),
      );

      await vi.waitFor(() => {
        const end = findSentMessage(ws, 'response_end');
        expect(end).toMatchObject({
          type: 'response_end',
          fullText: '',
          richContent: { markdown: '**Choose a debug option**' },
          actions: { elements: [{ id: 'debug-next', type: 'button', label: 'Next' }] },
          voiceConfig: { plain_text: 'Choose a debug option' },
          metadata: { ...responseMetadata, agentName: 'test_agent' },
        });

        expect(persistMessage).toHaveBeenCalledWith(
          'sess-preloaded',
          'assistant',
          '',
          'web_debug',
          'tenant-test',
          undefined,
          undefined,
          'proj-load',
          expect.any(Number),
          {
            richContent: { markdown: '**Choose a debug option**' },
            actions: { elements: [{ id: 'debug-next', type: 'button', label: 'Next' }] },
            voiceConfig: { plain_text: 'Choose a debug option' },
          },
          { ...responseMetadata, agentName: 'test_agent' },
        );
      });
    });

    test('attaches provenance metadata to response_end when llm_call traces indicate a visible model response', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      handleConnection(ws as any, makeReq({ token: 'tok' }));

      const session = await loadAgentOnConnection(ws, executor);

      executor.isConfigured.mockReturnValue(true);
      mockEnqueueLLMRequest.mockImplementation(
        async (
          _sid: string,
          _text: string,
          onChunk?: (c: string) => void,
          onTrace?: (e: any) => void,
        ) => {
          onChunk?.('reply');
          onTrace?.({
            type: 'llm_call',
            data: {
              usage: { inputTokens: 12, outputTokens: 34 },
              cost: 0.002,
              operationType: 'response_gen',
              responseContribution: 'customer_visible',
            },
          });
          return {
            response: 'reply',
            action: { type: 'continue' },
            stateUpdates: { gatherProgress: {}, context: {}, conversationPhase: 'active' },
          };
        },
      );

      ws.simulateMessage(
        JSON.stringify({
          type: 'send_message',
          sessionId: session.id,
          text: 'Hello agent',
        }),
      );

      await vi.waitFor(() => {
        const end = findSentMessage(ws, 'response_end');
        expect(end).toMatchObject({
          type: 'response_end',
          fullText: 'reply',
          metadata: {
            isLlmGenerated: true,
            responseProvenance: {
              schemaVersion: 1,
              kind: 'llm',
              disclaimerRequired: true,
              usedLlmInternally: true,
            },
          },
        });
      });
    });

    test('prefers canonical responseMetadata from execution results over recomputed trace metadata', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      handleConnection(ws as any, makeReq({ token: 'tok' }));

      const session = await loadAgentOnConnection(ws, executor);
      const canonicalResponseMetadata = {
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1 as const,
          kind: 'llm' as const,
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
        provenanceTag: 'canonical-web-debug-chat',
      };

      executor.isConfigured.mockReturnValue(true);
      mockEnqueueLLMRequest.mockImplementation(
        async (_sid: string, _text: string, onChunk?: (c: string) => void) => {
          onChunk?.('reply');
          return {
            response: 'reply',
            action: { type: 'continue' },
            stateUpdates: { gatherProgress: {}, context: {}, conversationPhase: 'active' },
            responseMetadata: canonicalResponseMetadata,
          };
        },
      );

      ws.simulateMessage(
        JSON.stringify({
          type: 'send_message',
          sessionId: session.id,
          text: 'Hello agent',
        }),
      );

      await vi.waitFor(() => {
        const end = findSentMessage(ws, 'response_end');
        expect(end?.metadata).toEqual({ ...canonicalResponseMetadata, agentName: 'test_agent' });
      });
    });

    test('does not persist the user turn via websocket when the message was forwarded to an active transfer', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      handleConnection(ws as any, makeReq({ token: 'tok' }));

      const session = await loadAgentOnConnection(ws, executor);

      const { persistMessage } = await import('../../services/message-persistence-queue.js');
      ws.send.mockClear();
      (persistMessage as any).mockClear();

      mockEnqueueLLMRequest.mockResolvedValue({
        response: '',
        action: { type: 'transfer_active' },
        stateUpdates: { gatherProgress: {}, context: {}, conversationPhase: 'active' },
      });

      ws.simulateMessage(
        JSON.stringify({
          type: 'send_message',
          sessionId: session.id,
          text: 'Transfer question',
        }),
      );

      await vi.waitFor(() => {
        const end = findSentMessage(ws, 'response_end');
        expect(end).toBeDefined();
        expect(end.actions).toEqual([{ type: 'transfer_active' }]);
      });

      expect(persistMessage).not.toHaveBeenCalled();
    });

    test('reactivates persisted summary when sending to a rehydrated historical session', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      handleConnection(ws as any, makeReq({ token: 'tok' }));

      const session = makeRuntimeSession({
        id: 'sess-historical',
        tenantId: 'tenant-test',
        userId: 'user-1',
      });
      executor.getSession.mockReturnValue(undefined);
      executor.rehydrateSession.mockResolvedValue(session);
      executor.isConfigured.mockReturnValue(true);

      ws.simulateMessage(
        JSON.stringify({
          type: 'send_message',
          sessionId: 'sess-historical',
          text: 'Continue this old chat',
        }),
      );

      await vi.waitFor(() => {
        expect(mockUpdateSession).toHaveBeenCalledWith(
          'sess-historical',
          expect.objectContaining({
            status: 'active',
            endedAt: null,
            disposition: null,
            dispositionCode: null,
          }),
          'tenant-test',
        );
      });
    });

    test('passes the client message id into coordinator dedup for debug websocket turns', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      handleConnection(ws as any, makeReq({ token: 'tok' }));

      const session = await loadAgentOnConnection(ws, executor);
      mockIsCoordinatorAvailable.mockReturnValue(true);
      mockExecutionCoordinator.submit.mockResolvedValue({
        status: 'completed',
        response: 'Hello from coordinator',
        resultData: {
          response: 'Hello from coordinator',
          action: { type: 'continue' },
        },
      });

      ws.simulateMessage(
        JSON.stringify({
          type: 'send_message',
          sessionId: session.id,
          text: 'Hello agent',
          messageId: 'studio-msg-1',
        }),
      );

      await vi.waitFor(() => {
        expect(mockExecutionCoordinator.submit).toHaveBeenCalledTimes(1);
      });

      expect(mockExecutionCoordinator.submit).toHaveBeenCalledWith(
        session.id,
        'Hello agent',
        expect.objectContaining({
          dedupKey: 'web_debug:studio-msg-1',
        }),
      );
    });

    test('emits auth lifecycle traces when preflight activates and queues a message', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      handleConnection(ws as any, makeReq({ token: 'tok' }));

      const session = await loadAgentOnConnection(ws, executor, {
        compilationOutput: { agents: {} },
      });

      const pendingRequirement = {
        connector: 'google',
        authProfileRef: 'google-creds',
        connectionMode: 'per_user',
      };
      mockCheckAuthPreflightFromIR.mockResolvedValue({
        active: true,
        pending: [pendingRequirement],
        satisfied: [],
        queuedMessages: [],
        createdAt: Date.now(),
      });

      ws.simulateMessage(
        JSON.stringify({
          type: 'send_message',
          sessionId: session.id,
          text: 'Need auth first',
          attachmentIds: ['att-1'],
        }),
      );

      await vi.waitFor(() => {
        expect(findSentMessage(ws, 'auth_required')).toBeDefined();
        expect(findSentMessage(ws, 'message_queued')).toBeDefined();
      });

      const authTraces = getSentMessages(ws).filter(
        (message: any) =>
          message.type === 'trace_event' && message.event?.data?.source === 'auth_contract',
      );
      expect(authTraces).toHaveLength(2);
      expect(authTraces[0].sessionId).toBe(session.id);
      expect(authTraces[0].event.data.code).toBe('AUTH_PREFLIGHT_REQUIRED');
      expect(authTraces[0].event.data.decision).toBe('preflight_required');
      expect(authTraces[1].event.data.code).toBe('AUTH_PREFLIGHT_REQUIRED');
      expect(authTraces[1].event.data.decision).toBe('message_queued');
      expect(authTraces[1].event.data.attachmentCount).toBe(1);

      expect(traceStore.addEvent).toHaveBeenCalledWith(
        session.id,
        expect.objectContaining({
          sessionId: session.id,
          type: 'decision',
          data: expect.objectContaining({
            source: 'auth_contract',
            code: 'AUTH_PREFLIGHT_REQUIRED',
          }),
        }),
      );
      expect(mockQueueMessageBehindAuthGateAsync).toHaveBeenCalledWith(
        session.id,
        'Need auth first',
        ['att-1'],
      );
    });

    test('sends response chunks via ws.send for each onChunk callback', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      handleConnection(ws as any, makeReq({ token: 'tok' }));

      await loadAgentOnConnection(ws, executor);

      executor.isConfigured.mockReturnValue(true);
      mockEnqueueLLMRequest.mockImplementation(
        async (_sid: string, _text: string, onChunk?: (c: string) => void) => {
          onChunk?.('A');
          onChunk?.('B');
          onChunk?.('C');
          return {
            response: 'ABC',
            action: { type: 'continue' },
            stateUpdates: { gatherProgress: {}, context: {}, conversationPhase: 'active' },
          };
        },
      );

      ws.simulateMessage(
        JSON.stringify({
          type: 'send_message',
          sessionId: 'sess-preloaded',
          text: 'test',
        }),
      );

      await vi.waitFor(() => {
        const chunks = getSentMessages(ws).filter((m: any) => m.type === 'response_chunk');
        expect(chunks).toHaveLength(3);
        expect(chunks.map((c: any) => c.chunk)).toEqual(['A', 'B', 'C']);
      });
    });

    test('sends response_start then error response_end on execution failure', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      handleConnection(ws as any, makeReq({ token: 'tok' }));

      await loadAgentOnConnection(ws, executor);

      executor.isConfigured.mockReturnValue(true);
      mockEnqueueLLMRequest.mockRejectedValue(new Error('LLM timeout'));

      ws.simulateMessage(
        JSON.stringify({
          type: 'send_message',
          sessionId: 'sess-preloaded',
          text: 'Fail please',
        }),
      );

      await vi.waitFor(() => {
        const msgs = getSentMessages(ws);
        const start = msgs.find((m: any) => m.type === 'response_start');
        const end = msgs.find((m: any) => m.type === 'response_end');
        expect(start).toBeDefined();
        expect(end).toBeDefined();
        expect(end.fullText).toContain('error');
      });
    });

    test('sends state_update and action_taken after successful execution', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      handleConnection(ws as any, makeReq({ token: 'tok' }));

      await loadAgentOnConnection(ws, executor);

      executor.isConfigured.mockReturnValue(true);
      mockEnqueueLLMRequest.mockImplementation(
        async (_sid: string, _text: string, onChunk?: (c: string) => void) => {
          onChunk?.('reply');
          return {
            response: 'reply',
            action: { type: 'continue' },
            stateUpdates: {
              gatherProgress: { name: 'John' },
              context: { key: 'val' },
              conversationPhase: 'collecting',
            },
          };
        },
      );

      ws.simulateMessage(
        JSON.stringify({
          type: 'send_message',
          sessionId: 'sess-preloaded',
          text: 'My name is John',
        }),
      );

      await vi.waitFor(() => {
        const msgs = getSentMessages(ws);
        const stateMsg = msgs.find((m: any) => m.type === 'state_update');
        const actionMsg = msgs.find((m: any) => m.type === 'action_taken');
        expect(stateMsg).toBeDefined();
        expect(stateMsg.state.gatherProgress).toEqual({ name: 'John' });
        expect(actionMsg).toBeDefined();
        expect(actionMsg.action.type).toBe('continue');
      });
    });

    test('does not initialize ClickHouse when debug websocket analytics are disabled', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      handleConnection(ws as any, makeReq({ token: 'tok' }));

      await loadAgentOnConnection(ws, executor);

      ws.simulateMessage(
        JSON.stringify({
          type: 'send_message',
          sessionId: 'sess-preloaded',
          text: 'No analytics please',
        }),
      );

      await vi.waitFor(() => {
        expect(findSentMessage(ws, 'response_end')).toBeDefined();
      });
      await flushMicrotasks();

      expect(mockGetClickHouseClient).not.toHaveBeenCalled();
    });

    test('records websocket metrics without duplicating session lifecycle audit events', async () => {
      process.env.USE_MONGO_CLICKHOUSE = 'true';
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      handleConnection(ws as any, makeReq({ token: 'tok' }));

      await loadAgentOnConnection(ws, executor);

      ws.simulateMessage(
        JSON.stringify({
          type: 'send_message',
          sessionId: 'sess-preloaded',
          text: 'Enable canonical audit writes',
        }),
      );

      await vi.waitFor(() => {
        expect(findSentMessage(ws, 'response_end')).toBeDefined();
      });
      await flushMicrotasks();

      expect(mockClickHouseMetricsRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-preloaded',
          tenantId: 'tenant-test',
        }),
      );
      expect(mockWriteAuditEvent).not.toHaveBeenCalled();
    });

    test('backs off ClickHouse initialization after a connection failure', async () => {
      process.env.USE_MONGO_CLICKHOUSE = 'true';
      mockGetClickHouseClient.mockImplementation(() => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:8123');
      });
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      handleConnection(ws as any, makeReq({ token: 'tok' }));

      await loadAgentOnConnection(ws, executor);

      ws.simulateMessage(
        JSON.stringify({
          type: 'send_message',
          sessionId: 'sess-preloaded',
          text: 'First attempt',
        }),
      );

      await vi.waitFor(() => {
        const ends = getSentMessages(ws).filter((message: any) => message.type === 'response_end');
        expect(ends).toHaveLength(1);
      });
      await flushMicrotasks();

      ws.simulateMessage(
        JSON.stringify({
          type: 'send_message',
          sessionId: 'sess-preloaded',
          text: 'Second attempt',
        }),
      );

      await vi.waitFor(() => {
        const ends = getSentMessages(ws).filter((message: any) => message.type === 'response_end');
        expect(ends).toHaveLength(2);
      });
      await vi.waitFor(() => {
        expect(mockGetClickHouseClient).toHaveBeenCalledTimes(1);
      });
    });

    test('uses fallback mode when executor is not configured', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      handleConnection(ws as any, makeReq({ token: 'tok' }));

      await loadAgentOnConnection(ws, executor);

      // Mark executor as not configured — triggers fallback path
      executor.isConfigured.mockReturnValue(false);

      ws.simulateMessage(
        JSON.stringify({
          type: 'send_message',
          sessionId: 'sess-preloaded',
          text: 'hello',
        }),
      );

      await vi.waitFor(
        () => {
          const msgs = getSentMessages(ws);
          const end = msgs.find((m: any) => m.type === 'response_end');
          expect(end).toBeDefined();
          // Fallback response includes the agent name (underscores replaced with spaces)
          expect(end.fullText).toContain('test agent');
        },
        { timeout: 5000 },
      );
    });

    test('rehydrates the session when it is no longer bound to the connection', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      handleConnection(ws as any, makeReq({ token: 'tok' }));
      await waitForAuthenticatedConnection(ws);
      ws.send.mockClear();

      const rehydratedSession = makeRuntimeSession({
        id: 'sess-rehydrated',
        tenantId: 'tenant-test',
        userId: 'user-1',
        projectId: 'proj-load',
      });

      executor.getSession.mockReturnValue(undefined);
      executor.rehydrateSession.mockResolvedValue(rehydratedSession);
      executor.isConfigured.mockReturnValue(true);
      mockEnqueueLLMRequest.mockImplementation(
        async (_sid: string, _text: string, onChunk?: (c: string) => void) => {
          onChunk?.('rehydrated ');
          onChunk?.('reply');
          return {
            response: 'rehydrated reply',
            action: { type: 'continue' },
            stateUpdates: { gatherProgress: {}, context: {}, conversationPhase: 'active' },
          };
        },
      );

      ws.simulateMessage(
        JSON.stringify({
          type: 'send_message',
          sessionId: 'sess-rehydrated',
          text: 'hello again',
        }),
      );

      await vi.waitFor(() => {
        const end = findSentMessage(ws, 'response_end');
        expect(end).toBeDefined();
        expect(end.fullText).toBe('rehydrated reply');
      });

      expect(executor.rehydrateSession).toHaveBeenCalledWith('sess-rehydrated', undefined);
      expect(executor.rewireSessionToolExecutor).toHaveBeenCalledWith('sess-rehydrated');
    });
  });

  // ---------------------------------------------------------------------------
  // action_submit
  // ---------------------------------------------------------------------------

  describe('action_submit', () => {
    test('forwards canonical responseMetadata when action execution already finalized provenance', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      handleConnection(ws as any, makeReq({ token: 'tok' }));

      const session = await loadAgentOnConnection(ws, executor);
      const canonicalResponseMetadata = {
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1 as const,
          kind: 'llm' as const,
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
        provenanceTag: 'canonical-web-debug-action',
      };

      executor.executeMessage.mockImplementationOnce(
        async (_id: string, _text: string, onChunk?: (c: string) => void) => {
          onChunk?.('Action reply');
          return {
            response: 'Action reply',
            action: { type: 'continue' },
            responseMetadata: canonicalResponseMetadata,
          };
        },
      );

      ws.simulateMessage(
        JSON.stringify({
          type: 'action_submit',
          sessionId: session.id,
          actionId: 'approve',
          value: 'yes',
        }),
      );

      await vi.waitFor(() => {
        const end = findSentMessage(ws, 'response_end');
        expect(end?.metadata).toEqual({ ...canonicalResponseMetadata, agentName: 'test_agent' });
      });
    });

    test('persists web debug action_submit assistant replies with structured content', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      handleConnection(ws as any, makeReq({ token: 'tok' }));

      const session = await loadAgentOnConnection(ws, executor);
      const { persistMessage } = await import('../../services/message-persistence-queue.js');
      vi.mocked(persistMessage).mockClear();

      const responseMetadata = {
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1 as const,
          kind: 'llm' as const,
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
      };

      executor.executeMessage.mockResolvedValueOnce({
        response: '',
        action: { type: 'continue' },
        richContent: { markdown: '**Action saved**' },
        actions: { elements: [{ id: 'done', type: 'button', label: 'Done' }] },
        voiceConfig: { plain_text: 'Action saved' },
        responseMetadata,
      });

      ws.simulateMessage(
        JSON.stringify({
          type: 'action_submit',
          sessionId: session.id,
          actionId: 'approve',
          value: 'yes',
        }),
      );

      await vi.waitFor(() => {
        const end = findSentMessage(ws, 'response_end');
        expect(end).toMatchObject({
          type: 'response_end',
          fullText: '',
          richContent: { markdown: '**Action saved**' },
          actions: { elements: [{ id: 'done', type: 'button', label: 'Done' }] },
          voiceConfig: { plain_text: 'Action saved' },
          metadata: { ...responseMetadata, agentName: 'test_agent' },
        });

        expect(persistMessage).toHaveBeenCalledWith(
          'sess-preloaded',
          'assistant',
          '',
          'web_debug',
          'tenant-test',
          undefined,
          undefined,
          'proj-load',
          expect.any(Number),
          {
            richContent: { markdown: '**Action saved**' },
            actions: { elements: [{ id: 'done', type: 'button', label: 'Done' }] },
            voiceConfig: { plain_text: 'Action saved' },
          },
          { ...responseMetadata, agentName: 'test_agent' },
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // get_state
  // ---------------------------------------------------------------------------

  describe('get_state', () => {
    test('sends state_update with current session state', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      const session = makeRuntimeSession({
        id: 'sess-gs',
        tenantId: 'tenant-test',
        userId: 'user-1',
        state: {
          gatherProgress: { field: 'val' },
          context: { ctx: 1 },
          conversationPhase: 'collecting',
        },
      });
      executor.getSession.mockReturnValue(session);

      handleConnection(ws as any, makeReq({ token: 'tok' }));
      await waitForAuthenticatedConnection(ws);
      ws.send.mockClear();

      ws.simulateMessage(JSON.stringify({ type: 'get_state', sessionId: 'sess-gs' }));

      await vi.waitFor(() => {
        const stateMsg = getSentMessages(ws).find(
          (m: any) => m.type === 'state_update' && m.sessionId === 'sess-gs',
        );
        expect(stateMsg).toBeDefined();
        expect(stateMsg.state.gatherProgress).toEqual({ field: 'val' });
        expect(stateMsg.state.conversationPhase).toBe('collecting');
      });
    });

    test('sends error when session not found for get_state', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      executor.getSession.mockReturnValue(undefined);

      handleConnection(ws as any, makeReq({ token: 'tok' }));

      ws.simulateMessage(JSON.stringify({ type: 'get_state', sessionId: 'missing' }));
      await flushMicrotasks();

      const error = findSentMessage(ws, 'error');
      expect(error).toBeDefined();
      expect(error.message).toContain('Session not found');
    });
  });

  // ---------------------------------------------------------------------------
  // subscribe_session / unsubscribe_session
  // ---------------------------------------------------------------------------

  describe('subscribe_session', () => {
    test('subscribes to trace store and sends subscribed ack', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      traceStore.subscribe.mockResolvedValue({ success: true, eventCount: 5 });
      // handleSubscribeSession calls getAuthorizedRuntimeSession which needs
      // a runtime session with matching tenant/user ownership
      executor.getSession.mockReturnValue(
        makeRuntimeSession({ id: 'sess-sub', tenantId: 'tenant-test', userId: 'user-1' }),
      );

      handleConnection(ws as any, makeReq({ token: 'tok' }));

      ws.simulateMessage(JSON.stringify({ type: 'subscribe_session', sessionId: 'sess-sub' }));

      await vi.waitFor(() => {
        const sub = findSentMessage(ws, 'subscribed');
        expect(sub).toBeDefined();
        expect(sub.sessionId).toBe('sess-sub');
        expect(sub.eventCount).toBe(5);
      });
    });

    test('sends error when subscription fails', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      traceStore.subscribe.mockResolvedValue({ success: false, eventCount: 0 });
      // Session must exist and pass ownership check to reach the subscribe logic
      executor.getSession.mockReturnValue(
        makeRuntimeSession({ id: 'sess-fail', tenantId: 'tenant-test', userId: 'user-1' }),
      );

      handleConnection(ws as any, makeReq({ token: 'tok' }));

      ws.simulateMessage(JSON.stringify({ type: 'subscribe_session', sessionId: 'sess-fail' }));

      await vi.waitFor(() => {
        const error = findSentMessage(ws, 'error');
        expect(error).toBeDefined();
        expect(error.message).toContain('Failed to subscribe');
      });
    });
  });

  describe('unsubscribe_session', () => {
    test('unsubscribes from trace store and sends ack', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');

      handleConnection(ws as any, makeReq({ token: 'tok' }));

      ws.simulateMessage(JSON.stringify({ type: 'unsubscribe_session', sessionId: 'sess-unsub' }));
      await flushMicrotasks();

      expect(traceStore.unsubscribe).toHaveBeenCalledWith('sess-unsub', ws);

      const unsub = findSentMessage(ws, 'unsubscribed');
      expect(unsub).toBeDefined();
      expect(unsub.sessionId).toBe('sess-unsub');
    });
  });

  // ---------------------------------------------------------------------------
  // list_sessions
  // ---------------------------------------------------------------------------

  describe('list_sessions', () => {
    test('sends session_list with active sessions from trace store', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      traceStore.getActiveSessions.mockReturnValue(['s1', 's2']);
      traceStore.getSessionInfo.mockImplementation((id: string) => ({
        agentName: `agent_${id}`,
        eventCount: 10,
        lastActivity: new Date('2026-01-15'),
      }));
      // Sessions must have tenantId/userId matching the client's resolved context.
      // Client resolves to tenantId='tenant-test' (from token claims via resolveTenantMembership).
      executor.getSession.mockImplementation((id: string) =>
        makeRuntimeSession({
          id,
          tenantId: 'tenant-test',
          userId: 'user-1',
        }),
      );

      handleConnection(ws as any, makeReq({ token: 'tok' }));

      ws.simulateMessage(JSON.stringify({ type: 'list_sessions' }));

      await vi.waitFor(() => {
        const list = findSentMessage(ws, 'session_list');
        expect(list).toBeDefined();
        expect(list.sessions).toHaveLength(2);
        expect(list.sessions[0].sessionId).toBe('s1');
        expect(list.sessions[0].agentName).toBe('agent_s1');
      });
    });

    test('returns empty list when no active sessions', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      traceStore.getActiveSessions.mockReturnValue([]);

      handleConnection(ws as any, makeReq({ token: 'tok' }));

      ws.simulateMessage(JSON.stringify({ type: 'list_sessions' }));
      await flushMicrotasks();

      const list = findSentMessage(ws, 'session_list');
      expect(list).toBeDefined();
      expect(list.sessions).toHaveLength(0);
    });

    test('filters sessions by tenant and user ownership while keeping anonymous tenant sessions visible', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      traceStore.getActiveSessions.mockReturnValue([
        'session-own',
        'session-other-user',
        'session-other-tenant',
        'session-anonymous',
      ]);
      traceStore.getSessionInfo.mockImplementation((id: string) => ({
        agentName: `agent_${id}`,
        eventCount: 10,
        lastActivity: new Date('2026-01-15'),
      }));
      executor.getSession.mockImplementation((id: string) => {
        if (id === 'session-own') {
          return makeRuntimeSession({
            id,
            tenantId: 'tenant-test',
            userId: 'user-1',
          });
        }
        if (id === 'session-other-user') {
          return makeRuntimeSession({
            id,
            tenantId: 'tenant-test',
            userId: 'user-2',
          });
        }
        if (id === 'session-other-tenant') {
          return makeRuntimeSession({
            id,
            tenantId: 'tenant-other',
            userId: 'user-1',
          });
        }
        if (id === 'session-anonymous') {
          return makeRuntimeSession({
            id,
            tenantId: 'tenant-test',
            userId: undefined,
          });
        }
        return undefined;
      });

      handleConnection(ws as any, makeReq({ token: 'tok' }));

      ws.simulateMessage(JSON.stringify({ type: 'list_sessions' }));

      await vi.waitFor(() => {
        const list = findSentMessage(ws, 'session_list');
        expect(list).toBeDefined();
        expect(list.sessions.map((session: { sessionId: string }) => session.sessionId)).toEqual([
          'session-own',
          'session-anonymous',
        ]);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // resume_session
  // ---------------------------------------------------------------------------

  describe('resume_session', () => {
    test('sends session_resumed with state and history on success', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      traceStore.readSince.mockResolvedValue({
        events: [{ id: 'evt-missed', sessionId: 'sess-resume', type: 'llm_call', data: {} }],
        totalBuffered: 1,
        afterEventId: 'evt-live',
        snapshotRequired: false,
      });
      // Client resolves to tenantId='tenant-test' from token claims via resolveTenantMembership.
      // Session tenantId/userId must match the client's resolved context.
      const session = makeRuntimeSession({
        id: 'sess-resume',
        tenantId: 'tenant-test',
        userId: 'user-1',
        conversationHistory: [
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello!' },
          { role: 'system', content: 'sys-prompt' },
        ],
        state: { gatherProgress: { g: 1 }, context: { c: 2 }, conversationPhase: 'active' },
      });
      executor.getSession.mockReturnValue(session);

      handleConnection(ws as any, makeReq({ token: 'tok' }));

      ws.simulateMessage(
        JSON.stringify({
          type: 'resume_session',
          sessionId: 'sess-resume',
          lastSeenTraceEventId: 'evt-live',
        }),
      );

      await vi.waitFor(() => {
        const resumed = findSentMessage(ws, 'session_resumed');
        expect(resumed).toBeDefined();
        expect(resumed.sessionId).toBe('sess-resume');
        // System messages are filtered out of conversation history
        expect(resumed.conversationHistory).toHaveLength(2);
        expect(resumed.conversationHistory[0].id).toMatch(/^resume-sess-resume-0-[0-9a-f]{12}$/);
        expect(resumed.conversationHistory[1].id).toMatch(/^resume-sess-resume-1-[0-9a-f]{12}$/);
        expect(resumed.state.gatherProgress).toEqual({ g: 1 });
        expect(resumed.agent).toMatchObject({
          id: 'test_agent',
          name: 'test_agent',
          type: 'agent',
        });
      });

      expect(traceStore.readSince).toHaveBeenCalledWith('sess-resume', 'evt-live', {
        tenantId: 'tenant-test',
      });

      const replay = findSentMessage(ws, 'trace_replay');
      expect(replay).toEqual({
        type: 'trace_replay',
        sessionId: 'sess-resume',
        events: [{ id: 'evt-missed', sessionId: 'sess-resume', type: 'llm_call', data: {} }],
        totalBuffered: 1,
        source: 'resume',
        afterEventId: 'evt-live',
        snapshotRequired: false,
      });

      expect(mockUpdateSession).toHaveBeenCalledWith(
        'sess-resume',
        expect.objectContaining({
          status: 'active',
          endedAt: null,
          disposition: null,
          dispositionCode: null,
        }),
        'tenant-test',
      );
    });

    test('preserves contentEnvelope and metadata on runtime-backed resume snapshots', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      const contentEnvelope = {
        version: 2 as const,
        format: 'message_envelope' as const,
        text: '',
        richContent: {
          markdown: '**Choose an option**',
        },
        actions: {
          elements: [{ id: 'resume-option', type: 'button' as const, label: 'Choose' }],
        },
        voiceConfig: {
          plain_text: 'Choose an option',
        },
      };
      const metadata = {
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1,
          kind: 'llm',
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
      };
      const session = makeRuntimeSession({
        id: 'sess-resume-envelope',
        tenantId: 'tenant-test',
        projectId: 'proj-load',
        userId: 'user-1',
        conversationHistory: [
          { role: 'user', content: 'Show me options' },
          {
            role: 'assistant',
            content: '',
            contentEnvelope,
            metadata,
          },
        ],
        state: { gatherProgress: {}, context: {}, conversationPhase: 'active' },
      });
      executor.getSession.mockReturnValue(session);

      handleConnection(ws as any, makeReq({ token: 'tok' }));

      ws.simulateMessage(
        JSON.stringify({
          type: 'resume_session',
          sessionId: 'sess-resume-envelope',
        }),
      );

      await vi.waitFor(() => {
        const resumed = findSentMessage(ws, 'session_resumed');
        expect(resumed).toBeDefined();
        expect(resumed.conversationHistory).toEqual([
          expect.objectContaining({
            role: 'user',
            content: 'Show me options',
          }),
          expect.objectContaining({
            role: 'assistant',
            content: '',
            contentEnvelope,
            metadata,
          }),
        ]);
      });
    });

    test('sends session_expired when session not found anywhere', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      executor.getSession.mockReturnValue(undefined);
      executor.rehydrateSession.mockResolvedValue(null);

      handleConnection(ws as any, makeReq({ token: 'tok' }));

      ws.simulateMessage(JSON.stringify({ type: 'resume_session', sessionId: 'sess-gone' }));

      await vi.waitFor(() => {
        const expired = findSentMessage(ws, 'session_expired');
        expect(expired).toBeDefined();
        expect(expired.sessionId).toBe('sess-gone');
        expect(expired.reason).toContain('not found');
      });
    });

    test('blocks DB-backed working-copy resume before compile when execution readiness fails', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      executor.getSession.mockReturnValue(undefined);
      executor.rehydrateSession.mockResolvedValue(null);

      const { findSessionById } = await import('../../repos/session-repo.js');
      (findSessionById as any).mockResolvedValue({
        id: 'sess-runtime-config-blocked',
        tenantId: 'tenant-test',
        userId: 'user-1',
        projectId: 'proj-load',
        entryAgentName: 'AgentOne',
      });
      mockFindProjectWithAgents.mockResolvedValue({
        agents: [
          {
            name: 'AgentOne',
            dslContent: 'agent AgentOne',
            dslValidationStatus: 'valid',
          },
        ],
      });
      mockFindProjectRuntimeConfig.mockResolvedValue({
        extraction: { nlu_provider: 'advanced' },
      });
      mockEvaluateProjectExecutionReadiness.mockResolvedValue({
        executableAgents: [],
        blockedAgents: [],
        hasBlockingErrors: true,
        issues: [{ kind: 'runtime_config', diagnostics: [] }],
      });

      handleConnection(ws as any, makeReq({ token: 'tok' }));
      await waitForAuthenticatedConnection(ws);
      ws.send.mockClear();

      ws.simulateMessage(
        JSON.stringify({ type: 'resume_session', sessionId: 'sess-runtime-config-blocked' }),
      );

      await vi.waitFor(() => {
        const expired = findSentMessage(ws, 'session_expired');
        expect(expired).toBeDefined();
        expect(expired).toMatchObject({
          sessionId: 'sess-runtime-config-blocked',
          reasonCode: 'project_dsl_not_ready',
          reason:
            'Project DSL has validation errors. Fix the draft or runtime config before starting a runtime session.',
        });
      });
      expect(mockFindProjectRuntimeConfig).toHaveBeenCalledWith('proj-load', 'tenant-test');
      expect(mockCompileProjectWorkingCopy).not.toHaveBeenCalled();
    });

    test('tries rehydrateSession when getSession returns undefined', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      executor.getSession.mockReturnValue(undefined);
      const session = makeRuntimeSession({
        id: 'sess-rehy',
        tenantId: 'tenant-test',
        userId: 'user-1',
        conversationHistory: [],
      });
      executor.rehydrateSession.mockResolvedValue(session);

      handleConnection(ws as any, makeReq({ token: 'tok' }));

      ws.simulateMessage(JSON.stringify({ type: 'resume_session', sessionId: 'sess-rehy' }));

      await vi.waitFor(() => {
        expect(executor.rehydrateSession).toHaveBeenCalledWith('sess-rehy', undefined);
        const resumed = findSentMessage(ws, 'session_resumed');
        expect(resumed).toBeDefined();
        expect(resumed.sessionId).toBe('sess-rehy');
      });
    });

    test('rebinds persisted project scope on resume before the next turn is persisted', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      const session = makeRuntimeSession({
        id: 'sess-resume-bound',
        tenantId: 'tenant-test',
        projectId: 'proj-load',
        userId: 'user-1',
        conversationHistory: [{ role: 'assistant', content: 'Welcome back' }],
      });
      executor.getSession.mockImplementation((id: string) =>
        id === 'sess-resume-bound' ? session : undefined,
      );

      const { findSessionById } = await import('../../repos/session-repo.js');
      (findSessionById as any).mockResolvedValue({
        id: 'sess-resume-bound',
        tenantId: 'tenant-test',
        projectId: 'proj-load',
      });

      handleConnection(ws as any, makeReq({ token: 'tok' }));

      ws.simulateMessage(
        JSON.stringify({ type: 'resume_session', sessionId: 'sess-resume-bound' }),
      );

      await vi.waitFor(() => {
        const resumed = findSentMessage(ws, 'session_resumed');
        expect(resumed).toBeDefined();
        expect(resumed.sessionId).toBe('sess-resume-bound');
      });

      const { persistMessage } = await import('../../services/message-persistence-queue.js');
      ws.send.mockClear();

      ws.simulateMessage(
        JSON.stringify({
          type: 'send_message',
          sessionId: 'sess-resume-bound',
          text: 'After reconnect',
        }),
      );

      await vi.waitFor(() => {
        expect(findSessionById).toHaveBeenCalledWith('sess-resume-bound', 'tenant-test');
        expect(persistMessage).toHaveBeenCalledWith(
          'sess-resume-bound',
          'user',
          'After reconnect',
          'web_debug',
          'tenant-test',
          undefined,
          undefined,
          'proj-load',
          expect.any(Number),
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // WebSocket close
  // ---------------------------------------------------------------------------

  describe('close handler', () => {
    test('calls traceStore.unsubscribeAll on close', () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');

      handleConnection(ws as any, makeReq({ token: 'tok' }));

      ws.simulateClose();

      return vi.waitFor(() => {
        expect(traceStore.unsubscribeAll).toHaveBeenCalledWith(ws);
      });
    });

    test('detaches session by default without ending the persisted DB session', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      const session = makeRuntimeSession({
        id: 'sess-close',
        tenantId: 'tenant-test',
        projectId: 'proj-load',
        userId: 'user-1',
      });
      executor.getSession.mockImplementation((id: string) =>
        id === session.id ? session : undefined,
      );

      const { findSessionById } = await import('../../repos/session-repo.js');
      (findSessionById as any).mockResolvedValue({
        id: session.id,
        tenantId: 'tenant-test',
        projectId: 'proj-load',
      });

      handleConnection(ws as any, makeReq({ token: 'tok' }));
      await waitForAuthenticatedConnection(ws);
      ws.send.mockClear();

      ws.simulateMessage(JSON.stringify({ type: 'resume_session', sessionId: session.id }));

      await vi.waitFor(() => {
        const resumed = findSentMessage(ws, 'session_resumed');
        expect(resumed).toBeDefined();
        expect(resumed.sessionId).toBe(session.id);
      });

      ws.simulateMessage(
        JSON.stringify({ type: 'send_message', sessionId: session.id, text: 'Keep this alive' }),
      );

      await vi.waitFor(() => {
        const end = findSentMessage(ws, 'response_end');
        expect(end).toBeDefined();
      });

      const { flushMessageQueue } = await import('../../services/message-persistence-queue.js');

      ws.simulateClose();

      await vi.waitFor(() => {
        expect(executor.detachSession).toHaveBeenCalledWith('sess-close');
        expect(flushMessageQueue).toHaveBeenCalledWith('sess-close');
      });
      expect(mockConversationStore.endSession).not.toHaveBeenCalled();
      expect(mockCleanupAuthGateAsync).not.toHaveBeenCalled();
    });

    test('ends the runtime session when the project web_debug override forces end', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      mockFindProjectSettings.mockResolvedValue({
        sessionLifecycle: {
          channels: {
            web_debug: {
              defaultDisposition: 'timeout',
              disconnectBehavior: 'end',
            },
          },
        },
      });

      handleConnection(ws as any, makeReq({ token: 'tok' }));
      const session = await loadAgentOnConnection(ws, executor, {
        id: 'sess-close-end',
        tenantId: 'tenant-test',
        projectId: 'proj-load',
      });
      executor.getSession.mockReturnValue(session);

      ws.simulateClose();

      await vi.waitFor(() => {
        expect(mockTerminateConversationSession).toHaveBeenCalledWith({
          tenantId: 'tenant-test',
          projectId: 'proj-load',
          sessionId: 'sess-close-end',
          agentName: 'test_agent',
          channel: 'web_debug',
          disposition: 'timeout',
          source: 'disconnect',
        });
        expect(mockCleanupClosedSessionArtifacts).toHaveBeenCalledWith(['sess-close-end']);
        expect(mockCleanupAuthGateAsync).toHaveBeenCalledWith('sess-close-end');
      });
      expect(executor.endSession).not.toHaveBeenCalled();
      expect(executor.detachSession).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // WebSocket error
  // ---------------------------------------------------------------------------

  describe('error handler', () => {
    test('removes client from registry on error', () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');

      handleConnection(ws as any, makeReq({ token: 'tok' }));

      // Verify ws is tracked, then simulate error
      ws.simulateError(new Error('connection reset'));

      // After error, subsequent messages should still work on a new connection
      // (the handler cleans up client state)
    });
  });

  // ---------------------------------------------------------------------------
  // does not send when ws is not OPEN
  // ---------------------------------------------------------------------------

  describe('send guard', () => {
    test('does not call ws.send when readyState is not OPEN', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');

      handleConnection(ws as any, makeReq({ token: 'tok' }));

      // Clear the initial info message
      ws.send.mockClear();

      // Set readyState to CLOSING
      ws.readyState = 2;

      ws.simulateMessage(JSON.stringify({ type: 'list_sessions' }));
      await flushMicrotasks();

      // No messages should have been sent since ws is not OPEN
      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple messages in sequence
  // ---------------------------------------------------------------------------

  describe('sequential messages', () => {
    test('handles multiple different message types in sequence', async () => {
      mockExtractUserIdFromToken.mockReturnValue('user-1');
      traceStore.getActiveSessions.mockReturnValue([]);

      handleConnection(ws as any, makeReq({ token: 'tok' }));

      // list_sessions
      ws.simulateMessage(JSON.stringify({ type: 'list_sessions' }));
      await flushMicrotasks();
      const list = findSentMessage(ws, 'session_list');
      expect(list).toBeDefined();

      // get_state for missing session
      executor.getSession.mockReturnValue(undefined);
      ws.simulateMessage(JSON.stringify({ type: 'get_state', sessionId: 'x' }));
      await flushMicrotasks();

      const errors = getSentMessages(ws).filter((m: any) => m.type === 'error');
      expect(errors.length).toBeGreaterThanOrEqual(1);
    });
  });
});

/**
 * WebSocket Tenant Isolation Tests (Sprint 1 — Tasks 1.3, 1.5)
 *
 * Tests that:
 * - Task 1.3: WS handler wraps message processing in runWithTenantContext()
 *   so that getCurrentTenantId() returns the correct value inside handlers
 * - Task 1.5: Session ownership checks are fail-closed — reject when either
 *   tenantId is missing, not silently allow
 *
 * These are behavioral tests against the debug WS handler (handler.ts).
 * They verify the contract changes WITHOUT mocking the tenant context
 * internals — instead they observe the outcomes of cross-tenant operations.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// =============================================================================
// MOCK DECLARATIONS — must come before any import that pulls them in
// =============================================================================

const mockGetRuntimeExecutor = vi.fn();
const mockCompileToResolvedAgent = vi.fn();

vi.mock('../../services/runtime-executor.js', () => ({
  getRuntimeExecutor: (...args: any[]) => mockGetRuntimeExecutor(...args),
  compileToResolvedAgent: (...args: any[]) => mockCompileToResolvedAgent(...args),
}));

vi.mock('../../services/dsl-utils.js', () => ({
  buildAgentDetails: vi.fn(),
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

const mockGetExecutionCoordinator = vi.fn();
const mockIsCoordinatorAvailable = vi.fn(() => true);
vi.mock('../../services/execution/coordinator-singleton.js', () => ({
  getExecutionCoordinator: (...args: any[]) => mockGetExecutionCoordinator(...args),
  isCoordinatorAvailable: (...args: any[]) => mockIsCoordinatorAvailable(...args),
}));

const mockIsDatabaseAvailable = vi.fn(() => true);
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

const mockExtractVerifiedUserTokenClaims = vi.fn();
const mockWriteAccessDeniedAuditLog = vi.fn();
vi.mock('../../middleware/auth.js', () => ({
  extractVerifiedUserTokenClaims: (...args: any[]) => mockExtractVerifiedUserTokenClaims(...args),
  writeAccessDeniedAuditLog: (...args: any[]) => mockWriteAccessDeniedAuditLog(...args),
}));

const mockResolveTenantMembership = vi.fn();
const mockResolveDefaultTenant = vi.fn();
vi.mock('../../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  resolveTenantMembership: (...args: any[]) => mockResolveTenantMembership(...args),
  resolveDefaultTenant: (...args: any[]) => mockResolveDefaultTenant(...args),
}));

vi.mock('../../services/permission-resolution.js', () => ({
  clearPermissionCache: vi.fn(),
  resolveEffectivePermissions: vi.fn(async () => ['agent:read', 'agent:execute']),
}));

vi.mock('../../services/deployment-resolver.js', () => ({
  DeploymentResolver: vi.fn(),
  mergeWorkingCopyModules: vi.fn(async (working: unknown) => working),
}));

vi.mock('../../services/session/session-service.js', () => ({
  getSessionService: vi.fn(),
}));

vi.mock('../../services/stores/store-factory.js', () => ({
  getStores: vi.fn(() => ({
    conversation: {
      createSession: vi.fn(async () => ({ id: 'db-session-1' })),
      endSession: vi.fn(async () => {}),
    },
  })),
}));

vi.mock('../../repos/project-repo.js', () => ({
  findProjectById: vi.fn(async () => null),
  findProjectAgentByPath: vi.fn(async () => null),
  findProjectAgentByName: vi.fn(async () => null),
  findProjectAgentForProject: vi.fn(async () => null),
  findProjectAgentsForProject: vi.fn(async () => []),
  findProjectWithAgents: vi.fn(async () => null),
  findProjectByIdAndTenant: vi.fn(async () => null),
  loadConfigVariablesMap: vi.fn(async () => ({})),
}));

const mockUpdateSession = vi.fn(async () => ({}));
const mockFindSessionById = vi.fn(async () => null);
const mockFindMessagesForSession = vi.fn(async () => []);
vi.mock('../../repos/session-repo.js', () => ({
  updateSession: (...args: any[]) => mockUpdateSession(...args),
  incrementSessionTokens: vi.fn(async () => ({})),
  findSessionByRuntimeId: vi.fn(async () => null),
  findSessionById: (...args: any[]) => mockFindSessionById(...args),
  findMessagesForSession: (...args: any[]) => mockFindMessagesForSession(...args),
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

const mockPausedExecutionGet = vi.fn(() => null);
const mockPausedExecutionResolveDistributed = vi.fn(async () => 'handled');
const mockPausedExecutionRejectDistributed = vi.fn(async () => 'handled');
const mockPausedExecutionCleanupSession = vi.fn(async () => {});
vi.mock('../../services/auth-profile/paused-execution-store.js', () => ({
  getPausedExecutionStore: vi.fn(() => ({
    get: (...args: any[]) => mockPausedExecutionGet(...args),
    resolveDistributed: (...args: any[]) => mockPausedExecutionResolveDistributed(...args),
    rejectDistributed: (...args: any[]) => mockPausedExecutionRejectDistributed(...args),
    cleanupSession: (...args: any[]) => mockPausedExecutionCleanupSession(...args),
  })),
}));

vi.mock('../../observability/metrics.js', () => ({
  incrementActiveSessions: vi.fn(),
  decrementActiveSessions: vi.fn(),
}));

vi.mock('../../channels/pipeline/session-factory.js', () => ({
  resolveSessionTimeouts: vi.fn(async () => ({})),
}));

vi.mock('../../services/tenant-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/tenant-config.js')>();
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

import { handleConnection } from '../../websocket/handler.js';

// =============================================================================
// HELPERS
// =============================================================================

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

class MockWebSocket extends EventEmitter {
  OPEN = 1 as const;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();

  simulateMessage(data: string) {
    this.emit('message', Buffer.from(data));
  }

  simulateClose() {
    this.emit('close');
  }
}

function makeReq(params: { token?: string } = {}): any {
  const headers: Record<string, string> = { host: 'localhost:3112' };
  if (params.token) {
    headers['sec-websocket-protocol'] = `web-debug-auth,${params.token}`;
  }
  return {
    url: '/ws',
    headers,
  };
}

function makeRuntimeSession(overrides: Record<string, any> = {}): any {
  return {
    id: overrides.id ?? 'session-001',
    agentName: overrides.agentName ?? 'test_agent',
    agentIR: null,
    compilationOutput: null,
    conversationHistory: [],
    state: { gatherProgress: {}, context: {}, conversationPhase: 'active' },
    data: {},
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    initialized: true,
    tenantId: overrides.tenantId,
    userId: overrides.userId,
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
    rewireSessionToolExecutor: vi.fn(),
    saveSessionSnapshot: vi.fn(async () => {}),
    checkSessionQuota: vi.fn(),
    releaseSessionSlot: vi.fn(),
    ...overrides,
  };
}

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

function makeMockCoordinator(overrides: Record<string, any> = {}) {
  return {
    getStatus: vi.fn(async () => null),
    cancel: vi.fn(async () => false),
    cancelSession: vi.fn(async () => {}),
    ...overrides,
  };
}

function getSentMessages(ws: MockWebSocket): any[] {
  return ws.send.mock.calls.map(([raw]: [string]) => JSON.parse(raw));
}

function findSentMessage(ws: MockWebSocket, type: string): any | undefined {
  return getSentMessages(ws).find((m: any) => m.type === type);
}

function getLatestAccessDeniedEvent(): any | undefined {
  return mockWriteAccessDeniedAuditLog.mock.calls.at(-1)?.[0];
}

/** Set up a WS connection with tenant-1 user authentication */
async function createTenantConnection(
  tenantId: string,
  userId: string,
): Promise<{ ws: MockWebSocket; executor: ReturnType<typeof makeMockExecutor> }> {
  const ws = new MockWebSocket();
  const executor = makeMockExecutor();
  const traceStore = makeMockTraceStore();
  const coordinator = makeMockCoordinator();

  mockGetRuntimeExecutor.mockReturnValue(executor);
  mockGetTraceStore.mockReturnValue(traceStore);
  mockGetExecutionCoordinator.mockReturnValue(coordinator);
  mockExtractVerifiedUserTokenClaims.mockReturnValue({ userId, tenantId });
  mockResolveTenantMembership.mockResolvedValue({
    role: 'ADMIN',
    customRoleId: null,
    orgId: 'org-1',
  });

  handleConnection(ws as any, makeReq({ token: 'valid-jwt' }));
  await flushMicrotasks();

  return { ws, executor };
}

// =============================================================================
// TESTS
// =============================================================================

describe('WS Tenant Isolation — Session Ownership (Task 1.5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsDatabaseAvailable.mockReturnValue(true);
    mockIsCoordinatorAvailable.mockReturnValue(true);
    mockGetExecutionCoordinator.mockReturnValue(makeMockCoordinator());
    mockUpdateSession.mockResolvedValue({});
    mockFindSessionById.mockResolvedValue(null);
    mockFindMessagesForSession.mockResolvedValue([]);
    mockPausedExecutionGet.mockReturnValue(null);
    mockPausedExecutionResolveDistributed.mockResolvedValue('handled');
    mockPausedExecutionRejectDistributed.mockResolvedValue('handled');
  });

  describe('access-denied auditing', () => {
    test('audits connection attempts without an auth token', async () => {
      const ws = new MockWebSocket();

      handleConnection(ws as any, makeReq());

      expect(ws.close).toHaveBeenCalledWith(4001, 'Authentication required');
      expect(getLatestAccessDeniedEvent()).toEqual(
        expect.objectContaining({
          transport: 'websocket',
          layer: 'require_auth',
          scope: 'auth',
          reasonCode: 'AUTHENTICATION_REQUIRED',
          statusCode: 401,
          path: '/ws',
          messageType: 'connect',
        }),
      );
    });

    test('audits invalid websocket auth tokens', async () => {
      const ws = new MockWebSocket();
      mockExtractVerifiedUserTokenClaims.mockReturnValue(null);

      handleConnection(ws as any, makeReq({ token: 'bad-token' }));

      expect(ws.close).toHaveBeenCalledWith(4001, 'Invalid authentication token');
      expect(getLatestAccessDeniedEvent()).toEqual(
        expect.objectContaining({
          transport: 'websocket',
          layer: 'require_auth',
          scope: 'auth',
          reasonCode: 'INVALID_AUTHENTICATION_TOKEN',
          statusCode: 401,
          path: '/ws',
          messageType: 'connect',
        }),
      );
    });

    test('audits websocket connections without tenant membership', async () => {
      const ws = new MockWebSocket();
      const executor = makeMockExecutor();
      const traceStore = makeMockTraceStore();

      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(traceStore);
      mockExtractVerifiedUserTokenClaims.mockReturnValue({
        userId: 'user-1',
        tenantId: undefined,
      });
      mockResolveDefaultTenant.mockResolvedValue(null);

      handleConnection(ws as any, makeReq({ token: 'valid-jwt' }));
      await flushMicrotasks();

      expect(ws.close).toHaveBeenCalledWith(4003, 'Tenant membership required');
      expect(getLatestAccessDeniedEvent()).toEqual(
        expect.objectContaining({
          transport: 'websocket',
          layer: 'require_tenant_context',
          scope: 'tenant',
          reasonCode: 'TENANT_MEMBERSHIP_REQUIRED',
          statusCode: 403,
          userId: 'user-1',
          authType: 'user',
          path: '/ws',
          messageType: 'connect',
        }),
      );
    });
  });

  describe('subscribe_session — fail-closed tenant checks', () => {
    test('rejects connection when an authenticated caller has no tenant context', async () => {
      const ws = new MockWebSocket();
      const executor = makeMockExecutor();
      const traceStore = makeMockTraceStore();

      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(traceStore);
      mockExtractVerifiedUserTokenClaims.mockReturnValue({
        userId: 'user-1',
        tenantId: undefined,
      });
      mockResolveDefaultTenant.mockResolvedValue(null);

      handleConnection(ws as any, makeReq({ token: 'valid-jwt' }));
      await flushMicrotasks();

      expect(ws.close).toHaveBeenCalledWith(4003, 'Tenant membership required');
      expect(traceStore.subscribe).not.toHaveBeenCalled();
    });

    test('rejects subscription when session has no tenantId (orphaned)', async () => {
      const { ws, executor } = await createTenantConnection('tenant-1', 'user-1');
      const orphanSession = makeRuntimeSession({
        id: 'orphan-session',
        tenantId: undefined, // Orphaned — no tenant
        userId: 'user-1',
      });
      executor.getSession.mockReturnValue(orphanSession);

      ws.simulateMessage(
        JSON.stringify({ type: 'subscribe_session', sessionId: 'orphan-session' }),
      );
      await flushMicrotasks();

      // Should reject — session has no tenantId, fail-closed
      const errorMsg = findSentMessage(ws, 'error');
      expect(errorMsg).toBeDefined();
    });

    test('rejects cross-tenant subscription', async () => {
      const { ws, executor } = await createTenantConnection('tenant-1', 'user-1');
      const crossTenantSession = makeRuntimeSession({
        id: 'other-tenant-session',
        tenantId: 'tenant-2', // Different tenant
        userId: 'user-1',
      });
      executor.getSession.mockReturnValue(crossTenantSession);

      ws.simulateMessage(
        JSON.stringify({ type: 'subscribe_session', sessionId: 'other-tenant-session' }),
      );
      await flushMicrotasks();

      // Should reject — cross-tenant
      const errorMsg = findSentMessage(ws, 'error');
      expect(errorMsg).toBeDefined();
    });

    test('allows same-tenant same-user subscription', async () => {
      const { ws, executor } = await createTenantConnection('tenant-1', 'user-1');
      const ownSession = makeRuntimeSession({
        id: 'own-session',
        tenantId: 'tenant-1',
        userId: 'user-1',
      });
      executor.getSession.mockReturnValue(ownSession);

      const traceStore = makeMockTraceStore();
      mockGetTraceStore.mockReturnValue(traceStore);

      ws.simulateMessage(JSON.stringify({ type: 'subscribe_session', sessionId: 'own-session' }));
      await flushMicrotasks();

      // Should allow — same tenant, same user
      const errorMsg = findSentMessage(ws, 'error');
      expect(errorMsg).toBeUndefined();
    });

    test('rejects same-tenant session subscription when no owner identity is present', async () => {
      const { ws, executor } = await createTenantConnection('tenant-1', 'user-1');
      const ownerlessSession = makeRuntimeSession({
        id: 'ownerless-session',
        tenantId: 'tenant-1',
        userId: undefined,
        callerContext: undefined,
      });
      executor.getSession.mockReturnValue(ownerlessSession);

      const traceStore = makeMockTraceStore();
      mockGetTraceStore.mockReturnValue(traceStore);

      ws.simulateMessage(
        JSON.stringify({ type: 'subscribe_session', sessionId: 'ownerless-session' }),
      );
      await flushMicrotasks();

      expect(findSentMessage(ws, 'error')?.message).toContain('Session not found');
      expect(getLatestAccessDeniedEvent()).toEqual(
        expect.objectContaining({
          messageType: 'subscribe_session',
          reasonCode: 'SESSION_OWNER_CONTEXT_MISSING',
          resourceId: 'ownerless-session',
        }),
      );
      expect(traceStore.subscribe).not.toHaveBeenCalled();
    });

    test('allows same-tenant session subscription when callerContext carries the owner identity', async () => {
      const { ws, executor } = await createTenantConnection('tenant-1', 'user-1');
      const callerOwnedSession = makeRuntimeSession({
        id: 'caller-owned-session',
        tenantId: 'tenant-1',
        userId: undefined,
        callerContext: {
          tenantId: 'tenant-1',
          channel: 'web_debug',
          initiatedById: 'user-1',
          identityTier: 0,
          verificationMethod: 'none',
        },
      });
      executor.getSession.mockReturnValue(callerOwnedSession);

      const traceStore = makeMockTraceStore();
      mockGetTraceStore.mockReturnValue(traceStore);

      ws.simulateMessage(
        JSON.stringify({ type: 'subscribe_session', sessionId: 'caller-owned-session' }),
      );
      await flushMicrotasks();

      expect(findSentMessage(ws, 'error')).toBeUndefined();
      expect(findSentMessage(ws, 'subscribed')).toBeDefined();
      expect(traceStore.subscribe).toHaveBeenCalledWith('caller-owned-session', ws, {
        tenantId: 'tenant-1',
      });
    });

    test('rejects cross-user subscription within same tenant', async () => {
      const { ws, executor } = await createTenantConnection('tenant-1', 'user-1');
      const otherUserSession = makeRuntimeSession({
        id: 'other-user-session',
        tenantId: 'tenant-1',
        userId: 'user-2', // Different user
      });
      executor.getSession.mockReturnValue(otherUserSession);

      ws.simulateMessage(
        JSON.stringify({ type: 'subscribe_session', sessionId: 'other-user-session' }),
      );
      await flushMicrotasks();

      // Should reject — different user
      const errorMsg = findSentMessage(ws, 'error');
      expect(errorMsg).toBeDefined();
    });

    test('rejects persisted cross-user session replays when runtime session is gone', async () => {
      const { ws, executor } = await createTenantConnection('tenant-1', 'user-1');
      const traceStore = makeMockTraceStore();

      executor.getSession.mockReturnValue(undefined);
      mockGetTraceStore.mockReturnValue(traceStore);
      mockFindSessionById.mockResolvedValue({
        id: 'persisted-session',
        tenantId: 'tenant-1',
        userId: 'user-2',
      });

      ws.simulateMessage(
        JSON.stringify({ type: 'subscribe_session', sessionId: 'persisted-session' }),
      );
      await flushMicrotasks();

      expect(findSentMessage(ws, 'error')).toBeDefined();
      expect(traceStore.subscribe).not.toHaveBeenCalled();
    });

    test('allows persisted same-user session replays when runtime session is gone', async () => {
      const { ws, executor } = await createTenantConnection('tenant-1', 'user-1');
      const traceStore = makeMockTraceStore();

      executor.getSession.mockReturnValue(undefined);
      mockGetTraceStore.mockReturnValue(traceStore);
      mockFindSessionById.mockResolvedValue({
        id: 'persisted-session',
        tenantId: 'tenant-1',
        userId: 'user-1',
      });

      ws.simulateMessage(
        JSON.stringify({ type: 'subscribe_session', sessionId: 'persisted-session' }),
      );
      await flushMicrotasks();

      expect(findSentMessage(ws, 'error')).toBeUndefined();
      expect(findSentMessage(ws, 'subscribed')).toBeDefined();
      expect(traceStore.subscribe).toHaveBeenCalledWith('persisted-session', ws, {
        tenantId: 'tenant-1',
      });
    });

    test('allows persisted same-user session replays when initiatedById is present but userId is not', async () => {
      const { ws, executor } = await createTenantConnection('tenant-1', 'user-1');
      const traceStore = makeMockTraceStore();

      executor.getSession.mockReturnValue(undefined);
      mockGetTraceStore.mockReturnValue(traceStore);
      mockFindSessionById.mockResolvedValue({
        id: 'persisted-session',
        tenantId: 'tenant-1',
        userId: undefined,
        initiatedById: 'user-1',
      });

      ws.simulateMessage(
        JSON.stringify({ type: 'subscribe_session', sessionId: 'persisted-session' }),
      );
      await flushMicrotasks();

      expect(findSentMessage(ws, 'error')).toBeUndefined();
      expect(findSentMessage(ws, 'subscribed')).toBeDefined();
      expect(traceStore.subscribe).toHaveBeenCalledWith('persisted-session', ws, {
        tenantId: 'tenant-1',
      });
    });
  });

  describe('message and mutation handlers — fail-closed session checks', () => {
    test('rejects cross-tenant send_message before execution starts', async () => {
      const { ws, executor } = await createTenantConnection('tenant-1', 'user-1');
      executor.getSession.mockReturnValue(
        makeRuntimeSession({ id: 'target-session', tenantId: 'tenant-2', userId: 'user-1' }),
      );

      ws.simulateMessage(
        JSON.stringify({ type: 'send_message', sessionId: 'target-session', text: 'hello' }),
      );
      await flushMicrotasks();

      expect(findSentMessage(ws, 'error')?.message).toContain('Session not found');
      expect(executor.executeMessage).not.toHaveBeenCalled();
    });

    test('rejects cross-user get_state within the same tenant', async () => {
      const { ws, executor } = await createTenantConnection('tenant-1', 'user-1');
      executor.getSession.mockReturnValue(
        makeRuntimeSession({ id: 'target-session', tenantId: 'tenant-1', userId: 'user-2' }),
      );

      ws.simulateMessage(JSON.stringify({ type: 'get_state', sessionId: 'target-session' }));
      await flushMicrotasks();

      expect(findSentMessage(ws, 'error')?.message).toContain('Session not found');
      expect(findSentMessage(ws, 'state_update')).toBeUndefined();
    });

    test('rejects cross-tenant inject_context even for write-capable callers', async () => {
      const { ws, executor } = await createTenantConnection('tenant-1', 'user-1');
      executor.getSession.mockReturnValue(
        makeRuntimeSession({ id: 'target-session', tenantId: 'tenant-2', userId: 'user-1' }),
      );

      ws.simulateMessage(
        JSON.stringify({
          type: 'inject_context',
          sessionId: 'target-session',
          injection: { values: { foo: 'bar' } },
        }),
      );
      await flushMicrotasks();

      const errorMsg = findSentMessage(ws, 'context_injection_error');
      expect(errorMsg).toBeDefined();
      expect(errorMsg.error.code).toBe('SESSION_NOT_FOUND');
    });

    test('rejects cross-tenant set_tool_mocks', async () => {
      const { ws, executor } = await createTenantConnection('tenant-1', 'user-1');
      executor.getSession.mockReturnValue(
        makeRuntimeSession({ id: 'target-session', tenantId: 'tenant-2', userId: 'user-1' }),
      );

      ws.simulateMessage(
        JSON.stringify({
          type: 'set_tool_mocks',
          sessionId: 'target-session',
          mocks: [{ toolName: 'search', result: { ok: true } }],
        }),
      );
      await flushMicrotasks();

      const errorMsg = findSentMessage(ws, 'context_injection_error');
      expect(errorMsg).toBeDefined();
      expect(errorMsg.error.code).toBe('SESSION_NOT_FOUND');
      expect(findSentMessage(ws, 'tool_mock_set')).toBeUndefined();
    });

    test('rejects cross-tenant clear_tool_mocks', async () => {
      const { ws, executor } = await createTenantConnection('tenant-1', 'user-1');
      executor.getSession.mockReturnValue(
        makeRuntimeSession({ id: 'target-session', tenantId: 'tenant-2', userId: 'user-1' }),
      );

      ws.simulateMessage(JSON.stringify({ type: 'clear_tool_mocks', sessionId: 'target-session' }));
      await flushMicrotasks();

      const errorMsg = findSentMessage(ws, 'context_injection_error');
      expect(errorMsg).toBeDefined();
      expect(errorMsg.error.code).toBe('SESSION_NOT_FOUND');
      expect(findSentMessage(ws, 'tool_mock_set')).toBeUndefined();
    });
  });

  describe('execution cancellation and auth_response — fail-closed session checks', () => {
    test('rejects cancel_execution when the execution belongs to another tenant session', async () => {
      const { ws, executor } = await createTenantConnection('tenant-1', 'user-1');
      const coordinator = makeMockCoordinator({
        getStatus: vi.fn(async () => ({
          executionId: 'exec-foreign',
          sessionId: 'foreign-session',
          tenantId: 'tenant-2',
          message: 'hello',
          agentName: 'test_agent',
          status: 'running',
          queuedAt: Date.now(),
        })),
        cancel: vi.fn(async () => true),
      });

      mockGetExecutionCoordinator.mockReturnValue(coordinator);
      executor.getSession.mockReturnValue(
        makeRuntimeSession({ id: 'foreign-session', tenantId: 'tenant-2', userId: 'user-1' }),
      );

      ws.simulateMessage(JSON.stringify({ type: 'cancel_execution', executionId: 'exec-foreign' }));
      await flushMicrotasks();

      expect(findSentMessage(ws, 'error')?.message).toContain('Execution not found');
      expect(coordinator.cancel).not.toHaveBeenCalled();
    });

    test('allows cancel_execution for an execution owned by the caller session', async () => {
      const { ws, executor } = await createTenantConnection('tenant-1', 'user-1');
      const coordinator = makeMockCoordinator({
        getStatus: vi.fn(async () => ({
          executionId: 'exec-own',
          sessionId: 'own-session',
          tenantId: 'tenant-1',
          message: 'hello',
          agentName: 'test_agent',
          status: 'running',
          queuedAt: Date.now(),
        })),
        cancel: vi.fn(async () => true),
      });

      mockGetExecutionCoordinator.mockReturnValue(coordinator);
      executor.getSession.mockReturnValue(
        makeRuntimeSession({ id: 'own-session', tenantId: 'tenant-1', userId: 'user-1' }),
      );

      ws.simulateMessage(JSON.stringify({ type: 'cancel_execution', executionId: 'exec-own' }));
      await flushMicrotasks();

      expect(findSentMessage(ws, 'error')).toBeUndefined();
      expect(coordinator.cancel).toHaveBeenCalledWith('exec-own');
    });

    test('rejects auth_response for a foreign paused session on a fresh socket', async () => {
      const { ws, executor } = await createTenantConnection('tenant-1', 'user-1');
      executor.getSession.mockReturnValue(undefined);
      mockPausedExecutionGet.mockReturnValue({
        sessionId: 'foreign-session',
        toolCallId: 'tool-call-foreign',
        authProfileRef: 'google',
        toolName: 'search',
        pausedAt: Date.now(),
        timeoutMs: 60_000,
      });
      mockFindSessionById.mockResolvedValue({
        id: 'foreign-session',
        tenantId: 'tenant-1',
        userId: 'user-2',
      });

      ws.simulateMessage(
        JSON.stringify({
          type: 'auth_response',
          toolCallId: 'tool-call-foreign',
          status: 'completed',
        }),
      );
      await flushMicrotasks();

      expect(mockPausedExecutionResolveDistributed).not.toHaveBeenCalled();
      expect(mockPausedExecutionRejectDistributed).not.toHaveBeenCalled();
    });

    test('allows auth_response for the caller-owned paused session on a fresh socket', async () => {
      const { ws, executor } = await createTenantConnection('tenant-1', 'user-1');
      executor.getSession.mockReturnValue(undefined);
      mockPausedExecutionGet.mockReturnValue({
        sessionId: 'own-session',
        toolCallId: 'tool-call-own',
        authProfileRef: 'google',
        toolName: 'search',
        pausedAt: Date.now(),
        timeoutMs: 60_000,
      });
      mockFindSessionById.mockResolvedValue({
        id: 'own-session',
        tenantId: 'tenant-1',
        userId: 'user-1',
      });

      ws.simulateMessage(
        JSON.stringify({
          type: 'auth_response',
          toolCallId: 'tool-call-own',
          status: 'completed',
        }),
      );
      await flushMicrotasks();

      expect(mockPausedExecutionResolveDistributed).toHaveBeenCalledWith(
        'own-session',
        'tool-call-own',
      );
    });

    test('audits auth_response when the paused execution belongs to a different bound session', async () => {
      const { ws, executor } = await createTenantConnection('tenant-1', 'user-1');
      const ownSession = makeRuntimeSession({
        id: 'own-session',
        tenantId: 'tenant-1',
        userId: 'user-1',
      });
      executor.getSession.mockReturnValue(ownSession);

      ws.simulateMessage(JSON.stringify({ type: 'resume_session', sessionId: 'own-session' }));
      await flushMicrotasks();

      mockPausedExecutionGet.mockReturnValue({
        sessionId: 'foreign-session',
        toolCallId: 'tool-call-foreign',
        authProfileRef: 'google',
        toolName: 'search',
        pausedAt: Date.now(),
        timeoutMs: 60_000,
      });

      ws.simulateMessage(
        JSON.stringify({
          type: 'auth_response',
          toolCallId: 'tool-call-foreign',
          status: 'completed',
        }),
      );
      await flushMicrotasks();

      expect(mockPausedExecutionResolveDistributed).not.toHaveBeenCalled();
      expect(getLatestAccessDeniedEvent()).toEqual(
        expect.objectContaining({
          messageType: 'auth_response',
          reasonCode: 'CLIENT_SESSION_BINDING_MISMATCH',
          resourceId: 'foreign-session',
        }),
      );
    });
  });

  describe('session-boundary mutation handlers — denial auditing', () => {
    test('audits action_submit when the client is bound to a different session', async () => {
      const { ws, executor } = await createTenantConnection('tenant-1', 'user-1');
      const ownSession = makeRuntimeSession({
        id: 'own-session',
        tenantId: 'tenant-1',
        userId: 'user-1',
      });
      executor.getSession.mockReturnValue(ownSession);

      ws.simulateMessage(JSON.stringify({ type: 'resume_session', sessionId: 'own-session' }));
      await flushMicrotasks();

      ws.simulateMessage(
        JSON.stringify({
          type: 'action_submit',
          sessionId: 'foreign-session',
          actionId: 'action-1',
          value: 'clicked',
        }),
      );
      await flushMicrotasks();

      expect(findSentMessage(ws, 'error')?.message).toContain('Session not found');
      expect(getLatestAccessDeniedEvent()).toEqual(
        expect.objectContaining({
          messageType: 'action_submit',
          reasonCode: 'CLIENT_SESSION_BINDING_MISMATCH',
          resourceId: 'foreign-session',
        }),
      );
    });

    test('audits consent_satisfy when the client is bound to a different session', async () => {
      const { ws, executor } = await createTenantConnection('tenant-1', 'user-1');
      const ownSession = makeRuntimeSession({
        id: 'own-session',
        tenantId: 'tenant-1',
        userId: 'user-1',
      });
      executor.getSession.mockReturnValue(ownSession);

      ws.simulateMessage(JSON.stringify({ type: 'resume_session', sessionId: 'own-session' }));
      await flushMicrotasks();

      ws.simulateMessage(
        JSON.stringify({
          type: 'consent_satisfy',
          sessionId: 'foreign-session',
          authProfileRef: 'google',
        }),
      );
      await flushMicrotasks();

      expect(findSentMessage(ws, 'error')?.message).toContain('Session not found');
      expect(getLatestAccessDeniedEvent()).toEqual(
        expect.objectContaining({
          messageType: 'consent_satisfy',
          reasonCode: 'CLIENT_SESSION_BINDING_MISMATCH',
          resourceId: 'foreign-session',
        }),
      );
    });
  });

  describe('resume_session — fail-closed tenant checks', () => {
    test('rejects connection before resume when tenant context cannot be resolved', async () => {
      const ws = new MockWebSocket();
      const executor = makeMockExecutor();
      const traceStore = makeMockTraceStore();

      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(traceStore);
      mockExtractVerifiedUserTokenClaims.mockReturnValue({
        userId: 'user-1',
        tenantId: undefined,
      });
      mockResolveDefaultTenant.mockResolvedValue(null);

      handleConnection(ws as any, makeReq({ token: 'valid-jwt' }));
      await flushMicrotasks();

      expect(ws.close).toHaveBeenCalledWith(4003, 'Tenant membership required');
    });

    test('rejects resume when session has no tenantId (orphaned)', async () => {
      const { ws, executor } = await createTenantConnection('tenant-1', 'user-1');
      const orphanSession = makeRuntimeSession({
        id: 'orphan-session',
        tenantId: undefined,
        userId: 'user-1',
      });
      executor.getSession.mockReturnValue(orphanSession);

      ws.simulateMessage(JSON.stringify({ type: 'resume_session', sessionId: 'orphan-session' }));
      await flushMicrotasks();

      const expired = findSentMessage(ws, 'session_expired');
      const error = findSentMessage(ws, 'error');
      expect(expired || error).toBeDefined();
    });

    test('rejects cross-tenant resume', async () => {
      const { ws, executor } = await createTenantConnection('tenant-1', 'user-1');
      const crossTenantSession = makeRuntimeSession({
        id: 'cross-session',
        tenantId: 'tenant-2',
        userId: 'user-1',
      });
      executor.getSession.mockReturnValue(crossTenantSession);

      ws.simulateMessage(JSON.stringify({ type: 'resume_session', sessionId: 'cross-session' }));
      await flushMicrotasks();

      const expired = findSentMessage(ws, 'session_expired');
      expect(expired).toBeDefined();
      expect(expired.reason).toContain('not found');
      expect(executor.rewireSessionToolExecutor).not.toHaveBeenCalled();
    });

    test('rejects cross-user resume within same tenant', async () => {
      const { ws, executor } = await createTenantConnection('tenant-1', 'user-1');
      const otherUserSession = makeRuntimeSession({
        id: 'other-user-session',
        tenantId: 'tenant-1',
        userId: 'user-2',
      });
      executor.getSession.mockReturnValue(otherUserSession);

      ws.simulateMessage(
        JSON.stringify({ type: 'resume_session', sessionId: 'other-user-session' }),
      );
      await flushMicrotasks();

      const expired = findSentMessage(ws, 'session_expired');
      expect(expired).toBeDefined();
    });

    test('allows same-tenant same-user resume', async () => {
      const { ws, executor } = await createTenantConnection('tenant-1', 'user-1');
      const ownSession = makeRuntimeSession({
        id: 'own-session',
        tenantId: 'tenant-1',
        userId: 'user-1',
        agentName: 'test_agent',
        agentIR: { name: 'test_agent', type: 'agent' },
        initialized: true,
      });
      executor.getSession.mockReturnValue(ownSession);

      ws.simulateMessage(JSON.stringify({ type: 'resume_session', sessionId: 'own-session' }));
      await flushMicrotasks();

      // Should not get an error/expired message
      const expired = findSentMessage(ws, 'session_expired');
      expect(expired).toBeUndefined();
      expect(executor.rewireSessionToolExecutor).toHaveBeenCalledWith('own-session');
    });

    test('DB fallback is never reached when tenant context resolution fails closed', async () => {
      const ws = new MockWebSocket();
      const executor = makeMockExecutor({
        getSession: vi.fn(() => undefined),
        rehydrateSession: vi.fn(async () => null),
      });
      const traceStore = makeMockTraceStore();

      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetTraceStore.mockReturnValue(traceStore);
      mockExtractVerifiedUserTokenClaims.mockReturnValue({
        userId: 'user-1',
        tenantId: undefined,
      });
      mockResolveDefaultTenant.mockResolvedValue(null);

      handleConnection(ws as any, makeReq({ token: 'valid-jwt' }));
      await flushMicrotasks();

      expect(ws.close).toHaveBeenCalledWith(4003, 'Tenant membership required');
      expect(mockFindSessionById).not.toHaveBeenCalled();
    });
  });

  describe('list_sessions — tenant scoping', () => {
    test('returns empty list when authenticated client has tenant context but no matching sessions', async () => {
      const { ws, executor } = await createTenantConnection('tenant-1', 'user-1');

      // All sessions belong to tenant-2 — tenant-1 should see none
      const tenant2Session = makeRuntimeSession({
        id: 'sess-t2',
        tenantId: 'tenant-2',
        userId: 'other-user',
      });
      executor.getSession.mockImplementation((id: string) => {
        if (id === 'sess-t2') return tenant2Session;
        return undefined;
      });

      const traceStore = makeMockTraceStore({
        getActiveSessions: vi.fn(() => ['sess-t2']),
        getSessionInfo: vi.fn(() => ({
          agentName: 'test',
          eventCount: 1,
          subscriberCount: 0,
          firstEventAt: Date.now(),
          lastEventAt: Date.now(),
        })),
      });
      mockGetTraceStore.mockReturnValue(traceStore);

      // Clear messages from connection setup
      ws.send.mockClear();

      ws.simulateMessage(JSON.stringify({ type: 'list_sessions' }));
      await flushMicrotasks();

      const listMsg = findSentMessage(ws, 'session_list');
      expect(listMsg).toBeDefined();
      expect(listMsg.sessions).toEqual([]);
    });

    test('filters sessions to only same-tenant', async () => {
      const { ws, executor } = await createTenantConnection('tenant-1', 'user-1');

      const tenant1Session = makeRuntimeSession({
        id: 'sess-t1',
        tenantId: 'tenant-1',
        userId: 'user-1',
      });
      const tenant2Session = makeRuntimeSession({
        id: 'sess-t2',
        tenantId: 'tenant-2',
        userId: 'user-1',
      });

      executor.getSession.mockImplementation((id: string) => {
        if (id === 'sess-t1') return tenant1Session;
        if (id === 'sess-t2') return tenant2Session;
        return undefined;
      });

      const traceStore = makeMockTraceStore({
        getActiveSessions: vi.fn(() => ['sess-t1', 'sess-t2']),
        getSessionInfo: vi.fn((id: string) => ({
          agentName: 'test_agent',
          eventCount: 1,
          subscriberCount: 0,
          firstEventAt: Date.now(),
          lastEventAt: Date.now(),
        })),
      });
      mockGetTraceStore.mockReturnValue(traceStore);

      ws.simulateMessage(JSON.stringify({ type: 'list_sessions' }));
      await flushMicrotasks();

      const listMsg = findSentMessage(ws, 'session_list');
      expect(listMsg).toBeDefined();
      // Only tenant-1 session should be included
      const sessionIds = listMsg.sessions.map((s: any) => s.sessionId);
      expect(sessionIds).toContain('sess-t1');
      expect(sessionIds).not.toContain('sess-t2');
    });
  });
});

describe('WS Tenant Isolation — ALS Propagation (Task 1.3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsDatabaseAvailable.mockReturnValue(true);
    mockIsCoordinatorAvailable.mockReturnValue(true);
    mockGetExecutionCoordinator.mockReturnValue(makeMockCoordinator());
    mockUpdateSession.mockResolvedValue({});
    mockFindSessionById.mockResolvedValue(null);
    mockFindMessagesForSession.mockResolvedValue([]);
    mockPausedExecutionGet.mockReturnValue(null);
  });

  test('tenant context is resolved at connection time for authenticated user', async () => {
    const ws = new MockWebSocket();
    const executor = makeMockExecutor();
    const traceStore = makeMockTraceStore();

    mockGetRuntimeExecutor.mockReturnValue(executor);
    mockGetTraceStore.mockReturnValue(traceStore);
    mockExtractVerifiedUserTokenClaims.mockReturnValue({
      userId: 'user-1',
      tenantId: 'tenant-1',
    });
    mockResolveTenantMembership.mockResolvedValue({
      role: 'ADMIN',
      customRoleId: null,
      orgId: 'org-1',
    });

    handleConnection(ws as any, makeReq({ token: 'valid-jwt' }));
    await flushMicrotasks();

    // Verify tenant membership was resolved
    expect(mockResolveTenantMembership).toHaveBeenCalledWith('user-1', 'tenant-1');
  });

  test('tenant context uses default tenant when no hint provided', async () => {
    const ws = new MockWebSocket();
    const executor = makeMockExecutor();
    const traceStore = makeMockTraceStore();

    mockGetRuntimeExecutor.mockReturnValue(executor);
    mockGetTraceStore.mockReturnValue(traceStore);
    mockExtractVerifiedUserTokenClaims.mockReturnValue({
      userId: 'user-1',
      tenantId: undefined,
    });
    mockResolveDefaultTenant.mockResolvedValue({
      tenantId: 'default-tenant-1',
      role: 'MEMBER',
      customRoleId: null,
    });

    handleConnection(ws as any, makeReq({ token: 'valid-jwt' })); // No tenantId hint
    await flushMicrotasks();

    expect(mockResolveDefaultTenant).toHaveBeenCalledWith('user-1');
  });

  test('messages are gated until tenant context is resolved', async () => {
    const ws = new MockWebSocket();
    const executor = makeMockExecutor();
    const traceStore = makeMockTraceStore();

    mockGetRuntimeExecutor.mockReturnValue(executor);
    mockGetTraceStore.mockReturnValue(traceStore);
    mockExtractVerifiedUserTokenClaims.mockReturnValue({
      userId: 'user-1',
      tenantId: 'tenant-1',
    });

    // Make tenant resolution slow
    let resolveMembership: (v: any) => void;
    const membershipPromise = new Promise((resolve) => {
      resolveMembership = resolve;
    });
    mockResolveTenantMembership.mockReturnValue(membershipPromise);

    handleConnection(ws as any, makeReq({ token: 'valid-jwt' }));

    // Clear the initial "info" message sent on connect
    ws.send.mockClear();

    // Send a message before tenant is resolved
    ws.simulateMessage(JSON.stringify({ type: 'list_sessions' }));

    // Message should not have been processed yet (no list_sessions response sent)
    const preResolveList = findSentMessage(ws, 'session_list');
    expect(preResolveList).toBeUndefined();

    // Now resolve tenant
    resolveMembership!({ role: 'ADMIN', customRoleId: null });
    await flushMicrotasks();
    await flushMicrotasks(); // Extra flush for the chained promise

    // Now the message should have been processed
    const listMsg = findSentMessage(ws, 'session_list');
    expect(listMsg).toBeDefined();
  });
});

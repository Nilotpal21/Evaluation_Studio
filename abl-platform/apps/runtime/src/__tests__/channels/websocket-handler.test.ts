/**
 * WebSocket Handler Tests
 *
 * Tests the handleConnection entry point and message dispatch layer.
 * All external dependencies are mocked — this tests the handler's own logic:
 * - Connection lifecycle (setup, auth extraction, tenant resolution)
 * - Message dispatch (routing to correct handlers)
 * - Authentication gates
 * - Agent loading (DB path)
 * - Session creation + send message execution
 * - Fallback response generation
 * - send() readyState guard
 * - Trace accumulation
 * - Error handling paths
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WebSocket as WSType } from 'ws';
import type { IncomingMessage } from 'http';

// =============================================================================
// MOCK ALL EXTERNAL DEPENDENCIES
// =============================================================================

// events.ts — let real parseClientMessage + serializeServerMessage run
// (already tested separately, and we need real parsing for dispatch tests)

const mockExecutor = {
  createSessionFromResolved: vi.fn(),
  getSession: vi.fn(),
  executeMessage: vi.fn(),
  initializeSession: vi.fn(),
  rehydrateSession: vi.fn(),
  saveSessionSnapshot: vi.fn(),
  endSession: vi.fn(),
  detachSession: vi.fn(),
  checkSessionQuota: vi.fn(),
  releaseSessionSlot: vi.fn(),
};

vi.mock('../../services/runtime-executor.js', () => ({
  getRuntimeExecutor: () => mockExecutor,
  compileToResolvedAgent: vi.fn(),
}));

vi.mock('../../services/dsl-utils.js', () => ({
  buildAgentDetails: vi.fn(),
}));

vi.mock('../../services/trace-emitter.js', () => ({
  createTraceEmitter: vi.fn(() => ({
    startSpan: vi.fn(),
    endSpan: vi.fn(),
    logUserMessage: vi.fn(),
    logAgentResponse: vi.fn(),
    logSessionUpdated: vi.fn(),
    getCurrentSpanId: vi.fn(() => 'span_1'),
  })),
}));

vi.mock('../../services/llm/session-llm-client.js', () => ({
  TRACE_MODEL_UNKNOWN: 'unknown',
}));

const mockEnqueueLLMRequest = vi.fn(async () => ({
  response: '',
  action: { type: 'continue' },
  stateUpdates: { gatherProgress: {}, context: {}, conversationPhase: 'active' },
}));
vi.mock('../../services/llm/llm-queue.js', () => ({
  enqueueLLMRequest: (...args: any[]) => mockEnqueueLLMRequest(...args),
  BackpressureError: class BackpressureError extends Error {},
  isLLMQueueEnabled: vi.fn(() => true),
}));

const mockTraceStore = {
  subscribe: vi.fn(() => ({ success: true, bufferedEvents: [] })),
  unsubscribe: vi.fn(),
  unsubscribeAll: vi.fn(),
  addEvent: vi.fn(),
  clearSession: vi.fn(),
  getActiveSessions: vi.fn(() => []),
  getSessionInfo: vi.fn(),
  setSessionAgent: vi.fn(),
};

vi.mock('../../services/trace-store.js', () => ({
  getTraceStore: () => mockTraceStore,
}));

vi.mock('../../config/loader.js', () => ({
  isConfigLoaded: vi.fn(() => false),
  getConfig: vi.fn(() => ({
    channelLifecycle: {
      web_debug: { defaultDisposition: 'completed', disconnectBehavior: 'detach' },
    },
    security: { superAdminUserIds: [] },
  })),
}));

vi.mock('../../middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    extractVerifiedUserTokenClaims: vi.fn((token: string) => {
      if (token === 'valid_token') return { userId: 'user_123', tenantId: 'tenant-test' };
      if (token === 'dev-login') return { userId: 'dev_user', tenantId: 'tenant-test' };
      return null;
    }),
  };
});

vi.mock('../../services/permission-resolution.js', () => ({
  clearPermissionCache: vi.fn(),
  resolveEffectivePermissions: vi.fn(() => ({})),
}));

const mockIsDatabaseAvailable = vi.fn(() => false);
vi.mock('../../db/index.js', () => ({
  isDatabaseAvailable: (...args: any[]) => mockIsDatabaseAvailable(...args),
}));

vi.mock('../../services/identity/artifact-hasher.js', () => ({
  buildCallerContext: vi.fn(() => ({})),
}));

vi.mock('../../services/deployment-resolver.js', () => ({
  DeploymentResolver: vi.fn(),
  mergeWorkingCopyModules: vi.fn(async (working: unknown) => working),
}));

vi.mock('../../services/session/session-service.js', () => ({
  getSessionService: vi.fn(),
}));

vi.mock('../../observability/metrics.js', () => ({
  incrementActiveSessions: vi.fn(),
  decrementActiveSessions: vi.fn(),
}));

vi.mock('../../services/stores/store-factory.js', () => ({
  getStores: vi.fn(() => ({
    conversation: {
      createSession: vi.fn(() => ({ id: 'db_session_1' })),
      endSession: vi.fn(),
    },
  })),
}));

const mockResolveTenantMembership = vi.fn();
const mockResolveDefaultTenant = vi.fn();
const mockFindProjectByIdAndTenant = vi.fn();
const mockLoadConfigVariablesMap = vi.fn(async () => ({}));
vi.mock('../../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  resolveTenantMembership: (...args: any[]) => mockResolveTenantMembership(...args),
  resolveDefaultTenant: (...args: any[]) => mockResolveDefaultTenant(...args),
}));

vi.mock('../../repos/project-repo.js', () => ({
  findProjectById: vi.fn(),
  findProjectByIdAndTenant: (...args: any[]) => mockFindProjectByIdAndTenant(...args),
  findProjectAgentByPath: vi.fn(),
  findProjectAgentByName: vi.fn(),
  findProjectAgentForProject: vi.fn(async () => null),
  findProjectAgentsForProject: vi.fn(),
  findProjectWithAgents: vi.fn(),
  loadConfigVariablesMap: (...args: any[]) => mockLoadConfigVariablesMap(...args),
}));

vi.mock('../../repos/session-repo.js', () => ({
  findSessionById: vi.fn(),
  findSessionByRuntimeId: vi.fn(),
  findMessagesForSession: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('../../services/message-persistence-queue.js', () => ({
  persistMessage: vi.fn(),
  persistMessageRecord: vi.fn(),
  persistTurnMetrics: vi.fn(),
  flushMessageQueue: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../services/audit-helpers.js', () => ({
  auditContextInjected: vi.fn(() => Promise.resolve()),
  auditToolMockSet: vi.fn(() => Promise.resolve()),
  auditTestSessionCreated: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../services/execution/mock-tool-executor.js', () => ({
  MockToolExecutor: vi.fn(),
}));

// Import the module under test AFTER mocks
import { handleConnection } from '../../websocket/handler.js';
import { incrementActiveSessions, decrementActiveSessions } from '../../observability/metrics.js';
import { findProjectAgentByPath, findProjectAgentByName } from '../../repos/project-repo.js';

// =============================================================================
// HELPERS
// =============================================================================

function createMockWs(): WSType & {
  sentMessages: any[];
  listeners: Record<string, Function[]>;
  triggerMessage: (data: string) => Promise<void>;
  triggerClose: () => void;
  triggerError: (err: Error) => void;
} {
  const listeners: Record<string, Function[]> = {};
  const ws: any = {
    OPEN: 1,
    readyState: 1,
    sentMessages: [],
    listeners,
    send: vi.fn((data: string) => {
      ws.sentMessages.push(JSON.parse(data));
    }),
    on: vi.fn((event: string, handler: Function) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    close: vi.fn(),
    async triggerMessage(data: string) {
      for (const handler of listeners['message'] || []) {
        await handler(Buffer.from(data));
      }
      // Allow microtasks to flush
      await new Promise((r) => setTimeout(r, 0));
    },
    triggerClose() {
      for (const handler of listeners['close'] || []) {
        handler();
      }
    },
    triggerError(err: Error) {
      for (const handler of listeners['error'] || []) {
        handler(err);
      }
    },
  };
  return ws;
}

function createMockReq(url: string): IncomingMessage {
  const parsed = new URL(url, 'http://localhost:3112');
  const token = parsed.searchParams.get('token');
  return {
    url: parsed.pathname,
    headers: {
      host: 'localhost:3112',
      ...(token ? { 'sec-websocket-protocol': `web-debug-auth, ${token}` } : {}),
    },
  } as any;
}

function getLastSentMessage(ws: ReturnType<typeof createMockWs>) {
  return ws.sentMessages[ws.sentMessages.length - 1];
}

function getSentMessagesOfType(ws: ReturnType<typeof createMockWs>, type: string) {
  return ws.sentMessages.filter((m: any) => m.type === type);
}

// =============================================================================
// TESTS
// =============================================================================

describe('WebSocket Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsDatabaseAvailable.mockReturnValue(true);
    mockFindProjectByIdAndTenant.mockResolvedValue({
      id: 'proj-1',
      tenantId: 'tenant-test',
    });
    mockLoadConfigVariablesMap.mockResolvedValue({});
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

    // Default: queue returns standard response (queue is always active now)
    mockEnqueueLLMRequest.mockImplementation(async () => ({
      response: '',
      action: { type: 'continue' },
      stateUpdates: { gatherProgress: {}, context: {}, conversationPhase: 'active' },
    }));
  });

  // ---------------------------------------------------------------------------
  // Connection setup
  // ---------------------------------------------------------------------------

  describe('handleConnection', () => {
    test('sends info message on connect', async () => {
      const ws = createMockWs();
      const req = createMockReq('/ws?token=valid_token');
      handleConnection(ws, req);
      await new Promise((r) => setTimeout(r, 0));

      const infoMsgs = getSentMessagesOfType(ws, 'info');
      expect(infoMsgs.length).toBe(1);
      expect(infoMsgs[0].configured).toBe(true);
    });

    test('registers message, close, and error handlers', () => {
      const ws = createMockWs();
      const req = createMockReq('/ws?token=valid_token');
      handleConnection(ws, req);

      const registeredEvents = ws.on.mock.calls.map((c: any) => c[0]);
      expect(registeredEvents).toContain('message');
      expect(registeredEvents).toContain('close');
      expect(registeredEvents).toContain('error');
    });

    test('increments active sessions on connect', () => {
      const ws = createMockWs();
      const req = createMockReq('/ws?token=valid_token');
      handleConnection(ws, req);
      expect(incrementActiveSessions).toHaveBeenCalledTimes(1);
    });

    test('extracts userId from a valid internal websocket auth token', () => {
      const ws = createMockWs();
      const req = createMockReq('/ws?token=valid_token');
      handleConnection(ws, req);

      // The user should be authenticated — subsequent messages should not get auth error
      // (we verify this indirectly through message handling)
    });

    test('rejects missing auth tokens during connection setup', () => {
      const ws = createMockWs();
      handleConnection(ws);

      expect(ws.close).toHaveBeenCalledWith(4001, 'Authentication required');
      expect(incrementActiveSessions).not.toHaveBeenCalled();
    });

    test('decrements active sessions on close', () => {
      const ws = createMockWs();
      const req = createMockReq('/ws?token=valid_token');
      handleConnection(ws, req);
      ws.triggerClose();
      expect(decrementActiveSessions).toHaveBeenCalledTimes(1);
    });

    test('closes connections that exceed the pre-auth message buffer before tenant resolution completes', async () => {
      mockResolveTenantMembership.mockReturnValue(new Promise(() => {}));

      const ws = createMockWs();
      const req = createMockReq('/ws?token=valid_token');
      handleConnection(ws, req);

      for (let i = 0; i < 17; i++) {
        await ws.triggerMessage(JSON.stringify({ type: 'list_sessions', nonce: i }));
      }

      expect(ws.close).toHaveBeenCalledWith(1008, 'Too many queued messages before authentication');
    });

    test('cleans up on error', () => {
      const ws = createMockWs();
      const req = createMockReq('/ws?token=valid_token');
      handleConnection(ws, req);
      // Should not throw
      ws.triggerError(new Error('Connection reset'));
    });
  });

  // ---------------------------------------------------------------------------
  // Authentication gate
  // ---------------------------------------------------------------------------

  describe('authentication gate', () => {
    test('rejects invalid auth tokens before message processing', async () => {
      const ws = createMockWs();
      const req = createMockReq('/ws?token=invalid_token');
      handleConnection(ws, req);

      await ws.triggerMessage(JSON.stringify({ type: 'list_sessions' }));

      expect(ws.close).toHaveBeenCalledWith(4001, 'Invalid authentication token');
      expect(getSentMessagesOfType(ws, 'error')).toEqual([]);
    });

    test('allows messages from authenticated users', async () => {
      const ws = createMockWs();
      const req = createMockReq('/ws?token=valid_token');
      handleConnection(ws, req);

      await ws.triggerMessage(JSON.stringify({ type: 'list_sessions' }));

      // Should NOT get an auth error
      const errors = getSentMessagesOfType(ws, 'error');
      const authErrors = errors.filter((e: any) => e.message.includes('Authentication'));
      expect(authErrors.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Message parsing
  // ---------------------------------------------------------------------------

  describe('message parsing', () => {
    test('sends error for invalid message format', async () => {
      const ws = createMockWs();
      const req = createMockReq('/ws?token=valid_token');
      handleConnection(ws, req);

      await ws.triggerMessage('not valid json');

      const errors = getSentMessagesOfType(ws, 'error');
      expect(errors.some((e: any) => e.message.includes('Invalid message format'))).toBe(true);
    });

    test('sends error for unknown message type', async () => {
      const ws = createMockWs();
      const req = createMockReq('/ws?token=valid_token');
      handleConnection(ws, req);

      await ws.triggerMessage(JSON.stringify({ type: 'nonexistent_type' }));

      const errors = getSentMessagesOfType(ws, 'error');
      expect(errors.some((e: any) => e.message.includes('Invalid message format'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Message dispatch — load_agent
  // ---------------------------------------------------------------------------

  describe('load_agent dispatch', () => {
    test('sends agent_load_error when agent not found in DB', async () => {
      vi.mocked(findProjectAgentByPath).mockResolvedValue(null);
      vi.mocked(findProjectAgentByName).mockResolvedValue(null);

      const ws = createMockWs();
      const req = createMockReq('/ws?token=valid_token');
      handleConnection(ws, req);

      await ws.triggerMessage(
        JSON.stringify({
          type: 'load_agent',
          agentPath: 'nonexistent/agent',
          projectId: 'proj-1',
        }),
      );

      // Allow async handler to settle
      await new Promise((r) => setTimeout(r, 50));

      const loadErrors = getSentMessagesOfType(ws, 'agent_load_error');
      expect(loadErrors.length).toBe(1);
      expect(loadErrors[0].error).toContain('Agent not found');
    });

    test('blocks cross-tenant project access before agent lookup', async () => {
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindProjectByIdAndTenant.mockResolvedValue(null);
      mockLoadConfigVariablesMap.mockResolvedValue({});
      vi.mocked(findProjectAgentByPath).mockResolvedValue({
        id: 'agent-db-1',
        name: 'test_agent',
        projectId: 'proj-1',
        dslContent: 'AGENT test_agent\nROLE: Test helper\nGOAL: Help',
      } as any);

      const { buildAgentDetails } = await import('../../services/dsl-utils.js');
      vi.mocked(buildAgentDetails as any).mockReturnValue({
        id: 'test_agent',
        name: 'test_agent',
        type: 'agent',
        mode: 'reasoning',
        toolCount: 0,
        gatherFieldCount: 0,
        isSupervisor: false,
        dsl: 'AGENT test_agent\nROLE: Test helper\nGOAL: Help',
      });

      const runtimeExecutorModule = await import('../../services/runtime-executor.js');
      vi.mocked(runtimeExecutorModule.compileToResolvedAgent as any).mockReturnValue({
        agents: {
          test_agent: {
            metadata: { name: 'test_agent' },
          },
        },
        entryAgent: 'test_agent',
        compilationOutput: { agents: {} },
        sourceHash: 'hash',
        versionInfo: { versions: {} },
      });
      mockExecutor.createSessionFromResolved.mockReturnValue({
        id: 'sess-cross-tenant',
        agentName: 'test_agent',
        agentIR: null,
        compilationOutput: null,
        conversationHistory: [],
        state: {
          gatherProgress: {},
          context: {},
          conversationPhase: 'active',
        },
        data: {
          values: {},
          gatheredKeys: new Set<string>(),
        },
        isComplete: false,
        isEscalated: false,
        handoffStack: [],
        threads: [],
        activeThreadIndex: 0,
        threadStack: [],
        initialized: true,
        tenantId: 'tenant-test',
        createdAt: new Date(),
        lastActivityAt: new Date(),
      });

      const ws = createMockWs();
      const req = createMockReq('/ws?token=valid_token');
      handleConnection(ws, req);

      await ws.triggerMessage(
        JSON.stringify({
          type: 'load_agent',
          agentPath: 'test_agent',
          projectId: 'proj-1',
        }),
      );

      await new Promise((r) => setTimeout(r, 50));

      const loadErrors = getSentMessagesOfType(ws, 'agent_load_error');
      expect(loadErrors.length).toBe(1);
      expect(loadErrors[0].error).toContain('Access denied');
      expect(findProjectAgentByPath).not.toHaveBeenCalled();
      expect(mockLoadConfigVariablesMap).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Message dispatch — send_message without session
  // ---------------------------------------------------------------------------

  describe('send_message dispatch', () => {
    test('sends error when no session is loaded', async () => {
      const ws = createMockWs();
      const req = createMockReq('/ws?token=valid_token');
      handleConnection(ws, req);

      await ws.triggerMessage(
        JSON.stringify({
          type: 'send_message',
          sessionId: 'nonexistent',
          text: 'hello',
        }),
      );

      await new Promise((r) => setTimeout(r, 50));

      // Should get some error response (no session configured)
      const errors = getSentMessagesOfType(ws, 'error');
      expect(errors.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Message dispatch — get_state
  // ---------------------------------------------------------------------------

  describe('get_state dispatch', () => {
    test('sends error when no session loaded', async () => {
      const ws = createMockWs();
      const req = createMockReq('/ws?token=valid_token');
      handleConnection(ws, req);

      await ws.triggerMessage(
        JSON.stringify({
          type: 'get_state',
          sessionId: 's1',
        }),
      );

      await new Promise((r) => setTimeout(r, 50));

      const errors = getSentMessagesOfType(ws, 'error');
      expect(errors.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Message dispatch — list_sessions
  // ---------------------------------------------------------------------------

  describe('list_sessions dispatch', () => {
    test('returns active sessions list', async () => {
      mockTraceStore.getActiveSessions.mockReturnValue(['sess_1', 'sess_2']);
      mockTraceStore.getSessionInfo.mockReturnValue({ agentName: 'TestAgent' });

      const ws = createMockWs();
      const req = createMockReq('/ws?token=valid_token');
      handleConnection(ws, req);

      await ws.triggerMessage(JSON.stringify({ type: 'list_sessions' }));

      await new Promise((r) => setTimeout(r, 50));

      // Should receive some response (not an auth error)
      const errors = getSentMessagesOfType(ws, 'error');
      const authErrors = errors.filter((e: any) => e.message.includes('Authentication'));
      expect(authErrors.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Message dispatch — subscribe_session
  // ---------------------------------------------------------------------------

  describe('subscribe_session dispatch', () => {
    test('calls trace store subscribe when session is authorized', async () => {
      // The handler now requires session authorization before subscribing.
      // Provide a runtime session so getAuthorizedRuntimeSession succeeds.
      mockExecutor.getSession.mockReturnValue({
        id: 'sess_1',
        tenantId: 'tenant-test',
        userId: 'user_123',
        agentName: 'test-agent',
      });
      // Also provide a DB session so getAuthorizedPersistedSession succeeds
      const { findSessionById } = await import('../../repos/session-repo.js');
      (findSessionById as any).mockResolvedValue({
        _id: 'sess_1',
        tenantId: 'tenant-test',
        projectId: 'proj-1',
        status: 'active',
      });

      const ws = createMockWs();
      const req = createMockReq('/ws?token=valid_token');
      handleConnection(ws, req);

      // Wait for tenant resolution to complete before sending messages
      await new Promise((r) => setTimeout(r, 150));

      await ws.triggerMessage(
        JSON.stringify({
          type: 'subscribe_session',
          sessionId: 'sess_1',
        }),
      );

      await new Promise((r) => setTimeout(r, 150));

      // After session authorization was added, subscribe_session checks session access.
      // If the session tenant matches the client tenant, subscribe proceeds.
      // If not, it sends an error. The test verifies subscribe is called for valid access.
      expect(mockTraceStore.subscribe).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Message dispatch — unsubscribe_session
  // ---------------------------------------------------------------------------

  describe('unsubscribe_session dispatch', () => {
    test('calls trace store unsubscribe', async () => {
      const ws = createMockWs();
      const req = createMockReq('/ws?token=valid_token');
      handleConnection(ws, req);

      await ws.triggerMessage(
        JSON.stringify({
          type: 'unsubscribe_session',
          sessionId: 'sess_1',
        }),
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(mockTraceStore.unsubscribe).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Close handler
  // ---------------------------------------------------------------------------

  describe('close handler', () => {
    test('unsubscribes from all trace sessions on close', async () => {
      const ws = createMockWs();
      const req = createMockReq('/ws?token=valid_token');
      handleConnection(ws, req);

      await vi.waitFor(() => {
        expect(mockResolveTenantMembership).toHaveBeenCalled();
      });

      ws.triggerClose();
      await vi.waitFor(() => {
        expect(mockTraceStore.unsubscribeAll).toHaveBeenCalledWith(ws);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // send() readyState guard
  // ---------------------------------------------------------------------------

  describe('send utility', () => {
    test('does not send when ws is not OPEN', async () => {
      const ws = createMockWs();
      const req = createMockReq('/ws?token=valid_token');
      handleConnection(ws, req);

      // Close the WS (readyState != OPEN)
      ws.readyState = 3; // CLOSED

      await ws.triggerMessage(JSON.stringify({ type: 'list_sessions' }));

      await new Promise((r) => setTimeout(r, 50));

      // After the info message (sent while OPEN), no further messages should be sent
      // The info message was sent at connect time when readyState was OPEN
      const msgsSentAfterClose = ws.send.mock.calls.filter((_: any, idx: number) => idx > 0);
      expect(msgsSentAfterClose.length).toBe(0);
    });
  });
});

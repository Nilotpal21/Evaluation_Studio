/**
 * Message Ownership Authorization Tests
 *
 * Verifies that messages are transitively protected by session ownership:
 *
 * 1. Session detail route (GET /api/projects/:projectId/sessions/:id) returns
 *    messages only when the session belongs to the caller's tenant.
 *    Cross-tenant requests get 404 (not 403, to avoid leaking existence).
 *
 * 2. Chat agent endpoint (POST /api/v1/chat/agent) verifies session ownership
 *    when resuming an existing session via sessionId. A caller from tenant B
 *    cannot send messages to a session owned by tenant A.
 *
 * Messages do not have their own userId/tenantId -- they belong to sessions.
 * Session ownership is the gate that protects message access.
 */

import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// =============================================================================
// MOCKS -- must be declared before any import that transitively pulls them in
// =============================================================================

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  checkSessionMessageRate: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock('../../middleware/rbac.js', () => ({
  requirePermissionInline: vi.fn(),
  requireProjectPermission: vi.fn().mockResolvedValue(true),
  requireSensitiveProjectPermission: vi.fn().mockResolvedValue(true),
}));

// Track which tenant is "current" so getCurrentTenantId returns the right value per-test.
let _currentTenantId: string | undefined;

vi.mock('@agent-platform/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/shared')>();
  return {
    ...actual,
    requireProjectScope: vi.fn(() => (_req: any, _res: any, next: any) => next()),
    getCurrentRequestId: vi.fn(() => 'req-test-1'),
    getCurrentTenantId: vi.fn(() => _currentTenantId),
  };
});

vi.mock('@agent-platform/shared-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/shared-auth')>();
  return {
    ...actual,
    requireProjectScope: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  };
});

vi.mock('../../openapi/registry.js', () => ({
  runtimeRegistry: {},
}));

vi.mock('@agent-platform/openapi/express', () => ({
  createOpenAPIRouter: vi.fn((_registry: any, _opts: any) => {
    const { Router } = require('express');
    const router = Router({ mergeParams: true });
    return {
      router,
      route: (method: string, path: string, _schema: any, ...handlers: any[]) => {
        const lastHandler = handlers[handlers.length - 1];
        const middlewares = handlers.slice(0, -1);
        (router as any)[method](path, ...middlewares, (req: any, res: any, next: any) => {
          const match = req.originalUrl.match(/\/api\/projects\/([^/?#]+)\/sessions(?:\/|$)/);
          const projectId = req.parentProjectId ?? (match?.[1] && decodeURIComponent(match[1]));
          if (projectId) {
            req.params.projectId = projectId;
          }
          return lastHandler(req, res, next);
        });
      },
    };
  }),
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// --- Project repo: project belongs to tenant-A ---
vi.mock('../../repos/project-repo.js', () => ({
  findProjectByIdAndTenant: vi.fn().mockResolvedValue({
    _id: 'proj-1',
    tenantId: 'tenant-A',
    ownerId: 'project-owner',
  }),
  findProjectMember: vi.fn().mockImplementation((_projectId: string, userId: string) => {
    const memberships: Record<string, { role: string }> = {
      'owner-user': { role: 'admin' },
      'tenant-B-user': { role: 'admin' },
    };
    return Promise.resolve(memberships[userId] ?? null);
  }),
  findProjectWithAgents: vi.fn().mockResolvedValue(null),
  findProjectAgentForProject: vi.fn().mockResolvedValue(null),
  findProjectAgentByPath: vi.fn().mockResolvedValue(null),
  findProjectAgentByName: vi.fn().mockResolvedValue(null),
  findLatestAgentVersion: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: vi.fn(),
}));

// --- Session repo: session sess-A belongs to tenant-A with messages ---
const mockMessages = [
  { id: 'msg-1', role: 'user', content: 'Hello', timestamp: new Date('2024-01-01T00:00:00Z') },
  {
    id: 'msg-2',
    role: 'assistant',
    content: 'Hi there',
    timestamp: new Date('2024-01-01T00:00:01Z'),
  },
];

vi.mock('../../repos/session-repo.js', () => ({
  listSessions: vi.fn().mockResolvedValue([]),
  countSessions: vi.fn().mockResolvedValue(0),
  findSessionById: vi.fn().mockImplementation((id: string, tenantId?: string) => {
    // Session sess-A belongs to tenant-A, project proj-1
    if (id === 'sess-A' && (!tenantId || tenantId === 'tenant-A')) {
      return Promise.resolve({
        id: 'sess-A',
        _id: 'sess-A',
        tenantId: 'tenant-A',
        projectId: 'proj-1',
        currentAgent: 'test-agent',
        channel: 'web_debug',
        initiatedById: 'owner-user',
        status: 'active',
        messageCount: 2,
        startedAt: new Date('2024-01-01T00:00:00Z'),
        lastActivityAt: new Date('2024-01-01T00:00:01Z'),
        context: '{}',
        runtimeSessionId: 'runtime-sess-A',
      });
    }
    // Cross-tenant: tenant-B asking for sess-A returns null (tenant mismatch)
    return Promise.resolve(null);
  }),
  findStoredSessionByAnyId: vi.fn().mockImplementation((id: string, tenantId?: string) => {
    if ((id === 'sess-A' || id === 'runtime-sess-A') && (!tenantId || tenantId === 'tenant-A')) {
      return Promise.resolve({
        id: 'sess-A',
        _id: 'sess-A',
        tenantId: 'tenant-A',
        projectId: 'proj-1',
        currentAgent: 'test-agent',
        channel: 'web_debug',
        initiatedById: 'owner-user',
        status: 'active',
        messageCount: 2,
        startedAt: new Date('2024-01-01T00:00:00Z'),
        lastActivityAt: new Date('2024-01-01T00:00:01Z'),
        context: '{}',
        runtimeSessionId: 'runtime-sess-A',
      });
    }
    return Promise.resolve(null);
  }),
  findSessionByRuntimeId: vi.fn().mockImplementation((runtimeId: string, tenantId?: string) => {
    if (runtimeId === 'runtime-sess-A' && (!tenantId || tenantId === 'tenant-A')) {
      return Promise.resolve({
        id: 'sess-A',
        _id: 'sess-A',
        tenantId: 'tenant-A',
        projectId: 'proj-1',
        currentAgent: 'test-agent',
        channel: 'web_debug',
        initiatedById: 'owner-user',
        status: 'active',
        messageCount: 2,
        startedAt: new Date('2024-01-01T00:00:00Z'),
        lastActivityAt: new Date('2024-01-01T00:00:01Z'),
        context: '{}',
        runtimeSessionId: 'runtime-sess-A',
      });
    }
    return Promise.resolve(null);
  }),
  findMessagesForSession: vi.fn().mockImplementation((sessionId: string) => {
    if (sessionId === 'sess-A') return Promise.resolve(mockMessages);
    return Promise.resolve([]);
  }),
  findMessagesForSessionCursor: vi.fn().mockResolvedValue({
    messages: [],
    nextCursor: null,
    hasMore: false,
  }),
  listStoredSessionCleanupIds: vi.fn().mockResolvedValue([]),
  resolveStoredSessionCompatibilityId: vi.fn(
    (session: { id?: string | null; _id?: string | null } | null | undefined, fallbackId: string) =>
      session?.id || session?._id || fallbackId,
  ),
  updateSession: vi.fn(),
}));

// --- Runtime executor: runtime-sess-A belongs to tenant-A ---
const mockGetSession = vi.fn().mockImplementation((sessionId: string) => {
  if (sessionId === 'runtime-sess-A') {
    return {
      id: 'runtime-sess-A',
      tenantId: 'tenant-A',
      projectId: 'proj-1',
      agentName: 'test-agent',
      data: { values: {} },
      state: {},
    };
  }
  return null;
});

const mockExecuteMessage = vi.fn().mockResolvedValue({
  response: 'Agent response',
  action: 'continue',
});

vi.mock('../../services/runtime-executor.js', () => ({
  getRuntimeExecutor: vi.fn(() => ({
    getSession: mockGetSession,
    getSessionDetail: vi.fn().mockReturnValue(null),
    listSessions: vi.fn().mockReturnValue([]),
    endSession: vi.fn(),
    isConfigured: vi.fn().mockReturnValue(true),
    rehydrateSession: vi.fn().mockResolvedValue(null),
    executeMessage: mockExecuteMessage,
    createSessionFromResolved: vi.fn(),
    checkSessionQuota: vi.fn(),
    releaseSessionSlot: vi.fn(),
  })),
  compileToResolvedAgent: vi.fn(),
}));

vi.mock('../../services/trace-store.js', () => ({
  getTraceStore: vi.fn(() => ({
    getEvents: vi.fn().mockReturnValue([]),
    removeSession: vi.fn(),
    clearSession: vi.fn(),
    getSessionInfo: vi.fn().mockReturnValue(null),
  })),
}));

vi.mock('../../services/test-session.js', () => ({
  TestSessionService: { createSession: vi.fn() },
}));

vi.mock('../../services/dsl-utils.js', () => ({
  buildAgentDetails: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  isDatabaseAvailable: vi.fn(() => true),
  requirePrisma: vi.fn(),
}));

vi.mock('../../services/audit-helpers.js', () => ({
  auditSessionModified: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/stores/store-factory.js', () => ({
  getStores: vi.fn(() => ({
    conversation: {
      createSession: vi.fn().mockResolvedValue({ id: 'db-session-new' }),
    },
    metrics: {
      record: vi.fn().mockResolvedValue(undefined),
    },
  })),
}));

vi.mock('../../repos/llm-resolution-repo.js', () => ({
  isResolutionDatabaseAvailable: vi.fn(() => false),
}));

vi.mock('@agent-platform/shared/encryption', () => ({
  getEncryptionService: vi.fn(() => ({})),
  isEncryptionAvailable: vi.fn(() => true),
}));

vi.mock('../../services/llm/index.js', () => ({
  ModelResolutionService: vi.fn(),
  SessionLLMClient: vi.fn(),
}));

vi.mock('../../services/llm/model-router.js', () => ({
  getModelCapabilities: vi.fn(() => ({
    inputCostPer1k: null,
    outputCostPer1k: null,
  })),
}));

vi.mock('../../services/identity/artifact-hasher.js', () => ({
  buildCallerContext: vi.fn(),
  buildCallerContextFromTenantContext: vi.fn(),
}));

vi.mock('../../services/message-persistence-queue.js', () => ({
  persistMessage: vi.fn().mockResolvedValue(undefined),
  persistMessageRecord: vi.fn().mockResolvedValue(undefined),
  persistTurnMetrics: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/pii/runtime-pii-boundary-service.js', () => ({
  renderSessionMessagesForUserSurface: vi.fn((messages: unknown[]) => messages),
  renderTraceEventsForReadSurface: vi.fn((events: unknown[]) => events),
}));

vi.mock('../../services/pii/session-pii-context.js', () => ({
  createPIIVaultForProjectSnapshot: vi.fn(),
  resolveProjectPIISnapshot: vi.fn(),
  buildStoredPIIReadSurfaceContext: vi.fn(() => undefined),
  refreshSessionPIIContext: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/session/session-state-repo.js', () => ({
  SessionStateRepo: vi.fn(function SessionStateRepo() {
    return {
      load: vi.fn().mockResolvedValue(null),
    };
  }),
}));

// =============================================================================
// IMPORTS -- after mocks
// =============================================================================

import express from 'express';
import { makeTenantContext, injectTenantContext } from '../helpers/auth-context.js';

// =============================================================================
// HELPERS
// =============================================================================

const SESSIONS_BASE = '/api/projects/proj-1/sessions';
const CHAT_BASE = '/api/v1/chat';

const [{ default: sessionsRouter }, { default: chatRouter }] = await Promise.all([
  import('../../routes/sessions.js'),
  import('../../routes/chat.js'),
]);

async function request(baseUrl: string, method: string, path: string, opts?: { body?: any }) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

function closeServer(server: http.Server | undefined) {
  return new Promise<void>((resolve, reject) => {
    if (!server?.listening) {
      resolve();
      return;
    }
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

/**
 * Create an Express app with session + chat routers, authenticated as the given tenant/user.
 */
async function createServerForTenant(tenantId: string, userId: string) {
  const app = express();
  app.use(express.json());
  // Inject tenant context for all requests AND set _currentTenantId so
  // getCurrentTenantId() (mocked above) returns the correct value.
  const ctx = makeTenantContext(tenantId, userId, 'OWNER', { authType: 'user' });
  app.use((req, res, next) => {
    _currentTenantId = tenantId;
    injectTenantContext(ctx)(req, res, next);
  });

  app.use(
    '/api/projects/:projectId/sessions',
    (req, _res, next) => {
      (req as any).parentProjectId = req.params.projectId;
      next();
    },
    sessionsRouter,
  );
  app.use('/api/v1/chat', chatRouter);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

// =============================================================================
// TESTS
// =============================================================================

describe('Message ownership via session ownership -- transitive protection', () => {
  // ---------------------------------------------------------------------------
  // Session detail route: messages are returned only for own-tenant sessions
  // ---------------------------------------------------------------------------
  describe('GET /api/projects/:projectId/sessions/:id (messages via session detail)', () => {
    describe('Tenant-A user (session owner)', () => {
      let baseUrl: string;
      let server: http.Server;

      beforeAll(async () => {
        ({ baseUrl, server } = await createServerForTenant('tenant-A', 'owner-user'));
      });
      afterAll(() => closeServer(server));

      test('gets session with messages -- 200 (own tenant)', async () => {
        const { status, body } = await request(
          baseUrl,
          'GET',
          `${SESSIONS_BASE}/sess-A?includeTraces=false`,
        );
        // Session found in DB (tenant-A owns sess-A)
        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.session).toBeDefined();
        expect(body.session.messages).toBeDefined();
        expect(body.session.messages).toHaveLength(2);
        expect(body.session.messages[0].content).toBe('Hello');
        expect(body.session.messages[1].content).toBe('Hi there');
      });
    });

    describe('Tenant-B user (not session owner)', () => {
      let baseUrl: string;
      let server: http.Server;

      beforeAll(async () => {
        ({ baseUrl, server } = await createServerForTenant('tenant-B', 'tenant-B-user'));
      });
      afterAll(() => closeServer(server));

      test('gets 404 for cross-tenant session -- messages not leaked', async () => {
        const { status, body } = await request(
          baseUrl,
          'GET',
          `${SESSIONS_BASE}/sess-A?includeTraces=false`,
        );
        // Session not found (tenant-B cannot see tenant-A's session)
        expect(status).toBe(404);
        expect(body.success).toBe(false);
        // Must not contain any message data
        expect(body.session).toBeUndefined();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Chat agent endpoint: session ownership verified when resuming via sessionId
  // ---------------------------------------------------------------------------
  describe('POST /api/v1/chat/agent (session resume via sessionId)', () => {
    describe('Tenant-A user (session owner)', () => {
      let baseUrl: string;
      let server: http.Server;

      beforeAll(async () => {
        mockExecuteMessage.mockClear();
        ({ baseUrl, server } = await createServerForTenant('tenant-A', 'owner-user'));
      });
      afterAll(() => closeServer(server));

      test('resumes own session -- executes message', async () => {
        const { status, body } = await request(baseUrl, 'POST', `${CHAT_BASE}/agent`, {
          body: {
            projectId: 'proj-1',
            sessionId: 'runtime-sess-A',
            message: 'Hello agent',
          },
        });
        // Session belongs to tenant-A, caller is tenant-A -- allowed
        expect(status).toBe(200);
        expect(body.response).toBe('Agent response');
        expect(body.sessionId).toBe('runtime-sess-A');
      });
    });

    describe('Tenant-B user (not session owner)', () => {
      let baseUrl: string;
      let server: http.Server;

      beforeAll(async () => {
        mockExecuteMessage.mockClear();
        ({ baseUrl, server } = await createServerForTenant('tenant-B', 'tenant-B-user'));
      });
      afterAll(() => closeServer(server));

      test('returns 404 when trying to resume cross-tenant session -- blocked', async () => {
        const { status, body } = await request(baseUrl, 'POST', `${CHAT_BASE}/agent`, {
          body: {
            projectId: 'proj-1',
            sessionId: 'runtime-sess-A',
            message: 'Trying to hijack session',
          },
        });
        // Session belongs to tenant-A, caller is tenant-B -- blocked with 404
        expect(status).toBe(404);
        expect(body.error).toBe('Session not found');
        // executeMessage must NOT have been called
        expect(mockExecuteMessage).not.toHaveBeenCalled();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Chat agent: creating new session (no sessionId) is always allowed
  // ---------------------------------------------------------------------------
  describe('POST /api/v1/chat/agent (new session -- no sessionId)', () => {
    describe('Any authenticated user', () => {
      let baseUrl: string;
      let server: http.Server;

      beforeAll(async () => {
        ({ baseUrl, server } = await createServerForTenant('tenant-A', 'owner-user'));
      });
      afterAll(() => closeServer(server));

      test('creating a new session without sessionId does not hit ownership check', async () => {
        // This will fail at project lookup since isResolutionDatabaseAvailable returns false,
        // but crucially it should NOT return 404 with "Session not found"
        const { status, body } = await request(baseUrl, 'POST', `${CHAT_BASE}/agent`, {
          body: {
            projectId: 'proj-1',
            message: 'Start new session',
          },
        });
        // Expected: 503 (database not available for project lookup) -- NOT a session ownership error
        expect(status).toBe(503);
        expect(body.error).not.toBe('Session not found');
      });
    });
  });
});

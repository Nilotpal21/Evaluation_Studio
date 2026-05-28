/**
 * Session Ownership Authorization Tests
 *
 * Verifies that `createRequireSessionOwnership` enforces session ownership
 * for SDK auth users on the sessions router.
 *
 * SDK session auth (scenario 2):
 *   - SDK users can only access sessions they own (identity match).
 *   - Ownership is determined by matching customerId, channelArtifact, or anonymousId.
 *   - Mismatched SDK users receive 404 (not 403) to avoid leaking existence.
 *
 * Platform member auth (scenario 1) and API key auth (scenario 3):
 *   - Pass through session ownership middleware (RBAC checked elsewhere).
 *
 * List endpoint (GET /):
 *   - SDK users only see their own sessions (buildSessionListFilter).
 *   - Platform members see all project sessions.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
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
  claimSessionSlot: vi.fn().mockResolvedValue(1),
  releaseSessionSlot: vi.fn().mockResolvedValue(0),
  decrementSessionCount: vi.fn().mockResolvedValue(0),
  incrementSessionCount: vi.fn().mockResolvedValue(1),
}));

vi.mock('../../attachments/multimodal-service-client.js', () => ({
  MultimodalServiceClient: vi.fn().mockImplementation(() => ({
    deleteBySession: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@agent-platform/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/shared')>();
  return {
    ...actual,
    requireProjectScope: vi.fn(() => (_req: any, _res: any, next: any) => next()),
    getCurrentRequestId: vi.fn(() => 'req-test-ownership'),
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
        (router as any)[method](path, ...middlewares, lastHandler);
      },
    };
  }),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// --- Project repo: returns project with ownerId + membership lookup ---
vi.mock('../../repos/project-repo.js', () => ({
  findProjectByIdAndTenant: vi.fn().mockResolvedValue({
    _id: 'proj-1',
    tenantId: 'tenant-A',
    ownerId: 'project-owner',
  }),
  findProjectMember: vi.fn().mockImplementation((_projectId: string, userId: string) => {
    const memberships: Record<string, { role: string }> = {
      'proj-admin-user': { role: 'admin' },
      'proj-dev-user': { role: 'developer' },
    };
    return Promise.resolve(memberships[userId] ?? null);
  }),
  findProjectAgentsForProject: vi.fn().mockResolvedValue([]),
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

vi.mock('../../services/runtime-executor.js', () => ({
  getRuntimeExecutor: vi.fn(() => ({
    getSession: vi.fn().mockReturnValue(null),
    getSessionDetail: vi.fn().mockReturnValue(null),
    listSessions: vi.fn().mockReturnValue([]),
    endSession: vi.fn(),
  })),
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

// --- Session repo: configurable mock for ownership tests ---
const mockFindStoredSessionByAnyId = vi.fn();
const mockListSessions = vi.fn().mockResolvedValue([]);
const mockCountSessions = vi.fn().mockResolvedValue(0);
const mockFindMessagesForSessionCursor = vi.fn().mockResolvedValue({
  messages: [],
  nextCursor: null,
  hasMore: false,
});
const mockListStoredSessionCleanupIds = vi.fn().mockResolvedValue([]);
vi.mock('../../repos/session-repo.js', () => ({
  listSessions: (...args: any[]) => mockListSessions(...args),
  countSessions: (...args: any[]) => mockCountSessions(...args),
  findSessionById: (...args: any[]) => mockFindStoredSessionByAnyId(...args),
  findStoredSessionByAnyId: (...args: any[]) => mockFindStoredSessionByAnyId(...args),
  findSessionByRuntimeId: vi.fn().mockResolvedValue(null),
  findMessagesForSession: vi.fn().mockResolvedValue([]),
  findMessagesForSessionCursor: (...args: any[]) => mockFindMessagesForSessionCursor(...args),
  listStoredSessionCleanupIds: (...args: any[]) => mockListStoredSessionCleanupIds(...args),
  resolveStoredSessionCompatibilityId: vi.fn(
    (session: { id?: string | null; _id?: string | null } | null | undefined, fallbackId: string) =>
      session?.id || session?._id || fallbackId,
  ),
  updateSession: vi.fn(),
}));

vi.mock('../../services/audit-helpers.js', () => ({
  auditSessionModified: vi.fn().mockResolvedValue(undefined),
}));

// =============================================================================
// IMPORTS -- after mocks
// =============================================================================

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import {
  buildSessionListFilter,
  createRequireSessionOwnership,
  toAuthContext,
} from '@agent-platform/shared-auth';
import { buildStoredSessionAccessSource } from '../../services/identity/stored-session-access-source.js';
import { buildStoredSessionCallerContext } from '../../services/identity/stored-session-caller-context.js';

// =============================================================================
// HELPERS
// =============================================================================

const SESSIONS_BASE = '/api/projects/proj-1/sessions';

function extractSessionListScopeClause(
  filterArg: Record<string, unknown>,
): Record<string, unknown> {
  const andClauses = Array.isArray(filterArg.$and) ? filterArg.$and : [];
  const scopedClause = andClauses.find(
    (clause): clause is Record<string, unknown> =>
      !!clause &&
      typeof clause === 'object' &&
      !Array.isArray(clause) &&
      ('tenantId' in clause ||
        'projectId' in clause ||
        'customerId' in clause ||
        'anonymousId' in clause ||
        'channelArtifact' in clause ||
        'initiatedById' in clause),
  );

  return scopedClause ?? filterArg;
}

/**
 * Session fixture: a session owned by customerId='cust-alice'
 */
const ALICE_SESSION = {
  _id: 'sess-alice',
  id: 'sess-alice',
  tenantId: 'tenant-A',
  projectId: 'proj-1',
  customerId: 'cust-alice',
  anonymousId: null,
  channelArtifact: null,
  channel: 'webchat',
  channelId: 'webchat',
  identityTier: 2,
  verificationMethod: 'hmac',
  currentAgent: 'test-agent',
  status: 'active',
  messageCount: 5,
  startedAt: new Date(),
  lastActivityAt: new Date(),
};

async function request(baseUrl: string, method: string, path: string, opts?: { body?: any }) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

function createOwnershipTestRouter() {
  const router = express.Router({ mergeParams: true });
  const requireSessionOwnership = createRequireSessionOwnership({
    async findSession(sessionId, tenantId) {
      const session = await mockFindStoredSessionByAnyId(sessionId, tenantId);
      if (!session) {
        return null;
      }
      return {
        callerContext: buildStoredSessionCallerContext(session, tenantId),
        ownerUserId:
          typeof session.initiatedById === 'string'
            ? session.initiatedById
            : typeof session.createdBy === 'string'
              ? session.createdBy
              : null,
        source: buildStoredSessionAccessSource(session),
      };
    },
  });

  router.get('/', async (req, res) => {
    const tenantContext = (req as any).tenantContext;
    const projectId = req.params.projectId;
    const filter = buildSessionListFilter(toAuthContext(tenantContext), projectId);
    await mockListSessions(filter);
    res.json({ success: true, sessions: [] });
  });

  router.get('/:id', requireSessionOwnership, async (req, res) => {
    const tenantId = (req as any).tenantContext?.tenantId;
    const session = await mockFindStoredSessionByAnyId(req.params.id, tenantId);
    if (!session) {
      res.status(404).json({ success: false, error: { message: 'Session not found' } });
      return;
    }
    res.json({ success: true });
  });

  router.get('/:id/traces', requireSessionOwnership, (_req, res) => {
    res.json({ success: true, traces: [] });
  });

  router.delete('/:id', requireSessionOwnership, (req, res) => {
    const permissions = ((req as any).tenantContext?.permissions ?? []) as string[];
    if (!permissions.includes('session:delete') && !permissions.includes('*:*')) {
      res.status(403).json({
        error: { message: 'Forbidden' },
        required: 'session:delete',
      });
      return;
    }
    res.json({ success: true });
  });

  router.post('/:id/close', requireSessionOwnership, (_req, res) => {
    res.json({ success: true });
  });

  router.post('/:id/reset', requireSessionOwnership, (_req, res) => {
    res.json({ success: true });
  });

  return router;
}

/**
 * Create an Express server with SDK session auth context injected.
 * Simulates an SDK end-user with the given identity fields.
 */
async function createSDKServer(identity: {
  customerId?: string;
  channelArtifact?: string;
  anonymousId?: string;
  identityTier?: number;
  verificationMethod?: string;
}) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).tenantContext = {
      tenantId: 'tenant-A',
      userId: 'sdk:webchat',
      role: 'sdk_session',
      permissions: ['session:read', 'session:execute'],
      authType: 'sdk_session',
      isSuperAdmin: false,
      projectId: 'proj-1',
      channelId: 'webchat',
      identityTier: identity.identityTier ?? 2,
      verificationMethod: identity.verificationMethod ?? 'hmac',
      verifiedUserId: identity.customerId,
      userContext: identity.customerId ? { userId: identity.customerId } : undefined,
      channelArtifact: identity.channelArtifact,
      anonymousId: identity.anonymousId,
    };
    (req as any).user = { id: 'sdk:webchat', email: 'sdk@test.com' };
    next();
  });
  app.use('/api/projects/:projectId/sessions', createOwnershipTestRouter());

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

/**
 * Create an Express server with platform member (User JWT) auth context.
 */
async function createPlatformMemberServer(role: string, userId: string) {
  const ROLE_PERMISSIONS: Record<string, string[]> = {
    OWNER: ['*:*'],
    ADMIN: ['tenant:read', 'project:*'],
  };
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).tenantContext = {
      tenantId: 'tenant-A',
      userId,
      role,
      permissions: ROLE_PERMISSIONS[role] || [],
      authType: 'user',
      isSuperAdmin: false,
    };
    (req as any).user = { id: userId, email: `${userId}@test.com` };
    next();
  });
  app.use('/api/projects/:projectId/sessions', createOwnershipTestRouter());

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

/**
 * Create an Express server with API key auth context.
 */
async function createApiKeyServer() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).tenantContext = {
      tenantId: 'tenant-A',
      userId: 'key-creator',
      role: 'api_key',
      permissions: ['session:read', 'session:execute', 'session:delete', 'project:*'],
      authType: 'api_key',
      isSuperAdmin: false,
      apiKeyId: 'key-1',
      clientId: 'client-1',
      projectScope: ['proj-1'],
    };
    (req as any).user = { id: 'key-creator', email: 'key@test.com' };
    next();
  });
  app.use('/api/projects/:projectId/sessions', createOwnershipTestRouter());

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

describe('Session ownership authorization', () => {
  beforeEach(() => {
    mockFindStoredSessionByAnyId.mockReset();
    mockListSessions.mockReset().mockResolvedValue([]);
    mockCountSessions.mockReset().mockResolvedValue(0);
    mockFindMessagesForSessionCursor.mockReset().mockResolvedValue({
      messages: [],
      nextCursor: null,
      hasMore: false,
    });
    mockListStoredSessionCleanupIds.mockReset().mockResolvedValue([]);
  });

  // ---------------------------------------------------------------------------
  // SDK user accessing own session (customerId match) -> 200
  // ---------------------------------------------------------------------------
  describe('SDK user with matching customerId', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeEach(async () => {
      ({ baseUrl, server } = await createSDKServer({ customerId: 'cust-alice' }));
    });
    afterEach(() => server?.close());

    test('GET /:id returns session when customerId matches', async () => {
      mockFindStoredSessionByAnyId.mockResolvedValue(ALICE_SESSION);
      const { status, body } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-alice`);
      // Should not be blocked by ownership middleware (404 from DB lookup is fine)
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('DELETE /:id reaches RBAC after ownership succeeds when customerId matches', async () => {
      mockFindStoredSessionByAnyId.mockResolvedValue(ALICE_SESSION);
      const { status } = await request(baseUrl, 'DELETE', `${SESSIONS_BASE}/sess-alice`);
      expect(status).toBe(403);
      expect(status).not.toBe(401);
      expect(status).not.toBe(404);
    });

    test('GET /:id/traces passes ownership check when customerId matches', async () => {
      mockFindStoredSessionByAnyId.mockResolvedValue(ALICE_SESSION);
      const { status } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-alice/traces`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // SDK user accessing another user's session (customerId mismatch) -> 404
  // ---------------------------------------------------------------------------
  describe('SDK user with non-matching customerId', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeEach(async () => {
      ({ baseUrl, server } = await createSDKServer({ customerId: 'cust-bob' }));
    });
    afterEach(() => server?.close());

    test('GET /:id returns 404 when customerId does not match', async () => {
      // Session belongs to cust-alice, but SDK user is cust-bob
      mockFindStoredSessionByAnyId.mockResolvedValue(ALICE_SESSION);
      const { status, body } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-alice`);
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });

    test('DELETE /:id returns 404 when customerId does not match', async () => {
      mockFindStoredSessionByAnyId.mockResolvedValue(ALICE_SESSION);
      const { status, body } = await request(baseUrl, 'DELETE', `${SESSIONS_BASE}/sess-alice`);
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });

    test('GET /:id/traces returns 404 when customerId does not match', async () => {
      mockFindStoredSessionByAnyId.mockResolvedValue(ALICE_SESSION);
      const { status, body } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-alice/traces`);
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });

    test('POST /:id/close returns 404 when customerId does not match', async () => {
      mockFindStoredSessionByAnyId.mockResolvedValue(ALICE_SESSION);
      const { status, body } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/sess-alice/close`, {
        body: { disposition: 'completed' },
      });
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });

    test('POST /:id/reset returns 404 when customerId does not match', async () => {
      mockFindStoredSessionByAnyId.mockResolvedValue(ALICE_SESSION);
      const { status, body } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/sess-alice/reset`);
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });
  });

  // ---------------------------------------------------------------------------
  // SDK user listing sessions -> only own sessions returned
  // ---------------------------------------------------------------------------
  describe('SDK user listing sessions (GET /)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeEach(async () => {
      ({ baseUrl, server } = await createSDKServer({ customerId: 'cust-alice' }));
    });
    afterEach(() => server?.close());

    test('GET / uses buildSessionListFilter to scope by customerId', async () => {
      // Mock listSessions to return matching sessions and capture the filter
      mockListSessions.mockResolvedValue([]);
      mockCountSessions.mockResolvedValue(0);

      const { status } = await request(baseUrl, 'GET', SESSIONS_BASE);
      expect(status).toBe(200);

      // Verify the filter passed to listSessions includes customerId scoping
      expect(mockListSessions).toHaveBeenCalled();
      const filterArg = mockListSessions.mock.calls[0][0] as Record<string, unknown>;
      const scopedFilter = extractSessionListScopeClause(filterArg);
      expect(scopedFilter).toHaveProperty('tenantId', 'tenant-A');
      expect(scopedFilter).toHaveProperty('projectId', 'proj-1');
      expect(scopedFilter).toHaveProperty('customerId', 'cust-alice');
    });
  });

  // ---------------------------------------------------------------------------
  // Platform member (User JWT) with session:read -> passes through (any session)
  // ---------------------------------------------------------------------------
  describe('Platform member (OWNER) accessing any session', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeEach(async () => {
      ({ baseUrl, server } = await createPlatformMemberServer('OWNER', 'owner-user'));
    });
    afterEach(() => server?.close());

    test('GET /:id passes through ownership middleware (User JWT)', async () => {
      // Ownership middleware should not even call findSessionById for non-SDK auth
      mockFindStoredSessionByAnyId.mockResolvedValue(null);
      const { status } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-alice`);
      // Should reach the route handler (404 from route handler is expected since
      // the route handler's own DB lookup returns null)
      expect(status).toBe(404);
      // The 404 is from the route handler, NOT the ownership middleware
    });

    test('GET / lists all project sessions (no ownership filter)', async () => {
      mockListSessions.mockResolvedValue([]);
      mockCountSessions.mockResolvedValue(0);

      const { status } = await request(baseUrl, 'GET', SESSIONS_BASE);
      expect(status).toBe(200);

      // Filter should NOT include customerId (platform members see all sessions)
      if (mockListSessions.mock.calls.length > 0) {
        const filterArg = mockListSessions.mock.calls[0][0] as Record<string, unknown>;
        const scopedFilter = extractSessionListScopeClause(filterArg);
        expect(scopedFilter).not.toHaveProperty('customerId');
        expect(scopedFilter).not.toHaveProperty('anonymousId');
        expect(scopedFilter).not.toHaveProperty('channelArtifact');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // API key with project scope -> passes through (any session)
  // ---------------------------------------------------------------------------
  describe('API key accessing sessions', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeEach(async () => {
      ({ baseUrl, server } = await createApiKeyServer());
    });
    afterEach(() => server?.close());

    test('GET /:id passes through ownership middleware (API key)', async () => {
      mockFindStoredSessionByAnyId.mockResolvedValue(null);
      const { status } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-alice`);
      // Should reach route handler (404 from handler's own lookup)
      expect(status).toBe(404);
    });

    test('GET / lists all project sessions (no ownership filter)', async () => {
      mockListSessions.mockResolvedValue([]);
      mockCountSessions.mockResolvedValue(0);

      const { status } = await request(baseUrl, 'GET', SESSIONS_BASE);
      expect(status).toBe(200);

      // Filter should NOT include customerId (API keys see all sessions)
      if (mockListSessions.mock.calls.length > 0) {
        const filterArg = mockListSessions.mock.calls[0][0] as Record<string, unknown>;
        const scopedFilter = extractSessionListScopeClause(filterArg);
        expect(scopedFilter).not.toHaveProperty('customerId');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // SDK user with channelArtifact identity tier
  // ---------------------------------------------------------------------------
  describe('SDK user with channelArtifact identity', () => {
    let baseUrl: string;
    let server: http.Server;

    const ARTIFACT_SESSION = {
      ...ALICE_SESSION,
      _id: 'sess-artifact',
      id: 'sess-artifact',
      customerId: null,
      channelArtifact: 'hash-device-abc',
      identityTier: 1,
      verificationMethod: 'cookie',
    };

    beforeEach(async () => {
      ({ baseUrl, server } = await createSDKServer({
        channelArtifact: 'hash-device-abc',
        identityTier: 1,
        verificationMethod: 'cookie',
      }));
    });
    afterEach(() => server?.close());

    test('GET /:id passes when channelArtifact matches', async () => {
      mockFindStoredSessionByAnyId.mockResolvedValue(ARTIFACT_SESSION);
      const { status } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-artifact`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // SDK user accessing session that does not exist -> 404
  // ---------------------------------------------------------------------------
  describe('SDK user accessing non-existent session', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeEach(async () => {
      ({ baseUrl, server } = await createSDKServer({ customerId: 'cust-alice' }));
    });
    afterEach(() => server?.close());

    test('GET /:id returns 404 for non-existent session', async () => {
      mockFindStoredSessionByAnyId.mockResolvedValue(null);
      const { status, body } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-nonexistent`);
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });
  });
});

/**
 * Sessions Authorization Tests -- Project-Level Object:Operation RBAC
 *
 * Verifies that `requireProjectPermission` enforces project-level permissions
 * on the sessions router using object:operation format.
 *
 * Resolution order in requireProjectPermission:
 *   1. Tenant OWNER/ADMIN -> workspace authority (project:* bypass)
 *   2. Project existence -> 404 if not found (tenant isolation)
 *   3. Project owner -> full access (ownerId match)
 *   4. Project member role -> permission check via PROJECT_ROLE_PERMISSIONS
 *   5. No membership -> 403
 *
 * Permission mapping:
 *   POST /              -> session:execute (create session)
 *   GET  /              -> session:read    (list sessions)
 *   POST /bulk-close    -> session:execute (bulk close)
 *   POST /cleanup-orphans -> session:delete (delete orphans)
 *   GET  /:id           -> session:read    (get session detail)
 *   DELETE /:id         -> session:delete  (delete session)
 *   POST /:id/close     -> session:execute (close session)
 *   POST /:id/reset     -> session:execute (reset session)
 *   GET  /:id/traces    -> session:read    (get traces)
 *   GET  /:id/agent-spec -> session:read   (get agent spec)
 *   GET  /:id/analysis  -> session:read    (get analysis)
 *
 * Project role -> permissions:
 *   admin     -> *:* (all)
 *   developer -> session:* (all session operations)
 *   viewer    -> session:read (read only)
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
}));

// Keep real hasPermission but stub requireProjectScope and getCurrentRequestId
vi.mock('@agent-platform/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/shared')>();
  return {
    ...actual,
    requireProjectScope: vi.fn(() => (_req: any, _res: any, next: any) => next()),
    getCurrentRequestId: vi.fn(() => 'req-test-1'),
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

vi.mock('@abl/compiler/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
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
      'proj-viewer-user': { role: 'viewer' },
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
  isDatabaseAvailable: vi.fn(() => false),
  requirePrisma: vi.fn(),
}));

vi.mock('../../repos/session-repo.js', () => ({
  listSessions: vi.fn().mockResolvedValue([]),
  countSessions: vi.fn().mockResolvedValue(0),
  findSessionById: vi.fn().mockResolvedValue(null),
  findStoredSessionByAnyId: vi.fn().mockResolvedValue(null),
  findSessionByRuntimeId: vi.fn().mockResolvedValue(null),
  findMessagesForSession: vi.fn().mockResolvedValue([]),
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

vi.mock('../../services/audit-helpers.js', () => ({
  auditSessionModified: vi.fn().mockResolvedValue(undefined),
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

async function request(baseUrl: string, method: string, path: string, opts?: { body?: any }) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function createServerForUser(
  tenantRole: 'OWNER' | 'ADMIN' | 'OPERATOR' | 'MEMBER' | 'VIEWER',
  userId: string,
) {
  const app = express();
  app.use(express.json());
  const ctx = makeTenantContext('tenant-A', userId, tenantRole);
  app.use(injectTenantContext(ctx));
  const sessionsRouter = (await import('../../routes/sessions.js')).default;
  app.use('/api/projects/:projectId/sessions', sessionsRouter);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

async function createUnauthenticatedServer() {
  const app = express();
  app.use(express.json());
  const sessionsRouter = (await import('../../routes/sessions.js')).default;
  app.use('/api/projects/:projectId/sessions', sessionsRouter);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

const CREATE_BODY = { agentName: 'test-agent' };
const BULK_CLOSE_BODY = { agentName: 'test-agent', disposition: 'abandoned' };
const CLOSE_BODY = { disposition: 'completed' };
const RESET_BODY = {};

// =============================================================================
// TESTS
// =============================================================================

describe('Sessions route authorization -- project-level object:operation RBAC', () => {
  // ---------------------------------------------------------------------------
  // Tenant OWNER -- *:* includes project:* -> workspace bypass -> all pass
  // ---------------------------------------------------------------------------
  describe('Tenant OWNER (workspace authority)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('OWNER', 'owner-user'));
    });
    afterAll(() => server?.close());

    test('POST / passes (session:execute -- workspace authority)', async () => {
      const { status } = await request(baseUrl, 'POST', SESSIONS_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET / passes (session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', SESSIONS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /bulk-close passes (session:execute)', async () => {
      const { status } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/bulk-close`, {
        body: BULK_CLOSE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /cleanup-orphans passes (session:delete)', async () => {
      const { status } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/cleanup-orphans`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id passes (session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('DELETE /:id passes (session:delete)', async () => {
      const { status } = await request(baseUrl, 'DELETE', `${SESSIONS_BASE}/sess-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/close passes (session:execute)', async () => {
      const { status } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/sess-1/close`, {
        body: CLOSE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/reset passes (session:execute)', async () => {
      const { status } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/sess-1/reset`, {
        body: RESET_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id/traces passes (session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1/traces`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id/agent-spec passes (session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1/agent-spec`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id/analysis passes (session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1/analysis`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Tenant ADMIN -- project:* -> workspace bypass -> all pass
  // ---------------------------------------------------------------------------
  describe('Tenant ADMIN (workspace authority)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('ADMIN', 'admin-user'));
    });
    afterAll(() => server?.close());

    test('POST / passes (session:execute -- workspace authority)', async () => {
      const { status } = await request(baseUrl, 'POST', SESSIONS_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET / passes (session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', SESSIONS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /bulk-close passes (session:execute)', async () => {
      const { status } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/bulk-close`, {
        body: BULK_CLOSE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /cleanup-orphans passes (session:delete)', async () => {
      const { status } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/cleanup-orphans`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id passes (session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('DELETE /:id passes (session:delete)', async () => {
      const { status } = await request(baseUrl, 'DELETE', `${SESSIONS_BASE}/sess-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/close passes (session:execute)', async () => {
      const { status } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/sess-1/close`, {
        body: CLOSE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/reset passes (session:execute)', async () => {
      const { status } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/sess-1/reset`, {
        body: RESET_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id/traces passes (session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1/traces`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id/agent-spec passes (session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1/agent-spec`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id/analysis passes (session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1/analysis`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Project owner (OPERATOR tenant role) -- ownerId match -> full access
  // ---------------------------------------------------------------------------
  describe('Project owner (ownerId match)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('OPERATOR', 'project-owner'));
    });
    afterAll(() => server?.close());

    test('POST / passes (session:execute -- project owner)', async () => {
      const { status } = await request(baseUrl, 'POST', SESSIONS_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET / passes (session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', SESSIONS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /bulk-close passes (session:execute)', async () => {
      const { status } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/bulk-close`, {
        body: BULK_CLOSE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /cleanup-orphans passes (session:delete)', async () => {
      const { status } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/cleanup-orphans`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id passes (session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('DELETE /:id passes (session:delete)', async () => {
      const { status } = await request(baseUrl, 'DELETE', `${SESSIONS_BASE}/sess-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/close passes (session:execute)', async () => {
      const { status } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/sess-1/close`, {
        body: CLOSE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/reset passes (session:execute)', async () => {
      const { status } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/sess-1/reset`, {
        body: RESET_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id/traces passes (session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1/traces`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id/agent-spec passes (session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1/agent-spec`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id/analysis passes (session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1/analysis`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Project admin member (OPERATOR tenant role) -> admin: *:* -> all pass
  // ---------------------------------------------------------------------------
  describe('Project admin member', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('OPERATOR', 'proj-admin-user'));
    });
    afterAll(() => server?.close());

    test('POST / passes (admin has *:* -> session:execute)', async () => {
      const { status } = await request(baseUrl, 'POST', SESSIONS_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET / passes (admin has *:* -> session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', SESSIONS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /bulk-close passes (admin has *:* -> session:execute)', async () => {
      const { status } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/bulk-close`, {
        body: BULK_CLOSE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /cleanup-orphans passes (admin has *:* -> session:delete)', async () => {
      const { status } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/cleanup-orphans`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id passes (admin has *:* -> session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('DELETE /:id passes (admin has *:* -> session:delete)', async () => {
      const { status } = await request(baseUrl, 'DELETE', `${SESSIONS_BASE}/sess-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/close passes (admin has *:* -> session:execute)', async () => {
      const { status } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/sess-1/close`, {
        body: CLOSE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/reset passes (admin has *:* -> session:execute)', async () => {
      const { status } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/sess-1/reset`, {
        body: RESET_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id/traces passes (admin has *:* -> session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1/traces`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id/agent-spec passes (admin has *:* -> session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1/agent-spec`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id/analysis passes (admin has *:* -> session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1/analysis`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Project developer member (OPERATOR tenant role) -> developer: session:* -> all pass
  // ---------------------------------------------------------------------------
  describe('Project developer member', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('OPERATOR', 'proj-dev-user'));
    });
    afterAll(() => server?.close());

    test('POST / passes (developer has session:* -> session:execute)', async () => {
      const { status } = await request(baseUrl, 'POST', SESSIONS_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET / passes (developer has session:* -> session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', SESSIONS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /bulk-close passes (developer has session:* -> session:execute)', async () => {
      const { status } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/bulk-close`, {
        body: BULK_CLOSE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /cleanup-orphans passes (developer has session:* -> session:delete)', async () => {
      const { status } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/cleanup-orphans`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id passes (developer has session:* -> session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('DELETE /:id passes (developer has session:* -> session:delete)', async () => {
      const { status } = await request(baseUrl, 'DELETE', `${SESSIONS_BASE}/sess-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/close passes (developer has session:* -> session:execute)', async () => {
      const { status } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/sess-1/close`, {
        body: CLOSE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/reset passes (developer has session:* -> session:execute)', async () => {
      const { status } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/sess-1/reset`, {
        body: RESET_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id/traces passes (developer has session:* -> session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1/traces`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id/agent-spec passes (developer has session:* -> session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1/agent-spec`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id/analysis passes (developer has session:* -> session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1/analysis`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Project viewer member (MEMBER tenant role) -> viewer: session:read only
  // Read endpoints pass, write/delete endpoints get 403
  // ---------------------------------------------------------------------------
  describe('Project viewer member', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('MEMBER', 'proj-viewer-user'));
    });
    afterAll(() => server?.close());

    // --- Read endpoints: pass ---

    test('GET / passes (viewer has session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', SESSIONS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id passes (viewer has session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id/traces passes (viewer has session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1/traces`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id/agent-spec passes (viewer has session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1/agent-spec`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id/analysis passes (viewer has session:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1/analysis`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    // --- Write/execute endpoints: 403 ---

    test('POST / returns 403 (viewer lacks session:execute)', async () => {
      const { status, body } = await request(baseUrl, 'POST', SESSIONS_BASE, {
        body: CREATE_BODY,
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('viewer');
      expect(body.message).toContain('session:execute');
    });

    test('POST /bulk-close returns 403 (viewer lacks session:execute)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/bulk-close`, {
        body: BULK_CLOSE_BODY,
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('viewer');
      expect(body.message).toContain('session:execute');
    });

    test('POST /cleanup-orphans returns 403 (viewer lacks session:delete)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/cleanup-orphans`);
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('viewer');
      expect(body.message).toContain('session:delete');
    });

    test('DELETE /:id returns 404 (session ownership check before RBAC — session not found)', async () => {
      const { status, body } = await request(baseUrl, 'DELETE', `${SESSIONS_BASE}/sess-1`);
      // Session ownership middleware runs before RBAC via router.param('id').
      // When findSessionById returns null, it returns 404 to conceal session existence.
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });

    test('POST /:id/close returns 404 (session ownership check before RBAC — session not found)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/sess-1/close`, {
        body: CLOSE_BODY,
      });
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });

    test('POST /:id/reset returns 404 (session ownership check before RBAC — session not found)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/sess-1/reset`, {
        body: RESET_BODY,
      });
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });
  });

  // ---------------------------------------------------------------------------
  // Non-member (OPERATOR tenant role, no project membership) -> all 404
  // This is the key test: tenant-level permissions alone are NOT enough
  // ---------------------------------------------------------------------------
  describe('Non-member (OPERATOR without project membership)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('OPERATOR', 'non-member-user'));
    });
    afterAll(() => server?.close());

    test('POST / returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'POST', SESSIONS_BASE, {
        body: CREATE_BODY,
      });
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('GET / returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'GET', SESSIONS_BASE);
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('POST /bulk-close returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/bulk-close`, {
        body: BULK_CLOSE_BODY,
      });
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('POST /cleanup-orphans returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/cleanup-orphans`);
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('GET /:id returns 404 (session ownership check before RBAC — session not found)', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1`);
      // Session ownership middleware runs before RBAC via router.param('id').
      // When findSessionById returns null, it returns 404 to conceal session existence.
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });

    test('DELETE /:id returns 404 (session ownership check before RBAC — session not found)', async () => {
      const { status, body } = await request(baseUrl, 'DELETE', `${SESSIONS_BASE}/sess-1`);
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });

    test('POST /:id/close returns 404 (session ownership check before RBAC — session not found)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/sess-1/close`, {
        body: CLOSE_BODY,
      });
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });

    test('POST /:id/reset returns 404 (session ownership check before RBAC — session not found)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/sess-1/reset`, {
        body: RESET_BODY,
      });
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });

    test('GET /:id/traces returns 404 (session ownership check before RBAC — session not found)', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1/traces`);
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });

    test('GET /:id/agent-spec returns 404 (session ownership check before RBAC — session not found)', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1/agent-spec`);
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });

    test('GET /:id/analysis returns 404 (session ownership check before RBAC — session not found)', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1/analysis`);
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });
  });

  // ---------------------------------------------------------------------------
  // Unauthenticated -- no tenant context -> all 401
  // ---------------------------------------------------------------------------
  describe('Unauthenticated requests', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createUnauthenticatedServer());
    });
    afterAll(() => server?.close());

    test('POST / returns 401', async () => {
      const { status, body } = await request(baseUrl, 'POST', SESSIONS_BASE, {
        body: CREATE_BODY,
      });
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('GET / returns 401', async () => {
      const { status, body } = await request(baseUrl, 'GET', SESSIONS_BASE);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('POST /bulk-close returns 401', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/bulk-close`, {
        body: BULK_CLOSE_BODY,
      });
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('POST /cleanup-orphans returns 401', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/cleanup-orphans`);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('GET /:id returns 401', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1`);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('DELETE /:id returns 401', async () => {
      const { status, body } = await request(baseUrl, 'DELETE', `${SESSIONS_BASE}/sess-1`);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('POST /:id/close returns 401', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/sess-1/close`, {
        body: CLOSE_BODY,
      });
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('POST /:id/reset returns 401', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/sess-1/reset`, {
        body: RESET_BODY,
      });
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('GET /:id/traces returns 401', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1/traces`);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('GET /:id/agent-spec returns 401', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1/agent-spec`);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('GET /:id/analysis returns 401', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${SESSIONS_BASE}/sess-1/analysis`);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });
  });
});

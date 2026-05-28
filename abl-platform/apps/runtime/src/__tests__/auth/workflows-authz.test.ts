/**
 * Workflows Route Authorization Tests — Project-Level Object:Operation RBAC
 *
 * Verifies that `requireProjectPermission` enforces project-level permissions
 * on the workflows router using object:operation format.
 *
 * Resolution order in requireProjectPermission:
 *   1. Tenant OWNER/ADMIN → workspace authority (project:* bypass)
 *   2. Project existence → 404 if not found (tenant isolation)
 *   3. Project owner → full access (ownerId match)
 *   4. Project member role → permission check via PROJECT_ROLE_PERMISSIONS
 *   5. No membership → 403
 *
 * Permission mapping:
 *   POST /                        → workflow:create
 *   GET  /                        → workflow:read
 *   GET  /by-name                 → workflow:read
 *   GET  /:id                     → workflow:read
 *   PUT  /:id                     → workflow:update
 *   POST /:id/archive             → workflow:delete
 *   POST /:id/associate-session   → workflow:execute
 *
 * Project role → permissions:
 *   admin     → *:* (all)
 *   developer → workflow:* (all)
 *   viewer    → workflow:read (read only)
 */

import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// =============================================================================
// MOCKS — must be declared before any import that transitively pulls them in
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
}));

vi.mock('../../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock('../../services/stores/store-factory.js', () => ({
  getStores: vi.fn(() => ({
    workflowDefinition: {
      create: vi.fn().mockResolvedValue({
        id: 'wf-1',
        name: 'Test',
        type: 'cx_automation',
        status: 'active',
        projectId: 'proj-1',
        tenantId: 'tenant-A',

        steps: [],
        triggers: [],
        escalationRules: [],
        metadata: {},
        createdAt: new Date().toISOString(),
      }),
      query: vi.fn().mockResolvedValue({ definitions: [], total: 0 }),
      getById: vi.fn().mockResolvedValue({
        id: 'wf-1',
        name: 'Test',
        projectId: 'proj-1',
        tenantId: 'tenant-A',
        type: 'cx_automation',
        status: 'active',

        steps: [],
        triggers: [],
        escalationRules: [],
        metadata: {},
        createdAt: new Date().toISOString(),
      }),
      getByName: vi.fn().mockResolvedValue({
        id: 'wf-1',
        name: 'Test',
        projectId: 'proj-1',
        tenantId: 'tenant-A',
        type: 'cx_automation',
        status: 'active',

        steps: [],
        triggers: [],
        escalationRules: [],
        metadata: {},
        createdAt: new Date().toISOString(),
      }),
      update: vi.fn().mockResolvedValue({
        id: 'wf-1',
        name: 'Updated',
        type: 'cx_automation',
        status: 'active',
        projectId: 'proj-1',
        tenantId: 'tenant-A',

        steps: [],
        triggers: [],
        escalationRules: [],
        metadata: {},
        createdAt: new Date().toISOString(),
      }),
      archive: vi.fn().mockResolvedValue(undefined),
    },
    conversation: {
      associateWorkflow: vi.fn().mockResolvedValue(undefined),
    },
  })),
}));

vi.mock('../../repos/session-repo.js', () => ({
  countSessions: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../services/audit-helpers.js', () => ({
  auditWorkflowCreated: vi.fn().mockResolvedValue(undefined),
  auditWorkflowUpdated: vi.fn().mockResolvedValue(undefined),
  auditWorkflowArchived: vi.fn().mockResolvedValue(undefined),
}));

// =============================================================================
// IMPORTS — after mocks
// =============================================================================

import express from 'express';
import { makeTenantContext, injectTenantContext } from '../helpers/auth-context.js';

// =============================================================================
// HELPERS
// =============================================================================

const WORKFLOWS_BASE = '/api/projects/proj-1/workflows';

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
  const workflowsRouter = (await import('../../routes/workflows.js')).default;
  app.use('/api/projects/:projectId/workflows', workflowsRouter);

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
  const workflowsRouter = (await import('../../routes/workflows.js')).default;
  app.use('/api/projects/:projectId/workflows', workflowsRouter);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

const CREATE_BODY = { name: 'Test Workflow' };
const UPDATE_BODY = { name: 'Updated Workflow' };
const ASSOCIATE_BODY = { sessionId: 'sess-1' };

// =============================================================================
// TESTS
// =============================================================================

describe('Workflows route authorization — project-level object:operation RBAC', () => {
  // ---------------------------------------------------------------------------
  // Tenant OWNER — *:* includes project:* → workspace bypass → all pass
  // ---------------------------------------------------------------------------
  describe('Tenant OWNER (workspace authority)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('OWNER', 'owner-user'));
    });
    afterAll(() => server?.close());

    test('POST / passes (workflow:create — workspace authority)', async () => {
      const { status } = await request(baseUrl, 'POST', WORKFLOWS_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET / passes (workflow:read)', async () => {
      const { status } = await request(baseUrl, 'GET', WORKFLOWS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /by-name passes (workflow:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${WORKFLOWS_BASE}/by-name?name=Test`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id passes (workflow:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${WORKFLOWS_BASE}/wf-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('PUT /:id passes (workflow:update)', async () => {
      const { status } = await request(baseUrl, 'PUT', `${WORKFLOWS_BASE}/wf-1`, {
        body: UPDATE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/archive passes (workflow:delete)', async () => {
      const { status } = await request(baseUrl, 'POST', `${WORKFLOWS_BASE}/wf-1/archive`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/associate-session passes (workflow:execute)', async () => {
      const { status } = await request(
        baseUrl,
        'POST',
        `${WORKFLOWS_BASE}/wf-1/associate-session`,
        {
          body: ASSOCIATE_BODY,
        },
      );
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Tenant ADMIN — project:* → workspace bypass → all pass
  // ---------------------------------------------------------------------------
  describe('Tenant ADMIN (workspace authority)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('ADMIN', 'admin-user'));
    });
    afterAll(() => server?.close());

    test('POST / passes (workflow:create — workspace authority)', async () => {
      const { status } = await request(baseUrl, 'POST', WORKFLOWS_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET / passes (workflow:read)', async () => {
      const { status } = await request(baseUrl, 'GET', WORKFLOWS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /by-name passes (workflow:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${WORKFLOWS_BASE}/by-name?name=Test`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id passes (workflow:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${WORKFLOWS_BASE}/wf-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('PUT /:id passes (workflow:update)', async () => {
      const { status } = await request(baseUrl, 'PUT', `${WORKFLOWS_BASE}/wf-1`, {
        body: UPDATE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/archive passes (workflow:delete)', async () => {
      const { status } = await request(baseUrl, 'POST', `${WORKFLOWS_BASE}/wf-1/archive`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/associate-session passes (workflow:execute)', async () => {
      const { status } = await request(
        baseUrl,
        'POST',
        `${WORKFLOWS_BASE}/wf-1/associate-session`,
        {
          body: ASSOCIATE_BODY,
        },
      );
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Project owner (OPERATOR tenant role) — ownerId match → full access
  // ---------------------------------------------------------------------------
  describe('Project owner (ownerId match)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('OPERATOR', 'project-owner'));
    });
    afterAll(() => server?.close());

    test('POST / passes (workflow:create — project owner)', async () => {
      const { status } = await request(baseUrl, 'POST', WORKFLOWS_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET / passes (workflow:read)', async () => {
      const { status } = await request(baseUrl, 'GET', WORKFLOWS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /by-name passes (workflow:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${WORKFLOWS_BASE}/by-name?name=Test`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id passes (workflow:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${WORKFLOWS_BASE}/wf-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('PUT /:id passes (workflow:update)', async () => {
      const { status } = await request(baseUrl, 'PUT', `${WORKFLOWS_BASE}/wf-1`, {
        body: UPDATE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/archive passes (workflow:delete)', async () => {
      const { status } = await request(baseUrl, 'POST', `${WORKFLOWS_BASE}/wf-1/archive`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/associate-session passes (workflow:execute)', async () => {
      const { status } = await request(
        baseUrl,
        'POST',
        `${WORKFLOWS_BASE}/wf-1/associate-session`,
        {
          body: ASSOCIATE_BODY,
        },
      );
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Project admin member (OPERATOR tenant role) → admin: *:* → all pass
  // ---------------------------------------------------------------------------
  describe('Project admin member', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('OPERATOR', 'proj-admin-user'));
    });
    afterAll(() => server?.close());

    test('POST / passes (admin has *:* → workflow:create)', async () => {
      const { status } = await request(baseUrl, 'POST', WORKFLOWS_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET / passes (admin has *:* → workflow:read)', async () => {
      const { status } = await request(baseUrl, 'GET', WORKFLOWS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /by-name passes (admin has *:* → workflow:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${WORKFLOWS_BASE}/by-name?name=Test`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id passes (admin has *:* → workflow:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${WORKFLOWS_BASE}/wf-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('PUT /:id passes (admin has *:* → workflow:update)', async () => {
      const { status } = await request(baseUrl, 'PUT', `${WORKFLOWS_BASE}/wf-1`, {
        body: UPDATE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/archive passes (admin has *:* → workflow:delete)', async () => {
      const { status } = await request(baseUrl, 'POST', `${WORKFLOWS_BASE}/wf-1/archive`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/associate-session passes (admin has *:* → workflow:execute)', async () => {
      const { status } = await request(
        baseUrl,
        'POST',
        `${WORKFLOWS_BASE}/wf-1/associate-session`,
        {
          body: ASSOCIATE_BODY,
        },
      );
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Project developer member (OPERATOR tenant role) → developer: workflow:* → all pass
  // ---------------------------------------------------------------------------
  describe('Project developer member', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('OPERATOR', 'proj-dev-user'));
    });
    afterAll(() => server?.close());

    test('POST / passes (developer has workflow:* → workflow:create)', async () => {
      const { status } = await request(baseUrl, 'POST', WORKFLOWS_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET / passes (developer has workflow:* → workflow:read)', async () => {
      const { status } = await request(baseUrl, 'GET', WORKFLOWS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /by-name passes (developer has workflow:* → workflow:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${WORKFLOWS_BASE}/by-name?name=Test`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id passes (developer has workflow:* → workflow:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${WORKFLOWS_BASE}/wf-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('PUT /:id passes (developer has workflow:* → workflow:update)', async () => {
      const { status } = await request(baseUrl, 'PUT', `${WORKFLOWS_BASE}/wf-1`, {
        body: UPDATE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/archive passes (developer has workflow:* → workflow:delete)', async () => {
      const { status } = await request(baseUrl, 'POST', `${WORKFLOWS_BASE}/wf-1/archive`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/associate-session passes (developer has workflow:* → workflow:execute)', async () => {
      const { status } = await request(
        baseUrl,
        'POST',
        `${WORKFLOWS_BASE}/wf-1/associate-session`,
        {
          body: ASSOCIATE_BODY,
        },
      );
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Project viewer member (MEMBER tenant role) → viewer: workflow:read only
  // ---------------------------------------------------------------------------
  describe('Project viewer member', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('MEMBER', 'proj-viewer-user'));
    });
    afterAll(() => server?.close());

    test('GET / passes (viewer has workflow:read)', async () => {
      const { status } = await request(baseUrl, 'GET', WORKFLOWS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /by-name passes (viewer has workflow:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${WORKFLOWS_BASE}/by-name?name=Test`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id passes (viewer has workflow:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${WORKFLOWS_BASE}/wf-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST / returns 403 (viewer lacks workflow:create)', async () => {
      const { status, body } = await request(baseUrl, 'POST', WORKFLOWS_BASE, {
        body: CREATE_BODY,
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('viewer');
      expect(body.message).toContain('workflow:create');
    });

    test('PUT /:id returns 403 (viewer lacks workflow:update)', async () => {
      const { status, body } = await request(baseUrl, 'PUT', `${WORKFLOWS_BASE}/wf-1`, {
        body: UPDATE_BODY,
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('viewer');
      expect(body.message).toContain('workflow:update');
    });

    test('POST /:id/archive returns 403 (viewer lacks workflow:delete)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${WORKFLOWS_BASE}/wf-1/archive`);
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('viewer');
      expect(body.message).toContain('workflow:delete');
    });

    test('POST /:id/associate-session returns 403 (viewer lacks workflow:execute)', async () => {
      const { status, body } = await request(
        baseUrl,
        'POST',
        `${WORKFLOWS_BASE}/wf-1/associate-session`,
        {
          body: ASSOCIATE_BODY,
        },
      );
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('viewer');
      expect(body.message).toContain('workflow:execute');
    });
  });

  // ---------------------------------------------------------------------------
  // Non-member (OPERATOR tenant role, no project membership) → all 404
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
      const { status, body } = await request(baseUrl, 'POST', WORKFLOWS_BASE, {
        body: CREATE_BODY,
      });
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('GET / returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'GET', WORKFLOWS_BASE);
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('GET /by-name returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${WORKFLOWS_BASE}/by-name?name=Test`);
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('GET /:id returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${WORKFLOWS_BASE}/wf-1`);
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('PUT /:id returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'PUT', `${WORKFLOWS_BASE}/wf-1`, {
        body: UPDATE_BODY,
      });
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('POST /:id/archive returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${WORKFLOWS_BASE}/wf-1/archive`);
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('POST /:id/associate-session returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(
        baseUrl,
        'POST',
        `${WORKFLOWS_BASE}/wf-1/associate-session`,
        {
          body: ASSOCIATE_BODY,
        },
      );
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });
  });

  // ---------------------------------------------------------------------------
  // Unauthenticated — no tenant context → all 401
  // ---------------------------------------------------------------------------
  describe('Unauthenticated requests', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createUnauthenticatedServer());
    });
    afterAll(() => server?.close());

    test('POST / returns 401', async () => {
      const { status, body } = await request(baseUrl, 'POST', WORKFLOWS_BASE, {
        body: CREATE_BODY,
      });
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('GET / returns 401', async () => {
      const { status, body } = await request(baseUrl, 'GET', WORKFLOWS_BASE);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('GET /by-name returns 401', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${WORKFLOWS_BASE}/by-name?name=Test`);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('GET /:id returns 401', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${WORKFLOWS_BASE}/wf-1`);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('PUT /:id returns 401', async () => {
      const { status, body } = await request(baseUrl, 'PUT', `${WORKFLOWS_BASE}/wf-1`, {
        body: UPDATE_BODY,
      });
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('POST /:id/archive returns 401', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${WORKFLOWS_BASE}/wf-1/archive`);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('POST /:id/associate-session returns 401', async () => {
      const { status, body } = await request(
        baseUrl,
        'POST',
        `${WORKFLOWS_BASE}/wf-1/associate-session`,
        {
          body: ASSOCIATE_BODY,
        },
      );
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });
  });
});

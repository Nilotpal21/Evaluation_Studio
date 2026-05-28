/**
 * Versions Authorization Tests — Project-Level Object:Operation RBAC
 *
 * Verifies that `requireProjectPermission` enforces project-level permissions
 * on the versions router using object:operation format.
 *
 * Resolution order in requireProjectPermission:
 *   1. Tenant OWNER/ADMIN -> workspace authority (project:* bypass)
 *   2. Project existence -> 404 if not found (tenant isolation)
 *   3. Project owner -> full access (ownerId match)
 *   4. Project member role -> permission check via PROJECT_ROLE_PERMISSIONS
 *   5. No membership -> 403
 *
 * Permission mapping:
 *   POST /                            -> version:create  (admin, developer)
 *   GET  /                            -> version:read    (all project members)
 *   GET  /:version                    -> version:read    (all project members)
 *   POST /:version/promote            -> version:promote (admin, developer)
 *   GET  /:version/diff/:otherVersion -> version:read    (all project members)
 *
 * Project role -> permissions:
 *   admin     -> *:* (all)
 *   developer -> version:* (all version operations)
 *   viewer    -> version:read (read only)
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

// Keep real hasPermission but stub requireProjectScope (API key scoping — tested separately)
vi.mock('@agent-platform/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/shared')>();
  return {
    ...actual,
    requireProjectScope: vi.fn(() => (_req: any, _res: any, next: any) => next()),
    validateAgentName: vi.fn(() => null),
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
  findProjectAgentForProject: vi.fn().mockResolvedValue({
    id: 'agent-1',
    _id: 'agent-1',
    name: 'main',
    dslContent: 'agent main {}',
    agentPath: 'default/main',
    description: null,
    project: { tenantId: 'tenant-A' },
  }),
}));

const mockVersionService = {
  nextVersion: vi.fn().mockResolvedValue('1.0.0'),
  createVersion: vi.fn().mockResolvedValue({
    version: '1.0.0',
    versionId: 'v-1',
    sourceHash: 'abc123',
  }),
  listVersions: vi.fn().mockResolvedValue({ versions: [], total: 0 }),
  getVersion: vi.fn().mockResolvedValue({
    versionId: 'v-1',
    version: '1.0.0',
    status: 'draft',
    sourceHash: 'abc',
    createdAt: new Date().toISOString(),
    createdBy: 'user-1',
  }),
  promoteVersion: vi.fn().mockResolvedValue({
    versionId: 'v-1',
    version: '1.0.0',
    status: 'testing',
    previousStatus: 'draft',
    sourceHash: 'abc',
    createdAt: new Date().toISOString(),
    createdBy: 'user-1',
  }),
  diffVersions: vi.fn().mockResolvedValue({
    version1: '1.0.0',
    version2: '0.1.0',
    dslContent1: 'a',
    dslContent2: 'b',
  }),
};

vi.mock('../../services/version-service.js', () => ({
  getVersionService: vi.fn(() => mockVersionService),
  VersionService: {
    validateChangelog: vi.fn(() => null),
    validateDslContent: vi.fn(() => null),
    isValidStatus: vi.fn(() => true),
  },
}));

vi.mock('../../services/audit-helpers.js', () => ({
  auditVersionCreated: vi.fn(() => Promise.resolve()),
  auditVersionPromoted: vi.fn(() => Promise.resolve()),
  auditVersionDeprecated: vi.fn(() => Promise.resolve()),
}));

// =============================================================================
// IMPORTS — after mocks
// =============================================================================

import express from 'express';
import { makeTenantContext, injectTenantContext } from '../helpers/auth-context.js';
import { findProjectAgentsForProject } from '../../repos/project-repo.js';

// =============================================================================
// HELPERS
// =============================================================================

const VERSIONS_BASE = '/api/projects/proj-1/agents/main/versions';

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
  const versionsRouter = (await import('../../routes/versions.js')).default;
  app.use('/api/projects/:projectId/agents/:agentName/versions', versionsRouter);

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
  const versionsRouter = (await import('../../routes/versions.js')).default;
  app.use('/api/projects/:projectId/agents/:agentName/versions', versionsRouter);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

const CREATE_BODY = { changelog: 'test' };
const PROMOTE_BODY = { targetStatus: 'testing' };

// =============================================================================
// TESTS
// =============================================================================

describe('Versions route authorization — project-level object:operation RBAC', () => {
  describe('Project-aware version creation', () => {
    test('POST / passes sibling agent DSLs to version compilation', async () => {
      mockVersionService.createVersion.mockClear();
      vi.mocked(findProjectAgentsForProject).mockResolvedValueOnce([
        {
          name: 'main',
          dslContent: 'agent main {}',
        },
        {
          name: 'SiblingAgent',
          dslContent: 'AGENT: SiblingAgent\nGOAL: "Handle sibling routing"',
        },
        {
          name: 'DraftWithoutDsl',
        },
      ] as any);

      const { baseUrl, server } = await createServerForUser('OPERATOR', 'proj-dev-user');
      try {
        const { status } = await request(baseUrl, 'POST', VERSIONS_BASE, { body: CREATE_BODY });
        expect(status).toBe(201);
      } finally {
        server.close();
      }

      expect(findProjectAgentsForProject).toHaveBeenCalledWith('proj-1', {
        tenantId: 'tenant-A',
        includeDSLContent: true,
      });
      expect(mockVersionService.createVersion).toHaveBeenLastCalledWith(
        expect.objectContaining({
          agentName: 'main',
          peerDsls: ['AGENT: SiblingAgent\nGOAL: "Handle sibling routing"'],
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Tenant OWNER — *:* includes project:* -> workspace bypass -> all pass
  // ---------------------------------------------------------------------------
  describe('Tenant OWNER (workspace authority)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('OWNER', 'owner-user'));
    });
    afterAll(() => server?.close());

    test('POST / passes (version:create — workspace authority)', async () => {
      const { status } = await request(baseUrl, 'POST', VERSIONS_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET / passes (version:read)', async () => {
      const { status } = await request(baseUrl, 'GET', VERSIONS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:version passes (version:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${VERSIONS_BASE}/1.0.0`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:version/promote passes (version:promote)', async () => {
      const { status } = await request(baseUrl, 'POST', `${VERSIONS_BASE}/1.0.0/promote`, {
        body: PROMOTE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:version/diff/:otherVersion passes (version:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${VERSIONS_BASE}/1.0.0/diff/0.1.0`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Tenant ADMIN — project:* -> workspace bypass -> all pass
  // ---------------------------------------------------------------------------
  describe('Tenant ADMIN (workspace authority)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('ADMIN', 'admin-user'));
    });
    afterAll(() => server?.close());

    test('POST / passes (version:create — workspace authority)', async () => {
      const { status } = await request(baseUrl, 'POST', VERSIONS_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET / passes (version:read)', async () => {
      const { status } = await request(baseUrl, 'GET', VERSIONS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:version passes (version:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${VERSIONS_BASE}/1.0.0`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:version/promote passes (version:promote)', async () => {
      const { status } = await request(baseUrl, 'POST', `${VERSIONS_BASE}/1.0.0/promote`, {
        body: PROMOTE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:version/diff/:otherVersion passes (version:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${VERSIONS_BASE}/1.0.0/diff/0.1.0`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Project owner (OPERATOR tenant role) — ownerId match -> full access
  // ---------------------------------------------------------------------------
  describe('Project owner (ownerId match)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('OPERATOR', 'project-owner'));
    });
    afterAll(() => server?.close());

    test('POST / passes (version:create — project owner)', async () => {
      const { status } = await request(baseUrl, 'POST', VERSIONS_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET / passes (version:read)', async () => {
      const { status } = await request(baseUrl, 'GET', VERSIONS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:version passes (version:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${VERSIONS_BASE}/1.0.0`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:version/promote passes (version:promote)', async () => {
      const { status } = await request(baseUrl, 'POST', `${VERSIONS_BASE}/1.0.0/promote`, {
        body: PROMOTE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:version/diff/:otherVersion passes (version:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${VERSIONS_BASE}/1.0.0/diff/0.1.0`);
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

    test('POST / passes (admin has *:* -> version:create)', async () => {
      const { status } = await request(baseUrl, 'POST', VERSIONS_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET / passes (admin has *:* -> version:read)', async () => {
      const { status } = await request(baseUrl, 'GET', VERSIONS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:version passes (admin has *:* -> version:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${VERSIONS_BASE}/1.0.0`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:version/promote passes (admin has *:* -> version:promote)', async () => {
      const { status } = await request(baseUrl, 'POST', `${VERSIONS_BASE}/1.0.0/promote`, {
        body: PROMOTE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:version/diff/:otherVersion passes (admin has *:* -> version:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${VERSIONS_BASE}/1.0.0/diff/0.1.0`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Project developer member (OPERATOR tenant role) -> developer: version:* -> all pass
  // ---------------------------------------------------------------------------
  describe('Project developer member', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('OPERATOR', 'proj-dev-user'));
    });
    afterAll(() => server?.close());

    test('POST / passes (developer has version:* -> version:create)', async () => {
      const { status } = await request(baseUrl, 'POST', VERSIONS_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET / passes (developer has version:* -> version:read)', async () => {
      const { status } = await request(baseUrl, 'GET', VERSIONS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:version passes (developer has version:* -> version:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${VERSIONS_BASE}/1.0.0`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:version/promote passes (developer has version:* -> version:promote)', async () => {
      const { status } = await request(baseUrl, 'POST', `${VERSIONS_BASE}/1.0.0/promote`, {
        body: PROMOTE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:version/diff/:otherVersion passes (developer has version:* -> version:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${VERSIONS_BASE}/1.0.0/diff/0.1.0`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Project viewer member (MEMBER tenant role) -> viewer: version:read only
  // ---------------------------------------------------------------------------
  describe('Project viewer member', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('MEMBER', 'proj-viewer-user'));
    });
    afterAll(() => server?.close());

    test('GET / passes (viewer has version:read)', async () => {
      const { status } = await request(baseUrl, 'GET', VERSIONS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:version passes (viewer has version:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${VERSIONS_BASE}/1.0.0`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:version/diff/:otherVersion passes (viewer has version:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${VERSIONS_BASE}/1.0.0/diff/0.1.0`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST / returns 403 (viewer lacks version:create)', async () => {
      const { status, body } = await request(baseUrl, 'POST', VERSIONS_BASE, { body: CREATE_BODY });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('viewer');
      expect(body.message).toContain('version:create');
    });

    test('POST /:version/promote returns 403 (viewer lacks version:promote)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${VERSIONS_BASE}/1.0.0/promote`, {
        body: PROMOTE_BODY,
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('viewer');
      expect(body.message).toContain('version:promote');
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
      const { status, body } = await request(baseUrl, 'POST', VERSIONS_BASE, { body: CREATE_BODY });
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('GET / returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'GET', VERSIONS_BASE);
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('GET /:version returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${VERSIONS_BASE}/1.0.0`);
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('POST /:version/promote returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${VERSIONS_BASE}/1.0.0/promote`, {
        body: PROMOTE_BODY,
      });
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('GET /:version/diff/:otherVersion returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${VERSIONS_BASE}/1.0.0/diff/0.1.0`);
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });
  });

  // ---------------------------------------------------------------------------
  // Unauthenticated — no tenant context -> all 401
  // ---------------------------------------------------------------------------
  describe('Unauthenticated requests', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createUnauthenticatedServer());
    });
    afterAll(() => server?.close());

    test('POST / returns 401', async () => {
      const { status, body } = await request(baseUrl, 'POST', VERSIONS_BASE, { body: CREATE_BODY });
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('GET / returns 401', async () => {
      const { status, body } = await request(baseUrl, 'GET', VERSIONS_BASE);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('GET /:version returns 401', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${VERSIONS_BASE}/1.0.0`);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('POST /:version/promote returns 401', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${VERSIONS_BASE}/1.0.0/promote`, {
        body: PROMOTE_BODY,
      });
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('GET /:version/diff/:otherVersion returns 401', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${VERSIONS_BASE}/1.0.0/diff/0.1.0`);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });
  });
});

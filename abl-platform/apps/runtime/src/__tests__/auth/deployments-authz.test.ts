/**
 * Deployments Authorization Tests — Project-Level Object:Operation RBAC
 *
 * Verifies that `requireProjectPermission` enforces project-level permissions
 * on the deployments router using object:operation format.
 *
 * Resolution order in requireProjectPermission:
 *   1. Tenant OWNER/ADMIN → workspace authority (project:* bypass)
 *   2. Project existence → 404 if not found (tenant isolation)
 *   3. Project owner → full access (ownerId match)
 *   4. Project member role → permission check via PROJECT_ROLE_PERMISSIONS
 *   5. No membership → 403
 *
 * Permission mapping:
 *   POST /                       → deployment:create  (admin only)
 *   GET  /                       → deployment:read    (all project members)
 *   GET  /:id                    → deployment:read    (all project members)
 *   POST /:id/retire             → deployment:retire  (admin only)
 *   POST /:id/rollback           → deployment:create  (admin only)
 *   POST /:id/promote            → deployment:create  (admin only)
 *
 * Project role → permissions:
 *   admin     → *:* (all)
 *   developer → deployment:read (read only)
 *   viewer    → deployment:read (read only)
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
  };
});

vi.mock('@agent-platform/shared-auth', () => ({
  requireAuth: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  getRequestAccessDeniedReporter: vi.fn(() => vi.fn()),
  requireProjectScope: vi
    .fn()
    .mockImplementation(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../services/preflight-validation-service.js', () => ({
  runPreflightValidation: vi.fn().mockResolvedValue({ status: 'ready', checks: [] }),
}));

vi.mock('../../services/snapshot-service.js', () => ({
  createDeploymentSnapshot: vi.fn().mockResolvedValue({ id: 'snap-1', _id: 'snap-1' }),
}));

vi.mock('@agent-platform/database/models', () => ({
  DeploymentVariableSnapshot: { deleteOne: vi.fn() },
  Deployment: { updateOne: vi.fn().mockResolvedValue({}) },
}));

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
  findProjectAgentsForProject: vi.fn().mockResolvedValue([
    {
      id: 'agent-1',
      _id: 'agent-1',
      name: 'main',
      dslContent: 'agent main {}',
    },
  ]),
  findAgentVersion: vi.fn().mockResolvedValue({
    id: 'ver-1',
    _id: 'ver-1',
    version: '1.0.0',
    irContent: '{}',
  }),
  loadConfigVariablesMap: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock('../../repos/deployment-repo.js', () => ({
  findActiveDeployment: vi.fn().mockResolvedValue(null),
  findDeploymentById: vi.fn().mockResolvedValue({
    id: 'dep-1',
    _id: 'dep-1',
    projectId: 'proj-1',
    tenantId: 'tenant-A',
    environment: 'dev',
    status: 'active',
    label: null,
    description: null,
    endpointSlug: 'test-slug',
    entryAgentName: 'main',
    agentVersionManifest: { main: '1.0.0' },
    previousDeploymentId: 'dep-0',
    compilationHash: null,
    modelOverrides: null,
  }),
  listDeployments: vi.fn().mockResolvedValue([]),
  createDeployment: vi
    .fn()
    .mockImplementation((data) => Promise.resolve({ id: 'dep-new', ...data })),
  updateDeploymentStatus: vi
    .fn()
    .mockImplementation((_id, data) =>
      Promise.resolve({ id: 'dep-1', status: data.status ?? 'active' }),
    ),
  countLinkedChannels: vi.fn().mockResolvedValue(0),
  retirePreviousActiveDeployment: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../repos/channel-repo.js', () => ({
  bulkUpdateChannelDeployment: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../services/version-service.js', () => ({
  getVersionService: vi.fn(() => ({
    nextVersion: vi.fn().mockResolvedValue('1.0.0'),
    createVersion: vi
      .fn()
      .mockResolvedValue({ version: '1.0.0', versionId: 'v-1', sourceHash: 'abc' }),
  })),
  VersionService: {
    validateChangelog: vi.fn(() => null),
    validateDslContent: vi.fn(() => null),
    isValidStatus: vi.fn(() => true),
  },
}));

vi.mock('../../repos/security-repo.js', () => ({
  findEnvironmentVariables: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../services/session/session-service.js', () => ({
  getSessionService: vi.fn(() => ({
    cacheCompilationOutput: vi.fn().mockResolvedValue('hash-1'),
    cacheAgentIR: vi.fn().mockResolvedValue(undefined),
  })),
}));

// =============================================================================
// IMPORTS — after mocks
// =============================================================================

import express from 'express';
import { makeTenantContext, injectTenantContext } from '../helpers/auth-context.js';

// =============================================================================
// HELPERS
// =============================================================================

const DEPLOYS_BASE = '/api/projects/proj-1/deployments';
const { default: deploymentsRouter } = await import('../../routes/deployments.js');

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

async function createServerForUser(
  tenantRole: 'OWNER' | 'ADMIN' | 'OPERATOR' | 'MEMBER' | 'VIEWER',
  userId: string,
) {
  const app = express();
  app.use(express.json());
  const ctx = makeTenantContext('tenant-A', userId, tenantRole);
  app.use(injectTenantContext(ctx));
  app.use('/api/projects/:projectId/deployments', deploymentsRouter);

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
  app.use('/api/projects/:projectId/deployments', deploymentsRouter);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

const CREATE_BODY = {
  environment: 'dev',
  agentVersionManifest: { main: '1.0.0' },
  entryAgentName: 'main',
};

const RETIRE_BODY = { force: true };

const PROMOTE_BODY = { targetEnvironment: 'staging' };

// =============================================================================
// TESTS
// =============================================================================

describe('Deployments route authorization — project-level object:operation RBAC', () => {
  // ---------------------------------------------------------------------------
  // Tenant OWNER — *:* includes project:* → workspace bypass → all pass
  // ---------------------------------------------------------------------------
  describe('Tenant OWNER (workspace authority)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('OWNER', 'owner-user'));
    });
    afterAll(() => closeServer(server));

    test('POST / passes (deployment:create — workspace authority)', async () => {
      const { status } = await request(baseUrl, 'POST', DEPLOYS_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET / passes (deployment:read)', async () => {
      const { status } = await request(baseUrl, 'GET', DEPLOYS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id passes (deployment:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${DEPLOYS_BASE}/dep-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/retire passes (deployment:retire)', async () => {
      const { status } = await request(baseUrl, 'POST', `${DEPLOYS_BASE}/dep-1/retire`, {
        body: RETIRE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/rollback passes (deployment:create)', async () => {
      const { status } = await request(baseUrl, 'POST', `${DEPLOYS_BASE}/dep-1/rollback`, {
        body: {},
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/promote passes (deployment:create)', async () => {
      const { status } = await request(baseUrl, 'POST', `${DEPLOYS_BASE}/dep-1/promote`, {
        body: PROMOTE_BODY,
      });
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
    afterAll(() => closeServer(server));

    test('POST / passes (deployment:create — workspace authority)', async () => {
      const { status } = await request(baseUrl, 'POST', DEPLOYS_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET / passes (deployment:read)', async () => {
      const { status } = await request(baseUrl, 'GET', DEPLOYS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id passes (deployment:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${DEPLOYS_BASE}/dep-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/retire passes (deployment:retire)', async () => {
      const { status } = await request(baseUrl, 'POST', `${DEPLOYS_BASE}/dep-1/retire`, {
        body: RETIRE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/rollback passes (deployment:create)', async () => {
      const { status } = await request(baseUrl, 'POST', `${DEPLOYS_BASE}/dep-1/rollback`, {
        body: {},
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/promote passes (deployment:create)', async () => {
      const { status } = await request(baseUrl, 'POST', `${DEPLOYS_BASE}/dep-1/promote`, {
        body: PROMOTE_BODY,
      });
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
    afterAll(() => closeServer(server));

    test('POST / passes (deployment:create — project owner)', async () => {
      const { status } = await request(baseUrl, 'POST', DEPLOYS_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET / passes (deployment:read)', async () => {
      const { status } = await request(baseUrl, 'GET', DEPLOYS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id passes (deployment:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${DEPLOYS_BASE}/dep-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/retire passes (deployment:retire)', async () => {
      const { status } = await request(baseUrl, 'POST', `${DEPLOYS_BASE}/dep-1/retire`, {
        body: RETIRE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/rollback passes (deployment:create)', async () => {
      const { status } = await request(baseUrl, 'POST', `${DEPLOYS_BASE}/dep-1/rollback`, {
        body: {},
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/promote passes (deployment:create)', async () => {
      const { status } = await request(baseUrl, 'POST', `${DEPLOYS_BASE}/dep-1/promote`, {
        body: PROMOTE_BODY,
      });
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
    afterAll(() => closeServer(server));

    test('POST / passes (admin has *:* → deployment:create)', async () => {
      const { status } = await request(baseUrl, 'POST', DEPLOYS_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET / passes (admin has *:* → deployment:read)', async () => {
      const { status } = await request(baseUrl, 'GET', DEPLOYS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id passes (admin has *:* → deployment:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${DEPLOYS_BASE}/dep-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/retire passes (admin has *:* → deployment:retire)', async () => {
      const { status } = await request(baseUrl, 'POST', `${DEPLOYS_BASE}/dep-1/retire`, {
        body: RETIRE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/rollback passes (admin has *:* → deployment:create)', async () => {
      const { status } = await request(baseUrl, 'POST', `${DEPLOYS_BASE}/dep-1/rollback`, {
        body: {},
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/promote passes (admin has *:* → deployment:create)', async () => {
      const { status } = await request(baseUrl, 'POST', `${DEPLOYS_BASE}/dep-1/promote`, {
        body: PROMOTE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Project developer member (OPERATOR tenant role) → developer: deployment:read only
  // ---------------------------------------------------------------------------
  describe('Project developer member', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('OPERATOR', 'proj-dev-user'));
    });
    afterAll(() => closeServer(server));

    test('GET / passes (developer has deployment:read)', async () => {
      const { status } = await request(baseUrl, 'GET', DEPLOYS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id passes (developer has deployment:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${DEPLOYS_BASE}/dep-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST / returns 403 (developer lacks deployment:create)', async () => {
      const { status, body } = await request(baseUrl, 'POST', DEPLOYS_BASE, { body: CREATE_BODY });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('developer');
      expect(body.message).toContain('deployment:create');
    });

    test('POST /:id/retire returns 403 (developer lacks deployment:retire)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${DEPLOYS_BASE}/dep-1/retire`, {
        body: RETIRE_BODY,
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('developer');
      expect(body.message).toContain('deployment:retire');
    });

    test('POST /:id/rollback returns 403 (developer lacks deployment:create)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${DEPLOYS_BASE}/dep-1/rollback`, {
        body: {},
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('developer');
      expect(body.message).toContain('deployment:create');
    });

    test('POST /:id/promote returns 403 (developer lacks deployment:create)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${DEPLOYS_BASE}/dep-1/promote`, {
        body: PROMOTE_BODY,
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('developer');
      expect(body.message).toContain('deployment:create');
    });
  });

  // ---------------------------------------------------------------------------
  // Project viewer member (MEMBER tenant role) → viewer: deployment:read only
  // ---------------------------------------------------------------------------
  describe('Project viewer member', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('MEMBER', 'proj-viewer-user'));
    });
    afterAll(() => closeServer(server));

    test('GET / passes (viewer has deployment:read)', async () => {
      const { status } = await request(baseUrl, 'GET', DEPLOYS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id passes (viewer has deployment:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${DEPLOYS_BASE}/dep-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST / returns 403 (viewer lacks deployment:create)', async () => {
      const { status, body } = await request(baseUrl, 'POST', DEPLOYS_BASE, { body: CREATE_BODY });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('viewer');
    });

    test('POST /:id/retire returns 403 (viewer lacks deployment:retire)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${DEPLOYS_BASE}/dep-1/retire`, {
        body: RETIRE_BODY,
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('viewer');
    });

    test('POST /:id/rollback returns 403 (viewer lacks deployment:create)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${DEPLOYS_BASE}/dep-1/rollback`, {
        body: {},
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('viewer');
    });

    test('POST /:id/promote returns 403 (viewer lacks deployment:create)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${DEPLOYS_BASE}/dep-1/promote`, {
        body: PROMOTE_BODY,
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('viewer');
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
    afterAll(() => closeServer(server));

    test('GET / returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'GET', DEPLOYS_BASE);
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('GET /:id returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${DEPLOYS_BASE}/dep-1`);
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('POST / returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'POST', DEPLOYS_BASE, { body: CREATE_BODY });
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('POST /:id/retire returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${DEPLOYS_BASE}/dep-1/retire`, {
        body: RETIRE_BODY,
      });
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('POST /:id/rollback returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${DEPLOYS_BASE}/dep-1/rollback`, {
        body: {},
      });
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('POST /:id/promote returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${DEPLOYS_BASE}/dep-1/promote`, {
        body: PROMOTE_BODY,
      });
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
    afterAll(() => closeServer(server));

    test('POST / returns 401', async () => {
      const { status, body } = await request(baseUrl, 'POST', DEPLOYS_BASE, { body: CREATE_BODY });
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('GET / returns 401', async () => {
      const { status, body } = await request(baseUrl, 'GET', DEPLOYS_BASE);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('GET /:id returns 401', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${DEPLOYS_BASE}/dep-1`);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('POST /:id/retire returns 401', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${DEPLOYS_BASE}/dep-1/retire`, {
        body: RETIRE_BODY,
      });
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('POST /:id/rollback returns 401', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${DEPLOYS_BASE}/dep-1/rollback`, {
        body: {},
      });
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('POST /:id/promote returns 401', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${DEPLOYS_BASE}/dep-1/promote`, {
        body: PROMOTE_BODY,
      });
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });
  });
});

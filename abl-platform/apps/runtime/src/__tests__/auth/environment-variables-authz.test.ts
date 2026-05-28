/**
 * Environment Variables Authorization Tests — Project-Level Object:Operation RBAC
 *
 * Verifies that `requireProjectPermission` enforces project-level permissions
 * on the environment variables router using object:operation format.
 *
 * Resolution order in requireProjectPermission:
 *   1. Tenant OWNER/ADMIN → workspace authority (project:* bypass)
 *   2. Project existence → 404 if not found (tenant isolation)
 *   3. Project owner → full access (ownerId match)
 *   4. Project member role → permission check via PROJECT_ROLE_PERMISSIONS
 *   5. No membership → 403
 *
 * Permission mapping:
 *   POST /              → env_var:create  (admin only)
 *   GET  /?environment= → env_var:read    (all project members)
 *   GET  /:id/value     → env_var:read    (all project members)
 *   PUT  /:id           → env_var:update  (admin only)
 *   DELETE /:id         → env_var:delete  (admin only)
 *   POST /copy          → env_var:create  (admin only)
 *   POST /validate      → env_var:read    (all project members)
 *
 * Project role → permissions:
 *   admin     → *:* (all)
 *   developer → env_var:read (read only)
 *   viewer    → env_var:read (read only)
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
  findProjectAgentsForProject: vi.fn().mockResolvedValue([]),
  findLatestAgentVersion: vi.fn().mockResolvedValue(null),
}));

vi.mock('@agent-platform/shared/encryption', () => ({
  getEncryptionService: vi.fn(() => ({
    encryptForTenant: vi.fn(() => 'encrypted-value'),
    decryptForTenant: vi.fn(() => 'decrypted-value'),
  })),
  isEncryptionAvailable: vi.fn(() => true),
}));

vi.mock('../../repos/security-repo.js', () => ({
  createEnvironmentVariable: vi.fn().mockResolvedValue({
    _id: 'ev-1',
    key: 'TEST_KEY',
    environment: 'dev',
    isSecret: false,
    description: null,
    createdAt: new Date().toISOString(),
  }),
  findEnvironmentVariables: vi.fn().mockResolvedValue([]),
  countEnvironmentVariables: vi.fn().mockResolvedValue(0),
  findEnvironmentVariableById: vi.fn().mockResolvedValue({
    _id: 'ev-1',
    key: 'TEST_KEY',
    environment: 'dev',
    encryptedValue: 'encrypted',
    isSecret: false,
    description: null,
  }),
  findEnvironmentVariableByKey: vi.fn().mockResolvedValue(null),
  updateEnvironmentVariable: vi.fn().mockResolvedValue({
    _id: 'ev-1',
    key: 'TEST_KEY',
    environment: 'dev',
    isSecret: false,
    description: null,
    updatedAt: new Date().toISOString(),
  }),
  deleteEnvironmentVariable: vi.fn().mockResolvedValue(true),
  bulkUpsertEnvironmentVariables: vi.fn().mockResolvedValue({ upserted: 0, matched: 0 }),
}));

vi.mock('../../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock('../../repos/variable-namespace-membership-repo.js', () => ({
  addVariableNamespaceMemberships: vi.fn().mockResolvedValue(undefined),
  deleteAllVariableNamespaceMembershipsForVariable: vi.fn().mockResolvedValue(undefined),
  findVariableNamespaceMembershipsByVariableIds: vi.fn().mockResolvedValue(new Map()),
  findVariableNamespaceMembershipsByVariable: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../repos/variable-namespace-repo.js', () => ({
  findDefaultVariableNamespace: vi.fn().mockResolvedValue(null),
  getOrCreateDefaultNamespace: vi.fn().mockResolvedValue({ _id: 'default-ns' }),
  findVariableNamespaces: vi.fn().mockResolvedValue([]),
  findVariableNamespaceById: vi.fn().mockResolvedValue({
    _id: 'default-ns',
    projectId: 'proj-1',
  }),
}));

// =============================================================================
// IMPORTS — after mocks
// =============================================================================

import express from 'express';
import { makeTenantContext, injectTenantContext } from '../helpers/auth-context.js';

// =============================================================================
// HELPERS
// =============================================================================

const ENV_VARS_BASE = '/api/projects/proj-1/env-vars';

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
  const envVarsRouter = (await import('../../routes/environment-variables.js')).default;
  app.use('/api/projects/:projectId/env-vars', envVarsRouter);

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
  const envVarsRouter = (await import('../../routes/environment-variables.js')).default;
  app.use('/api/projects/:projectId/env-vars', envVarsRouter);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

const CREATE_BODY = { environment: 'dev', key: 'TEST_KEY', value: 'test-value' };
const UPDATE_BODY = { value: 'new-value' };
const COPY_BODY = { sourceEnvironment: 'dev', targetEnvironment: 'staging' };
const VALIDATE_BODY = { environment: 'dev' };

// =============================================================================
// TESTS
// =============================================================================

describe('Environment Variables route authorization — project-level object:operation RBAC', () => {
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

    test('POST / passes (env_var:create — workspace authority)', async () => {
      const { status } = await request(baseUrl, 'POST', ENV_VARS_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /?environment=dev passes (env_var:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${ENV_VARS_BASE}?environment=dev`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('PUT /:id passes (env_var:update)', async () => {
      const { status } = await request(baseUrl, 'PUT', `${ENV_VARS_BASE}/ev-1`, {
        body: UPDATE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('DELETE /:id passes (env_var:delete)', async () => {
      const { status } = await request(baseUrl, 'DELETE', `${ENV_VARS_BASE}/ev-1`);
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

    test('POST / passes (env_var:create — workspace authority)', async () => {
      const { status } = await request(baseUrl, 'POST', ENV_VARS_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /?environment=dev passes (env_var:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${ENV_VARS_BASE}?environment=dev`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('PUT /:id passes (env_var:update)', async () => {
      const { status } = await request(baseUrl, 'PUT', `${ENV_VARS_BASE}/ev-1`, {
        body: UPDATE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('DELETE /:id passes (env_var:delete)', async () => {
      const { status } = await request(baseUrl, 'DELETE', `${ENV_VARS_BASE}/ev-1`);
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

    test('POST / passes (env_var:create — project owner)', async () => {
      const { status } = await request(baseUrl, 'POST', ENV_VARS_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /?environment=dev passes (env_var:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${ENV_VARS_BASE}?environment=dev`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('PUT /:id passes (env_var:update)', async () => {
      const { status } = await request(baseUrl, 'PUT', `${ENV_VARS_BASE}/ev-1`, {
        body: UPDATE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('DELETE /:id passes (env_var:delete)', async () => {
      const { status } = await request(baseUrl, 'DELETE', `${ENV_VARS_BASE}/ev-1`);
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

    test('POST / passes (admin has *:* → env_var:create)', async () => {
      const { status } = await request(baseUrl, 'POST', ENV_VARS_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /?environment=dev passes (admin has *:* → env_var:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${ENV_VARS_BASE}?environment=dev`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('PUT /:id passes (admin has *:* → env_var:update)', async () => {
      const { status } = await request(baseUrl, 'PUT', `${ENV_VARS_BASE}/ev-1`, {
        body: UPDATE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('DELETE /:id passes (admin has *:* → env_var:delete)', async () => {
      const { status } = await request(baseUrl, 'DELETE', `${ENV_VARS_BASE}/ev-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Project developer member (OPERATOR tenant role) → developer: env_var:read only
  // ---------------------------------------------------------------------------
  describe('Project developer member', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('OPERATOR', 'proj-dev-user'));
    });
    afterAll(() => server?.close());

    test('GET /?environment=dev passes (developer has env_var:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${ENV_VARS_BASE}?environment=dev`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST / returns 403 (developer lacks env_var:create)', async () => {
      const { status, body } = await request(baseUrl, 'POST', ENV_VARS_BASE, {
        body: CREATE_BODY,
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('developer');
      expect(body.message).toContain('env_var:create');
    });

    test('PUT /:id returns 403 (developer lacks env_var:update)', async () => {
      const { status, body } = await request(baseUrl, 'PUT', `${ENV_VARS_BASE}/ev-1`, {
        body: UPDATE_BODY,
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('developer');
      expect(body.message).toContain('env_var:update');
    });

    test('DELETE /:id returns 403 (developer lacks env_var:delete)', async () => {
      const { status, body } = await request(baseUrl, 'DELETE', `${ENV_VARS_BASE}/ev-1`);
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('developer');
      expect(body.message).toContain('env_var:delete');
    });
  });

  // ---------------------------------------------------------------------------
  // Project viewer member (MEMBER tenant role) → viewer: env_var:read only
  // ---------------------------------------------------------------------------
  describe('Project viewer member', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('MEMBER', 'proj-viewer-user'));
    });
    afterAll(() => server?.close());

    test('GET /?environment=dev passes (viewer has env_var:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${ENV_VARS_BASE}?environment=dev`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST / returns 403 (viewer lacks env_var:create)', async () => {
      const { status, body } = await request(baseUrl, 'POST', ENV_VARS_BASE, {
        body: CREATE_BODY,
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('viewer');
    });

    test('PUT /:id returns 403 (viewer lacks env_var:update)', async () => {
      const { status, body } = await request(baseUrl, 'PUT', `${ENV_VARS_BASE}/ev-1`, {
        body: UPDATE_BODY,
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('viewer');
    });

    test('DELETE /:id returns 403 (viewer lacks env_var:delete)', async () => {
      const { status, body } = await request(baseUrl, 'DELETE', `${ENV_VARS_BASE}/ev-1`);
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
    afterAll(() => server?.close());

    test('GET /?environment=dev returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${ENV_VARS_BASE}?environment=dev`);
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('POST / returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'POST', ENV_VARS_BASE, {
        body: CREATE_BODY,
      });
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('PUT /:id returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'PUT', `${ENV_VARS_BASE}/ev-1`, {
        body: UPDATE_BODY,
      });
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('DELETE /:id returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'DELETE', `${ENV_VARS_BASE}/ev-1`);
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
      const { status, body } = await request(baseUrl, 'POST', ENV_VARS_BASE, {
        body: CREATE_BODY,
      });
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('GET /?environment=dev returns 401', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${ENV_VARS_BASE}?environment=dev`);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('PUT /:id returns 401', async () => {
      const { status, body } = await request(baseUrl, 'PUT', `${ENV_VARS_BASE}/ev-1`, {
        body: UPDATE_BODY,
      });
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('DELETE /:id returns 401', async () => {
      const { status, body } = await request(baseUrl, 'DELETE', `${ENV_VARS_BASE}/ev-1`);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });
  });
});

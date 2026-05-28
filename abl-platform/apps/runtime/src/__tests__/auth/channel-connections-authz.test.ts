/**
 * Channel Connections Authorization Tests — Project-Level Object:Operation RBAC
 *
 * Verifies that `requireProjectPermission` enforces project-level permissions
 * on the channel-connections router using object:operation format.
 *
 * Resolution order in requireProjectPermission:
 *   1. Tenant OWNER/ADMIN -> workspace authority (project:* bypass)
 *   2. Project existence -> 404 if not found (tenant isolation)
 *   3. Project owner -> full access (ownerId match)
 *   4. Project member role -> permission check via PROJECT_ROLE_PERMISSIONS
 *   5. No membership -> 403
 *
 * Permission mapping:
 *   POST   /          -> channel_connection:create  (admin/developer)
 *   GET    /          -> channel_connection:read     (all project members)
 *   GET    /:id       -> channel_connection:read     (all project members)
 *   PATCH  /:id       -> channel_connection:update   (admin/developer)
 *   DELETE /:id       -> channel_connection:delete   (admin/developer)
 *
 * Project role -> permissions:
 *   admin     -> *:* (all)
 *   developer -> channel_connection:* (all)
 *   viewer    -> channel_connection:read (read only)
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

vi.mock('../../repos/deployment-repo.js', () => ({
  findDeploymentById: vi.fn().mockResolvedValue({
    _id: 'deploy-1',
    projectId: 'proj-1',
    tenantId: 'tenant-A',
  }),
}));

vi.mock('@agent-platform/shared/encryption', () => ({
  getEncryptionService: vi.fn(() => ({
    encryptForTenant: vi.fn(() => 'encrypted'),
    decryptForTenant: vi.fn(() => 'decrypted'),
  })),
  isEncryptionAvailable: vi.fn(() => true),
}));

vi.mock('@agent-platform/database/models', () => ({
  ChannelConnection: {
    create: vi.fn().mockResolvedValue({
      _id: 'cc-1',
      tenantId: 'tenant-A',
      projectId: 'proj-1',
      channelType: 'slack',
      displayName: null,
      externalIdentifier: 'test-workspace',
      encryptedCredentials: 'encrypted',
      config: {},
      status: 'active',
      deploymentId: null,
      environment: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    find: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([]),
      }),
    }),
    findOne: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'cc-1',
        tenantId: 'tenant-A',
        projectId: 'proj-1',
        channelType: 'slack',
        displayName: null,
        externalIdentifier: 'test-workspace',
        encryptedCredentials: 'encrypted',
        config: {},
        status: 'active',
        deploymentId: null,
        environment: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    }),
    findOneAndUpdate: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'cc-1',
        tenantId: 'tenant-A',
        projectId: 'proj-1',
        channelType: 'slack',
        displayName: 'Updated',
        externalIdentifier: 'test-workspace',
        encryptedCredentials: 'encrypted',
        config: {},
        status: 'active',
        deploymentId: null,
        environment: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    }),
  },
}));

// =============================================================================
// IMPORTS — after mocks
// =============================================================================

import express from 'express';
import { makeTenantContext, injectTenantContext } from '../helpers/auth-context.js';

// =============================================================================
// HELPERS
// =============================================================================

const CC_BASE = '/api/projects/proj-1/channel-connections';

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
  const ccRouter = (await import('../../routes/channel-connections.js')).default;
  app.use('/api/projects/:projectId/channel-connections', ccRouter);

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
  const ccRouter = (await import('../../routes/channel-connections.js')).default;
  app.use('/api/projects/:projectId/channel-connections', ccRouter);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

const CREATE_BODY = {
  channel_type: 'slack',
  external_identifier: 'test-workspace',
  credentials: { bot_token: 'xoxb-test-token', signing_secret: 'secret123' },
};
const PATCH_BODY = { display_name: 'Updated Name' };

// =============================================================================
// TESTS
// =============================================================================

describe('Channel Connections route authorization — project-level object:operation RBAC', () => {
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

    test('POST / passes (channel_connection:create — workspace authority)', async () => {
      const { status } = await request(baseUrl, 'POST', CC_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET / passes (channel_connection:read)', async () => {
      const { status } = await request(baseUrl, 'GET', CC_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id passes (channel_connection:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${CC_BASE}/cc-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('PATCH /:id passes (channel_connection:update)', async () => {
      const { status } = await request(baseUrl, 'PATCH', `${CC_BASE}/cc-1`, {
        body: PATCH_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('DELETE /:id passes (channel_connection:delete)', async () => {
      const { status } = await request(baseUrl, 'DELETE', `${CC_BASE}/cc-1`);
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

    test('POST / passes (channel_connection:create — workspace authority)', async () => {
      const { status } = await request(baseUrl, 'POST', CC_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET / passes (channel_connection:read)', async () => {
      const { status } = await request(baseUrl, 'GET', CC_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id passes (channel_connection:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${CC_BASE}/cc-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('PATCH /:id passes (channel_connection:update)', async () => {
      const { status } = await request(baseUrl, 'PATCH', `${CC_BASE}/cc-1`, {
        body: PATCH_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('DELETE /:id passes (channel_connection:delete)', async () => {
      const { status } = await request(baseUrl, 'DELETE', `${CC_BASE}/cc-1`);
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

    test('POST / passes (channel_connection:create — project owner)', async () => {
      const { status } = await request(baseUrl, 'POST', CC_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET / passes (channel_connection:read)', async () => {
      const { status } = await request(baseUrl, 'GET', CC_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id passes (channel_connection:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${CC_BASE}/cc-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('PATCH /:id passes (channel_connection:update)', async () => {
      const { status } = await request(baseUrl, 'PATCH', `${CC_BASE}/cc-1`, {
        body: PATCH_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('DELETE /:id passes (channel_connection:delete)', async () => {
      const { status } = await request(baseUrl, 'DELETE', `${CC_BASE}/cc-1`);
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

    test('POST / passes (admin has *:* -> channel_connection:create)', async () => {
      const { status } = await request(baseUrl, 'POST', CC_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET / passes (admin has *:* -> channel_connection:read)', async () => {
      const { status } = await request(baseUrl, 'GET', CC_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id passes (admin has *:* -> channel_connection:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${CC_BASE}/cc-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('PATCH /:id passes (admin has *:* -> channel_connection:update)', async () => {
      const { status } = await request(baseUrl, 'PATCH', `${CC_BASE}/cc-1`, {
        body: PATCH_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('DELETE /:id passes (admin has *:* -> channel_connection:delete)', async () => {
      const { status } = await request(baseUrl, 'DELETE', `${CC_BASE}/cc-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Project developer member (OPERATOR tenant role) -> developer: channel_connection:* -> all pass
  // ---------------------------------------------------------------------------
  describe('Project developer member', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('OPERATOR', 'proj-dev-user'));
    });
    afterAll(() => server?.close());

    test('POST / passes (developer has channel_connection:*)', async () => {
      const { status } = await request(baseUrl, 'POST', CC_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET / passes (developer has channel_connection:*)', async () => {
      const { status } = await request(baseUrl, 'GET', CC_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id passes (developer has channel_connection:*)', async () => {
      const { status } = await request(baseUrl, 'GET', `${CC_BASE}/cc-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('PATCH /:id passes (developer has channel_connection:*)', async () => {
      const { status } = await request(baseUrl, 'PATCH', `${CC_BASE}/cc-1`, {
        body: PATCH_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('DELETE /:id passes (developer has channel_connection:*)', async () => {
      const { status } = await request(baseUrl, 'DELETE', `${CC_BASE}/cc-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Project viewer member (MEMBER tenant role) -> viewer: channel_connection:read only
  // ---------------------------------------------------------------------------
  describe('Project viewer member', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('MEMBER', 'proj-viewer-user'));
    });
    afterAll(() => server?.close());

    test('GET / passes (viewer has channel_connection:read)', async () => {
      const { status } = await request(baseUrl, 'GET', CC_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id passes (viewer has channel_connection:read)', async () => {
      const { status } = await request(baseUrl, 'GET', `${CC_BASE}/cc-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST / returns 403 (viewer lacks channel_connection:create)', async () => {
      const { status, body } = await request(baseUrl, 'POST', CC_BASE, {
        body: CREATE_BODY,
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('viewer');
      expect(body.message).toContain('channel_connection:create');
    });

    test('PATCH /:id returns 403 (viewer lacks channel_connection:update)', async () => {
      const { status, body } = await request(baseUrl, 'PATCH', `${CC_BASE}/cc-1`, {
        body: PATCH_BODY,
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('viewer');
      expect(body.message).toContain('channel_connection:update');
    });

    test('DELETE /:id returns 403 (viewer lacks channel_connection:delete)', async () => {
      const { status, body } = await request(baseUrl, 'DELETE', `${CC_BASE}/cc-1`);
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('viewer');
      expect(body.message).toContain('channel_connection:delete');
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
      const { status, body } = await request(baseUrl, 'POST', CC_BASE, {
        body: CREATE_BODY,
      });
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('GET / returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'GET', CC_BASE);
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('GET /:id returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${CC_BASE}/cc-1`);
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('PATCH /:id returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'PATCH', `${CC_BASE}/cc-1`, {
        body: PATCH_BODY,
      });
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('DELETE /:id returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'DELETE', `${CC_BASE}/cc-1`);
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
      const { status, body } = await request(baseUrl, 'POST', CC_BASE, {
        body: CREATE_BODY,
      });
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('GET / returns 401', async () => {
      const { status, body } = await request(baseUrl, 'GET', CC_BASE);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('GET /:id returns 401', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${CC_BASE}/cc-1`);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('PATCH /:id returns 401', async () => {
      const { status, body } = await request(baseUrl, 'PATCH', `${CC_BASE}/cc-1`, {
        body: PATCH_BODY,
      });
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('DELETE /:id returns 401', async () => {
      const { status, body } = await request(baseUrl, 'DELETE', `${CC_BASE}/cc-1`);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });
  });
});

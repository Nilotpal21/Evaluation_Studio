/**
 * Channels Authorization Tests — Project-Level Object:Operation RBAC
 *
 * Verifies that `requireProjectPermission` enforces project-level permissions
 * on the /channels mount (backed by the consolidated sdk-channels router).
 *
 * Resolution order in requireProjectPermission:
 *   1. Tenant OWNER/ADMIN → workspace authority (project:* bypass)
 *   2. Project existence → 404 if not found (tenant isolation)
 *   3. Project owner → full access (ownerId match)
 *   4. Project member role → permission check via PROJECT_ROLE_PERMISSIONS
 *   5. No membership → 404 (concealed)
 *
 * Permission mapping:
 *   POST /              → channel:create  (admin + developer)
 *   GET  /              → channel:read    (all project members)
 *   PATCH /:channelId   → channel:update  (admin + developer)
 *   DELETE /:channelId  → channel:delete  (admin + developer)
 *
 * Project role → permissions:
 *   admin     → *:* (all)
 *   developer → channel:{read,create,update,delete}
 *   viewer    → channel:read (read only)
 */

import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// =============================================================================
// MOCKS — must be declared before any import that transitively pulls them in
// =============================================================================

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
  SDK_TOKEN_ISSUER: 'agent-platform',
  SDK_TOKEN_AUDIENCE: 'sdk-session',
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

vi.mock('../../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock('../../config/index.js', () => ({
  getConfig: vi.fn(() => ({
    jwt: { secret: 'test-secret-at-least-32-chars-long!!' },
  })),
}));

vi.mock('jsonwebtoken', () => ({
  default: { sign: vi.fn(() => 'mock-jwt-token') },
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
}));

vi.mock('../../repos/deployment-repo.js', () => ({
  findActiveDeployment: vi.fn().mockResolvedValue(null),
  findDeploymentById: vi.fn().mockResolvedValue({
    _id: 'deploy-1',
    projectId: 'proj-1',
    tenantId: 'tenant-A',
  }),
}));

vi.mock('../../repos/channel-repo.js', () => ({
  SDKChannelProjectScopeError: class SDKChannelProjectScopeError extends Error {},
  SDKChannelPublicApiKeyScopeError: class SDKChannelPublicApiKeyScopeError extends Error {},
  findPublicApiKey: vi.fn().mockResolvedValue({
    id: 'key-1',
    projectId: 'proj-1',
    tenantId: 'tenant-A',
    keyHash: 'hash',
    isActive: true,
  }),
  findPublicApiKeysByIds: vi.fn().mockResolvedValue([
    {
      id: 'key-1',
      projectId: 'proj-1',
      tenantId: 'tenant-A',
      keyHash: 'hash',
      keyPrefix: 'pk_test',
      isActive: true,
      permissions: { chat: true, voice: false },
      allowedOrigins: [],
      expiresAt: null,
    },
  ]),
  createSDKChannel: vi.fn().mockResolvedValue({
    id: 'ch-1',
    name: 'test-channel',
    tenantId: 'tenant-A',
    projectId: 'proj-1',
    channelType: 'web',
    deploymentId: null,
    publicApiKeyId: 'key-1',
    config: '{}',
    isActive: true,
    environment: null,
    followEnvironment: true,
  }),
  findSDKChannels: vi.fn().mockResolvedValue([]),
  findSDKChannelById: vi.fn().mockResolvedValue({
    id: 'ch-1',
    name: 'test-channel',
    tenantId: 'tenant-A',
    projectId: 'proj-1',
    channelType: 'web',
    deploymentId: null,
    publicApiKeyId: 'key-1',
    config: '{}',
    isActive: true,
    environment: null,
    followEnvironment: true,
  }),
  updateSDKChannel: vi.fn().mockResolvedValue({
    id: 'ch-1',
    name: 'updated-channel',
    tenantId: 'tenant-A',
    projectId: 'proj-1',
    channelType: 'web',
    deploymentId: null,
    publicApiKeyId: 'key-1',
    config: '{}',
    isActive: true,
    environment: null,
    followEnvironment: true,
  }),
  deleteSDKChannel: vi.fn().mockResolvedValue(true),
}));

// =============================================================================
// IMPORTS — after mocks
// =============================================================================

import express from 'express';
import { makeTenantContext, injectTenantContext } from '../helpers/auth-context.js';

// =============================================================================
// HELPERS
// =============================================================================

const CHANNELS_BASE = '/api/projects/proj-1/sdk-channels';

async function request(baseUrl: string, method: string, path: string, opts?: { body?: any }) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

function expectForbiddenError(
  body: { error?: unknown },
  code: 'PROJECT_PERMISSION_REQUIRED' | 'PROJECT_MEMBERSHIP_REQUIRED',
): void {
  expect(body.error).toEqual(
    expect.objectContaining({
      code,
      message: 'Forbidden',
    }),
  );
}

function expectConcealedNotFoundError(body: { error?: unknown }): void {
  expect(body.error).toEqual(
    expect.objectContaining({
      code: 'PROJECT_MEMBERSHIP_REQUIRED',
      message: 'Project not found',
    }),
  );
  expect((body as { message?: string }).message).toBeUndefined();
}

async function createServerForUser(
  tenantRole: 'OWNER' | 'ADMIN' | 'OPERATOR' | 'MEMBER' | 'VIEWER',
  userId: string,
) {
  const app = express();
  app.use(express.json());
  const ctx = makeTenantContext('tenant-A', userId, tenantRole);
  app.use(injectTenantContext(ctx));
  const channelsRouter = (await import('../../routes/sdk-channels.js')).default;
  app.use('/api/projects/:projectId/sdk-channels', channelsRouter);

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
  const channelsRouter = (await import('../../routes/sdk-channels.js')).default;
  app.use('/api/projects/:projectId/sdk-channels', channelsRouter);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

function closeServer(server?: http.Server) {
  if (!server) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  });
}

const CREATE_BODY = { name: 'test-channel', channelType: 'web', publicApiKeyId: 'key-1' };
const UPDATE_BODY = { name: 'updated-channel' };

// =============================================================================
// TESTS
// =============================================================================

describe('Channels route authorization — project-level object:operation RBAC', () => {
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

    test('POST / passes (channel:create — workspace authority)', async () => {
      const { status } = await request(baseUrl, 'POST', CHANNELS_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET / passes (channel:read)', async () => {
      const { status } = await request(baseUrl, 'GET', CHANNELS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('PATCH /:channelId passes (channel:update)', async () => {
      const { status } = await request(baseUrl, 'PATCH', `${CHANNELS_BASE}/ch-1`, {
        body: UPDATE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('DELETE /:channelId passes (channel:delete)', async () => {
      const { status } = await request(baseUrl, 'DELETE', `${CHANNELS_BASE}/ch-1`);
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

    test('POST / passes (channel:create — workspace authority)', async () => {
      const { status } = await request(baseUrl, 'POST', CHANNELS_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET / passes (channel:read)', async () => {
      const { status } = await request(baseUrl, 'GET', CHANNELS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('PATCH /:channelId passes (channel:update)', async () => {
      const { status } = await request(baseUrl, 'PATCH', `${CHANNELS_BASE}/ch-1`, {
        body: UPDATE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('DELETE /:channelId passes (channel:delete)', async () => {
      const { status } = await request(baseUrl, 'DELETE', `${CHANNELS_BASE}/ch-1`);
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

    test('POST / passes (channel:create — project owner)', async () => {
      const { status } = await request(baseUrl, 'POST', CHANNELS_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET / passes (channel:read)', async () => {
      const { status } = await request(baseUrl, 'GET', CHANNELS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('PATCH /:channelId passes (channel:update)', async () => {
      const { status } = await request(baseUrl, 'PATCH', `${CHANNELS_BASE}/ch-1`, {
        body: UPDATE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('DELETE /:channelId passes (channel:delete)', async () => {
      const { status } = await request(baseUrl, 'DELETE', `${CHANNELS_BASE}/ch-1`);
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

    test('POST / passes (admin has *:* → channel:create)', async () => {
      const { status } = await request(baseUrl, 'POST', CHANNELS_BASE, { body: CREATE_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET / passes (admin has *:* → channel:read)', async () => {
      const { status } = await request(baseUrl, 'GET', CHANNELS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('PATCH /:channelId passes (admin has *:* → channel:update)', async () => {
      const { status } = await request(baseUrl, 'PATCH', `${CHANNELS_BASE}/ch-1`, {
        body: UPDATE_BODY,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('DELETE /:channelId passes (admin has *:* → channel:delete)', async () => {
      const { status } = await request(baseUrl, 'DELETE', `${CHANNELS_BASE}/ch-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Project developer member (OPERATOR tenant role) → developer: channel management
  // ---------------------------------------------------------------------------
  describe('Project developer member', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('OPERATOR', 'proj-dev-user'));
    });
    afterAll(() => closeServer(server));

    test('GET / passes (developer has channel:read)', async () => {
      const { status } = await request(baseUrl, 'GET', CHANNELS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST / passes (developer has channel:create)', async () => {
      const { status, body } = await request(baseUrl, 'POST', CHANNELS_BASE, { body: CREATE_BODY });
      expect(body).toBeTruthy();
      expect(status).toBe(201);
    });

    test('PATCH /:channelId passes (developer has channel:update)', async () => {
      const { status, body } = await request(baseUrl, 'PATCH', `${CHANNELS_BASE}/ch-1`, {
        body: UPDATE_BODY,
      });
      expect(body).toBeTruthy();
      expect(status).toBe(200);
    });

    test('DELETE /:channelId passes (developer has channel:delete)', async () => {
      const { status, body } = await request(baseUrl, 'DELETE', `${CHANNELS_BASE}/ch-1`);
      expect(body).toBeTruthy();
      expect(status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  // Project viewer member (MEMBER tenant role) → viewer: channel:read only
  // ---------------------------------------------------------------------------
  describe('Project viewer member', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('MEMBER', 'proj-viewer-user'));
    });
    afterAll(() => closeServer(server));

    test('GET / passes (viewer has channel:read)', async () => {
      const { status } = await request(baseUrl, 'GET', CHANNELS_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST / returns 403 (viewer lacks channel:create)', async () => {
      const { status, body } = await request(baseUrl, 'POST', CHANNELS_BASE, { body: CREATE_BODY });
      expect(status).toBe(403);
      expectForbiddenError(body, 'PROJECT_PERMISSION_REQUIRED');
      expect(body.message).toContain('viewer');
    });

    test('PATCH /:channelId returns 403 (viewer lacks channel:update)', async () => {
      const { status, body } = await request(baseUrl, 'PATCH', `${CHANNELS_BASE}/ch-1`, {
        body: UPDATE_BODY,
      });
      expect(status).toBe(403);
      expectForbiddenError(body, 'PROJECT_PERMISSION_REQUIRED');
      expect(body.message).toContain('viewer');
    });

    test('DELETE /:channelId returns 403 (viewer lacks channel:delete)', async () => {
      const { status, body } = await request(baseUrl, 'DELETE', `${CHANNELS_BASE}/ch-1`);
      expect(status).toBe(403);
      expectForbiddenError(body, 'PROJECT_PERMISSION_REQUIRED');
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

    test('GET / returns 404 (concealed for non-members)', async () => {
      const { status, body } = await request(baseUrl, 'GET', CHANNELS_BASE);
      expect(status).toBe(404);
      expectConcealedNotFoundError(body);
    });

    test('POST / returns 404 (concealed for non-members)', async () => {
      const { status, body } = await request(baseUrl, 'POST', CHANNELS_BASE, { body: CREATE_BODY });
      expect(status).toBe(404);
      expectConcealedNotFoundError(body);
    });

    test('PATCH /:channelId returns 404 (concealed for non-members)', async () => {
      const { status, body } = await request(baseUrl, 'PATCH', `${CHANNELS_BASE}/ch-1`, {
        body: UPDATE_BODY,
      });
      expect(status).toBe(404);
      expectConcealedNotFoundError(body);
    });

    test('DELETE /:channelId returns 404 (concealed for non-members)', async () => {
      const { status, body } = await request(baseUrl, 'DELETE', `${CHANNELS_BASE}/ch-1`);
      expect(status).toBe(404);
      expectConcealedNotFoundError(body);
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
      const { status, body } = await request(baseUrl, 'POST', CHANNELS_BASE, { body: CREATE_BODY });
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('GET / returns 401', async () => {
      const { status, body } = await request(baseUrl, 'GET', CHANNELS_BASE);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('PATCH /:channelId returns 401', async () => {
      const { status, body } = await request(baseUrl, 'PATCH', `${CHANNELS_BASE}/ch-1`, {
        body: UPDATE_BODY,
      });
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('DELETE /:channelId returns 401', async () => {
      const { status, body } = await request(baseUrl, 'DELETE', `${CHANNELS_BASE}/ch-1`);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });
  });
});

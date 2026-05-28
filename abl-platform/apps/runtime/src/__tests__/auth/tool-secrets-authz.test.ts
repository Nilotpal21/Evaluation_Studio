/**
 * Tool Secrets Route Authorization Tests -- Project-Level Object:Operation RBAC
 *
 * Verifies that `requireProjectPermission` enforces project-level permissions
 * on the tool-secrets router using object:operation format.
 *
 * Resolution order in requireProjectPermission:
 *   1. Tenant OWNER/ADMIN -> workspace authority (project:* bypass)
 *   2. Project existence -> 404 if not found (tenant isolation)
 *   3. Project owner -> full access (ownerId match)
 *   4. Project member role -> permission check via PROJECT_ROLE_PERMISSIONS
 *   5. No membership -> 403
 *
 * Permission mapping:
 *   POST   /                  — credential:write
 *   GET    /                  — credential:read
 *   POST   /:id/rotate        — credential:write
 *   DELETE /:id               — credential:delete
 *
 * Project role -> permissions:
 *   admin     -> *:* (all)
 *   developer -> credential:* (all credential operations)
 *   viewer    -> credential:read (read only)
 *
 * Roles tested:
 *   OWNER    — *:* tenant perm → project:* bypass → all pass
 *   ADMIN    — project:* tenant perm → workspace bypass → all pass
 *   OPERATOR — no project:* → project member (viewer) → reads pass, writes/deletes 403
 *   MEMBER   — no project:* → project member (viewer) → reads pass, writes/deletes 403
 *   VIEWER   — no project:* → project member (viewer) → reads pass, writes/deletes 403
 *   Unauthenticated → all 401
 */

import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// =============================================================================
// MOCKS — must be declared before any import that transitively pulls them in
// =============================================================================

const mockIsTenantEncryptionReady = vi.fn(() => true);

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

// Keep real hasPermission but stub getCurrentRequestId
vi.mock('@agent-platform/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/shared')>();
  return {
    ...actual,
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

vi.mock('@agent-platform/shared/encryption', () => ({
  getEncryptionService: vi.fn(() => ({
    encryptForTenant: vi.fn(() => 'encrypted'),
    decryptForTenant: vi.fn(() => 'decrypted'),
  })),
  isTenantEncryptionReady: (...args: any[]) => mockIsTenantEncryptionReady(...args),
}));

// --- Shared repos: tool secret CRUD functions (route imports from @agent-platform/shared/repos) ---
vi.mock('@agent-platform/shared/repos', () => ({
  createToolSecret: vi.fn().mockResolvedValue({
    id: 'secret-1',
    toolName: 'my-tool',
    secretKey: 'API_KEY',
    environment: 'dev',
    version: 1,
    expiresAt: null,
    createdAt: new Date().toISOString(),
  }),
  findToolSecrets: vi.fn().mockResolvedValue([]),
  countToolSecrets: vi.fn().mockResolvedValue(0),
  // Must return a secret with projectId so rotate/delete reach the RBAC check
  findToolSecretById: vi.fn().mockResolvedValue({
    id: 'secret-1',
    projectId: 'proj-1',
    toolName: 'my-tool',
    secretKey: 'API_KEY',
    environment: 'dev',
    version: 1,
    expiresAt: null,
    tenantId: 'tenant-A',
  }),
  updateToolSecret: vi.fn().mockResolvedValue({
    id: 'secret-1',
    toolName: 'my-tool',
    secretKey: 'API_KEY',
    environment: 'dev',
    version: 2,
    rotatedAt: new Date().toISOString(),
  }),
  deleteToolSecret: vi.fn().mockResolvedValue(true),
}));

// --- Project repo: returns project + membership for requireProjectPermission ---
vi.mock('../../repos/project-repo.js', () => ({
  findProjectByIdAndTenant: vi.fn().mockResolvedValue({
    _id: 'proj-1',
    tenantId: 'tenant-A',
    ownerId: 'project-owner', // Different from test user 'user-1'
  }),
  findProjectMember: vi.fn().mockResolvedValue({
    projectId: 'proj-1',
    userId: 'user-1',
    role: 'viewer', // viewer role → credential:read only
  }),
}));

vi.mock('../../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

// =============================================================================
// IMPORTS — after mocks
// =============================================================================

import express from 'express';
import { makeTenantContext, injectTenantContext } from '../helpers/auth-context.js';

// =============================================================================
// HELPERS
// =============================================================================

const SECRETS_BASE = '/api/tool-secrets';

async function request(baseUrl: string, method: string, path: string, opts?: { body?: any }) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

/**
 * Creates a test Express app with the tool-secrets router mounted,
 * injecting the given role's tenant context into every request.
 * Returns the base URL and a cleanup function.
 */
async function createServerForRole(role: 'OWNER' | 'ADMIN' | 'OPERATOR' | 'MEMBER' | 'VIEWER') {
  const app = express();
  app.use(express.json());

  const ctx = makeTenantContext('tenant-A', 'user-1', role);
  app.use(injectTenantContext(ctx));

  const toolSecretsRouter = (await import('../../routes/tool-secrets.js')).default;
  app.use('/api/tool-secrets', toolSecretsRouter);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

// Minimal valid body for POST / (create tool secret)
const createBody = {
  projectId: 'proj-1',
  toolName: 'my-tool',
  secretKey: 'API_KEY',
  value: 'secret-value-123',
  environment: 'dev',
};

// Minimal valid body for POST /:id/rotate
const rotateBody = {
  value: 'new-secret-value-456',
};

// =============================================================================
// TESTS
// =============================================================================

describe('Tool secrets route authorization -- project-level object:operation RBAC', () => {
  // -------------------------------------------------------------------------
  // OWNER — *:* tenant perm → project:* bypass → all endpoints pass
  // -------------------------------------------------------------------------
  describe('Tenant OWNER (workspace authority)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForRole('OWNER'));
    });

    afterAll(() => {
      server?.close();
    });

    test('GET / (list) → passes auth (not 403)', async () => {
      const { status } = await request(baseUrl, 'GET', `${SECRETS_BASE}?projectId=proj-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST / (create) → passes auth (not 403)', async () => {
      const { status } = await request(baseUrl, 'POST', SECRETS_BASE, { body: createBody });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/rotate → passes auth (not 403)', async () => {
      const { status } = await request(baseUrl, 'POST', `${SECRETS_BASE}/secret-1/rotate`, {
        body: rotateBody,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('DELETE /:id → passes auth (not 403)', async () => {
      const { status } = await request(baseUrl, 'DELETE', `${SECRETS_BASE}/secret-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // ADMIN — project:* tenant perm → workspace authority bypass → all pass
  // -------------------------------------------------------------------------
  describe('Tenant ADMIN (workspace authority)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForRole('ADMIN'));
    });

    afterAll(() => {
      server?.close();
    });

    test('GET / (list) → passes auth (not 403)', async () => {
      const { status } = await request(baseUrl, 'GET', `${SECRETS_BASE}?projectId=proj-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST / (create) → passes auth (not 403)', async () => {
      const { status } = await request(baseUrl, 'POST', SECRETS_BASE, { body: createBody });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/rotate → passes auth (not 403)', async () => {
      const { status } = await request(baseUrl, 'POST', `${SECRETS_BASE}/secret-1/rotate`, {
        body: rotateBody,
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('DELETE /:id → passes auth (not 403)', async () => {
      const { status } = await request(baseUrl, 'DELETE', `${SECRETS_BASE}/secret-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // OPERATOR — no project:* → falls to project member (viewer) →
  //   credential:read passes, credential:write/delete 403
  // -------------------------------------------------------------------------
  describe('OPERATOR role (project viewer)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForRole('OPERATOR'));
    });

    afterAll(() => {
      server?.close();
    });

    test('GET / (list) → 200 (credential:read granted via project viewer)', async () => {
      const { status } = await request(baseUrl, 'GET', `${SECRETS_BASE}?projectId=proj-1`);
      expect(status).toBe(200);
    });

    test('POST / (create) → 403 (viewer lacks credential:write)', async () => {
      const { status, body } = await request(baseUrl, 'POST', SECRETS_BASE, {
        body: createBody,
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
    });

    test('POST /:id/rotate → 403 (viewer lacks credential:write)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${SECRETS_BASE}/secret-1/rotate`, {
        body: rotateBody,
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
    });

    test('DELETE /:id → 403 (viewer lacks credential:delete)', async () => {
      const { status, body } = await request(baseUrl, 'DELETE', `${SECRETS_BASE}/secret-1`);
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
    });
  });

  // -------------------------------------------------------------------------
  // MEMBER — no project:* → falls to project member (viewer) →
  //   credential:read passes, credential:write/delete 403
  // -------------------------------------------------------------------------
  describe('MEMBER role (project viewer)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForRole('MEMBER'));
    });

    afterAll(() => {
      server?.close();
    });

    test('GET / (list) → 200 (credential:read granted via project viewer)', async () => {
      const { status } = await request(baseUrl, 'GET', `${SECRETS_BASE}?projectId=proj-1`);
      expect(status).toBe(200);
    });

    test('POST / (create) → 403 (viewer lacks credential:write)', async () => {
      const { status, body } = await request(baseUrl, 'POST', SECRETS_BASE, {
        body: createBody,
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
    });

    test('POST /:id/rotate → 403 (viewer lacks credential:write)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${SECRETS_BASE}/secret-1/rotate`, {
        body: rotateBody,
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
    });

    test('DELETE /:id → 403 (viewer lacks credential:delete)', async () => {
      const { status, body } = await request(baseUrl, 'DELETE', `${SECRETS_BASE}/secret-1`);
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
    });
  });

  // -------------------------------------------------------------------------
  // VIEWER — no project:* → falls to project member (viewer) →
  //   credential:read passes, credential:write/delete 403
  // -------------------------------------------------------------------------
  describe('VIEWER role (project viewer)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForRole('VIEWER'));
    });

    afterAll(() => {
      server?.close();
    });

    test('GET / (list) → 200 (credential:read granted via project viewer)', async () => {
      const { status } = await request(baseUrl, 'GET', `${SECRETS_BASE}?projectId=proj-1`);
      expect(status).toBe(200);
    });

    test('POST / (create) → 403 (viewer lacks credential:write)', async () => {
      const { status, body } = await request(baseUrl, 'POST', SECRETS_BASE, {
        body: createBody,
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
    });

    test('POST /:id/rotate → 403 (viewer lacks credential:write)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${SECRETS_BASE}/secret-1/rotate`, {
        body: rotateBody,
      });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
    });

    test('DELETE /:id → 403 (viewer lacks credential:delete)', async () => {
      const { status, body } = await request(baseUrl, 'DELETE', `${SECRETS_BASE}/secret-1`);
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
    });
  });

  // -------------------------------------------------------------------------
  // Unauthenticated — no tenant context → all 401
  // -------------------------------------------------------------------------
  describe('Unauthenticated requests', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      const app = express();
      app.use(express.json());
      // Deliberately do NOT inject tenantContext

      const toolSecretsRouter = (await import('../../routes/tool-secrets.js')).default;
      app.use('/api/tool-secrets', toolSecretsRouter);

      await new Promise<void>((resolve) => {
        server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as AddressInfo;
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    });

    afterAll(() => {
      server?.close();
    });

    test('GET / returns 401 without tenantContext', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${SECRETS_BASE}?projectId=proj-1`);
      expect(status).toBe(401);
      expect(body.error).toBe('Authentication required');
    });

    test('POST / returns 401 without tenantContext', async () => {
      const { status, body } = await request(baseUrl, 'POST', SECRETS_BASE, {
        body: createBody,
      });
      expect(status).toBe(401);
      expect(body.error).toBe('Authentication required');
    });

    test('POST /:id/rotate returns 401 without tenantContext', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${SECRETS_BASE}/secret-1/rotate`, {
        body: rotateBody,
      });
      expect(status).toBe(401);
      expect(body.error).toBe('Authentication required');
    });

    test('DELETE /:id returns 401 without tenantContext', async () => {
      const { status, body } = await request(baseUrl, 'DELETE', `${SECRETS_BASE}/secret-1`);
      expect(status).toBe(401);
      expect(body.error).toBe('Authentication required');
    });
  });
});

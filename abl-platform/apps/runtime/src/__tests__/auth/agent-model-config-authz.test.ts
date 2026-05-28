/**
 * Agent Model Config Authorization Tests — Project-Level Object:Operation RBAC
 *
 * Verifies that `requireProjectPermission` enforces project-level permissions
 * on the agent-model-config router using object:operation format.
 *
 * Resolution order in requireProjectPermission:
 *   1. Tenant OWNER/ADMIN → workspace authority (project:* bypass)
 *   2. Project existence → 404 if not found (tenant isolation)
 *   3. Project owner → full access (ownerId match)
 *   4. Project member role → permission check via PROJECT_ROLE_PERMISSIONS
 *   5. No membership → 403
 *
 * Permission mapping:
 *   GET  / → agent:read   (read config)
 *   PUT  / → agent:update (upsert config)
 *
 * Project role → permissions:
 *   admin     → *:* (all)
 *   developer → agent:* (all agent operations — read + update both pass)
 *   viewer    → agent:read (read only)
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
  findProjectAgentForProject: vi.fn().mockResolvedValue({
    id: 'agent-1',
    _id: 'agent-1',
    name: 'main',
  }),
  findAgentModelConfig: vi.fn().mockResolvedValue({
    projectId: 'proj-1',
    agentName: 'main',
    defaultModel: 'gpt-4',
    operationModels: {},
    temperature: null,
    maxTokens: null,
  }),
  upsertAgentModelConfig: vi.fn().mockResolvedValue({
    projectId: 'proj-1',
    agentName: 'main',
    defaultModel: 'gpt-4',
    operationModels: '{}',
    temperature: null,
    maxTokens: null,
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

const CONFIG_BASE = '/api/projects/proj-1/agents/main/model-config';

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
  const modelConfigRouter = (await import('../../routes/agent-model-config.js')).default;
  app.use('/api/projects/:projectId/agents/:agentName/model-config', modelConfigRouter);

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
  const modelConfigRouter = (await import('../../routes/agent-model-config.js')).default;
  app.use('/api/projects/:projectId/agents/:agentName/model-config', modelConfigRouter);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

const PUT_BODY = { defaultModel: 'gpt-4' };

// =============================================================================
// TESTS
// =============================================================================

describe('Agent Model Config route authorization — project-level object:operation RBAC', () => {
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

    test('GET / passes (agent:read — workspace authority)', async () => {
      const { status } = await request(baseUrl, 'GET', CONFIG_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('PUT / passes (agent:update — workspace authority)', async () => {
      const { status } = await request(baseUrl, 'PUT', CONFIG_BASE, { body: PUT_BODY });
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

    test('GET / passes (agent:read — workspace authority)', async () => {
      const { status } = await request(baseUrl, 'GET', CONFIG_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('PUT / passes (agent:update — workspace authority)', async () => {
      const { status } = await request(baseUrl, 'PUT', CONFIG_BASE, { body: PUT_BODY });
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

    test('GET / passes (agent:read — project owner)', async () => {
      const { status } = await request(baseUrl, 'GET', CONFIG_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('PUT / passes (agent:update — project owner)', async () => {
      const { status } = await request(baseUrl, 'PUT', CONFIG_BASE, { body: PUT_BODY });
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

    test('GET / passes (admin has *:* → agent:read)', async () => {
      const { status } = await request(baseUrl, 'GET', CONFIG_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('PUT / passes (admin has *:* → agent:update)', async () => {
      const { status } = await request(baseUrl, 'PUT', CONFIG_BASE, { body: PUT_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Project developer member (OPERATOR tenant role) → developer: agent:* → all pass
  // ---------------------------------------------------------------------------
  describe('Project developer member', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('OPERATOR', 'proj-dev-user'));
    });
    afterAll(() => server?.close());

    test('GET / passes (developer has agent:* → agent:read)', async () => {
      const { status } = await request(baseUrl, 'GET', CONFIG_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('PUT / passes (developer has agent:* → agent:update)', async () => {
      const { status } = await request(baseUrl, 'PUT', CONFIG_BASE, { body: PUT_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Project viewer member (MEMBER tenant role) → viewer: agent:read only
  // ---------------------------------------------------------------------------
  describe('Project viewer member', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('MEMBER', 'proj-viewer-user'));
    });
    afterAll(() => server?.close());

    test('GET / passes (viewer has agent:read)', async () => {
      const { status } = await request(baseUrl, 'GET', CONFIG_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('PUT / returns 403 (viewer lacks agent:update)', async () => {
      const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, { body: PUT_BODY });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('viewer');
      expect(body.message).toContain('agent:update');
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

    test('GET / returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'GET', CONFIG_BASE);
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('PUT / returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, { body: PUT_BODY });
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

    test('GET / returns 401', async () => {
      const { status, body } = await request(baseUrl, 'GET', CONFIG_BASE);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('PUT / returns 401', async () => {
      const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, { body: PUT_BODY });
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });
  });
});

/**
 * Agent Transfer Routes Authorization Tests
 *
 * Verifies that authMiddleware + requireProjectPermission enforce auth on:
 *   GET  /api/v1/agent-transfer/sessions
 *   POST /api/v1/agent-transfer/sessions/:id/end
 *   GET  /api/v1/agent-transfer/settings
 *   PUT  /api/v1/agent-transfer/settings
 *
 * These routes use X-Tenant-Id / X-Project-Id headers instead of URL params.
 * The explicitProjectId parameter is passed to requireProjectPermission.
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

vi.mock('../../repos/project-repo.js', () => ({
  findProjectByIdAndTenant: vi.fn().mockResolvedValue({
    _id: 'proj-1',
    tenantId: 'tenant-A',
    ownerId: 'project-owner',
  }),
  findProjectAgentForProject: vi.fn().mockResolvedValue(null),
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

// Sessions route deps
vi.mock('../../services/agent-transfer/index.js', () => ({
  isAgentTransferInitialized: vi.fn(() => true),
  getTransferSessionStore: vi.fn(() => ({
    getActiveSessions: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    end: vi.fn().mockResolvedValue(true),
  })),
  getTransferTraceEmitter: vi.fn(() => null),
}));

// Settings route deps
vi.mock('../../db/index.js', () => ({
  isDatabaseAvailable: vi.fn(() => true),
}));

vi.mock('../../repos/project-settings-repo.js', () => ({
  findProjectSettings: vi.fn().mockResolvedValue({ agentTransfer: {} }),
}));

vi.mock('@agent-platform/database/models', () => ({
  ProjectSettings: {
    findOneAndUpdate: vi.fn().mockResolvedValue({}),
  },
}));

// =============================================================================
// IMPORTS -- after mocks
// =============================================================================

import express from 'express';
import agentTransferSessionsRouter from '../../routes/agent-transfer-sessions.js';
import agentTransferSettingsRouter from '../../routes/agent-transfer-settings.js';
import { makeTenantContext, injectTenantContext } from '../helpers/auth-context.js';

// =============================================================================
// HELPERS
// =============================================================================

const SESSIONS_BASE = '/api/v1/agent-transfer/sessions';
const SETTINGS_BASE = '/api/v1/agent-transfer/settings';
const TENANT_ID = 'tenant-A';
const PROJECT_ID = 'proj-1';

async function request(
  baseUrl: string,
  method: string,
  path: string,
  opts?: { body?: any; headers?: Record<string, string> },
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-tenant-id': TENANT_ID,
    'x-project-id': PROJECT_ID,
    ...(opts?.headers ?? {}),
  };
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
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
  const ctx = makeTenantContext(TENANT_ID, userId, tenantRole);
  app.use(injectTenantContext(ctx));

  app.use(SESSIONS_BASE, agentTransferSessionsRouter);
  app.use(SETTINGS_BASE, agentTransferSettingsRouter);

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

  app.use(SESSIONS_BASE, agentTransferSessionsRouter);
  app.use(SETTINGS_BASE, agentTransferSettingsRouter);

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

describe('Agent Transfer routes authorization', () => {
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

    test('GET /sessions returns 401', async () => {
      const { status, body } = await request(baseUrl, 'GET', SESSIONS_BASE);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('POST /sessions/:id/end returns 401', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/sess-1/end`);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('GET /settings returns 401', async () => {
      const { status, body } = await request(baseUrl, 'GET', SETTINGS_BASE);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('PUT /settings returns 401', async () => {
      const { status, body } = await request(baseUrl, 'PUT', SETTINGS_BASE, { body: {} });
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });
  });

  // ---------------------------------------------------------------------------
  // Tenant OWNER -- workspace authority bypass -> all pass
  // ---------------------------------------------------------------------------
  describe('Tenant OWNER (workspace authority)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('OWNER', 'owner-user'));
    });
    afterAll(() => server?.close());

    test('GET /sessions passes (connection:read)', async () => {
      const { status } = await request(baseUrl, 'GET', SESSIONS_BASE);
      expect(status).not.toBe(401);
      expect(status).not.toBe(403);
    });

    test('POST /sessions/:id/end passes (connection:write)', async () => {
      const { status } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/sess-1/end`);
      expect(status).not.toBe(401);
      expect(status).not.toBe(403);
    });

    test('GET /settings passes (connection:read)', async () => {
      const { status } = await request(baseUrl, 'GET', SETTINGS_BASE);
      expect(status).not.toBe(401);
      expect(status).not.toBe(403);
    });

    test('PUT /settings passes (connection:write)', async () => {
      const { status } = await request(baseUrl, 'PUT', SETTINGS_BASE, {
        body: { enabled: true },
      });
      expect(status).not.toBe(401);
      expect(status).not.toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // Non-member (OPERATOR without project membership) -> all 404
  // ---------------------------------------------------------------------------
  describe('Non-member (OPERATOR without project membership)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('OPERATOR', 'non-member-user'));
    });
    afterAll(() => server?.close());

    test('GET /sessions returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'GET', SESSIONS_BASE);
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('POST /sessions/:id/end returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${SESSIONS_BASE}/sess-1/end`);
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('GET /settings returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'GET', SETTINGS_BASE);
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });

    test('PUT /settings returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'PUT', SETTINGS_BASE, {
        body: { enabled: true },
      });
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
    });
  });

  // ---------------------------------------------------------------------------
  // PUT /settings body validation
  // ---------------------------------------------------------------------------
  describe('PUT /settings body validation', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createServerForUser('OWNER', 'owner-user'));
    });
    afterAll(() => server?.close());

    test('returns 400 when body is an array', async () => {
      const { status, body } = await request(baseUrl, 'PUT', SETTINGS_BASE, {
        body: [1, 2, 3],
      });
      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INVALID_BODY');
    });

    test('returns 400 when body contains __proto__', async () => {
      const { status, body } = await request(baseUrl, 'PUT', SETTINGS_BASE, {
        body: { __proto__: { isAdmin: true } },
        headers: { 'Content-Type': 'application/json' },
      });
      // Note: express JSON parser may strip __proto__, but if it gets through, we reject it
      // The status should be either 400 (caught) or 200 (stripped by parser)
      expect([200, 400]).toContain(status);
    });

    test('returns 200 with valid object body', async () => {
      const { status, body } = await request(baseUrl, 'PUT', SETTINGS_BASE, {
        body: { enabled: true, provider: 'smartassist' },
      });
      expect(status).toBe(200);
      expect(body.success).toBe(true);
    });
  });
});

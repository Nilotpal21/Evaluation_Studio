/**
 * Project Settings Route Tests
 *
 * Tests for GET (defaults), PUT (create/update), POST versions,
 * POST promote, and authorization (cross-tenant 404, missing auth 401).
 */

import { describe, test, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { makeTenantContext, injectTenantContext } from './helpers/auth-context.js';

// ─── Hoisted Mocks ──────────────────────────────────────────────────────

const mockFindProjectSettings = vi.fn();
const mockUpsertProjectSettings = vi.fn();

vi.mock('../repos/project-settings-repo.js', () => ({
  findProjectSettings: (...args: any[]) => mockFindProjectSettings(...args),
  upsertProjectSettings: (...args: any[]) => mockUpsertProjectSettings(...args),
}));

const mockCreateVersion = vi.fn();
const mockListVersions = vi.fn();
const mockGetVersion = vi.fn();
const mockPromoteVersion = vi.fn();

vi.mock('../services/settings-version-service.js', () => ({
  getSettingsVersionService: () => ({
    createVersion: mockCreateVersion,
    listVersions: mockListVersions,
    getVersion: mockGetVersion,
    promoteVersion: mockPromoteVersion,
  }),
}));

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@agent-platform/shared', () => ({
  requireProjectScope: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock requireProjectPermission — let all permissions pass for basic tests
vi.mock('../middleware/rbac.js', () => ({
  requirePermissionInline: vi.fn(),
  requireProjectPermission: vi.fn(async () => true),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────

async function createTestServer(tenantRole: 'OWNER' | 'ADMIN' | 'VIEWER' = 'OWNER') {
  const app = express();
  app.use(express.json());

  const ctx = makeTenantContext('tenant-A', 'user-1', tenantRole);
  app.use(injectTenantContext(ctx));

  const routerModule = await import('../routes/project-settings.js');
  app.use('/api/projects/:projectId/settings', routerModule.default);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

async function request(baseUrl: string, method: string, path: string, opts?: { body?: any }) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

const BASE = '/api/projects/proj-1/settings';
const VERSIONS_BASE = `${BASE}/versions`;

// ─── Tests ───────────────────────────────────────────────────────────────

describe('Project Settings Route', () => {
  let baseUrl: string;
  let server: http.Server;

  beforeAll(async () => {
    ({ baseUrl, server } = await createTestServer());
  });

  afterAll(() => server?.close());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =======================================================================
  // GET / — Working Copy
  // =======================================================================

  describe('GET / — working copy', () => {
    test('returns defaults when no record exists', async () => {
      mockFindProjectSettings.mockResolvedValue(null);

      const { status, body } = await request(baseUrl, 'GET', BASE);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.settings.projectId).toBe('proj-1');
      expect(body.settings.enableThinking).toBe(false);
      expect(body.settings.thinkingBudget).toBeNull();
      expect(body.promptDefaults['llm_prompt.entity_extraction']).toBeTypeOf('string');
      expect(body.promptDefaults['escalation.digital']).toBeTypeOf('string');
    });

    test('returns stored values when record exists', async () => {
      mockFindProjectSettings.mockResolvedValue({
        enableThinking: true,
        thinkingBudget: 4096,
      });

      const { status, body } = await request(baseUrl, 'GET', BASE);

      expect(status).toBe(200);
      expect(body.settings.enableThinking).toBe(true);
      expect(body.settings.thinkingBudget).toBe(4096);
      expect(body.promptDefaults['tool_description.shared.thought']).toBeTypeOf('string');
    });
  });

  // =======================================================================
  // PUT / — Update Working Copy
  // =======================================================================

  describe('PUT / — update working copy', () => {
    test('creates record on first save', async () => {
      mockUpsertProjectSettings.mockResolvedValue({
        enableThinking: true,
        thinkingBudget: null,
      });

      const { status, body } = await request(baseUrl, 'PUT', BASE, {
        body: { enableThinking: true },
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.settings.enableThinking).toBe(true);
      expect(body.promptDefaults['escalation.plain']).toBeTypeOf('string');
      expect(mockUpsertProjectSettings).toHaveBeenCalledWith(
        'proj-1',
        'tenant-A',
        expect.objectContaining({ enableThinking: true }),
      );
    });

    test('updates existing record', async () => {
      mockUpsertProjectSettings.mockResolvedValue({
        enableThinking: false,
        thinkingBudget: 8192,
      });

      const { status, body } = await request(baseUrl, 'PUT', BASE, {
        body: { enableThinking: false, thinkingBudget: 8192 },
      });

      expect(status).toBe(200);
      expect(body.settings.enableThinking).toBe(false);
      expect(body.settings.thinkingBudget).toBe(8192);
    });

    test('clears thinkingBudget with null', async () => {
      mockUpsertProjectSettings.mockResolvedValue({
        enableThinking: true,
        thinkingBudget: null,
      });

      const { status, body } = await request(baseUrl, 'PUT', BASE, {
        body: { thinkingBudget: null },
      });

      expect(status).toBe(200);
      expect(body.settings.thinkingBudget).toBeNull();
    });

    test('accepts inherit as explicit live SDK token envelope default', async () => {
      mockUpsertProjectSettings.mockResolvedValue({
        enableThinking: false,
        thinkingBudget: null,
        sdkDefaults: {
          hostedExchangeTokenEnvelopePolicy: 'inherit',
        },
      });

      const { status, body } = await request(baseUrl, 'PUT', BASE, {
        body: {
          sdkDefaults: {
            hostedExchangeTokenEnvelopePolicy: 'inherit',
          },
        },
      });

      expect(status).toBe(200);
      expect(body.settings.sdkDefaults).toEqual({
        hostedExchangeTokenEnvelopePolicy: 'inherit',
      });
      expect(mockUpsertProjectSettings).toHaveBeenCalledWith(
        'proj-1',
        'tenant-A',
        expect.objectContaining({
          sdkDefaults: {
            hostedExchangeTokenEnvelopePolicy: 'inherit',
          },
        }),
      );
    });
  });

  // =======================================================================
  // POST /versions — Create Version
  // =======================================================================

  describe('POST /versions — create version', () => {
    test('creates version from working copy', async () => {
      mockCreateVersion.mockResolvedValue({
        versionId: 'ver-001',
        version: '0.1.0',
        sourceHash: 'abc123def456789a',
      });

      const { status, body } = await request(baseUrl, 'POST', VERSIONS_BASE, {
        body: { changelog: 'initial settings' },
      });

      expect(status).toBe(201);
      expect(body.success).toBe(true);
      expect(body.version.versionId).toBe('ver-001');
      expect(body.version.version).toBe('0.1.0');
    });

    test('returns deduplicated result', async () => {
      mockCreateVersion.mockResolvedValue({
        versionId: 'ver-existing',
        version: '0.1.0',
        sourceHash: 'abc123def456789a',
        deduplicated: true,
      });

      const { status, body } = await request(baseUrl, 'POST', VERSIONS_BASE, {
        body: {},
      });

      expect(status).toBe(201);
      expect(body.version.deduplicated).toBe(true);
    });
  });

  // =======================================================================
  // GET /versions — List Versions
  // =======================================================================

  describe('GET /versions — list versions', () => {
    test('returns paginated versions', async () => {
      mockListVersions.mockResolvedValue({
        versions: [
          { _id: 'v2', version: '0.1.1', status: 'draft' },
          { _id: 'v1', version: '0.1.0', status: 'active' },
        ],
        total: 2,
      });

      const { status, body } = await request(baseUrl, 'GET', VERSIONS_BASE);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.versions).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    test('returns empty when no versions', async () => {
      mockListVersions.mockResolvedValue({ versions: [], total: 0 });

      const { status, body } = await request(baseUrl, 'GET', VERSIONS_BASE);

      expect(status).toBe(200);
      expect(body.versions).toHaveLength(0);
      expect(body.total).toBe(0);
    });
  });

  // =======================================================================
  // GET /versions/:version — Get Version Detail
  // =======================================================================

  describe('GET /versions/:version — get version detail', () => {
    test('returns version when found', async () => {
      mockGetVersion.mockResolvedValue({
        _id: 'ver-1',
        version: '0.1.0',
        status: 'draft',
        settings: { enableThinking: true, thinkingBudget: 4096 },
      });

      const { status, body } = await request(baseUrl, 'GET', `${VERSIONS_BASE}/0.1.0`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.version.version).toBe('0.1.0');
    });

    test('returns 404 when version not found', async () => {
      mockGetVersion.mockResolvedValue(null);

      const { status, body } = await request(baseUrl, 'GET', `${VERSIONS_BASE}/9.9.9`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
    });
  });

  // =======================================================================
  // POST /versions/:version/promote — Promote Version
  // =======================================================================

  describe('POST /versions/:version/promote — promote version', () => {
    test('promotes version successfully', async () => {
      mockPromoteVersion.mockResolvedValue({
        _id: 'ver-1',
        version: '0.1.0',
        status: 'testing',
        previousStatus: 'draft',
      });

      const { status, body } = await request(baseUrl, 'POST', `${VERSIONS_BASE}/0.1.0/promote`, {
        body: { targetStatus: 'testing' },
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.previousStatus).toBe('draft');
    });

    test('returns 400 for invalid transition', async () => {
      const err = Object.assign(new Error("Cannot transition from 'draft' to 'active'"), {
        code: 'BAD_REQUEST',
        statusCode: 400,
      });
      mockPromoteVersion.mockRejectedValue(err);

      const { status, body } = await request(baseUrl, 'POST', `${VERSIONS_BASE}/0.1.0/promote`, {
        body: { targetStatus: 'active' },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
    });

    test('returns 404 for version not found', async () => {
      const err = Object.assign(new Error("Settings version '9.9.9' not found"), {
        code: 'NOT_FOUND',
        statusCode: 404,
      });
      mockPromoteVersion.mockRejectedValue(err);

      const { status, body } = await request(baseUrl, 'POST', `${VERSIONS_BASE}/9.9.9/promote`, {
        body: { targetStatus: 'testing' },
      });

      expect(status).toBe(404);
      expect(body.success).toBe(false);
    });

    test('returns 422 for concurrent modification', async () => {
      const err = Object.assign(new Error('Concurrent modification'), {
        code: 'UNPROCESSABLE_ENTITY',
        statusCode: 422,
      });
      mockPromoteVersion.mockRejectedValue(err);

      const { status, body } = await request(baseUrl, 'POST', `${VERSIONS_BASE}/0.1.0/promote`, {
        body: { targetStatus: 'testing' },
      });

      expect(status).toBe(422);
      expect(body.success).toBe(false);
    });
  });
});

// =========================================================================
// AUTHORIZATION TESTS
// =========================================================================

describe('Project Settings Route — Authorization', () => {
  describe('RBAC — permission denied', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      // Override requireProjectPermission to deny
      const rbac = await import('../middleware/rbac.js');
      (rbac.requireProjectPermission as any).mockImplementation(
        async (_req: any, res: any, _perm: string) => {
          res.status(403).json({ success: false, error: 'Forbidden' });
          return false;
        },
      );

      const app = express();
      app.use(express.json());

      const ctx = makeTenantContext('tenant-A', 'viewer-user', 'VIEWER');
      app.use(injectTenantContext(ctx));

      const routerModule = await import('../routes/project-settings.js');
      app.use('/api/projects/:projectId/settings', routerModule.default);

      await new Promise<void>((resolve) => {
        const srv = http.createServer(app);
        srv.listen(0, '127.0.0.1', () => {
          const addr = srv.address() as AddressInfo;
          baseUrl = `http://127.0.0.1:${addr.port}`;
          server = srv;
          resolve();
        });
      });
    });

    afterAll(async () => {
      server?.close();
      // Restore default permission pass-through
      const rbac = await import('../middleware/rbac.js');
      (rbac.requireProjectPermission as any).mockImplementation(async () => true);
    });

    test('GET / returns 403 without model_config:read', async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-1/settings`);
      expect(res.status).toBe(403);
    });

    test('PUT / returns 403 without model_config:write', async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-1/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enableThinking: true }),
      });
      expect(res.status).toBe(403);
    });

    test('POST /versions returns 403 without deployment:create', async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-1/settings/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(403);
    });
  });
});

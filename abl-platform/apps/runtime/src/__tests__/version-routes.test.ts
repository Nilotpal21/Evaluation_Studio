/**
 * Version & Project-Agents Route Integration Tests
 *
 * Mounts the routers on a real Express app and exercises the endpoints
 * via Node's built-in fetch against an http.createServer listener.
 */

import { describe, test, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// =============================================================================
// MOCKS — must be declared before any import that transitively pulls them in
// =============================================================================

let mockDb: ReturnType<typeof createMockDb>;

vi.mock('../db/index.js', () => ({
  isDatabaseAvailable: vi.fn(() => true),
}));

vi.mock('../repos/project-repo.js', () => ({
  findProjectByIdAndTenant: vi.fn(async (...args: any[]) => mockDb.project.findFirst(...args)),
  findProjectAgentsForProject: vi.fn(async (...args: any[]) =>
    mockDb.projectAgent.findMany(...args),
  ),
  findProjectAgentForProject: vi.fn(
    async (projectId: string, agentName: string, tenantId?: string, opts?: any) => {
      const result = await mockDb.projectAgent.findFirst({
        where: { projectId, name: agentName },
        include: {
          project: true,
          _count: opts?.includeVersionCount ? { select: { versions: true } } : undefined,
        },
      });
      if (result && tenantId && result.project?.tenantId !== tenantId) return null;
      return result;
    },
  ),
  updateProjectAgentDsl: vi.fn(async (agentId: string, dslContent: string) =>
    mockDb.projectAgent.update({
      where: { id: agentId },
      data: { dslContent, updatedAt: new Date() },
    }),
  ),
}));

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: vi.fn((req: any, _res: any, next: any) => {
    // Auth middleware is a passthrough — tenantContext/user are set by the
    // test-level middleware below.  But when we want to test 401, the test
    // installs a custom version that skips setting those.
    next();
  }),
}));

vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('../middleware/rbac.js', () => ({
  requireWriteAccess: vi.fn(async (_req: any, _res: any) => true),
  requirePermissionInline: vi.fn(() => true),
  requireProjectPermission: vi.fn(async () => true),
}));

vi.mock('@agent-platform/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/shared')>();
  return {
    ...actual,
    requireProjectScope: vi.fn(() => (_req: any, _res: any, next: any) => next()),
    validateAgentName: vi.fn(() => null), // Pass-through: all agent names valid in tests
  };
});

vi.mock('../services/audit-helpers.js', () => ({
  auditVersionCreated: vi.fn(() => Promise.resolve()),
  auditVersionPromoted: vi.fn(() => Promise.resolve()),
  auditVersionDeprecated: vi.fn(() => Promise.resolve()),
  auditDslUpdated: vi.fn(() => Promise.resolve()),
}));

// Mock the version-service module.  We intercept getVersionService to return
// our own stub, and expose VersionService static methods as-is.
const mockVersionServiceInstance = {
  nextVersion: vi.fn(),
  createVersion: vi.fn(),
  listVersions: vi.fn(),
  getVersion: vi.fn(),
  promoteVersion: vi.fn(),
  diffVersions: vi.fn(),
};

vi.mock('../services/version-service.js', () => ({
  getVersionService: vi.fn(() => mockVersionServiceInstance),
  VersionService: {
    validateChangelog: vi.fn(() => null),
    validateDslContent: vi.fn((content: unknown) => {
      if (typeof content !== 'string') return 'dslContent must be a string';
      if (content.length === 0) return 'dslContent must not be empty';
      return null;
    }),
    isValidStatus: vi.fn(
      (s: unknown) =>
        typeof s === 'string' && ['draft', 'testing', 'staged', 'active', 'deprecated'].includes(s),
    ),
  },
  safeParseJSON: vi.fn((val: string | null | undefined, fallback: any) => {
    if (!val) return fallback;
    try {
      return JSON.parse(val);
    } catch {
      return fallback;
    }
  }),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// =============================================================================
// MOCK DB FACTORY
// =============================================================================

function createMockDb() {
  return {
    projectAgent: {
      findFirst: vi.fn(),
      findMany: vi.fn(async () => []),
      update: vi.fn(),
    },
    project: {
      findFirst: vi.fn(),
    },
    tenantMember: {
      findUnique: vi.fn(async () => ({ role: 'ADMIN' })),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => ({ id: 'audit-1', ...data })),
    },
  };
}

// =============================================================================
// APP SETUP
// =============================================================================

import express from 'express';
import { requireWriteAccess } from '../middleware/rbac.js';
import { validateAgentName } from '@agent-platform/shared';

let baseUrl: string;
let server: http.Server;

beforeAll(async () => {
  mockDb = createMockDb();

  const app = express();
  app.use(express.json());

  // Inject tenantContext and user for every request (default: authenticated).
  // Individual tests can override by setting `skipAuth = true` before the request.
  app.use((req: any, _res: any, next: any) => {
    if (!(req as any).__skipAuth) {
      req.tenantContext = { tenantId: 'tenant-1', userId: 'user-1' };
      req.user = { id: 'user-1', email: 'test@test.com' };
    }
    next();
  });

  // Mount version routes under the expected parent path
  const versionsRouter = (await import('../routes/versions.js')).default;
  app.use('/api/projects/:projectId/agents/:agentName/versions', versionsRouter);

  // Mount project-agents routes
  const projectAgentsRouter = (await import('../routes/project-agents.js')).default;
  app.use('/api/projects/:projectId/agents', projectAgentsRouter);

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

beforeEach(() => {
  // Reset mocks before each test
  mockDb = createMockDb();
  vi.mocked(mockVersionServiceInstance.nextVersion).mockReset();
  vi.mocked(mockVersionServiceInstance.createVersion).mockReset();
  vi.mocked(mockVersionServiceInstance.listVersions).mockReset();
  vi.mocked(mockVersionServiceInstance.getVersion).mockReset();
  vi.mocked(mockVersionServiceInstance.promoteVersion).mockReset();
  vi.mocked(mockVersionServiceInstance.diffVersions).mockReset();

  // Reset requireWriteAccess to default pass-through
  vi.mocked(requireWriteAccess).mockResolvedValue(true);
});

// =============================================================================
// HELPERS
// =============================================================================

/** Make a request, optionally skipping auth injection for 401 tests. */
async function request(method: string, path: string, opts?: { body?: any; skipAuth?: boolean }) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts?.skipAuth) {
    headers['X-Skip-Auth'] = '1';
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

// =============================================================================
// VERSION ROUTES  — /api/projects/:projectId/agents/:agentName/versions
// =============================================================================

const VERSIONS_BASE = '/api/projects/proj-1/agents/my_agent/versions';

describe('Version Routes', () => {
  // ---------------------------------------------------------------------------
  // POST / — create version
  // ---------------------------------------------------------------------------
  describe('POST / (create version)', () => {
    test('returns 201 on successful version creation', async () => {
      // Agent exists with DSL content
      mockDb.projectAgent.findFirst.mockResolvedValue({
        id: 'agent-1',
        projectId: 'proj-1',
        name: 'my_agent',
        dslContent: 'AGENT my_agent\n  GOAL: Help user',
        project: { tenantId: 'tenant-1' },
      });

      mockVersionServiceInstance.nextVersion.mockResolvedValue('0.1.0');
      mockVersionServiceInstance.createVersion.mockResolvedValue({
        versionId: 'ver-1',
        version: '0.1.0',
        sourceHash: 'abc123',
      });

      const { status, body } = await request('POST', VERSIONS_BASE, {
        body: { changelog: 'Initial version' },
      });

      expect(status).toBe(201);
      expect(body.success).toBe(true);
      expect(body.versionId).toBe('ver-1');
      expect(body.version).toBe('0.1.0');
      expect(body.sourceHash).toBe('abc123');
    });

    test('returns 400 when agent has no DSL content', async () => {
      mockDb.projectAgent.findFirst.mockResolvedValue({
        id: 'agent-1',
        projectId: 'proj-1',
        name: 'my_agent',
        dslContent: null,
        project: { tenantId: 'tenant-1' },
      });

      const { status, body } = await request('POST', VERSIONS_BASE, {
        body: {},
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('no DSL content');
    });

    test('returns 422 when DSL has compile errors', async () => {
      mockDb.projectAgent.findFirst.mockResolvedValue({
        id: 'agent-1',
        projectId: 'proj-1',
        name: 'my_agent',
        dslContent: 'AGENT bad_syntax >>>',
        project: { tenantId: 'tenant-1' },
      });

      mockVersionServiceInstance.nextVersion.mockResolvedValue('0.1.0');
      mockVersionServiceInstance.createVersion.mockResolvedValue({
        versionId: '',
        version: '0.1.0',
        sourceHash: 'def456',
        compileErrors: ['Unexpected token at line 1'],
      });

      const { status, body } = await request('POST', VERSIONS_BASE, {
        body: {},
      });

      expect(status).toBe(422);
      expect(body.success).toBe(false);
      expect(body.errors).toEqual(['Unexpected token at line 1']);
      expect(body.sourceHash).toBe('def456');
    });

    test('returns 404 when agent not found', async () => {
      mockDb.projectAgent.findFirst.mockResolvedValue(null);

      const { status, body } = await request('POST', VERSIONS_BASE, {
        body: {},
      });

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });

    test('returns 404 when agent belongs to different tenant', async () => {
      mockDb.projectAgent.findFirst.mockResolvedValue({
        id: 'agent-1',
        projectId: 'proj-1',
        name: 'my_agent',
        dslContent: 'AGENT my_agent',
        project: { tenantId: 'other-tenant' },
      });

      const { status, body } = await request('POST', VERSIONS_BASE, {
        body: {},
      });

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });

    test('returns 200 with deduplicated flag when DSL unchanged', async () => {
      mockDb.projectAgent.findFirst.mockResolvedValue({
        id: 'agent-1',
        projectId: 'proj-1',
        name: 'my_agent',
        dslContent: 'AGENT my_agent\n  GOAL: Help user',
        project: { tenantId: 'tenant-1' },
      });

      mockVersionServiceInstance.nextVersion.mockResolvedValue('0.1.1');
      mockVersionServiceInstance.createVersion.mockResolvedValue({
        versionId: 'ver-existing',
        version: '0.1.0',
        sourceHash: 'same-hash',
        deduplicated: true,
      });

      const { status, body } = await request('POST', VERSIONS_BASE, {
        body: {},
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.deduplicated).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // GET / — list versions
  // ---------------------------------------------------------------------------
  describe('GET / (list versions)', () => {
    test('returns 200 with versions and pagination metadata', async () => {
      mockVersionServiceInstance.listVersions.mockResolvedValue({
        versions: [
          { id: 'v1', version: '0.1.0', status: 'draft', sourceHash: 'a1' },
          { id: 'v2', version: '0.1.1', status: 'active', sourceHash: 'a2' },
        ],
        total: 5,
      });

      const { status, body } = await request('GET', `${VERSIONS_BASE}?limit=2&offset=0`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.versions).toHaveLength(2);
      expect(body.total).toBe(5);
      expect(body.limit).toBe(2);
      expect(body.offset).toBe(0);
      expect(body.hasMore).toBe(true);
    });

    test('returns default pagination when no query params', async () => {
      mockVersionServiceInstance.listVersions.mockResolvedValue({
        versions: [],
        total: 0,
      });

      const { status, body } = await request('GET', VERSIONS_BASE);

      expect(status).toBe(200);
      expect(body.limit).toBe(50);
      expect(body.offset).toBe(0);
      expect(body.hasMore).toBe(false);
    });

    test('returns hasMore=false when all versions fit in page', async () => {
      mockVersionServiceInstance.listVersions.mockResolvedValue({
        versions: [{ id: 'v1', version: '0.1.0', status: 'draft' }],
        total: 1,
      });

      const { status, body } = await request('GET', `${VERSIONS_BASE}?limit=10&offset=0`);

      expect(status).toBe(200);
      expect(body.hasMore).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /:version — get version detail
  // ---------------------------------------------------------------------------
  describe('GET /:version (get version)', () => {
    test('returns 200 with version detail', async () => {
      const versionRecord = {
        id: 'v1',
        version: '0.1.0',
        status: 'draft',
        dslContent: 'AGENT my_agent',
        irContent: '{}',
        sourceHash: 'abc123',
      };
      mockVersionServiceInstance.getVersion.mockResolvedValue(versionRecord);

      const { status, body } = await request('GET', `${VERSIONS_BASE}/0.1.0`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.version).toEqual(versionRecord);
    });

    test('returns 404 when version not found', async () => {
      mockVersionServiceInstance.getVersion.mockResolvedValue(null);

      const { status, body } = await request('GET', `${VERSIONS_BASE}/9.9.9`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });
  });

  // ---------------------------------------------------------------------------
  // POST /:version/promote — promote version
  // ---------------------------------------------------------------------------
  describe('POST /:version/promote', () => {
    test('returns 200 on successful promotion', async () => {
      mockVersionServiceInstance.promoteVersion.mockResolvedValue({
        id: 'v1',
        version: '0.1.0',
        status: 'testing',
        previousStatus: 'draft',
      });

      const { status, body } = await request('POST', `${VERSIONS_BASE}/0.1.0/promote`, {
        body: { targetStatus: 'testing' },
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.version.status).toBe('testing');
      expect(body.version.previousStatus).toBe('draft');
    });

    test('returns 400 when targetStatus is missing', async () => {
      const { status, body } = await request('POST', `${VERSIONS_BASE}/0.1.0/promote`, {
        body: {},
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('targetStatus');
    });

    test('returns 400 when targetStatus is invalid', async () => {
      const { status, body } = await request('POST', `${VERSIONS_BASE}/0.1.0/promote`, {
        body: { targetStatus: 'invalid_status' },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Invalid targetStatus');
    });

    test('returns 422 on invalid status transition', async () => {
      mockVersionServiceInstance.promoteVersion.mockRejectedValue(
        new Error("Cannot transition from 'deprecated' to 'active'"),
      );

      const { status, body } = await request('POST', `${VERSIONS_BASE}/0.1.0/promote`, {
        body: { targetStatus: 'active' },
      });

      expect(status).toBe(422);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Cannot transition');
    });

    test('returns 404 when version not found during promotion', async () => {
      mockVersionServiceInstance.promoteVersion.mockRejectedValue(
        new Error("Version '0.1.0' not found"),
      );

      const { status, body } = await request('POST', `${VERSIONS_BASE}/0.1.0/promote`, {
        body: { targetStatus: 'testing' },
      });

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });

    test('returns 409 on concurrent modification', async () => {
      mockVersionServiceInstance.promoteVersion.mockRejectedValue(
        new Error("Concurrent modification: version '0.1.0' status changed since read"),
      );

      const { status, body } = await request('POST', `${VERSIONS_BASE}/0.1.0/promote`, {
        body: { targetStatus: 'testing' },
      });

      expect(status).toBe(409);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Concurrent modification');
    });
  });

  // ---------------------------------------------------------------------------
  // GET /:version/diff/:otherVersion — diff two versions
  // ---------------------------------------------------------------------------
  describe('GET /:version/diff/:otherVersion', () => {
    test('returns 200 with diff data for two versions', async () => {
      const diffResult = {
        a: {
          version: '0.1.0',
          status: 'draft',
          dslContent: 'AGENT v1',
          sourceHash: 'h1',
          createdAt: new Date().toISOString(),
        },
        b: {
          version: '0.1.1',
          status: 'testing',
          dslContent: 'AGENT v2',
          sourceHash: 'h2',
          createdAt: new Date().toISOString(),
        },
      };
      mockVersionServiceInstance.diffVersions.mockResolvedValue(diffResult);

      const { status, body } = await request('GET', `${VERSIONS_BASE}/0.1.0/diff/0.1.1`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.diff.a.version).toBe('0.1.0');
      expect(body.diff.b.version).toBe('0.1.1');
    });

    test('returns 404 when one version is not found', async () => {
      mockVersionServiceInstance.diffVersions.mockRejectedValue(
        new Error("Version '9.9.9' not found"),
      );

      const { status, body } = await request('GET', `${VERSIONS_BASE}/0.1.0/diff/9.9.9`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });
  });
});

// =============================================================================
// PROJECT-AGENTS ROUTES  — /api/projects/:projectId/agents
// =============================================================================

const AGENTS_BASE = '/api/projects/proj-1/agents';

describe('Project-Agents Routes', () => {
  // ---------------------------------------------------------------------------
  // GET / — list agents
  // ---------------------------------------------------------------------------
  describe('GET / (list agents)', () => {
    test('returns 200 with agents list', async () => {
      mockDb.project.findFirst.mockResolvedValue({ id: 'proj-1', tenantId: 'tenant-1' });
      mockDb.projectAgent.findMany.mockResolvedValue([
        {
          id: 'a1',
          name: 'agent_one',
          agentPath: 'proj-1/agent_one',
          description: 'First agent',
          activeVersions: '{"default":"0.1.0"}',
          _count: { versions: 3 },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'a2',
          name: 'agent_two',
          agentPath: 'proj-1/agent_two',
          description: 'Second agent',
          activeVersions: null,
          _count: { versions: 0 },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const { status, body } = await request('GET', AGENTS_BASE);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.agents).toHaveLength(2);
      expect(body.agents[0].name).toBe('agent_one');
      expect(body.agents[0].versionCount).toBe(3);
      expect(body.agents[0].activeVersions).toEqual({ default: '0.1.0' });
      expect(body.agents[1].activeVersions).toEqual({});
    });

    // NOTE: "project not found" is now handled by requireProjectPermission (tested in versions-authz.test.ts)
  });

  // ---------------------------------------------------------------------------
  // GET /:agentName — get agent detail
  // ---------------------------------------------------------------------------
  describe('GET /:agentName', () => {
    test('returns 200 with agent detail and version count', async () => {
      mockDb.projectAgent.findFirst.mockResolvedValue({
        id: 'a1',
        name: 'my_agent',
        agentPath: 'proj-1/my_agent',
        description: 'Test agent',
        dslContent: 'AGENT my_agent\n  GOAL: Help',
        activeVersions: '{"default":"0.2.0"}',
        _count: { versions: 5 },
        project: { tenantId: 'tenant-1' },
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const { status, body } = await request('GET', `${AGENTS_BASE}/my_agent`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.agent.name).toBe('my_agent');
      expect(body.agent.dslContent).toContain('AGENT my_agent');
      expect(body.agent.versionCount).toBe(5);
      expect(body.agent.activeVersions).toEqual({ default: '0.2.0' });
    });

    test('returns 404 when agent not found', async () => {
      mockDb.projectAgent.findFirst.mockResolvedValue(null);

      const { status, body } = await request('GET', `${AGENTS_BASE}/nonexistent`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Agent not found');
    });

    test('returns 404 when agent belongs to different tenant', async () => {
      mockDb.projectAgent.findFirst.mockResolvedValue({
        id: 'a1',
        name: 'my_agent',
        project: { tenantId: 'other-tenant' },
      });

      const { status, body } = await request('GET', `${AGENTS_BASE}/my_agent`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Agent not found');
    });
  });

  // ---------------------------------------------------------------------------
  // PUT /:agentName/dsl — save working copy
  // ---------------------------------------------------------------------------
  describe('PUT /:agentName/dsl', () => {
    test('returns 200 on successful DSL update', async () => {
      const now = new Date();
      mockDb.projectAgent.findFirst.mockResolvedValue({
        id: 'a1',
        name: 'my_agent',
        dslContent: 'AGENT my_agent\n  GOAL: Old goal',
        project: { tenantId: 'tenant-1' },
      });
      mockDb.projectAgent.update.mockResolvedValue({
        updatedAt: now,
      });

      const { status, body } = await request('PUT', `${AGENTS_BASE}/my_agent/dsl`, {
        body: { dslContent: 'AGENT my_agent\n  GOAL: New goal' },
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.updatedAt).toBeDefined();
    });

    test('returns 409 when raw DSL save renames the persisted agent header', async () => {
      mockDb.projectAgent.findFirst.mockResolvedValue({
        id: 'a1',
        name: 'my_agent',
        dslContent: 'AGENT: my_agent\nGOAL: "Old goal"',
        project: { tenantId: 'tenant-1' },
      });

      const { status, body } = await request('PUT', `${AGENTS_BASE}/my_agent/dsl`, {
        body: { dslContent: 'AGENT: other_agent\nGOAL: "Rename through raw save"' },
      });

      expect(status).toBe(409);
      expect(body).toMatchObject({
        success: false,
        code: 'AGENT_DSL_NAME_MISMATCH',
        declaredName: 'other_agent',
        recordName: 'my_agent',
      });
      expect(mockDb.projectAgent.update).not.toHaveBeenCalled();
    });

    test('returns 400 when dslContent is missing', async () => {
      const { status, body } = await request('PUT', `${AGENTS_BASE}/my_agent/dsl`, {
        body: {},
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.details).toBeDefined();
      expect(body.details[0].path).toContain('dslContent');
    });

    test('returns 400 when dslContent is empty string', async () => {
      const { status, body } = await request('PUT', `${AGENTS_BASE}/my_agent/dsl`, {
        body: { dslContent: '' },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.details).toBeDefined();
      expect(body.details[0].message).toContain('empty');
    });

    test('returns 404 when agent not found', async () => {
      mockDb.projectAgent.findFirst.mockResolvedValue(null);

      const { status, body } = await request('PUT', `${AGENTS_BASE}/my_agent/dsl`, {
        body: { dslContent: 'AGENT my_agent\n  GOAL: Update' },
      });

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Agent not found');
    });

    test('returns 404 when agent belongs to different tenant', async () => {
      mockDb.projectAgent.findFirst.mockResolvedValue({
        id: 'a1',
        name: 'my_agent',
        dslContent: 'AGENT my_agent',
        project: { tenantId: 'other-tenant' },
      });

      const { status, body } = await request('PUT', `${AGENTS_BASE}/my_agent/dsl`, {
        body: { dslContent: 'AGENT my_agent\n  GOAL: Sneaky update' },
      });

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Agent not found');
    });
  });
});

// =============================================================================
// AGENT NAME VALIDATION — tests for validateAgentName middleware
// =============================================================================

describe('Agent Name Validation', () => {
  test('project-agents: rejects agent name starting with digit', async () => {
    vi.mocked(validateAgentName).mockReturnValueOnce(
      'Agent name must start with a letter and contain only letters, digits, and underscores',
    );

    const { status, body } = await request('GET', `${AGENTS_BASE}/2bad_name`);

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toContain('must start with a letter');
  });

  test('project-agents: rejects agent name with hyphens', async () => {
    vi.mocked(validateAgentName).mockReturnValueOnce(
      'Agent name must start with a letter and contain only letters, digits, and underscores',
    );

    const { status, body } = await request('GET', `${AGENTS_BASE}/my-agent`);

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toContain('must start with a letter');
  });

  test('versions: rejects invalid agent name in parent param', async () => {
    vi.mocked(validateAgentName).mockReturnValueOnce(
      'Agent name must start with a letter and contain only letters, digits, and underscores',
    );

    const { status, body } = await request('GET', '/api/projects/proj-1/agents/bad-name/versions');

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toContain('must start with a letter');
  });

  test('allows valid agent names through', async () => {
    // validateAgentName mock returns null (default) — name is valid
    mockDb.projectAgent.findFirst.mockResolvedValue({
      id: 'a1',
      name: 'valid_agent',
      agentPath: 'proj-1/valid_agent',
      dslContent: 'AGENT valid_agent',
      project: { tenantId: 'tenant-1' },
      _count: { versions: 0 },
      activeVersions: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { status, body } = await request('GET', `${AGENTS_BASE}/valid_agent`);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  test('PUT dsl: rejects invalid agent name', async () => {
    vi.mocked(validateAgentName).mockReturnValueOnce(
      'Agent name must start with a letter and contain only letters, digits, and underscores',
    );

    const { status, body } = await request('PUT', `${AGENTS_BASE}/_invalid/dsl`, {
      body: { dslContent: 'AGENT _invalid\n  GOAL: Hack' },
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toContain('must start with a letter');
  });
});

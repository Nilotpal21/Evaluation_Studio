/**
 * Module Consumers & Release Detail Route Tests
 *
 * Covers:
 *   GET  /api/projects/:id/module/consumers                        — List consumers
 *   GET  /api/projects/:id/module/releases/:releaseId              — Release detail
 *   POST /api/projects/:id/module/releases/:releaseId              — Archive release
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// =============================================================================
// MOCKS
// =============================================================================

vi.mock('server-only', () => ({}));

// Feature resolver — always enabled so module routes proceed
vi.mock('@/lib/feature-resolver', () => ({
  isFeatureEnabled: vi.fn().mockResolvedValue(true),
}));

// Auth
const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);

vi.mock('@/lib/auth', () => ({
  requireAuth: mockRequireAuth,
  isAuthError: mockIsAuthError,
}));

vi.mock('@/services/auth-service', () => ({ verifyAccessToken: vi.fn() }));
vi.mock('@/repos/auth-repo', () => ({ findUserById: vi.fn() }));

// Project access
const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn(() => false);

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: mockRequireProjectAccess,
  isAccessError: mockIsAccessError,
}));

// Permissions
vi.mock('@/lib/permission-resolver', () => ({
  hasPermission: vi.fn(() => true),
  hasAnyPermission: vi.fn(() => true),
}));

// Ensure DB
vi.mock('@/lib/ensure-db', () => ({
  ensureDb: vi.fn().mockResolvedValue(undefined),
}));

// Audit service
vi.mock('@/services/audit-service', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
  AuditActions: {
    MODULE_ENABLED: 'module_enabled',
    MODULE_DISABLED: 'module_disabled',
    MODULE_PUBLISHED: 'module_published',
    MODULE_PROMOTED: 'module_promoted',
    MODULE_RELEASE_ARCHIVED: 'module_release_archived',
  },
}));

// Database models — set up stubs; overridden per-test via beforeEach
const mockProjectModuleDependencyFind = vi.fn();
const mockProjectModuleDependencyExists = vi.fn();
const mockProjectModuleDependencyCountDocuments = vi.fn();
const mockProjectFind = vi.fn();
const mockDeploymentFind = vi.fn();
const mockDeploymentExists = vi.fn();
const mockDeploymentModuleSnapshotFind = vi.fn();
const mockDeploymentModuleSnapshotExists = vi.fn();
const mockModuleReleaseFindOne = vi.fn();
const mockModuleReleaseFindOneAndUpdate = vi.fn();
const mockModuleEnvironmentPointerExists = vi.fn();
const mockResolveSelector = vi.fn();

vi.mock('@agent-platform/project-io', () => ({
  resolveSelector: (...args: unknown[]) => mockResolveSelector(...args),
}));

vi.mock('@agent-platform/database/models', () => ({
  ProjectModuleDependency: {
    find: (...args: unknown[]) => mockProjectModuleDependencyFind(...args),
    exists: (...args: unknown[]) => mockProjectModuleDependencyExists(...args),
    countDocuments: (...args: unknown[]) => mockProjectModuleDependencyCountDocuments(...args),
  },
  Project: {
    find: (...args: unknown[]) => mockProjectFind(...args),
  },
  Deployment: {
    find: (...args: unknown[]) => mockDeploymentFind(...args),
    exists: (...args: unknown[]) => mockDeploymentExists(...args),
  },
  DeploymentModuleSnapshot: {
    find: (...args: unknown[]) => mockDeploymentModuleSnapshotFind(...args),
    exists: (...args: unknown[]) => mockDeploymentModuleSnapshotExists(...args),
  },
  ModuleRelease: {
    findOne: (...args: unknown[]) => mockModuleReleaseFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mockModuleReleaseFindOneAndUpdate(...args),
  },
  ModuleEnvironmentPointer: {
    exists: (...args: unknown[]) => mockModuleEnvironmentPointerExists(...args),
  },
}));

// Validation — pass-through actual parseInput
vi.mock('@agent-platform/shared/validation', async () => {
  const actual = await vi.importActual<typeof import('@agent-platform/shared/validation')>(
    '@agent-platform/shared/validation',
  );
  return { ...actual };
});

// =============================================================================
// CONSTANTS
// =============================================================================

const PROJECT_ID = 'proj-module-1';
const TENANT_ID = 'tenant-1';
const RELEASE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const CONSUMER_PROJECT_1 = 'proj-consumer-1';
const CONSUMER_PROJECT_2 = 'proj-consumer-2';

const testUser = {
  id: 'user-1',
  email: 'test@example.com',
  name: 'Test User',
  tenantId: TENANT_ID,
  permissions: ['*:*'],
};

const testProject = {
  _id: PROJECT_ID,
  tenantId: TENANT_ID,
  name: 'Module Project',
};

// =============================================================================
// HELPERS
// =============================================================================

type RouteCtx = { params: Promise<Record<string, string>> };

function makeRequest(url: string, method = 'GET', body?: unknown): NextRequest {
  const opts: Record<string, unknown> = {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return new NextRequest(new URL(url, 'http://localhost:3000'), opts);
}

function routeCtx(params: Record<string, string>): RouteCtx {
  return { params: Promise.resolve(params) };
}

// =============================================================================
// SETUP
// =============================================================================

beforeEach(() => {
  vi.clearAllMocks();

  // Auth succeeds
  mockRequireAuth.mockResolvedValue(testUser);
  mockIsAuthError.mockReturnValue(false);

  // Project access succeeds
  mockRequireProjectAccess.mockResolvedValue({ project: testProject });
  mockIsAccessError.mockReturnValue(false);

  // Default: countDocuments returns 0 (overridden per-test as needed)
  mockProjectModuleDependencyCountDocuments.mockResolvedValue(0);
  mockResolveSelector.mockResolvedValue({ error: 'No environment pointer configured' });
  mockDeploymentFind.mockReturnValue({
    select: () => ({
      lean: () => Promise.resolve([]),
    }),
  });
  mockDeploymentExists.mockResolvedValue(null);
});

// =============================================================================
// CONSUMERS — GET /api/projects/:id/module/consumers
// =============================================================================

describe('Module Consumers Route', () => {
  describe('GET /api/projects/:id/module/consumers', () => {
    it('returns consumers listed correctly with project names', async () => {
      mockProjectModuleDependencyCountDocuments.mockResolvedValue(2);
      const dependencies = [
        {
          _id: 'dep-1',
          projectId: CONSUMER_PROJECT_1,
          moduleProjectId: PROJECT_ID,
          alias: 'auth',
          resolvedVersion: '1.0.0',
          resolvedReleaseId: 'rel-1',
          selector: { type: 'semver', value: '^1.0.0' },
          createdAt: '2026-03-01T00:00:00Z',
        },
        {
          _id: 'dep-2',
          projectId: CONSUMER_PROJECT_2,
          moduleProjectId: PROJECT_ID,
          alias: 'auth-v2',
          resolvedVersion: '2.0.0',
          resolvedReleaseId: 'rel-2',
          selector: { type: 'environment', value: 'production' },
          createdAt: '2026-03-02T00:00:00Z',
        },
      ];

      mockProjectModuleDependencyFind.mockReturnValue({
        sort: () => ({
          limit: () => ({
            lean: () => Promise.resolve(dependencies),
          }),
        }),
      });

      mockProjectFind.mockReturnValue({
        select: () => ({
          lean: () =>
            Promise.resolve([
              { _id: CONSUMER_PROJECT_1, name: 'Consumer App 1' },
              { _id: CONSUMER_PROJECT_2, name: 'Consumer App 2' },
            ]),
        }),
      });

      mockDeploymentModuleSnapshotFind.mockReturnValue({
        select: () => ({
          lean: () => Promise.resolve([]),
        }),
      });

      const { GET } = await import('@/app/api/projects/[id]/module/consumers/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module/consumers`);
      const res = await GET(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(2);
      expect(json.data[0].projectName).toBe('Consumer App 1');
      expect(json.data[0].alias).toBe('auth');
      expect(json.data[1].projectName).toBe('Consumer App 2');
      expect(json.data[1].alias).toBe('auth-v2');
    });

    it('cross-tenant returns empty — consumers from different tenant not visible', async () => {
      // When moduleProjectId filter scoped to tenantId finds no dependencies
      mockProjectModuleDependencyFind.mockReturnValue({
        sort: () => ({
          limit: () => ({
            lean: () => Promise.resolve([]),
          }),
        }),
      });

      const { GET } = await import('@/app/api/projects/[id]/module/consumers/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module/consumers`);
      const res = await GET(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(0);
      expect(json.summary.totalConsumers).toBe(0);

      // Verify the query was scoped to tenantId
      expect(mockProjectModuleDependencyFind).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT_ID,
          moduleProjectId: PROJECT_ID,
        }),
      );
    });

    it('active deployment indicator — consumer with active deployment shows hasActiveDeployment: true', async () => {
      mockProjectModuleDependencyCountDocuments.mockResolvedValue(2);
      const dependencies = [
        {
          _id: 'dep-1',
          projectId: CONSUMER_PROJECT_1,
          moduleProjectId: PROJECT_ID,
          alias: 'auth',
          resolvedVersion: '1.0.0',
          resolvedReleaseId: 'rel-active',
          selector: { type: 'semver', value: '^1.0.0' },
          createdAt: '2026-03-01T00:00:00Z',
        },
        {
          _id: 'dep-2',
          projectId: CONSUMER_PROJECT_2,
          moduleProjectId: PROJECT_ID,
          alias: 'auth-v2',
          resolvedVersion: '2.0.0',
          resolvedReleaseId: 'rel-inactive',
          selector: { type: 'environment', value: 'staging' },
          createdAt: '2026-03-02T00:00:00Z',
        },
      ];

      mockProjectModuleDependencyFind.mockReturnValue({
        sort: () => ({
          limit: () => ({
            lean: () => Promise.resolve(dependencies),
          }),
        }),
      });

      mockProjectFind.mockReturnValue({
        select: () => ({
          lean: () =>
            Promise.resolve([
              { _id: CONSUMER_PROJECT_1, name: 'App 1' },
              { _id: CONSUMER_PROJECT_2, name: 'App 2' },
            ]),
        }),
      });

      // Both releases have retained snapshots, but only rel-active is from a live deployment.
      mockDeploymentModuleSnapshotFind.mockReturnValue({
        select: () => ({
          lean: () =>
            Promise.resolve([
              { deploymentId: 'deploy-active', moduleReleaseIds: ['rel-active'] },
              { deploymentId: 'deploy-retired', moduleReleaseIds: ['rel-inactive'] },
            ]),
        }),
      });
      mockDeploymentFind.mockReturnValue({
        select: () => ({
          lean: () => Promise.resolve([{ _id: 'deploy-active' }]),
        }),
      });

      const { GET } = await import('@/app/api/projects/[id]/module/consumers/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module/consumers`);
      const res = await GET(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.data[0].hasActiveDeployment).toBe(true);
      expect(json.data[1].hasActiveDeployment).toBe(false);
      expect(json.summary.activeDeployments).toBe(1);
    });

    it('resolves environment selector consumers live before active deployment checks', async () => {
      mockProjectModuleDependencyCountDocuments.mockResolvedValue(1);
      const dependencies = [
        {
          _id: 'dep-env',
          projectId: CONSUMER_PROJECT_1,
          moduleProjectId: PROJECT_ID,
          alias: 'auth-env',
          resolvedVersion: '1.0.0',
          resolvedReleaseId: 'rel-stale',
          selector: { type: 'environment', value: 'production' },
          createdAt: '2026-03-01T00:00:00Z',
        },
      ];

      mockProjectModuleDependencyFind.mockReturnValue({
        sort: () => ({
          limit: () => ({
            lean: () => Promise.resolve(dependencies),
          }),
        }),
      });
      mockProjectFind.mockReturnValue({
        select: () => ({
          lean: () => Promise.resolve([{ _id: CONSUMER_PROJECT_1, name: 'App 1' }]),
        }),
      });
      mockResolveSelector.mockResolvedValue({ releaseId: 'rel-live', version: '2.0.0' });
      mockDeploymentModuleSnapshotFind.mockReturnValue({
        select: () => ({
          lean: () =>
            Promise.resolve([{ deploymentId: 'deploy-live', moduleReleaseIds: ['rel-live'] }]),
        }),
      });
      mockDeploymentFind.mockReturnValue({
        select: () => ({
          lean: () => Promise.resolve([{ _id: 'deploy-live' }]),
        }),
      });

      const { GET } = await import('@/app/api/projects/[id]/module/consumers/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module/consumers`);
      const res = await GET(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.data[0].resolvedReleaseId).toBe('rel-live');
      expect(json.data[0].resolvedVersion).toBe('2.0.0');
      expect(json.data[0].hasActiveDeployment).toBe(true);
      expect(mockResolveSelector).toHaveBeenCalledWith(TENANT_ID, PROJECT_ID, {
        type: 'environment',
        value: 'production',
      });
    });

    it('cursor pagination — returns correct page with nextCursor', async () => {
      mockProjectModuleDependencyCountDocuments.mockResolvedValue(3);
      // Simulate limit+1 results (limit=2, so 3 results returned)
      const dependencies = [
        {
          _id: 'dep-3',
          projectId: CONSUMER_PROJECT_1,
          moduleProjectId: PROJECT_ID,
          alias: 'a',
          resolvedVersion: '1.0.0',
          resolvedReleaseId: 'rel-1',
          selector: { type: 'semver', value: '^1.0.0' },
          createdAt: '2026-03-03T00:00:00Z',
        },
        {
          _id: 'dep-2',
          projectId: CONSUMER_PROJECT_2,
          moduleProjectId: PROJECT_ID,
          alias: 'b',
          resolvedVersion: '1.0.0',
          resolvedReleaseId: 'rel-1',
          selector: { type: 'semver', value: '^1.0.0' },
          createdAt: '2026-03-02T00:00:00Z',
        },
        {
          _id: 'dep-1',
          projectId: CONSUMER_PROJECT_1,
          moduleProjectId: PROJECT_ID,
          alias: 'c',
          resolvedVersion: '1.0.0',
          resolvedReleaseId: 'rel-1',
          selector: { type: 'semver', value: '^1.0.0' },
          createdAt: '2026-03-01T00:00:00Z',
        },
      ];

      mockProjectModuleDependencyFind.mockReturnValue({
        sort: () => ({
          limit: () => ({
            lean: () => Promise.resolve(dependencies),
          }),
        }),
      });

      mockProjectFind.mockReturnValue({
        select: () => ({
          lean: () =>
            Promise.resolve([
              { _id: CONSUMER_PROJECT_1, name: 'App 1' },
              { _id: CONSUMER_PROJECT_2, name: 'App 2' },
            ]),
        }),
      });

      mockDeploymentModuleSnapshotFind.mockReturnValue({
        select: () => ({
          lean: () => Promise.resolve([]),
        }),
      });

      const { GET } = await import('@/app/api/projects/[id]/module/consumers/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module/consumers?limit=2`);
      const res = await GET(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.data).toHaveLength(2);
      expect(json.pagination.hasMore).toBe(true);
      expect(json.pagination.nextCursor).toBe('dep-2');
    });
  });
});

// =============================================================================
// RELEASE DETAIL — GET /api/projects/:id/module/releases/:releaseId
// =============================================================================

describe('Release Detail Route', () => {
  describe('GET /api/projects/:id/module/releases/:releaseId', () => {
    it('returns release fields excluding compiledIR', async () => {
      mockModuleReleaseFindOne.mockReturnValue({
        lean: () =>
          Promise.resolve({
            _id: RELEASE_ID,
            tenantId: TENANT_ID,
            moduleProjectId: PROJECT_ID,
            version: '1.0.0',
            releaseNotes: 'Initial release',
            contract: { providedAgents: ['Agent1'], providedTools: ['tool1'] },
            artifact: { agents: {}, tools: {} },
            compiledIR: { agents: { Agent1: { name: 'Agent1' } } },
            sourceHash: 'abc123',
            createdBy: 'user-1',
            createdAt: '2026-03-01T00:00:00Z',
            archivedAt: null,
            archivedBy: null,
          }),
      });

      const { GET } = await import('@/app/api/projects/[id]/module/releases/[releaseId]/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module/releases/${RELEASE_ID}`);
      const res = await GET(req, routeCtx({ id: PROJECT_ID, releaseId: RELEASE_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data.id).toBe(RELEASE_ID);
      expect(json.data.version).toBe('1.0.0');
      expect(json.data.releaseNotes).toBe('Initial release');
      expect(json.data.contract).toEqual({
        providedAgents: ['Agent1'],
        providedTools: ['tool1'],
      });
      expect(json.data.sourceHash).toBe('abc123');
      expect(json.data.createdBy).toBe('user-1');
      expect(json.data.archivedAt).toBeNull();
      // compiledIR must NOT be in the response
      expect(json.data.compiledIR).toBeUndefined();
    });

    it('returns 404 when release not found', async () => {
      mockModuleReleaseFindOne.mockReturnValue({
        lean: () => Promise.resolve(null),
      });

      const { GET } = await import('@/app/api/projects/[id]/module/releases/[releaseId]/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module/releases/nonexistent-id`);
      const res = await GET(req, routeCtx({ id: PROJECT_ID, releaseId: 'nonexistent-id' }));
      const json = await res.json();

      expect(res.status).toBe(404);
      expect(json.success).toBe(false);
      expect(json.errors[0].code).toBe('NOT_FOUND');
    });
  });
});

// =============================================================================
// ARCHIVE — POST /api/projects/:id/module/releases/:releaseId
// =============================================================================

describe('Archive Release Route', () => {
  describe('POST /api/projects/:id/module/releases/:releaseId', () => {
    it('archive blocked by active deployment snapshot — returns 409', async () => {
      // Release exists and is not archived
      mockModuleReleaseFindOne.mockReturnValue({
        lean: () =>
          Promise.resolve({
            _id: RELEASE_ID,
            tenantId: TENANT_ID,
            moduleProjectId: PROJECT_ID,
            version: '1.0.0',
            archivedAt: null,
          }),
      });

      // No environment pointer
      mockModuleEnvironmentPointerExists.mockResolvedValue(null);

      // DeploymentModuleSnapshot references this release from an active deployment.
      mockDeploymentModuleSnapshotFind.mockReturnValue({
        select: () => ({
          lean: () => Promise.resolve([{ _id: 'snap-1', deploymentId: 'deploy-active' }]),
        }),
      });
      mockDeploymentExists.mockResolvedValue({ _id: 'deploy-active' });

      const { POST } = await import('@/app/api/projects/[id]/module/releases/[releaseId]/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module/releases/${RELEASE_ID}`, 'POST', {
        action: 'archive',
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID, releaseId: RELEASE_ID }));
      const json = await res.json();

      expect(res.status).toBe(409);
      expect(json.success).toBe(false);
      expect(json.errors[0].msg).toContain('active deployment');
    });

    it('archive blocked by environment pointer — returns 409', async () => {
      mockModuleReleaseFindOne.mockReturnValue({
        lean: () =>
          Promise.resolve({
            _id: RELEASE_ID,
            tenantId: TENANT_ID,
            moduleProjectId: PROJECT_ID,
            version: '1.0.0',
            archivedAt: null,
          }),
      });

      // Environment pointer references this release
      mockModuleEnvironmentPointerExists.mockResolvedValue({ _id: 'ptr-1' });

      const { POST } = await import('@/app/api/projects/[id]/module/releases/[releaseId]/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module/releases/${RELEASE_ID}`, 'POST', {
        action: 'archive',
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID, releaseId: RELEASE_ID }));
      const json = await res.json();

      expect(res.status).toBe(409);
      expect(json.success).toBe(false);
      expect(json.errors[0].msg).toContain('environment pointer');
    });

    it('archive blocked by dependency reference — returns 409', async () => {
      mockModuleReleaseFindOne.mockReturnValue({
        lean: () =>
          Promise.resolve({
            _id: RELEASE_ID,
            tenantId: TENANT_ID,
            moduleProjectId: PROJECT_ID,
            version: '1.0.0',
            archivedAt: null,
          }),
      });

      // No environment pointer
      mockModuleEnvironmentPointerExists.mockResolvedValue(null);

      // No deployment snapshot
      mockDeploymentModuleSnapshotFind.mockReturnValue({
        select: () => ({
          lean: () => Promise.resolve([]),
        }),
      });

      // ProjectModuleDependency references this release (pre-Phase-2 fallback)
      mockProjectModuleDependencyExists.mockResolvedValue({ _id: 'dep-1' });
      mockProjectModuleDependencyFind.mockReturnValue({
        select: () => ({
          lean: () =>
            Promise.resolve([
              {
                _id: 'dep-1',
                projectId: CONSUMER_PROJECT_1,
                resolvedReleaseId: RELEASE_ID,
                selector: { type: 'version', value: '1.0.0' },
              },
            ]),
        }),
      });

      const { POST } = await import('@/app/api/projects/[id]/module/releases/[releaseId]/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module/releases/${RELEASE_ID}`, 'POST', {
        action: 'archive',
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID, releaseId: RELEASE_ID }));
      const json = await res.json();

      expect(res.status).toBe(409);
      expect(json.success).toBe(false);
      expect(json.errors[0].msg).toContain('consumer projects');
    });

    it('archive returns 400 when release is already archived — GAP-012', async () => {
      mockModuleReleaseFindOne.mockReturnValue({
        lean: () =>
          Promise.resolve({
            _id: RELEASE_ID,
            tenantId: TENANT_ID,
            moduleProjectId: PROJECT_ID,
            version: '1.0.0',
            archivedAt: new Date('2026-03-20'),
            archivedBy: 'user-1',
          }),
      });

      const { POST } = await import('@/app/api/projects/[id]/module/releases/[releaseId]/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module/releases/${RELEASE_ID}`, 'POST', {
        action: 'archive',
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID, releaseId: RELEASE_ID }));
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.errors[0].msg).toContain('already archived');

      // Verify no guard checks were invoked (we short-circuit before them)
      expect(mockModuleEnvironmentPointerExists).not.toHaveBeenCalled();
      expect(mockDeploymentModuleSnapshotFind).not.toHaveBeenCalled();
      expect(mockProjectModuleDependencyExists).not.toHaveBeenCalled();
    });

    it('archive ignores stale retained snapshots from retired deployments', async () => {
      const now = new Date();

      mockModuleReleaseFindOne.mockReturnValue({
        lean: () =>
          Promise.resolve({
            _id: RELEASE_ID,
            tenantId: TENANT_ID,
            moduleProjectId: PROJECT_ID,
            version: '1.0.0',
            archivedAt: null,
          }),
      });
      mockModuleEnvironmentPointerExists.mockResolvedValue(null);
      mockDeploymentModuleSnapshotFind.mockReturnValue({
        select: () => ({
          lean: () => Promise.resolve([{ _id: 'snap-1', deploymentId: 'deploy-retired' }]),
        }),
      });
      mockDeploymentExists.mockResolvedValue(null);
      mockProjectModuleDependencyFind.mockReturnValue({
        select: () => ({
          lean: () => Promise.resolve([]),
        }),
      });
      mockModuleReleaseFindOneAndUpdate.mockReturnValue({
        lean: () =>
          Promise.resolve({
            _id: RELEASE_ID,
            version: '1.0.0',
            archivedAt: now.toISOString(),
            archivedBy: 'user-1',
          }),
      });

      const { POST } = await import('@/app/api/projects/[id]/module/releases/[releaseId]/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module/releases/${RELEASE_ID}`, 'POST', {
        action: 'archive',
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID, releaseId: RELEASE_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(mockDeploymentExists).toHaveBeenCalledWith({
        _id: { $in: ['deploy-retired'] },
        tenantId: TENANT_ID,
        status: { $in: ['active', 'draining'] },
      });
    });

    it('archive ignores stale environment-selector dependency rows after the pointer moved', async () => {
      const now = new Date();

      mockModuleReleaseFindOne.mockReturnValue({
        lean: () =>
          Promise.resolve({
            _id: RELEASE_ID,
            tenantId: TENANT_ID,
            moduleProjectId: PROJECT_ID,
            version: '1.0.0',
            archivedAt: null,
          }),
      });
      mockModuleEnvironmentPointerExists.mockResolvedValue(null);
      mockDeploymentModuleSnapshotFind.mockReturnValue({
        select: () => ({
          lean: () => Promise.resolve([]),
        }),
      });
      mockProjectModuleDependencyExists.mockResolvedValue({ _id: 'dep-stale' });
      mockProjectModuleDependencyFind.mockReturnValue({
        select: () => ({
          lean: () =>
            Promise.resolve([
              {
                _id: 'dep-stale',
                projectId: CONSUMER_PROJECT_1,
                resolvedReleaseId: RELEASE_ID,
                selector: { type: 'environment', value: 'production' },
              },
            ]),
        }),
      });
      mockResolveSelector.mockResolvedValue({
        releaseId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
        version: '2.0.0',
      });
      mockModuleReleaseFindOneAndUpdate.mockReturnValue({
        lean: () =>
          Promise.resolve({
            _id: RELEASE_ID,
            version: '1.0.0',
            archivedAt: now.toISOString(),
            archivedBy: 'user-1',
          }),
      });

      const { POST } = await import('@/app/api/projects/[id]/module/releases/[releaseId]/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module/releases/${RELEASE_ID}`, 'POST', {
        action: 'archive',
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID, releaseId: RELEASE_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(mockResolveSelector).toHaveBeenCalledWith(TENANT_ID, PROJECT_ID, {
        type: 'environment',
        value: 'production',
      });
      expect(mockProjectModuleDependencyExists).not.toHaveBeenCalled();
    });

    it('archive success when unreferenced — archivedAt set', async () => {
      const now = new Date();

      mockModuleReleaseFindOne.mockReturnValue({
        lean: () =>
          Promise.resolve({
            _id: RELEASE_ID,
            tenantId: TENANT_ID,
            moduleProjectId: PROJECT_ID,
            version: '1.0.0',
            archivedAt: null,
          }),
      });

      // No environment pointer
      mockModuleEnvironmentPointerExists.mockResolvedValue(null);

      // No deployment snapshot
      mockDeploymentModuleSnapshotFind.mockReturnValue({
        select: () => ({
          lean: () => Promise.resolve([]),
        }),
      });

      // No dependency reference
      mockProjectModuleDependencyExists.mockResolvedValue(null);
      mockProjectModuleDependencyFind.mockReturnValue({
        select: () => ({
          lean: () => Promise.resolve([]),
        }),
      });

      // findOneAndUpdate succeeds
      mockModuleReleaseFindOneAndUpdate.mockReturnValue({
        lean: () =>
          Promise.resolve({
            _id: RELEASE_ID,
            version: '1.0.0',
            archivedAt: now.toISOString(),
            archivedBy: 'user-1',
          }),
      });

      const { POST } = await import('@/app/api/projects/[id]/module/releases/[releaseId]/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module/releases/${RELEASE_ID}`, 'POST', {
        action: 'archive',
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID, releaseId: RELEASE_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.message).toBe('Release archived');
      expect(json.releaseId).toBe(RELEASE_ID);
      expect(json.version).toBe('1.0.0');

      // Verify findOneAndUpdate was called with archive fields
      expect(mockModuleReleaseFindOneAndUpdate).toHaveBeenCalledWith(
        { _id: RELEASE_ID, tenantId: TENANT_ID, moduleProjectId: PROJECT_ID },
        {
          $set: {
            archivedAt: expect.any(Date),
            archivedBy: 'user-1',
          },
        },
        { new: true },
      );
    });
  });
});

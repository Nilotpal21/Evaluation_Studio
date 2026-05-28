/**
 * Module Catalog Route Tests
 *
 * Covers:
 *   GET /api/projects/:id/module-catalog                      — List visible modules
 *   GET /api/projects/:id/module-catalog/:moduleProjectId     — Module detail
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
    MODULE_IMPORTED: 'module_imported',
    MODULE_REMOVED: 'module_removed',
  },
}));

// Database models
const mockProjectFind = vi.fn();
const mockProjectFindOne = vi.fn();
const mockModuleReleaseAggregate = vi.fn();
const mockModuleReleaseFindChain = vi.fn();
const mockModuleEnvironmentPointerFind = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  Project: {
    find: (...args: unknown[]) => mockProjectFind(...args),
    findOne: (...args: unknown[]) => mockProjectFindOne(...args),
  },
  ModuleRelease: {
    aggregate: (...args: unknown[]) => mockModuleReleaseAggregate(...args),
    find: (...args: unknown[]) => mockModuleReleaseFindChain(...args),
  },
  ModuleEnvironmentPointer: {
    find: (...args: unknown[]) => mockModuleEnvironmentPointerFind(...args),
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

const PROJECT_ID = 'proj-consumer';
const TENANT_ID = 'tenant-1';
const MODULE_PROJECT_ID = 'proj-module-1';

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
  name: 'Consumer Project',
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
});

// =============================================================================
// CATALOG LIST — GET /api/projects/:id/module-catalog
// =============================================================================

describe('Module Catalog List Route', () => {
  describe('GET /api/projects/:id/module-catalog', () => {
    it('returns visible tenant-scoped modules with enriched data', async () => {
      // Project.find returns tenant-visible modules (excludes own project)
      mockProjectFind.mockReturnValue({
        select: () => ({
          sort: () => ({
            limit: () => ({
              lean: () =>
                Promise.resolve([
                  {
                    _id: MODULE_PROJECT_ID,
                    name: 'Auth Module',
                    description: 'Handles auth',
                    moduleVisibility: 'tenant',
                    createdAt: '2026-01-01',
                  },
                ]),
            }),
          }),
        }),
      });

      // Aggregate: latest release per module
      mockModuleReleaseAggregate.mockResolvedValue([
        {
          _id: MODULE_PROJECT_ID,
          version: '2.0.0',
          createdAt: '2026-03-01',
          contract: {
            providedAgents: ['AuthAgent', 'TokenAgent'],
            providedTools: ['validate_token'],
          },
        },
      ]);

      // Environment pointers
      mockModuleEnvironmentPointerFind.mockReturnValue({
        select: () => ({
          lean: () =>
            Promise.resolve([
              {
                moduleProjectId: MODULE_PROJECT_ID,
                environment: 'production',
                moduleReleaseId: 'rel-1',
                revision: 3,
              },
            ]),
        }),
      });

      const { GET } = await import('@/app/api/projects/[id]/module-catalog/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module-catalog`);
      const res = await GET(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);

      const mod = json.data[0];
      expect(mod.moduleProjectId).toBe(MODULE_PROJECT_ID);
      expect(mod.name).toBe('Auth Module');
      expect(mod.latestVersion).toBe('2.0.0');
      expect(mod.providedAgentCount).toBe(2);
      expect(mod.providedToolCount).toBe(1);
      expect(mod.environments).toHaveLength(1);
      expect(mod.environments[0].environment).toBe('production');
    });

    it('P1-I07: private module hidden from catalog — only tenant-visible modules returned', async () => {
      // Project.find should be called with visibility filter that excludes 'private'
      // Simulate: the DB query already filters, so result set contains no private modules
      mockProjectFind.mockReturnValue({
        select: () => ({
          sort: () => ({
            limit: () => ({
              lean: () => Promise.resolve([]),
            }),
          }),
        }),
      });

      mockModuleReleaseAggregate.mockResolvedValue([]);
      mockModuleEnvironmentPointerFind.mockReturnValue({
        select: () => ({
          lean: () => Promise.resolve([]),
        }),
      });

      const { GET } = await import('@/app/api/projects/[id]/module-catalog/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module-catalog`);
      const res = await GET(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(0);

      // Verify the filter passed to Project.find includes visibility constraints
      // and excludes the requesting project's own ID
      expect(mockProjectFind).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'module',
          tenantId: TENANT_ID,
          _id: { $ne: PROJECT_ID },
          $or: expect.arrayContaining([{ moduleVisibility: 'tenant' }]),
        }),
      );
    });

    it('P1-I13: catalog excludes own project via _id $ne filter', async () => {
      mockProjectFind.mockReturnValue({
        select: () => ({
          sort: () => ({
            limit: () => ({
              lean: () => Promise.resolve([]),
            }),
          }),
        }),
      });

      mockModuleReleaseAggregate.mockResolvedValue([]);
      mockModuleEnvironmentPointerFind.mockReturnValue({
        select: () => ({
          lean: () => Promise.resolve([]),
        }),
      });

      const { GET } = await import('@/app/api/projects/[id]/module-catalog/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module-catalog`);
      await GET(req, routeCtx({ id: PROJECT_ID }));

      // Verify the query includes _id: { $ne: projectId } to exclude self
      expect(mockProjectFind).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: { $ne: PROJECT_ID },
        }),
      );
    });

    it('returns modules with null latestVersion when no releases exist', async () => {
      mockProjectFind.mockReturnValue({
        select: () => ({
          sort: () => ({
            limit: () => ({
              lean: () =>
                Promise.resolve([
                  {
                    _id: MODULE_PROJECT_ID,
                    name: 'Empty Module',
                    description: null,
                    moduleVisibility: 'tenant',
                    createdAt: '2026-01-01',
                  },
                ]),
            }),
          }),
        }),
      });

      mockModuleReleaseAggregate.mockResolvedValue([]);
      mockModuleEnvironmentPointerFind.mockReturnValue({
        select: () => ({
          lean: () => Promise.resolve([]),
        }),
      });

      const { GET } = await import('@/app/api/projects/[id]/module-catalog/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module-catalog`);
      const res = await GET(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      const mod = json.data[0];
      expect(mod.latestVersion).toBeNull();
      expect(mod.latestReleaseDate).toBeNull();
      expect(mod.providedAgentCount).toBe(0);
      expect(mod.providedToolCount).toBe(0);
      expect(mod.environments).toHaveLength(0);
    });
  });
});

// =============================================================================
// CATALOG DETAIL — GET /api/projects/:id/module-catalog/:moduleProjectId
// =============================================================================

describe('Module Catalog Detail Route', () => {
  describe('GET /api/projects/:id/module-catalog/:moduleProjectId', () => {
    it('returns module detail with releases and environments', async () => {
      // Module project exists and is visible
      mockProjectFindOne.mockReturnValue({
        lean: () =>
          Promise.resolve({
            _id: MODULE_PROJECT_ID,
            name: 'Auth Module',
            description: 'Auth helper module',
            moduleVisibility: 'tenant',
          }),
      });

      // Releases
      mockModuleReleaseFindChain.mockReturnValue({
        sort: () => ({
          select: () => ({
            limit: () => ({
              lean: () =>
                Promise.resolve([
                  {
                    _id: 'rel-2',
                    version: '2.0.0',
                    releaseNotes: 'Major update',
                    contract: { providedAgents: ['AuthAgent'] },
                    sourceHash: 'hash-2',
                    createdAt: '2026-03-01',
                    createdBy: 'user-1',
                  },
                  {
                    _id: 'rel-1',
                    version: '1.0.0',
                    releaseNotes: 'Initial',
                    contract: { providedAgents: ['AuthAgent'] },
                    sourceHash: 'hash-1',
                    createdAt: '2026-01-01',
                    createdBy: 'user-1',
                  },
                ]),
            }),
          }),
        }),
      });

      // Environment pointers
      mockModuleEnvironmentPointerFind.mockReturnValue({
        lean: () =>
          Promise.resolve([
            {
              environment: 'production',
              moduleReleaseId: 'rel-2',
              revision: 5,
            },
            {
              environment: 'staging',
              moduleReleaseId: 'rel-2',
              revision: 3,
            },
          ]),
      });

      const { GET } =
        await import('@/app/api/projects/[id]/module-catalog/[moduleProjectId]/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module-catalog/${MODULE_PROJECT_ID}`);
      const res = await GET(req, routeCtx({ id: PROJECT_ID, moduleProjectId: MODULE_PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data.moduleProjectId).toBe(MODULE_PROJECT_ID);
      expect(json.data.name).toBe('Auth Module');
      expect(json.data.releases).toHaveLength(2);
      expect(json.data.releases[0].version).toBe('2.0.0');
      expect(json.data.releases[0].contract).toEqual({ providedAgents: ['AuthAgent'] });
      expect(json.data.environments).toHaveLength(2);
      expect(json.data.environments[0].environment).toBe('production');
    });

    it('self-lookup guard: returns 404 when moduleProjectId === projectId', async () => {
      const { GET } =
        await import('@/app/api/projects/[id]/module-catalog/[moduleProjectId]/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module-catalog/${PROJECT_ID}`);
      const res = await GET(req, routeCtx({ id: PROJECT_ID, moduleProjectId: PROJECT_ID }));

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.success).toBe(false);
    });

    it('returns 404 when module not found', async () => {
      mockProjectFindOne.mockReturnValue({
        lean: () => Promise.resolve(null),
      });

      const { GET } =
        await import('@/app/api/projects/[id]/module-catalog/[moduleProjectId]/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module-catalog/non-existent`);
      const res = await GET(req, routeCtx({ id: PROJECT_ID, moduleProjectId: 'non-existent' }));

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.success).toBe(false);
    });

    it('returns 404 for private module (visibility filter excludes it)', async () => {
      // findOne returns null because the visibility $or filter won't match 'private'
      mockProjectFindOne.mockReturnValue({
        lean: () => Promise.resolve(null),
      });

      const { GET } =
        await import('@/app/api/projects/[id]/module-catalog/[moduleProjectId]/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module-catalog/${MODULE_PROJECT_ID}`);
      const res = await GET(req, routeCtx({ id: PROJECT_ID, moduleProjectId: MODULE_PROJECT_ID }));

      expect(res.status).toBe(404);

      // Verify that findOne was called with visibility filter
      expect(mockProjectFindOne).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: MODULE_PROJECT_ID,
          tenantId: TENANT_ID,
          kind: 'module',
          $or: expect.arrayContaining([{ moduleVisibility: 'tenant' }]),
        }),
      );
    });
  });
});

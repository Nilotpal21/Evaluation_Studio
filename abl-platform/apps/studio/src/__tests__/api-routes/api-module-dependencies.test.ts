/**
 * Module Dependencies Route Tests
 *
 * Covers:
 *   GET    /api/projects/:id/module-dependencies                    — List dependencies
 *   POST   /api/projects/:id/module-dependencies                    — Confirm import
 *   DELETE /api/projects/:id/module-dependencies/:dependencyId      — Remove dependency
 *   POST   /api/projects/:id/module-dependencies/preview            — Preview import (dry-run)
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

// Logger
vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  deriveRetentionClass: vi.fn(() => 'standard'),
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
    MODULE_IMPORTED: 'module_imported',
    MODULE_REMOVED: 'module_removed',
  },
}));

// Database model stubs — overridden per-test via beforeEach
const mockProjectModuleDependencyFind = vi.fn();
const mockProjectModuleDependencyFindOne = vi.fn();
const mockProjectModuleDependencyCountDocuments = vi.fn();
const mockProjectModuleDependencyCreate = vi.fn();
const mockProjectModuleDependencyDeleteOne = vi.fn();
const mockProjectFindOne = vi.fn();
const mockProjectFindOneAndUpdate = vi.fn();
const mockModuleReleaseFindOne = vi.fn();
const mockModuleReleaseAggregate = vi.fn().mockResolvedValue([]);
const mockProjectAgentFind = vi.fn();
const mockProjectToolFind = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  ProjectModuleDependency: {
    find: (...args: unknown[]) => mockProjectModuleDependencyFind(...args),
    findOne: (...args: unknown[]) => mockProjectModuleDependencyFindOne(...args),
    countDocuments: (...args: unknown[]) => mockProjectModuleDependencyCountDocuments(...args),
    create: (...args: unknown[]) => mockProjectModuleDependencyCreate(...args),
    deleteOne: (...args: unknown[]) => mockProjectModuleDependencyDeleteOne(...args),
  },
  Project: {
    findOne: (...args: unknown[]) => mockProjectFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mockProjectFindOneAndUpdate(...args),
  },
  ModuleRelease: {
    findOne: (...args: unknown[]) => mockModuleReleaseFindOne(...args),
    aggregate: (...args: unknown[]) => mockModuleReleaseAggregate(...args),
  },
  ProjectAgent: {
    find: (...args: unknown[]) => mockProjectAgentFind(...args),
  },
  ProjectTool: {
    find: (...args: unknown[]) => mockProjectToolFind(...args),
  },
  ModuleEnvironmentPointer: {
    findOne: vi.fn(),
  },
  AuditLog: {
    create: vi.fn().mockResolvedValue({ toObject: () => ({ _id: 'audit-1' }) }),
  },
}));

// Validation — pass-through actual parseInput
vi.mock('@agent-platform/shared/validation', async () => {
  const actual = await vi.importActual<typeof import('@agent-platform/shared/validation')>(
    '@agent-platform/shared/validation',
  );
  return { ...actual };
});

// project-io — mock validateConfigOverrides and resolveSelector
const mockValidateConfigOverrides = vi.fn();
const mockResolveSelector = vi.fn();

vi.mock('@agent-platform/project-io', () => ({
  validateConfigOverrides: (...args: unknown[]) => mockValidateConfigOverrides(...args),
  resolveSelector: (...args: unknown[]) => mockResolveSelector(...args),
}));

// =============================================================================
// CONSTANTS
// =============================================================================

const PROJECT_ID = 'proj-consumer-1';
const TENANT_ID = 'tenant-1';
const MODULE_PROJECT_ID = 'proj-module-1';
const RELEASE_ID = 'release-1';
const DEPENDENCY_ID = 'dep-1';

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
  kind: 'application',
};

const sampleContract = {
  providedAgents: [{ name: 'AgentA' }],
  providedTools: [{ name: 'ToolX' }],
  requiredConfigKeys: [
    { key: 'api_url', isSecret: false, description: 'API base URL' },
    { key: 'api_secret', isSecret: true, description: 'Secret token' },
  ],
  requiredAuthProfiles: [],
  requiredConnectors: [],
};

const sampleDependency = {
  _id: DEPENDENCY_ID,
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
  moduleProjectId: MODULE_PROJECT_ID,
  moduleProjectName: 'Auth Module',
  alias: 'auth',
  selector: { type: 'version', value: '1.0.0' },
  resolvedReleaseId: RELEASE_ID,
  resolvedVersion: '1.0.0',
  configOverrides: {},
  contractSnapshot: sampleContract,
  createdAt: new Date().toISOString(),
  createdBy: 'user-1',
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

  mockResolveSelector.mockResolvedValue({
    releaseId: RELEASE_ID,
    version: '1.0.0',
  });
  mockValidateConfigOverrides.mockReturnValue({
    blocking: [],
    warnings: [],
  });
  mockProjectAgentFind.mockReturnValue({
    select: () => ({
      lean: () => Promise.resolve([]),
    }),
  });
  mockProjectToolFind.mockReturnValue({
    select: () => ({
      lean: () => Promise.resolve([]),
    }),
  });
});

// =============================================================================
// GET /api/projects/:id/module-dependencies — List dependencies
// =============================================================================

describe('Module Dependencies List Route', () => {
  describe('GET /api/projects/:id/module-dependencies', () => {
    it('returns all dependencies with correct fields', async () => {
      mockProjectModuleDependencyFind.mockReturnValue({
        sort: () => ({
          lean: () => Promise.resolve([sampleDependency]),
        }),
      });

      const { GET } = await import('@/app/api/projects/[id]/module-dependencies/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module-dependencies`);
      const res = await GET(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0]).toEqual(
        expect.objectContaining({
          id: DEPENDENCY_ID,
          alias: 'auth',
          moduleProjectId: MODULE_PROJECT_ID,
          moduleProjectName: 'Auth Module',
          resolvedReleaseId: RELEASE_ID,
          resolvedVersion: '1.0.0',
        }),
      );
    });

    it('returns empty array when no dependencies exist', async () => {
      mockProjectModuleDependencyFind.mockReturnValue({
        sort: () => ({
          lean: () => Promise.resolve([]),
        }),
      });

      const { GET } = await import('@/app/api/projects/[id]/module-dependencies/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module-dependencies`);
      const res = await GET(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(0);
    });

    it('re-resolves environment selectors to the live pointed release', async () => {
      const liveContract = {
        ...sampleContract,
        providedAgents: [{ name: 'AgentLive' }],
        providedTools: [{ name: 'ToolLive' }],
      };

      mockProjectModuleDependencyFind.mockReturnValue({
        sort: () => ({
          lean: () =>
            Promise.resolve([
              {
                ...sampleDependency,
                selector: { type: 'environment', value: 'production' },
                resolvedReleaseId: 'release-stale',
                resolvedVersion: '1.0.0',
                contractSnapshot: sampleContract,
              },
            ]),
        }),
      });
      mockModuleReleaseAggregate.mockResolvedValue([
        {
          _id: MODULE_PROJECT_ID,
          latestVersion: '9.9.9',
          latestReleaseId: { toString: () => 'release-latest' },
        },
      ]);
      mockResolveSelector.mockResolvedValue({
        releaseId: 'release-live',
        version: '2.1.0',
      });
      mockModuleReleaseFindOne.mockResolvedValue({
        _id: 'release-live',
        tenantId: TENANT_ID,
        moduleProjectId: MODULE_PROJECT_ID,
        version: '2.1.0',
        archivedAt: null,
        contract: liveContract,
      });

      const { GET } = await import('@/app/api/projects/[id]/module-dependencies/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module-dependencies`);
      const res = await GET(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data[0]).toEqual(
        expect.objectContaining({
          resolvedReleaseId: 'release-live',
          resolvedVersion: '2.1.0',
          contractSnapshot: liveContract,
        }),
      );
      expect(json.data[0].updateAvailable).toBeUndefined();
    });
  });
});

// =============================================================================
// POST /api/projects/:id/module-dependencies — Confirm import
// =============================================================================

describe('Module Dependencies Import Route', () => {
  /** Standard valid import body */
  const validImportBody = {
    moduleProjectId: MODULE_PROJECT_ID,
    alias: 'billing',
    selector: { type: 'version', value: '1.0.0' },
    resolvedReleaseId: RELEASE_ID,
  };

  function setupSuccessfulImportMocks() {
    // No existing dependencies
    mockProjectModuleDependencyCountDocuments.mockResolvedValue(0);
    // No alias conflict
    mockProjectModuleDependencyFindOne.mockResolvedValue(null);
    // Module project exists
    mockProjectFindOne.mockResolvedValue({
      _id: MODULE_PROJECT_ID,
      tenantId: TENANT_ID,
      name: 'Billing Module',
      kind: 'module',
    });
    // Release exists
    mockModuleReleaseFindOne.mockReturnValue({
      _id: RELEASE_ID,
      tenantId: TENANT_ID,
      moduleProjectId: MODULE_PROJECT_ID,
      version: '1.0.0',
      archivedAt: null,
      contract: sampleContract,
    });
    // Create succeeds
    mockProjectModuleDependencyCreate.mockResolvedValue({
      _id: 'dep-new',
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      moduleProjectId: MODULE_PROJECT_ID,
      moduleProjectName: 'Billing Module',
      alias: 'billing',
      selector: { type: 'version', value: '1.0.0' },
      resolvedReleaseId: RELEASE_ID,
      resolvedVersion: '1.0.0',
      configOverrides: {},
      contractSnapshot: sampleContract,
      createdAt: new Date().toISOString(),
      createdBy: 'user-1',
    });
    // Project version increment
    mockProjectFindOneAndUpdate.mockResolvedValue({});
  }

  describe('POST /api/projects/:id/module-dependencies', () => {
    it('successfully imports a valid dependency', async () => {
      setupSuccessfulImportMocks();

      const { POST } = await import('@/app/api/projects/[id]/module-dependencies/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies`,
        'POST',
        validImportBody,
      );
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(201);
      expect(json.success).toBe(true);
      expect(json.data).toEqual(
        expect.objectContaining({
          id: 'dep-new',
          alias: 'billing',
          moduleProjectId: MODULE_PROJECT_ID,
          resolvedReleaseId: RELEASE_ID,
          resolvedVersion: '1.0.0',
        }),
      );
    });

    it('rejects self-import — a project cannot import itself', async () => {
      const { POST } = await import('@/app/api/projects/[id]/module-dependencies/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module-dependencies`, 'POST', {
        ...validImportBody,
        moduleProjectId: PROJECT_ID, // Same as the consumer project
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.errors[0].msg).toContain('cannot import itself');
    });

    it('rejects transitive imports from module projects', async () => {
      setupSuccessfulImportMocks();
      mockRequireProjectAccess.mockResolvedValue({
        project: {
          ...testProject,
          kind: 'module',
          name: 'Reusable Billing Module',
        },
      });

      const { POST } = await import('@/app/api/projects/[id]/module-dependencies/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies`,
        'POST',
        validImportBody,
      );
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.errors[0].msg).toContain('Module projects cannot import');
      expect(mockProjectModuleDependencyCreate).not.toHaveBeenCalled();
    });

    it('rejects duplicate alias within same project', async () => {
      mockProjectModuleDependencyCountDocuments.mockResolvedValue(1);
      // Alias conflict found
      mockProjectModuleDependencyFindOne.mockResolvedValue(sampleDependency);

      const { POST } = await import('@/app/api/projects/[id]/module-dependencies/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module-dependencies`, 'POST', {
        ...validImportBody,
        alias: 'auth', // same alias as existing dependency
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(409);
      expect(json.success).toBe(false);
      expect(json.errors[0].msg).toContain('already in use');
      expect(json.errors[0].code).toBe('NAME_CONFLICT');
    });

    it('rejects import when MAX_DEPENDENCIES (5) reached', async () => {
      mockProjectModuleDependencyCountDocuments.mockResolvedValue(5);

      const { POST } = await import('@/app/api/projects/[id]/module-dependencies/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies`,
        'POST',
        validImportBody,
      );
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.errors[0].msg).toContain('Maximum of 5');
    });

    it('rejects config overrides with secret key values', async () => {
      // Pass validation steps up to configOverrides check
      mockProjectModuleDependencyCountDocuments.mockResolvedValue(0);
      mockProjectModuleDependencyFindOne.mockResolvedValue(null);
      mockProjectFindOne.mockResolvedValue({
        _id: MODULE_PROJECT_ID,
        tenantId: TENANT_ID,
        name: 'Module',
        kind: 'module',
      });
      mockModuleReleaseFindOne.mockReturnValue({
        _id: RELEASE_ID,
        tenantId: TENANT_ID,
        moduleProjectId: MODULE_PROJECT_ID,
        version: '1.0.0',
        archivedAt: null,
        contract: sampleContract,
      });
      // validateConfigOverrides returns blocking error for secret key
      mockValidateConfigOverrides.mockReturnValue({
        blocking: [
          'Config key "api_secret" is declared as secret — secrets cannot be set via config overrides',
        ],
        warnings: [],
      });

      const { POST } = await import('@/app/api/projects/[id]/module-dependencies/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module-dependencies`, 'POST', {
        ...validImportBody,
        configOverrides: { api_secret: 'my-secret-value' },
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.errors[0].msg).toContain('secret');
    });

    it('returns 404 when module project does not exist or is not a module', async () => {
      mockProjectModuleDependencyCountDocuments.mockResolvedValue(0);
      mockProjectModuleDependencyFindOne.mockResolvedValue(null);
      // Module project not found (different tenant or not kind=module)
      mockProjectFindOne.mockResolvedValue(null);

      const { POST } = await import('@/app/api/projects/[id]/module-dependencies/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies`,
        'POST',
        validImportBody,
      );
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(404);
      expect(json.success).toBe(false);
      expect(json.errors[0].msg).toContain('Module project not found');
    });

    it('returns 404 when the module project is private and not visible', async () => {
      mockProjectModuleDependencyCountDocuments.mockResolvedValue(0);
      mockProjectModuleDependencyFindOne.mockResolvedValue(null);
      mockProjectFindOne.mockResolvedValue(null);

      const { POST } = await import('@/app/api/projects/[id]/module-dependencies/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies`,
        'POST',
        validImportBody,
      );
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(404);
      expect(json.success).toBe(false);
      expect(json.errors[0].code).toBe('NOT_FOUND');
      expect(mockProjectFindOne).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: MODULE_PROJECT_ID,
          tenantId: TENANT_ID,
          kind: 'module',
          $or: expect.arrayContaining([expect.objectContaining({ moduleVisibility: 'tenant' })]),
        }),
      );
    });

    it('rejects stale selector imports after the pointer moves', async () => {
      mockProjectModuleDependencyCountDocuments.mockResolvedValue(0);
      mockProjectModuleDependencyFindOne.mockResolvedValue(null);
      mockProjectFindOne.mockResolvedValue({
        _id: MODULE_PROJECT_ID,
        tenantId: TENANT_ID,
        name: 'Billing Module',
        kind: 'module',
      });
      mockResolveSelector.mockResolvedValue({
        releaseId: 'release-2',
        version: '1.1.0',
      });

      const { POST } = await import('@/app/api/projects/[id]/module-dependencies/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module-dependencies`, 'POST', {
        ...validImportBody,
        selector: { type: 'environment', value: 'production' },
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(409);
      expect(json.success).toBe(false);
      expect(json.errors[0].code).toBe('POINTER_CONFLICT');
      expect(json.errors[0].msg).toContain('changed after preview');
      expect(mockProjectModuleDependencyCreate).not.toHaveBeenCalled();
    });

    it('rejects confirm import when mounted tool symbols now collide with local project tools', async () => {
      setupSuccessfulImportMocks();
      mockProjectToolFind.mockReturnValue({
        select: () => ({
          lean: () =>
            Promise.resolve([
              {
                name: 'billing__ToolX',
              },
            ]),
        }),
      });

      const { POST } = await import('@/app/api/projects/[id]/module-dependencies/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies`,
        'POST',
        validImportBody,
      );
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(409);
      expect(json.success).toBe(false);
      expect(json.errors[0].code).toBe('NAME_CONFLICT');
      expect(json.errors[0].msg).toContain('billing__ToolX');
      expect(mockProjectModuleDependencyCreate).not.toHaveBeenCalled();
      expect(mockProjectToolFind).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          name: { $in: ['billing__AgentA', 'billing__ToolX'] },
        }),
      );
    });

    it('rejects confirm import when mounted tool symbols now collide with local project agents', async () => {
      setupSuccessfulImportMocks();
      mockProjectAgentFind.mockImplementation((query: Record<string, unknown>) => ({
        select: () => ({
          lean: () => {
            const names =
              query.name &&
              typeof query.name === 'object' &&
              '$in' in query.name &&
              Array.isArray((query.name as { $in?: unknown }).$in)
                ? ((query.name as { $in: string[] }).$in ?? [])
                : [];
            return Promise.resolve(
              names.includes('billing__ToolX') ? [{ name: 'billing__ToolX' }] : [],
            );
          },
        }),
      }));

      const { POST } = await import('@/app/api/projects/[id]/module-dependencies/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies`,
        'POST',
        validImportBody,
      );
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(409);
      expect(json.success).toBe(false);
      expect(json.errors[0].code).toBe('NAME_CONFLICT');
      expect(json.errors[0].msg).toContain('billing__ToolX');
      expect(mockProjectModuleDependencyCreate).not.toHaveBeenCalled();
      expect(mockProjectAgentFind).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          name: { $in: ['billing__AgentA', 'billing__ToolX'] },
        }),
      );
    });

    it('handles duplicate alias via DB unique index (MongoDB 11000)', async () => {
      // All checks pass, but DB create throws duplicate key
      mockProjectModuleDependencyCountDocuments.mockResolvedValue(0);
      mockProjectModuleDependencyFindOne.mockResolvedValue(null);
      mockProjectFindOne.mockResolvedValue({
        _id: MODULE_PROJECT_ID,
        tenantId: TENANT_ID,
        name: 'Module',
        kind: 'module',
      });
      mockModuleReleaseFindOne.mockReturnValue({
        _id: RELEASE_ID,
        tenantId: TENANT_ID,
        moduleProjectId: MODULE_PROJECT_ID,
        version: '1.0.0',
        archivedAt: null,
        contract: sampleContract,
      });

      const dupError = Object.assign(new Error('duplicate key'), { code: 11000 });
      mockProjectModuleDependencyCreate.mockRejectedValue(dupError);

      const { POST } = await import('@/app/api/projects/[id]/module-dependencies/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies`,
        'POST',
        validImportBody,
      );
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(409);
      expect(json.success).toBe(false);
      expect(json.errors[0].msg).toContain('already in use');
    });
  });
});

// =============================================================================
// DELETE /api/projects/:id/module-dependencies/:dependencyId — Remove dependency
// =============================================================================

describe('Module Dependencies Delete Route', () => {
  describe('DELETE /api/projects/:id/module-dependencies/:dependencyId', () => {
    it('successfully removes an existing dependency', async () => {
      mockProjectModuleDependencyFindOne.mockResolvedValue(sampleDependency);
      mockProjectModuleDependencyDeleteOne.mockResolvedValue({ deletedCount: 1 });
      mockProjectFindOneAndUpdate.mockResolvedValue({});

      const { DELETE } =
        await import('@/app/api/projects/[id]/module-dependencies/[dependencyId]/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies/${DEPENDENCY_ID}`,
        'DELETE',
      );
      const res = await DELETE(req, routeCtx({ id: PROJECT_ID, dependencyId: DEPENDENCY_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.message).toBe('Dependency removed');
    });

    it('returns 404 when dependency not found (wrong project scope)', async () => {
      mockProjectModuleDependencyFindOne.mockResolvedValue(null);

      const { DELETE } =
        await import('@/app/api/projects/[id]/module-dependencies/[dependencyId]/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies/${DEPENDENCY_ID}`,
        'DELETE',
      );
      const res = await DELETE(req, routeCtx({ id: PROJECT_ID, dependencyId: DEPENDENCY_ID }));
      const json = await res.json();

      expect(res.status).toBe(404);
      expect(json.success).toBe(false);
      expect(json.errors[0].msg).toContain('not found');
    });
  });
});

// =============================================================================
// POST /api/projects/:id/module-dependencies/preview — Preview import
// =============================================================================

describe('Module Dependencies Preview Route', () => {
  const validPreviewBody = {
    moduleProjectId: MODULE_PROJECT_ID,
    alias: 'payments',
    selector: { type: 'version' as const, value: '2.0.0' },
  };

  describe('POST /api/projects/:id/module-dependencies/preview', () => {
    it('rejects self-import in preview', async () => {
      const { POST } = await import('@/app/api/projects/[id]/module-dependencies/preview/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module-dependencies/preview`, 'POST', {
        ...validPreviewBody,
        moduleProjectId: PROJECT_ID, // Self-import
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.errors[0].msg).toContain('cannot import itself');
    });

    it('rejects preview imports from module projects', async () => {
      mockRequireProjectAccess.mockResolvedValue({
        project: {
          ...testProject,
          kind: 'module',
          name: 'Reusable Billing Module',
        },
      });
      mockProjectFindOne.mockResolvedValue({
        _id: MODULE_PROJECT_ID,
        tenantId: TENANT_ID,
        name: 'Payments Module',
        kind: 'module',
      });
      mockResolveSelector.mockResolvedValue({
        releaseId: RELEASE_ID,
        version: '2.0.0',
      });
      mockModuleReleaseFindOne.mockReturnValue({
        _id: RELEASE_ID,
        tenantId: TENANT_ID,
        moduleProjectId: MODULE_PROJECT_ID,
        version: '2.0.0',
        archivedAt: null,
        contract: sampleContract,
      });
      mockProjectAgentFind.mockReturnValue({
        select: () => ({
          lean: () => Promise.resolve([]),
        }),
      });
      mockProjectToolFind.mockReturnValue({
        select: () => ({
          lean: () => Promise.resolve([]),
        }),
      });

      const { POST } = await import('@/app/api/projects/[id]/module-dependencies/preview/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies/preview`,
        'POST',
        validPreviewBody,
      );
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.errors[0].msg).toContain('Module projects cannot import');
    });

    it('returns resolved release with mounted symbols and no collisions', async () => {
      // Module project exists
      mockProjectFindOne.mockResolvedValue({
        _id: MODULE_PROJECT_ID,
        tenantId: TENANT_ID,
        name: 'Payments Module',
        kind: 'module',
      });

      // resolveSelector succeeds
      mockResolveSelector.mockResolvedValue({
        releaseId: RELEASE_ID,
        version: '2.0.0',
      });

      // Release exists with contract
      mockModuleReleaseFindOne.mockReturnValue({
        _id: RELEASE_ID,
        tenantId: TENANT_ID,
        moduleProjectId: MODULE_PROJECT_ID,
        version: '2.0.0',
        archivedAt: null,
        contract: sampleContract,
      });

      // No collisions with existing agents/tools
      mockProjectAgentFind.mockReturnValue({
        select: () => ({
          lean: () => Promise.resolve([]),
        }),
      });
      mockProjectToolFind.mockReturnValue({
        select: () => ({
          lean: () => Promise.resolve([]),
        }),
      });

      const { POST } = await import('@/app/api/projects/[id]/module-dependencies/preview/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies/preview`,
        'POST',
        validPreviewBody,
      );
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data.resolvedReleaseId).toBe(RELEASE_ID);
      expect(json.data.resolvedVersion).toBe('2.0.0');
      expect(json.data.mountedSymbols.agents).toEqual(['payments__AgentA']);
      expect(json.data.mountedSymbols.tools).toEqual(['payments__ToolX']);
      expect(json.data.collisions).toHaveLength(0);
    });

    it('reports preview collisions when mounted tool symbols collide with local project agents', async () => {
      mockProjectFindOne.mockResolvedValue({
        _id: MODULE_PROJECT_ID,
        tenantId: TENANT_ID,
        name: 'Payments Module',
        kind: 'module',
      });
      mockResolveSelector.mockResolvedValue({
        releaseId: RELEASE_ID,
        version: '2.0.0',
      });
      mockModuleReleaseFindOne.mockReturnValue({
        _id: RELEASE_ID,
        tenantId: TENANT_ID,
        moduleProjectId: MODULE_PROJECT_ID,
        version: '2.0.0',
        archivedAt: null,
        contract: sampleContract,
      });
      mockProjectAgentFind.mockImplementation((query: Record<string, unknown>) => ({
        select: () => ({
          lean: () => {
            const names =
              query.name &&
              typeof query.name === 'object' &&
              '$in' in query.name &&
              Array.isArray((query.name as { $in?: unknown }).$in)
                ? ((query.name as { $in: string[] }).$in ?? [])
                : [];
            return Promise.resolve(
              names.includes('payments__ToolX') ? [{ name: 'payments__ToolX' }] : [],
            );
          },
        }),
      }));
      mockProjectToolFind.mockReturnValue({
        select: () => ({
          lean: () => Promise.resolve([]),
        }),
      });

      const { POST } = await import('@/app/api/projects/[id]/module-dependencies/preview/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies/preview`,
        'POST',
        validPreviewBody,
      );
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data.collisions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            mountedName: 'payments__ToolX',
            conflictsWith: 'agent:payments__ToolX',
          }),
        ]),
      );
      expect(mockProjectAgentFind).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          name: { $in: ['payments__AgentA', 'payments__ToolX'] },
        }),
      );
    });

    it('returns 404 when the module project is private and not visible', async () => {
      mockProjectFindOne.mockResolvedValue(null);

      const { POST } = await import('@/app/api/projects/[id]/module-dependencies/preview/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies/preview`,
        'POST',
        validPreviewBody,
      );
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(404);
      expect(json.success).toBe(false);
      expect(json.errors[0].code).toBe('NOT_FOUND');
      expect(mockProjectFindOne).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: MODULE_PROJECT_ID,
          tenantId: TENANT_ID,
          kind: 'module',
          $or: expect.arrayContaining([expect.objectContaining({ moduleVisibility: 'tenant' })]),
        }),
      );
    });

    it('reports prerequisite warnings for required auth profiles, env vars, and MCP servers', async () => {
      const contractWithPrereqs = {
        ...sampleContract,
        requiredAuthProfiles: [{ name: 'oauth-profile' }],
        requiredConnectors: [{ name: 'slack-connector' }],
        requiredEnvVars: [{ name: 'PAYMENTS_API_KEY' }],
        requiredMcpServers: [{ name: 'payments-mcp' }],
      };

      mockProjectFindOne.mockResolvedValue({
        _id: MODULE_PROJECT_ID,
        tenantId: TENANT_ID,
        name: 'Module',
        kind: 'module',
      });
      mockResolveSelector.mockResolvedValue({
        releaseId: RELEASE_ID,
        version: '2.0.0',
      });
      mockModuleReleaseFindOne.mockReturnValue({
        _id: RELEASE_ID,
        tenantId: TENANT_ID,
        moduleProjectId: MODULE_PROJECT_ID,
        version: '2.0.0',
        archivedAt: null,
        contract: contractWithPrereqs,
      });
      mockProjectAgentFind.mockReturnValue({
        select: () => ({ lean: () => Promise.resolve([]) }),
      });
      mockProjectToolFind.mockReturnValue({
        select: () => ({ lean: () => Promise.resolve([]) }),
      });

      const { POST } = await import('@/app/api/projects/[id]/module-dependencies/preview/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies/preview`,
        'POST',
        validPreviewBody,
      );
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.data.prerequisites.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining('auth profile'),
          expect.stringContaining('connector'),
          expect.stringContaining('environment variable'),
          expect.stringContaining('MCP server'),
        ]),
      );
    });

    it('returns blocking errors when configOverrides include invalid keys', async () => {
      mockProjectFindOne.mockResolvedValue({
        _id: MODULE_PROJECT_ID,
        tenantId: TENANT_ID,
        name: 'Module',
        kind: 'module',
      });
      mockResolveSelector.mockResolvedValue({
        releaseId: RELEASE_ID,
        version: '2.0.0',
      });
      mockModuleReleaseFindOne.mockReturnValue({
        _id: RELEASE_ID,
        tenantId: TENANT_ID,
        moduleProjectId: MODULE_PROJECT_ID,
        version: '2.0.0',
        archivedAt: null,
        contract: sampleContract,
      });
      mockProjectAgentFind.mockReturnValue({
        select: () => ({ lean: () => Promise.resolve([]) }),
      });
      mockProjectToolFind.mockReturnValue({
        select: () => ({ lean: () => Promise.resolve([]) }),
      });

      // validateConfigOverrides returns a blocking error
      mockValidateConfigOverrides.mockReturnValue({
        blocking: [
          'Config key "api_secret" is declared as secret — secrets cannot be set via config overrides',
        ],
        warnings: [],
      });

      const { POST } = await import('@/app/api/projects/[id]/module-dependencies/preview/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module-dependencies/preview`, 'POST', {
        ...validPreviewBody,
        configOverrides: { api_secret: 'secret-value' },
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      // Preview still succeeds but prerequisites.blocking has the error
      expect(res.status).toBe(200);
      expect(json.data.prerequisites.blocking).toEqual(
        expect.arrayContaining([expect.stringContaining('secret')]),
      );
    });
  });
});

// =============================================================================
// CROSS-CUTTING CONCERNS
// =============================================================================

describe('Cross-Tenant Isolation', () => {
  it('returns 404 when module project belongs to different tenant', async () => {
    // All setup passes, but the module project lookup returns null
    // (because the route filters by tenantId and kind=module)
    mockProjectModuleDependencyCountDocuments.mockResolvedValue(0);
    mockProjectModuleDependencyFindOne.mockResolvedValue(null);
    // Module project not found — simulates cross-tenant access
    mockProjectFindOne.mockResolvedValue(null);

    const { POST } = await import('@/app/api/projects/[id]/module-dependencies/route');
    const req = makeRequest(`/api/projects/${PROJECT_ID}/module-dependencies`, 'POST', {
      moduleProjectId: 'proj-other-tenant',
      alias: 'foreign',
      selector: { type: 'version', value: '1.0.0' },
      resolvedReleaseId: 'release-other',
    });
    const res = await POST(req, routeCtx({ id: PROJECT_ID }));
    const json = await res.json();

    // Cross-tenant returns 404, not 403, to avoid leaking existence
    expect(res.status).toBe(404);
    expect(json.success).toBe(false);
    expect(json.errors[0].msg).toContain('Module project not found');
  });
});

describe('Project Isolation', () => {
  it('DELETE scopes by both tenantId and projectId', async () => {
    // Dependency not found because wrong project scope
    mockProjectModuleDependencyFindOne.mockResolvedValue(null);

    const wrongProjectId = 'proj-wrong';
    // Override project access to resolve to a different project
    mockRequireProjectAccess.mockResolvedValue({
      project: { _id: wrongProjectId, tenantId: TENANT_ID, name: 'Wrong Project' },
    });

    const { DELETE } =
      await import('@/app/api/projects/[id]/module-dependencies/[dependencyId]/route');
    const req = makeRequest(
      `/api/projects/${wrongProjectId}/module-dependencies/${DEPENDENCY_ID}`,
      'DELETE',
    );
    const res = await DELETE(req, routeCtx({ id: wrongProjectId, dependencyId: DEPENDENCY_ID }));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.success).toBe(false);
    expect(json.errors[0].msg).toContain('not found');

    // Verify the findOne was called with the correct project scope
    expect(mockProjectModuleDependencyFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: DEPENDENCY_ID,
        tenantId: TENANT_ID,
        projectId: wrongProjectId,
      }),
    );
  });
});

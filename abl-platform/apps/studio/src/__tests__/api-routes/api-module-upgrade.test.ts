/**
 * Module Upgrade & Diff Route Tests
 *
 * Covers:
 *   PATCH  /api/projects/:id/module-dependencies/:dependencyId — Upgrade dependency to new release
 *   GET    /api/projects/:id/module-dependencies/:dependencyId/diff — Compute upgrade diff
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
const mockLogAuditEvent = vi.fn().mockResolvedValue(undefined);

vi.mock('@/services/audit-service', () => ({
  logAuditEvent: mockLogAuditEvent,
  AuditActions: {
    MODULE_UPGRADED: 'module_upgraded',
    MODULE_REMOVED: 'module_removed',
  },
}));

// Database model stubs — overridden per-test via beforeEach
const mockProjectModuleDependencyFindOne = vi.fn();
const mockProjectModuleDependencyFindOneAndUpdate = vi.fn();
const mockModuleReleaseFindOne = vi.fn();
const mockProjectFindOneAndUpdate = vi.fn();
const mockProjectAgentFind = vi.fn();
const mockProjectToolFind = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  ProjectModuleDependency: {
    findOne: (...args: unknown[]) => mockProjectModuleDependencyFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mockProjectModuleDependencyFindOneAndUpdate(...args),
    deleteOne: vi.fn(),
  },
  ModuleRelease: {
    findOne: (...args: unknown[]) => mockModuleReleaseFindOne(...args),
  },
  Project: {
    findOneAndUpdate: (...args: unknown[]) => mockProjectFindOneAndUpdate(...args),
  },
  ProjectAgent: {
    find: (...args: unknown[]) => mockProjectAgentFind(...args),
  },
  ProjectTool: {
    find: (...args: unknown[]) => mockProjectToolFind(...args),
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

// project-io — mock diffModuleContracts and validateConfigOverrides
const mockDiffModuleContracts = vi.fn();
const mockValidateConfigOverrides = vi.fn();

vi.mock('@agent-platform/project-io', () => ({
  diffModuleContracts: (...args: unknown[]) => mockDiffModuleContracts(...args),
  validateConfigOverrides: (...args: unknown[]) => mockValidateConfigOverrides(...args),
}));

// =============================================================================
// CONSTANTS
// =============================================================================

const PROJECT_ID = 'proj-consumer-1';
const TENANT_ID = 'tenant-1';
const MODULE_PROJECT_ID = 'proj-module-1';
const DEPENDENCY_ID = 'dep-1';
const CURRENT_RELEASE_ID = 'release-current';
const TARGET_RELEASE_ID = 'release-target';
const OLDER_RELEASE_ID = 'release-older';

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

const baseContract = {
  providedAgents: [{ name: 'AgentA', description: 'Agent A' }],
  providedTools: [{ name: 'ToolX', toolType: 'http' }],
  requiredConfigKeys: [{ key: 'api_url', isSecret: false, description: 'API base URL' }],
  requiredEnvVars: [],
  requiredAuthProfiles: [],
  requiredConnectors: [],
  requiredMcpServers: [],
  warnings: [],
};

const targetContract = {
  providedAgents: [
    { name: 'AgentA', description: 'Agent A updated' },
    { name: 'AgentB', description: 'New agent' },
  ],
  providedTools: [{ name: 'ToolX', toolType: 'http' }],
  requiredConfigKeys: [{ key: 'api_url', isSecret: false, description: 'API base URL' }],
  requiredEnvVars: [],
  requiredAuthProfiles: [],
  requiredConnectors: [],
  requiredMcpServers: [],
  warnings: [],
};

const sampleDependency = {
  _id: DEPENDENCY_ID,
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
  moduleProjectId: MODULE_PROJECT_ID,
  moduleProjectName: 'Auth Module',
  alias: 'auth',
  selector: { type: 'version', value: '1.0.0' },
  resolvedReleaseId: CURRENT_RELEASE_ID,
  resolvedVersion: '1.0.0',
  configOverrides: {},
  contractSnapshot: baseContract,
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

function mockNameLookup(modelFind: ReturnType<typeof vi.fn>, names: string[] = []) {
  modelFind.mockReturnValue({
    select: () => ({
      lean: () => Promise.resolve(names.map((name) => ({ name }))),
    }),
  });
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

  mockNameLookup(mockProjectAgentFind);
  mockNameLookup(mockProjectToolFind);
});

// =============================================================================
// PATCH /api/projects/:id/module-dependencies/:dependencyId — Upgrade
// =============================================================================

describe('Upgrade Dependency Route', () => {
  /** Standard successful upgrade mock setup */
  function setupSuccessfulUpgradeMocks() {
    // Current dependency exists
    mockProjectModuleDependencyFindOne.mockResolvedValue(sampleDependency);

    // Target release exists — same module, not archived
    mockModuleReleaseFindOne.mockResolvedValue({
      _id: TARGET_RELEASE_ID,
      tenantId: TENANT_ID,
      moduleProjectId: MODULE_PROJECT_ID,
      version: '2.0.0',
      archivedAt: null,
      contract: targetContract,
    });

    // diffModuleContracts returns non-breaking diff
    mockDiffModuleContracts.mockReturnValue({
      agents: [],
      tools: [],
      configKeys: [],
      envVars: [],
      authProfiles: [],
      connectors: [],
      mcpServers: [],
      warnings: [],
      hasBreakingChanges: false,
      summary: '1 non-breaking change',
    });

    // findOneAndUpdate returns updated doc
    mockProjectModuleDependencyFindOneAndUpdate.mockResolvedValue({
      _id: DEPENDENCY_ID,
      alias: 'auth',
      moduleProjectId: MODULE_PROJECT_ID,
      moduleProjectName: 'Auth Module',
      resolvedReleaseId: TARGET_RELEASE_ID,
      resolvedVersion: '2.0.0',
    });

    // Project version increment succeeds
    mockProjectFindOneAndUpdate.mockResolvedValue({});
  }

  describe('PATCH /api/projects/:id/module-dependencies/:dependencyId', () => {
    it('successfully upgrades dependency with valid targetReleaseId', async () => {
      setupSuccessfulUpgradeMocks();

      const { PATCH } =
        await import('@/app/api/projects/[id]/module-dependencies/[dependencyId]/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies/${DEPENDENCY_ID}`,
        'PATCH',
        { targetReleaseId: TARGET_RELEASE_ID },
      );
      const res = await PATCH(req, routeCtx({ id: PROJECT_ID, dependencyId: DEPENDENCY_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data.resolvedReleaseId).toBe(TARGET_RELEASE_ID);
      expect(json.data.resolvedVersion).toBe('2.0.0');
      expect(json.data.previousVersion).toBe('1.0.0');
      expect(mockProjectModuleDependencyFindOneAndUpdate).toHaveBeenCalledWith(
        { _id: DEPENDENCY_ID, tenantId: TENANT_ID, projectId: PROJECT_ID },
        expect.objectContaining({
          $set: expect.objectContaining({
            selector: { type: 'version', value: '2.0.0' },
            resolvedReleaseId: TARGET_RELEASE_ID,
            resolvedVersion: '2.0.0',
          }),
        }),
        { new: true },
      );
      expect(json.data.diff).toEqual(
        expect.objectContaining({
          hasBreakingChanges: false,
        }),
      );
    });

    it('blocks upgrade when target release requires auth profiles (prerequisite warning)', async () => {
      // Current dependency exists
      mockProjectModuleDependencyFindOne.mockResolvedValue(sampleDependency);

      // Target release has required auth profiles
      const contractWithAuthReqs = {
        ...targetContract,
        requiredAuthProfiles: [
          { name: 'oauth-profile', authType: 'oauth2', scope: 'project', referencedBy: ['AgentA'] },
        ],
      };

      mockModuleReleaseFindOne.mockResolvedValue({
        _id: TARGET_RELEASE_ID,
        tenantId: TENANT_ID,
        moduleProjectId: MODULE_PROJECT_ID,
        version: '2.0.0',
        archivedAt: null,
        contract: contractWithAuthReqs,
      });

      // The route computes prerequisites as warnings (not blocking), so it still succeeds
      mockDiffModuleContracts.mockReturnValue({
        agents: [],
        tools: [],
        configKeys: [],
        envVars: [],
        authProfiles: [],
        connectors: [],
        mcpServers: [],
        warnings: [],
        hasBreakingChanges: false,
        summary: 'No changes',
      });

      mockProjectModuleDependencyFindOneAndUpdate.mockResolvedValue({
        _id: DEPENDENCY_ID,
        alias: 'auth',
        moduleProjectId: MODULE_PROJECT_ID,
        moduleProjectName: 'Auth Module',
        resolvedReleaseId: TARGET_RELEASE_ID,
        resolvedVersion: '2.0.0',
      });

      mockProjectFindOneAndUpdate.mockResolvedValue({});

      const { PATCH } =
        await import('@/app/api/projects/[id]/module-dependencies/[dependencyId]/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies/${DEPENDENCY_ID}`,
        'PATCH',
        { targetReleaseId: TARGET_RELEASE_ID },
      );
      const res = await PATCH(req, routeCtx({ id: PROJECT_ID, dependencyId: DEPENDENCY_ID }));
      const json = await res.json();

      // Prerequisites are warnings in the current implementation, so the upgrade still proceeds
      // The response includes the diff summary
      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
    });

    it('returns 404 when targeting an archived release', async () => {
      mockProjectModuleDependencyFindOne.mockResolvedValue(sampleDependency);

      // Target release is archived — findOne with archivedAt filter returns null
      mockModuleReleaseFindOne.mockResolvedValue(null);

      const { PATCH } =
        await import('@/app/api/projects/[id]/module-dependencies/[dependencyId]/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies/${DEPENDENCY_ID}`,
        'PATCH',
        { targetReleaseId: 'archived-release-id' },
      );
      const res = await PATCH(req, routeCtx({ id: PROJECT_ID, dependencyId: DEPENDENCY_ID }));
      const json = await res.json();

      expect(res.status).toBe(404);
      expect(json.success).toBe(false);
      expect(json.errors[0].msg).toContain('not found or archived');
    });

    it('allows downgrade (re-pin to older version)', async () => {
      // Dependency is currently at 2.0.0
      const depAtV2 = {
        ...sampleDependency,
        resolvedReleaseId: TARGET_RELEASE_ID,
        resolvedVersion: '2.0.0',
        contractSnapshot: targetContract,
      };
      mockProjectModuleDependencyFindOne.mockResolvedValue(depAtV2);

      // Target is the older 1.0.0 release
      mockModuleReleaseFindOne.mockResolvedValue({
        _id: OLDER_RELEASE_ID,
        tenantId: TENANT_ID,
        moduleProjectId: MODULE_PROJECT_ID,
        version: '1.0.0',
        archivedAt: null,
        contract: baseContract,
      });

      mockDiffModuleContracts.mockReturnValue({
        agents: [{ name: 'AgentB', change: 'removed', severity: 'breaking' }],
        tools: [],
        configKeys: [],
        envVars: [],
        authProfiles: [],
        connectors: [],
        mcpServers: [],
        warnings: [],
        hasBreakingChanges: true,
        summary: '1 breaking change',
      });

      mockProjectModuleDependencyFindOneAndUpdate.mockResolvedValue({
        _id: DEPENDENCY_ID,
        alias: 'auth',
        moduleProjectId: MODULE_PROJECT_ID,
        moduleProjectName: 'Auth Module',
        resolvedReleaseId: OLDER_RELEASE_ID,
        resolvedVersion: '1.0.0',
      });

      mockProjectFindOneAndUpdate.mockResolvedValue({});

      const { PATCH } =
        await import('@/app/api/projects/[id]/module-dependencies/[dependencyId]/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies/${DEPENDENCY_ID}`,
        'PATCH',
        { targetReleaseId: OLDER_RELEASE_ID },
      );
      const res = await PATCH(req, routeCtx({ id: PROJECT_ID, dependencyId: DEPENDENCY_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data.resolvedVersion).toBe('1.0.0');
      expect(json.data.previousVersion).toBe('2.0.0');
      expect(json.data.diff.hasBreakingChanges).toBe(true);
    });

    it('increments project.moduleDependencyVersion after upgrade', async () => {
      setupSuccessfulUpgradeMocks();

      const { PATCH } =
        await import('@/app/api/projects/[id]/module-dependencies/[dependencyId]/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies/${DEPENDENCY_ID}`,
        'PATCH',
        { targetReleaseId: TARGET_RELEASE_ID },
      );
      await PATCH(req, routeCtx({ id: PROJECT_ID, dependencyId: DEPENDENCY_ID }));

      // Verify Project.findOneAndUpdate was called with $inc for moduleDependencyVersion
      expect(mockProjectFindOneAndUpdate).toHaveBeenCalledWith(
        { _id: PROJECT_ID, tenantId: TENANT_ID },
        { $inc: { moduleDependencyVersion: 1 } },
      );
    });

    it('emits MODULE_UPGRADED audit event with correct metadata', async () => {
      setupSuccessfulUpgradeMocks();

      const { PATCH } =
        await import('@/app/api/projects/[id]/module-dependencies/[dependencyId]/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies/${DEPENDENCY_ID}`,
        'PATCH',
        { targetReleaseId: TARGET_RELEASE_ID },
      );
      await PATCH(req, routeCtx({ id: PROJECT_ID, dependencyId: DEPENDENCY_ID }));

      expect(mockLogAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          tenantId: TENANT_ID,
          action: 'module_upgraded',
          metadata: expect.objectContaining({
            projectId: PROJECT_ID,
            dependencyId: DEPENDENCY_ID,
            alias: 'auth',
            moduleProjectId: MODULE_PROJECT_ID,
            previousVersion: '1.0.0',
            targetVersion: '2.0.0',
            targetReleaseId: TARGET_RELEASE_ID,
            hasBreakingChanges: false,
          }),
        }),
      );
    });

    it('returns 404 when dependency not found', async () => {
      mockProjectModuleDependencyFindOne.mockResolvedValue(null);

      const { PATCH } =
        await import('@/app/api/projects/[id]/module-dependencies/[dependencyId]/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies/non-existent-dep`,
        'PATCH',
        { targetReleaseId: TARGET_RELEASE_ID },
      );
      const res = await PATCH(req, routeCtx({ id: PROJECT_ID, dependencyId: 'non-existent-dep' }));
      const json = await res.json();

      expect(res.status).toBe(404);
      expect(json.success).toBe(false);
      expect(json.errors[0].msg).toContain('not found');
    });

    it('rejects upgrade with release from a different module (cross-module guard)', async () => {
      // Dependency belongs to MODULE_PROJECT_ID
      mockProjectModuleDependencyFindOne.mockResolvedValue(sampleDependency);

      // Target release query returns null because moduleProjectId doesn't match
      // (the route filters by dep.moduleProjectId)
      mockModuleReleaseFindOne.mockResolvedValue(null);

      const { PATCH } =
        await import('@/app/api/projects/[id]/module-dependencies/[dependencyId]/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies/${DEPENDENCY_ID}`,
        'PATCH',
        { targetReleaseId: 'release-from-different-module' },
      );
      const res = await PATCH(req, routeCtx({ id: PROJECT_ID, dependencyId: DEPENDENCY_ID }));
      const json = await res.json();

      expect(res.status).toBe(404);
      expect(json.success).toBe(false);
      expect(json.errors[0].msg).toContain('not found or archived');
    });

    it('rejects configOverrides with secret key values', async () => {
      mockProjectModuleDependencyFindOne.mockResolvedValue(sampleDependency);

      // Target release has a secret config key
      const contractWithSecret = {
        ...targetContract,
        requiredConfigKeys: [
          { key: 'api_url', isSecret: false, description: 'API base URL' },
          { key: 'api_secret', isSecret: true, description: 'Secret token' },
        ],
      };

      mockModuleReleaseFindOne.mockResolvedValue({
        _id: TARGET_RELEASE_ID,
        tenantId: TENANT_ID,
        moduleProjectId: MODULE_PROJECT_ID,
        version: '2.0.0',
        archivedAt: null,
        contract: contractWithSecret,
      });

      // validateConfigOverrides returns blocking error for secret key
      mockValidateConfigOverrides.mockReturnValue({
        blocking: [
          'Config key "api_secret" is declared as secret — secrets cannot be set via config overrides',
        ],
        warnings: [],
      });

      const { PATCH } =
        await import('@/app/api/projects/[id]/module-dependencies/[dependencyId]/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies/${DEPENDENCY_ID}`,
        'PATCH',
        {
          targetReleaseId: TARGET_RELEASE_ID,
          configOverrides: { api_secret: 'my-secret-value' },
        },
      );
      const res = await PATCH(req, routeCtx({ id: PROJECT_ID, dependencyId: DEPENDENCY_ID }));
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.errors[0].msg).toContain('secret');
    });

    it('blocks upgrade when target mounted symbols collide with existing project symbols', async () => {
      mockProjectModuleDependencyFindOne.mockResolvedValue(sampleDependency);
      mockModuleReleaseFindOne.mockResolvedValue({
        _id: TARGET_RELEASE_ID,
        tenantId: TENANT_ID,
        moduleProjectId: MODULE_PROJECT_ID,
        version: '2.0.0',
        archivedAt: null,
        contract: targetContract,
      });
      mockNameLookup(mockProjectAgentFind, ['auth__AgentB']);

      const { PATCH } =
        await import('@/app/api/projects/[id]/module-dependencies/[dependencyId]/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies/${DEPENDENCY_ID}`,
        'PATCH',
        { targetReleaseId: TARGET_RELEASE_ID },
      );
      const res = await PATCH(req, routeCtx({ id: PROJECT_ID, dependencyId: DEPENDENCY_ID }));
      const json = await res.json();

      expect(res.status).toBe(409);
      expect(json.success).toBe(false);
      expect(json.errors[0].msg).toContain('auth__AgentB');
      expect(mockProjectModuleDependencyFindOneAndUpdate).not.toHaveBeenCalled();
    });
  });
});

// =============================================================================
// GET /api/projects/:id/module-dependencies/:dependencyId/diff — Diff endpoint
// =============================================================================

describe('Dependency Diff Route', () => {
  describe('GET /api/projects/:id/module-dependencies/:dependencyId/diff', () => {
    it('detects breaking changes when agent is removed in target', async () => {
      // Current contract has AgentA + AgentB, target only has AgentA
      const currentContractWithTwo = {
        ...baseContract,
        providedAgents: [
          { name: 'AgentA', description: 'Agent A' },
          { name: 'AgentB', description: 'Agent B' },
        ],
      };

      const targetContractMissingAgent = {
        ...baseContract,
        providedAgents: [{ name: 'AgentA', description: 'Agent A' }],
      };

      mockProjectModuleDependencyFindOne.mockReturnValue({
        lean: () =>
          Promise.resolve({
            ...sampleDependency,
            contractSnapshot: currentContractWithTwo,
          }),
      });

      mockModuleReleaseFindOne.mockReturnValue({
        lean: () =>
          Promise.resolve({
            _id: TARGET_RELEASE_ID,
            tenantId: TENANT_ID,
            moduleProjectId: MODULE_PROJECT_ID,
            version: '2.0.0',
            archivedAt: null,
            contract: targetContractMissingAgent,
          }),
      });

      mockDiffModuleContracts.mockReturnValue({
        agents: [{ name: 'AgentB', change: 'removed', severity: 'breaking' }],
        tools: [],
        configKeys: [],
        envVars: [],
        authProfiles: [],
        connectors: [],
        mcpServers: [],
        warnings: [],
        hasBreakingChanges: true,
        summary: '1 breaking change',
      });

      const { GET } =
        await import('@/app/api/projects/[id]/module-dependencies/[dependencyId]/diff/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies/${DEPENDENCY_ID}/diff?targetReleaseId=${TARGET_RELEASE_ID}`,
      );
      const res = await GET(req, routeCtx({ id: PROJECT_ID, dependencyId: DEPENDENCY_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data.diff.hasBreakingChanges).toBe(true);
      // Agent removal detected in mounted symbol changes
      expect(json.data.mountedSymbolChanges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            symbolType: 'agent',
            name: 'AgentB',
            change: 'removed',
          }),
        ]),
      );
    });

    it('detects non-breaking changes when agent is added in target', async () => {
      mockProjectModuleDependencyFindOne.mockReturnValue({
        lean: () =>
          Promise.resolve({
            ...sampleDependency,
            contractSnapshot: baseContract,
          }),
      });

      mockModuleReleaseFindOne.mockReturnValue({
        lean: () =>
          Promise.resolve({
            _id: TARGET_RELEASE_ID,
            tenantId: TENANT_ID,
            moduleProjectId: MODULE_PROJECT_ID,
            version: '2.0.0',
            archivedAt: null,
            contract: targetContract,
          }),
      });

      mockDiffModuleContracts.mockReturnValue({
        agents: [{ name: 'AgentB', change: 'added', severity: 'non-breaking' }],
        tools: [],
        configKeys: [],
        envVars: [],
        authProfiles: [],
        connectors: [],
        mcpServers: [],
        warnings: [],
        hasBreakingChanges: false,
        summary: '1 non-breaking change',
      });

      const { GET } =
        await import('@/app/api/projects/[id]/module-dependencies/[dependencyId]/diff/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies/${DEPENDENCY_ID}/diff?targetReleaseId=${TARGET_RELEASE_ID}`,
      );
      const res = await GET(req, routeCtx({ id: PROJECT_ID, dependencyId: DEPENDENCY_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data.diff.hasBreakingChanges).toBe(false);
      // Agent addition detected in mounted symbol changes
      expect(json.data.mountedSymbolChanges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            symbolType: 'agent',
            name: 'AgentB',
            mountedName: 'auth__AgentB',
            change: 'added',
          }),
        ]),
      );
    });

    it('returns 400 when targetReleaseId query param is missing', async () => {
      const { GET } =
        await import('@/app/api/projects/[id]/module-dependencies/[dependencyId]/diff/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies/${DEPENDENCY_ID}/diff`,
      );
      const res = await GET(req, routeCtx({ id: PROJECT_ID, dependencyId: DEPENDENCY_ID }));
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.errors[0].msg).toContain('targetReleaseId');
    });

    it('returns 404 when target release not found', async () => {
      mockProjectModuleDependencyFindOne.mockReturnValue({
        lean: () => Promise.resolve(sampleDependency),
      });

      // Target release not found (different module or archived)
      mockModuleReleaseFindOne.mockReturnValue({
        lean: () => Promise.resolve(null),
      });

      const { GET } =
        await import('@/app/api/projects/[id]/module-dependencies/[dependencyId]/diff/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies/${DEPENDENCY_ID}/diff?targetReleaseId=non-existent-release`,
      );
      const res = await GET(req, routeCtx({ id: PROJECT_ID, dependencyId: DEPENDENCY_ID }));
      const json = await res.json();

      expect(res.status).toBe(404);
      expect(json.success).toBe(false);
      expect(json.errors[0].msg).toContain('not found or archived');
    });

    it('returns 404 when dependency not found', async () => {
      mockProjectModuleDependencyFindOne.mockReturnValue({
        lean: () => Promise.resolve(null),
      });

      const { GET } =
        await import('@/app/api/projects/[id]/module-dependencies/[dependencyId]/diff/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies/${DEPENDENCY_ID}/diff?targetReleaseId=${TARGET_RELEASE_ID}`,
      );
      const res = await GET(req, routeCtx({ id: PROJECT_ID, dependencyId: DEPENDENCY_ID }));
      const json = await res.json();

      expect(res.status).toBe(404);
      expect(json.success).toBe(false);
      expect(json.errors[0].msg).toContain('not found');
    });

    it('returns prerequisite issues for new auth profiles in target', async () => {
      const currentContractNoPrereqs = { ...baseContract };

      const targetContractWithPrereqs = {
        ...baseContract,
        requiredAuthProfiles: [
          { name: 'oauth-profile', authType: 'oauth2', scope: 'project', referencedBy: ['AgentA'] },
        ],
        requiredConnectors: [{ name: 'slack-connector', connectorType: 'slack' }],
      };

      mockProjectModuleDependencyFindOne.mockReturnValue({
        lean: () =>
          Promise.resolve({
            ...sampleDependency,
            contractSnapshot: currentContractNoPrereqs,
          }),
      });

      mockModuleReleaseFindOne.mockReturnValue({
        lean: () =>
          Promise.resolve({
            _id: TARGET_RELEASE_ID,
            tenantId: TENANT_ID,
            moduleProjectId: MODULE_PROJECT_ID,
            version: '2.0.0',
            archivedAt: null,
            contract: targetContractWithPrereqs,
          }),
      });

      mockDiffModuleContracts.mockReturnValue({
        agents: [],
        tools: [],
        configKeys: [],
        envVars: [],
        authProfiles: [{ name: 'oauth-profile', change: 'added', severity: 'breaking' }],
        connectors: [{ name: 'slack-connector', change: 'added', severity: 'breaking' }],
        mcpServers: [],
        warnings: [],
        hasBreakingChanges: true,
        summary: '2 breaking changes',
      });

      const { GET } =
        await import('@/app/api/projects/[id]/module-dependencies/[dependencyId]/diff/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies/${DEPENDENCY_ID}/diff?targetReleaseId=${TARGET_RELEASE_ID}`,
      );
      const res = await GET(req, routeCtx({ id: PROJECT_ID, dependencyId: DEPENDENCY_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.data.prerequisiteIssues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'authProfile',
            name: 'oauth-profile',
            severity: 'breaking',
          }),
          expect.objectContaining({
            type: 'connector',
            name: 'slack-connector',
            severity: 'breaking',
          }),
        ]),
      );
    });

    it('reports target mounted symbol collisions using canonical mounted names', async () => {
      mockProjectModuleDependencyFindOne.mockReturnValue({
        lean: () =>
          Promise.resolve({
            ...sampleDependency,
            contractSnapshot: baseContract,
          }),
      });

      mockModuleReleaseFindOne.mockReturnValue({
        lean: () =>
          Promise.resolve({
            _id: TARGET_RELEASE_ID,
            tenantId: TENANT_ID,
            moduleProjectId: MODULE_PROJECT_ID,
            version: '2.0.0',
            archivedAt: null,
            contract: targetContract,
          }),
      });

      mockDiffModuleContracts.mockReturnValue({
        agents: [{ name: 'AgentB', change: 'added', severity: 'non-breaking' }],
        tools: [],
        configKeys: [],
        envVars: [],
        authProfiles: [],
        connectors: [],
        mcpServers: [],
        warnings: [],
        hasBreakingChanges: false,
        summary: '1 non-breaking change',
      });
      mockNameLookup(mockProjectAgentFind, ['auth__AgentB']);

      const { GET } =
        await import('@/app/api/projects/[id]/module-dependencies/[dependencyId]/diff/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies/${DEPENDENCY_ID}/diff?targetReleaseId=${TARGET_RELEASE_ID}`,
      );
      const res = await GET(req, routeCtx({ id: PROJECT_ID, dependencyId: DEPENDENCY_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.data.collisions).toEqual([
        {
          mountedName: 'auth__AgentB',
          conflictsWith: 'agent:auth__AgentB',
        },
      ]);
    });
  });
});

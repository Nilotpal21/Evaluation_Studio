/**
 * Module Audit Event Tests
 *
 * Verifies that all module lifecycle actions emit correct audit events
 * via logAuditEvent with sanitized metadata.
 *
 * Covers:
 *   POST /api/projects/:id/module (enable)            → MODULE_ENABLED
 *   POST /api/projects/:id/module (disable)           → MODULE_DISABLED
 *   POST /api/projects/:id/module/releases (publish)  → MODULE_PUBLISHED
 *   POST /api/projects/:id/module/releases/:releaseId/promote → MODULE_PROMOTED
 *   POST /api/projects/:id/module-dependencies (import) → MODULE_IMPORTED
 *   DELETE /api/projects/:id/module-dependencies/:depId → MODULE_REMOVED
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

// Audit service — the key mock for this test file
const mockLogAuditEvent = vi.fn().mockResolvedValue(undefined);

vi.mock('@/services/audit-service', () => ({
  logAuditEvent: mockLogAuditEvent,
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
const mockProjectFindOne = vi.fn();
const mockProjectFindOneAndUpdate = vi.fn();
const mockProjectModuleDependencyCountDocuments = vi.fn();
const mockProjectModuleDependencyFindOne = vi.fn();
const mockProjectModuleDependencyCreate = vi.fn();
const mockProjectModuleDependencyDeleteOne = vi.fn();
const mockModuleReleaseFindOne = vi.fn();
const mockModuleReleaseCreate = vi.fn();
const mockModuleEnvironmentPointerFindOneAndUpdate = vi.fn();
const mockProjectAgentFind = vi.fn();
const mockProjectToolFind = vi.fn();
const mockProjectConfigVariableFind = vi.fn();
const mockAgentModelConfigCountDocuments = vi.fn();
const mockProjectRuntimeConfigFindOne = vi.fn();
const mockProjectLLMConfigFindOne = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  Project: {
    findOne: (...args: unknown[]) => mockProjectFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mockProjectFindOneAndUpdate(...args),
  },
  ProjectModuleDependency: {
    countDocuments: (...args: unknown[]) => mockProjectModuleDependencyCountDocuments(...args),
    findOne: (...args: unknown[]) => mockProjectModuleDependencyFindOne(...args),
    create: (...args: unknown[]) => mockProjectModuleDependencyCreate(...args),
    deleteOne: (...args: unknown[]) => mockProjectModuleDependencyDeleteOne(...args),
  },
  ModuleRelease: {
    findOne: (...args: unknown[]) => mockModuleReleaseFindOne(...args),
    create: (...args: unknown[]) => mockModuleReleaseCreate(...args),
  },
  ModuleEnvironmentPointer: {
    findOneAndUpdate: (...args: unknown[]) => mockModuleEnvironmentPointerFindOneAndUpdate(...args),
  },
  ProjectAgent: {
    find: (...args: unknown[]) => mockProjectAgentFind(...args),
  },
  ProjectTool: {
    find: (...args: unknown[]) => mockProjectToolFind(...args),
  },
  ProjectConfigVariable: {
    find: (...args: unknown[]) => mockProjectConfigVariableFind(...args),
  },
  AgentModelConfig: {
    countDocuments: (...args: unknown[]) => mockAgentModelConfigCountDocuments(...args),
  },
  ProjectRuntimeConfig: {
    findOne: (...args: unknown[]) => mockProjectRuntimeConfigFindOne(...args),
  },
  ProjectLLMConfig: {
    findOne: (...args: unknown[]) => mockProjectLLMConfigFindOne(...args),
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

// project-io — mock build/contract/safety for release publish
const mockBuildModuleRelease = vi.fn();
const mockExtractModuleContract = vi.fn();
const mockValidatePublishSafety = vi.fn();
const mockValidateConfigOverrides = vi.fn();
const mockResolveSelector = vi.fn();
const mockGetProjectExportReadinessIssues = vi.fn();
const mockParseAgentBasedABL = vi.fn((dsl: string) => {
  const nameMatch = /AGENT:\s*([A-Za-z0-9_]+)/.exec(dsl) ?? /name:\s*([A-Za-z0-9_]+)/.exec(dsl);
  return {
    document: { name: nameMatch?.[1] ?? 'TestAgent' },
    errors: [],
  };
});
const mockCompileABLtoIR = vi.fn((documents: Array<{ name?: string }>) => ({
  agents: Object.fromEntries(
    documents
      .filter((document) => typeof document?.name === 'string')
      .map((document) => [document.name as string, {}]),
  ),
  compilation_errors: [],
}));

vi.mock('@agent-platform/project-io', () => ({
  buildModuleRelease: (...args: unknown[]) => mockBuildModuleRelease(...args),
  extractModuleContract: mockExtractModuleContract,
  validatePublishSafety: mockValidatePublishSafety,
  validateConfigOverrides: (...args: unknown[]) => mockValidateConfigOverrides(...args),
  resolveSelector: (...args: unknown[]) => mockResolveSelector(...args),
  getProjectExportReadinessIssues: (...args: unknown[]) =>
    mockGetProjectExportReadinessIssues(...args),
  behaviorProfileConfigKeyToName: (key: string) =>
    key.startsWith('profile:') ? key.slice('profile:'.length) : null,
}));

// ABL compiler/parser — mock for publish route
vi.mock('@abl/core', () => ({
  parseAgentBasedABL: (...args: unknown[]) => mockParseAgentBasedABL(...args),
}));

vi.mock('@abl/compiler', () => ({
  compileABLtoIR: (...args: unknown[]) => mockCompileABLtoIR(...args),
}));

// =============================================================================
// CONSTANTS
// =============================================================================

const PROJECT_ID = 'proj-1';
const TENANT_ID = 'tenant-1';
const RELEASE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const MODULE_PROJECT_ID = 'proj-module-1';
const DEP_ID = 'dep-1';

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
  name: 'Test Project',
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

  mockValidateConfigOverrides.mockReturnValue({ blocking: [] });
  mockResolveSelector.mockResolvedValue({ releaseId: RELEASE_ID });
  mockGetProjectExportReadinessIssues.mockResolvedValue([]);
  mockProjectAgentFind.mockReturnValue({
    lean: () => Promise.resolve([]),
    select: () => ({ lean: () => Promise.resolve([]) }),
  });
  mockProjectToolFind.mockReturnValue({
    lean: () => Promise.resolve([]),
    select: () => ({ lean: () => Promise.resolve([]) }),
  });
  mockProjectRuntimeConfigFindOne.mockReturnValue({
    lean: () => Promise.resolve(null),
  });
  mockProjectLLMConfigFindOne.mockReturnValue({
    lean: () => Promise.resolve(null),
  });
});

// =============================================================================
// P1-I11: SANITIZED AUDIT EVENTS FOR ALL LIFECYCLE ACTIONS
// =============================================================================

describe('Module Audit Events', () => {
  describe('POST /api/projects/:id/module (enable) → MODULE_ENABLED', () => {
    it('emits MODULE_ENABLED audit event with projectId and moduleVisibility', async () => {
      mockProjectFindOne.mockReturnValue({
        lean: () => Promise.resolve({ _id: PROJECT_ID, kind: 'application' }),
      });
      mockProjectFindOneAndUpdate.mockResolvedValue({});

      const { POST } = await import('@/app/api/projects/[id]/module/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module`, 'POST', {
        enabled: true,
        moduleVisibility: 'tenant',
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));

      expect(res.status).toBe(200);

      // Wait for the fire-and-forget audit call
      await vi.waitFor(() => {
        expect(mockLogAuditEvent).toHaveBeenCalledTimes(1);
      });

      expect(mockLogAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          tenantId: TENANT_ID,
          action: 'module_enabled',
          metadata: expect.objectContaining({
            projectId: PROJECT_ID,
            moduleVisibility: 'tenant',
          }),
        }),
      );
    });

    it('defaults moduleVisibility to private in audit metadata when not specified', async () => {
      mockProjectFindOne.mockReturnValue({
        lean: () => Promise.resolve({ _id: PROJECT_ID, kind: 'application' }),
      });
      mockProjectFindOneAndUpdate.mockResolvedValue({});

      const { POST } = await import('@/app/api/projects/[id]/module/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module`, 'POST', {
        enabled: true,
      });
      await POST(req, routeCtx({ id: PROJECT_ID }));

      await vi.waitFor(() => {
        expect(mockLogAuditEvent).toHaveBeenCalledTimes(1);
      });

      expect(mockLogAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'module_enabled',
          metadata: expect.objectContaining({
            moduleVisibility: 'private',
          }),
        }),
      );
    });
  });

  describe('POST /api/projects/:id/module (disable) → MODULE_DISABLED', () => {
    it('emits MODULE_DISABLED audit event with projectId', async () => {
      mockProjectFindOne.mockReturnValue({
        lean: () => Promise.resolve({ _id: PROJECT_ID, kind: 'module' }),
      });
      mockProjectModuleDependencyCountDocuments.mockResolvedValue(0);
      mockProjectFindOneAndUpdate.mockResolvedValue({});

      const { POST } = await import('@/app/api/projects/[id]/module/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module`, 'POST', {
        enabled: false,
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));

      expect(res.status).toBe(200);

      await vi.waitFor(() => {
        expect(mockLogAuditEvent).toHaveBeenCalledTimes(1);
      });

      expect(mockLogAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          tenantId: TENANT_ID,
          action: 'module_disabled',
          metadata: expect.objectContaining({
            projectId: PROJECT_ID,
          }),
        }),
      );
    });
  });

  describe('POST /api/projects/:id/module/releases (publish) → MODULE_PUBLISHED', () => {
    beforeEach(() => {
      mockProjectFindOne.mockReturnValue({
        lean: () =>
          Promise.resolve({
            _id: PROJECT_ID,
            kind: 'module',
            entryAgentName: 'MainAgent',
          }),
      });
      mockProjectAgentFind.mockReturnValue({
        lean: () =>
          Promise.resolve([{ name: 'MainAgent', dslContent: 'AGENT:\n  name: MainAgent' }]),
        select: () => ({
          lean: () =>
            Promise.resolve([{ name: 'MainAgent', dslContent: 'AGENT:\n  name: MainAgent' }]),
        }),
      });
      mockProjectToolFind.mockReturnValue({
        lean: () => Promise.resolve([]),
        select: () => ({ lean: () => Promise.resolve([]) }),
      });
      mockProjectConfigVariableFind.mockReturnValue({
        select: () => ({ lean: () => Promise.resolve([]) }),
      });
      mockAgentModelConfigCountDocuments.mockResolvedValue(0);
    });

    it('emits MODULE_PUBLISHED audit event with projectId, releaseId, and version', async () => {
      mockBuildModuleRelease.mockReturnValue({
        success: true,
        artifact: { agents: {}, tools: {} },
        compiledIR: {},
        contract: { agents: [], tools: [] },
        sourceHash: 'abc123',
        warnings: [],
        errors: [],
      });

      mockModuleReleaseCreate.mockResolvedValue({ _id: RELEASE_ID });

      const { POST } = await import('@/app/api/projects/[id]/module/releases/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module/releases`, 'POST', {
        version: '1.0.0',
        releaseNotes: 'First release',
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));

      expect(res.status).toBe(201);

      await vi.waitFor(() => {
        expect(mockLogAuditEvent).toHaveBeenCalledTimes(1);
      });

      expect(mockLogAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          tenantId: TENANT_ID,
          action: 'module_published',
          metadata: expect.objectContaining({
            projectId: PROJECT_ID,
            releaseId: RELEASE_ID,
            version: '1.0.0',
          }),
        }),
      );
    });
  });

  describe('POST /api/projects/:id/module/releases/:releaseId/promote → MODULE_PROMOTED', () => {
    it('emits MODULE_PROMOTED audit event with projectId, releaseId, environment, and version', async () => {
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

      mockModuleEnvironmentPointerFindOneAndUpdate.mockResolvedValue({
        revision: 2,
        environment: 'staging',
        moduleReleaseId: RELEASE_ID,
      });

      const { POST } =
        await import('@/app/api/projects/[id]/module/releases/[releaseId]/promote/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module/releases/${RELEASE_ID}/promote`,
        'POST',
        { environment: 'staging', expectedRevision: 1 },
      );
      const res = await POST(req, routeCtx({ id: PROJECT_ID, releaseId: RELEASE_ID }));

      expect(res.status).toBe(200);

      await vi.waitFor(() => {
        expect(mockLogAuditEvent).toHaveBeenCalledTimes(1);
      });

      expect(mockLogAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          tenantId: TENANT_ID,
          action: 'module_promoted',
          metadata: expect.objectContaining({
            projectId: PROJECT_ID,
            releaseId: RELEASE_ID,
            environment: 'staging',
            version: '1.0.0',
          }),
        }),
      );
    });

    it('emits MODULE_PROMOTED for upsert path (no expectedRevision)', async () => {
      mockModuleReleaseFindOne.mockReturnValue({
        lean: () =>
          Promise.resolve({
            _id: RELEASE_ID,
            tenantId: TENANT_ID,
            moduleProjectId: PROJECT_ID,
            version: '2.0.0',
            archivedAt: null,
          }),
      });

      mockModuleEnvironmentPointerFindOneAndUpdate.mockResolvedValue({
        revision: 1,
        environment: 'dev',
        moduleReleaseId: RELEASE_ID,
      });

      const { POST } =
        await import('@/app/api/projects/[id]/module/releases/[releaseId]/promote/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module/releases/${RELEASE_ID}/promote`,
        'POST',
        { environment: 'dev' },
      );
      const res = await POST(req, routeCtx({ id: PROJECT_ID, releaseId: RELEASE_ID }));

      expect(res.status).toBe(200);

      await vi.waitFor(() => {
        expect(mockLogAuditEvent).toHaveBeenCalledTimes(1);
      });

      expect(mockLogAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'module_promoted',
          metadata: expect.objectContaining({
            environment: 'dev',
            version: '2.0.0',
          }),
        }),
      );
    });
  });

  describe('POST /api/projects/:id/module-dependencies (import) → MODULE_IMPORTED', () => {
    it('emits MODULE_IMPORTED audit event with alias and moduleProjectId in metadata', async () => {
      // Module project exists
      mockProjectFindOne.mockReturnValue({
        lean: vi.fn(),
      });
      // Override for the two findOne calls in the route:
      // 1st call: Project.findOne for module project verification (returns truthy)
      // We need to handle this differently — the route uses findOne without .lean() for project check
      mockProjectFindOne.mockReturnValue({ name: 'Auth Module' });

      // No alias conflict
      mockProjectModuleDependencyFindOne.mockResolvedValue(null);
      // Under max deps
      mockProjectModuleDependencyCountDocuments.mockResolvedValue(0);

      // Release exists
      mockModuleReleaseFindOne.mockResolvedValue({
        _id: RELEASE_ID,
        version: '1.0.0',
        contract: {
          providedAgents: [{ name: 'AuthAgent' }],
          providedTools: [],
          requiredConfigKeys: [],
        },
      });

      // Dependency created
      mockProjectModuleDependencyCreate.mockResolvedValue({
        _id: DEP_ID,
        alias: 'auth_mod',
        moduleProjectId: MODULE_PROJECT_ID,
        moduleProjectName: 'Auth Module',
        selector: { type: 'version', value: '1.0.0' },
        resolvedReleaseId: RELEASE_ID,
        resolvedVersion: '1.0.0',
        configOverrides: {},
        contractSnapshot: { providedAgents: [{ name: 'AuthAgent' }], providedTools: [] },
        createdAt: '2026-03-01',
        createdBy: 'user-1',
      });

      // Project version increment
      mockProjectFindOneAndUpdate.mockResolvedValue({});

      const { POST } = await import('@/app/api/projects/[id]/module-dependencies/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module-dependencies`, 'POST', {
        moduleProjectId: MODULE_PROJECT_ID,
        alias: 'auth_mod',
        selector: { type: 'version', value: '1.0.0' },
        resolvedReleaseId: RELEASE_ID,
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));

      expect(res.status).toBe(201);

      await vi.waitFor(() => {
        expect(mockLogAuditEvent).toHaveBeenCalledTimes(1);
      });

      expect(mockLogAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          tenantId: TENANT_ID,
          action: 'module_imported',
          metadata: expect.objectContaining({
            projectId: PROJECT_ID,
            moduleProjectId: MODULE_PROJECT_ID,
            alias: 'auth_mod',
            resolvedReleaseId: RELEASE_ID,
            dependencyId: DEP_ID,
          }),
        }),
      );
    });
  });

  describe('DELETE /api/projects/:id/module-dependencies/:depId → MODULE_REMOVED', () => {
    it('emits MODULE_REMOVED audit event with alias in metadata', async () => {
      // Dependency exists
      mockProjectModuleDependencyFindOne.mockResolvedValue({
        _id: DEP_ID,
        alias: 'auth_mod',
        moduleProjectId: MODULE_PROJECT_ID,
      });

      // Delete succeeds
      mockProjectModuleDependencyDeleteOne.mockResolvedValue({ deletedCount: 1 });

      // Project version increment
      mockProjectFindOneAndUpdate.mockResolvedValue({});

      const { DELETE } =
        await import('@/app/api/projects/[id]/module-dependencies/[dependencyId]/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module-dependencies/${DEP_ID}`,
        'DELETE',
      );
      const res = await DELETE(req, routeCtx({ id: PROJECT_ID, dependencyId: DEP_ID }));

      expect(res.status).toBe(200);

      await vi.waitFor(() => {
        expect(mockLogAuditEvent).toHaveBeenCalledTimes(1);
      });

      expect(mockLogAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          tenantId: TENANT_ID,
          action: 'module_removed',
          metadata: expect.objectContaining({
            projectId: PROJECT_ID,
            dependencyId: DEP_ID,
            alias: 'auth_mod',
            moduleProjectId: MODULE_PROJECT_ID,
          }),
        }),
      );
    });
  });

  describe('Audit failure resilience', () => {
    it('audit failure does not block the main enable request', async () => {
      mockProjectFindOne.mockReturnValue({
        lean: () => Promise.resolve({ _id: PROJECT_ID, kind: 'application' }),
      });
      mockProjectFindOneAndUpdate.mockResolvedValue({});

      // Make audit event reject
      mockLogAuditEvent.mockRejectedValue(new Error('Audit DB down'));

      const { POST } = await import('@/app/api/projects/[id]/module/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module`, 'POST', {
        enabled: true,
        moduleVisibility: 'tenant',
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));

      // Main request still succeeds
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
    });

    it('audit failure does not block the main promote request', async () => {
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

      mockModuleEnvironmentPointerFindOneAndUpdate.mockResolvedValue({
        revision: 2,
        environment: 'production',
        moduleReleaseId: RELEASE_ID,
      });

      // Make audit event reject
      mockLogAuditEvent.mockRejectedValue(new Error('Audit DB down'));

      const { POST } =
        await import('@/app/api/projects/[id]/module/releases/[releaseId]/promote/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module/releases/${RELEASE_ID}/promote`,
        'POST',
        { environment: 'production', expectedRevision: 1 },
      );
      const res = await POST(req, routeCtx({ id: PROJECT_ID, releaseId: RELEASE_ID }));

      // Main request still succeeds
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
    });
  });
});

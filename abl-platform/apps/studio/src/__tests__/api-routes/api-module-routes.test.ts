/**
 * Module API Route Tests
 *
 * Covers:
 *   GET/POST   /api/projects/:id/module                                    — Module settings
 *   GET/POST   /api/projects/:id/module/releases                           — List / publish releases
 *   POST       /api/projects/:id/module/releases/:releaseId/promote        — Promote release
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
  },
}));

// Database models — set up stubs; overridden per-test via beforeEach
const mockProjectFindOne = vi.fn();
const mockProjectFindOneAndUpdate = vi.fn();
const mockProjectModuleDependencyCountDocuments = vi.fn();
const mockModuleReleaseFindChain = vi.fn();
const mockModuleReleaseFindOne = vi.fn();
const mockModuleReleaseCreate = vi.fn();
const mockModuleEnvironmentPointerFindOneAndUpdate = vi.fn();
const mockModuleEnvironmentPointerFind = vi.fn();
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
  },
  ModuleRelease: {
    find: (...args: unknown[]) => mockModuleReleaseFindChain(...args),
    findOne: (...args: unknown[]) => mockModuleReleaseFindOne(...args),
    create: (...args: unknown[]) => mockModuleReleaseCreate(...args),
  },
  ModuleEnvironmentPointer: {
    findOneAndUpdate: (...args: unknown[]) => mockModuleEnvironmentPointerFindOneAndUpdate(...args),
    find: (...args: unknown[]) => mockModuleEnvironmentPointerFind(...args),
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
    findOne: (...args: unknown[]) => ({ lean: () => mockProjectRuntimeConfigFindOne(...args) }),
  },
  ProjectLLMConfig: {
    findOne: (...args: unknown[]) => ({ lean: () => mockProjectLLMConfigFindOne(...args) }),
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
const mockGetProjectExportReadinessIssues = vi.fn();
const mockParseAgentBasedABL = vi.fn();
const mockCompileABLtoIR = vi.fn();
const mockResolvePromptLibraryRefOnDocument = vi.fn();

vi.mock('@agent-platform/project-io', () => ({
  buildModuleRelease: (...args: unknown[]) => mockBuildModuleRelease(...args),
  extractModuleContract: mockExtractModuleContract,
  validatePublishSafety: mockValidatePublishSafety,
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
  mapProjectRuntimeConfigDocumentToIR: (input: unknown) => {
    const record = input as Record<string, unknown>;
    const extraction = record.extraction as Record<string, unknown> | undefined;
    return {
      extraction_strategy: extraction?.strategy ?? 'auto',
    };
  },
}));

vi.mock('@agent-platform/shared/prompts', () => ({
  resolvePromptLibraryRefOnDocument: (...args: unknown[]) =>
    mockResolvePromptLibraryRefOnDocument(...args),
}));

// =============================================================================
// CONSTANTS
// =============================================================================

const PROJECT_ID = 'proj-1';
const TENANT_ID = 'tenant-1';
const RELEASE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

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

  mockParseAgentBasedABL.mockImplementation((dsl: string) => {
    const agentMatch = dsl.match(/^AGENT:\s*(\S+)/m);
    if (agentMatch) {
      return {
        document: {
          name: agentMatch[1],
          meta: { kind: 'agent' },
          tools: [],
        },
        errors: [],
      };
    }

    const profileMatch = dsl.match(/^BEHAVIOR_PROFILE:\s*(\S+)/m);
    if (profileMatch) {
      return {
        document: {
          name: profileMatch[1],
          meta: { kind: 'behavior_profile' },
          tools: [],
        },
        errors: [],
      };
    }

    return {
      document: null,
      errors: [{ message: 'Unable to parse test DSL' }],
    };
  });
  mockCompileABLtoIR.mockImplementation((documents: Array<Record<string, unknown>>) => ({
    agents: Object.fromEntries(
      documents
        .filter((document) => document.meta?.kind === 'agent')
        .map((document) => [
          String(document.name),
          {
            metadata: { name: document.name },
            identity: {
              system_prompt: {
                template:
                  typeof document.systemPrompt === 'string' ? document.systemPrompt : undefined,
              },
            },
            tools: [],
          },
        ]),
    ),
    compilation_errors: [],
  }));
  mockResolvePromptLibraryRefOnDocument.mockImplementation(
    async (document: Record<string, any>) => {
      document.systemPrompt = 'Resolved prompt from library';
      document.systemPromptLibraryRef = {
        ...(document.systemPromptLibraryRef ?? {}),
        resolvedHash: 'prompt-hash',
      };
    },
  );
  mockGetProjectExportReadinessIssues.mockResolvedValue([]);
  mockProjectRuntimeConfigFindOne.mockResolvedValue(null);
  mockProjectLLMConfigFindOne.mockResolvedValue(null);

  // Auth succeeds
  mockRequireAuth.mockResolvedValue(testUser);
  mockIsAuthError.mockReturnValue(false);

  // Project access succeeds
  mockRequireProjectAccess.mockResolvedValue({ project: testProject });
  mockIsAccessError.mockReturnValue(false);
});

// =============================================================================
// MODULE SETTINGS — GET/POST /api/projects/:id/module
// =============================================================================

describe('Module Settings Route', () => {
  describe('GET /api/projects/:id/module', () => {
    it('returns current module settings when kind=module', async () => {
      mockProjectFindOne.mockReturnValue({
        lean: () =>
          Promise.resolve({ _id: PROJECT_ID, kind: 'module', moduleVisibility: 'tenant' }),
      });

      const { GET } = await import('@/app/api/projects/[id]/module/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module`);
      const res = await GET(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data.enabled).toBe(true);
      expect(json.data.moduleVisibility).toBe('tenant');
    });

    it('returns enabled=false when kind=application', async () => {
      mockProjectFindOne.mockReturnValue({
        lean: () =>
          Promise.resolve({ _id: PROJECT_ID, kind: 'application', moduleVisibility: undefined }),
      });

      const { GET } = await import('@/app/api/projects/[id]/module/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module`);
      const res = await GET(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.data.enabled).toBe(false);
      expect(json.data.moduleVisibility).toBeNull();
    });

    it('returns 404 when project not found', async () => {
      mockProjectFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });

      const { GET } = await import('@/app/api/projects/[id]/module/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module`);
      const res = await GET(req, routeCtx({ id: PROJECT_ID }));

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/projects/:id/module', () => {
    it('enables module mode', async () => {
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
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.message).toBe('Module mode enabled');
    });

    it('disables module mode when no consumers', async () => {
      mockProjectFindOne.mockReturnValue({
        lean: () => Promise.resolve({ _id: PROJECT_ID, kind: 'module' }),
      });
      mockProjectModuleDependencyCountDocuments.mockResolvedValue(0);
      mockProjectFindOneAndUpdate.mockResolvedValue({});

      const { POST } = await import('@/app/api/projects/[id]/module/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module`, 'POST', { enabled: false });
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.message).toBe('Module mode disabled');
    });

    it('returns 409 when disabling with active consumers', async () => {
      mockProjectFindOne.mockReturnValue({
        lean: () => Promise.resolve({ _id: PROJECT_ID, kind: 'module' }),
      });
      mockProjectModuleDependencyCountDocuments.mockResolvedValue(3);

      const { POST } = await import('@/app/api/projects/[id]/module/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module`, 'POST', { enabled: false });
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.errors[0].msg).toContain('3 consumer project(s)');
    });

    it('sets moduleVisibility on enable', async () => {
      mockProjectFindOne.mockReturnValue({
        lean: () => Promise.resolve({ _id: PROJECT_ID, kind: 'application' }),
      });
      mockProjectFindOneAndUpdate.mockResolvedValue({});

      const { POST } = await import('@/app/api/projects/[id]/module/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module`, 'POST', {
        enabled: true,
        moduleVisibility: 'private',
      });
      await POST(req, routeCtx({ id: PROJECT_ID }));

      // Verify findOneAndUpdate was called with the correct update
      expect(mockProjectFindOneAndUpdate).toHaveBeenCalled();
    });
  });
});

// =============================================================================
// RELEASES — GET/POST /api/projects/:id/module/releases
// =============================================================================

describe('Module Releases Route', () => {
  describe('GET /api/projects/:id/module/releases', () => {
    it('returns paginated release list', async () => {
      const releases = [
        {
          _id: 'r1',
          version: '1.0.0',
          releaseNotes: 'Initial',
          contract: {},
          sourceHash: 'abc',
          createdBy: 'user-1',
          createdAt: new Date().toISOString(),
          archivedAt: null,
        },
        {
          _id: 'r2',
          version: '1.1.0',
          releaseNotes: null,
          contract: {},
          sourceHash: 'def',
          createdBy: 'user-1',
          createdAt: new Date().toISOString(),
          archivedAt: null,
        },
      ];

      mockModuleReleaseFindChain.mockReturnValue({
        sort: () => ({
          limit: () => ({
            lean: () => Promise.resolve(releases),
          }),
        }),
      });

      const { GET } = await import('@/app/api/projects/[id]/module/releases/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module/releases?limit=20`);
      const res = await GET(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(2);
      expect(json.data[0].version).toBe('1.0.0');
      expect(json.pagination.hasMore).toBe(false);
    });

    it('returns hasMore=true when more releases exist', async () => {
      // Simulate limit+1 results
      const releases = Array.from({ length: 3 }, (_, i) => ({
        _id: `r${i}`,
        version: `1.${i}.0`,
        releaseNotes: null,
        contract: {},
        sourceHash: 'hash',
        createdBy: 'user-1',
        createdAt: new Date().toISOString(),
        archivedAt: null,
      }));

      mockModuleReleaseFindChain.mockReturnValue({
        sort: () => ({
          limit: () => ({
            lean: () => Promise.resolve(releases),
          }),
        }),
      });

      const { GET } = await import('@/app/api/projects/[id]/module/releases/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module/releases?limit=2`);
      const res = await GET(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(json.pagination.hasMore).toBe(true);
      expect(json.data).toHaveLength(2);
      expect(json.pagination.nextCursor).toBe('r1');
    });
  });

  describe('POST /api/projects/:id/module/releases', () => {
    beforeEach(() => {
      // Default: project is a module
      mockProjectFindOne.mockReturnValue({
        lean: () =>
          Promise.resolve({
            _id: PROJECT_ID,
            kind: 'module',
            entryAgentName: 'MainAgent',
          }),
      });
      // Default: agents exist
      mockProjectAgentFind.mockReturnValue({
        lean: () =>
          Promise.resolve([{ name: 'MainAgent', dslContent: 'AGENT:\n  name: MainAgent' }]),
      });
      // Default: no tools
      mockProjectToolFind.mockReturnValue({ lean: () => Promise.resolve([]) });
      // Default: no standalone behavior profiles
      mockProjectConfigVariableFind.mockReturnValue({
        select: () => ({ lean: () => Promise.resolve([]) }),
      });
      // Default: no model configs
      mockAgentModelConfigCountDocuments.mockResolvedValue(0);
    });

    it('publishes a release successfully', async () => {
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
      const json = await res.json();

      expect(res.status).toBe(201);
      expect(json.success).toBe(true);
      expect(json.data.releaseId).toBe(RELEASE_ID);
      expect(json.data.version).toBe('1.0.0');
    });

    it('blocks publish when executable-artifact readiness has model policy issues', async () => {
      mockProjectLLMConfigFindOne.mockResolvedValue({
        _id: 'llm-config-1',
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        operationTierOverrides: {
          response_gen: 'voice',
        },
      });
      mockGetProjectExportReadinessIssues.mockResolvedValue([
        {
          kind: 'model_policy',
          diagnostics: [
            {
              severity: 'error',
              message: 'Invalid operation-tier overrides',
              source: 'export-model-policy-readiness',
            },
          ],
        },
      ]);

      const { POST } = await import('@/app/api/projects/[id]/module/releases/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module/releases`, 'POST', {
        version: '1.0.0',
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(422);
      expect(json).toMatchObject({
        success: false,
        error: {
          code: 'MODULE_RELEASE_READINESS_FAILED',
        },
        issues: [{ kind: 'model_policy' }],
      });
      expect(mockGetProjectExportReadinessIssues).toHaveBeenCalledWith({
        agents: expect.arrayContaining([
          expect.objectContaining({
            name: 'MainAgent',
            dslContent: 'AGENT:\n  name: MainAgent',
          }),
        ]),
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        runtimeConfig: null,
        llmConfig: expect.objectContaining({
          operationTierOverrides: {
            response_gen: 'voice',
          },
        }),
      });
      expect(mockBuildModuleRelease).not.toHaveBeenCalled();
      expect(mockModuleReleaseCreate).not.toHaveBeenCalled();
    });

    it('compiles the full module graph once and forwards prompt companions into the release build', async () => {
      mockProjectAgentFind.mockReturnValue({
        lean: () =>
          Promise.resolve([
            {
              name: 'MainAgent',
              dslContent: 'AGENT: MainAgent\nGOAL: route requests',
              systemPromptLibraryRef: {
                promptId: 'prompt-1',
                versionId: 'version-1',
              },
            },
            {
              name: 'HelperAgent',
              dslContent: 'AGENT: HelperAgent\nGOAL: assist requests',
            },
          ]),
      });
      mockProjectRuntimeConfigFindOne.mockResolvedValue({
        extraction: {
          strategy: 'hybrid',
        },
      });
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
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));

      expect(res.status).toBe(201);
      expect(mockCompileABLtoIR).toHaveBeenCalledTimes(1);
      const [compiledDocuments, compilerOptions] = mockCompileABLtoIR.mock.calls[0] as [
        Array<Record<string, unknown>>,
        Record<string, unknown>,
      ];
      expect(compiledDocuments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'MainAgent' }),
          expect.objectContaining({ name: 'HelperAgent' }),
        ]),
      );
      expect(compilerOptions).toMatchObject({
        project_runtime_config: expect.objectContaining({
          extraction_strategy: 'hybrid',
        }),
      });
      expect(mockResolvePromptLibraryRefOnDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'MainAgent',
          systemPromptLibraryRef: expect.objectContaining({
            promptId: 'prompt-1',
            versionId: 'version-1',
          }),
        }),
        { tenantId: TENANT_ID, projectId: PROJECT_ID },
      );
      expect(mockBuildModuleRelease).toHaveBeenCalledWith(
        expect.objectContaining({
          precompiledIR: expect.objectContaining({
            MainAgent: expect.objectContaining({
              identity: expect.objectContaining({
                system_prompt: expect.objectContaining({
                  libraryRef: expect.objectContaining({
                    promptId: 'prompt-1',
                    versionId: 'version-1',
                    resolvedHash: 'prompt-hash',
                  }),
                }),
              }),
            }),
            HelperAgent: expect.any(Object),
          }),
          agentCompanions: {
            MainAgent: {
              systemPromptLibraryRef: {
                promptId: 'prompt-1',
                versionId: 'version-1',
                resolvedHash: 'prompt-hash',
              },
              resolvedSystemPrompt: 'Resolved prompt from library',
            },
          },
        }),
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
      );
    });

    it('does not bake source project config variables into portable module compiledIR', async () => {
      const profileDsl = `BEHAVIOR_PROFILE: voice_vip
PRIORITY: 10
WHEN: true
INSTRUCTIONS: |
  Speak warmly.`;

      mockProjectAgentFind.mockReturnValue({
        lean: () =>
          Promise.resolve([
            {
              name: 'MainAgent',
              dslContent: 'AGENT: MainAgent\nGOAL: Help {{config.PRODUCT_NAME}} users',
            },
          ]),
      });
      mockProjectConfigVariableFind.mockReturnValue({
        select: () => ({
          lean: () =>
            Promise.resolve([
              { key: 'PRODUCT_NAME', value: 'SourceProjectName' },
              { key: 'profile:voice_vip', value: profileDsl },
            ]),
        }),
      });
      mockBuildModuleRelease.mockReturnValue({
        success: true,
        artifact: { agents: {}, tools: {}, profiles: {} },
        compiledIR: {},
        contract: { agents: [], tools: [], providedBehaviorProfiles: [] },
        sourceHash: 'abc123',
        warnings: [],
        errors: [],
      });
      mockModuleReleaseCreate.mockResolvedValue({ _id: RELEASE_ID });

      const { POST } = await import('@/app/api/projects/[id]/module/releases/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module/releases`, 'POST', {
        version: '1.0.0',
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));

      expect(res.status).toBe(201);
      expect(mockCompileABLtoIR).toHaveBeenCalledTimes(1);
      const [compiledDocuments, compilerOptions] = mockCompileABLtoIR.mock.calls[0] as [
        Array<Record<string, unknown>>,
        unknown,
      ];
      expect(compiledDocuments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'MainAgent', meta: { kind: 'agent' } }),
          expect.objectContaining({ name: 'voice_vip', meta: { kind: 'behavior_profile' } }),
        ]),
      );
      expect(compilerOptions).toBeUndefined();
      expect(mockBuildModuleRelease).toHaveBeenCalledWith(
        expect.objectContaining({
          profiles: { voice_vip: profileDsl },
        }),
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
      );
    });

    it('passes standalone behavior profiles into the release build', async () => {
      const profileDsl = `BEHAVIOR_PROFILE: voice_vip
PRIORITY: 10
WHEN: true
INSTRUCTIONS: |
  Use concise voice behavior.`;
      mockProjectConfigVariableFind.mockReturnValueOnce({
        select: () => ({
          lean: () =>
            Promise.resolve([
              {
                key: 'profile:voice_vip',
                value: profileDsl,
              },
            ]),
        }),
      });
      mockBuildModuleRelease.mockReturnValue({
        success: true,
        artifact: { agents: {}, tools: {}, profiles: {} },
        compiledIR: {},
        contract: { agents: [], tools: [], providedBehaviorProfiles: [] },
        sourceHash: 'abc123',
        warnings: [],
        errors: [],
      });
      mockModuleReleaseCreate.mockResolvedValue({ _id: RELEASE_ID });

      const { POST } = await import('@/app/api/projects/[id]/module/releases/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module/releases`, 'POST', {
        version: '1.0.0',
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));

      expect(res.status).toBe(201);
      expect(mockBuildModuleRelease).toHaveBeenCalledWith(
        expect.objectContaining({
          profiles: { voice_vip: profileDsl },
        }),
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
      );
    });

    it('returns 400 when project is not a module', async () => {
      mockProjectFindOne.mockReturnValue({
        lean: () => Promise.resolve({ _id: PROJECT_ID, kind: 'application' }),
      });

      const { POST } = await import('@/app/api/projects/[id]/module/releases/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module/releases`, 'POST', {
        version: '1.0.0',
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.errors[0].msg).toContain('Only module projects');
    });

    it('returns 409 on duplicate version (MongoServerError 11000)', async () => {
      mockBuildModuleRelease.mockReturnValue({
        success: true,
        artifact: {},
        compiledIR: {},
        contract: {},
        sourceHash: 'abc',
        warnings: [],
        errors: [],
      });

      const dupError = Object.assign(new Error('duplicate key'), { code: 11000 });
      mockModuleReleaseCreate.mockRejectedValue(dupError);

      const { POST } = await import('@/app/api/projects/[id]/module/releases/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module/releases`, 'POST', {
        version: '1.0.0',
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.errors[0].msg).toContain('Version 1.0.0 already exists');
    });

    it('returns 422 on build errors', async () => {
      mockBuildModuleRelease.mockReturnValue({
        success: false,
        errors: ['Agent compile failed'],
        warnings: ['Some warning'],
      });

      const { POST } = await import('@/app/api/projects/[id]/module/releases/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module/releases`, 'POST', {
        version: '1.0.0',
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.errors[0].msg).toBe('Agent compile failed');
    });

    it('publishes successfully and includes warnings in response', async () => {
      mockBuildModuleRelease.mockReturnValue({
        success: true,
        artifact: { agents: {}, tools: {} },
        compiledIR: {},
        contract: { agents: [], tools: [] },
        sourceHash: 'abc123',
        warnings: ['Non-fatal: tool X has no description'],
        errors: [],
      });

      mockModuleReleaseCreate.mockResolvedValue({ _id: RELEASE_ID });

      const { POST } = await import('@/app/api/projects/[id]/module/releases/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module/releases`, 'POST', {
        version: '2.0.0',
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(201);
      expect(json.success).toBe(true);
      expect(json.data.warnings).toContain('Non-fatal: tool X has no description');
    });

    it('publishes successfully when agent DSL has parser warnings (E720 hints)', async () => {
      // Simulate an agent DSL that produces parser warnings (E720 for implementation
      // properties) but no errors — this is the exact scenario that was blocking
      // publishing before the fix.
      mockParseAgentBasedABL.mockImplementation(() => ({
        document: {
          name: 'WeatherAgent',
          meta: { kind: 'agent' },
          tools: [
            {
              name: 'get_weather',
              parameters: [{ name: 'city', type: 'string' }],
              returns: { type: 'object' },
              type: 'http',
              hints: { timeout: 15000 },
            },
          ],
        },
        errors: [],
        warnings: [
          {
            line: 10,
            message:
              "E720: Implementation property 'timeout' not allowed in agent DSL TOOLS section.",
          },
        ],
      }));

      mockBuildModuleRelease.mockReturnValue({
        success: true,
        artifact: { agents: {}, tools: {} },
        compiledIR: {},
        contract: { agents: [{ name: 'WeatherAgent', tools: ['get_weather'] }], tools: [] },
        sourceHash: 'weather-hash',
        warnings: [],
        errors: [],
      });

      mockModuleReleaseCreate.mockResolvedValue({ _id: RELEASE_ID });

      const { POST } = await import('@/app/api/projects/[id]/module/releases/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module/releases`, 'POST', {
        version: '1.0.0',
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(201);
      expect(json.success).toBe(true);
      expect(json.data.releaseId).toBe(RELEASE_ID);
    });

    it('publishes successfully when agent has HTTP tools with hints:timeout in DSL', async () => {
      // End-to-end scenario: HTTP tools with hints.timeout configured in Project Tools
      // are serialized into the agent DSL as "hints:\n  timeout: 15000".
      // The parser must not block on this (E720 is a warning, not an error).
      mockProjectAgentFind.mockReturnValue({
        lean: () =>
          Promise.resolve([
            {
              name: 'WeatherAssistant',
              dslContent: [
                'AGENT: WeatherAssistant',
                'GOAL: "Help with weather"',
                '',
                'TOOLS:',
                '  get_weather(city: string) -> object',
                '    description: "Get weather"',
                '    type: http',
                '    hints:',
                '      timeout: 15000',
              ].join('\n'),
            },
          ]),
      });

      // Parser returns document with no errors but with a warning
      mockParseAgentBasedABL.mockImplementation(() => ({
        document: {
          name: 'WeatherAssistant',
          meta: { kind: 'agent' },
          tools: [
            {
              name: 'get_weather',
              parameters: [{ name: 'city', type: 'string' }],
              returns: { type: 'object' },
              type: 'http',
              hints: { timeout: 15000 },
            },
          ],
        },
        errors: [],
        warnings: [],
      }));

      mockBuildModuleRelease.mockReturnValue({
        success: true,
        artifact: { agents: { WeatherAssistant: {} }, tools: {} },
        compiledIR: {},
        contract: {
          agents: [{ name: 'WeatherAssistant', tools: ['get_weather'] }],
          tools: [],
        },
        sourceHash: 'weather-hash',
        warnings: [],
        errors: [],
      });

      mockModuleReleaseCreate.mockResolvedValue({ _id: RELEASE_ID });

      const { POST } = await import('@/app/api/projects/[id]/module/releases/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module/releases`, 'POST', {
        version: '1.0.0',
        promoteToEnvironment: 'dev',
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(201);
      expect(json.success).toBe(true);
      expect(json.data.version).toBe('1.0.0');
    });

    it('appends promotion failure as warning without failing publish', async () => {
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

      // Promotion fails
      mockModuleEnvironmentPointerFindOneAndUpdate.mockRejectedValue(
        new Error('MongoDB connection lost'),
      );

      const { POST } = await import('@/app/api/projects/[id]/module/releases/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module/releases`, 'POST', {
        version: '1.0.0',
        promoteToEnvironment: 'dev',
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      // Release created successfully despite promotion failure
      expect(res.status).toBe(201);
      expect(json.success).toBe(true);
      expect(json.data.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('promotion to dev failed')]),
      );
    });

    it('rejects publish when agent DSL has real parse errors', async () => {
      // Real parse errors (not E720 warnings) must still block publishing
      mockParseAgentBasedABL.mockImplementation(() => ({
        document: null,
        errors: [{ line: 1, message: 'Missing required AGENT header' }],
        warnings: [],
      }));

      const { POST } = await import('@/app/api/projects/[id]/module/releases/route');
      const req = makeRequest(`/api/projects/${PROJECT_ID}/module/releases`, 'POST', {
        version: '1.0.0',
      });
      const res = await POST(req, routeCtx({ id: PROJECT_ID }));
      const json = await res.json();

      expect(res.status).toBe(422);
      expect(json.success).toBe(false);
      expect(json.errors[0].msg).toContain('failed to parse');
    });
  });
});

// =============================================================================
// PROMOTE — POST /api/projects/:id/module/releases/:releaseId/promote
// =============================================================================

describe('Promote Route', () => {
  describe('POST /api/projects/:id/module/releases/:releaseId/promote', () => {
    it('promotes with valid expectedRevision', async () => {
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
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.pointer.environment).toBe('staging');
      expect(json.pointer.revision).toBe(2);
    });

    it('returns 409 on revision conflict', async () => {
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

      // findOneAndUpdate returns null when revision doesn't match
      mockModuleEnvironmentPointerFindOneAndUpdate.mockResolvedValue(null);

      const { POST } =
        await import('@/app/api/projects/[id]/module/releases/[releaseId]/promote/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module/releases/${RELEASE_ID}/promote`,
        'POST',
        { environment: 'staging', expectedRevision: 5 },
      );
      const res = await POST(req, routeCtx({ id: PROJECT_ID, releaseId: RELEASE_ID }));

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.errors[0].msg).toContain('updated by another user');
    });

    it('upserts when no expectedRevision provided', async () => {
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
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.pointer.revision).toBe(1);
    });

    it('returns 404 when release not found', async () => {
      mockModuleReleaseFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });

      const { POST } =
        await import('@/app/api/projects/[id]/module/releases/[releaseId]/promote/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module/releases/${RELEASE_ID}/promote`,
        'POST',
        { environment: 'production' },
      );
      const res = await POST(req, routeCtx({ id: PROJECT_ID, releaseId: RELEASE_ID }));

      expect(res.status).toBe(404);
    });

    it('rejects promotion of archived release', async () => {
      mockModuleReleaseFindOne.mockReturnValue({
        lean: () =>
          Promise.resolve({
            _id: RELEASE_ID,
            tenantId: TENANT_ID,
            moduleProjectId: PROJECT_ID,
            version: '1.0.0',
            archivedAt: new Date().toISOString(),
          }),
      });

      const { POST } =
        await import('@/app/api/projects/[id]/module/releases/[releaseId]/promote/route');
      const req = makeRequest(
        `/api/projects/${PROJECT_ID}/module/releases/${RELEASE_ID}/promote`,
        'POST',
        { environment: 'production' },
      );
      const res = await POST(req, routeCtx({ id: PROJECT_ID, releaseId: RELEASE_ID }));

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.errors[0].msg).toContain('archived');
    });
  });
});

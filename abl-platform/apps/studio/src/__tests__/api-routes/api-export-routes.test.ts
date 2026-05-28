/**
 * Tests for Export API Route
 *
 * Covers:
 *   GET /api/projects/:id/export  — v2 layered export (always)
 *   Auth, permission, and size guard checks
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);

vi.mock('@/lib/auth', () => ({
  requireAuth: mockRequireAuth,
  isAuthError: mockIsAuthError,
}));

vi.mock('@/services/auth-service', () => ({
  verifyAccessToken: vi.fn(),
}));

vi.mock('@/repos/auth-repo', () => ({
  findUserById: vi.fn(),
}));

const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn(() => false);
const mockCanProjectPermissionContextPerform = vi.fn();
const mockResolveProjectPermissionContext = vi.fn();
const mockResolveStudioProjectPermissionAliases = vi.fn();
const mockHasPermission = vi.fn();
const mockHasAnyPermission = vi.fn();

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: mockRequireProjectAccess,
  isAccessError: mockIsAccessError,
}));

vi.mock('../../lib/project-permission', () => ({
  canProjectPermissionContextPerform: (...args: unknown[]) =>
    mockCanProjectPermissionContextPerform(...args),
  resolveProjectPermissionContext: (...args: unknown[]) =>
    mockResolveProjectPermissionContext(...args),
  resolveStudioProjectPermissionAliases: (...args: unknown[]) =>
    mockResolveStudioProjectPermissionAliases(...args),
}));

vi.mock('@/config', () => ({
  getConfig: vi.fn(() => ({
    jwt: { secret: 'test-jwt-secret' },
    server: { frontendUrl: 'http://localhost:5173' },
  })),
  isConfigLoaded: vi.fn(() => true),
}));

// Database models
const mockProjectAgentFind = vi.fn();
const mockProjectToolFind = vi.fn();
const mockProjectConfigVariableFind = vi.fn();
const mockDeploymentFind = vi.fn();
const mockConnectorConfigFind = vi.fn();
const mockMCPServerConfigFind = vi.fn();
const mockProjectRuntimeConfigFindOne = vi.fn();
const mockProjectLLMConfigFindOne = vi.fn();
const mockValidateProjectRuntimeConfigWrite = vi.fn();
const mockGetProjectExportReadinessIssues = vi.fn();
const mockBuildInvalidProjectExportPayload = vi.fn((issues: unknown[]) => ({
  success: false,
  error: {
    code: 'INVALID_AGENT_DRAFT',
    message:
      'Export blocked because the project working copy has validation errors. Fix the draft or runtime config diagnostics before exporting or syncing.',
  },
  issues,
}));

vi.mock('@agent-platform/database/models', () => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  ProjectAgent: {
    find: mockProjectAgentFind,
  },
  ProjectTool: {
    find: mockProjectToolFind,
  },
  ProjectConfigVariable: {
    find: mockProjectConfigVariableFind,
  },
  Deployment: {
    find: mockDeploymentFind,
  },
  ConnectorConfig: {
    find: mockConnectorConfigFind,
  },
  MCPServerConfig: {
    find: mockMCPServerConfigFind,
  },
  ProjectRuntimeConfig: {
    findOne: (...args: unknown[]) => ({
      lean: () => mockProjectRuntimeConfigFindOne(...args),
    }),
  },
  ProjectLLMConfig: {
    findOne: (...args: unknown[]) => ({
      lean: () => mockProjectLLMConfigFindOne(...args),
    }),
  },
}));

vi.mock('@agent-platform/project-io/import', () => ({
  validateProjectRuntimeConfigWrite: (...args: unknown[]) =>
    mockValidateProjectRuntimeConfigWrite(...args),
}));

vi.mock('@/lib/project-agent-export-readiness', () => ({
  getProjectExportReadinessIssues: (...args: unknown[]) =>
    mockGetProjectExportReadinessIssues(...args),
  buildInvalidProjectExportPayload: (...args: unknown[]) =>
    mockBuildInvalidProjectExportPayload(...args),
}));

// Export functions
const mockExportProject = vi.fn();
const mockExportProjectV2 = vi.fn();
const mockResolveLayers = vi.fn();
const mockResolveLayersForToolDependencies = vi.fn((layers: unknown) => layers);
const mockScanProjectEnvVars = vi.fn();
const mockExtractProfileManifestEntries = vi.fn(
  (profiles: Map<string, string>, _agents: Array<{ name: string; dslContent: string }>) =>
    Array.from(profiles.keys()).map((name) => ({
      name,
      file: `behavior_profiles/${name}.behavior_profile.abl`,
      sha256: `sha-${name}`,
      attached_agents: [],
    })),
);
const mockBuildExportProvisioningRequirements = vi.fn(() => ({
  requiredEnvVars: [],
  requiredAuthProfiles: [],
  requiredConnectors: [],
  requiredMcpServers: [],
}));

vi.mock('@agent-platform/project-io/export', () => ({
  exportProject: mockExportProject,
  exportProjectV2: mockExportProjectV2,
  resolveLayers: mockResolveLayers,
  resolveLayersForToolDependencies: mockResolveLayersForToolDependencies,
  scanProjectEnvVars: mockScanProjectEnvVars,
  extractProfileManifestEntries: mockExtractProfileManifestEntries,
  buildExportProvisioningRequirements: mockBuildExportProvisioningRequirements,
}));

const mockBehaviorProfileConfigKeyToName = vi.fn((key: string) =>
  key.startsWith('profile:') ? key.slice('profile:'.length) : null,
);

vi.mock('@agent-platform/project-io', () => ({
  behaviorProfileConfigKeyToName: mockBehaviorProfileConfigKeyToName,
}));

// Export assemblers (lazy-imported by v2 path)
const mockBuildAssemblerMap = vi.fn();
vi.mock('@/lib/export-assemblers', () => ({
  buildAssemblerMap: mockBuildAssemblerMap,
}));

// DSL compiler mocks
vi.mock('@abl/core', () => ({
  parseAgentBasedABL: vi.fn(() => ({ document: { name: 'test-agent' } })),
}));

vi.mock('@abl/compiler', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  compileABLtoIR: vi.fn(() => ({ agents: {}, entry_agent: null })),
}));

vi.mock('@agent-platform/openapi/nextjs', () => ({
  withOpenAPI: (_schema: unknown, handler: Function) => handler,
}));

// Stub permission resolver
vi.mock('@/lib/permission-resolver', () => ({
  resolveStudioPermissions: vi.fn().mockResolvedValue([]),
  hasPermission: (...args: unknown[]) => mockHasPermission(...args),
  hasAnyPermission: (...args: unknown[]) => mockHasAnyPermission(...args),
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/repos/project-repo', () => ({
  findProjectByIdAndTenant: vi.fn(),
  findProjectById: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testUser = {
  id: 'user-1',
  email: 'test@test.com',
  name: 'Test User',
  tenantId: 'tenant-1',
  permissions: ['project:export'],
};

const testProject = {
  id: 'proj-1',
  _id: 'proj-1',
  name: 'Test Project',
  slug: 'test-project',
  ownerId: 'user-1',
  tenantId: 'tenant-1',
  description: 'A test project',
  entryAgentName: 'main-agent',
};

function makeChainable(data: unknown[]) {
  return {
    select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(data) }),
    lean: vi.fn().mockResolvedValue(data),
  };
}

function hasPermissionMatch(granted: string[] = [], required: string): boolean {
  return granted.some((permission) => {
    if (permission === required || permission === '*:*') {
      return true;
    }

    const [grantedResource, grantedAction] = permission.split(':');
    const [requiredResource, requiredAction] = required.split(':');

    if (!grantedResource || !grantedAction || !requiredResource || !requiredAction) {
      return false;
    }

    return (
      (grantedResource === requiredResource || grantedResource === '*') &&
      (grantedAction === requiredAction || grantedAction === '*')
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue(testUser);
  mockIsAuthError.mockReturnValue(false);
  mockRequireProjectAccess.mockResolvedValue({ project: testProject });
  mockIsAccessError.mockReturnValue(false);
  mockResolveStudioProjectPermissionAliases.mockReturnValue(null);
  mockResolveProjectPermissionContext.mockResolvedValue({
    project: testProject,
    accessLevel: 'project_member',
    role: 'viewer',
    customRolePermissions: [],
  });
  mockCanProjectPermissionContextPerform.mockReturnValue(true);

  // Default agent/tool/deployment mocks (empty)
  mockProjectAgentFind.mockReturnValue(makeChainable([]));
  mockProjectToolFind.mockReturnValue(makeChainable([]));
  mockProjectConfigVariableFind.mockReturnValue(makeChainable([]));
  mockDeploymentFind.mockReturnValue(makeChainable([]));
  mockConnectorConfigFind.mockReturnValue(makeChainable([]));
  mockMCPServerConfigFind.mockReturnValue(makeChainable([]));
  mockProjectRuntimeConfigFindOne.mockResolvedValue(null);
  mockProjectLLMConfigFindOne.mockResolvedValue(null);
  mockValidateProjectRuntimeConfigWrite.mockResolvedValue({ valid: true, data: {} });
  mockGetProjectExportReadinessIssues.mockResolvedValue([]);

  mockResolveLayers.mockReturnValue(['core']);
  mockBuildAssemblerMap.mockReturnValue(new Map());
  mockScanProjectEnvVars.mockReturnValue([]);
  mockExtractProfileManifestEntries.mockImplementation(
    (profiles: Map<string, string>, _agents: Array<{ name: string; dslContent: string }>) =>
      Array.from(profiles.keys()).map((name) => ({
        name,
        file: `behavior_profiles/${name}.behavior_profile.abl`,
        sha256: `sha-${name}`,
        attached_agents: [],
      })),
  );
  mockBehaviorProfileConfigKeyToName.mockImplementation((key: string) =>
    key.startsWith('profile:') ? key.slice('profile:'.length) : null,
  );
  mockHasPermission.mockImplementation(hasPermissionMatch);
  mockHasAnyPermission.mockImplementation((granted: string[] = [], permissions: string[]) =>
    permissions.some((permission) => hasPermissionMatch(granted, permission)),
  );
});

// ===========================================================================
// GET /api/projects/:id/export — v2 export
// ===========================================================================

describe('GET /api/projects/:id/export?version=2', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/projects/[id]/export/route');
    handler = mod.GET;
  });

  it('returns v2 export with manifest/lockfile/warnings', async () => {
    mockProjectLLMConfigFindOne.mockResolvedValue({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      operationTierOverrides: { response_gen: 'powerful' },
    });
    mockExportProjectV2.mockResolvedValue({
      success: true,
      manifest: { version: '2.0', projectName: 'Test Project' },
      lockfile: { checksums: {} },
      files: new Map([['agents/main.abl', 'AGENT main {}']]),
      warnings: ['No entry agent specified'],
    });

    const req = new NextRequest(
      new URL('/api/projects/proj-1/export?version=2', 'http://localhost:3000'),
    );
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.version).toBe(2);
    expect(body.manifest).toBeDefined();
    expect(body.lockfile).toBeDefined();
    expect(body.warnings).toEqual(['No entry agent specified']);
    expect(body.files['agents/main.abl']).toBe('AGENT main {}');

    expect(mockExportProjectV2).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1', format: 'zip', dslFormat: 'source' }),
      expect.any(Object),
      expect.any(Object),
    );
    expect(mockProjectLLMConfigFindOne).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
    expect(mockGetProjectExportReadinessIssues).toHaveBeenCalledWith(
      expect.objectContaining({
        llmConfig: expect.objectContaining({
          operationTierOverrides: { response_gen: 'powerful' },
        }),
      }),
    );
  });

  it('passes explicit canonical YAML export mode when requested', async () => {
    mockExportProjectV2.mockResolvedValue({
      success: true,
      manifest: { format_version: '2.0' },
      lockfile: { lockfile_version: '2.0' },
      files: new Map([['agents/main.agent.yaml', 'agent: Main']]),
      warnings: [],
    });

    const req = new NextRequest(
      new URL('/api/projects/proj-1/export?dsl_format=yaml', 'http://localhost:3000'),
    );
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(200);

    expect(mockExportProjectV2).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1', dslFormat: 'yaml' }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('returns 400 when v2 export fails', async () => {
    mockExportProjectV2.mockResolvedValue({
      success: false,
      error: 'Layer assembly failed',
    });

    const req = new NextRequest(
      new URL('/api/projects/proj-1/export?version=2', 'http://localhost:3000'),
    );
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Layer assembly failed');
  });
});

// ===========================================================================
// GET /api/projects/:id/export — always uses v2 (no version param needed)
// ===========================================================================

describe('GET /api/projects/:id/export (default = v2)', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/projects/[id]/export/route');
    handler = mod.GET;
  });

  it('returns v2 export when no version specified', async () => {
    mockExportProjectV2.mockResolvedValue({
      success: true,
      manifest: { format_version: '2.0' },
      lockfile: { lockfile_version: '2.0' },
      files: new Map([['agents/main.abl', 'AGENT main {}']]),
      warnings: [],
    });

    const req = new NextRequest(new URL('/api/projects/proj-1/export', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.version).toBe(2);

    expect(mockExportProjectV2).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1' }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('preserves required MCP server metadata in the fast export contract', async () => {
    mockExportProjectV2.mockResolvedValue({
      success: true,
      manifest: {
        format_version: '2.0',
        metadata: {
          required_mcp_servers: ['public-repo-tools'],
        },
      },
      lockfile: { lockfile_version: '2.0' },
      files: new Map([
        [
          'core/mcp-servers/public-repo-tools.mcp-config.json',
          JSON.stringify({
            name: 'public-repo-tools',
            transport: 'sse',
            url: 'https://example.com/mcp',
          }),
        ],
        [
          'tools/search_docs.tools.abl',
          'TOOLS:\n  search_docs(query: string) -> object\n    server: "public-repo-tools"\n',
        ],
      ]),
      warnings: [],
    });

    const req = new NextRequest(new URL('/api/projects/proj-1/export', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.manifest.metadata.required_mcp_servers).toEqual(['public-repo-tools']);
    expect(body.files['core/mcp-servers/public-repo-tools.mcp-config.json']).toContain(
      '"name":"public-repo-tools"',
    );
    expect(body.files['tools/search_docs.tools.abl']).toContain('server: "public-repo-tools"');
  });

  it('passes stored behavior profiles into the export manifest contract', async () => {
    mockProjectAgentFind.mockReturnValue(
      makeChainable([
        {
          name: 'Main',
          description: 'Main agent',
          dslContent: 'AGENT: Main\nUSE BEHAVIOR_PROFILE: voice_vip\n',
          ownerId: 'user-1',
          ownerTeamId: null,
          version: '1.0',
          status: 'active',
        },
      ]),
    );
    mockProjectConfigVariableFind.mockReturnValue(
      makeChainable([
        {
          key: 'profile:voice_vip',
          value: 'BEHAVIOR_PROFILE: voice_vip\nPRIORITY: 5\nWHEN: channel == "voice"\n',
        },
      ]),
    );
    mockExportProjectV2.mockResolvedValue({
      success: true,
      manifest: {
        format_version: '2.0',
        behavior_profiles: {
          voice_vip: {
            name: 'voice_vip',
            path: 'behavior_profiles/voice_vip.behavior_profile.abl',
          },
        },
      },
      lockfile: { lockfile_version: '2.0' },
      files: new Map([
        [
          'behavior_profiles/voice_vip.behavior_profile.abl',
          'BEHAVIOR_PROFILE: voice_vip\nPRIORITY: 5\nWHEN: channel == "voice"\n',
        ],
      ]),
      warnings: [],
    });

    const req = new NextRequest(new URL('/api/projects/proj-1/export', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(200);

    expect(mockExportProjectV2).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        profiles: [
          expect.objectContaining({
            name: 'voice_vip',
            file: 'behavior_profiles/voice_vip.behavior_profile.abl',
            attached_agents: [],
          }),
        ],
        entityCounts: expect.objectContaining({
          behavior_profiles: 1,
        }),
      }),
    );
    expect(mockExtractProfileManifestEntries).toHaveBeenCalledWith(
      new Map([
        ['voice_vip', 'BEHAVIOR_PROFILE: voice_vip\nPRIORITY: 5\nWHEN: channel == "voice"\n'],
      ]),
      [
        {
          name: 'Main',
          dslContent: 'AGENT: Main\nUSE BEHAVIOR_PROFILE: voice_vip\n',
        },
      ],
    );

    const body = await res.json();
    expect(body.files['behavior_profiles/voice_vip.behavior_profile.abl']).toContain(
      'BEHAVIOR_PROFILE: voice_vip',
    );
    expect(body.manifest.behavior_profiles.voice_vip.path).toBe(
      'behavior_profiles/voice_vip.behavior_profile.abl',
    );
  });

  it('returns 400 when export fails', async () => {
    mockExportProjectV2.mockResolvedValue({
      success: false,
      error: 'Export failed',
    });

    const req = new NextRequest(new URL('/api/projects/proj-1/export', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('blocks export when a saved draft has validation errors', async () => {
    mockGetProjectExportReadinessIssues.mockResolvedValue([
      {
        kind: 'agent_draft',
        agentName: 'BrokenAgent',
        diagnostics: [
          {
            severity: 'error',
            message: 'Unknown ON_ACTION target',
            source: 'studio-save',
          },
        ],
      },
    ]);
    mockProjectAgentFind.mockReturnValue(
      makeChainable([
        {
          name: 'BrokenAgent',
          description: 'Invalid draft',
          dslContent: 'AGENT: BrokenAgent\nBROKEN',
          ownerId: 'user-1',
          ownerTeamId: null,
          dslValidationStatus: 'error',
          dslDiagnostics: [
            {
              severity: 'error',
              message: 'Unknown ON_ACTION target',
              source: 'studio-save',
            },
          ],
        },
      ]),
    );

    const req = new NextRequest(new URL('/api/projects/proj-1/export', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });

    expect(res.status).toBe(409);
    expect(mockExportProjectV2).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_AGENT_DRAFT');
    expect(body.issues).toEqual([
      {
        kind: 'agent_draft',
        agentName: 'BrokenAgent',
        diagnostics: [
          {
            severity: 'error',
            message: 'Unknown ON_ACTION target',
            source: 'studio-save',
          },
        ],
      },
    ]);
  });

  it('blocks export when runtime config validation fails', async () => {
    mockGetProjectExportReadinessIssues.mockResolvedValue([
      {
        kind: 'runtime_config',
        diagnostics: [
          {
            severity: 'error',
            message: 'Runtime filler promptRef must reference an active project prompt version',
            source: 'export-runtime-config-readiness',
          },
        ],
      },
    ]);
    mockProjectRuntimeConfigFindOne.mockResolvedValue({
      filler: {
        enabled: true,
        promptRef: { promptId: 'prompt-1', versionId: 'archived-version' },
      },
      tenantId: 'tenant-1',
      projectId: 'proj-1',
    });
    mockValidateProjectRuntimeConfigWrite.mockResolvedValue({
      valid: false,
      code: 'RUNTIME_CONFIG_PROMPT_REF_INVALID',
      status: 400,
      message: 'Runtime filler promptRef must reference an active project prompt version',
    });

    const req = new NextRequest(new URL('/api/projects/proj-1/export', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });

    expect(res.status).toBe(409);
    expect(mockExportProjectV2).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_AGENT_DRAFT');
    expect(body.issues).toEqual([
      {
        kind: 'runtime_config',
        diagnostics: [
          {
            severity: 'error',
            message: 'Runtime filler promptRef must reference an active project prompt version',
            source: 'export-runtime-config-readiness',
          },
        ],
      },
    ]);
  });
});

// ===========================================================================
// Auth & Permission checks
// ===========================================================================

describe('GET /api/projects/:id/export — auth & permissions', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/projects/[id]/export/route');
    handler = mod.GET;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = new NextRequest(new URL('/api/projects/proj-1/export', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 403 without PROJECT_EXPORT permission', async () => {
    mockRequireAuth.mockResolvedValue({ ...testUser, id: 'member-1', permissions: [] });
    mockRequireProjectAccess.mockResolvedValue({
      project: { ...testProject, ownerId: 'owner-1' },
      accessPath: 'membership',
    });
    mockResolveStudioProjectPermissionAliases.mockReturnValue(['project:export']);
    mockCanProjectPermissionContextPerform.mockReturnValue(false);

    const req = new NextRequest(new URL('/api/projects/proj-1/export', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(403);
    expect(mockResolveProjectPermissionContext).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({ id: 'member-1' }),
      {
        project: { ...testProject, ownerId: 'owner-1' },
      },
    );
  });
});

// ===========================================================================
// Size guard (enforced by exportProjectV2 via LAYER_SIZE_LIMITS)
// ===========================================================================

describe('GET /api/projects/:id/export — size guard', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/projects/[id]/export/route');
    handler = mod.GET;
  });

  it('returns 429 when v2 export reports SIZE_LIMIT_EXCEEDED', async () => {
    mockExportProjectV2.mockResolvedValue({
      success: false,
      error: { code: 'SIZE_LIMIT_EXCEEDED', message: 'Layer "core" has 1001 agents (max 1000)' },
    });

    const req = new NextRequest(new URL('/api/projects/proj-1/export', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ id: 'proj-1' }) });
    expect(res.status).toBe(429);

    const body = await res.json();
    expect(body.success).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);

vi.mock('@/lib/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
}));

vi.mock('@/services/auth-service', () => ({
  verifyAccessToken: vi.fn(),
}));

vi.mock('@/repos/auth-repo', () => ({
  findUserById: vi.fn(),
}));

const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn(() => false);
vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: unknown[]) => mockRequireProjectAccess(...args),
  isAccessError: (...args: unknown[]) => mockIsAccessError(...args),
}));

const mockCanProjectPermissionContextPerform = vi.fn();
const mockResolveProjectPermissionContext = vi.fn();
const mockResolveStudioProjectPermissionAliases = vi.fn();
vi.mock('@/lib/project-permission', () => ({
  canProjectPermissionContextPerform: (...args: unknown[]) =>
    mockCanProjectPermissionContextPerform(...args),
  resolveProjectPermissionContext: (...args: unknown[]) =>
    mockResolveProjectPermissionContext(...args),
  resolveStudioProjectPermissionAliases: (...args: unknown[]) =>
    mockResolveStudioProjectPermissionAliases(...args),
}));

const mockHasPermission = vi.fn();
const mockHasAnyPermission = vi.fn();
vi.mock('@/lib/permission-resolver', () => ({
  resolveStudioPermissions: vi.fn().mockResolvedValue([]),
  hasPermission: (...args: unknown[]) => mockHasPermission(...args),
  hasAnyPermission: (...args: unknown[]) => mockHasAnyPermission(...args),
}));

vi.mock('@/config', () => ({
  getConfig: vi.fn(() => ({
    jwt: { secret: 'test-jwt-secret' },
    server: { frontendUrl: 'http://localhost:5173' },
  })),
  isConfigLoaded: vi.fn(() => true),
}));

const mockResolveGitCredentials = vi.fn();
vi.mock('@/lib/git-credentials', () => ({
  resolveGitCredentials: (...args: unknown[]) => mockResolveGitCredentials(...args),
}));

const mockGitIntegrationFindOne = vi.fn();
const mockGitSyncHistoryCreate = vi.fn();
const mockGitIntegrationFindOneAndUpdate = vi.fn();
const mockProjectFindOne = vi.fn();
const mockProjectAgentFind = vi.fn();
const mockProjectToolFind = vi.fn();
const mockProjectConfigVariableFind = vi.fn();
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
  GitIntegration: {
    findOne: (...args: unknown[]) => mockGitIntegrationFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mockGitIntegrationFindOneAndUpdate(...args),
  },
  GitSyncHistory: {
    create: (...args: unknown[]) => mockGitSyncHistoryCreate(...args),
  },
  Project: {
    findOne: (...args: unknown[]) => mockProjectFindOne(...args),
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
  ConnectorConfig: {
    find: (...args: unknown[]) => mockConnectorConfigFind(...args),
  },
  MCPServerConfig: {
    find: (...args: unknown[]) => mockMCPServerConfigFind(...args),
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

const mockExportProjectV2 = vi.fn();
const mockResolveLayers = vi.fn();
const mockResolveLayersForToolDependencies = vi.fn((layers: unknown) => layers);
const mockScanProjectEnvVars = vi.fn();
const mockExtractProfileManifestEntries = vi.fn();
const mockBuildExportProvisioningRequirements = vi.fn(() => ({
  requiredEnvVars: [],
  requiredAuthProfiles: [],
  requiredConnectors: [],
  requiredMcpServers: [],
}));
vi.mock('@agent-platform/project-io/export', () => ({
  exportProjectV2: (...args: unknown[]) => mockExportProjectV2(...args),
  resolveLayers: (...args: unknown[]) => mockResolveLayers(...args),
  resolveLayersForToolDependencies: (...args: unknown[]) =>
    mockResolveLayersForToolDependencies(...args),
  scanProjectEnvVars: (...args: unknown[]) => mockScanProjectEnvVars(...args),
  extractProfileManifestEntries: (...args: unknown[]) => mockExtractProfileManifestEntries(...args),
  buildExportProvisioningRequirements: (...args: unknown[]) =>
    mockBuildExportProvisioningRequirements(...args),
}));

vi.mock('@agent-platform/project-io', () => ({
  behaviorProfileConfigKeyToName: (key: string) =>
    key.startsWith('profile:') ? key.slice('profile:'.length) : null,
}));

const mockBuildAssemblerMap = vi.fn();
vi.mock('@/lib/export-assemblers', () => ({
  buildAssemblerMap: (...args: unknown[]) => mockBuildAssemblerMap(...args),
}));

const mockCreateGitProvider = vi.fn();
const mockGitSyncServicePush = vi.fn();

class MockGitSyncService {
  push(...args: unknown[]) {
    return mockGitSyncServicePush(...args);
  }
}

class MockGitCircuitBreakerError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super('Git provider temporarily unavailable');
  }
}

vi.mock('@agent-platform/project-io/git', () => ({
  createGitProvider: (...args: unknown[]) => mockCreateGitProvider(...args),
  GitSyncService: MockGitSyncService,
  GitCircuitBreakerError: MockGitCircuitBreakerError,
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  deriveRetentionClass: vi.fn(() => 'standard'),
}));

function makeChainable(data: unknown[]) {
  return {
    select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(data) }),
    lean: vi.fn().mockResolvedValue(data),
  };
}

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/projects/project-1/git/push', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/projects/[id]/git/push', () => {
  const testUser = {
    id: 'user-1',
    email: 'test@example.com',
    name: 'Test User',
    tenantId: 'tenant-1',
    permissions: ['project:git'],
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockRequireAuth.mockResolvedValue(testUser);
    mockIsAuthError.mockReturnValue(false);
    mockRequireProjectAccess.mockResolvedValue({
      project: {
        id: 'project-1',
        tenantId: 'tenant-1',
        ownerId: 'user-1',
        name: 'Support Ops',
        slug: 'support-ops',
      },
    });
    mockIsAccessError.mockReturnValue(false);
    mockResolveStudioProjectPermissionAliases.mockReturnValue(null);
    mockResolveProjectPermissionContext.mockResolvedValue({
      project: {
        id: 'project-1',
        tenantId: 'tenant-1',
        ownerId: 'user-1',
      },
      accessLevel: 'project_member',
      role: 'editor',
      customRolePermissions: [],
    });
    mockCanProjectPermissionContextPerform.mockReturnValue(true);
    mockHasPermission.mockReturnValue(true);
    mockHasAnyPermission.mockReturnValue(true);

    mockGitIntegrationFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        projectId: 'project-1',
        tenantId: 'tenant-1',
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-ops',
        authProfileId: 'auth-profile-1',
        defaultBranch: 'main',
        lastSyncCommit: 'abc123',
      }),
    });
    mockProjectFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'project-1',
        tenantId: 'tenant-1',
        name: 'Support Ops',
        slug: 'support-ops',
        description: 'Primary support project',
        entryAgentName: 'support_agent',
      }),
    });
    mockProjectAgentFind.mockReturnValue(
      makeChainable([
        {
          name: 'support_agent',
          description: 'Primary agent',
          dslContent: 'AGENT support_agent',
          ownerId: 'user-1',
          ownerTeamId: null,
          systemPromptLibraryRef: {
            promptId: 'prompt-1',
            versionId: 'version-1',
            resolvedHash: 'hash-1',
          },
        },
      ]),
    );
    mockProjectToolFind.mockReturnValue(
      makeChainable([
        {
          name: 'search_docs',
          slug: 'search_docs',
          dslContent: 'TOOL search_docs',
        },
      ]),
    );
    mockProjectConfigVariableFind.mockReturnValue(
      makeChainable([
        {
          key: 'profile:voice_vip',
          value: 'BEHAVIOR_PROFILE voice_vip',
        },
      ]),
    );
    mockConnectorConfigFind.mockReturnValue(makeChainable([]));
    mockMCPServerConfigFind.mockReturnValue(makeChainable([]));
    mockProjectRuntimeConfigFindOne.mockResolvedValue(null);
    mockProjectLLMConfigFindOne.mockResolvedValue(null);
    mockValidateProjectRuntimeConfigWrite.mockResolvedValue({ valid: true, data: {} });
    mockGetProjectExportReadinessIssues.mockResolvedValue([]);
    mockResolveLayers.mockReturnValue(['core', 'workflows']);
    mockBuildAssemblerMap.mockReturnValue(new Map());
    mockScanProjectEnvVars.mockReturnValue([]);
    mockExtractProfileManifestEntries.mockReturnValue([
      {
        name: 'voice_vip',
        file: 'behavior_profiles/voice_vip.behavior_profile.abl',
        sha256: 'sha-voice-vip',
        attached_agents: [],
      },
    ]);
    mockExportProjectV2.mockResolvedValue({
      success: true,
      manifest: { format_version: '2.0' },
      lockfile: { version: '2.0' },
      files: new Map([
        ['agents/support_agent.agent.yaml', 'agent: support_agent'],
        ['behavior_profiles/voice_vip.behavior_profile.abl', 'BEHAVIOR_PROFILE voice_vip'],
        ['workflows/escalate.workflow.json', '{"name":"escalate"}'],
        ['project.json', '{"format_version":"2.0"}'],
        ['abl.lock', '{"version":"2.0"}'],
      ]),
      warnings: [],
    });
    mockResolveGitCredentials.mockResolvedValue({ token: 'secret' });
    mockCreateGitProvider.mockReturnValue({ kind: 'github' });
    mockGitSyncServicePush.mockResolvedValue({
      success: true,
      commitSha: 'new123',
      changes: { added: [], modified: [], deleted: [] },
      conflicts: [],
    });
    mockGitSyncHistoryCreate.mockResolvedValue({});
    mockGitIntegrationFindOneAndUpdate.mockResolvedValue({});
  });

  it('pushes canonical layered export files instead of the legacy v1 project shape', async () => {
    const { POST } = await import('@/app/api/projects/[id]/git/push/route');

    const response = await POST(
      makeRequest({
        commitMessage: 'sync: export canonical files',
      }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(200);
    expect(mockGitSyncServicePush).toHaveBeenCalledTimes(1);

    const [[callArgs]] = mockGitSyncServicePush.mock.calls as Array<
      [
        {
          projectFiles?: Map<string, string>;
        },
      ]
    >;

    expect(callArgs.projectFiles).toEqual(
      new Map([
        ['agents/support_agent.agent.yaml', 'agent: support_agent'],
        ['behavior_profiles/voice_vip.behavior_profile.abl', 'BEHAVIOR_PROFILE voice_vip'],
        ['workflows/escalate.workflow.json', '{"name":"escalate"}'],
        ['project.json', '{"format_version":"2.0"}'],
        ['abl.lock', '{"version":"2.0"}'],
      ]),
    );
  });

  it.each(['/feature', 'feature/', 'feature..branch'])(
    'rejects unsafe push branch name %s',
    async (branch) => {
      const { POST } = await import('@/app/api/projects/[id]/git/push/route');

      const response = await POST(makeRequest({ branch }), {
        params: Promise.resolve({ id: 'project-1' }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({ error: 'Invalid branch name' }),
      );
      expect(mockGitSyncServicePush).not.toHaveBeenCalled();
    },
  );

  it('rejects unsafe pull request target branches before provider calls', async () => {
    const { POST } = await import('@/app/api/projects/[id]/git/push/route');

    const response = await POST(
      makeRequest({
        createPR: {
          title: 'Sync support project',
          description: 'Open a sync PR',
          targetBranch: '../main',
        },
      }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ error: 'Invalid pull request options' }),
    );
    expect(mockGitSyncServicePush).not.toHaveBeenCalled();
  });

  it('blocks git push when a saved draft has validation errors', async () => {
    mockGetProjectExportReadinessIssues.mockResolvedValue([
      {
        kind: 'agent_draft',
        agentName: 'support_agent',
        diagnostics: [
          { severity: 'error', message: 'Invalid handoff target', source: 'studio-save' },
        ],
      },
    ]);
    mockProjectAgentFind.mockReturnValue(
      makeChainable([
        {
          name: 'support_agent',
          description: 'Primary agent',
          dslContent: 'AGENT support_agent\nBROKEN',
          ownerId: 'user-1',
          ownerTeamId: null,
          dslValidationStatus: 'error',
          dslDiagnostics: [
            { severity: 'error', message: 'Invalid handoff target', source: 'studio-save' },
          ],
        },
      ]),
    );

    const { POST } = await import('@/app/api/projects/[id]/git/push/route');

    const response = await POST(makeRequest({ commitMessage: 'sync: invalid draft' }), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(409);
    expect(mockExportProjectV2).not.toHaveBeenCalled();
    expect(mockGitSyncServicePush).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.error.code).toBe('INVALID_AGENT_DRAFT');
    expect(body.issues[0].agentName).toBe('support_agent');
    expect(body.issues[0].kind).toBe('agent_draft');
  });

  it('blocks git push when runtime config validation fails', async () => {
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
      projectId: 'project-1',
    });
    mockValidateProjectRuntimeConfigWrite.mockResolvedValue({
      valid: false,
      code: 'RUNTIME_CONFIG_PROMPT_REF_INVALID',
      status: 400,
      message: 'Runtime filler promptRef must reference an active project prompt version',
    });

    const { POST } = await import('@/app/api/projects/[id]/git/push/route');

    const response = await POST(makeRequest({ commitMessage: 'sync: invalid runtime config' }), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(409);
    expect(mockExportProjectV2).not.toHaveBeenCalled();
    expect(mockGitSyncServicePush).not.toHaveBeenCalled();
    const body = await response.json();
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

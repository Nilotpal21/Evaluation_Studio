import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockEnsureConnected = vi.fn();
const mockGitIntegrationFindOne = vi.fn();
const mockGitIntegrationFindOneAndUpdate = vi.fn();
const mockGitSyncHistoryCreate = vi.fn();
const mockProjectAgentFind = vi.fn();
const mockProjectFindOne = vi.fn();
const mockProjectToolFind = vi.fn();
const mockResolveGitCredentials = vi.fn();
const mockCreateGitProvider = vi.fn();
const mockPull = vi.fn();
const mockPush = vi.fn();
const mockCreateEnvironmentBranch = vi.fn();
const mockPromoteBranch = vi.fn();
const mockLogAuditEvent = vi.fn();
const mockBuildProjectLocalizationFileMap = vi.fn();
const mockBuildProjectLocalizationRelativeFileMap = vi.fn();
const mockProjectConfigVariableFind = vi.fn();
const mockConnectorConfigFind = vi.fn();
const mockMCPServerConfigFind = vi.fn();
const mockProjectRuntimeConfigFindOne = vi.fn();
const mockProjectLLMConfigFindOne = vi.fn();
const mockApplyStudioLayeredImportV2 = vi.fn();
const mockBuildExportProvisioningRequirements = vi.fn();
const mockExportProjectV2 = vi.fn();
const mockResolveLayers = vi.fn();
const mockResolveLayersForToolDependencies = vi.fn((layers: unknown) => layers);
const mockExtractProfileManifestEntries = vi.fn();
const mockBuildAssemblerMap = vi.fn();
const mockGetProjectExportReadinessIssues = vi.fn();

vi.mock('@/lib/route-handler', () => ({
  withRouteHandler:
    (_options: unknown, handler: Function) =>
    async (request: NextRequest, ctx: { params: Promise<Record<string, string>> }) => {
      const params = await ctx.params;
      return handler({
        request,
        tenantId: 'tenant-1',
        user: {
          id: 'user-1',
          name: 'Test User',
          email: 'user-1@example.com',
          permissions: ['project:git', 'project:deploy'],
        },
        params,
        project: { id: params.id, tenantId: 'tenant-1' },
      });
    },
}));

vi.mock('@/lib/permissions', () => ({
  StudioPermission: {
    PROJECT_GIT: 'project:git',
    PROJECT_DEPLOY: 'project:deploy',
  },
}));

vi.mock('@/lib/git-credentials', () => ({
  resolveGitCredentials: (...args: unknown[]) => mockResolveGitCredentials(...args),
}));

vi.mock('@/services/audit-service', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
  AuditActions: {
    GIT_PULL_COMPLETED: 'git_pull_completed',
    GIT_PUSH_COMPLETED: 'git_push_completed',
    GIT_PROMOTION_COMPLETED: 'git_promotion_completed',
  },
}));

vi.mock('@/lib/localization-assets', () => ({
  buildProjectLocalizationFileMap: (...args: unknown[]) =>
    mockBuildProjectLocalizationFileMap(...args),
  buildProjectLocalizationRelativeFileMap: (...args: unknown[]) =>
    mockBuildProjectLocalizationRelativeFileMap(...args),
}));

vi.mock('@/lib/runtime-model-cache-invalidation', () => ({
  notifyRuntimeModelConfigChanged: vi.fn(),
}));

vi.mock('@/lib/project-import/layered-import-support', () => ({
  applyStudioLayeredImportV2: (...args: unknown[]) => mockApplyStudioLayeredImportV2(...args),
}));

vi.mock('@/lib/export-assemblers', () => ({
  buildAssemblerMap: (...args: unknown[]) => mockBuildAssemblerMap(...args),
}));

vi.mock('@/lib/project-agent-export-readiness', () => ({
  buildInvalidProjectExportPayload: vi.fn((issues: unknown[]) => ({ issues })),
  getProjectExportReadinessIssues: (...args: unknown[]) =>
    mockGetProjectExportReadinessIssues(...args),
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

vi.mock('@agent-platform/database/models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/database/models')>();
  return {
    ...actual,
    ensureConnected: (...args: unknown[]) => mockEnsureConnected(...args),
    GitIntegration: {
      findOne: (...args: unknown[]) => mockGitIntegrationFindOne(...args),
      findOneAndUpdate: (...args: unknown[]) => mockGitIntegrationFindOneAndUpdate(...args),
    },
    GitSyncHistory: {
      create: (...args: unknown[]) => mockGitSyncHistoryCreate(...args),
    },
    ProjectAgent: {
      find: (...args: unknown[]) => mockProjectAgentFind(...args),
    },
    Project: {
      findOne: (...args: unknown[]) => mockProjectFindOne(...args),
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
    ProjectTool: {
      find: (...args: unknown[]) => mockProjectToolFind(...args),
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
  };
});

vi.mock('@agent-platform/project-io/export', () => ({
  buildExportProvisioningRequirements: (...args: unknown[]) =>
    mockBuildExportProvisioningRequirements(...args),
  exportProjectV2: (...args: unknown[]) => mockExportProjectV2(...args),
  extractProfileManifestEntries: (...args: unknown[]) => mockExtractProfileManifestEntries(...args),
  resolveLayers: (...args: unknown[]) => mockResolveLayers(...args),
  resolveLayersForToolDependencies: (...args: unknown[]) =>
    mockResolveLayersForToolDependencies(...args),
}));

vi.mock('@agent-platform/project-io/git', () => ({
  createGitProvider: (...args: unknown[]) => mockCreateGitProvider(...args),
  GitSyncService: vi.fn(function GitSyncService() {
    return {
      pullProjectFiles: (...args: unknown[]) => mockPull(...args),
      pull: (...args: unknown[]) => mockPull(...args),
      push: (...args: unknown[]) => mockPush(...args),
    };
  }),
  BranchManager: vi.fn(function BranchManager() {
    return {
      createEnvironmentBranch: (...args: unknown[]) => mockCreateEnvironmentBranch(...args),
      promoteBranch: (...args: unknown[]) => mockPromoteBranch(...args),
    };
  }),
  GitCircuitBreakerError: class GitCircuitBreakerError extends Error {
    retryAfterMs: number;

    constructor(retryAfterMs: number) {
      super('Circuit breaker open');
      this.retryAfterMs = retryAfterMs;
    }
  },
}));

const testIntegration = {
  _id: 'git-int-1',
  projectId: 'proj-1',
  tenantId: 'tenant-1',
  provider: 'github',
  repositoryUrl: 'https://github.com/org/repo',
  defaultBranch: 'main',
  credentials: { type: 'token', secretId: 'secret-1' },
  syncConfig: { autoSync: true, conflictStrategy: 'manual' },
  lastSyncCommit: 'abc123',
};

function makeJsonRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.10',
      'user-agent': 'vitest',
    },
  });
}

function makeLayeredPreview() {
  return {
    valid: true,
    formatVersion: '2.0',
    layers: ['core'],
    layerChanges: {
      core: { added: 1, modified: 1, removed: 0, unchanged: 0 },
    },
    agentChanges: {
      added: ['agent-a'],
      modified: [{ name: 'agent-b', diff: { hunks: [] } }],
      removed: [],
      unchanged: [],
    },
    toolChanges: { added: [], modified: [], removed: [] },
    localeChanges: { added: [], modified: [], removed: [] },
    profileChanges: { added: [], modified: [], removed: [] },
    shaIntegrity: {
      valid: true,
      integrityMatch: true,
      layerResults: {},
      errors: [],
      warnings: [],
    },
    crossLayerDeps: { valid: true, missingDependencies: [], warnings: [] },
    syntaxErrors: [],
    issues: [],
    hasBlockingIssues: false,
    requiresAcknowledgement: false,
    blockingIssueCount: 0,
    nonBlockingIssueCount: 0,
    entryAgentResolution: { requested: null, resolved: null, matchedBy: 'none' },
    warnings: [],
  };
}

describe('project git audit routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockEnsureConnected.mockResolvedValue(undefined);
    mockResolveGitCredentials.mockResolvedValue({ token: 'resolved-token' });
    mockCreateGitProvider.mockReturnValue({ kind: 'provider' });
    mockLogAuditEvent.mockResolvedValue(undefined);
    mockBuildProjectLocalizationFileMap.mockResolvedValue(new Map());
    mockBuildProjectLocalizationRelativeFileMap.mockResolvedValue(new Map());

    mockGitIntegrationFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(testIntegration),
    });
    mockGitIntegrationFindOneAndUpdate.mockResolvedValue({});
    mockGitSyncHistoryCreate.mockResolvedValue({});
    mockProjectConfigVariableFind.mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
    });
    mockConnectorConfigFind.mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
    });
    mockMCPServerConfigFind.mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
    });
    mockProjectRuntimeConfigFindOne.mockResolvedValue(null);
    mockProjectLLMConfigFindOne.mockResolvedValue(null);
    mockProjectAgentFind.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi
        .fn()
        .mockResolvedValue([
          { name: 'agent-one', dslContent: 'agent One {}', ownerId: 'user-1', ownerTeamId: null },
        ]),
    });
    mockProjectToolFind.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([{ name: 'tool-one', slug: 'tool-one', dslContent: '' }]),
    });
    mockProjectFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'proj-1',
        name: 'Test Project',
        slug: 'test-project',
        description: 'desc',
        entryAgentName: 'agent-one',
      }),
    });
    mockApplyStudioLayeredImportV2.mockResolvedValue({
      success: true,
      preview: makeLayeredPreview(),
      warnings: [],
      applied: {
        created: 1,
        updated: 1,
        deleted: 0,
        toolsCreated: 0,
        toolsUpdated: 0,
        toolsDeleted: 0,
        modelPoliciesUpserted: 0,
        modelPoliciesDeleted: 0,
      },
    });
    mockResolveLayers.mockReturnValue(['core']);
    mockBuildAssemblerMap.mockReturnValue(new Map());
    mockBuildExportProvisioningRequirements.mockReturnValue({
      requiredEnvVars: [],
      requiredAuthProfiles: [],
      requiredConnectors: [],
      requiredMcpServers: [],
    });
    mockExtractProfileManifestEntries.mockReturnValue([]);
    mockExportProjectV2.mockResolvedValue({
      success: true,
      manifest: { format_version: '2.0' },
      lockfile: { version: '1.0' },
      files: new Map([['project.json', '{"format_version":"2.0"}']]),
      warnings: [],
    });
    mockGetProjectExportReadinessIssues.mockResolvedValue([]);
  });

  it('writes audit for successful git pull', async () => {
    mockPull.mockResolvedValue({
      branch: 'main',
      commitSha: 'commit-pull',
      files: new Map([['agents/agent-a.agent.abl', 'AGENT AgentA']]),
    });

    const { POST } = await import('@/app/api/projects/[id]/git/pull/route');
    const response = await POST(
      makeJsonRequest('http://localhost/api/projects/proj-1/git/pull', { branch: 'main' }),
      { params: Promise.resolve({ id: 'proj-1' }) },
    );

    expect(response.status).toBe(200);
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        tenantId: 'tenant-1',
        action: 'git_pull_completed',
        metadata: expect.objectContaining({
          projectId: 'proj-1',
          resourceType: 'git_integration',
          resourceId: 'git-int-1',
          branch: 'main',
          commitSha: 'commit-pull',
          dryRun: false,
          added: 1,
          modified: 1,
          deleted: 0,
        }),
      }),
    );
  });

  it('writes audit for successful git push', async () => {
    mockPush.mockResolvedValue({
      success: true,
      commitSha: 'commit-push',
      changes: { added: ['tool-a'], modified: ['agent-one'], deleted: [] },
      conflicts: [],
      error: null,
    });

    const { POST } = await import('@/app/api/projects/[id]/git/push/route');
    const response = await POST(
      makeJsonRequest('http://localhost/api/projects/proj-1/git/push', {
        branch: 'release',
        createPR: {
          title: 'Sync release',
          description: 'Promote latest changes',
          targetBranch: 'main',
        },
      }),
      { params: Promise.resolve({ id: 'proj-1' }) },
    );

    expect(response.status).toBe(200);
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        tenantId: 'tenant-1',
        action: 'git_push_completed',
        metadata: expect.objectContaining({
          projectId: 'proj-1',
          resourceType: 'git_integration',
          resourceId: 'git-int-1',
          branch: 'release',
          commitSha: 'commit-push',
          added: 1,
          modified: 1,
          deleted: 0,
          agentsCount: 1,
          createPR: expect.objectContaining({
            title: 'Sync release',
            targetBranch: 'main',
          }),
        }),
      }),
    );
  });

  it('writes audit for successful git promotion', async () => {
    mockPromoteBranch.mockResolvedValue({
      success: true,
      fromBranch: 'main',
      toBranch: 'staging',
      commitSha: 'commit-promote',
    });
    mockCreateEnvironmentBranch.mockResolvedValue(undefined);

    const { POST } = await import('@/app/api/projects/[id]/git/promote/route');
    const response = await POST(
      makeJsonRequest('http://localhost/api/projects/proj-1/git/promote', {
        from: 'main',
        to: 'staging',
      }),
      { params: Promise.resolve({ id: 'proj-1' }) },
    );

    expect(response.status).toBe(200);
    expect(mockCreateEnvironmentBranch).toHaveBeenCalledWith('staging', 'main');
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        tenantId: 'tenant-1',
        action: 'git_promotion_completed',
        metadata: expect.objectContaining({
          projectId: 'proj-1',
          resourceType: 'git_integration',
          resourceId: 'git-int-1',
          fromBranch: 'main',
          toBranch: 'staging',
          commitSha: 'commit-promote',
        }),
      }),
    );
  });

  it('keeps promotion successful when audit logging fails after provider promotion', async () => {
    mockPromoteBranch.mockResolvedValue({
      success: true,
      fromBranch: 'main',
      toBranch: 'staging',
      commitSha: 'commit-promote',
    });
    mockCreateEnvironmentBranch.mockResolvedValue(undefined);
    mockLogAuditEvent.mockRejectedValueOnce(new Error('audit sink unavailable'));

    const { POST } = await import('@/app/api/projects/[id]/git/promote/route');
    const response = await POST(
      makeJsonRequest('http://localhost/api/projects/proj-1/git/promote', {
        from: 'main',
        to: 'staging',
      }),
      { params: Promise.resolve({ id: 'proj-1' }) },
    );

    expect(response.status).toBe(200);
    expect(mockPromoteBranch).toHaveBeenCalledWith('main', 'staging');
  });
});

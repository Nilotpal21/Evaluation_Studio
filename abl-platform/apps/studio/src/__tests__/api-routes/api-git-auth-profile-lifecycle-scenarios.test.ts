/**
 * Git lifecycle credential propagation scenarios.
 *
 * Setup is only half of ABLP-976. Once an integration stores authProfileId,
 * every lifecycle operation must resolve credentials through that profile
 * instead of treating the profile id as a secret id.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/route-handler', () => ({
  withRouteHandler:
    (_options: unknown, handler: Function) =>
    async (request: NextRequest, ctx: { params: Promise<Record<string, string>> }) =>
      handler({
        request,
        tenantId: 'tenant-1',
        user: {
          id: 'user-1',
          email: 'user@example.com',
          name: 'User One',
          permissions: ['project:git', 'project:deploy'],
        },
        params: await ctx.params,
        project: { id: 'project-1', tenantId: 'tenant-1' },
      }),
}));

vi.mock('@/lib/permissions', () => ({
  StudioPermission: {
    PROJECT_GIT: 'project:git',
    PROJECT_DEPLOY: 'project:deploy',
  },
}));

const mockResolveGitCredentials = vi.fn();

vi.mock('@/lib/git-credentials', () => ({
  resolveGitCredentials: (...args: unknown[]) => mockResolveGitCredentials(...args),
}));

vi.mock('@/lib/redis-client', () => ({
  getRedisClient: () => null,
}));

const mockGitIntegrationFindOne = vi.fn();
const mockGitIntegrationFindOneAndUpdate = vi.fn();
const mockGitSyncHistoryCreate = vi.fn();
const mockProjectFindOne = vi.fn();
const mockProjectAgentFind = vi.fn();
const mockProjectToolFind = vi.fn();
const mockProjectConfigVariableFind = vi.fn();
const mockConnectorConfigFind = vi.fn();
const mockMCPServerConfigFind = vi.fn();
const mockProjectRuntimeConfigFindOne = vi.fn();
const mockProjectLLMConfigFindOne = vi.fn();

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

const mockExportProjectV2 = vi.fn();
const mockResolveLayers = vi.fn();
const mockResolveLayersForToolDependencies = vi.fn((layers: unknown) => layers);
const mockExtractProfileManifestEntries = vi.fn();
const mockBuildExportProvisioningRequirements = vi.fn();

vi.mock('@agent-platform/project-io/export', () => ({
  exportProjectV2: (...args: unknown[]) => mockExportProjectV2(...args),
  resolveLayers: (...args: unknown[]) => mockResolveLayers(...args),
  resolveLayersForToolDependencies: (...args: unknown[]) =>
    mockResolveLayersForToolDependencies(...args),
  extractProfileManifestEntries: (...args: unknown[]) => mockExtractProfileManifestEntries(...args),
  buildExportProvisioningRequirements: (...args: unknown[]) =>
    mockBuildExportProvisioningRequirements(...args),
}));

const mockPreviewStudioLayeredImportV2 = vi.fn();
const mockApplyStudioLayeredImportV2 = vi.fn();

vi.mock('@/lib/project-import/layered-import-support', () => ({
  previewStudioLayeredImportV2: (...args: unknown[]) => mockPreviewStudioLayeredImportV2(...args),
  applyStudioLayeredImportV2: (...args: unknown[]) => mockApplyStudioLayeredImportV2(...args),
}));

const mockNotifyRuntimeModelConfigChanged = vi.fn();

vi.mock('@/lib/runtime-model-cache-invalidation', () => ({
  notifyRuntimeModelConfigChanged: (...args: unknown[]) =>
    mockNotifyRuntimeModelConfigChanged(...args),
}));

vi.mock('@/lib/export-assemblers', () => ({
  buildAssemblerMap: vi.fn(() => new Map()),
}));

vi.mock('@/lib/project-agent-export-readiness', () => ({
  getProjectExportReadinessIssues: vi.fn().mockResolvedValue([]),
  buildInvalidProjectExportPayload: vi.fn((issues: unknown[]) => ({
    success: false,
    issues,
  })),
}));

vi.mock('@agent-platform/project-io', () => ({
  behaviorProfileConfigKeyToName: (key: string) =>
    key.startsWith('profile:') ? key.slice('profile:'.length) : null,
}));

const mockCreateGitProvider = vi.fn();
const mockPush = vi.fn();
const mockPullProjectFiles = vi.fn();
const mockCreateEnvironmentBranch = vi.fn();
const mockPromoteBranch = vi.fn();

vi.mock('@agent-platform/project-io/git', () => ({
  createGitProvider: (...args: unknown[]) => mockCreateGitProvider(...args),
  GitSyncService: vi.fn(function GitSyncService() {
    return {
      push: (...args: unknown[]) => mockPush(...args),
      pullProjectFiles: (...args: unknown[]) => mockPullProjectFiles(...args),
    };
  }),
  BranchManager: vi.fn(function BranchManager() {
    return {
      createEnvironmentBranch: (...args: unknown[]) => mockCreateEnvironmentBranch(...args),
      promoteBranch: (...args: unknown[]) => mockPromoteBranch(...args),
    };
  }),
  GitCircuitBreakerError: class GitCircuitBreakerError extends Error {
    constructor(public readonly retryAfterMs: number) {
      super('Circuit breaker open');
    }
  },
}));

const mockLogAuditEvent = vi.fn();

vi.mock('@/services/audit-service', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
  AuditActions: {
    GIT_PUSH_COMPLETED: 'git_push_completed',
    GIT_PULL_COMPLETED: 'git_pull_completed',
    GIT_PROMOTION_COMPLETED: 'git_promotion_completed',
  },
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
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(data),
  };
}

function makePostRequest(path: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer token' },
    body: JSON.stringify(body),
  });
}

const integrationWithAuthProfile = {
  _id: 'git-integration-1',
  projectId: 'project-1',
  tenantId: 'tenant-1',
  provider: 'github',
  repositoryUrl: 'https://github.com/acme/support',
  defaultBranch: 'main',
  syncPath: '/',
  credentials: { type: 'token', secretId: 'legacy-secret-1' },
  authProfileId: 'auth-profile-1',
  syncConfig: { autoSync: true, conflictStrategy: 'manual' },
  lastSyncCommit: 'abc123',
};

function makeLayeredPreview() {
  return {
    valid: true,
    formatVersion: '2.0',
    layers: ['core'],
    layerChanges: {
      core: { added: 0, modified: 0, removed: 0, unchanged: 0 },
    },
    agentChanges: {
      added: [],
      modified: [],
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
    crossLayerDeps: {
      valid: true,
      missingDependencies: [],
      warnings: [],
    },
    syntaxErrors: [],
    issues: [],
    hasBlockingIssues: false,
    requiresAcknowledgement: false,
    blockingIssueCount: 0,
    nonBlockingIssueCount: 0,
    entryAgentResolution: {
      requested: null,
      resolved: null,
      matchedBy: 'none',
    },
    warnings: [],
  };
}

describe('Git lifecycle auth profile propagation scenarios', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    mockGitIntegrationFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(integrationWithAuthProfile),
    });
    mockGitIntegrationFindOneAndUpdate.mockResolvedValue({});
    mockGitSyncHistoryCreate.mockResolvedValue({});
    mockProjectFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'project-1',
        tenantId: 'tenant-1',
        name: 'Support',
        slug: 'support',
        entryAgentName: 'support_agent',
      }),
    });
    mockProjectAgentFind.mockReturnValue(
      makeChainable([{ name: 'support_agent', dslContent: 'AGENT support_agent' }]),
    );
    mockProjectToolFind.mockReturnValue(makeChainable([]));
    mockProjectConfigVariableFind.mockReturnValue(makeChainable([]));
    mockConnectorConfigFind.mockReturnValue(makeChainable([]));
    mockMCPServerConfigFind.mockReturnValue(makeChainable([]));
    mockProjectRuntimeConfigFindOne.mockResolvedValue(null);
    mockProjectLLMConfigFindOne.mockResolvedValue(null);

    mockResolveGitCredentials.mockResolvedValue({ type: 'token', token: 'resolved-profile-token' });
    mockCreateGitProvider.mockReturnValue({ kind: 'provider' });
    mockResolveLayers.mockReturnValue(['core']);
    mockExtractProfileManifestEntries.mockReturnValue([]);
    mockBuildExportProvisioningRequirements.mockReturnValue({
      requiredEnvVars: [],
      requiredAuthProfiles: [],
      requiredConnectors: [],
      requiredMcpServers: [],
    });
    mockExportProjectV2.mockResolvedValue({
      success: true,
      manifest: { format_version: '2.0' },
      lockfile: { version: '2.0' },
      files: new Map([['project.json', '{"format_version":"2.0"}']]),
      warnings: [],
    });
    mockPush.mockResolvedValue({
      success: true,
      commitSha: 'push-commit-1',
      changes: { added: [], modified: [], deleted: [] },
      conflicts: [],
    });
    mockPullProjectFiles.mockResolvedValue({
      branch: 'main',
      commitSha: 'pull-commit-1',
      files: new Map([['project.json', '{"format_version":"2.0"}']]),
    });
    mockPreviewStudioLayeredImportV2.mockResolvedValue({
      success: true,
      preview: makeLayeredPreview(),
      warnings: [],
    });
    mockApplyStudioLayeredImportV2.mockResolvedValue({
      success: true,
      preview: makeLayeredPreview(),
      warnings: [],
      applied: {},
    });
    mockCreateEnvironmentBranch.mockResolvedValue(undefined);
    mockPromoteBranch.mockResolvedValue({
      success: true,
      fromBranch: 'main',
      toBranch: 'staging',
      commitSha: 'promote-commit-1',
    });
    mockLogAuditEvent.mockResolvedValue(undefined);
    mockNotifyRuntimeModelConfigChanged.mockResolvedValue(undefined);
  });

  it('passes authProfileId into credential resolution during push', async () => {
    const { POST } = await import('@/app/api/projects/[id]/git/push/route');

    const response = await POST(makePostRequest('/api/projects/project-1/git/push', {}), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(200);
    expect(mockResolveGitCredentials).toHaveBeenCalledWith('auth-profile-1', 'tenant-1', {
      projectId: 'project-1',
      userId: 'user-1',
    });
  });

  it('passes authProfileId into credential resolution during pull', async () => {
    const { POST } = await import('@/app/api/projects/[id]/git/pull/route');

    const response = await POST(
      makePostRequest('/api/projects/project-1/git/pull', { dryRun: true }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(200);
    expect(mockResolveGitCredentials).toHaveBeenCalledWith('auth-profile-1', 'tenant-1', {
      projectId: 'project-1',
      userId: 'user-1',
    });
  });

  it('passes authProfileId into credential resolution during promotion', async () => {
    const { POST } = await import('@/app/api/projects/[id]/git/promote/route');

    const response = await POST(
      makePostRequest('/api/projects/project-1/git/promote', { from: 'main', to: 'staging' }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(200);
    expect(mockResolveGitCredentials).toHaveBeenCalledWith('auth-profile-1', 'tenant-1', {
      projectId: 'project-1',
      userId: 'user-1',
    });
  });

  it('fails legacy raw-secret integrations through credential resolution', async () => {
    mockResolveGitCredentials.mockRejectedValueOnce(
      new Error('Git integration requires an auth profile'),
    );
    mockGitIntegrationFindOne.mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue({
        ...integrationWithAuthProfile,
        authProfileId: null,
        credentials: { type: 'token', secretId: 'raw-secret-1' },
      }),
    });
    const { POST } = await import('@/app/api/projects/[id]/git/push/route');

    const response = await POST(makePostRequest('/api/projects/project-1/git/push', {}), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(500);
    expect(mockResolveGitCredentials).toHaveBeenCalledWith(null, 'tenant-1', {
      projectId: 'project-1',
      userId: 'user-1',
    });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('records a failed sync history entry when credential resolution fails during push', async () => {
    mockResolveGitCredentials.mockRejectedValueOnce(new Error('Auth profile revoked'));
    const { POST } = await import('@/app/api/projects/[id]/git/push/route');

    const response = await POST(makePostRequest('/api/projects/project-1/git/push', {}), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(500);
    expect(mockGitSyncHistoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        tenantId: 'tenant-1',
        direction: 'push',
        status: 'failed',
        triggeredBy: 'user-1',
      }),
    );
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('rejects concurrent mutating git operations for the same project', async () => {
    let finishPush: ((value: unknown) => void) | null = null;
    const pushGate = new Promise((resolve) => {
      finishPush = resolve;
    });
    mockPush.mockImplementationOnce(async () => {
      await pushGate;
      return {
        success: true,
        commitSha: 'push-commit-locked',
        changes: { added: [], modified: [], deleted: [] },
        conflicts: [],
      };
    });

    const { POST } = await import('@/app/api/projects/[id]/git/push/route');

    const first = POST(makePostRequest('/api/projects/project-1/git/push', {}), {
      params: Promise.resolve({ id: 'project-1' }),
    });
    await vi.waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));

    const second = await POST(makePostRequest('/api/projects/project-1/git/push', {}), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(second.status).toBe(423);
    await expect(second.json()).resolves.toEqual(
      expect.objectContaining({
        code: 'GIT_OPERATION_IN_PROGRESS',
      }),
    );

    finishPush?.(undefined);
    await expect(first).resolves.toMatchObject({ status: 200 });
  });

  it('rejects unsafe push branch names before resolving credentials or exporting', async () => {
    const { POST } = await import('@/app/api/projects/[id]/git/push/route');

    const response = await POST(
      makePostRequest('/api/projects/project-1/git/push', { branch: '../production' }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(400);
    expect(mockResolveGitCredentials).not.toHaveBeenCalled();
    expect(mockExportProjectV2).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('rejects unsafe pull branch names before resolving credentials or pulling files', async () => {
    const { POST } = await import('@/app/api/projects/[id]/git/pull/route');

    const response = await POST(
      makePostRequest('/api/projects/project-1/git/pull', { branch: '/production' }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(400);
    expect(mockResolveGitCredentials).not.toHaveBeenCalled();
    expect(mockPullProjectFiles).not.toHaveBeenCalled();
  });

  it('dry-run pull previews changes without executing apply or recording sync history', async () => {
    mockPreviewStudioLayeredImportV2.mockResolvedValueOnce({
      success: true,
      preview: {
        ...makeLayeredPreview(),
        agentChanges: {
          added: ['support_agent'],
          modified: [],
          removed: [],
          unchanged: [],
        },
      },
      warnings: [],
    });
    const { POST } = await import('@/app/api/projects/[id]/git/pull/route');

    const response = await POST(
      makePostRequest('/api/projects/project-1/git/pull', { dryRun: true }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        success: true,
        dryRun: true,
        changes: expect.objectContaining({ added: ['support_agent'] }),
      }),
    );
    expect(mockApplyStudioLayeredImportV2).not.toHaveBeenCalled();
    expect(mockGitSyncHistoryCreate).not.toHaveBeenCalled();
  });

  it('blocks pull apply when preview has blocking issues and records failure without partial writes', async () => {
    mockApplyStudioLayeredImportV2.mockResolvedValueOnce({
      success: false,
      stage: 'preview',
      error: { code: 'VALIDATION_FAILED', message: 'Import preview contains blocking issues' },
      preview: {
        ...makeLayeredPreview(),
        agentChanges: {
          added: [],
          modified: [{ name: 'support_agent', diff: { hunks: [] } }],
          removed: [],
          unchanged: [],
        },
        hasBlockingIssues: true,
        issues: [{ code: 'E_IMPORT_UNSUPPORTED_LAYERS', blocking: true }],
      },
      warnings: [],
    });
    const { POST } = await import('@/app/api/projects/[id]/git/pull/route');

    const response = await POST(makePostRequest('/api/projects/project-1/git/pull', {}), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(400);
    expect(mockGitSyncHistoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        tenantId: 'tenant-1',
        direction: 'pull',
        status: 'failed',
        changesSummary: expect.objectContaining({ modified: ['support_agent'] }),
      }),
    );
  });

  it('records failed pull history exactly once when apply execution fails', async () => {
    mockApplyStudioLayeredImportV2.mockResolvedValueOnce({
      success: false,
      stage: 'apply',
      error: { code: 'IMPORT_APPLY_FAILED', message: 'adapter write failed' },
      preview: makeLayeredPreview(),
      warnings: [],
    });
    const { POST } = await import('@/app/api/projects/[id]/git/pull/route');

    const response = await POST(makePostRequest('/api/projects/project-1/git/pull', {}), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(500);
    expect(mockGitSyncHistoryCreate).toHaveBeenCalledTimes(1);
    expect(mockGitSyncHistoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        tenantId: 'tenant-1',
        direction: 'pull',
        status: 'failed',
      }),
    );
  });

  it('records sanitized error text in failed pull history', async () => {
    mockApplyStudioLayeredImportV2.mockResolvedValueOnce({
      success: false,
      stage: 'apply',
      error: {
        code: 'IMPORT_APPLY_FAILED',
        message: 'tenant-1 project-1 secret-1 adapter write failed',
      },
      preview: makeLayeredPreview(),
      warnings: [],
    });
    const { POST } = await import('@/app/api/projects/[id]/git/pull/route');

    const response = await POST(makePostRequest('/api/projects/project-1/git/pull', {}), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(500);
    expect(mockGitSyncHistoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        error: expect.not.stringContaining('secret-1'),
      }),
    );
    expect(mockGitSyncHistoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.not.stringContaining('tenant-1'),
      }),
    );
  });

  it('passes createPR options through push and records a single successful history entry', async () => {
    const createPR = {
      title: 'Promote support updates',
      description: 'Open a reviewable PR',
      targetBranch: 'main',
    };
    const { POST } = await import('@/app/api/projects/[id]/git/push/route');

    const response = await POST(
      makePostRequest('/api/projects/project-1/git/push', {
        branch: 'feature/git-sync',
        createPR,
      }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(200);
    expect(mockPush).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'feature/git-sync',
        createPR,
      }),
    );
    expect(mockGitSyncHistoryCreate).toHaveBeenCalledTimes(1);
    expect(mockGitSyncHistoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        tenantId: 'tenant-1',
        direction: 'push',
        status: 'success',
        commitSha: 'push-commit-1',
      }),
    );
  });

  it('does not mark the default branch lastSyncCommit when push creates a pull request', async () => {
    const createPR = {
      title: 'Review support updates',
      description: 'Open a reviewable PR',
      targetBranch: 'main',
    };
    const { POST } = await import('@/app/api/projects/[id]/git/push/route');

    const response = await POST(
      makePostRequest('/api/projects/project-1/git/push', {
        branch: 'feature/git-sync',
        createPR,
      }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(200);
    expect(mockGitIntegrationFindOneAndUpdate).not.toHaveBeenCalledWith(
      { projectId: 'project-1', tenantId: 'tenant-1' },
      expect.objectContaining({
        lastSyncCommit: 'push-commit-1',
      }),
    );
    expect(mockGitSyncHistoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: 'push',
        status: 'success',
        branch: 'feature/git-sync',
        pullRequest: expect.objectContaining({
          targetBranch: 'main',
        }),
      }),
    );
  });

  it('keeps push successful when audit logging fails after remote git and local state are updated', async () => {
    mockLogAuditEvent.mockRejectedValueOnce(new Error('audit sink unavailable'));
    const { POST } = await import('@/app/api/projects/[id]/git/push/route');

    const response = await POST(makePostRequest('/api/projects/project-1/git/push', {}), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(200);
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockGitSyncHistoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success', commitSha: 'push-commit-1' }),
    );
    expect(mockGitIntegrationFindOneAndUpdate).toHaveBeenCalledWith(
      { projectId: 'project-1', tenantId: 'tenant-1' },
      expect.objectContaining({ lastSyncStatus: 'success', lastSyncCommit: 'push-commit-1' }),
    );
  });

  it('records sanitized error text in failed push history without leaking credential details', async () => {
    mockPush.mockResolvedValueOnce({
      success: false,
      commitSha: null,
      changes: { added: [], modified: [], deleted: [] },
      conflicts: [],
      error: {
        code: 'AUTH_FAILED',
        message: 'remote https://secret-token@github.com/acme/support rejected tenant-1',
      },
    });
    const { POST } = await import('@/app/api/projects/[id]/git/push/route');

    const response = await POST(makePostRequest('/api/projects/project-1/git/push', {}), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(500);
    expect(mockGitSyncHistoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        error: expect.not.stringContaining('secret-token'),
      }),
    );
    expect(mockGitSyncHistoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.not.stringContaining('tenant-1'),
      }),
    );
  });

  it('returns a conflict response for protected branch push failures', async () => {
    mockPush.mockResolvedValueOnce({
      success: false,
      commitSha: null,
      changes: { added: [], modified: ['project.json'], deleted: [] },
      conflicts: [],
      error: {
        code: 'BRANCH_PROTECTED',
        message: 'Protected branch requires pull request review',
      },
    });
    const { POST } = await import('@/app/api/projects/[id]/git/push/route');

    const response = await POST(makePostRequest('/api/projects/project-1/git/push', {}), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(409);
    expect(mockGitSyncHistoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: 'push',
        status: 'failed',
        error: expect.stringContaining('Protected branch'),
      }),
    );
  });

  it('omits credentials, profile ids, and tenant ids from successful push audit metadata', async () => {
    const { POST } = await import('@/app/api/projects/[id]/git/push/route');

    const response = await POST(makePostRequest('/api/projects/project-1/git/push', {}), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(200);
    expect(mockLogAuditEvent).toHaveBeenCalled();
    const serializedAudit = JSON.stringify(
      mockLogAuditEvent.mock.calls.map(([event]) => event?.metadata),
    );
    expect(serializedAudit).not.toContain('auth-profile-1');
    expect(serializedAudit).not.toContain('legacy-secret-1');
    expect(serializedAudit).not.toContain('tenant-1');
  });

  it('records conflict history exactly once when push detects merge conflicts', async () => {
    mockPush.mockResolvedValueOnce({
      success: false,
      commitSha: null,
      changes: { added: [], modified: ['agents/support.agent.abl'], deleted: [] },
      conflicts: [{ agentName: 'support_agent', file: 'agents/support.agent.abl' }],
    });
    const { POST } = await import('@/app/api/projects/[id]/git/push/route');

    const response = await POST(makePostRequest('/api/projects/project-1/git/push', {}), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(409);
    expect(mockGitSyncHistoryCreate).toHaveBeenCalledTimes(1);
    expect(mockGitSyncHistoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        tenantId: 'tenant-1',
        direction: 'push',
        status: 'conflict',
        conflictDetails: [
          expect.objectContaining({
            agentName: 'support_agent',
            file: 'agents/support.agent.abl',
            resolved: false,
          }),
        ],
      }),
    );
  });

  it('does not expose credential ids or tenant ids when promotion credential resolution fails', async () => {
    mockResolveGitCredentials.mockRejectedValueOnce(
      new Error('auth-profile-1 / legacy-secret-1 rejected for tenant-1'),
    );
    const { POST } = await import('@/app/api/projects/[id]/git/promote/route');

    const response = await POST(
      makePostRequest('/api/projects/project-1/git/promote', { from: 'main', to: 'staging' }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBeLessThan(500);
    const payload = await response.json();
    expect(JSON.stringify(payload)).not.toContain('auth-profile-1');
    expect(JSON.stringify(payload)).not.toContain('legacy-secret-1');
    expect(JSON.stringify(payload)).not.toContain('tenant-1');
    expect(mockCreateEnvironmentBranch).not.toHaveBeenCalled();
    expect(mockPromoteBranch).not.toHaveBeenCalled();
  });

  it('keeps pull successful and returns a warning when runtime cache invalidation fails after apply', async () => {
    mockApplyStudioLayeredImportV2.mockResolvedValueOnce({
      success: true,
      preview: makeLayeredPreview(),
      warnings: [],
      applied: { modelPoliciesUpserted: 1, modelPoliciesDeleted: 0 },
    });
    mockNotifyRuntimeModelConfigChanged.mockRejectedValueOnce(new Error('runtime unavailable'));
    const { POST } = await import('@/app/api/projects/[id]/git/pull/route');

    const response = await POST(makePostRequest('/api/projects/project-1/git/pull', {}), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        success: true,
        warnings: expect.arrayContaining([
          expect.stringContaining('runtime model cache invalidation'),
        ]),
      }),
    );
    expect(mockGitSyncHistoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success', commitSha: 'pull-commit-1' }),
    );
  });

  it('rejects invalid promotion branch combinations before resolving credentials', async () => {
    const { POST } = await import('@/app/api/projects/[id]/git/promote/route');

    const response = await POST(
      makePostRequest('/api/projects/project-1/git/promote', {
        from: 'staging',
        to: 'qa',
      }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(400);
    expect(mockResolveGitCredentials).not.toHaveBeenCalled();
    expect(mockCreateEnvironmentBranch).not.toHaveBeenCalled();
  });

  it.each([
    ['main', 'staging'],
    ['staging', 'production'],
  ])('allows ordered promotion from %s to %s', async (from, to) => {
    const { POST } = await import('@/app/api/projects/[id]/git/promote/route');

    const response = await POST(
      makePostRequest('/api/projects/project-1/git/promote', {
        from,
        to,
      }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(200);
    expect(mockPromoteBranch).toHaveBeenCalledWith(from, to);
  });

  it.each([
    ['main', 'production'],
    ['production', 'staging'],
  ])('rejects unordered promotion from %s to %s before resolving credentials', async (from, to) => {
    const { POST } = await import('@/app/api/projects/[id]/git/promote/route');

    const response = await POST(
      makePostRequest('/api/projects/project-1/git/promote', {
        from,
        to,
      }),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(400);
    expect(mockResolveGitCredentials).not.toHaveBeenCalled();
    expect(mockPromoteBranch).not.toHaveBeenCalled();
  });

  it('does not update lastSyncCommit when pull apply fails', async () => {
    mockApplyStudioLayeredImportV2.mockResolvedValueOnce({
      success: false,
      stage: 'apply',
      error: { code: 'IMPORT_APPLY_FAILED', message: 'apply failed after preview' },
      preview: makeLayeredPreview(),
      warnings: [],
    });
    const { POST } = await import('@/app/api/projects/[id]/git/pull/route');

    const response = await POST(makePostRequest('/api/projects/project-1/git/pull', {}), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(500);
    expect(mockGitIntegrationFindOneAndUpdate).toHaveBeenCalledWith(
      { projectId: 'project-1', tenantId: 'tenant-1' },
      expect.objectContaining({
        lastSyncStatus: 'failed',
        lastSyncError: 'apply failed after preview',
      }),
    );
    expect(mockGitIntegrationFindOneAndUpdate).not.toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ lastSyncCommit: 'pull-commit-1' }),
    );
  });
});

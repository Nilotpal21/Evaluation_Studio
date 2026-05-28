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

vi.mock('@/lib/studio-audit-trail-handler', () => ({
  ensureStudioAuditTrailHandlerRegistered: vi.fn(),
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

vi.mock('@/lib/permissions', () => ({
  StudioPermission: {
    PROJECT_GIT: 'project:git',
  },
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

vi.mock('@agent-platform/shared/rbac', () => ({
  hasSensitivePermission: vi.fn(() => false),
  isSensitiveExactPermission: vi.fn(() => false),
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
const mockLogAuditEvent = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  GitIntegration: {
    findOne: (...args: unknown[]) => mockGitIntegrationFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mockGitIntegrationFindOneAndUpdate(...args),
  },
  GitSyncHistory: {
    create: (...args: unknown[]) => mockGitSyncHistoryCreate(...args),
  },
}));

vi.mock('@/services/audit-service', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
  AuditActions: {
    GIT_PULL_COMPLETED: 'git_pull_completed',
  },
}));

const mockCreateGitProvider = vi.fn();
const mockGitSyncServicePullProjectFiles = vi.fn();

class MockGitCircuitBreakerError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super('Git provider temporarily unavailable');
  }
}

class MockGitSyncService {
  pullProjectFiles(...args: unknown[]) {
    return mockGitSyncServicePullProjectFiles(...args);
  }
}

vi.mock('@agent-platform/project-io/git', () => ({
  createGitProvider: (...args: unknown[]) => mockCreateGitProvider(...args),
  GitSyncService: MockGitSyncService,
  GitCircuitBreakerError: MockGitCircuitBreakerError,
}));

const mockPreviewStudioLayeredImportV2 = vi.fn();
const mockApplyStudioLayeredImportV2 = vi.fn();
const mockNotifyRuntimeModelConfigChanged = vi.fn();

vi.mock('@/lib/project-import/layered-import-support', () => ({
  previewStudioLayeredImportV2: (...args: unknown[]) => mockPreviewStudioLayeredImportV2(...args),
  applyStudioLayeredImportV2: (...args: unknown[]) => mockApplyStudioLayeredImportV2(...args),
}));

vi.mock('@/lib/runtime-model-cache-invalidation', () => ({
  notifyRuntimeModelConfigChanged: (...args: unknown[]) =>
    mockNotifyRuntimeModelConfigChanged(...args),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

function makeRequest(body: Record<string, unknown>, headers?: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost/api/projects/project-1/git/pull', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function makeLayeredPreview() {
  return {
    valid: true,
    formatVersion: '2.0',
    layers: ['core', 'connections'],
    layerChanges: {
      core: { added: 3, modified: 1, removed: 0, unchanged: 0 },
      connections: { added: 2, modified: 0, removed: 0, unchanged: 0 },
    },
    agentChanges: {
      added: ['support_agent'],
      modified: [],
      removed: [],
      unchanged: [],
    },
    toolChanges: { added: ['search_docs'], modified: [], removed: [] },
    localeChanges: { added: [], modified: [], removed: [] },
    profileChanges: {
      added: ['voice_vip'],
      modified: [],
      removed: [],
    },
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
    previewDigest: 'preview-digest-1',
    entryAgentResolution: {
      requested: null,
      resolved: 'support_agent',
      matchedBy: 'exact',
    },
    warnings: [],
  };
}

function makeLayeredApplyResult() {
  return {
    success: true,
    preview: makeLayeredPreview(),
    warnings: [],
    applied: {
      created: 1,
      updated: 0,
      deleted: 0,
      toolsCreated: 1,
      toolsUpdated: 0,
      toolsDeleted: 0,
      localesCreated: 0,
      localesUpdated: 0,
      localesDeleted: 0,
      profilesCreated: 1,
      profilesUpdated: 0,
      profilesDeleted: 0,
      modelPoliciesUpserted: 1,
      modelPoliciesDeleted: 0,
    },
  };
}

describe('POST /api/projects/[id]/git/pull', () => {
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
    mockResolveStudioProjectPermissionAliases.mockReturnValue(['project:git']);
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

    mockResolveGitCredentials.mockResolvedValue({ token: 'secret' });
    mockCreateGitProvider.mockReturnValue({ kind: 'github' });
    mockGitSyncServicePullProjectFiles.mockResolvedValue({
      commitSha: 'def456',
      branch: 'main',
      files: new Map([
        ['project.json', '{"format_version":"2.0"}'],
        ['agents/support_agent.agent.yaml', 'agent: support_agent'],
      ]),
    });

    const applyResult = makeLayeredApplyResult();
    mockPreviewStudioLayeredImportV2.mockResolvedValue({
      success: true,
      preview: makeLayeredPreview(),
      warnings: [],
    });
    mockApplyStudioLayeredImportV2.mockResolvedValue(applyResult);

    mockGitIntegrationFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        projectId: 'project-1',
        tenantId: 'tenant-1',
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-ops',
        authProfileId: 'auth-profile-1',
        defaultBranch: 'main',
        syncPath: 'studio/project-a',
        lastSyncCommit: 'abc123',
      }),
    });
    mockGitSyncHistoryCreate.mockResolvedValue({});
    mockGitIntegrationFindOneAndUpdate.mockResolvedValue({});
  });

  it('passes pulled git files into the layered preview path for dry runs', async () => {
    const { POST } = await import('@/app/api/projects/[id]/git/pull/route');

    const response = await POST(makeRequest({ dryRun: true }), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(200);
    expect(mockGitSyncServicePullProjectFiles).toHaveBeenCalledWith('main', 'studio/project-a');
    expect(mockResolveGitCredentials).toHaveBeenCalledWith('auth-profile-1', 'tenant-1', {
      projectId: 'project-1',
      userId: 'user-1',
    });
    expect(mockPreviewStudioLayeredImportV2).toHaveBeenCalledWith(
      expect.objectContaining({
        files: new Map([
          ['project.json', '{"format_version":"2.0"}'],
          ['agents/support_agent.agent.yaml', 'agent: support_agent'],
        ]),
        projectId: 'project-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        conflictStrategy: 'replace',
      }),
    );
    expect(mockApplyStudioLayeredImportV2).not.toHaveBeenCalled();

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      dryRun: true,
      previewDigest: 'preview-digest-1',
      changes: {
        added: expect.arrayContaining([
          'support_agent',
          'search_docs',
          'voice_vip',
          'connections:added(2)',
        ]),
        modified: [],
        deleted: [],
      },
    });
  });

  it('applies the layered import path before marking git pull success', async () => {
    const { POST } = await import('@/app/api/projects/[id]/git/pull/route');

    const response = await POST(
      makeRequest(
        {
          dryRun: false,
          previewDigest: 'preview-digest-1',
          acknowledgedIssueIds: ['warning-1'],
        },
        { Authorization: 'Bearer studio-token' },
      ),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(200);
    expect(mockApplyStudioLayeredImportV2).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        conflictStrategy: 'replace',
        previewDigest: 'preview-digest-1',
        acknowledgedIssueIds: ['warning-1'],
      }),
    );
    expect(mockGitSyncHistoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success',
        commitSha: 'def456',
        changesSummary: {
          added: expect.arrayContaining([
            'support_agent',
            'search_docs',
            'voice_vip',
            'connections:added(2)',
          ]),
          modified: [],
          deleted: [],
        },
        agentsAffected: ['support_agent'],
      }),
    );
    expect(mockGitIntegrationFindOneAndUpdate).toHaveBeenCalledWith(
      { projectId: 'project-1', tenantId: 'tenant-1' },
      expect.objectContaining({
        lastSyncStatus: 'success',
        lastSyncCommit: 'def456',
      }),
    );
    expect(mockNotifyRuntimeModelConfigChanged).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      authorization: 'Bearer studio-token',
    });
  });

  it('records a failed pull and does not advance lastSyncCommit when layered apply fails', async () => {
    mockApplyStudioLayeredImportV2.mockResolvedValueOnce({
      success: false,
      stage: 'apply',
      error: { code: 'INVALID_IMPORT', message: 'Invalid import bundle' },
      preview: makeLayeredPreview(),
      warnings: [],
    });

    const { POST } = await import('@/app/api/projects/[id]/git/pull/route');
    const response = await POST(makeRequest({ dryRun: false }), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(500);
    expect(mockGitIntegrationFindOneAndUpdate).toHaveBeenCalledWith(
      { projectId: 'project-1', tenantId: 'tenant-1' },
      expect.objectContaining({
        lastSyncStatus: 'failed',
        lastSyncError: 'Invalid import bundle',
      }),
    );
    const lastUpdateCall =
      mockGitIntegrationFindOneAndUpdate.mock.calls[
        mockGitIntegrationFindOneAndUpdate.mock.calls.length - 1
      ]?.[1];
    expect(lastUpdateCall).not.toHaveProperty('lastSyncCommit');
  });
});

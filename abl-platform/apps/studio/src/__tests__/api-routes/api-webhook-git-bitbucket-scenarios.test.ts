/**
 * Bitbucket webhook scenario regression for Git integration.
 *
 * The parser deliberately marks Bitbucket push payloads as relevant because the
 * provider does not reliably include changed file lists. This route-level test
 * keeps the parser/route contract executable instead of mocking relevance into
 * whatever shape the route currently expects.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockProjectFindOne = vi.fn();
const mockGitIntegrationFindOne = vi.fn();
const mockProjectAgentFind = vi.fn();
const mockGitSyncHistoryCreate = vi.fn();
const mockGitIntegrationFindOneAndUpdate = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  Project: {
    findOne: (...args: unknown[]) => mockProjectFindOne(...args),
  },
  GitIntegration: {
    findOne: (...args: unknown[]) => mockGitIntegrationFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mockGitIntegrationFindOneAndUpdate(...args),
  },
  ProjectAgent: {
    find: (...args: unknown[]) => mockProjectAgentFind(...args),
  },
  GitSyncHistory: {
    create: (...args: unknown[]) => mockGitSyncHistoryCreate(...args),
  },
}));

const mockVerifyWebhookSignature = vi.fn();
const mockPullProjectFiles = vi.fn();
const mockResolveGitCredentials = vi.fn();
const mockApplyStudioLayeredImportV2 = vi.fn();
const mockReleaseGitOperationLock = vi.fn().mockResolvedValue(undefined);
const mockAcquireGitOperationLock = vi.fn().mockResolvedValue({
  acquired: true,
  release: mockReleaseGitOperationLock,
});
const mockNotifyRuntimeModelConfigChanged = vi.fn();

vi.mock('@agent-platform/project-io/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/project-io/git')>();
  return {
    ...actual,
    verifyWebhookSignature: (...args: unknown[]) => mockVerifyWebhookSignature(...args),
    createGitProvider: vi.fn(() => ({ provider: 'bitbucket' })),
    GitSyncService: vi.fn(function GitSyncService() {
      return {
        pullProjectFiles: (...args: unknown[]) => mockPullProjectFiles(...args),
      };
    }),
  };
});

vi.mock('@/lib/git-credentials', () => ({
  resolveGitCredentials: (...args: unknown[]) => mockResolveGitCredentials(...args),
}));

vi.mock('@/lib/project-import/layered-import-support', () => ({
  applyStudioLayeredImportV2: (...args: unknown[]) => mockApplyStudioLayeredImportV2(...args),
}));

vi.mock('@/lib/git-operation-lock', () => ({
  acquireGitOperationLock: (...args: unknown[]) => mockAcquireGitOperationLock(...args),
  gitOperationLockedResponse: () =>
    new Response(JSON.stringify({ error: 'locked' }), { status: 423 }),
}));

vi.mock('@/lib/runtime-model-cache-invalidation', () => ({
  notifyRuntimeModelConfigChanged: (...args: unknown[]) =>
    mockNotifyRuntimeModelConfigChanged(...args),
}));

const mockLogAuditEvent = vi.fn();

vi.mock('@/services/audit-service', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
  AuditActions: {
    GIT_WEBHOOK_ACCEPTED: 'git_webhook_accepted',
  },
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

function bitbucketRequest() {
  return new NextRequest('http://localhost/api/webhooks/git/project-1', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature': 'sha256=test',
    },
    body: JSON.stringify({
      push: {
        changes: [
          {
            new: {
              name: 'develop',
              target: {
                hash: 'commit-bitbucket-1',
                author: { raw: 'Bitbucket User <user@example.com>' },
              },
            },
          },
        ],
      },
    }),
  });
}

function bitbucketBranchDeleteRequest() {
  return new NextRequest('http://localhost/api/webhooks/git/project-1', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature': 'sha256=test',
    },
    body: JSON.stringify({
      push: {
        changes: [
          {
            old: {
              name: 'develop',
              target: { hash: 'old-bitbucket-commit' },
            },
          },
        ],
      },
    }),
  });
}

function bitbucketMultipleChangesRequest() {
  return new NextRequest('http://localhost/api/webhooks/git/project-1', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature': 'sha256=test',
    },
    body: JSON.stringify({
      push: {
        changes: [
          {
            new: {
              name: 'feature/not-synced',
              target: {
                hash: 'commit-bitbucket-feature',
                author: { raw: 'Bitbucket User <user@example.com>' },
              },
            },
          },
          {
            new: {
              name: 'develop',
              target: {
                hash: 'commit-bitbucket-develop',
                author: { raw: 'Bitbucket User <user@example.com>' },
              },
            },
          },
        ],
      },
    }),
  });
}

function githubRequestWithoutSignature(): NextRequest {
  return new NextRequest('http://localhost/api/webhooks/git/project-1', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      ref: 'refs/heads/main',
      head_commit: {
        id: 'commit-github-1',
        committer: { name: 'GitHub User', email: 'user@example.com' },
      },
      commits: [
        {
          added: ['agents/support.agent.abl'],
          modified: [],
          removed: [],
        },
      ],
    }),
  });
}

function githubRequest(input?: {
  branch?: string;
  changedFiles?: string[];
  signature?: string;
  refPrefix?: string;
  headCommit?: { id?: string | null } | null;
}): NextRequest {
  const changedFiles = input?.changedFiles ?? ['agents/support.agent.abl'];
  return new NextRequest('http://localhost/api/webhooks/git/project-1', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': input?.signature ?? 'sha256=test',
    },
    body: JSON.stringify({
      ref: `${input?.refPrefix ?? 'refs/heads/'}${input?.branch ?? 'main'}`,
      head_commit:
        input && 'headCommit' in input
          ? input.headCommit
          : {
              id: 'commit-github-1',
              committer: { name: 'GitHub User', email: 'user@example.com' },
            },
      commits: [
        {
          added: changedFiles,
          modified: [],
          removed: [],
        },
      ],
    }),
  });
}

function makeLayeredPreview() {
  return {
    valid: true,
    formatVersion: '2.0',
    layers: ['core'],
    layerChanges: {},
    agentChanges: { added: [], modified: [], removed: [], unchanged: [] },
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

describe('Bitbucket webhook lifecycle scenario', () => {
  let POST: (
    request: NextRequest,
    context: { params: Promise<{ projectId: string }> },
  ) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    mockProjectFindOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'project-1', tenantId: 'tenant-1' }),
      }),
    });
    mockGitIntegrationFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'git-integration-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        provider: 'bitbucket',
        repositoryUrl: 'https://bitbucket.org/acme/support-agents',
        defaultBranch: 'develop',
        syncPath: '/',
        webhookSecret: 'webhook-secret',
        credentials: { type: 'token', secretId: 'secret-1' },
        authProfileId: 'auth-profile-1',
        syncConfig: { autoSync: true },
      }),
    });
    mockProjectAgentFind.mockReturnValue({
      lean: vi.fn().mockResolvedValue([]),
    });
    mockVerifyWebhookSignature.mockReturnValue(true);
    mockResolveGitCredentials.mockResolvedValue({ type: 'token', token: 'secret' });
    mockReleaseGitOperationLock.mockResolvedValue(undefined);
    mockAcquireGitOperationLock.mockResolvedValue({
      acquired: true,
      release: mockReleaseGitOperationLock,
    });
    mockPullProjectFiles.mockResolvedValue({
      branch: 'develop',
      commitSha: 'commit-bitbucket-1',
      files: new Map([
        ['project.json', JSON.stringify({ format_version: '2.0', layers_included: ['core'] })],
      ]),
    });
    mockApplyStudioLayeredImportV2.mockResolvedValue({
      success: true,
      preview: makeLayeredPreview(),
      warnings: [],
      applied: {},
    });
    mockGitSyncHistoryCreate.mockResolvedValue({});
    mockGitIntegrationFindOneAndUpdate.mockResolvedValue({});
    mockLogAuditEvent.mockResolvedValue(undefined);

    const mod = await import('@/app/api/webhooks/git/[projectId]/route');
    POST = mod.POST;
  });

  it('processes Bitbucket pushes even when the provider omits changed file paths', async () => {
    const response = await POST(bitbucketRequest(), {
      params: Promise.resolve({ projectId: 'project-1' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        processed: true,
        commitSha: 'commit-bitbucket-1',
      }),
    );
    expect(mockPullProjectFiles).toHaveBeenCalledTimes(1);
  });

  it('passes authProfileId through credential resolution for relevant GitHub webhooks', async () => {
    mockGitIntegrationFindOne.mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue({
        _id: 'git-integration-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        defaultBranch: 'main',
        syncPath: '/',
        webhookSecret: 'webhook-secret',
        credentials: { type: 'token', secretId: 'secret-1' },
        authProfileId: 'auth-profile-1',
        syncConfig: { autoSync: true },
      }),
    });

    const response = await POST(githubRequest(), {
      params: Promise.resolve({ projectId: 'project-1' }),
    });

    expect(response.status).toBe(200);
    expect(mockResolveGitCredentials).toHaveBeenCalledWith('auth-profile-1', 'tenant-1', {
      projectId: 'project-1',
    });
    expect(mockGitSyncHistoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        status: 'success',
        triggeredBy: 'git-webhook',
      }),
    );
  });

  it('skips irrelevant GitHub file changes without pulling from git', async () => {
    mockGitIntegrationFindOne.mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue({
        _id: 'git-integration-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        defaultBranch: 'main',
        syncPath: '/',
        webhookSecret: 'webhook-secret',
        credentials: { type: 'token', secretId: 'secret-1' },
        authProfileId: null,
        syncConfig: { autoSync: true },
      }),
    });

    const response = await POST(githubRequest({ changedFiles: ['README.md'] }), {
      params: Promise.resolve({ projectId: 'project-1' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ processed: false, message: 'No relevant changes' }),
    );
    expect(mockPullProjectFiles).not.toHaveBeenCalled();
  });

  it('skips relevant webhooks from non-sync branches without pulling from git', async () => {
    mockGitIntegrationFindOne.mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue({
        _id: 'git-integration-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        defaultBranch: 'main',
        syncPath: '/',
        webhookSecret: 'webhook-secret',
        credentials: { type: 'token', secretId: 'secret-1' },
        authProfileId: null,
        syncConfig: { autoSync: true },
      }),
    });

    const response = await POST(githubRequest({ branch: 'feature/test' }), {
      params: Promise.resolve({ projectId: 'project-1' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        processed: false,
        message: expect.stringContaining('does not match sync branch'),
      }),
    );
    expect(mockPullProjectFiles).not.toHaveBeenCalled();
  });

  it('rejects invalid webhook signatures before parsing or pulling', async () => {
    mockVerifyWebhookSignature.mockReturnValueOnce(false);

    const response = await POST(githubRequest({ signature: 'sha256=bad' }), {
      params: Promise.resolve({ projectId: 'project-1' }),
    });

    expect(response.status).toBe(401);
    expect(mockPullProjectFiles).not.toHaveBeenCalled();
  });

  it('rejects missing webhook signatures before pulling from git', async () => {
    mockVerifyWebhookSignature.mockImplementationOnce(
      (_provider: unknown, _rawBody: unknown, signature: unknown) => signature !== '',
    );

    const response = await POST(githubRequestWithoutSignature(), {
      params: Promise.resolve({ projectId: 'project-1' }),
    });

    expect(response.status).toBe(401);
    expect(mockPullProjectFiles).not.toHaveBeenCalled();
    expect(mockGitSyncHistoryCreate).not.toHaveBeenCalled();
  });

  it('does not pull relevant GitHub changes when auto-sync is disabled', async () => {
    mockGitIntegrationFindOne.mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue({
        _id: 'git-integration-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        defaultBranch: 'main',
        syncPath: '/',
        webhookSecret: 'webhook-secret',
        credentials: { type: 'token', secretId: 'secret-1' },
        authProfileId: null,
        syncConfig: { autoSync: false },
      }),
    });

    const response = await POST(githubRequest(), {
      params: Promise.resolve({ projectId: 'project-1' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        processed: false,
        message: expect.stringContaining('Auto-sync is disabled'),
      }),
    );
    expect(mockPullProjectFiles).not.toHaveBeenCalled();
    expect(mockGitSyncHistoryCreate).not.toHaveBeenCalled();
  });

  it('treats Bitbucket branch delete payloads as non-sync-branch events before pulling', async () => {
    const response = await POST(bitbucketBranchDeleteRequest(), {
      params: Promise.resolve({ projectId: 'project-1' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        processed: false,
        message: expect.stringContaining('does not match sync branch'),
      }),
    );
    expect(mockPullProjectFiles).not.toHaveBeenCalled();
  });

  it('processes the Bitbucket change that matches the sync branch when multiple branches are present', async () => {
    mockPullProjectFiles.mockResolvedValueOnce({
      branch: 'develop',
      commitSha: 'commit-bitbucket-develop',
      files: new Map([
        ['project.json', JSON.stringify({ format_version: '2.0', layers_included: ['core'] })],
      ]),
    });

    const response = await POST(bitbucketMultipleChangesRequest(), {
      params: Promise.resolve({ projectId: 'project-1' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        processed: true,
        commitSha: 'commit-bitbucket-develop',
      }),
    );
    expect(mockPullProjectFiles).toHaveBeenCalledWith('develop', '/');
  });

  it('treats GitHub tag push events as ignored webhook events without pulling', async () => {
    mockGitIntegrationFindOne.mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue({
        _id: 'git-integration-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        defaultBranch: 'main',
        syncPath: '/',
        webhookSecret: 'webhook-secret',
        credentials: { type: 'token', secretId: 'secret-1' },
        authProfileId: null,
        syncConfig: { autoSync: true },
      }),
    });

    const response = await POST(githubRequest({ refPrefix: 'refs/tags/', branch: 'v1.0.0' }), {
      params: Promise.resolve({ projectId: 'project-1' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        processed: false,
        message: expect.stringContaining('ignored'),
      }),
    );
    expect(mockPullProjectFiles).not.toHaveBeenCalled();
    expect(mockGitSyncHistoryCreate).not.toHaveBeenCalled();
  });

  it('treats GitHub branch delete events as ignored webhook events without returning parse errors', async () => {
    mockGitIntegrationFindOne.mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue({
        _id: 'git-integration-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        defaultBranch: 'main',
        syncPath: '/',
        webhookSecret: 'webhook-secret',
        credentials: { type: 'token', secretId: 'secret-1' },
        authProfileId: null,
        syncConfig: { autoSync: true },
      }),
    });

    const response = await POST(githubRequest({ headCommit: null }), {
      params: Promise.resolve({ projectId: 'project-1' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        processed: false,
        message: expect.stringContaining('ignored'),
      }),
    );
    expect(mockPullProjectFiles).not.toHaveBeenCalled();
  });

  it('records failed webhook history exactly once when auto-sync apply fails', async () => {
    mockGitIntegrationFindOne.mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue({
        _id: 'git-integration-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        defaultBranch: 'main',
        syncPath: '/',
        webhookSecret: 'webhook-secret',
        credentials: { type: 'token', secretId: 'secret-1' },
        authProfileId: null,
        syncConfig: { autoSync: true },
      }),
    });
    mockPullProjectFiles.mockResolvedValueOnce({
      branch: 'main',
      commitSha: 'commit-github-apply-fail',
      files: new Map([
        ['project.json', JSON.stringify({ format_version: '2.0', layers_included: ['core'] })],
      ]),
    });
    mockApplyStudioLayeredImportV2.mockResolvedValueOnce({
      success: false,
      stage: 'apply',
      error: { code: 'IMPORT_APPLY_FAILED', message: 'apply failed' },
      preview: makeLayeredPreview(),
      warnings: [],
    });

    const response = await POST(githubRequest(), {
      params: Promise.resolve({ projectId: 'project-1' }),
    });

    expect(response.status).toBe(500);
    expect(mockGitSyncHistoryCreate).toHaveBeenCalledTimes(1);
    expect(mockGitSyncHistoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        tenantId: 'tenant-1',
        direction: 'pull',
        status: 'failed',
        triggeredBy: 'git-webhook',
      }),
    );
  });

  it('sanitizes unauthenticated webhook import preparation errors', async () => {
    mockGitIntegrationFindOne.mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue({
        _id: 'git-integration-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        defaultBranch: 'main',
        syncPath: '/',
        webhookSecret: 'webhook-secret',
        credentials: { type: 'token', secretId: 'secret-1' },
        authProfileId: null,
        syncConfig: { autoSync: true },
      }),
    });
    mockApplyStudioLayeredImportV2.mockResolvedValueOnce({
      success: false,
      stage: 'prepare',
      error: {
        code: 'VALIDATION_FAILED',
        message: 'tenant-1 project-1 internal model config credential secret-1 failed validation',
      },
      preview: { ...makeLayeredPreview(), hasBlockingIssues: true },
      warnings: [],
    });

    const response = await POST(githubRequest(), {
      params: Promise.resolve({ projectId: 'project-1' }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(JSON.stringify(payload)).not.toContain('tenant-1');
    expect(JSON.stringify(payload)).not.toContain('project-1');
    expect(JSON.stringify(payload)).not.toContain('secret-1');
    expect(mockGitSyncHistoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        error: expect.not.stringContaining('secret-1'),
      }),
    );
  });

  it('does not apply duplicate webhook deliveries for the same commit twice', async () => {
    mockGitIntegrationFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'git-integration-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        defaultBranch: 'main',
        syncPath: '/',
        webhookSecret: 'webhook-secret',
        credentials: { type: 'token', secretId: 'secret-1' },
        authProfileId: null,
        lastSyncCommit: 'previous-commit',
        syncConfig: { autoSync: true },
      }),
    });

    const first = await POST(githubRequest(), {
      params: Promise.resolve({ projectId: 'project-1' }),
    });
    const second = await POST(githubRequest(), {
      params: Promise.resolve({ projectId: 'project-1' }),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mockPullProjectFiles).toHaveBeenCalledTimes(1);
    expect(mockApplyStudioLayeredImportV2).toHaveBeenCalledTimes(1);
    expect(mockGitSyncHistoryCreate).toHaveBeenCalledTimes(1);
  });

  it('keeps duplicate delivery reservation after apply succeeds even when status persistence fails', async () => {
    mockGitIntegrationFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'git-integration-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        defaultBranch: 'main',
        syncPath: '/',
        webhookSecret: 'webhook-secret',
        credentials: { type: 'token', secretId: 'secret-1' },
        authProfileId: null,
        lastSyncCommit: 'previous-commit',
        syncConfig: { autoSync: true },
      }),
    });
    mockGitSyncHistoryCreate.mockRejectedValueOnce(new Error('mongo unavailable'));

    const first = await POST(githubRequest(), {
      params: Promise.resolve({ projectId: 'project-1' }),
    });
    const firstBody = await first.json();
    const second = await POST(githubRequest(), {
      params: Promise.resolve({ projectId: 'project-1' }),
    });

    expect(first.status).toBe(200);
    expect(firstBody).toEqual(
      expect.objectContaining({
        processed: true,
        warnings: expect.arrayContaining([
          'Webhook auto-sync applied, but sync status persistence failed',
        ]),
      }),
    );
    expect(second.status).toBe(200);
    expect(mockPullProjectFiles).toHaveBeenCalledTimes(1);
    expect(mockApplyStudioLayeredImportV2).toHaveBeenCalledTimes(1);
    expect(mockGitSyncHistoryCreate).toHaveBeenCalledTimes(1);
  });

  it('keeps duplicate delivery reservation after apply succeeds even when runtime cache invalidation fails', async () => {
    mockGitIntegrationFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'git-integration-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        defaultBranch: 'main',
        syncPath: '/',
        webhookSecret: 'webhook-secret',
        credentials: { type: 'token', secretId: 'secret-1' },
        authProfileId: null,
        lastSyncCommit: 'previous-commit',
        syncConfig: { autoSync: true },
      }),
    });
    mockApplyStudioLayeredImportV2.mockResolvedValueOnce({
      success: true,
      preview: makeLayeredPreview(),
      warnings: [],
      applied: { modelPoliciesUpserted: 1 },
    });
    mockNotifyRuntimeModelConfigChanged.mockRejectedValueOnce(new Error('runtime unavailable'));

    const first = await POST(githubRequest(), {
      params: Promise.resolve({ projectId: 'project-1' }),
    });
    const firstBody = await first.json();
    const second = await POST(githubRequest(), {
      params: Promise.resolve({ projectId: 'project-1' }),
    });

    expect(first.status).toBe(200);
    expect(firstBody).toEqual(
      expect.objectContaining({
        processed: true,
        warnings: expect.arrayContaining([
          'Webhook auto-sync applied, but runtime model cache invalidation failed',
        ]),
      }),
    );
    expect(second.status).toBe(200);
    expect(mockPullProjectFiles).toHaveBeenCalledTimes(1);
    expect(mockApplyStudioLayeredImportV2).toHaveBeenCalledTimes(1);
    expect(mockNotifyRuntimeModelConfigChanged).toHaveBeenCalledTimes(1);
  });

  it('ignores webhook commits already recorded as the integration lastSyncCommit', async () => {
    mockGitIntegrationFindOne.mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue({
        _id: 'git-integration-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        defaultBranch: 'main',
        syncPath: '/',
        webhookSecret: 'webhook-secret',
        credentials: { type: 'token', secretId: 'secret-1' },
        authProfileId: null,
        lastSyncCommit: 'commit-github-1',
        syncConfig: { autoSync: true },
      }),
    });

    const response = await POST(githubRequest(), {
      params: Promise.resolve({ projectId: 'project-1' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        processed: false,
        message: expect.stringContaining('already synced'),
      }),
    );
    expect(mockPullProjectFiles).not.toHaveBeenCalled();
    expect(mockGitSyncHistoryCreate).not.toHaveBeenCalled();
  });

  it('accepts previous webhook secrets during the configured rotation grace window', async () => {
    mockGitIntegrationFindOne.mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue({
        _id: 'git-integration-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        defaultBranch: 'main',
        syncPath: '/',
        webhookSecret: 'new-webhook-secret',
        previousWebhookSecret: 'old-webhook-secret',
        previousWebhookSecretExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        credentials: { type: 'token', secretId: 'secret-1' },
        authProfileId: null,
        syncConfig: { autoSync: true },
      }),
    });
    mockVerifyWebhookSignature.mockImplementation(
      (_provider: unknown, _rawBody: unknown, _signature: unknown, secret: unknown) =>
        secret === 'old-webhook-secret',
    );

    const response = await POST(githubRequest({ signature: 'sha256=old-secret-signature' }), {
      params: Promise.resolve({ projectId: 'project-1' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        processed: true,
      }),
    );
    expect(mockVerifyWebhookSignature).toHaveBeenCalledWith(
      'github',
      expect.any(String),
      'sha256=old-secret-signature',
      'old-webhook-secret',
    );
  });

  it('records sanitized failed history when webhook credential resolution fails', async () => {
    mockGitIntegrationFindOne.mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue({
        _id: 'git-integration-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        defaultBranch: 'main',
        syncPath: '/',
        webhookSecret: 'webhook-secret',
        credentials: { type: 'token', secretId: 'secret-1' },
        authProfileId: 'auth-profile-1',
        syncConfig: { autoSync: true },
      }),
    });
    mockResolveGitCredentials.mockRejectedValueOnce(
      new Error('auth-profile-1 secret-1 tenant-1 refresh token expired'),
    );

    const response = await POST(githubRequest(), {
      params: Promise.resolve({ projectId: 'project-1' }),
    });

    expect(response.status).toBeLessThan(500);
    const payload = await response.json();
    expect(JSON.stringify(payload)).not.toContain('auth-profile-1');
    expect(JSON.stringify(payload)).not.toContain('secret-1');
    expect(JSON.stringify(payload)).not.toContain('tenant-1');
    expect(mockGitSyncHistoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        tenantId: 'tenant-1',
        direction: 'pull',
        status: 'failed',
        triggeredBy: 'git-webhook',
      }),
    );
    expect(mockPullProjectFiles).not.toHaveBeenCalled();
  });

  it('rejects webhooks when no webhook secret is configured before signature verification', async () => {
    mockGitIntegrationFindOne.mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue({
        _id: 'git-integration-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support-agents',
        defaultBranch: 'main',
        syncPath: '/',
        webhookSecret: null,
        credentials: { type: 'token', secretId: 'secret-1' },
        authProfileId: null,
        syncConfig: { autoSync: true },
      }),
    });

    const response = await POST(githubRequest(), {
      params: Promise.resolve({ projectId: 'project-1' }),
    });

    expect(response.status).toBe(400);
    expect(mockVerifyWebhookSignature).not.toHaveBeenCalled();
    expect(mockPullProjectFiles).not.toHaveBeenCalled();
  });

  it('rejects unsupported providers before resolving credentials', async () => {
    mockGitIntegrationFindOne.mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue({
        _id: 'git-integration-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        provider: 'gitea',
        repositoryUrl: 'https://git.example.com/acme/support-agents',
        defaultBranch: 'main',
        syncPath: '/',
        webhookSecret: 'webhook-secret',
        credentials: { type: 'token', secretId: 'secret-1' },
        authProfileId: null,
        syncConfig: { autoSync: true },
      }),
    });

    const response = await POST(githubRequest(), {
      params: Promise.resolve({ projectId: 'project-1' }),
    });

    expect(response.status).toBe(400);
    expect(mockResolveGitCredentials).not.toHaveBeenCalled();
    expect(mockPullProjectFiles).not.toHaveBeenCalled();
  });

  it('returns the same non-leaky 404 shape for unknown projects and projects without git integration', async () => {
    mockProjectFindOne.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      }),
    });
    const unknownProject = await POST(githubRequest(), {
      params: Promise.resolve({ projectId: 'missing-project' }),
    });

    mockProjectFindOne.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'project-1', tenantId: 'tenant-1' }),
      }),
    });
    mockGitIntegrationFindOne.mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue(null),
    });
    const missingIntegration = await POST(githubRequest(), {
      params: Promise.resolve({ projectId: 'project-1' }),
    });

    expect(unknownProject.status).toBe(404);
    expect(missingIntegration.status).toBe(404);
    await expect(unknownProject.json()).resolves.toEqual(await missingIntegration.json());
    expect(mockVerifyWebhookSignature).not.toHaveBeenCalled();
  });
});

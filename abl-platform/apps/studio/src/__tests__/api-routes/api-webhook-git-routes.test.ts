/**
 * Tests for Git Webhook API Route
 *
 * Covers:
 *   POST /api/webhooks/git/:projectId
 *   - Valid webhook with correct signature returns 200
 *   - Missing/invalid signature returns 401
 *   - Unknown projectId returns 404
 *   - Tenant-scoped integration lookup
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockProjectFindOne = vi.fn();
const mockGitIntegrationFindOne = vi.fn();
const mockProjectAgentFind = vi.fn();
const mockGitSyncHistoryCreate = vi.fn();
const mockGitIntegrationFindOneAndUpdate = vi.fn();
const mockLogAuditEvent = vi.fn();

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
const mockParseWebhookPayload = vi.fn();
const mockHasRelevantChanges = vi.fn();
const mockCreateGitProvider = vi.fn();
const mockGitSyncServicePull = vi.fn();
const mockGitSyncServicePullProjectFiles = vi.fn();

vi.mock('@agent-platform/project-io/git', () => ({
  verifyWebhookSignature: (...args: unknown[]) => mockVerifyWebhookSignature(...args),
  parseWebhookPayload: (...args: unknown[]) => mockParseWebhookPayload(...args),
  hasRelevantChanges: (...args: unknown[]) => mockHasRelevantChanges(...args),
  createGitProvider: (...args: unknown[]) => mockCreateGitProvider(...args),
  GitSyncService: vi.fn().mockImplementation(function () {
    return {
      pull: (...args: unknown[]) => mockGitSyncServicePull(...args),
      pullProjectFiles: (...args: unknown[]) => mockGitSyncServicePullProjectFiles(...args),
    };
  }),
}));

const mockApplyStudioLayeredImportV2 = vi.fn();
const mockGetRedisClient = vi.fn();

vi.mock('@/lib/project-import/layered-import-support', () => ({
  applyStudioLayeredImportV2: (...args: unknown[]) => mockApplyStudioLayeredImportV2(...args),
}));

vi.mock('@/lib/redis-client', () => ({
  getRedisClient: () => mockGetRedisClient(),
}));

const mockResolveGitCredentials = vi.fn();

vi.mock('@/lib/git-credentials', () => ({
  resolveGitCredentials: (...args: unknown[]) => mockResolveGitCredentials(...args),
}));

const mockNotifyRuntimeModelConfigChanged = vi.fn();

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

vi.mock('@/services/audit-service', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
  AuditActions: {
    GIT_WEBHOOK_ACCEPTED: 'git_webhook_accepted',
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createRequest(body: object, headers?: Record<string, string>): NextRequest {
  const req = new NextRequest('http://localhost/api/webhooks/git/proj-1', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
  return req;
}

const testIntegration = {
  _id: 'git-int-1',
  projectId: 'proj-1',
  tenantId: 'tenant-1',
  provider: 'github',
  repositoryUrl: 'https://github.com/org/repo',
  defaultBranch: 'main',
  syncPath: 'studio/project-a',
  webhookSecret: 'whsec_test123',
  authProfileId: 'auth-profile-1',
  syncConfig: { autoSync: true },
  lastSyncCommit: 'abc123',
};

const testProject = {
  _id: 'proj-1',
  tenantId: 'tenant-1',
};

const testPayload = {
  branch: 'main',
  commitSha: 'def456',
  changedFiles: ['agents/test-agent.abl'],
  isRelevant: true,
};

function makeLayeredPreview() {
  return {
    valid: true,
    formatVersion: '2.0',
    layers: ['core', 'workflows'],
    layerChanges: {
      core: { added: 0, modified: 1, removed: 0, unchanged: 0 },
      workflows: { added: 1, modified: 0, removed: 0, unchanged: 0 },
    },
    agentChanges: {
      added: [],
      modified: [{ name: 'test_agent', diff: { hunks: [] } }],
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
      resolved: 'test_agent',
      matchedBy: 'exact',
    },
    warnings: [],
  };
}

function makeLayeredApplyResult(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    preview: makeLayeredPreview(),
    warnings: [],
    applied: {
      modelPoliciesUpserted: 0,
      modelPoliciesDeleted: 0,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/git/:projectId', () => {
  let POST: (
    request: NextRequest,
    context: { params: Promise<{ projectId: string }> },
  ) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Default: project exists
    mockProjectFindOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(testProject),
      }),
    });

    // Default: integration exists
    mockGitIntegrationFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(testIntegration),
    });

    // Default: signature valid
    mockVerifyWebhookSignature.mockReturnValue(true);

    // Default: payload parses
    mockParseWebhookPayload.mockReturnValue(testPayload);

    // Default: relevant changes
    mockHasRelevantChanges.mockReturnValue(true);

    // Default: agents for pull
    mockProjectAgentFind.mockReturnValue({
      lean: vi.fn().mockResolvedValue([]),
    });

    // Default: pull succeeds
    mockGitSyncServicePull.mockResolvedValue({
      success: true,
      commitSha: 'def456',
      changes: { added: [], modified: ['test-agent'], deleted: [] },
    });
    mockGitSyncServicePullProjectFiles.mockResolvedValue({
      branch: 'main',
      commitSha: 'def456',
      files: new Map([['agents/test-agent.abl', 'AGENT: test_agent']]),
    });
    mockResolveGitCredentials.mockResolvedValue({ type: 'token', token: 'secret' });
    mockCreateGitProvider.mockReturnValue({ provider: 'github' });
    mockApplyStudioLayeredImportV2.mockResolvedValue(makeLayeredApplyResult());

    mockGitSyncHistoryCreate.mockResolvedValue({});
    mockGitIntegrationFindOneAndUpdate.mockResolvedValue({});
    mockLogAuditEvent.mockResolvedValue(undefined);
    mockGetRedisClient.mockReturnValue(null);

    const mod = await import('../../app/api/webhooks/git/[projectId]/route');
    POST = mod.POST;
  });

  it('applies a valid auto-sync webhook through the layered pull/import path', async () => {
    const req = createRequest(
      { ref: 'refs/heads/main', commits: [] },
      { 'x-hub-signature-256': 'sha256=valid' },
    );

    const res = await POST(req, { params: Promise.resolve({ projectId: 'proj-1' }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      success: true,
      processed: true,
      pendingSync: false,
      branch: 'main',
      commitSha: 'def456',
      changes: {
        added: ['workflows:added(1)'],
        modified: ['test_agent'],
        deleted: [],
      },
    });
    expect(mockGitSyncServicePullProjectFiles).toHaveBeenCalledWith('main', 'studio/project-a');
    expect(mockResolveGitCredentials).toHaveBeenCalledWith('auth-profile-1', 'tenant-1', {
      projectId: 'proj-1',
    });
    expect(mockApplyStudioLayeredImportV2).toHaveBeenCalledWith(
      expect.objectContaining({
        files: expect.any(Map),
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        userId: 'git-webhook',
        conflictStrategy: 'replace',
      }),
    );
    expect(mockGitIntegrationFindOneAndUpdate).toHaveBeenCalledWith(
      { projectId: 'proj-1', tenantId: 'tenant-1' },
      expect.objectContaining({
        lastSyncStatus: 'success',
        lastSyncCommit: 'def456',
      }),
    );
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'git_webhook_accepted',
        metadata: expect.objectContaining({
          projectId: 'proj-1',
          resourceType: 'git_integration',
          resourceId: 'git-int-1',
          branch: 'main',
          relevantChanges: true,
          autoSyncEnabled: true,
        }),
      }),
    );
  });

  it('invalidates runtime model cache after webhook model policy mutations', async () => {
    mockParseWebhookPayload.mockReturnValueOnce({
      ...testPayload,
      commitSha: 'model-policy-commit',
    });
    mockApplyStudioLayeredImportV2.mockResolvedValueOnce(
      makeLayeredApplyResult({
        applied: {
          modelPoliciesUpserted: 1,
          modelPoliciesDeleted: 0,
        },
      }),
    );

    const req = createRequest(
      { ref: 'refs/heads/main', commits: [] },
      {
        'x-hub-signature-256': 'sha256=valid',
        authorization: 'Bearer studio-token',
      },
    );

    const res = await POST(req, { params: Promise.resolve({ projectId: 'proj-1' }) });

    expect(res.status).toBe(200);
    expect(mockNotifyRuntimeModelConfigChanged).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      authorization: 'Bearer studio-token',
    });
  });

  it('uses Redis SET NX with TTL to dedupe webhook deliveries across pods', async () => {
    const redis = {
      set: vi.fn().mockResolvedValue(null),
      del: vi.fn().mockResolvedValue(1),
    };
    mockGetRedisClient.mockReturnValue(redis);

    const req = createRequest(
      { ref: 'refs/heads/main', commits: [] },
      { 'x-hub-signature-256': 'sha256=valid' },
    );

    const res = await POST(req, { params: Promise.resolve({ projectId: 'proj-1' }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      processed: false,
      message: 'Duplicate webhook delivery already processed',
    });
    expect(redis.set).toHaveBeenCalledWith(
      'studio:git-webhook-delivery:proj-1:main:def456',
      '1',
      'EX',
      86400,
      'NX',
    );
    expect(redis.del).not.toHaveBeenCalled();
    expect(mockGitSyncServicePullProjectFiles).not.toHaveBeenCalled();
  });

  it('returns 401 for invalid signature', async () => {
    mockVerifyWebhookSignature.mockReturnValue(false);

    const req = createRequest(
      { ref: 'refs/heads/main' },
      { 'x-hub-signature-256': 'sha256=invalid' },
    );

    const res = await POST(req, { params: Promise.resolve({ projectId: 'proj-1' }) });
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Invalid signature');
  });

  it('returns 401 when signature header is missing', async () => {
    mockVerifyWebhookSignature.mockReturnValue(false);

    const req = createRequest({ ref: 'refs/heads/main' });

    const res = await POST(req, { params: Promise.resolve({ projectId: 'proj-1' }) });

    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown projectId', async () => {
    mockProjectFindOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      }),
    });

    const req = createRequest(
      { ref: 'refs/heads/main' },
      { 'x-hub-signature-256': 'sha256=valid' },
    );

    const res = await POST(req, { params: Promise.resolve({ projectId: 'unknown-proj' }) });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe('Not found');
  });

  it('returns 404 when no git integration configured', async () => {
    mockGitIntegrationFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });

    const req = createRequest(
      { ref: 'refs/heads/main' },
      { 'x-hub-signature-256': 'sha256=valid' },
    );

    const res = await POST(req, { params: Promise.resolve({ projectId: 'proj-1' }) });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe('Not found');
  });

  // TODO: Rate limiting is not yet implemented in the webhook route.
  // Add rate limit test cases when rate limiting middleware is added.
  // it('returns 429 with Retry-After header when rate limited', ...)

  it('uses tenantId from project lookup for integration query', async () => {
    const req = createRequest(
      { ref: 'refs/heads/main' },
      { 'x-hub-signature-256': 'sha256=valid' },
    );

    await POST(req, { params: Promise.resolve({ projectId: 'proj-1' }) });

    // Verify integration lookup includes tenantId from project
    expect(mockGitIntegrationFindOne).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
  });

  it('returns 200 with processed=false when auto-sync is disabled', async () => {
    mockGitIntegrationFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        ...testIntegration,
        syncConfig: { autoSync: false },
      }),
    });

    const req = createRequest(
      { ref: 'refs/heads/main' },
      { 'x-hub-signature-256': 'sha256=valid' },
    );

    const res = await POST(req, { params: Promise.resolve({ projectId: 'proj-1' }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.processed).toBe(false);
    expect(json.message).toContain('Auto-sync is disabled');
  });

  it('returns 200 with processed=false for non-matching branch', async () => {
    mockParseWebhookPayload.mockReturnValue({
      ...testPayload,
      branch: 'feature/other',
    });

    const req = createRequest(
      { ref: 'refs/heads/feature/other' },
      { 'x-hub-signature-256': 'sha256=valid' },
    );

    const res = await POST(req, { params: Promise.resolve({ projectId: 'proj-1' }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.processed).toBe(false);
    expect(json.message).toContain('does not match sync branch');
  });
});

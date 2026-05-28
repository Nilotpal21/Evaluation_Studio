import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

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

vi.mock('@/config', () => ({
  getConfig: vi.fn(() => ({
    jwt: { secret: 'test-jwt-secret' },
    server: { frontendUrl: 'http://localhost:5173' },
  })),
  isConfigLoaded: vi.fn(() => true),
}));

const mockGitIntegrationFindOne = vi.fn();
const mockProjectAgentFind = vi.fn();
const mockEnsureConnected = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  ensureConnected: (...args: unknown[]) => mockEnsureConnected(...args),
  GitIntegration: {
    findOne: (...args: unknown[]) => mockGitIntegrationFindOne(...args),
  },
  ProjectAgent: {
    find: (...args: unknown[]) => mockProjectAgentFind(...args),
  },
}));

const mockListProjectLocalizationAssets = vi.fn();
vi.mock('@/lib/localization-assets', () => ({
  listProjectLocalizationAssets: (...args: unknown[]) => mockListProjectLocalizationAssets(...args),
}));

const mockResolveLayers = vi.fn();
const mockBuildLayerPreview = vi.fn();
vi.mock('@agent-platform/project-io/export', () => ({
  resolveLayers: (...args: unknown[]) => mockResolveLayers(...args),
  buildLayerPreview: (...args: unknown[]) => mockBuildLayerPreview(...args),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@agent-platform/shared/rbac', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-platform/shared/rbac')>()),
  hasSensitivePermission: vi.fn((granted: string[], required: string) =>
    granted.includes(required),
  ),
  isSensitiveExactPermission: vi.fn(() => false),
}));

vi.mock('@/repos/project-repo', () => ({
  findProjectByIdAndTenant: vi.fn(),
  findProjectById: vi.fn(),
}));

const testUser = {
  id: 'user-1',
  email: 'test@test.com',
  name: 'Test User',
  tenantId: 'tenant-1',
  permissions: ['project:git'],
};

const testProject = {
  id: 'proj-1',
  _id: 'proj-1',
  name: 'Support Ops',
  slug: 'support-ops',
  ownerId: 'owner-1',
  tenantId: 'tenant-1',
};

function makeAgentQuery(data: unknown[]) {
  return {
    limit: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(data),
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue(testUser);
  mockIsAuthError.mockReturnValue(false);
  mockRequireProjectAccess.mockResolvedValue({ project: testProject });
  mockIsAccessError.mockReturnValue(false);

  mockEnsureConnected.mockResolvedValue(undefined);
  mockGitIntegrationFindOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue({
      provider: 'github',
      repositoryUrl: 'https://github.com/acme/support-ops',
      defaultBranch: 'main',
      lastSyncAt: '2026-05-03T00:00:00.000Z',
      lastSyncCommit: 'abc1234',
      lastSyncStatus: 'success',
    }),
  });
  mockProjectAgentFind.mockReturnValue(
    makeAgentQuery([
      {
        name: 'support_agent',
        sourceHash: 'hash-support',
        updatedAt: '2026-05-02T10:00:00.000Z',
      },
    ]),
  );
  mockListProjectLocalizationAssets.mockResolvedValue([
    {
      id: 'locale-1',
      relativePath: 'en/shared.json',
      filePath: 'locales/en/shared.json',
      localeCode: 'en',
      scope: 'shared',
      updatedAt: '2026-05-02T10:05:00.000Z',
    },
  ]);
  mockResolveLayers.mockReturnValue(['core', 'connections', 'guardrails', 'workflows']);
  mockBuildLayerPreview.mockResolvedValue([
    { name: 'core', defaultMode: 'always', entityCount: 4 },
    { name: 'connections', defaultMode: 'always', entityCount: 2 },
    { name: 'guardrails', defaultMode: 'on', entityCount: 1 },
    { name: 'workflows', defaultMode: 'on', entityCount: 0 },
    { name: 'evals', defaultMode: 'off', entityCount: 3 },
    { name: 'search', defaultMode: 'off', entityCount: 0 },
    { name: 'channels', defaultMode: 'off', entityCount: 0 },
    { name: 'vocabulary', defaultMode: 'off', entityCount: 0 },
  ]);
});

describe('GET /api/projects/:id/git/status', () => {
  it('returns canonical local layer coverage alongside agent and locale state', async () => {
    const { GET } = await import('@/app/api/projects/[id]/git/status/route');

    const response = await GET(new NextRequest('http://localhost/api/projects/proj-1/git/status'), {
      params: Promise.resolve({ id: 'proj-1' }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.integration.provider).toBe('github');
    expect(body.defaultLayers).toEqual(['core', 'connections', 'guardrails', 'workflows']);
    expect(body.localLayers).toEqual([
      { name: 'core', defaultMode: 'always', entityCount: 4 },
      { name: 'connections', defaultMode: 'always', entityCount: 2 },
      { name: 'guardrails', defaultMode: 'on', entityCount: 1 },
      { name: 'workflows', defaultMode: 'on', entityCount: 0 },
      { name: 'evals', defaultMode: 'off', entityCount: 3 },
      { name: 'search', defaultMode: 'off', entityCount: 0 },
      { name: 'channels', defaultMode: 'off', entityCount: 0 },
      { name: 'vocabulary', defaultMode: 'off', entityCount: 0 },
    ]);
    expect(body.localAgents).toEqual([
      {
        name: 'support_agent',
        sourceHash: 'hash-support',
        lastEditedAt: '2026-05-02T10:00:00.000Z',
      },
    ]);
    expect(body.localLocaleFiles).toHaveLength(1);
    expect(mockBuildLayerPreview).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1', tenantId: 'tenant-1' }),
    );
  });

  it('returns 404 when no git integration exists', async () => {
    mockGitIntegrationFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });

    const { GET } = await import('@/app/api/projects/[id]/git/status/route');
    const response = await GET(new NextRequest('http://localhost/api/projects/proj-1/git/status'), {
      params: Promise.resolve({ id: 'proj-1' }),
    });

    expect(response.status).toBe(404);
  });

  it('returns 401 when authentication fails', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const { GET } = await import('@/app/api/projects/[id]/git/status/route');
    const response = await GET(new NextRequest('http://localhost/api/projects/proj-1/git/status'), {
      params: Promise.resolve({ id: 'proj-1' }),
    });

    expect(response.status).toBe(401);
  });

  it('returns 403 when the caller only has project read permission', async () => {
    mockRequireAuth.mockResolvedValue({
      ...testUser,
      permissions: ['project:read'],
    });

    const { GET } = await import('@/app/api/projects/[id]/git/status/route');
    const response = await GET(new NextRequest('http://localhost/api/projects/proj-1/git/status'), {
      params: Promise.resolve({ id: 'proj-1' }),
    });

    expect(response.status).toBe(403);
    expect(mockGitIntegrationFindOne).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockWithRouteHandler = vi.fn(
  (_options: unknown, handler: Function) =>
    async (request: NextRequest, ctx: { params: Promise<Record<string, string>> }) =>
      handler({
        request,
        tenantId: 'tenant-1',
        user: { id: 'user-1', permissions: ['project:git'] },
        params: await ctx.params,
        project: { id: 'project-1', tenantId: 'tenant-1' },
      }),
);

vi.mock('@/lib/route-handler', () => ({
  withRouteHandler: (...args: unknown[]) => mockWithRouteHandler(...args),
}));

vi.mock('@/lib/permissions', () => ({
  StudioPermission: {
    PROJECT_READ: 'project:read',
    PROJECT_GIT: 'project:git',
  },
}));

const mockGitIntegrationFindOne = vi.fn();
const mockProjectAgentFind = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  GitIntegration: {
    findOne: (...args: unknown[]) => mockGitIntegrationFindOne(...args),
  },
  ProjectAgent: {
    find: (...args: unknown[]) => mockProjectAgentFind(...args),
  },
}));

vi.mock('@/lib/localization-assets', () => ({
  listProjectLocalizationAssets: vi.fn().mockResolvedValue([]),
}));

vi.mock('@agent-platform/project-io/export', () => ({
  buildLayerPreview: vi.fn().mockResolvedValue([]),
  resolveLayers: vi.fn(() => ['core', 'connections', 'prompts', 'guardrails', 'workflows']),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    error: vi.fn(),
  })),
}));

function statusRequest(): NextRequest {
  return new NextRequest('http://localhost/api/projects/project-1/git/status', {
    method: 'GET',
    headers: { authorization: 'Bearer token' },
  });
}

describe('Git status hidden path scenarios', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    mockGitIntegrationFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'git-integration-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
        provider: 'github',
        repositoryUrl: 'https://github.com/acme/support',
        defaultBranch: 'main',
        syncPath: '/',
        credentials: { type: 'token', secretId: 'secret-1', token: 'raw-token' },
        authProfileId: 'auth-profile-1',
        webhookSecret: 'webhook-secret',
        lastSyncAt: null,
        lastSyncCommit: 'commit-1',
        lastSyncStatus: 'success',
      }),
    });
    mockProjectAgentFind.mockReturnValue({
      limit: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([]),
      }),
    });
  });

  it('scopes status lookup by project and tenant and never returns secret-bearing fields', async () => {
    const { GET } = await import('@/app/api/projects/[id]/git/status/route');

    const response = await GET(statusRequest(), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(200);
    expect(mockGitIntegrationFindOne).toHaveBeenCalledWith({
      projectId: 'project-1',
      tenantId: 'tenant-1',
    });
    const payloadText = JSON.stringify(await response.json());
    expect(payloadText).not.toContain('secret-1');
    expect(payloadText).not.toContain('raw-token');
    expect(payloadText).not.toContain('webhook-secret');
    expect(payloadText).not.toContain('auth-profile-1');
  });

  it('requires git-specific permission because status exposes repository state', async () => {
    await import('@/app/api/projects/[id]/git/status/route');

    expect(mockWithRouteHandler).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: 'project:git' }),
      expect.any(Function),
    );
  });
});

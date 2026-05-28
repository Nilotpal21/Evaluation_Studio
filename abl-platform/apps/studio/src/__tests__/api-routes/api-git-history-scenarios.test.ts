/**
 * Git history route scenarios.
 *
 * These are thin acceptance-style checks for the wire contract: history is
 * scoped by project + tenant, direction filters are forwarded, and limits are
 * bounded.
 */

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
const mockGitSyncHistoryFind = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  GitIntegration: {
    findOne: (...args: unknown[]) => mockGitIntegrationFindOne(...args),
  },
  GitSyncHistory: {
    find: (...args: unknown[]) => mockGitSyncHistoryFind(...args),
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

function makeRequest(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'GET',
  });
}

describe('GET /api/projects/[id]/git/history scenarios', () => {
  let GET: (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    mockGitIntegrationFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'git-integration-1',
        projectId: 'project-1',
        tenantId: 'tenant-1',
      }),
    });
    mockGitSyncHistoryFind.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([
            {
              projectId: 'project-1',
              tenantId: 'tenant-1',
              direction: 'pull',
              status: 'success',
            },
          ]),
        }),
      }),
    });

    const mod = await import('@/app/api/projects/[id]/git/history/route');
    GET = mod.GET;
  });

  it('queries history by project and tenant with direction filter', async () => {
    const response = await GET(makeRequest('/api/projects/project-1/git/history?direction=pull'), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(200);
    expect(mockGitSyncHistoryFind).toHaveBeenCalledWith({
      projectId: 'project-1',
      tenantId: 'tenant-1',
      direction: 'pull',
    });
  });

  it('requires git-specific permission because history exposes sync metadata', async () => {
    expect(mockWithRouteHandler).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: 'project:git' }),
      expect.any(Function),
    );
  });

  it('caps requested history limit at the route maximum', async () => {
    const limit = vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue([]),
    });
    mockGitSyncHistoryFind.mockReturnValueOnce({
      sort: vi.fn().mockReturnValue({ limit }),
    });

    const response = await GET(makeRequest('/api/projects/project-1/git/history?limit=999'), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(200);
    expect(limit).toHaveBeenCalledWith(100);
  });

  it('returns 404 before querying history when the project has no git integration', async () => {
    mockGitIntegrationFindOne.mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue(null),
    });

    const response = await GET(makeRequest('/api/projects/project-1/git/history'), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(404);
    expect(mockGitSyncHistoryFind).not.toHaveBeenCalled();
  });

  it('rejects unsupported direction filters instead of querying arbitrary values', async () => {
    const response = await GET(
      makeRequest('/api/projects/project-1/git/history?direction=sideways'),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(400);
    expect(mockGitSyncHistoryFind).not.toHaveBeenCalled();
  });

  it('uses the default limit for invalid or negative limit values', async () => {
    const limit = vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue([]),
    });
    mockGitSyncHistoryFind.mockReturnValueOnce({
      sort: vi.fn().mockReturnValue({ limit }),
    });

    const response = await GET(makeRequest('/api/projects/project-1/git/history?limit=-5'), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(200);
    expect(limit).toHaveBeenCalledWith(25);
  });

  it('uses deterministic newest-first sorting with an _id tie-breaker', async () => {
    const sort = vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([]),
      }),
    });
    mockGitSyncHistoryFind.mockReturnValueOnce({ sort });

    const response = await GET(makeRequest('/api/projects/project-1/git/history'), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(200);
    expect(sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
  });

  it('forwards branch and status filters with the tenant-scoped history query', async () => {
    const response = await GET(
      makeRequest('/api/projects/project-1/git/history?branch=main&status=failed'),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(200);
    expect(mockGitSyncHistoryFind).toHaveBeenCalledWith({
      projectId: 'project-1',
      tenantId: 'tenant-1',
      branch: 'main',
      status: 'failed',
    });
  });

  it('rejects unsupported status filters instead of querying arbitrary values', async () => {
    const response = await GET(
      makeRequest('/api/projects/project-1/git/history?status=half-synced'),
      {
        params: Promise.resolve({ id: 'project-1' }),
      },
    );

    expect(response.status).toBe(400);
    expect(mockGitSyncHistoryFind).not.toHaveBeenCalled();
  });
});

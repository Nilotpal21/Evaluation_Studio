import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockRequireAuth = vi.fn();
const mockRequireProjectAccess = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  isAuthError: () => false,
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: unknown[]) => mockRequireProjectAccess(...args),
  isAccessError: () => false,
}));

vi.mock('@/lib/permissions', () => ({
  StudioPermission: { CONNECTION_WRITE: 'connection:write' },
}));

vi.mock('@/lib/route-handler', () => ({
  withRouteHandler:
    (options: { requireProject?: boolean }, handler: Function) =>
    async (request: NextRequest, ctx: { params: Promise<Record<string, string>> }) => {
      const params = await ctx.params;
      return handler({
        request,
        user: {
          id: 'user-1',
          tenantId: 'tenant-1',
          permissions: ['connection:write'],
        },
        tenantId: 'tenant-1',
        params,
        project: { id: params.id, tenantId: 'tenant-1' },
      });
    },
}));

import { POST } from '@/app/api/projects/[id]/connections/oauth/callback/route';

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/projects/proj-1/connections/oauth/callback', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

describe('connection oauth callback route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      tenantId: 'tenant-1',
      permissions: ['connection:write'],
    });
    mockRequireProjectAccess.mockResolvedValue({
      project: { id: 'proj-1', tenantId: 'tenant-1' },
    });
  });

  it('returns 410 Gone — OAuth connections are now created via auth profiles', async () => {
    const response = await POST(makeRequest({ code: 'auth-code', state: 'some-state' }), {
      params: Promise.resolve({ id: 'proj-1' }),
    });

    expect(response.status).toBe(410);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('auth profiles');
  });
});

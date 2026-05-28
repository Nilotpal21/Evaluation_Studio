import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/permissions', () => ({
  StudioPermission: {
    CONNECTION_READ: 'connection:read',
    CONNECTION_WRITE: 'connection:write',
  },
}));

vi.mock('@/lib/route-handler', () => ({
  withRouteHandler:
    (_options: unknown, handler: Function) =>
    async (request: NextRequest, ctx: { params: Promise<Record<string, string>> }) => {
      const params = await ctx.params;
      return handler({
        request,
        user: {
          id: 'user-1',
          tenantId: 'tenant-1',
          permissions: ['connection:read', 'connection:write'],
        },
        tenantId: 'tenant-1',
        params,
        project: { id: params.id, tenantId: 'tenant-1' },
      });
    },
}));

const mockFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mockFetch);
});

function makeRequest(url: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    ...init,
    headers: {
      Authorization: 'Bearer studio-token',
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

describe('agent-transfer settings proxy route', () => {
  it('proxies canonical GET responses from runtime', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          defaultRouting: {
            connection: {
              connectionId: 'conn-123',
            },
            queue: 'vip-support',
          },
        },
      }),
    });

    const { GET } = await import('@/app/api/projects/[id]/agent-transfer/settings/route');
    const response = await GET(makeRequest('/api/projects/project-123/agent-transfer/settings'), {
      params: Promise.resolve({ id: 'project-123' }),
    });
    const body = await response.json();

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3112/api/v1/agent-transfer/settings',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer studio-token',
          'Content-Type': 'application/json',
          'X-Project-Id': 'project-123',
          'X-Tenant-Id': 'tenant-1',
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: {
        defaultRouting: {
          connection: {
            connectionId: 'conn-123',
          },
          queue: 'vip-support',
        },
      },
    });
  });

  it('proxies canonical PUT payloads to runtime unchanged', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          defaultRouting: {
            connection: {
              connectionId: 'conn-123',
            },
            queue: 'vip-support',
          },
        },
      }),
    });

    const payload = {
      defaultRouting: {
        connection: {
          connectionId: 'conn-123',
        },
        queue: 'vip-support',
      },
    };

    const { PUT } = await import('@/app/api/projects/[id]/agent-transfer/settings/route');
    const response = await PUT(
      makeRequest('/api/projects/project-123/agent-transfer/settings', {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
      {
        params: Promise.resolve({ id: 'project-123' }),
      },
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3112/api/v1/agent-transfer/settings',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({
          Authorization: 'Bearer studio-token',
          'Content-Type': 'application/json',
          'X-Project-Id': 'project-123',
          'X-Tenant-Id': 'tenant-1',
        }),
        body: JSON.stringify(payload),
      }),
    );
    expect(response.status).toBe(200);
  });
});

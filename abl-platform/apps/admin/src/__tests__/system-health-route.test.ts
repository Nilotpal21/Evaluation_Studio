import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockBuildRuntimeHeaders = vi.fn();
const mockFetch = vi.fn();

vi.mock('../lib/with-admin-route', () => ({
  withAdminRoute:
    (_options: unknown, handler: (ctx: any) => Promise<Response>) =>
    async (request: NextRequest, routeCtx?: { params?: Promise<Record<string, string>> }) =>
      handler({
        request,
        params: routeCtx?.params ? await routeCtx.params : {},
        token: 'admin-token',
        user: {
          userId: 'admin-user',
          email: 'admin@example.com',
          role: 'VIEWER',
          ipAddress: '127.0.0.1',
          isSuperAdmin: false,
        },
      }),
}));

vi.mock('../lib/runtime-proxy', () => ({
  getRuntimeBaseUrl: () => 'http://localhost:3112',
  buildRuntimeHeaders: (...args: unknown[]) => mockBuildRuntimeHeaders(...args),
}));

function makeRequest(url: string): NextRequest {
  return new NextRequest(new URL(url));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockBuildRuntimeHeaders.mockReturnValue({
    Authorization: 'Bearer admin-token',
  });
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Admin system-health proxy route', () => {
  test('surfaces runtime compatibility blockers without reshaping the payload', async () => {
    const payload = {
      success: true,
      summary: {
        total: 3,
        changeManagementBlockers: 1,
        changeManagementWarnings: 0,
      },
      changeManagement: {
        service: 'runtime',
        outcome: 'not_ready',
        blockingIssues: [
          {
            changeId: 'seed.platform-core',
            reason: 'missing',
          },
        ],
      },
    };

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
    });

    const { GET } = await import('../app/api/system-health/route.js');

    const response = await GET(makeRequest('http://localhost:3003/api/system-health'), {
      params: Promise.resolve({}),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(payload);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3112/api/platform/admin/system-health',
      {
        headers: {
          Authorization: 'Bearer admin-token',
        },
      },
    );
  });

  test('returns 502 when the runtime proxy fails', async () => {
    mockFetch.mockRejectedValue(new Error('runtime unavailable'));

    const { GET } = await import('../app/api/system-health/route.js');

    const response = await GET(makeRequest('http://localhost:3003/api/system-health'), {
      params: Promise.resolve({}),
    });
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      success: false,
      error: 'Failed to connect to runtime',
    });
  });
});

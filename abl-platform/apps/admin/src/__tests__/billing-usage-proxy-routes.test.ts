import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockBuildRuntimeHeaders = vi.fn();

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

const mockFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockBuildRuntimeHeaders.mockReturnValue({
    Authorization: 'Bearer admin-token',
  });
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ success: true }),
  });
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeRequest(url: string): NextRequest {
  return new NextRequest(new URL(url));
}

describe('Admin billing usage proxy routes', () => {
  test('GET /api/usage proxies to the platform billing usage report endpoint', async () => {
    const { GET } = await import('../app/api/usage/route.js');

    const response = await GET(
      makeRequest(
        'http://localhost:3003/api/usage?windowStart=2026-03-30T00:00:00.000Z&windowEnd=2026-03-31T00:00:00.000Z&granularity=day',
      ),
      { params: Promise.resolve({}) },
    );

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3112/api/platform/admin/billing-policy/reports/usage?windowStart=2026-03-30T00%3A00%3A00.000Z&windowEnd=2026-03-31T00%3A00%3A00.000Z&granularity=day',
      {
        headers: {
          Authorization: 'Bearer admin-token',
        },
      },
    );
  });

  test('GET /api/tenants/:tenantId/usage proxies to the tenant billing usage report endpoint', async () => {
    const { GET } = await import('../app/api/tenants/[tenantId]/usage/route.js');

    const response = await GET(
      makeRequest(
        'http://localhost:3003/api/tenants/tenant-123/usage?windowStart=2026-03-30T00:00:00.000Z&windowEnd=2026-03-31T00:00:00.000Z&granularity=day',
      ),
      { params: Promise.resolve({ tenantId: 'tenant-123' }) },
    );

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3112/api/platform/admin/billing-policy/tenant-123/reports/usage?windowStart=2026-03-30T00%3A00%3A00.000Z&windowEnd=2026-03-31T00%3A00%3A00.000Z&granularity=day',
      {
        headers: {
          Authorization: 'Bearer admin-token',
        },
      },
    );
  });

  test('GET /api/usage/publication-status proxies to the platform publication visibility endpoint', async () => {
    const { GET } = await import('../app/api/usage/publication-status/route.js');

    const response = await GET(
      makeRequest('http://localhost:3003/api/usage/publication-status?limit=10'),
      { params: Promise.resolve({}) },
    );

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3112/api/platform/admin/billing-policy/materializations/publication-status?limit=10',
      {
        headers: {
          Authorization: 'Bearer admin-token',
        },
      },
    );
  });

  test('GET /api/tenants/:tenantId/usage/publication-status proxies to the tenant publication visibility endpoint', async () => {
    const { GET } = await import('../app/api/tenants/[tenantId]/usage/publication-status/route.js');

    const response = await GET(
      makeRequest('http://localhost:3003/api/tenants/tenant-123/usage/publication-status?limit=8'),
      { params: Promise.resolve({ tenantId: 'tenant-123' }) },
    );

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3112/api/platform/admin/billing-policy/tenant-123/materializations/publication-status?limit=8',
      {
        headers: {
          Authorization: 'Bearer admin-token',
        },
      },
    );
  });

  test('GET /api/tenants/:tenantId/usage/materializations/:batchId proxies to the batch detail endpoint', async () => {
    const { GET } =
      await import('../app/api/tenants/[tenantId]/usage/materializations/[batchId]/route.js');

    const response = await GET(
      makeRequest('http://localhost:3003/api/tenants/tenant-123/usage/materializations/batch-456'),
      { params: Promise.resolve({ tenantId: 'tenant-123', batchId: 'batch-456' }) },
    );

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3112/api/platform/admin/billing-policy/tenant-123/materializations/batch-456',
      {
        headers: {
          Authorization: 'Bearer admin-token',
        },
      },
    );
  });

  test('GET /api/tenants/:tenantId/usage/materializations/:batchId/application proxies to the application detail endpoint', async () => {
    const { GET } =
      await import('../app/api/tenants/[tenantId]/usage/materializations/[batchId]/application/route.js');

    const response = await GET(
      makeRequest(
        'http://localhost:3003/api/tenants/tenant-123/usage/materializations/batch-456/application',
      ),
      { params: Promise.resolve({ tenantId: 'tenant-123', batchId: 'batch-456' }) },
    );

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3112/api/platform/admin/billing-policy/tenant-123/materializations/batch-456/application',
      {
        headers: {
          Authorization: 'Bearer admin-token',
        },
      },
    );
  });

  test('GET /api/tenants/:tenantId/usage/materializations/:batchId/results proxies to the paginated results endpoint', async () => {
    const { GET } =
      await import('../app/api/tenants/[tenantId]/usage/materializations/[batchId]/results/route.js');

    const response = await GET(
      makeRequest(
        'http://localhost:3003/api/tenants/tenant-123/usage/materializations/batch-456/results?page=2&limit=5',
      ),
      { params: Promise.resolve({ tenantId: 'tenant-123', batchId: 'batch-456' }) },
    );

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3112/api/platform/admin/billing-policy/tenant-123/materializations/batch-456/results?page=2&limit=5',
      {
        headers: {
          Authorization: 'Bearer admin-token',
        },
      },
    );
  });

  test('POST /api/tenants/:tenantId/usage/materializations/:batchId/apply proxies to the apply endpoint', async () => {
    const { POST } =
      await import('../app/api/tenants/[tenantId]/usage/materializations/[batchId]/apply/route.js');

    const response = await POST(
      makeRequest(
        'http://localhost:3003/api/tenants/tenant-123/usage/materializations/batch-456/apply',
      ),
      { params: Promise.resolve({ tenantId: 'tenant-123', batchId: 'batch-456' }) },
    );

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3112/api/platform/admin/billing-policy/tenant-123/materializations/batch-456/apply',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-token',
        },
      },
    );
  });

  test('GET /api/usage returns 502 when the runtime proxy fails', async () => {
    mockFetch.mockRejectedValueOnce(new Error('runtime unavailable'));
    const { GET } = await import('../app/api/usage/route.js');

    const response = await GET(makeRequest('http://localhost:3003/api/usage'), {
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

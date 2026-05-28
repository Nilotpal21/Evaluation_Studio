import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockRequireTenantAuth = vi.fn();
const mockIsAuthError = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireTenantAuth: (...args: unknown[]) => mockRequireTenantAuth(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
}));

vi.mock('@/services/auth-service', () => ({
  verifyAccessToken: vi.fn(),
}));

vi.mock('@/repos/auth-repo', () => ({
  findUserById: vi.fn(),
}));

vi.mock('@/config/runtime.server', () => ({
  getRuntimeUrl: () => 'http://localhost:3112',
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockFetch = vi.fn();

const authenticatedUser = {
  id: 'user-1',
  email: 'test@test.com',
  name: 'Test User',
  tenantId: 'tenant-1',
  permissions: ['*:*'],
};

function makeRequest(url: string, opts: Record<string, unknown> = {}) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    ...opts,
    headers: {
      Authorization: 'Bearer test-jwt-token',
      'X-Tenant-Id': 'tenant-1',
      'Content-Type': 'application/json',
      ...((opts.headers as Record<string, string>) || {}),
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireTenantAuth.mockResolvedValue(authenticatedUser);
  mockIsAuthError.mockReturnValue(false);
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        success: true,
        summary: { totalRequests: 3 },
        breakdown: [],
        daily: [],
        projects: [],
      }),
  });
  vi.stubGlobal('fetch', mockFetch);
});

import { GET as getAnalyticsTenantUsage } from '@/app/api/analytics/tenant-usage/route';
import { GET as getLegacyTenantUsage } from '@/app/api/tenant-usage/route';

describe('tenant usage analytics proxy routes', () => {
  test('forwards analytics requests with authenticated tenant scope and strips tenantId from the runtime query', async () => {
    const request = makeRequest(
      '/api/analytics/tenant-usage?tenantId=tenant-1&startDate=2026-03-01T00%3A00%3A00.000Z&endDate=2026-03-08T00%3A00%3A00.000Z&projectId=project-abc',
    );

    const response = await getAnalyticsTenantUsage(request);
    const body = await response.json();

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'http://localhost:3112/api/tenants/tenant-1/usage?startDate=2026-03-01T00%3A00%3A00.000Z&endDate=2026-03-08T00%3A00%3A00.000Z&projectId=project-abc',
    );
    expect(init).toEqual(
      expect.objectContaining({
        method: 'GET',
        cache: 'no-store',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-jwt-token',
          'X-Tenant-Id': 'tenant-1',
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
  });

  test('returns 404 when a caller tries to override tenant scope', async () => {
    const response = await getAnalyticsTenantUsage(
      makeRequest('/api/analytics/tenant-usage?tenantId=tenant-2&projectId=project-abc'),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Not found' },
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('keeps the legacy route as a shim and marks responses as deprecated', async () => {
    const response = await getLegacyTenantUsage(
      makeRequest(
        '/api/tenant-usage?tenantId=tenant-1&startDate=2026-03-01T00%3A00%3A00.000Z&endDate=2026-03-08T00%3A00%3A00.000Z&projectId=project-abc',
      ),
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(response.headers.get('Deprecation')).toBe('true');
    expect(response.headers.get('X-ABL-Successor-Route')).toBe('/api/analytics/tenant-usage');
  });

  test('returns auth errors without calling runtime', async () => {
    const authError = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireTenantAuth.mockResolvedValue(authError);
    mockIsAuthError.mockReturnValue(true);

    const response = await getLegacyTenantUsage(makeRequest('/api/tenant-usage'));

    expect(response.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('returns proxy failures with compatibility headers on the legacy route', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Runtime unavailable'));

    const response = await getLegacyTenantUsage(
      makeRequest('/api/tenant-usage?tenantId=tenant-1&projectId=project-abc'),
    );
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      success: false,
      error: { code: 'PROXY_ERROR', message: 'Failed to fetch usage analytics from runtime' },
    });
    expect(response.headers.get('Deprecation')).toBe('true');
    expect(response.headers.get('X-ABL-Successor-Route')).toBe('/api/analytics/tenant-usage');
  });
});

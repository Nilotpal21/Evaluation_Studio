/**
 * Project Billing Usage Proxy Route Tests
 *
 * Verifies the Studio proxy route correctly:
 * - forwards GET requests to the runtime project billing usage API
 * - preserves auth and tenant headers
 * - short-circuits on auth/access failures
 * - returns 502 when runtime proxying fails
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
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

const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn();
vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: unknown[]) => mockRequireProjectAccess(...args),
  isAccessError: (...args: unknown[]) => mockIsAccessError(...args),
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
};

beforeEach(() => {
  vi.clearAllMocks();

  mockRequireTenantAuth.mockResolvedValue(authenticatedUser);
  mockIsAuthError.mockReturnValue(false);
  mockRequireProjectAccess.mockResolvedValue({
    project: {
      id: 'project-1',
      tenantId: 'tenant-1',
      name: 'Support Ops',
      slug: 'support-ops',
      ownerId: 'user-1',
    },
  });
  mockIsAccessError.mockReturnValue(false);
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      tenantId: 'tenant-1',
      projectId: 'project-1',
      totals: {
        totalUnits: 3,
      },
      windows: [],
      projectBreakdown: [],
      channelBreakdown: [],
    }),
  });
  vi.stubGlobal('fetch', mockFetch);
});

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

import { GET } from '@/app/api/projects/[id]/billing/usage/route';

describe('Project billing usage proxy route', () => {
  const routeParams = { params: Promise.resolve({ id: 'project-1' }) };

  test('forwards GET to runtime with auth headers and query string intact', async () => {
    const request = makeRequest(
      '/api/projects/project-1/billing/usage?windowStart=2026-03-01T00%3A00%3A00.000Z&windowEnd=2026-03-08T00%3A00%3A00.000Z&granularity=day',
    );

    const response = await GET(request, routeParams);
    const body = await response.json();

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'http://localhost:3112/api/projects/project-1/billing/usage?windowStart=2026-03-01T00%3A00%3A00.000Z&windowEnd=2026-03-08T00%3A00%3A00.000Z&granularity=day',
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
    expect(body.projectId).toBe('project-1');
  });

  test('returns auth errors without calling runtime', async () => {
    const authError = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireTenantAuth.mockResolvedValue(authError);
    mockIsAuthError.mockReturnValue(true);

    const response = await GET(makeRequest('/api/projects/project-1/billing/usage'), routeParams);

    expect(response.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('returns access errors without calling runtime', async () => {
    const accessError = NextResponse.json({ error: 'Not found' }, { status: 404 });
    mockRequireProjectAccess.mockResolvedValue(accessError);
    mockIsAccessError.mockReturnValue(true);

    const response = await GET(makeRequest('/api/projects/project-1/billing/usage'), routeParams);

    expect(response.status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('returns 502 when the runtime request fails', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Runtime unavailable'));

    const response = await GET(makeRequest('/api/projects/project-1/billing/usage'), routeParams);
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({ error: 'Failed to proxy to runtime' });
  });
});

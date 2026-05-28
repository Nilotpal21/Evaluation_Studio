import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockRequireTenantAuth = vi.fn();
const mockIsAuthError = vi.fn();
vi.mock('@/lib/auth', () => ({
  requireTenantAuth: (...args: unknown[]) => mockRequireTenantAuth(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
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
    error: vi.fn(),
  }),
}));

const mockFetch = vi.fn();

const authenticatedUser = {
  id: 'user-1',
  email: 'user@example.com',
  tenantId: 'tenant-1',
};

function makeRequest(url: string, opts: Record<string, unknown> = {}) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    ...opts,
    headers: {
      Authorization: 'Bearer user-token',
      'X-Tenant-Id': 'spoofed-tenant',
      ...((opts.headers as Record<string, string>) || {}),
    },
  });
}

import { GET } from '@/app/api/runtime/sessions/[id]/attachments/route';

describe('Runtime session attachments proxy route', () => {
  const routeParams = {
    params: Promise.resolve({ id: 'session-1' }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    mockRequireTenantAuth.mockResolvedValue(authenticatedUser);
    mockIsAuthError.mockReturnValue(false);
    mockRequireProjectAccess.mockResolvedValue({
      project: { id: 'project-1', tenantId: 'tenant-1', ownerId: 'user-1' },
    });
    mockIsAccessError.mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('requires project access before proxying attachment readback', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            attachments: [{ id: 'att-1', filename: 'contract.pdf', mimeType: 'application/pdf' }],
            total: 1,
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    const response = await GET(
      makeRequest('/api/runtime/sessions/session-1/attachments?projectId=project-1&limit=5'),
      routeParams,
    );
    const body = await response.json();

    expect(mockRequireProjectAccess).toHaveBeenCalledWith('project-1', authenticatedUser);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3112/api/projects/project-1/sessions/session-1/attachments?limit=5&offset=0',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer user-token',
          'X-Tenant-Id': 'tenant-1',
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(body.data.attachments[0]).toMatchObject({
      id: 'att-1',
      mimeType: 'application/pdf',
    });
  });

  test('returns non-leaky project access errors without calling runtime', async () => {
    const notFound = NextResponse.json(
      { success: false, error: { code: 'NOT_FOUND', message: 'Not found' } },
      { status: 404 },
    );
    mockRequireProjectAccess.mockResolvedValue(notFound);
    mockIsAccessError.mockReturnValue(true);

    const response = await GET(
      makeRequest('/api/runtime/sessions/session-1/attachments?projectId=foreign-project'),
      routeParams,
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe('Not found');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

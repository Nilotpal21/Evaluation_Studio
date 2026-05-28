import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockRequireAuth = vi.fn();
const mockRequireTenantAuth = vi.fn();
const mockGetRequiredRuntimeUrl = vi.fn();
const mockFindSdkChannelByIdForTenant = vi.fn();
const mockRequireSdkProjectAccess = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  requireTenantAuth: (...args: unknown[]) => mockRequireTenantAuth(...args),
  isAuthError: (value: unknown) => value instanceof NextResponse,
}));

vi.mock('@/config/runtime.server', () => ({
  getRequiredRuntimeUrl: (...args: unknown[]) => mockGetRequiredRuntimeUrl(...args),
}));

vi.mock('@/repos/sdk-repo', () => ({
  findSdkChannelByIdForTenant: (...args: unknown[]) => mockFindSdkChannelByIdForTenant(...args),
}));

vi.mock('@/lib/sdk-project-access', () => ({
  requireSdkProjectAccess: (...args: unknown[]) => mockRequireSdkProjectAccess(...args),
  isSdkProjectAccessError: (value: unknown) => value instanceof NextResponse,
}));

import { resolveSdkRuntimeTenantChannelProxyContext } from '@/lib/sdk-runtime-channel-proxy';

describe('resolveSdkRuntimeTenantChannelProxyContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      tenantId: 'tenant-1',
      permissions: ['project:*'],
    });
    mockRequireTenantAuth.mockResolvedValue({
      id: 'user-1',
      tenantId: 'tenant-1',
      permissions: ['project:*'],
    });
    mockGetRequiredRuntimeUrl.mockReturnValue('https://runtime.example.test');
  });

  it('returns a concealed 404 when the channel is missing in the tenant', async () => {
    mockFindSdkChannelByIdForTenant.mockResolvedValue(null);

    const result = await resolveSdkRuntimeTenantChannelProxyContext(
      new NextRequest('http://localhost:3000/api/runtime/sdk-channels/channel-1'),
      'channel-1',
      'read',
    );

    expect(result).toBeInstanceOf(NextResponse);
    const response = result as NextResponse;
    expect(response.status).toBe(404);
    expect(mockRequireSdkProjectAccess).not.toHaveBeenCalled();

    const body = await response.json();
    expect(body).toEqual({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'SDK channel not found',
      },
    });
  });

  it('returns a concealed 404 when Studio project access is denied', async () => {
    mockFindSdkChannelByIdForTenant.mockResolvedValue({
      id: 'channel-1',
      projectId: 'project-1',
    });
    mockRequireSdkProjectAccess.mockResolvedValue(
      NextResponse.json({ error: 'Project not found' }, { status: 404 }),
    );

    const result = await resolveSdkRuntimeTenantChannelProxyContext(
      new NextRequest('http://localhost:3000/api/runtime/sdk-channels/channel-1'),
      'channel-1',
      'write',
    );

    expect(result).toBeInstanceOf(NextResponse);
    const response = result as NextResponse;
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body).toEqual({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'SDK channel not found',
      },
    });
  });

  it('returns Runtime tenant proxy context with project scope after Studio project access passes', async () => {
    mockFindSdkChannelByIdForTenant.mockResolvedValue({
      id: 'channel-1',
      projectId: 'project-1',
    });
    mockRequireSdkProjectAccess.mockResolvedValue({
      project: { id: 'project-1', tenantId: 'tenant-1' },
      accessLevel: 'project_owner',
    });

    const result = await resolveSdkRuntimeTenantChannelProxyContext(
      new NextRequest('http://localhost:3000/api/runtime/sdk-channels/channel-1'),
      'channel-1',
      'read',
    );

    expect(result).toEqual({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      runtimeUrl: 'https://runtime.example.test',
    });
  });
});

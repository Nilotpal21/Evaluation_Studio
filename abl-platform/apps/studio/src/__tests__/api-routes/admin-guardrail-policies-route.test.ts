import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockRequireTenantAuth = vi.fn();
const mockRequireAdminRole = vi.fn();
const mockRequireProjectPermission = vi.fn();
const mockFetch = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireTenantAuth: (...args: unknown[]) => mockRequireTenantAuth(...args),
  requireAdminRole: (...args: unknown[]) => mockRequireAdminRole(...args),
  isAuthError: (value: unknown) => value instanceof NextResponse,
}));

vi.mock('@/config/runtime.server', () => ({
  getRuntimeUrl: vi.fn(() => 'http://runtime.example'),
}));

vi.mock('@/lib/project-permission', () => ({
  requireProjectPermission: (...args: unknown[]) => mockRequireProjectPermission(...args),
  isProjectPermissionError: (value: unknown) => value instanceof NextResponse,
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { GET, POST } from '@/app/api/admin/guardrail-policies/route';

describe('/api/admin/guardrail-policies proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    mockRequireTenantAuth.mockResolvedValue({
      id: 'user-1',
      tenantId: 'tenant-1',
      permissions: ['guardrail:write'],
    });
    mockRequireAdminRole.mockResolvedValue(null);
    mockRequireProjectPermission.mockResolvedValue({
      project: { _id: 'project-1', tenantId: 'tenant-1' },
      accessLevel: 'project_member',
      role: 'developer',
      actorPermissions: [],
      customRolePermissions: [],
    });
    mockFetch.mockResolvedValue({
      status: 200,
      json: async () => ({
        success: true,
        data: [],
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forwards tenant-scoped GET requests to the runtime tenant route when projectId is omitted', async () => {
    const response = await GET(
      new NextRequest('http://localhost:3000/api/admin/guardrail-policies', {
        headers: {
          Authorization: 'Bearer test-token',
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(mockRequireAdminRole).toHaveBeenCalledWith('user-1', 'tenant-1');
    expect(mockRequireProjectPermission).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://runtime.example/api/guardrail-policies',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
          'X-Tenant-Id': 'tenant-1',
        }),
      }),
    );
  });

  it('forwards tenant-scoped POST requests to the runtime tenant route when projectId is omitted', async () => {
    const response = await POST(
      new NextRequest('http://localhost:3000/api/admin/guardrail-policies', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'tenant-policy',
          rules: [],
          settings: {
            failMode: 'open',
            timeouts: { local: 100, model: 3000, llm: 10000 },
            streaming: {
              enabled: false,
              defaultInterval: 'sentence',
              chunkSize: 1,
              maxLatencyMs: 500,
              earlyTermination: true,
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mockRequireAdminRole).toHaveBeenCalledWith('user-1', 'tenant-1');
    expect(mockRequireProjectPermission).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://runtime.example/api/guardrail-policies',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
          'X-Tenant-Id': 'tenant-1',
        }),
      }),
    );

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual(
      expect.objectContaining({
        name: 'tenant-policy',
      }),
    );
  });

  it('authorizes project-scoped GET requests through project guardrail read permission', async () => {
    const response = await GET(
      new NextRequest(
        'http://localhost:3000/api/admin/guardrail-policies?projectId=project-1&status=active',
        {
          headers: {
            Authorization: 'Bearer test-token',
          },
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(mockRequireAdminRole).not.toHaveBeenCalled();
    expect(mockRequireProjectPermission).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ id: 'user-1', tenantId: 'tenant-1' }),
      'guardrail:read',
    );
    expect(mockFetch).toHaveBeenCalledWith(
      'http://runtime.example/api/projects/project-1/guardrail-policies?status=active',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'X-Tenant-Id': 'tenant-1',
        }),
      }),
    );
  });

  it('authorizes project-scoped POST requests through project guardrail write permission', async () => {
    const response = await POST(
      new NextRequest('http://localhost:3000/api/admin/guardrail-policies?projectId=project-1', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'project-policy',
          rules: [],
          settings: {
            failMode: 'open',
            timeouts: { local: 100, model: 3000, llm: 10000 },
            streaming: {
              enabled: false,
              defaultInterval: 'sentence',
              chunkSize: 1,
              maxLatencyMs: 500,
              earlyTermination: true,
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mockRequireAdminRole).not.toHaveBeenCalled();
    expect(mockRequireProjectPermission).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ id: 'user-1', tenantId: 'tenant-1' }),
      'guardrail:write',
    );
    expect(mockFetch).toHaveBeenCalledWith(
      'http://runtime.example/api/projects/project-1/guardrail-policies',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'X-Tenant-Id': 'tenant-1',
        }),
      }),
    );
  });
});

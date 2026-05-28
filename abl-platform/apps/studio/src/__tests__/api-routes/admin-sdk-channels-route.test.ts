import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockRequireTenantAuth = vi.fn();
const mockRequireAdminRole = vi.fn();
const mockGetRequiredRuntimeUrl = vi.fn();
const mockFetch = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireTenantAuth: (...args: unknown[]) => mockRequireTenantAuth(...args),
  requireAdminRole: (...args: unknown[]) => mockRequireAdminRole(...args),
  isAuthError: (value: unknown) => value instanceof NextResponse,
}));

vi.mock('@/config/runtime.server', () => ({
  getRequiredRuntimeUrl: (...args: unknown[]) => mockGetRequiredRuntimeUrl(...args),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import {
  GET as AdminSdkChannelsGET,
  POST as AdminSdkChannelsPOST,
  PUT as AdminSdkChannelsPUT,
} from '@/app/api/admin/sdk-channels/route';

describe('GET /api/admin/sdk-channels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    mockRequireTenantAuth.mockResolvedValue({
      id: 'user-1',
      tenantId: 'tenant-1',
      permissions: ['tenant:admin'],
    });
    mockRequireAdminRole.mockResolvedValue(null);
    mockGetRequiredRuntimeUrl.mockReturnValue('https://runtime.example.test');
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('proxies tenant-scoped list requests through the configured Runtime URL', async () => {
    const response = await AdminSdkChannelsGET(
      new NextRequest('http://localhost:3000/api/admin/sdk-channels', {
        headers: { Authorization: 'Bearer tenant-admin-token' },
      }),
    );

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://runtime.example.test/api/tenants/tenant-1/sdk-channels',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer tenant-admin-token',
          'X-Tenant-Id': 'tenant-1',
        }),
      }),
    );
  });

  it('fails closed when the Runtime URL is not configured', async () => {
    mockGetRequiredRuntimeUrl.mockImplementationOnce(() => {
      throw new Error('Runtime URL must be configured explicitly');
    });

    const response = await AdminSdkChannelsGET(
      new NextRequest('http://localhost:3000/api/admin/sdk-channels'),
    );

    expect(response.status).toBe(500);
    expect(mockFetch).not.toHaveBeenCalled();

    const body = await response.json();
    expect(body).toEqual({
      success: false,
      error: {
        code: 'RUNTIME_CONFIG_REQUIRED',
        message: 'Runtime URL must be configured explicitly',
      },
    });
  });

  it('round-trips create payloads with runtime SDK-channel contract fields intact', async () => {
    const payload = {
      name: 'Support Widget',
      projectId: 'project-1',
      environment: 'production',
      enabled: true,
      rateLimitRpm: 180,
      allowedOrigins: ['https://widget.example.com'],
    };
    const runtimeResponse = {
      success: true,
      data: {
        id: 'channel-1',
        projectId: 'project-1',
        apiKey: 'pk_live_1234',
        publicApiKeyId: 'public-key-1',
        rateLimitRpm: 180,
        allowedOrigins: ['https://widget.example.com'],
      },
    };

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(runtimeResponse), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await AdminSdkChannelsPOST(
      new NextRequest('http://localhost:3000/api/admin/sdk-channels', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tenant-admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }),
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(mockFetch).toHaveBeenCalledWith(
      'https://runtime.example.test/api/tenants/tenant-1/sdk-channels',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(payload),
        headers: expect.objectContaining({
          Authorization: 'Bearer tenant-admin-token',
          'X-Tenant-Id': 'tenant-1',
        }),
      }),
    );
    expect(body).toEqual(runtimeResponse);
    expect(body.data.apiKey).toMatch(/^pk_/);
    expect(body.data.apiKey).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(body.data.rateLimitRpm).toBe(payload.rateLimitRpm);
    expect(body.data.allowedOrigins).toEqual(payload.allowedOrigins);
  });

  it('round-trips update payloads to the tenant detail route without dropping rate limits or allowed origins', async () => {
    const payload = {
      rateLimitRpm: 240,
      allowedOrigins: ['https://widget.example.com', 'https://admin.example.com'],
    };
    const runtimeResponse = {
      success: true,
      data: {
        id: 'channel-1',
        apiKey: 'pk_live_1234',
        rateLimitRpm: 240,
        allowedOrigins: ['https://widget.example.com', 'https://admin.example.com'],
      },
    };

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(runtimeResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await AdminSdkChannelsPUT(
      new NextRequest('http://localhost:3000/api/admin/sdk-channels?channelId=channel-1', {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer tenant-admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(mockFetch).toHaveBeenCalledWith(
      'https://runtime.example.test/api/tenants/tenant-1/sdk-channels/channel-1',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify(payload),
        headers: expect.objectContaining({
          Authorization: 'Bearer tenant-admin-token',
          'X-Tenant-Id': 'tenant-1',
        }),
      }),
    );
    expect(body).toEqual(runtimeResponse);
    expect(body.data.rateLimitRpm).toBe(payload.rateLimitRpm);
    expect(body.data.allowedOrigins).toEqual(payload.allowedOrigins);
    expect(body.data.apiKey).toMatch(/^pk_/);
  });
});

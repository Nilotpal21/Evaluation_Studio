import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockFetch = vi.fn();
const mockBuildRuntimeProxyHeaders = vi.fn();
const mockResolveSdkRuntimeTenantChannelProxyContext = vi.fn();
const mockUpsertWidgetConfig = vi.fn();

vi.mock('@/lib/runtime-proxy', () => ({
  buildRuntimeProxyHeaders: (...args: unknown[]) => mockBuildRuntimeProxyHeaders(...args),
}));

vi.mock('@/lib/sdk-runtime-channel-proxy', () => ({
  resolveSdkRuntimeTenantChannelProxyContext: (...args: unknown[]) =>
    mockResolveSdkRuntimeTenantChannelProxyContext(...args),
}));

vi.mock('@/lib/safe-proxy', () => ({
  safeJsonParse: async (response: Response) => ({
    data: await response.json(),
  }),
}));

vi.mock('@/repos/sdk-repo', () => ({
  upsertWidgetConfig: (...args: unknown[]) => mockUpsertWidgetConfig(...args),
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
  DELETE as RuntimeSdkChannelDELETE,
  GET as RuntimeSdkChannelGET,
  PATCH as RuntimeSdkChannelPATCH,
} from '@/app/api/runtime/sdk-channels/[channelId]/route';

const channelId = 'channel-1';
const runtimeChannelUrl = `https://runtime.example.test/api/tenants/tenant-1/sdk-channels/${channelId}`;

describe('/api/runtime/sdk-channels/:channelId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    mockBuildRuntimeProxyHeaders.mockReturnValue({
      Authorization: 'Bearer studio-user-token',
      'Content-Type': 'application/json',
      'X-Tenant-Id': 'tenant-1',
    });
    mockResolveSdkRuntimeTenantChannelProxyContext.mockResolvedValue({
      runtimeUrl: 'https://runtime.example.test',
      tenantId: 'tenant-1',
      projectId: 'project-1',
    });
    mockUpsertWidgetConfig.mockResolvedValue({
      channelId,
      mode: 'unified',
      position: 'bottom-left',
      welcomeMessage: 'Welcome',
      placeholderText: 'Type here',
      voiceEnabled: true,
      chatEnabled: true,
      theme: {},
    });
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          channel: { id: 'channel-1', name: 'Customer Web' },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('proxies reads through the tenant-scoped runtime SDK channel route', async () => {
    const response = await RuntimeSdkChannelGET(
      new NextRequest(`http://localhost:3000/api/runtime/sdk-channels/${channelId}`, {
        method: 'GET',
        headers: {
          Authorization: 'Bearer studio-user-token',
        },
      }),
      { params: Promise.resolve({ channelId }) },
    );

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      runtimeChannelUrl,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer studio-user-token',
          'X-Tenant-Id': 'tenant-1',
        }),
      }),
    );
  });

  it('proxies mutations through the tenant-scoped runtime SDK channel route', async () => {
    const response = await RuntimeSdkChannelPATCH(
      new NextRequest(`http://localhost:3000/api/runtime/sdk-channels/${channelId}`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer studio-user-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Customer Web' }),
      }),
      { params: Promise.resolve({ channelId: 'channel-1' }) },
    );

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      runtimeChannelUrl,
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({
          Authorization: 'Bearer studio-user-token',
          'X-Tenant-Id': 'tenant-1',
        }),
        body: JSON.stringify({ name: 'Customer Web' }),
      }),
    );

    const body = await response.json();
    expect(body).toEqual({
      success: true,
      channel: { id: channelId, name: 'Customer Web' },
    });
  });

  it('syncs SDK channel widget fields into the widget config store after mutations', async () => {
    const response = await RuntimeSdkChannelPATCH(
      new NextRequest(`http://localhost:3000/api/runtime/sdk-channels/${channelId}`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer studio-user-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          config: {
            mode: 'unified',
            position: 'bottom-left',
            chatEnabled: true,
            voiceEnabled: true,
            welcomeMessage: 'Welcome',
            placeholderText: 'Type here',
            showActivityUpdates: true,
          },
        }),
      }),
      { params: Promise.resolve({ channelId }) },
    );

    expect(response.status).toBe(200);
    expect(mockUpsertWidgetConfig).toHaveBeenCalledWith('project-1', 'tenant-1', {
      update: {
        channelId,
        mode: 'unified',
        position: 'bottom-left',
        chatEnabled: true,
        voiceEnabled: true,
        welcomeMessage: 'Welcome',
        placeholderText: 'Type here',
      },
      create: {
        channelId,
        mode: 'unified',
        position: 'bottom-left',
        chatEnabled: true,
        voiceEnabled: true,
        welcomeMessage: 'Welcome',
        placeholderText: 'Type here',
        theme: {},
      },
    });
  });

  it('proxies deletes through the tenant-scoped runtime SDK channel route', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await RuntimeSdkChannelDELETE(
      new NextRequest(`http://localhost:3000/api/runtime/sdk-channels/${channelId}`, {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer studio-user-token',
        },
      }),
      { params: Promise.resolve({ channelId }) },
    );

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      runtimeChannelUrl,
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          Authorization: 'Bearer studio-user-token',
          'X-Tenant-Id': 'tenant-1',
        }),
      }),
    );

    const body = await response.json();
    expect(body).toEqual({
      success: true,
    });
  });

  it('passes through concealed not-found responses from project access resolution', async () => {
    mockResolveSdkRuntimeTenantChannelProxyContext.mockResolvedValueOnce(
      NextResponse.json(
        {
          success: false,
          error: { code: 'NOT_FOUND', message: 'SDK channel not found' },
        },
        { status: 404 },
      ),
    );

    const response = await RuntimeSdkChannelPATCH(
      new NextRequest(`http://localhost:3000/api/runtime/sdk-channels/${channelId}`, {
        method: 'PATCH',
      }),
      { params: Promise.resolve({ channelId }) },
    );

    expect(response.status).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// @vitest-environment node

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fetchMock = vi.fn();

vi.mock('@/config/runtime.server', () => ({
  getRequiredRuntimeUrl: () => 'https://runtime.example.test',
}));

describe('runtime-sdk-session scope validation', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  test('accepts runtime bootstrap exchanges whose scope matches the expected tenant/project/channel', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        token: 'sdk-token',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        channelId: 'channel-1',
        permissions: ['session:send_message', 'session:read'],
        showActivityUpdates: false,
        expiresIn: 14_400,
      }),
    } as Response);

    const { exchangeSdkBootstrapArtifactWithRuntime } = await import('@/lib/runtime-sdk-session');
    const result = await exchangeSdkBootstrapArtifactWithRuntime('bootstrap-token', {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      channelId: 'channel-1',
      permissions: ['session:send_message', 'session:read'],
    });

    expect(result).toEqual({
      success: true,
      data: {
        token: 'sdk-token',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        channelId: 'channel-1',
        permissions: ['session:send_message', 'session:read'],
        showActivityUpdates: false,
        expiresIn: 14_400,
      },
    });
  });

  test('accepts runtime bootstrap exchanges when runtime adds derived session:read to interactive permissions', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        token: 'sdk-token',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        channelId: 'channel-1',
        permissions: ['session:send_message', 'session:read'],
        showActivityUpdates: false,
        expiresIn: 14_400,
      }),
    } as Response);

    const { exchangeSdkBootstrapArtifactWithRuntime } = await import('@/lib/runtime-sdk-session');
    const result = await exchangeSdkBootstrapArtifactWithRuntime('bootstrap-token', {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      channelId: 'channel-1',
      permissions: ['session:send_message'],
    });

    expect(result).toEqual({
      success: true,
      data: {
        token: 'sdk-token',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        channelId: 'channel-1',
        permissions: ['session:send_message', 'session:read'],
        showActivityUpdates: false,
        expiresIn: 14_400,
      },
    });
  });

  test('rejects runtime bootstrap exchanges whose channel scope does not match the expected channel', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        token: 'sdk-token',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        channelId: 'channel-2',
        permissions: ['session:send_message'],
        showActivityUpdates: false,
        expiresIn: 14_400,
      }),
    } as Response);

    const { exchangeSdkBootstrapArtifactWithRuntime } = await import('@/lib/runtime-sdk-session');
    const result = await exchangeSdkBootstrapArtifactWithRuntime('bootstrap-token', {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      channelId: 'channel-1',
      permissions: ['session:send_message'],
    });

    expect(result).toEqual({
      success: false,
      status: 502,
      body: {
        error: 'Runtime SDK session scope mismatch',
      },
    });
  });

  test('rejects runtime bootstrap exchanges whose permissions do not match the expected permission set', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        token: 'sdk-token',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        channelId: 'channel-1',
        permissions: ['session:voice'],
        showActivityUpdates: false,
        expiresIn: 14_400,
      }),
    } as Response);

    const { exchangeSdkBootstrapArtifactWithRuntime } = await import('@/lib/runtime-sdk-session');
    const result = await exchangeSdkBootstrapArtifactWithRuntime('bootstrap-token', {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      channelId: 'channel-1',
      permissions: ['session:send_message'],
    });

    expect(result).toEqual({
      success: false,
      status: 502,
      body: {
        error: 'Runtime SDK session permissions mismatch',
      },
    });
  });

  test('rejects runtime bootstrap exchanges whose permissions expand beyond the derived interactive read scope', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        token: 'sdk-token',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        channelId: 'channel-1',
        permissions: ['attachment:write', 'session:send_message', 'session:read'],
        showActivityUpdates: false,
        expiresIn: 14_400,
      }),
    } as Response);

    const { exchangeSdkBootstrapArtifactWithRuntime } = await import('@/lib/runtime-sdk-session');
    const result = await exchangeSdkBootstrapArtifactWithRuntime('bootstrap-token', {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      channelId: 'channel-1',
      permissions: ['session:send_message'],
    });

    expect(result).toEqual({
      success: false,
      status: 502,
      body: {
        error: 'Runtime SDK session permissions mismatch',
      },
    });
  });

  test('rejects runtime bootstrap exchanges whose permissions array contains non-string entries', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        token: 'sdk-token',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        channelId: 'channel-1',
        permissions: ['session:send_message', 42],
        showActivityUpdates: false,
        expiresIn: 14_400,
      }),
    } as Response);

    const { exchangeSdkBootstrapArtifactWithRuntime } = await import('@/lib/runtime-sdk-session');
    const result = await exchangeSdkBootstrapArtifactWithRuntime('bootstrap-token');

    expect(result).toEqual({
      success: false,
      status: 502,
      body: {
        error: 'Invalid runtime response',
      },
    });
  });

  test('rejects runtime bootstrap exchanges whose optional deploymentId is not a string', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        token: 'sdk-token',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        deploymentId: 123,
        channelId: 'channel-1',
        permissions: ['session:send_message'],
        showActivityUpdates: false,
        expiresIn: 14_400,
      }),
    } as Response);

    const { exchangeSdkBootstrapArtifactWithRuntime } = await import('@/lib/runtime-sdk-session');
    const result = await exchangeSdkBootstrapArtifactWithRuntime('bootstrap-token');

    expect(result).toEqual({
      success: false,
      status: 502,
      body: {
        error: 'Invalid runtime response',
      },
    });
  });
});

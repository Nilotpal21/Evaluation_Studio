import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TokenManager } from '../core/TokenManager.js';
import type { SDKBootstrapTokenConfig, SDKPublicKeyConfig } from '../core/types.js';

interface SdkSessionResponsePayload {
  token: string;
  expiresIn: number;
  tenantId: string;
  projectId: string;
  deploymentId?: string;
  channelId: string;
  permissions: string[];
  showActivityUpdates: boolean;
}

function createConfig(overrides: Partial<SDKPublicKeyConfig> = {}): SDKPublicKeyConfig {
  return {
    projectId: 'project-1',
    apiKey: 'pk_test',
    endpoint: 'https://runtime.example.com',
    ...overrides,
  };
}

function createSdkSessionPayload(
  overrides: Partial<SdkSessionResponsePayload> = {},
): SdkSessionResponsePayload {
  return {
    token: 'sdk_token_1',
    expiresIn: 300,
    tenantId: 'tenant-1',
    projectId: 'project-1',
    channelId: 'channel-1',
    permissions: ['session:send_message'],
    showActivityUpdates: false,
    ...overrides,
  };
}

function createSdkSessionResponse(payload: unknown): Response {
  return {
    ok: true,
    json: async () => payload,
    text: async () => '',
  } as Response;
}

function createBootstrapConfig(
  overrides: Partial<SDKBootstrapTokenConfig> = {},
): SDKBootstrapTokenConfig {
  return {
    projectId: 'project-1',
    bootstrapToken: 'boot_test',
    endpoint: 'https://runtime.example.com',
    ...overrides,
  };
}

describe('TokenManager SDK token contract', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test.each(['tenantId', 'projectId', 'channelId'] as const)(
    'rejects init responses missing %s',
    async (missingField) => {
      const fetchMock = vi.mocked(fetch);
      const payload = { ...createSdkSessionPayload() } as Record<string, unknown>;
      delete payload[missingField];
      fetchMock.mockResolvedValueOnce(createSdkSessionResponse(payload));

      const manager = new TokenManager(createConfig());

      await expect(manager.getToken()).rejects.toThrow(
        'SDK init failed: Runtime must return tenantId, projectId, and channelId.',
      );
      expect(manager.getScope()).toBeNull();
    },
  );

  test('rejects init responses with an empty permissions array', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      createSdkSessionResponse(createSdkSessionPayload({ permissions: [] })),
    );

    const manager = new TokenManager(createConfig());

    await expect(manager.getToken()).rejects.toThrow(
      'SDK init failed: Runtime must return a non-empty permissions array.',
    );
    expect(manager.getScope()).toBeNull();
  });

  test('rejects init responses missing showActivityUpdates', async () => {
    const fetchMock = vi.mocked(fetch);
    const payload = { ...createSdkSessionPayload() } as Record<string, unknown>;
    delete payload.showActivityUpdates;
    fetchMock.mockResolvedValueOnce(createSdkSessionResponse(payload));

    const manager = new TokenManager(createConfig());

    await expect(manager.getToken()).rejects.toThrow(
      'SDK init failed: Runtime must return showActivityUpdates.',
    );
    expect(manager.getScope()).toBeNull();
  });

  test.each(['tenantId', 'projectId', 'channelId'] as const)(
    'rejects refresh responses missing %s',
    async (missingField) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-22T00:00:00.000Z'));

      const fetchMock = vi.mocked(fetch);
      const refreshPayload = {
        ...createSdkSessionPayload({ token: 'sdk_token_2' }),
      } as Record<string, unknown>;
      delete refreshPayload[missingField];
      fetchMock
        .mockResolvedValueOnce(createSdkSessionResponse(createSdkSessionPayload()))
        .mockResolvedValueOnce(createSdkSessionResponse(refreshPayload));

      const manager = new TokenManager(createConfig());

      await expect(manager.getToken()).resolves.toBe('sdk_token_1');
      expect(manager.getScope()).toEqual({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        channelId: 'channel-1',
        deploymentId: undefined,
        permissions: ['session:send_message'],
        showActivityUpdates: false,
      });

      vi.setSystemTime(new Date('2026-03-22T00:04:01.000Z'));

      await expect(manager.getToken()).rejects.toThrow(
        'SDK token refresh failed: Runtime must return tenantId, projectId, and channelId.',
      );
      expect(manager.getScope()).toBeNull();
    },
  );

  test('rejects refresh responses with an empty permissions array', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-22T00:00:00.000Z'));

    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(createSdkSessionResponse(createSdkSessionPayload()))
      .mockResolvedValueOnce(
        createSdkSessionResponse(
          createSdkSessionPayload({ token: 'sdk_token_2', permissions: [] }),
        ),
      );

    const manager = new TokenManager(createConfig());

    await expect(manager.getToken()).resolves.toBe('sdk_token_1');

    vi.setSystemTime(new Date('2026-03-22T00:04:01.000Z'));

    await expect(manager.getToken()).rejects.toThrow(
      'SDK token refresh failed: Runtime must return a non-empty permissions array.',
    );
    expect(manager.getScope()).toBeNull();
  });

  test('rejects refresh responses that drift SDK scope', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-22T00:00:00.000Z'));

    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(createSdkSessionResponse(createSdkSessionPayload()))
      .mockResolvedValueOnce(
        createSdkSessionResponse(
          createSdkSessionPayload({
            token: 'sdk_token_2',
            channelId: 'channel-2',
          }),
        ),
      );

    const manager = new TokenManager(createConfig());

    await expect(manager.getToken()).resolves.toBe('sdk_token_1');

    vi.setSystemTime(new Date('2026-03-22T00:04:01.000Z'));

    await expect(manager.getToken()).rejects.toThrow(
      'Runtime changed SDK session scope during refresh. Re-initialize the SDK session.',
    );
    expect(manager.getScope()).toBeNull();
  });

  test('rejects init responses for a different project than the SDK config', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      createSdkSessionResponse(
        createSdkSessionPayload({
          projectId: 'project-2',
        }),
      ),
    );

    const manager = new TokenManager(createConfig({ projectId: 'project-1' }));

    await expect(manager.getToken()).rejects.toThrow(
      'Runtime returned an SDK session for a different project than the SDK config.',
    );
    expect(manager.getScope()).toBeNull();
  });

  test('prefers channelId over channelName in sdk init requests', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(createSdkSessionResponse(createSdkSessionPayload()));

    const manager = new TokenManager(
      createConfig({
        channelId: 'channel-stable-1',
        channelName: 'mutable-channel-name',
      }),
    );

    await expect(manager.getToken()).resolves.toBe('sdk_token_1');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const initRequest = fetchMock.mock.calls[0]?.[1];
    expect(initRequest?.body).toBeDefined();
    expect(JSON.parse(String(initRequest?.body))).toEqual({
      channelId: 'channel-stable-1',
    });
  });

  test('sends bootstrapToken init requests without X-Public-Key', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(createSdkSessionResponse(createSdkSessionPayload()));

    const manager = new TokenManager(createBootstrapConfig());

    await expect(manager.getToken()).resolves.toBe('sdk_token_1');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const initRequest = fetchMock.mock.calls[0]?.[1];
    expect(initRequest?.headers).toEqual({
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(initRequest?.body))).toEqual({
      bootstrapToken: 'boot_test',
    });
  });
});

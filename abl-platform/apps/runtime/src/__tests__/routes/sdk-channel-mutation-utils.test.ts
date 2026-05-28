import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreatePublicApiKey = vi.fn();
const mockDeletePublicApiKey = vi.fn();
const mockDeleteSDKChannel = vi.fn();
const mockFindPublicApiKey = vi.fn();
const mockFindPublicApiKeys = vi.fn();
const mockFindSDKChannelsByPublicApiKeyId = vi.fn();
const mockUpdatePublicApiKey = vi.fn();
const mockUpdateSDKChannel = vi.fn();

vi.mock('../../repos/channel-repo.js', () => ({
  createPublicApiKey: (...args: unknown[]) => mockCreatePublicApiKey(...args),
  deletePublicApiKey: (...args: unknown[]) => mockDeletePublicApiKey(...args),
  deleteSDKChannel: (...args: unknown[]) => mockDeleteSDKChannel(...args),
  findPublicApiKey: (...args: unknown[]) => mockFindPublicApiKey(...args),
  findPublicApiKeys: (...args: unknown[]) => mockFindPublicApiKeys(...args),
  findPublicApiKeysByIds: vi.fn().mockResolvedValue([]),
  findSDKChannelsByPublicApiKeyId: (...args: unknown[]) =>
    mockFindSDKChannelsByPublicApiKeyId(...args),
  SDKChannelProjectScopeError: class SDKChannelProjectScopeError extends Error {},
  SDKChannelPublicApiKeyScopeError: class SDKChannelPublicApiKeyScopeError extends Error {},
  updatePublicApiKey: (...args: unknown[]) => mockUpdatePublicApiKey(...args),
  updateSDKChannel: (...args: unknown[]) => mockUpdateSDKChannel(...args),
}));

vi.mock('../../repos/deployment-repo.js', () => ({
  findActiveDeployment: vi.fn(),
  findDeploymentById: vi.fn(),
}));

import {
  cleanupFailedSdkChannelCreate,
  ensureDedicatedPublicApiKeyForAllowedOrigins,
  parseAllowedOriginsUpdate,
  prepareSdkChannelCreateInput,
  prepareSdkChannelUpdateInput,
  rollbackFailedSdkChannelUpdate,
} from '../../routes/sdk-channel-mutation-utils.js';

describe('sdk-channel-mutation-utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindPublicApiKeys.mockResolvedValue([]);
    mockFindSDKChannelsByPublicApiKeyId.mockResolvedValue([]);
    mockUpdatePublicApiKey.mockResolvedValue({ id: 'key-1' });
    mockDeleteSDKChannel.mockResolvedValue(true);
    mockDeletePublicApiKey.mockResolvedValue(true);
    mockUpdateSDKChannel.mockResolvedValue({ id: 'channel-1' });
  });

  it('accepts wildcard allowed origins while still rejecting non-http protocols', () => {
    expect(
      parseAllowedOriginsUpdate({
        allowedOrigins: ['https://*.example.com'],
      }),
    ).toEqual({
      ok: true,
      value: ['https://*.example.com'],
    });

    expect(
      parseAllowedOriginsUpdate({
        allowedOrigins: ['javascript:alert(1)'],
      }),
    ).toEqual({
      ok: false,
      error: {
        statusCode: 400,
        code: 'INVALID_ALLOWED_ORIGINS',
        message: 'allowedOrigins must be an array of valid URLs or null',
      },
    });
  });

  it('clones a shared public API key before channel-scoped origin edits', async () => {
    mockFindSDKChannelsByPublicApiKeyId.mockResolvedValue([
      { id: 'channel-1' },
      { id: 'channel-2' },
    ]);
    mockFindPublicApiKey.mockResolvedValue({
      id: 'key-1',
      projectId: 'project-1',
      tenantId: 'tenant-1',
      name: 'Default SDK Key',
      allowedOrigins: ['https://old.example.com'],
      permissions: JSON.stringify({ chat: true, voice: false }),
      expiresAt: null,
      isActive: true,
    });
    mockCreatePublicApiKey.mockResolvedValue({ id: 'key-2' });

    await expect(
      ensureDedicatedPublicApiKeyForAllowedOrigins(
        {
          id: 'channel-1',
          name: 'Support Widget',
          projectId: 'project-1',
          publicApiKeyId: 'key-1',
        },
        'tenant-1',
      ),
    ).resolves.toEqual({
      publicApiKeyId: 'key-2',
      createdPublicApiKeyId: 'key-2',
    });

    expect(mockCreatePublicApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        tenantId: 'tenant-1',
        name: 'Support Widget SDK Key',
        allowedOrigins: ['https://old.example.com'],
        permissions: { chat: true, voice: false },
        expiresAt: null,
        isActive: true,
      }),
    );
  });

  it('reuses the current public API key when the channel is already isolated', async () => {
    mockFindSDKChannelsByPublicApiKeyId.mockResolvedValue([{ id: 'channel-1' }]);

    await expect(
      ensureDedicatedPublicApiKeyForAllowedOrigins(
        {
          id: 'channel-1',
          name: 'Support Widget',
          projectId: 'project-1',
          publicApiKeyId: 'key-1',
        },
        'tenant-1',
      ),
    ).resolves.toEqual({
      publicApiKeyId: 'key-1',
    });

    expect(mockCreatePublicApiKey).not.toHaveBeenCalled();
  });

  it('rejects invalid SDK token envelope policy on channel create', async () => {
    mockFindPublicApiKey.mockResolvedValue({
      id: 'key-1',
      projectId: 'project-1',
      tenantId: 'tenant-1',
      isActive: true,
    });

    await expect(
      prepareSdkChannelCreateInput({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        body: {
          name: 'Support Widget',
          channelType: 'web',
          publicApiKeyId: 'key-1',
          auth: { mode: 'hosted_exchange' },
          config: { sdkTokenEnvelopePolicy: 'jweRequired' },
        },
        allowImplicitDefaultPublicKey: false,
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        statusCode: 400,
        code: 'INVALID_SDK_TOKEN_ENVELOPE_POLICY',
        message:
          'config.sdkTokenEnvelopePolicy must be one of: inherit, signed, jwe_preferred, jwe_required',
      },
    });
  });

  it('rejects SDK token envelope policy on anonymous channel create', async () => {
    mockFindPublicApiKey.mockResolvedValue({
      id: 'key-1',
      projectId: 'project-1',
      tenantId: 'tenant-1',
      isActive: true,
    });

    await expect(
      prepareSdkChannelCreateInput({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        body: {
          name: 'Support Widget',
          channelType: 'web',
          publicApiKeyId: 'key-1',
          config: { sdkTokenEnvelopePolicy: 'jwe_required' },
        },
        allowImplicitDefaultPublicKey: false,
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        statusCode: 400,
        code: 'INVALID_SDK_TOKEN_ENVELOPE_POLICY_AUTH_MODE',
        message: 'config.sdkTokenEnvelopePolicy requires auth.mode=hosted_exchange',
      },
    });
  });

  it('accepts explicit SDK token envelope policy on channel update', async () => {
    const result = await prepareSdkChannelUpdateInput({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      body: {
        config: { sdkTokenEnvelopePolicy: 'jwe_required', custom: 'kept' },
      },
      existing: {
        config: { rateLimitRpm: 100 },
        authMode: 'hosted_exchange',
        serverSecretHash: 'hash',
        serverSecretSalt: 'salt',
        serverSecretPrefix: 'prefix',
      },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        updates: {
          config: JSON.stringify({ sdkTokenEnvelopePolicy: 'jwe_required', custom: 'kept' }),
        },
      },
    });
  });

  it('allows SDK token envelope policy when the same update enables hosted_exchange auth', async () => {
    const result = await prepareSdkChannelUpdateInput({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      body: {
        auth: { mode: 'hosted_exchange' },
        config: { sdkTokenEnvelopePolicy: 'jwe_required' },
      },
      existing: {
        config: {},
        authMode: 'anonymous',
        serverSecretHash: null,
        serverSecretSalt: null,
        serverSecretPrefix: null,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.value.updates).toEqual(
      expect.objectContaining({
        authMode: 'hosted_exchange',
        config: JSON.stringify({ sdkTokenEnvelopePolicy: 'jwe_required' }),
        serverSecretHash: expect.any(String),
        serverSecretSalt: expect.any(String),
        serverSecretPrefix: expect.any(String),
        serverSecretLastRotatedAt: expect.any(Date),
      }),
    );
    expect(result.value.generatedServerSecret).toEqual(expect.any(String));
  });

  it('rejects SDK token envelope policy when the same update switches to anonymous auth', async () => {
    await expect(
      prepareSdkChannelUpdateInput({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        body: {
          auth: { mode: 'anonymous' },
          config: { sdkTokenEnvelopePolicy: 'jwe_required' },
        },
        existing: {
          config: {},
          authMode: 'hosted_exchange',
          serverSecretHash: 'hash',
          serverSecretSalt: 'salt',
          serverSecretPrefix: 'prefix',
        },
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        statusCode: 400,
        code: 'INVALID_SDK_TOKEN_ENVELOPE_POLICY_AUTH_MODE',
        message: 'config.sdkTokenEnvelopePolicy requires auth.mode=hosted_exchange',
      },
    });
  });

  it('scrubs existing SDK token envelope policy when switching to anonymous auth', async () => {
    const result = await prepareSdkChannelUpdateInput({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      body: {
        auth: { mode: 'anonymous' },
      },
      existing: {
        config: { sdkTokenEnvelopePolicy: 'jwe_required', custom: 'kept' },
        authMode: 'hosted_exchange',
        serverSecretHash: 'hash',
        serverSecretSalt: 'salt',
        serverSecretPrefix: 'prefix',
      },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        updates: {
          authMode: 'anonymous',
          config: JSON.stringify({ custom: 'kept' }),
          serverSecretHash: null,
          serverSecretSalt: null,
          serverSecretPrefix: null,
          serverSecretLastRotatedAt: null,
        },
      },
    });
  });

  it('allows unrelated rate limit edits when legacy config has an invalid SDK token envelope policy', async () => {
    const result = await prepareSdkChannelUpdateInput({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      body: {
        rateLimitRpm: 60,
      },
      existing: {
        config: { sdkTokenEnvelopePolicy: 'encrypted', custom: 'legacy' },
        authMode: 'hosted_exchange',
        serverSecretHash: 'hash',
        serverSecretSalt: 'salt',
        serverSecretPrefix: 'prefix',
      },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        updates: {
          config: JSON.stringify({
            sdkTokenEnvelopePolicy: 'encrypted',
            custom: 'legacy',
            rateLimitRpm: 60,
          }),
        },
      },
    });
  });

  it('cleans up the persisted channel before deleting a newly created key on create rollback', async () => {
    await cleanupFailedSdkChannelCreate({
      projectId: 'project-1',
      tenantId: 'tenant-1',
      channelId: 'channel-1',
      createdPublicApiKeyId: 'key-2',
    });

    expect(mockDeleteSDKChannel).toHaveBeenCalledWith('channel-1', 'project-1', 'tenant-1');
    expect(mockDeletePublicApiKey).toHaveBeenCalledWith('key-2', 'project-1', 'tenant-1');
    expect(mockDeleteSDKChannel.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeletePublicApiKey.mock.invocationCallOrder[0],
    );
  });

  it('restores the previous channel document before removing a temporary cloned key on update rollback', async () => {
    await rollbackFailedSdkChannelUpdate({
      existing: {
        id: 'channel-1',
        projectId: 'project-1',
        name: 'Support Widget',
        publicApiKeyId: 'key-1',
        deploymentId: null,
        config: { mode: 'chat' },
        isActive: true,
        environment: null,
        followEnvironment: true,
        authMode: 'anonymous',
      },
      tenantId: 'tenant-1',
      updatePersisted: true,
      createdPublicApiKeyId: 'key-2',
    });

    expect(mockUpdateSDKChannel).toHaveBeenCalledWith(
      'channel-1',
      'project-1',
      'tenant-1',
      expect.objectContaining({
        name: 'Support Widget',
        publicApiKeyId: 'key-1',
        deploymentId: null,
        config: { mode: 'chat' },
        isActive: true,
        environment: null,
        followEnvironment: true,
        authMode: 'anonymous',
      }),
    );
    expect(mockDeletePublicApiKey).toHaveBeenCalledWith('key-2', 'project-1', 'tenant-1');
    expect(mockUpdateSDKChannel.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeletePublicApiKey.mock.invocationCallOrder[0],
    );
  });
});

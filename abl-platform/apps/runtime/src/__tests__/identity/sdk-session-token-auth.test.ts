import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SDKSessionTokenPayload } from '@agent-platform/shared-auth';

const mockFindSDKChannelById = vi.fn();
const mockFindPublicApiKey = vi.fn();
const mockFindWidgetConfig = vi.fn();
const mockUpdateSDKChannel = vi.fn();
const mockFindDeploymentById = vi.fn();
const mockFindActiveDeployment = vi.fn();
const mockVerifyRuntimeSdkSessionToken = vi.fn();
const mockResolveRuntimeSdkTokenEnvelopePolicy = vi.fn();

vi.mock('../../repos/channel-repo.js', () => ({
  findPublicApiKey: (...args: unknown[]) => mockFindPublicApiKey(...args),
  findSDKChannelById: (...args: unknown[]) => mockFindSDKChannelById(...args),
  findWidgetConfig: (...args: unknown[]) => mockFindWidgetConfig(...args),
  updateSDKChannel: (...args: unknown[]) => mockUpdateSDKChannel(...args),
}));

vi.mock('../../repos/deployment-repo.js', () => ({
  findActiveDeployment: (...args: unknown[]) => mockFindActiveDeployment(...args),
  findDeploymentById: (...args: unknown[]) => mockFindDeploymentById(...args),
}));

vi.mock('../../services/identity/sdk-jwe-runtime-config.js', () => ({
  getRuntimeSdkTokenEnvelopeDeps: () => ({
    maxEncryptedSessionBytes: 4096,
  }),
}));

vi.mock('../../services/identity/sdk-token-envelope-runtime.js', () => ({
  verifyRuntimeSdkSessionToken: (...args: unknown[]) => mockVerifyRuntimeSdkSessionToken(...args),
}));

vi.mock('../../services/identity/sdk-token-envelope-runtime-policy.js', () => ({
  resolveRuntimeSdkTokenEnvelopePolicy: (...args: unknown[]) =>
    mockResolveRuntimeSdkTokenEnvelopePolicy(...args),
}));

import {
  authorizeRuntimeSdkSessionPayloadForAuth,
  verifyRuntimeSdkSessionForAuth,
} from '../../services/identity/sdk-session-token-auth.js';

function makeCustomerSessionPayload(): SDKSessionTokenPayload {
  return {
    type: 'sdk_session',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    channelId: 'channel-1',
    sessionId: 'session-1',
    sessionPrincipal: 'session-1',
    permissions: ['session:read', 'session:send_message'],
    bootstrapType: 'customer',
    verifiedUserId: 'verified-user-1',
    identityTier: 2,
    verificationMethod: 'hosted_exchange',
    authScope: 'user',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
  };
}

function makePublicKeySessionPayload(): SDKSessionTokenPayload {
  return {
    type: 'sdk_session',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    channelId: 'channel-1',
    sessionId: 'session-1',
    sessionPrincipal: 'session-1',
    permissions: ['session:read', 'session:send_message'],
    bootstrapType: 'public_key',
    bootstrapKeyId: 'pk-1',
    identityTier: 0,
    verificationMethod: 'none',
    authScope: 'session',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
  };
}

describe('verifyRuntimeSdkSessionForAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindSDKChannelById.mockResolvedValue({
      id: 'channel-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      authMode: 'hosted_exchange',
      isActive: true,
      config: {},
      publicApiKeyId: 'pk-1',
      deploymentId: 'deploy-current',
      environment: 'production',
      followEnvironment: true,
    });
    mockFindPublicApiKey.mockResolvedValue({
      id: 'pk-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      isActive: true,
      permissions: { chat: true, voice: false },
    });
    mockFindWidgetConfig.mockResolvedValue({ chatEnabled: true, voiceEnabled: false });
    mockFindDeploymentById.mockResolvedValue({
      id: 'deploy-current',
      status: 'active',
      environment: 'production',
    });
    mockFindActiveDeployment.mockResolvedValue(null);
    mockUpdateSDKChannel.mockImplementation(async (_id, _projectId, _tenantId, data) => ({
      id: 'channel-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      isActive: true,
      publicApiKeyId: 'pk-1',
      deploymentId: data.deploymentId,
      environment: 'production',
      followEnvironment: true,
      config: {},
    }));
  });

  it('rejects an already-issued signed hosted_exchange session after live policy changes to jwe_required', async () => {
    mockVerifyRuntimeSdkSessionToken.mockResolvedValue({
      success: true,
      envelope: 'signed',
      data: makeCustomerSessionPayload(),
    });
    mockResolveRuntimeSdkTokenEnvelopePolicy.mockResolvedValue({
      policyMode: 'jwe_required',
      bootstrapMode: 'jwe',
      sessionMode: 'jwe',
      requiresEncryptedBootstrap: true,
      requiresEncryptedSession: true,
      acceptsSignedBootstrap: false,
      acceptsSignedSession: false,
      acceptsJweBootstrap: true,
      acceptsJweSession: true,
      canIssueBootstrap: true,
      canIssueSession: true,
      reason: 'strict_required',
    });

    await expect(verifyRuntimeSdkSessionForAuth('signed.session.token')).resolves.toEqual({
      success: false,
      status: 401,
      code: 'INVALID_SDK_TOKEN',
      error: 'Invalid or expired SDK session token',
      logReason: 'sdk_session_envelope_rejected_by_policy',
    });

    expect(mockResolveRuntimeSdkTokenEnvelopePolicy).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      channel: expect.objectContaining({ id: 'channel-1', authMode: 'hosted_exchange' }),
      bootstrapType: 'customer',
    });
  });

  it('reauthorizes a consumed ticket payload against live channel policy', async () => {
    mockResolveRuntimeSdkTokenEnvelopePolicy.mockResolvedValue({
      policyMode: 'jwe_required',
      bootstrapMode: 'jwe',
      sessionMode: 'jwe',
      requiresEncryptedBootstrap: true,
      requiresEncryptedSession: true,
      acceptsSignedBootstrap: false,
      acceptsSignedSession: false,
      acceptsJweBootstrap: true,
      acceptsJweSession: true,
      canIssueBootstrap: true,
      canIssueSession: true,
      reason: 'strict_required',
    });

    await expect(
      authorizeRuntimeSdkSessionPayloadForAuth(makeCustomerSessionPayload(), 'signed'),
    ).resolves.toEqual({
      success: false,
      status: 401,
      code: 'INVALID_SDK_TOKEN',
      error: 'Invalid or expired SDK session token',
      logReason: 'sdk_session_envelope_rejected_by_policy',
    });
  });

  it('rejects expired consumed ticket payloads', async () => {
    await expect(
      authorizeRuntimeSdkSessionPayloadForAuth(
        {
          ...makeCustomerSessionPayload(),
          exp: Math.floor(Date.now() / 1000) - 1,
        },
        'jwe',
      ),
    ).resolves.toEqual({
      success: false,
      status: 401,
      code: 'EXPIRED_SDK_TOKEN',
      error: 'Token expired - re-authenticate via /api/v1/sdk/init',
      logReason: 'sdk_session_expired',
    });
    expect(mockFindSDKChannelById).not.toHaveBeenCalled();
  });

  it('rejects public-key sessions when the bound channel is no longer active', async () => {
    mockFindSDKChannelById.mockResolvedValue({
      id: 'channel-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      isActive: false,
      publicApiKeyId: 'pk-1',
      config: {},
    });

    await expect(
      authorizeRuntimeSdkSessionPayloadForAuth(makePublicKeySessionPayload(), 'signed'),
    ).resolves.toEqual({
      success: false,
      status: 401,
      code: 'INVALID_SDK_TOKEN',
      error: 'Invalid or expired SDK session token',
      logReason: 'sdk_session_channel_invalid',
    });

    expect(mockFindPublicApiKey).not.toHaveBeenCalled();
  });

  it('returns the current channel binding for public-key sessions instead of stale token binding', async () => {
    await expect(
      authorizeRuntimeSdkSessionPayloadForAuth(
        {
          ...makePublicKeySessionPayload(),
          deploymentId: 'deploy-stale',
          environment: 'staging',
        },
        'signed',
      ),
    ).resolves.toEqual({
      success: true,
      payload: expect.objectContaining({
        bootstrapType: 'public_key',
        deploymentId: 'deploy-stale',
      }),
      envelope: 'signed',
      currentBinding: {
        deploymentId: 'deploy-current',
        environment: 'production',
      },
    });
  });

  it('updates retired follow-environment bindings to the active deployment during authorization', async () => {
    mockFindDeploymentById.mockResolvedValue({
      id: 'deploy-retired',
      status: 'retired',
      environment: 'production',
    });
    mockFindActiveDeployment.mockResolvedValue({
      id: 'deploy-active',
      status: 'active',
      environment: 'production',
    });
    mockFindSDKChannelById.mockResolvedValue({
      id: 'channel-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      isActive: true,
      publicApiKeyId: 'pk-1',
      deploymentId: 'deploy-retired',
      environment: 'production',
      followEnvironment: true,
      config: {},
    });

    await expect(
      authorizeRuntimeSdkSessionPayloadForAuth(makePublicKeySessionPayload(), 'signed'),
    ).resolves.toEqual(
      expect.objectContaining({
        success: true,
        currentBinding: {
          deploymentId: 'deploy-active',
          environment: 'production',
        },
      }),
    );
    expect(mockUpdateSDKChannel).toHaveBeenCalledWith('channel-1', 'project-1', 'tenant-1', {
      deploymentId: 'deploy-active',
    });
  });
});

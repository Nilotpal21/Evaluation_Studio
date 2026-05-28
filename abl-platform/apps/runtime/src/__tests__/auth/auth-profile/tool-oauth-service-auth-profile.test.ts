/**
 * ToolOAuthService — Auth Profile Resolution Tests
 *
 * Tests the auth-profile-aware token lookup integration in ToolOAuthService.
 * Auth profiles now resolve to a stable provider key; the token itself still
 * comes from the encrypted OAuth token store.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolOAuthService } from '../../../services/tool-oauth-service.js';
import type {
  OAuthTokenStore,
  OAuthEncryptor,
  OAuthProviderConfig,
  AuthProfileOAuthResolver,
  SessionOAuthArtifactStore,
} from '../../../services/tool-oauth-service.js';

const mockRefreshOAuth2Token = vi.fn();
const mockResolveOAuth2AppCredentials = vi.fn();
const mockParseAuthProfileOAuthProviderKey = vi.fn((provider: string) =>
  provider.startsWith('auth-profile:') ? provider.slice('auth-profile:'.length) : undefined,
);
const mockIsDEKEnvelopeFormat = vi.fn((value: string) => value.startsWith('dek:'));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@agent-platform/shared-kernel', () => ({
  AppError: class AppError extends Error {
    constructor(
      message: string,
      public details?: any,
    ) {
      super(message);
    }
  },
  ErrorCodes: {
    BAD_REQUEST: { code: 400, message: 'Bad Request' },
    SERVICE_UNAVAILABLE: { code: 503, message: 'Service Unavailable' },
  },
}));

vi.mock('@agent-platform/shared/services/auth-profile', () => ({
  refreshOAuth2Token: (...args: unknown[]) => mockRefreshOAuth2Token(...args),
  resolveOAuth2AppCredentials: (...args: unknown[]) => mockResolveOAuth2AppCredentials(...args),
  parseAuthProfileOAuthProviderKey: (...args: unknown[]) =>
    mockParseAuthProfileOAuthProviderKey(...args),
}));

vi.mock('@agent-platform/shared-encryption', () => ({
  isDEKEnvelopeFormat: (...args: unknown[]) => mockIsDEKEnvelopeFormat(...args),
}));

function createMockTokenStore(): OAuthTokenStore {
  return {
    findToken: vi.fn().mockResolvedValue(null),
    upsertToken: vi.fn().mockResolvedValue(undefined),
    compareAndSwapToken: vi.fn().mockResolvedValue(true),
    markRevoked: vi.fn().mockResolvedValue(undefined),
    updateLastUsed: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockEncryptor(): OAuthEncryptor {
  return {
    encryptForTenant: vi.fn((v) => `enc:${v}`),
    decryptForTenant: vi.fn((v) => v.replace('enc:', '')),
  };
}

function createMockSessionArtifactStore(): SessionOAuthArtifactStore & {
  tokens: Map<string, any>;
} {
  const tokens = new Map<string, any>();
  const key = (tenantId: string, projectId: string, sessionPrincipal: string, provider: string) =>
    `${tenantId}:${projectId}:${sessionPrincipal}:${provider}`;

  return {
    tokens,
    findToken: vi.fn(async (params) => {
      return (
        tokens.get(
          key(params.tenantId, params.projectId, params.sessionPrincipal, params.provider),
        ) ?? null
      );
    }),
    upsertToken: vi.fn(async (params) => {
      tokens.set(key(params.tenantId, params.projectId, params.sessionPrincipal, params.provider), {
        encryptedAccessToken: params.encryptedAccessToken,
        encryptedRefreshToken: params.encryptedRefreshToken ?? null,
        scope: params.scope,
        expiresAt: params.expiresAt ?? null,
        sessionId: params.sessionId,
        channelId: params.channelId ?? null,
        authProfileId: params.authProfileId ?? null,
        authProfileRef: params.authProfileRef ?? null,
        sessionExpiresAt: params.sessionExpiresAt,
      });
    }),
    compareAndSwapToken: vi.fn(async () => true),
    deleteBySessionId: vi.fn(async () => 0),
    updateLastUsed: vi.fn(async () => {}),
  };
}

describe('ToolOAuthService — Auth Profile resolution', () => {
  let mockTokenStore: OAuthTokenStore;
  let mockEncryptor: OAuthEncryptor;
  let mockResolver: AuthProfileOAuthResolver;
  const providerConfigs = new Map<string, OAuthProviderConfig>();
  const authProfileProvider = {
    authProfileId: 'profile-1',
    authProfileRef: 'google',
    providerKey: 'auth-profile:profile-1',
    config: {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      authorizeUrl: 'https://example.com/oauth/authorize',
      tokenUrl: 'https://example.com/oauth/token',
      scopes: ['calendar.read'],
    },
  };

  beforeEach(() => {
    mockTokenStore = createMockTokenStore();
    mockEncryptor = createMockEncryptor();
    mockRefreshOAuth2Token.mockReset();
    mockResolveOAuth2AppCredentials.mockReset();
    mockParseAuthProfileOAuthProviderKey.mockReset();
    mockIsDEKEnvelopeFormat.mockReset();
    mockParseAuthProfileOAuthProviderKey.mockImplementation((provider: string) =>
      provider.startsWith('auth-profile:') ? provider.slice('auth-profile:'.length) : undefined,
    );
    mockIsDEKEnvelopeFormat.mockImplementation((value: string) => value.startsWith('dek:'));
    mockResolveOAuth2AppCredentials.mockResolvedValue({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenUrl: 'https://example.com/oauth/token',
      authorizationUrl: 'https://example.com/oauth/authorize',
      revocationUrl: 'https://example.com/oauth/revoke',
      defaultScopes: ['calendar.read'],
      pkceRequired: false,
    });
    mockResolver = {
      resolveProvider: vi.fn().mockResolvedValue(null),
      resolveProviderById: vi.fn().mockResolvedValue(null),
    };
  });

  it('resolves token from auth profile provider key when explicitly requested', async () => {
    (mockResolver.resolveProvider as any).mockResolvedValue(authProfileProvider);
    (mockTokenStore.findToken as any).mockResolvedValue({
      encryptedAccessToken: 'enc:profile-token-123',
      encryptedRefreshToken: null,
      scope: 'calendar.read',
      expiresAt: new Date(Date.now() + 3600000),
    });

    const service = new ToolOAuthService(
      mockTokenStore,
      mockEncryptor,
      providerConfigs,
      undefined,
      mockResolver,
    );

    const result = await service.getAccessToken('tenant-1', 'user-1', 'google', {
      projectId: 'project-1',
      environment: 'dev',
      lookupScope: 'user',
      preferAuthProfile: true,
    });

    expect(result).toBe('profile-token-123');
    expect(mockResolver.resolveProvider).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      userId: 'user-1',
      provider: 'google',
      projectId: 'project-1',
      environment: 'dev',
      scopes: undefined,
      lookupScope: 'user',
    });
    expect(mockTokenStore.findToken).toHaveBeenCalledWith(
      'tenant-1',
      'user-1',
      'auth-profile:profile-1',
    );
  });

  it('decrypts tenant-scoped auth-profile grants with end_user_oauth_tokens AAD context', async () => {
    (mockResolver.resolveProvider as any).mockResolvedValue(authProfileProvider);
    (mockTokenStore.findToken as any).mockResolvedValue({
      encryptedAccessToken: 'enc:tenant-shared-profile-token',
      encryptedRefreshToken: null,
      scope: 'calendar.read',
      expiresAt: new Date(Date.now() + 3600000),
    });

    const service = new ToolOAuthService(
      mockTokenStore,
      mockEncryptor,
      providerConfigs,
      undefined,
      mockResolver,
    );

    const result = await service.getAccessToken('tenant-1', '__tenant__', 'google', {
      projectId: 'project-1',
      lookupScope: 'tenant',
      authScope: 'tenant',
      preferAuthProfile: true,
    });

    expect(result).toBe('tenant-shared-profile-token');
    expect(mockEncryptor.decryptForTenant).toHaveBeenCalledWith(
      'enc:tenant-shared-profile-token',
      'tenant-1',
      {
        resourceType: 'end_user_oauth_tokens',
        fieldName: 'encryptedAccessToken',
      },
    );
  });

  it('uses plaintext compatibility for non-envelope OAuth access tokens when decrypt fails', async () => {
    (mockResolver.resolveProvider as any).mockResolvedValue(authProfileProvider);
    (mockTokenStore.findToken as any).mockResolvedValue({
      encryptedAccessToken: 'plaintext-access-token',
      encryptedRefreshToken: null,
      scope: 'calendar.read',
      expiresAt: new Date(Date.now() + 3600000),
    });
    (mockEncryptor.decryptForTenant as any).mockRejectedValueOnce(
      new Error('Unsupported state or unable to authenticate data'),
    );

    const service = new ToolOAuthService(
      mockTokenStore,
      mockEncryptor,
      providerConfigs,
      undefined,
      mockResolver,
    );

    const result = await service.getAccessToken('tenant-1', '__tenant__', 'google', {
      lookupScope: 'tenant',
      authScope: 'tenant',
      preferAuthProfile: true,
    });

    expect(result).toBe('plaintext-access-token');
  });

  it('returns undefined when encrypted OAuth access token fails decryption', async () => {
    (mockResolver.resolveProvider as any).mockResolvedValue(authProfileProvider);
    (mockTokenStore.findToken as any).mockResolvedValue({
      encryptedAccessToken: 'dek:broken-ciphertext',
      encryptedRefreshToken: null,
      scope: 'calendar.read',
      expiresAt: new Date(Date.now() + 3600000),
    });
    (mockEncryptor.decryptForTenant as any).mockRejectedValueOnce(
      new Error('Unsupported state or unable to authenticate data'),
    );

    const service = new ToolOAuthService(
      mockTokenStore,
      mockEncryptor,
      providerConfigs,
      undefined,
      mockResolver,
    );

    const result = await service.getAccessToken('tenant-1', '__tenant__', 'google', {
      lookupScope: 'tenant',
      authScope: 'tenant',
      preferAuthProfile: true,
    });

    expect(result).toBeUndefined();
  });

  it('returns undefined when auth-profile resolution is requested but no provider matches', async () => {
    (mockResolver.resolveProvider as any).mockResolvedValue(null);

    const service = new ToolOAuthService(
      mockTokenStore,
      mockEncryptor,
      providerConfigs,
      undefined,
      mockResolver,
    );

    const result = await service.getAccessToken('tenant-1', 'user-1', 'slack', {
      preferAuthProfile: true,
      lookupScope: 'user',
    });

    expect(mockResolver.resolveProvider).toHaveBeenCalled();
    expect(mockTokenStore.findToken).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('uses the legacy token store when auth-profile resolution is not requested', async () => {
    (mockTokenStore.findToken as any).mockResolvedValue({
      encryptedAccessToken: 'enc:fallback-token',
      encryptedRefreshToken: null,
      scope: 'read',
      expiresAt: new Date(Date.now() + 3600000),
    });

    const service = new ToolOAuthService(
      mockTokenStore,
      mockEncryptor,
      providerConfigs,
      undefined,
      mockResolver,
    );

    const result = await service.getAccessToken('tenant-1', 'user-1', 'google');

    expect(mockResolver.resolveProvider).not.toHaveBeenCalled();
    expect(mockTokenStore.findToken).toHaveBeenCalledWith('tenant-1', 'user-1', 'google');
    expect(result).toBe('fallback-token');
  });

  it('skips auth profile entirely when no resolver is configured', async () => {
    (mockTokenStore.findToken as any).mockResolvedValue({
      encryptedAccessToken: 'enc:direct-token',
      encryptedRefreshToken: null,
      scope: 'read',
      expiresAt: new Date(Date.now() + 3600000),
    });

    const service = new ToolOAuthService(mockTokenStore, mockEncryptor, providerConfigs);

    const result = await service.getAccessToken('tenant-1', 'user-1', 'google');

    expect(result).toBe('direct-token');
  });

  it('returns undefined when auth profile resolves but the provider-key token is missing', async () => {
    (mockResolver.resolveProvider as any).mockResolvedValue(authProfileProvider);
    (mockTokenStore.findToken as any).mockResolvedValue(null);

    const service = new ToolOAuthService(
      mockTokenStore,
      mockEncryptor,
      providerConfigs,
      undefined,
      mockResolver,
    );

    const result = await service.getAccessToken('tenant-1', 'user-1', 'google', {
      preferAuthProfile: true,
      lookupScope: 'user',
    });

    expect(result).toBeUndefined();
  });

  it('refreshes expired auth-profile grants via the shared refresh helper', async () => {
    (mockResolver.resolveProvider as any).mockResolvedValue(authProfileProvider);
    (mockTokenStore.findToken as any).mockResolvedValue({
      encryptedAccessToken: 'enc:expired-profile-token',
      encryptedRefreshToken: 'enc:profile-refresh-token',
      scope: 'calendar.read',
      expiresAt: new Date(Date.now() - 60_000),
    });
    mockRefreshOAuth2Token.mockResolvedValue({
      accessToken: 'refreshed-profile-token',
      refreshToken: 'new-refresh-token',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scope: 'calendar.read calendar.write',
      refreshed: true,
    });

    const service = new ToolOAuthService(
      mockTokenStore,
      mockEncryptor,
      providerConfigs,
      undefined,
      mockResolver,
    );

    const result = await service.getAccessToken('tenant-1', 'user-1', 'google', {
      projectId: 'project-1',
      environment: 'dev',
      lookupScope: 'user',
      preferAuthProfile: true,
      scopes: ['calendar.read'],
    });

    expect(result).toBe('refreshed-profile-token');
    expect(mockRefreshOAuth2Token).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        authScope: 'user',
        userId: 'user-1',
      }),
    );
  });

  it('refreshes session-scoped auth-profile artifacts via the shared refresh helper', async () => {
    const sessionArtifactStore = createMockSessionArtifactStore();
    (mockResolver.resolveProvider as any).mockResolvedValue(authProfileProvider);
    sessionArtifactStore.tokens.set('tenant-1:project-1:sdk-session-1:auth-profile:profile-1', {
      encryptedAccessToken: 'enc:expired-session-token',
      encryptedRefreshToken: 'enc:session-refresh-token',
      scope: 'calendar.read',
      expiresAt: new Date(Date.now() - 60_000),
      sessionId: 'runtime-session-1',
      authProfileId: 'profile-1',
      authProfileRef: 'google',
      sessionExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });
    mockRefreshOAuth2Token.mockResolvedValue({
      accessToken: 'refreshed-session-token',
      refreshToken: 'new-session-refresh-token',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scope: 'calendar.read',
      refreshed: true,
    });

    const service = new ToolOAuthService(
      mockTokenStore,
      mockEncryptor,
      providerConfigs,
      undefined,
      mockResolver,
      sessionArtifactStore,
    );

    const result = await service.getAccessToken('tenant-1', 'sdk-session-1', 'google', {
      projectId: 'project-1',
      authScope: 'session',
      lookupScope: 'user',
      preferAuthProfile: true,
    });

    expect(result).toBe('refreshed-session-token');
    expect(mockRefreshOAuth2Token).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        authScope: 'session',
        projectId: 'project-1',
        sessionPrincipal: 'sdk-session-1',
      }),
    );
  });

  it('decrypts session-scoped auth-profile artifacts with session_oauth_artifacts AAD context', async () => {
    const sessionArtifactStore = createMockSessionArtifactStore();
    (mockResolver.resolveProvider as any).mockResolvedValue(authProfileProvider);
    sessionArtifactStore.tokens.set('tenant-1:project-1:sdk-session-1:auth-profile:profile-1', {
      encryptedAccessToken: 'enc:session-profile-token',
      encryptedRefreshToken: null,
      scope: 'calendar.read',
      expiresAt: new Date(Date.now() + 3600000),
      sessionId: 'runtime-session-1',
      authProfileId: 'profile-1',
      authProfileRef: 'google',
      sessionExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });

    const service = new ToolOAuthService(
      mockTokenStore,
      mockEncryptor,
      providerConfigs,
      undefined,
      mockResolver,
      sessionArtifactStore,
    );

    const result = await service.getAccessToken('tenant-1', 'sdk-session-1', 'google', {
      projectId: 'project-1',
      authScope: 'session',
      lookupScope: 'user',
      preferAuthProfile: true,
    });

    expect(result).toBe('session-profile-token');
    expect(mockEncryptor.decryptForTenant).toHaveBeenCalledWith(
      'enc:session-profile-token',
      'tenant-1',
      {
        resourceType: 'session_oauth_artifacts',
        fieldName: 'encryptedAccessToken',
      },
    );
  });

  it('refreshes canonical auth-profile provider keys without resolver config', async () => {
    (mockTokenStore.findToken as any).mockResolvedValue({
      encryptedAccessToken: 'enc:expired-profile-token',
      encryptedRefreshToken: 'enc:profile-refresh-token',
      scope: 'calendar.read',
      expiresAt: new Date(Date.now() - 60_000),
    });
    mockRefreshOAuth2Token.mockResolvedValue({
      accessToken: 'refreshed-profile-token',
      refreshToken: 'new-refresh-token',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scope: 'calendar.read',
      refreshed: true,
    });

    const service = new ToolOAuthService(mockTokenStore, mockEncryptor, providerConfigs);

    const result = await service.getAccessToken('tenant-1', 'user-1', 'auth-profile:profile-1');

    expect(result).toBe('refreshed-profile-token');
    expect(mockParseAuthProfileOAuthProviderKey).toHaveBeenCalledWith('auth-profile:profile-1');
    expect(mockRefreshOAuth2Token).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        authScope: 'user',
        userId: 'user-1',
      }),
    );
  });

  it('revokes canonical auth-profile provider keys via the linked oauth2_app revocation URL', async () => {
    (mockTokenStore.findToken as any).mockResolvedValue({
      encryptedAccessToken: 'enc:profile-token-123',
      encryptedRefreshToken: null,
      scope: 'calendar.read',
      expiresAt: new Date(Date.now() + 3600000),
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    const service = new ToolOAuthService(mockTokenStore, mockEncryptor, providerConfigs);

    await service.revokeToken('tenant-1', 'user-1', 'auth-profile:profile-1');

    expect(mockResolveOAuth2AppCredentials).toHaveBeenCalledWith({
      linkedAppProfileId: 'profile-1',
      tenantId: 'tenant-1',
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://example.com/oauth/revoke',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    expect(mockTokenStore.markRevoked).toHaveBeenCalledWith(
      'tenant-1',
      'user-1',
      'auth-profile:profile-1',
    );

    vi.unstubAllGlobals();
  });

  it('still revokes canonical auth-profile provider keys locally when revocation metadata is unavailable', async () => {
    (mockTokenStore.findToken as any).mockResolvedValue({
      encryptedAccessToken: 'enc:profile-token-123',
      encryptedRefreshToken: null,
      scope: 'calendar.read',
      expiresAt: new Date(Date.now() + 3600000),
    });
    mockResolveOAuth2AppCredentials.mockRejectedValueOnce(new Error('app missing'));

    const service = new ToolOAuthService(mockTokenStore, mockEncryptor, providerConfigs);

    await expect(
      service.revokeToken('tenant-1', 'user-1', 'auth-profile:profile-1'),
    ).resolves.not.toThrow();

    expect(mockTokenStore.markRevoked).toHaveBeenCalledWith(
      'tenant-1',
      'user-1',
      'auth-profile:profile-1',
    );
  });
});

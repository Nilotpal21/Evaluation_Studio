/**
 * Tasks 19-22: Token refresh service tests
 *
 * Imports from @agent-platform/shared-auth-profile directly — the local
 * packages/shared/src/services/auth-profile/token-refresh-service.ts was
 * dead code (its index.ts already re-exports the canonical implementation).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { needsProactiveRefresh, refreshOAuth2Token } from '@agent-platform/shared-auth-profile';
import type { RefreshTokenDeps } from '@agent-platform/shared-auth-profile';

const mockFindOne = vi.fn();
const mockEndUserOAuthTokenFindOne = vi.fn();
const mockSessionOAuthArtifactFindOne = vi.fn();
const mockAcquireRefreshLock = vi.fn();
const mockResolveOAuth2AppCredentials = vi.fn();

function buildDeps(overrides?: Partial<RefreshTokenDeps>): RefreshTokenDeps {
  return {
    AuthProfile: { findOne: mockFindOne },
    EndUserOAuthToken: { findOne: mockEndUserOAuthTokenFindOne },
    SessionOAuthArtifact: { findOne: mockSessionOAuthArtifactFindOne },
    acquireRefreshLock: mockAcquireRefreshLock,
    resolveOAuth2AppCredentials: mockResolveOAuth2AppCredentials,
    ...overrides,
  };
}

describe('needsProactiveRefresh', () => {
  it('returns false when expiresAt is null', () => {
    expect(needsProactiveRefresh(null)).toBe(false);
  });

  it('returns false when expiresAt is undefined', () => {
    expect(needsProactiveRefresh(undefined)).toBe(false);
  });

  it('returns false when token expires far in the future', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
    expect(needsProactiveRefresh(future)).toBe(false);
  });

  it('returns true when token expires within 5 minutes', () => {
    const soon = new Date(Date.now() + 2 * 60 * 1000).toISOString(); // 2 minutes
    expect(needsProactiveRefresh(soon)).toBe(true);
  });

  it('returns true when token is already expired', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(needsProactiveRefresh(past)).toBe(true);
  });
});

describe('refreshOAuth2Token', () => {
  const mockSave = vi.fn().mockResolvedValue(undefined);
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockFindOne.mockReset();
    mockEndUserOAuthTokenFindOne.mockReset();
    mockSessionOAuthArtifactFindOne.mockReset();
    mockAcquireRefreshLock.mockReset();
    mockResolveOAuth2AppCredentials.mockReset();
    mockSave.mockReset();
    mockSave.mockResolvedValue(undefined);
    globalThis.fetch = vi.fn();
    mockEndUserOAuthTokenFindOne.mockResolvedValue(null);
    mockSessionOAuthArtifactFindOne.mockResolvedValue(null);
    mockAcquireRefreshLock.mockResolvedValue({
      acquired: true,
      release: vi.fn().mockResolvedValue(undefined),
    });
    mockResolveOAuth2AppCredentials.mockResolvedValue({
      clientId: 'cid',
      clientSecret: 'csec',
      tokenUrl: 'https://auth.example.com/token',
      authorizationUrl: 'https://auth.example.com/authorize',
      defaultScopes: [],
      pkceRequired: false,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('throws when profile not found', async () => {
    mockFindOne.mockResolvedValue(null);

    await expect(
      refreshOAuth2Token({ profileId: 'p-1', tenantId: 't-1' }, buildDeps()),
    ).rejects.toThrow(/not found/);
  });

  it('throws when no refresh token available', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'p-1',
      tenantId: 't-1',
      authType: 'oauth2_token',
      linkedAppProfileId: 'app-1',
      scope: 'project',
      visibility: 'shared',
      projectId: 'project-1',
      encryptedSecrets: JSON.stringify({ accessToken: 'at' }),
      config: {},
      save: mockSave,
    });

    await expect(
      refreshOAuth2Token({ profileId: 'p-1', tenantId: 't-1' }, buildDeps()),
    ).rejects.toThrow(/No refresh token/);
  });

  it('throws when no linkedAppProfileId', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'p-1',
      tenantId: 't-1',
      authType: 'oauth2_token',
      encryptedSecrets: JSON.stringify({ accessToken: 'at', refreshToken: 'rt' }),
      config: {},
      save: mockSave,
    });

    await expect(
      refreshOAuth2Token({ profileId: 'p-1', tenantId: 't-1' }, buildDeps()),
    ).rejects.toThrow(/no linkedAppProfileId/);
  });

  it('refreshes token and saves updated profile', async () => {
    const profile = {
      _id: 'p-1',
      tenantId: 't-1',
      authType: 'oauth2_token',
      linkedAppProfileId: 'app-1',
      scope: 'project',
      visibility: 'shared',
      projectId: 'project-1',
      encryptedSecrets: JSON.stringify({ accessToken: 'old-at', refreshToken: 'old-rt' }),
      config: {},
      save: mockSave,
    };
    mockFindOne.mockResolvedValue(profile);

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new-at',
        refresh_token: 'new-rt',
        expires_in: 3600,
        scope: 'calendar.read calendar.write',
      }),
    });

    const result = await refreshOAuth2Token({ profileId: 'p-1', tenantId: 't-1' }, buildDeps());

    expect(result.accessToken).toBe('new-at');
    expect(result.refreshToken).toBe('new-rt');
    expect(result.scope).toBe('calendar.read calendar.write');
    expect(result.refreshed).toBe(true);
    expect(mockSave).toHaveBeenCalled();
    expect(profile.config).toEqual(
      expect.objectContaining({
        grantedScopes: ['calendar.read', 'calendar.write'],
      }),
    );
  });

  it('refreshes a shared durable oauth grant when called with an oauth2_app profile id', async () => {
    const mockGrantSave = vi.fn().mockResolvedValue(undefined);
    const grant = {
      encryptedAccessToken: 'old-at',
      encryptedRefreshToken: 'old-rt',
      scope: 'calendar.read',
      expiresAt: new Date('2026-03-18T10:00:00.000Z'),
      refreshedAt: null,
      save: mockGrantSave,
    };

    mockFindOne.mockResolvedValue({
      _id: 'app-1',
      tenantId: 't-1',
      authType: 'oauth2_app',
      scope: 'project',
      visibility: 'shared',
      projectId: 'project-1',
      encryptedSecrets: JSON.stringify({ clientId: 'cid', clientSecret: 'csec' }),
      config: {
        authorizationUrl: 'https://auth.example.com/authorize',
        tokenUrl: 'https://auth.example.com/token',
      },
      save: mockSave,
    });
    mockEndUserOAuthTokenFindOne.mockResolvedValue(grant);

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new-at',
        refresh_token: 'new-rt',
        expires_in: 3600,
        scope: 'calendar.read calendar.write',
      }),
    });

    const result = await refreshOAuth2Token({ profileId: 'app-1', tenantId: 't-1' }, buildDeps());

    expect(result).toEqual({
      accessToken: 'new-at',
      refreshToken: 'new-rt',
      expiresAt: expect.any(String),
      scope: 'calendar.read calendar.write',
      refreshed: true,
    });
    expect(mockEndUserOAuthTokenFindOne).toHaveBeenCalledWith({
      tenantId: 't-1',
      userId: '__tenant__',
      provider: 'auth-profile:app-1',
      revokedAt: null,
    });
    expect(mockResolveOAuth2AppCredentials).toHaveBeenCalledWith({
      linkedAppProfileId: 'app-1',
      tenantId: 't-1',
      expectedScope: 'project',
      expectedVisibility: 'shared',
      expectedProjectId: 'project-1',
      expectedOwnerId: undefined,
    });
    expect(mockGrantSave).toHaveBeenCalled();
    expect(grant.scope).toBe('calendar.read calendar.write');
  });

  it('uses the provided userId for per-user durable oauth grant refresh', async () => {
    const mockGrantSave = vi.fn().mockResolvedValue(undefined);

    mockFindOne.mockResolvedValue({
      _id: 'app-1',
      tenantId: 't-1',
      authType: 'oauth2_app',
      scope: 'project',
      visibility: 'shared',
      projectId: 'project-1',
      encryptedSecrets: JSON.stringify({ clientId: 'cid', clientSecret: 'csec' }),
      config: {
        authorizationUrl: 'https://auth.example.com/authorize',
        tokenUrl: 'https://auth.example.com/token',
      },
      save: mockSave,
    });
    mockEndUserOAuthTokenFindOne.mockResolvedValue({
      encryptedAccessToken: 'old-at',
      encryptedRefreshToken: 'old-rt',
      expiresAt: null,
      refreshedAt: null,
      save: mockGrantSave,
    });

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new-at',
        refresh_token: 'new-rt',
      }),
    });

    await refreshOAuth2Token(
      {
        profileId: 'app-1',
        tenantId: 't-1',
        userId: 'user-1',
        connectionMode: 'per_user',
      },
      buildDeps(),
    );

    expect(mockEndUserOAuthTokenFindOne).toHaveBeenCalledWith({
      tenantId: 't-1',
      userId: 'user-1',
      provider: 'auth-profile:app-1',
      revokedAt: null,
    });
  });

  it('fails closed when an oauth2_app profile has no durable grant to refresh', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'app-1',
      tenantId: 't-1',
      authType: 'oauth2_app',
      scope: 'project',
      visibility: 'shared',
      projectId: 'project-1',
      encryptedSecrets: JSON.stringify({ clientId: 'cid', clientSecret: 'csec' }),
      config: {
        authorizationUrl: 'https://auth.example.com/authorize',
        tokenUrl: 'https://auth.example.com/token',
      },
      save: mockSave,
    });
    mockEndUserOAuthTokenFindOne.mockResolvedValue(null);

    await expect(
      refreshOAuth2Token({ profileId: 'app-1', tenantId: 't-1' }, buildDeps()),
    ).rejects.toThrow(/OAuth grant .* not found/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('refreshes a session-scoped oauth artifact when called with oauth2_app session context', async () => {
    const mockArtifactSave = vi.fn().mockResolvedValue(undefined);
    const artifact = {
      encryptedAccessToken: 'old-at',
      encryptedRefreshToken: 'old-rt',
      scope: 'calendar.read',
      sessionId: 'runtime-session-1',
      sessionExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
      expiresAt: null,
      refreshedAt: null,
      save: mockArtifactSave,
    };

    mockFindOne.mockResolvedValue({
      _id: 'app-1',
      tenantId: 't-1',
      authType: 'oauth2_app',
      scope: 'project',
      visibility: 'shared',
      projectId: null,
      encryptedSecrets: JSON.stringify({ clientId: 'cid', clientSecret: 'csec' }),
      config: {
        authorizationUrl: 'https://auth.example.com/authorize',
        tokenUrl: 'https://auth.example.com/token',
      },
      save: mockSave,
    });
    mockSessionOAuthArtifactFindOne.mockResolvedValue(artifact);

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new-at',
        refresh_token: 'new-rt',
        expires_in: 1800,
        scope: 'calendar.read calendar.write',
      }),
    });

    const result = await refreshOAuth2Token(
      {
        profileId: 'app-1',
        tenantId: 't-1',
        authScope: 'session',
        projectId: 'project-1',
        sessionPrincipal: 'sdk-session-1',
      },
      buildDeps(),
    );

    expect(result).toEqual({
      accessToken: 'new-at',
      refreshToken: 'new-rt',
      expiresAt: expect.any(String),
      scope: 'calendar.read calendar.write',
      refreshed: true,
    });
    expect(mockSessionOAuthArtifactFindOne).toHaveBeenCalledWith({
      tenantId: 't-1',
      projectId: 'project-1',
      sessionPrincipal: 'sdk-session-1',
      provider: 'auth-profile:app-1',
    });
    expect(mockArtifactSave).toHaveBeenCalled();
    expect(artifact.scope).toBe('calendar.read calendar.write');
  });

  it('fails closed when session-scoped oauth refresh is missing projectId', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'app-1',
      tenantId: 't-1',
      authType: 'oauth2_app',
      scope: 'project',
      visibility: 'shared',
      projectId: null,
      encryptedSecrets: JSON.stringify({ clientId: 'cid', clientSecret: 'csec' }),
      config: {
        authorizationUrl: 'https://auth.example.com/authorize',
        tokenUrl: 'https://auth.example.com/token',
      },
      save: mockSave,
    });

    await expect(
      refreshOAuth2Token(
        {
          profileId: 'app-1',
          tenantId: 't-1',
          authScope: 'session',
          sessionPrincipal: 'sdk-session-1',
        },
        buildDeps(),
      ),
    ).rejects.toThrow(/requires projectId/i);
  });

  it('throws when token exchange fails', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'p-1',
      tenantId: 't-1',
      authType: 'oauth2_token',
      linkedAppProfileId: 'app-1',
      scope: 'project',
      visibility: 'shared',
      projectId: 'project-1',
      encryptedSecrets: JSON.stringify({ accessToken: 'at', refreshToken: 'rt' }),
      config: {},
      save: mockSave,
    });

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 401,
    });

    await expect(
      refreshOAuth2Token({ profileId: 'p-1', tenantId: 't-1' }, buildDeps()),
    ).rejects.toThrow(/Token refresh failed with status 401/);
  });

  it('rejects malformed token refresh payloads before persisting them', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'p-1',
      tenantId: 't-1',
      authType: 'oauth2_token',
      linkedAppProfileId: 'app-1',
      scope: 'project',
      visibility: 'shared',
      projectId: 'project-1',
      encryptedSecrets: JSON.stringify({ accessToken: 'at', refreshToken: 'rt' }),
      config: {},
      save: mockSave,
    });

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        refresh_token: 'new-rt',
        expires_in: 3600,
      }),
    });

    await expect(
      refreshOAuth2Token({ profileId: 'p-1', tenantId: 't-1' }, buildDeps()),
    ).rejects.toThrow(/invalid access_token/);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('waits for the winning pod to persist a fresh token before returning', async () => {
    mockAcquireRefreshLock.mockResolvedValueOnce({
      acquired: false,
      release: vi.fn().mockResolvedValue(undefined),
    });
    const staleProfile = {
      _id: 'p-1',
      tenantId: 't-1',
      authType: 'oauth2_token',
      linkedAppProfileId: 'app-1',
      scope: 'project',
      visibility: 'shared',
      projectId: 'project-1',
      encryptedSecrets: JSON.stringify({ accessToken: 'stale-at', refreshToken: 'old-rt' }),
      config: { expiresAt: '2026-03-18T10:00:00.000Z' },
      updatedAt: new Date('2026-03-18T09:00:00.000Z'),
    };
    const freshProfile = {
      _id: 'p-1',
      tenantId: 't-1',
      authType: 'oauth2_token',
      linkedAppProfileId: 'app-1',
      scope: 'project',
      visibility: 'shared',
      projectId: 'project-1',
      encryptedSecrets: JSON.stringify({ accessToken: 'fresh-at', refreshToken: 'fresh-rt' }),
      config: { expiresAt: '2026-03-18T11:00:00.000Z' },
      updatedAt: new Date('2026-03-18T09:00:01.000Z'),
    };
    mockFindOne
      .mockResolvedValueOnce(staleProfile)
      .mockResolvedValueOnce(staleProfile)
      .mockResolvedValueOnce(freshProfile);

    const result = await refreshOAuth2Token(
      {
        profileId: 'p-1',
        tenantId: 't-1',
        redis: {} as any,
      },
      buildDeps(),
    );

    expect(result).toEqual({
      accessToken: 'fresh-at',
      refreshToken: 'fresh-rt',
      expiresAt: '2026-03-18T11:00:00.000Z',
      refreshed: false,
    });
  });

  it('waits for the winning pod to persist a fresh session oauth artifact before returning', async () => {
    mockAcquireRefreshLock.mockResolvedValueOnce({
      acquired: false,
      release: vi.fn().mockResolvedValue(undefined),
    });
    mockFindOne.mockResolvedValue({
      _id: 'app-1',
      tenantId: 't-1',
      authType: 'oauth2_app',
      scope: 'project',
      visibility: 'shared',
      projectId: null,
      encryptedSecrets: JSON.stringify({ clientId: 'cid', clientSecret: 'csec' }),
      config: {
        authorizationUrl: 'https://auth.example.com/authorize',
        tokenUrl: 'https://auth.example.com/token',
      },
    });
    mockSessionOAuthArtifactFindOne
      .mockResolvedValueOnce({
        encryptedAccessToken: 'stale-at',
        encryptedRefreshToken: 'old-rt',
        sessionId: 'runtime-session-1',
        sessionExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
        expiresAt: new Date('2026-03-18T10:00:00.000Z'),
        refreshedAt: new Date('2026-03-18T09:00:00.000Z'),
        updatedAt: new Date('2026-03-18T09:00:00.000Z'),
        save: mockSave,
      })
      .mockResolvedValueOnce({
        encryptedAccessToken: 'fresh-at',
        encryptedRefreshToken: 'fresh-rt',
        sessionId: 'runtime-session-1',
        sessionExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
        expiresAt: new Date('2026-03-18T11:00:00.000Z'),
        refreshedAt: new Date('2026-03-18T09:00:01.000Z'),
        updatedAt: new Date('2026-03-18T09:00:01.000Z'),
        save: mockSave,
      });

    const result = await refreshOAuth2Token(
      {
        profileId: 'app-1',
        tenantId: 't-1',
        authScope: 'session',
        projectId: 'project-1',
        sessionPrincipal: 'sdk-session-1',
        redis: {} as any,
      },
      buildDeps(),
    );

    expect(result).toEqual({
      accessToken: 'fresh-at',
      refreshToken: 'fresh-rt',
      expiresAt: '2026-03-18T11:00:00.000Z',
      refreshed: false,
    });
  });

  it('rejects non-HTTPS refresh endpoints even if the resolver returns one', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'p-1',
      tenantId: 't-1',
      authType: 'oauth2_token',
      linkedAppProfileId: 'app-1',
      scope: 'project',
      visibility: 'shared',
      projectId: 'project-1',
      encryptedSecrets: JSON.stringify({ accessToken: 'at', refreshToken: 'rt' }),
      config: {},
      save: mockSave,
    });
    mockResolveOAuth2AppCredentials.mockResolvedValueOnce({
      clientId: 'cid',
      clientSecret: 'csec',
      tokenUrl: 'https://auth.example.com/token',
      refreshUrl: 'http://auth.example.com/refresh',
      authorizationUrl: 'https://auth.example.com/authorize',
      defaultScopes: [],
      pkceRequired: false,
    });

    await expect(
      refreshOAuth2Token({ profileId: 'p-1', tenantId: 't-1' }, buildDeps()),
    ).rejects.toThrow(/must use HTTPS/);
    expect(mockResolveOAuth2AppCredentials).toHaveBeenCalledWith({
      linkedAppProfileId: 'app-1',
      tenantId: 't-1',
      expectedScope: 'project',
      expectedVisibility: 'shared',
      expectedProjectId: 'project-1',
      expectedOwnerId: undefined,
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

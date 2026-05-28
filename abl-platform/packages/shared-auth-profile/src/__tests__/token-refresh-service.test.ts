import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { needsProactiveRefresh, refreshOAuth2Token } from '../token-refresh-service.js';
import type { RefreshTokenDeps } from '../token-refresh-service.js';

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

function buildLinkedAppProfile(
  overrides: Partial<{
    _id: string;
    tenantId: string;
    projectId: string | null;
    visibility: 'shared' | 'personal';
    scope: 'tenant' | 'project';
    encryptedSecrets: string;
    config: Record<string, unknown>;
  }> = {},
) {
  const { config: configOverrides, ...restOverrides } = overrides;

  return {
    _id: 'app-1',
    tenantId: 't-1',
    authType: 'oauth2_app',
    status: 'active',
    scope: 'project',
    visibility: 'shared',
    projectId: 'project-1',
    encryptedSecrets: JSON.stringify({ clientId: 'cid', clientSecret: 'csec' }),
    config: {
      authorizationUrl: 'https://auth.example.com/authorize',
      tokenUrl: 'https://auth.example.com/token',
      ...configOverrides,
    },
    ...restOverrides,
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
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(needsProactiveRefresh(future)).toBe(false);
  });

  it('returns true when token expires within 5 minutes', () => {
    const soon = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    expect(needsProactiveRefresh(soon)).toBe(true);
  });

  it('returns true when token is already expired', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(needsProactiveRefresh(past)).toBe(true);
  });
});

describe('refreshOAuth2Token', () => {
  const mockSave = vi.fn();
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
      { profileId: 'p-1', tenantId: 't-1', redis: {} as any },
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
    expect(globalThis.fetch).not.toHaveBeenCalled();
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

  it('persists granted scopes on refreshed legacy oauth2_token profiles', async () => {
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

    expect(result).toEqual({
      accessToken: 'new-at',
      refreshToken: 'new-rt',
      expiresAt: expect.any(String),
      scope: 'calendar.read calendar.write',
      refreshed: true,
    });
    expect(profile.config).toEqual(
      expect.objectContaining({
        grantedScopes: ['calendar.read', 'calendar.write'],
      }),
    );
  });

  it('refreshes shared durable grants when invoked with an oauth2_app profile id', async () => {
    const mockGrantSave = vi.fn().mockResolvedValue(undefined);
    const grant = {
      encryptedAccessToken: 'old-at',
      encryptedRefreshToken: 'old-rt',
      scope: 'calendar.read',
      expiresAt: null,
      refreshedAt: null,
      save: mockGrantSave,
    };

    mockFindOne.mockResolvedValue(buildLinkedAppProfile());
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
    expect(mockGrantSave).toHaveBeenCalled();
    expect(grant.scope).toBe('calendar.read calendar.write');
  });

  it('returns plaintext access token even when save() simulates encryption plugin overwriting the field', async () => {
    // Bug 1 regression: encryptionPlugin pre-save hook overwrites in-memory field with ciphertext.
    // Fix returns tokens.accessToken (raw OAuth response) instead of re-reading post-save document.
    const grant = {
      encryptedAccessToken: 'old-at',
      encryptedRefreshToken: 'old-rt',
      scope: 'calendar.read',
      expiresAt: null,
      refreshedAt: null,
      save: vi.fn().mockImplementation(async function (this: typeof grant) {
        this.encryptedAccessToken = 'AES256:iv:ciphertext:tag';
        this.encryptedRefreshToken = 'AES256:iv:ciphertext-rt:tag';
      }),
    };

    mockFindOne.mockResolvedValue(buildLinkedAppProfile());
    mockEndUserOAuthTokenFindOne.mockResolvedValue(grant);

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'plaintext-new-at',
        refresh_token: 'plaintext-new-rt',
        expires_in: 3600,
        scope: 'calendar.read',
      }),
    });

    const result = await refreshOAuth2Token({ profileId: 'app-1', tenantId: 't-1' }, buildDeps());

    expect(result.accessToken).toBe('plaintext-new-at');
    expect(result.refreshToken).toBe('plaintext-new-rt');
    expect(result.accessToken).not.toContain('AES256');
    expect(result.refreshToken).not.toContain('AES256');
  });

  it('falls back to existing refresh token when provider omits it from refresh response', async () => {
    // Google sometimes omits refresh_token when original grant had offline_access.
    const grant = {
      encryptedAccessToken: 'old-at',
      encryptedRefreshToken: 'keep-this-rt',
      scope: 'calendar.read',
      expiresAt: null,
      refreshedAt: null,
      save: vi.fn().mockResolvedValue(undefined),
    };

    mockFindOne.mockResolvedValue(buildLinkedAppProfile());
    mockEndUserOAuthTokenFindOne.mockResolvedValue(grant);

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new-at',
        // no refresh_token in response
        expires_in: 3600,
        scope: 'calendar.read',
      }),
    });

    const result = await refreshOAuth2Token({ profileId: 'app-1', tenantId: 't-1' }, buildDeps());

    expect(result.accessToken).toBe('new-at');
    expect(result.refreshToken).toBe('keep-this-rt');
  });

  it('releases the Redis lock even when the token fetch fails', async () => {
    const mockRelease = vi.fn().mockResolvedValue(undefined);
    mockAcquireRefreshLock.mockResolvedValueOnce({ acquired: true, release: mockRelease });

    const grant = {
      encryptedAccessToken: 'old-at',
      encryptedRefreshToken: 'old-rt',
      scope: 'calendar.read',
      expiresAt: null,
      refreshedAt: null,
      save: vi.fn(),
    };

    mockFindOne.mockResolvedValue(buildLinkedAppProfile());
    mockEndUserOAuthTokenFindOne.mockResolvedValue(grant);

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 401,
    });

    await expect(
      refreshOAuth2Token({ profileId: 'app-1', tenantId: 't-1', redis: {} as any }, buildDeps()),
    ).rejects.toThrow('Token refresh failed with status 401');

    expect(mockRelease).toHaveBeenCalled();
  });

  it('acquires Redis lock with correct key when redis client is provided', async () => {
    const mockRelease = vi.fn().mockResolvedValue(undefined);
    mockAcquireRefreshLock.mockResolvedValueOnce({ acquired: true, release: mockRelease });

    const grant = {
      encryptedAccessToken: 'old-at',
      encryptedRefreshToken: 'old-rt',
      scope: 'calendar.read',
      expiresAt: null,
      refreshedAt: null,
      save: vi.fn().mockResolvedValue(undefined),
    };

    mockFindOne.mockResolvedValue(buildLinkedAppProfile());
    mockEndUserOAuthTokenFindOne.mockResolvedValue(grant);

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600 }),
    });

    const fakeRedis = {} as any;
    await refreshOAuth2Token(
      { profileId: 'app-1', tenantId: 't-1', redis: fakeRedis },
      buildDeps(),
    );

    expect(mockAcquireRefreshLock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ redis: fakeRedis }),
    );
    expect(mockRelease).toHaveBeenCalled();
  });

  it('waits for the winning pod to persist a fresh durable grant before returning', async () => {
    mockAcquireRefreshLock.mockResolvedValueOnce({
      acquired: false,
      release: vi.fn().mockResolvedValue(undefined),
    });
    mockFindOne.mockResolvedValue(buildLinkedAppProfile());
    mockEndUserOAuthTokenFindOne
      .mockResolvedValueOnce({
        encryptedAccessToken: 'stale-at',
        encryptedRefreshToken: 'old-rt',
        expiresAt: new Date('2026-03-18T10:00:00.000Z'),
        refreshedAt: new Date('2026-03-18T09:00:00.000Z'),
        updatedAt: new Date('2026-03-18T09:00:00.000Z'),
        save: mockSave,
      })
      .mockResolvedValueOnce({
        encryptedAccessToken: 'fresh-at',
        encryptedRefreshToken: 'fresh-rt',
        expiresAt: new Date('2026-03-18T11:00:00.000Z'),
        refreshedAt: new Date('2026-03-18T09:00:01.000Z'),
        updatedAt: new Date('2026-03-18T09:00:01.000Z'),
        save: mockSave,
      });

    const result = await refreshOAuth2Token(
      { profileId: 'app-1', tenantId: 't-1', redis: {} as any },
      buildDeps(),
    );

    expect(result).toEqual({
      accessToken: 'fresh-at',
      refreshToken: 'fresh-rt',
      expiresAt: '2026-03-18T11:00:00.000Z',
      refreshed: false,
    });
  });

  it('refreshes session-scoped oauth artifacts when invoked with oauth2_app session context', async () => {
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

    mockFindOne.mockResolvedValue(buildLinkedAppProfile());
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

  it('waits for the winning pod to persist a fresh session oauth artifact before returning', async () => {
    mockAcquireRefreshLock.mockResolvedValueOnce({
      acquired: false,
      release: vi.fn().mockResolvedValue(undefined),
    });
    mockFindOne.mockResolvedValue(buildLinkedAppProfile());
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
});

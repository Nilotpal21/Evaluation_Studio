import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindOne = vi.fn();

vi.mock('@agent-platform/shared-observability', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('resolveOAuth2AppCredentials', () => {
  beforeEach(() => {
    mockFindOne.mockReset();
    vi.resetModules();
    vi.doMock('@agent-platform/database/models', () => ({
      AuthProfile: {
        findOne: (...args: unknown[]) => mockFindOne(...args),
      },
    }));
  });

  it('rejects expired oauth2_app profiles', async () => {
    const { resolveOAuth2AppCredentials } = await import('../oauth2-app-resolver.js');
    mockFindOne.mockResolvedValueOnce({
      _id: 'app-profile-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
      status: 'active',
      expiresAt: new Date(Date.now() - 60_000),
      encryptedSecrets: JSON.stringify({ clientId: 'cid', clientSecret: 'secret' }),
      config: {
        tokenUrl: 'https://auth.example.com/token',
        authorizationUrl: 'https://auth.example.com/authorize',
      },
    });

    await expect(
      resolveOAuth2AppCredentials({
        linkedAppProfileId: 'app-profile-1',
        tenantId: 'tenant-1',
      }),
    ).rejects.toThrow(/has expired/);
  });

  it('rejects non-HTTPS refresh URLs', async () => {
    const { resolveOAuth2AppCredentials } = await import('../oauth2-app-resolver.js');
    mockFindOne.mockResolvedValueOnce({
      _id: 'app-profile-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
      status: 'active',
      encryptedSecrets: JSON.stringify({ clientId: 'cid', clientSecret: 'secret' }),
      config: {
        tokenUrl: 'https://auth.example.com/token',
        refreshUrl: 'http://auth.example.com/refresh',
        authorizationUrl: 'https://auth.example.com/authorize',
      },
    });

    await expect(
      resolveOAuth2AppCredentials({
        linkedAppProfileId: 'app-profile-1',
        tenantId: 'tenant-1',
      }),
    ).rejects.toThrow(/refreshUrl must use HTTPS/);
  });

  it('rejects linked app profiles outside expected project/owner boundaries', async () => {
    const { resolveOAuth2AppCredentials } = await import('../oauth2-app-resolver.js');
    mockFindOne.mockResolvedValueOnce({
      _id: 'app-profile-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
      status: 'active',
      scope: 'project',
      visibility: 'personal',
      projectId: 'project-2',
      createdBy: 'user-2',
      encryptedSecrets: JSON.stringify({ clientId: 'cid', clientSecret: 'secret' }),
      config: {
        tokenUrl: 'https://auth.example.com/token',
        authorizationUrl: 'https://auth.example.com/authorize',
      },
    });

    await expect(
      resolveOAuth2AppCredentials({
        linkedAppProfileId: 'app-profile-1',
        tenantId: 'tenant-1',
        expectedScope: 'project',
        expectedVisibility: 'personal',
        expectedProjectId: 'project-1',
        expectedOwnerId: 'user-1',
      }),
    ).rejects.toThrow(/same project/);
  });

  it('rejects project-scoped validation when project context is missing', async () => {
    const { resolveOAuth2AppCredentials } = await import('../oauth2-app-resolver.js');
    mockFindOne.mockResolvedValueOnce({
      _id: 'app-profile-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
      status: 'active',
      scope: 'project',
      visibility: 'shared',
      projectId: 'project-1',
      encryptedSecrets: JSON.stringify({ clientId: 'cid', clientSecret: 'secret' }),
      config: {
        tokenUrl: 'https://auth.example.com/token',
        authorizationUrl: 'https://auth.example.com/authorize',
      },
    });

    await expect(
      resolveOAuth2AppCredentials({
        linkedAppProfileId: 'app-profile-1',
        tenantId: 'tenant-1',
        expectedScope: 'project',
      }),
    ).rejects.toThrow(/requires a projectId context/);
  });

  it('returns revocationUrl when configured', async () => {
    const { resolveOAuth2AppCredentials } = await import('../oauth2-app-resolver.js');
    mockFindOne.mockResolvedValueOnce({
      _id: 'app-profile-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
      status: 'active',
      encryptedSecrets: JSON.stringify({ clientId: 'cid', clientSecret: 'secret' }),
      config: {
        tokenUrl: 'https://auth.example.com/token',
        authorizationUrl: 'https://auth.example.com/authorize',
        revocationUrl: 'https://auth.example.com/revoke',
      },
    });

    const result = await resolveOAuth2AppCredentials({
      linkedAppProfileId: 'app-profile-1',
      tenantId: 'tenant-1',
    });

    expect(result.revocationUrl).toBe('https://auth.example.com/revoke');
  });
});

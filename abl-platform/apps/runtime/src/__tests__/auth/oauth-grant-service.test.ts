import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockFindEndUserOAuthTokens = vi.fn();
vi.mock('@agent-platform/shared/repos', () => ({
  findEndUserOAuthTokens: (...args: unknown[]) => mockFindEndUserOAuthTokens(...args),
}));

const mockResolveByName = vi.fn();
vi.mock('../../services/auth-profile-resolver.js', () => ({
  resolveByName: (...args: unknown[]) => mockResolveByName(...args),
  getAuthProfileCache: vi.fn(),
  resolveAuthProfileCredentials: vi.fn(),
}));

const mockGetAccessToken = vi.fn();
const mockRevokeToken = vi.fn();
const mockGetToolOAuthService = vi.fn();
vi.mock('../../services/tool-oauth-service-singleton.js', () => ({
  getToolOAuthService: () => mockGetToolOAuthService(),
}));

const mockAuthProfileFind = vi.fn();
const mockAuthProfileFindOne = vi.fn();
const mockAuthProfileUpdateMany = vi.fn();
const mockEndUserOAuthTokenUpdateMany = vi.fn();
vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: {
    find: (...args: unknown[]) => mockAuthProfileFind(...args),
    findOne: (...args: unknown[]) => mockAuthProfileFindOne(...args),
    updateMany: (...args: unknown[]) => mockAuthProfileUpdateMany(...args),
  },
  EndUserOAuthToken: {
    updateMany: (...args: unknown[]) => mockEndUserOAuthTokenUpdateMany(...args),
  },
}));

import {
  listOAuthGrantTokensForUser,
  resolveOAuthGrantAccessToken,
  revokeOAuthGrantForUser,
} from '../../services/oauth-grant-service.js';

function futureIso(): string {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

describe('oauth-grant-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccessToken.mockReset();
    mockRevokeToken.mockReset();
    mockGetToolOAuthService.mockReturnValue({
      getAccessToken: (...args: unknown[]) => mockGetAccessToken(...args),
      revokeToken: (...args: unknown[]) => mockRevokeToken(...args),
    });
  });

  it('does not fall back from an oauth2_app ref to linked legacy oauth2_token profiles', async () => {
    mockResolveByName.mockResolvedValue({
      profileId: 'app-1',
      name: 'google-app',
      authType: 'oauth2_app',
      projectId: 'project-1',
      config: {},
      secrets: {},
    });
    mockGetAccessToken.mockResolvedValue(undefined);

    const result = await resolveOAuthGrantAccessToken({
      tenantId: 'tenant-1',
      authProfileRef: 'google-app',
      projectId: 'project-1',
      environment: 'production',
      userId: 'user-1',
      lookupScope: 'user',
      authScope: 'user',
      scopes: ['gmail.readonly'],
    });

    expect(result).toBeNull();
    expect(mockAuthProfileFindOne).not.toHaveBeenCalled();
  });

  it('does not resolve oauth2_token refs through the canonical grant store', async () => {
    mockResolveByName.mockResolvedValue({
      profileId: 'token-1',
      name: 'google-token',
      authType: 'oauth2_token',
      linkedAppProfileId: 'app-1',
      config: {
        expiresAt: futureIso(),
      },
      secrets: {
        accessToken: 'legacy-access-token',
      },
    });
    mockGetAccessToken.mockResolvedValue('durable-access-token');

    const result = await resolveOAuthGrantAccessToken({
      tenantId: 'tenant-1',
      authProfileRef: 'google-token',
      userId: 'user-1',
      lookupScope: 'user',
      authScope: 'user',
    });

    expect(result).toBeNull();
    expect(mockGetAccessToken).not.toHaveBeenCalled();
  });

  it('deduplicates durable and legacy OAuth records onto canonical provider keys', async () => {
    mockFindEndUserOAuthTokens.mockResolvedValue([
      {
        provider: 'auth-profile:app-1',
        expiresAt: '2026-04-04T00:00:00.000Z',
        consentedAt: '2026-04-01T00:00:00.000Z',
      },
      {
        provider: 'google',
        consentedAt: '2026-03-01T00:00:00.000Z',
      },
    ]);
    mockAuthProfileFind
      .mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue([
              {
                _id: 'legacy-1',
                name: 'Google Legacy Token',
                tenantId: 'tenant-1',
                authType: 'oauth2_token',
                config: { expiresAt: '2026-04-05T00:00:00.000Z' },
                status: 'active',
                visibility: 'personal',
                createdBy: 'user-1',
                linkedAppProfileId: 'app-1',
                createdAt: '2026-03-31T00:00:00.000Z',
                updatedAt: '2026-03-31T12:00:00.000Z',
              },
              {
                _id: 'legacy-2',
                name: 'Jira Legacy Token',
                tenantId: 'tenant-1',
                authType: 'oauth2_token',
                config: { expiresAt: '2026-04-06T00:00:00.000Z' },
                status: 'active',
                visibility: 'personal',
                createdBy: 'user-1',
                linkedAppProfileId: 'app-2',
                createdAt: '2026-04-02T00:00:00.000Z',
                updatedAt: '2026-04-02T08:00:00.000Z',
              },
            ]),
          }),
        }),
      })
      .mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([
            { _id: 'app-1', name: 'Google App', status: 'active' },
            { _id: 'app-2', name: 'Jira App', status: 'active' },
          ]),
        }),
      });

    const result = await listOAuthGrantTokensForUser({
      tenantId: 'tenant-1',
      userId: 'user-1',
      page: 1,
      limit: 10,
    });

    expect(result.total).toBe(3);
    expect(result.tokens).toEqual([
      expect.objectContaining({
        provider: 'auth-profile:app-2',
        metadata: expect.objectContaining({
          source: 'legacy_oauth2_token_profile',
          authProfileName: 'Jira App',
        }),
      }),
      expect.objectContaining({
        provider: 'auth-profile:app-1',
        metadata: expect.objectContaining({
          source: 'oauth_grant_store',
          authProfileName: 'Google App',
        }),
      }),
      expect.objectContaining({
        provider: 'google',
        metadata: expect.objectContaining({
          source: 'oauth_grant_store',
        }),
      }),
    ]);
  });

  it('revokes durable grants without mutating linked legacy oauth2_token profiles', async () => {
    mockRevokeToken.mockResolvedValue(undefined);

    await revokeOAuthGrantForUser({
      tenantId: 'tenant-1',
      userId: 'user-1',
      provider: 'auth-profile:app-1',
    });

    expect(mockRevokeToken).toHaveBeenCalledWith('tenant-1', 'user-1', 'auth-profile:app-1');
    expect(mockAuthProfileUpdateMany).not.toHaveBeenCalled();
  });
});

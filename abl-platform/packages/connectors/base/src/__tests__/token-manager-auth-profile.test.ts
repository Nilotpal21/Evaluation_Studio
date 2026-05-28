/**
 * TokenManager — Auth Profile Resolution Tests
 *
 * Tests the auth profile dual-read integration in TokenManager.
 * When authProfileId and resolver are provided, getAccessToken()
 * checks auth profiles before falling through to the legacy token path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TokenManager } from '../auth/token-manager.js';
import type { TokenManagerAuthProfileResolver } from '../auth/token-manager.js';
import type { IOAuthProvider } from '../interfaces/oauth-provider.interface.js';

vi.mock('@agent-platform/database', () => ({}));

function createMockProvider(): IOAuthProvider {
  return {
    providerName: 'google',
    getAuthorizationUrl: vi.fn(),
    exchangeCode: vi.fn(),
    refreshToken: vi.fn(),
    revokeToken: vi.fn(),
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    needsRefresh: vi.fn().mockReturnValue(false),
  } as unknown as IOAuthProvider;
}

function createMockTokenModel() {
  return {
    findOne: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    updateOne: vi.fn().mockResolvedValue({
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1,
    }),
  } as any;
}

describe('TokenManager — Auth Profile resolution', () => {
  let mockProvider: IOAuthProvider;
  let mockTokenModel: any;
  let mockResolver: TokenManagerAuthProfileResolver;

  beforeEach(() => {
    mockProvider = createMockProvider();
    mockTokenModel = createMockTokenModel();
    mockResolver = {
      resolveToken: vi.fn().mockResolvedValue(null),
    };
  });

  it('resolves token from auth profile when resolver returns a match', async () => {
    (mockResolver.resolveToken as any).mockResolvedValue({
      accessToken: 'profile-access-token',
      expiresAt: new Date(Date.now() + 3600000),
    });

    const manager = new TokenManager(mockProvider, 'tenant-1', 'user-1', mockTokenModel, {
      authProfileId: 'auth-prof-1',
      authProfileResolver: mockResolver,
    });

    const result = await manager.getAccessToken();

    expect(result).toBe('profile-access-token');
    expect(mockResolver.resolveToken).toHaveBeenCalledWith({
      authProfileId: 'auth-prof-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
    });
    // Should NOT have queried the legacy token model
    expect(mockTokenModel.findOne).not.toHaveBeenCalled();
  });

  it('falls through to legacy token when auth profile returns null', async () => {
    (mockResolver.resolveToken as any).mockResolvedValue(null);

    const existingToken = {
      _id: 'token-1',
      encryptedAccessToken: 'legacy-token',
      expiresAt: new Date(Date.now() + 3600000),
      lastUsedAt: null,
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockTokenModel.findOne.mockResolvedValue(existingToken);

    const manager = new TokenManager(mockProvider, 'tenant-1', 'user-1', mockTokenModel, {
      authProfileId: 'auth-prof-1',
      authProfileResolver: mockResolver,
    });

    const result = await manager.getAccessToken();

    expect(mockResolver.resolveToken).toHaveBeenCalled();
    expect(mockTokenModel.findOne).toHaveBeenCalled();
    expect(mockTokenModel.updateOne).toHaveBeenCalledWith(
      { _id: 'token-1' },
      { $set: { lastUsedAt: expect.any(Date) } },
    );
    expect(result).toBe('legacy-token');
  });

  it('falls through to legacy token when resolver throws', async () => {
    (mockResolver.resolveToken as any).mockRejectedValue(new Error('Profile not found'));

    const existingToken = {
      _id: 'token-2',
      encryptedAccessToken: 'fallback-token',
      expiresAt: new Date(Date.now() + 3600000),
      lastUsedAt: null,
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockTokenModel.findOne.mockResolvedValue(existingToken);

    const manager = new TokenManager(mockProvider, 'tenant-1', 'user-1', mockTokenModel, {
      authProfileId: 'auth-prof-1',
      authProfileResolver: mockResolver,
    });

    const result = await manager.getAccessToken();

    expect(result).toBe('fallback-token');
  });

  it('skips auth profile when no authProfileId provided', async () => {
    const existingToken = {
      _id: 'token-3',
      encryptedAccessToken: 'direct-token',
      expiresAt: new Date(Date.now() + 3600000),
      lastUsedAt: null,
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockTokenModel.findOne.mockResolvedValue(existingToken);

    const manager = new TokenManager(mockProvider, 'tenant-1', 'user-1', mockTokenModel);

    const result = await manager.getAccessToken();

    expect(result).toBe('direct-token');
    expect(mockResolver.resolveToken).not.toHaveBeenCalled();
  });

  it('skips auth profile when no resolver provided even with authProfileId', async () => {
    const existingToken = {
      _id: 'token-4',
      encryptedAccessToken: 'no-resolver-token',
      expiresAt: new Date(Date.now() + 3600000),
      lastUsedAt: null,
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockTokenModel.findOne.mockResolvedValue(existingToken);

    const manager = new TokenManager(mockProvider, 'tenant-1', 'user-1', mockTokenModel, {
      authProfileId: 'auth-prof-1',
      // No resolver
    });

    const result = await manager.getAccessToken();

    expect(result).toBe('no-resolver-token');
  });
});

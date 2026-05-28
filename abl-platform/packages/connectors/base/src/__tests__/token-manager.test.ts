/**
 * TokenManager Tests
 *
 * Tests OAuth token lifecycle: storage, refresh, expiry detection.
 *
 * Tests the current API:
 *   new TokenManager(provider, tenantId, userId, tokenModel, options?)
 *   .storeTokens(tokens, providerUserId) / .getAccessToken() / .revokeToken()
 *   .validateToken()
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TokenManager, TokenManagerError } from '../auth/token-manager.js';
import type { IOAuthProvider } from '../interfaces/oauth-provider.interface.js';

// ─── Mock OAuth Provider ──────────────────────────────────────────────────

class MockOAuthProvider implements IOAuthProvider {
  readonly providerName = 'mock';
  readonly clientId = 'test-client-id';

  async requestDeviceCode(_scopes: string[]) {
    return {
      deviceCode: 'device-123',
      userCode: 'ABCD-1234',
      verificationUri: 'https://example.com/device',
      expiresIn: 900,
      interval: 5,
    };
  }

  async exchangeDeviceCode(_deviceCode: string) {
    return {
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      tokenType: 'Bearer',
      expiresIn: 3600,
      scope: 'read write',
    };
  }

  getAuthorizationUrl() {
    return 'https://example.com/authorize';
  }

  async exchangeAuthorizationCode() {
    return {
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      tokenType: 'Bearer',
      expiresIn: 3600,
      scope: 'read write',
    };
  }

  async acquireClientCredentialsToken() {
    return {
      accessToken: 'client-cred-token',
      refreshToken: null,
      tokenType: 'Bearer',
      expiresIn: 3600,
      scope: '.default',
    };
  }

  async refreshToken(_refreshToken: string) {
    return {
      accessToken: 'refreshed-access-token',
      refreshToken: 'refreshed-refresh-token',
      expiresIn: 3600,
    };
  }

  async revokeToken(_token: string): Promise<void> {
    // Mock implementation
  }

  async validateToken(
    _accessToken: string,
  ): Promise<{ valid: boolean; expiresAt: Date | null; scopes: string[] }> {
    return {
      valid: true,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      scopes: ['read', 'write'],
    };
  }

  needsRefresh(expiresAt: Date, bufferMinutes = 5): boolean {
    const bufferMs = bufferMinutes * 60 * 1000;
    return Date.now() + bufferMs >= expiresAt.getTime();
  }
}

// ─── Mock Token Model ─────────────────────────────────────────────────────

function createMockTokenModel() {
  const tokens: any[] = [];

  return {
    findOne: vi.fn().mockImplementation((query: any) => {
      const match = tokens.find(
        (t: any) =>
          t.tenantId === query.tenantId &&
          t.userId === query.userId &&
          t.provider === query.provider &&
          (query.revokedAt === null ? !t.revokedAt : true),
      );
      return Promise.resolve(match || null);
    }),
    create: vi.fn().mockImplementation((data: any) => {
      const doc = {
        _id: 'token-' + Date.now(),
        ...data,
        save: vi.fn().mockImplementation(async function (this: any) {
          return this;
        }),
      };
      tokens.push(doc);
      return Promise.resolve(doc);
    }),
    updateOne: vi.fn().mockResolvedValue({
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1,
    }),
    _tokens: tokens,
    _reset: () => {
      tokens.length = 0;
    },
  } as any;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('TokenManager', () => {
  let tokenManager: TokenManager;
  let mockProvider: MockOAuthProvider;
  let mockTokenModel: ReturnType<typeof createMockTokenModel>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider = new MockOAuthProvider();
    mockTokenModel = createMockTokenModel();
    tokenManager = new TokenManager(mockProvider, 'tenant-123', 'user-123', mockTokenModel);
  });

  describe('storeTokens', () => {
    it('should store tokens in database', async () => {
      const result = await tokenManager.storeTokens(
        {
          accessToken: 'access-123',
          refreshToken: 'refresh-123',
          scope: 'read write',
          expiresIn: 3600,
        },
        'provider-user-123',
      );

      expect(result._id).toBeDefined();
      expect(mockTokenModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-123',
          userId: 'user-123',
          provider: 'mock',
          providerUserId: 'provider-user-123',
          encryptedAccessToken: 'access-123',
          encryptedRefreshToken: 'refresh-123',
          scope: 'read write',
          expiresAt: expect.any(Date),
          consentedAt: expect.any(Date),
        }),
      );
    });

    it('should calculate correct expiry time', async () => {
      const now = Date.now();
      await tokenManager.storeTokens(
        {
          accessToken: 'access-123',
          refreshToken: 'refresh-123',
          scope: 'read write',
          expiresIn: 3600,
        },
        'provider-user-123',
      );

      const createCall = mockTokenModel.create.mock.calls[0][0];
      const expiresAt = createCall.expiresAt.getTime();

      // Should expire in ~3600 seconds (1 hour)
      expect(expiresAt).toBeGreaterThan(now + 3500000);
      expect(expiresAt).toBeLessThan(now + 3700000);
    });

    it('should update existing token if one exists', async () => {
      // Store initial token
      await tokenManager.storeTokens(
        {
          accessToken: 'access-v1',
          refreshToken: 'refresh-v1',
          scope: 'read',
          expiresIn: 3600,
        },
        'provider-user-123',
      );

      // Mock findOne to return the existing token
      const existingToken = mockTokenModel._tokens[0];
      mockTokenModel.findOne.mockResolvedValueOnce(existingToken);

      // Store updated token
      await tokenManager.storeTokens(
        {
          accessToken: 'access-v2',
          refreshToken: 'refresh-v2',
          scope: 'read write',
          expiresIn: 7200,
        },
        'provider-user-123',
      );

      // Should have called save on the existing token, not create a new one
      expect(existingToken.save).toHaveBeenCalled();
      expect(existingToken.encryptedAccessToken).toBe('access-v2');
    });
  });

  describe('getAccessToken', () => {
    it('should return valid token without refresh', async () => {
      // Set up a valid (non-expired) token in the model
      const validToken = {
        _id: 'token-123',
        tenantId: 'tenant-123',
        userId: 'user-123',
        provider: 'mock',
        encryptedAccessToken: 'valid-access-token',
        encryptedRefreshToken: 'refresh-token',
        expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 min from now
        lastUsedAt: null,
        save: vi.fn().mockResolvedValue(true),
      };
      mockTokenModel.findOne.mockResolvedValueOnce(validToken);

      const accessToken = await tokenManager.getAccessToken();

      expect(accessToken).toBe('valid-access-token');
      expect(mockTokenModel.updateOne).toHaveBeenCalledWith(
        { _id: 'token-123' },
        { $set: { lastUsedAt: expect.any(Date) } },
      );
    });

    it('should refresh token when near expiry', async () => {
      // Token expires in 3 minutes (less than 5-minute buffer)
      const expiringSoonToken = {
        _id: 'token-123',
        tenantId: 'tenant-123',
        userId: 'user-123',
        provider: 'mock',
        encryptedAccessToken: 'old-access-token',
        encryptedRefreshToken: 'refresh-token',
        expiresAt: new Date(Date.now() + 3 * 60 * 1000), // 3 min from now
        save: vi.fn().mockResolvedValue(true),
      };
      mockTokenModel.findOne.mockResolvedValueOnce(expiringSoonToken);

      const refreshSpy = vi.spyOn(mockProvider, 'refreshToken');
      const accessToken = await tokenManager.getAccessToken();

      expect(refreshSpy).toHaveBeenCalledWith('refresh-token');
      expect(accessToken).toBe('refreshed-access-token');
      expect(expiringSoonToken.save).toHaveBeenCalled();
    });

    it('should throw error when token not found', async () => {
      mockTokenModel.findOne.mockResolvedValueOnce(null);
      await expect(tokenManager.getAccessToken()).rejects.toThrow(TokenManagerError);

      mockTokenModel.findOne.mockResolvedValueOnce(null);
      await expect(tokenManager.getAccessToken()).rejects.toThrow('No OAuth token found');
    });

    it('should throw error when token has no refresh token', async () => {
      // Token near expiry but no refresh token
      const noRefreshToken = {
        _id: 'token-123',
        tenantId: 'tenant-123',
        userId: 'user-123',
        provider: 'mock',
        encryptedAccessToken: 'old-token',
        encryptedRefreshToken: null, // No refresh token
        expiresAt: new Date(Date.now() + 2 * 60 * 1000), // 2 min (needs refresh)
        save: vi.fn().mockResolvedValue(true),
      };
      mockTokenModel.findOne.mockResolvedValueOnce(noRefreshToken);

      await expect(tokenManager.getAccessToken()).rejects.toThrow('No refresh token available');
    });
  });

  describe('revokeToken', () => {
    it('should revoke token at provider and mark in database', async () => {
      const token = {
        _id: 'token-123',
        tenantId: 'tenant-123',
        userId: 'user-123',
        provider: 'mock',
        encryptedAccessToken: 'access-token',
        encryptedRefreshToken: 'refresh-token',
        expiresAt: new Date(Date.now() + 3600000),
        revokedAt: null as Date | null,
        save: vi.fn().mockResolvedValue(true),
      };
      mockTokenModel.findOne.mockResolvedValueOnce(token);

      const revokeSpy = vi.spyOn(mockProvider, 'revokeToken');
      await tokenManager.revokeToken();

      expect(revokeSpy).toHaveBeenCalledWith('access-token');
      expect(token.revokedAt).toBeInstanceOf(Date);
      expect(token.save).toHaveBeenCalled();
    });

    it('should throw when no token exists', async () => {
      mockTokenModel.findOne.mockResolvedValueOnce(null);

      await expect(tokenManager.revokeToken()).rejects.toThrow(TokenManagerError);
    });
  });

  describe('validateToken', () => {
    it('should return true for valid token', async () => {
      const token = {
        _id: 'token-123',
        tenantId: 'tenant-123',
        userId: 'user-123',
        provider: 'mock',
        encryptedAccessToken: 'valid-token',
        expiresAt: new Date(Date.now() + 3600000),
        save: vi.fn(),
      };
      mockTokenModel.findOne.mockResolvedValueOnce(token);

      const valid = await tokenManager.validateToken();
      expect(valid).toBe(true);
    });

    it('should return false when token not found', async () => {
      mockTokenModel.findOne.mockResolvedValueOnce(null);

      const valid = await tokenManager.validateToken();
      expect(valid).toBe(false);
    });

    it('should return false when provider validation fails', async () => {
      const token = {
        _id: 'token-123',
        tenantId: 'tenant-123',
        userId: 'user-123',
        provider: 'mock',
        encryptedAccessToken: 'invalid-token',
        expiresAt: new Date(Date.now() + 3600000),
        save: vi.fn(),
      };
      mockTokenModel.findOne.mockResolvedValueOnce(token);

      vi.spyOn(mockProvider, 'validateToken').mockResolvedValueOnce({
        valid: false,
        expiresAt: null,
        scopes: [],
      });

      const valid = await tokenManager.validateToken();
      expect(valid).toBe(false);
    });
  });
});

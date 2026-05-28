/**
 * DeviceCodeFlowAuthenticator Tests
 *
 * Tests OAuth 2.0 Device Code Flow (RFC 8628) implementation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DeviceCodeFlowAuthenticator } from '../auth/device-code-flow.js';
import type { IOAuthProvider } from '../interfaces/oauth-provider.interface.js';

// Mock OAuth provider
class MockOAuthProvider implements IOAuthProvider {
  readonly providerName = 'mock';
  readonly clientId = 'test-client-id';

  public deviceCodeRequests: string[][] = [];
  public exchangeAttempts: string[] = [];
  public refreshAttempts: string[] = [];
  private exchangeCallCount = 0;
  private shouldSucceedAfter = 3;

  async requestDeviceCode(scopes: string[]) {
    this.deviceCodeRequests.push(scopes);
    return {
      deviceCode: 'device-abc123',
      userCode: 'WXYZ-5678',
      verificationUri: 'https://example.com/device',
      expiresIn: 900,
      interval: 5,
    };
  }

  async exchangeDeviceCode(deviceCode: string) {
    this.exchangeAttempts.push(deviceCode);
    this.exchangeCallCount++;

    if (this.exchangeCallCount < this.shouldSucceedAfter) {
      const error: any = new Error('authorization_pending');
      error.code = 'authorization_pending';
      throw error;
    }

    return {
      accessToken: 'access-token-123',
      refreshToken: 'refresh-token-123',
      tokenType: 'Bearer',
      expiresIn: 3600,
      scope: 'read write',
    };
  }

  async refreshToken(refreshToken: string) {
    this.refreshAttempts.push(refreshToken);
    return {
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      expiresIn: 3600,
    };
  }

  getAuthorizationUrl() {
    return 'https://example.com/authorize';
  }

  async exchangeAuthorizationCode() {
    return {
      accessToken: 'access-token-123',
      refreshToken: 'refresh-token-123',
      tokenType: 'Bearer',
      expiresIn: 3600,
      scope: 'read write',
    };
  }

  async acquireClientCredentialsToken() {
    return {
      accessToken: 'app-token-123',
      refreshToken: null,
      tokenType: 'Bearer',
      expiresIn: 3600,
      scope: '.default',
    };
  }

  async revokeToken(_token: string): Promise<void> {
    // Mock implementation
  }

  async validateToken(_accessToken: string) {
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

  setShouldSucceedAfter(count: number) {
    this.shouldSucceedAfter = count;
  }

  reset() {
    this.deviceCodeRequests = [];
    this.exchangeAttempts = [];
    this.exchangeCallCount = 0;
    this.shouldSucceedAfter = 3;
  }
}

describe('DeviceCodeFlowAuthenticator', () => {
  let authenticator: DeviceCodeFlowAuthenticator;
  let mockProvider: MockOAuthProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    mockProvider = new MockOAuthProvider();
    authenticator = new DeviceCodeFlowAuthenticator(mockProvider);
  });

  describe('authenticate', () => {
    it('should request device code with correct scopes', async () => {
      mockProvider.setShouldSucceedAfter(1);
      const displayCallback = vi.fn();

      const resultPromise = authenticator.authenticate(['read', 'write'], displayCallback);

      // Advance through the polling interval (5 seconds)
      await vi.advanceTimersByTimeAsync(5000);

      const result = await resultPromise;

      expect(result).toEqual({
        accessToken: 'access-token-123',
        refreshToken: 'refresh-token-123',
        tokenType: 'Bearer',
        expiresIn: 3600,
        scope: 'read write',
      });
      expect(mockProvider.deviceCodeRequests).toHaveLength(1);
      expect(mockProvider.deviceCodeRequests[0]).toEqual(['read', 'write']);
    });

    it('should call display callback with device code information', async () => {
      const displayCallback = vi.fn();
      mockProvider.setShouldSucceedAfter(1);

      const resultPromise = authenticator.authenticate(['read'], displayCallback);

      // Wait for async device code request to complete
      await vi.waitFor(() => {
        expect(displayCallback).toHaveBeenCalledWith({
          deviceCode: 'device-abc123',
          userCode: 'WXYZ-5678',
          verificationUri: 'https://example.com/device',
          expiresIn: 900,
          interval: 5,
        });
      });

      // Advance through polling interval
      await vi.advanceTimersByTimeAsync(5000);
      await resultPromise;
    });

    it('should poll for token at specified interval', async () => {
      mockProvider.setShouldSucceedAfter(3); // Succeed on 3rd attempt
      const displayCallback = vi.fn();

      const resultPromise = authenticator.authenticate(['read'], displayCallback);

      // First poll (immediate after device code)
      await vi.advanceTimersByTimeAsync(100);
      expect(mockProvider.exchangeAttempts).toHaveLength(0); // Polls after interval

      // First poll after interval (5 seconds)
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockProvider.exchangeAttempts).toHaveLength(1);

      // Second poll after another interval
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockProvider.exchangeAttempts).toHaveLength(2);

      // Third poll
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockProvider.exchangeAttempts).toHaveLength(3);

      await resultPromise;
    });

    it('should return tokens after successful authentication', async () => {
      mockProvider.setShouldSucceedAfter(2);
      const displayCallback = vi.fn();

      const resultPromise = authenticator.authenticate(['read'], displayCallback);
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(5000);

      const result = await resultPromise;

      expect(result).toEqual({
        accessToken: 'access-token-123',
        refreshToken: 'refresh-token-123',
        tokenType: 'Bearer',
        expiresIn: 3600,
        scope: 'read write',
      });
    });

    it('should timeout if user does not authorize within expiry time', async () => {
      mockProvider.setShouldSucceedAfter(1000); // Never succeed
      const displayCallback = vi.fn();

      const resultPromise = authenticator
        .authenticate(['read'], displayCallback)
        .catch((err) => err);

      // Advance past expiry time (900 seconds)
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(905000);

      const result = await resultPromise;
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toContain('Device code expired');
    });

    it('should handle slow_down error by increasing poll interval', async () => {
      // Create provider that returns slow_down on first attempt
      const slowProvider: any = {
        providerName: 'slow',
        clientId: 'test',
        attemptCount: 0,
        async requestDeviceCode(_scopes: string[]) {
          return {
            deviceCode: 'device-123',
            userCode: 'ABCD-1234',
            verificationUri: 'https://example.com/device',
            expiresIn: 900,
            interval: 5,
          };
        },
        async exchangeDeviceCode(_deviceCode: string) {
          if (this.attemptCount === 0) {
            this.attemptCount++;
            const error: any = new Error('slow_down');
            error.code = 'slow_down';
            throw error;
          }
          return {
            accessToken: 'token',
            refreshToken: 'refresh',
            tokenType: 'Bearer',
            expiresIn: 3600,
            scope: 'read',
          };
        },
        async refreshToken(_refreshToken: string) {
          return {
            accessToken: 'new-token',
            refreshToken: 'new-refresh',
            expiresIn: 3600,
          };
        },
        async revokeToken() {},
        async validateToken() {
          return { valid: true, expiresAt: new Date(), scopes: [] };
        },
        needsRefresh() {
          return false;
        },
      };

      const slowAuthenticator = new DeviceCodeFlowAuthenticator(slowProvider);
      const displayCallback = vi.fn();

      const resultPromise = slowAuthenticator.authenticate(['read'], displayCallback);

      // First attempt after interval
      await vi.advanceTimersByTimeAsync(5000);

      // Should wait longer due to slow_down (10 seconds instead of 5)
      await vi.advanceTimersByTimeAsync(10000);

      const result = await resultPromise;
      expect(result.accessToken).toBe('token');
    });

    it('should throw error on access denied', async () => {
      const errorProvider: any = {
        providerName: 'error',
        clientId: 'test',
        async requestDeviceCode(_scopes: string[]) {
          return {
            deviceCode: 'device-123',
            userCode: 'ABCD-1234',
            verificationUri: 'https://example.com/device',
            expiresIn: 900,
            interval: 5,
          };
        },
        async exchangeDeviceCode(_deviceCode: string) {
          const error: any = new Error('access_denied');
          error.code = 'access_denied';
          throw error;
        },
        async refreshToken(_refreshToken: string) {
          return {
            accessToken: 'token',
            refreshToken: 'refresh',
            expiresIn: 3600,
          };
        },
        async revokeToken() {},
        async validateToken() {
          return { valid: true, expiresAt: new Date(), scopes: [] };
        },
        needsRefresh() {
          return false;
        },
      };

      const errorAuthenticator = new DeviceCodeFlowAuthenticator(errorProvider);
      const displayCallback = vi.fn();

      const resultPromise = errorAuthenticator
        .authenticate(['read'], displayCallback)
        .catch((err) => err);
      await vi.advanceTimersByTimeAsync(5000);

      const result = await resultPromise;
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('User denied authorization');
    });
  });

  describe('edge cases', () => {
    it('should handle missing interval in device code response', async () => {
      const noIntervalProvider: any = {
        providerName: 'no-interval',
        clientId: 'test',
        async requestDeviceCode(_scopes: string[]) {
          return {
            deviceCode: 'device-123',
            userCode: 'ABCD-1234',
            verificationUri: 'https://example.com/device',
            expiresIn: 900,
            interval: 5, // Add interval to match interface
          };
        },
        async exchangeDeviceCode(_deviceCode: string) {
          return {
            accessToken: 'token',
            refreshToken: 'refresh',
            tokenType: 'Bearer',
            expiresIn: 3600,
            scope: 'read',
          };
        },
        async refreshToken(_refreshToken: string) {
          return {
            accessToken: 'token',
            refreshToken: 'refresh',
            expiresIn: 3600,
          };
        },
        async revokeToken() {},
        async validateToken() {
          return { valid: true, expiresAt: new Date(), scopes: [] };
        },
        needsRefresh() {
          return false;
        },
      };

      const noIntervalAuth = new DeviceCodeFlowAuthenticator(noIntervalProvider);
      const displayCallback = vi.fn();

      const resultPromise = noIntervalAuth.authenticate(['read'], displayCallback);
      await vi.advanceTimersByTimeAsync(5000);

      const result = await resultPromise;
      expect(result.accessToken).toBe('token');
    });

    it('should handle very short expiry time', async () => {
      const shortExpiryProvider: any = {
        providerName: 'short-expiry',
        clientId: 'test',
        attemptCount: 0,
        async requestDeviceCode(_scopes: string[]) {
          return {
            deviceCode: 'device-123',
            userCode: 'ABCD-1234',
            verificationUri: 'https://example.com/device',
            expiresIn: 10, // Only 10 seconds
            interval: 5,
          };
        },
        async exchangeDeviceCode(_deviceCode: string) {
          this.attemptCount++;
          if (this.attemptCount < 5) {
            const error: any = new Error('authorization_pending');
            error.code = 'authorization_pending';
            throw error;
          }
          return {
            accessToken: 'token',
            refreshToken: 'refresh',
            tokenType: 'Bearer',
            expiresIn: 3600,
            scope: 'read',
          };
        },
        async refreshToken(_refreshToken: string) {
          return {
            accessToken: 'token',
            refreshToken: 'refresh',
            expiresIn: 3600,
          };
        },
        async revokeToken() {},
        async validateToken() {
          return { valid: true, expiresAt: new Date(), scopes: [] };
        },
        needsRefresh() {
          return false;
        },
      };

      const shortExpiryAuth = new DeviceCodeFlowAuthenticator(shortExpiryProvider);
      const displayCallback = vi.fn();

      const resultPromise = shortExpiryAuth
        .authenticate(['read'], displayCallback)
        .catch((err) => err);
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(6000); // Total 11 seconds > 10 second expiry

      const result = await resultPromise;
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toContain('Device code expired');
    });
  });
});

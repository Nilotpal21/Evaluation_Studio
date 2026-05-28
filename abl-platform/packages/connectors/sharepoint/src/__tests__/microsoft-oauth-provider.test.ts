/**
 * MicrosoftOAuthProvider Tests
 *
 * Tests Azure AD OAuth implementation for SharePoint.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MicrosoftOAuthProvider } from '../auth/microsoft-oauth-provider.js';

// Mock fetch globally
global.fetch = vi.fn();

describe('MicrosoftOAuthProvider', () => {
  let provider: MicrosoftOAuthProvider;

  beforeEach(() => {
    provider = new MicrosoftOAuthProvider({
      clientId: 'test-client-id',
      tenantId: 'common',
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('requestDeviceCode', () => {
    it('should request device code from Microsoft endpoint', async () => {
      const mockResponse = {
        device_code: 'device-abc123',
        user_code: 'WXYZ-5678',
        verification_uri: 'https://microsoft.com/devicelogin',
        expires_in: 900,
        interval: 5,
      };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await provider.requestDeviceCode(['Files.Read.All', 'Sites.Read.All']);

      expect(global.fetch).toHaveBeenCalledWith(
        'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: expect.any(URLSearchParams),
        },
      );

      // Check the body contains expected params
      const fetchCall = (global.fetch as any).mock.calls[0];
      const body = fetchCall[1].body.toString();
      expect(body).toContain('client_id=test-client-id');
      expect(body).toContain('scope=');

      expect(result).toEqual({
        deviceCode: 'device-abc123',
        userCode: 'WXYZ-5678',
        verificationUri: 'https://microsoft.com/devicelogin',
        expiresIn: 900,
        interval: 5,
      });
    });

    it('should include scopes in request', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          device_code: 'device-123',
          user_code: 'ABCD-1234',
          verification_uri: 'https://microsoft.com/devicelogin',
          expires_in: 900,
          interval: 5,
        }),
      });

      await provider.requestDeviceCode(['Files.Read.All', 'Sites.Read.All', 'User.Read']);

      const fetchCall = (global.fetch as any).mock.calls[0];
      const body = fetchCall[1].body.toString();

      // URLSearchParams encodes spaces as +
      expect(body).toContain('scope=Files.Read.All+Sites.Read.All+User.Read');
    });

    it('should throw error on failed request', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          error: 'invalid_request',
          error_description: 'Invalid client_id',
        }),
      });

      await expect(provider.requestDeviceCode(['Files.Read.All'])).rejects.toThrow(
        'Invalid client_id',
      );
    });

    it('should handle network errors', async () => {
      (global.fetch as any).mockRejectedValue(new Error('Network error'));

      await expect(provider.requestDeviceCode(['Files.Read.All'])).rejects.toThrow('Network error');
    });
  });

  describe('exchangeDeviceCode', () => {
    it('should exchange device code for tokens', async () => {
      const mockResponse = {
        access_token: 'access-token-123',
        refresh_token: 'refresh-token-123',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'Files.Read.All Sites.Read.All',
      };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await provider.exchangeDeviceCode('device-abc123');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: expect.any(URLSearchParams),
        },
      );

      // Check the body
      const fetchCall = (global.fetch as any).mock.calls[0];
      const body = fetchCall[1].body.toString();
      expect(body).toContain('device_code=device-abc123');

      expect(result).toEqual({
        accessToken: 'access-token-123',
        refreshToken: 'refresh-token-123',
        tokenType: 'Bearer',
        expiresIn: 3600,
        scope: 'Files.Read.All Sites.Read.All',
      });
    });

    it('should handle authorization_pending error', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          error: 'authorization_pending',
          error_description: 'User has not completed authorization',
        }),
      });

      const error: any = await provider.exchangeDeviceCode('device-123').catch((e) => e);

      expect(error.code).toBe('authorization_pending');
      expect(error.message).toContain('User has not completed authorization');
    });

    it('should handle slow_down error', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          error: 'slow_down',
          error_description: 'Too many requests',
        }),
      });

      const error: any = await provider.exchangeDeviceCode('device-123').catch((e) => e);

      expect(error.code).toBe('slow_down');
    });

    it('should handle access_denied error', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          error: 'access_denied',
          error_description: 'User denied consent',
        }),
      });

      await expect(provider.exchangeDeviceCode('device-123')).rejects.toThrow(
        'User denied consent',
      );
    });

    it('should handle expired_token error', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          error: 'expired_token',
          error_description: 'Device code expired',
        }),
      });

      await expect(provider.exchangeDeviceCode('device-123')).rejects.toThrow(
        'Device code expired',
      );
    });
  });

  describe('refreshToken', () => {
    it('should refresh access token', async () => {
      const mockResponse = {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
        scope: 'Files.Read.All Sites.Read.All',
      };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await provider.refreshToken('refresh-token-123');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: expect.any(URLSearchParams),
        },
      );

      // Check the body
      const fetchCall = (global.fetch as any).mock.calls[0];
      const body = fetchCall[1].body.toString();
      expect(body).toContain('refresh_token=refresh-token-123');

      expect(result).toEqual({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresIn: 3600,
      });
    });

    it('should throw error on invalid refresh token', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          error: 'invalid_grant',
          error_description: 'Refresh token expired',
        }),
      });

      await expect(provider.refreshToken('invalid-refresh-token')).rejects.toThrow(
        'Refresh token expired',
      );
    });
  });

  describe('tenant configuration', () => {
    it('should use specified tenant ID in endpoints', async () => {
      const tenantProvider = new MicrosoftOAuthProvider({
        clientId: 'test-client-id',
        tenantId: 'tenant-123',
      });

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          device_code: 'device-123',
          user_code: 'ABCD-1234',
          verification_uri: 'https://microsoft.com/devicelogin',
          expires_in: 900,
          interval: 5,
        }),
      });

      await tenantProvider.requestDeviceCode(['Files.Read.All']);

      expect(global.fetch).toHaveBeenCalledWith(
        'https://login.microsoftonline.com/tenant-123/oauth2/v2.0/devicecode',
        expect.any(Object),
      );
    });

    it('should use common tenant by default', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({
          device_code: 'device-123',
          user_code: 'ABCD-1234',
          verification_uri: 'https://microsoft.com/devicelogin',
          expires_in: 900,
          interval: 5,
        }),
      });

      await provider.requestDeviceCode(['Files.Read.All']);

      expect(global.fetch).toHaveBeenCalledWith(
        'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode',
        expect.any(Object),
      );
    });
  });

  describe('error handling', () => {
    it('should include error details in thrown error', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          error: 'invalid_client',
          error_description: 'Client authentication failed',
          error_codes: [7000215],
          correlation_id: 'abc-123',
        }),
      });

      try {
        await provider.requestDeviceCode(['Files.Read.All']);
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toContain('Client authentication failed');
      }
    });

    it('should handle malformed JSON response', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('Invalid JSON');
        },
        text: async () => 'Internal server error',
      });

      await expect(provider.requestDeviceCode(['Files.Read.All'])).rejects.toThrow();
    });
  });
});

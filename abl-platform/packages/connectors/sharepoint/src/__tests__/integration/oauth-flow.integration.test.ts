/**
 * OAuth Flow Integration Tests
 *
 * Tests the complete OAuth integration:
 * - MicrosoftOAuthProvider + DeviceCodeFlowAuthenticator
 * - Token refresh and expiry handling
 * - Scope management and upgrades
 * - Error recovery and retry
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MicrosoftOAuthProvider } from '../../auth/microsoft-oauth-provider.js';
import { DeviceCodeFlowAuthenticator } from '@agent-platform/connectors-base';
import type { OAuthTokens, DeviceCodeResponse } from '@agent-platform/connectors-base';

// =============================================================================
// MOCK DATA (snake_case — matches Microsoft token endpoint response format)
// =============================================================================

const mockDeviceCodeApiResponse = {
  device_code: 'test-device-code-12345',
  user_code: 'ABCD-1234',
  verification_uri: 'https://microsoft.com/devicelogin',
  verification_uri_complete: 'https://microsoft.com/devicelogin?user_code=ABCD-1234',
  expires_in: 900,
  interval: 5,
};

const mockTokenApiResponse = {
  access_token: 'test-access-token',
  refresh_token: 'test-refresh-token',
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'Sites.Read.All Files.Read.All',
};

// =============================================================================
// INTEGRATION TESTS
// =============================================================================

describe('OAuth Flow Integration', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  // ===========================================================================
  // DEVICE CODE FLOW INTEGRATION
  // ===========================================================================

  describe('Device Code Flow Integration', () => {
    it('should complete full device code flow', async () => {
      vi.useFakeTimers();

      const provider = new MicrosoftOAuthProvider({
        clientId: 'test-client-id',
        tenantId: 'organizations',
      });

      const authenticator = new DeviceCodeFlowAuthenticator(provider);

      // Use interval=1 to minimize timer advancement needed
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ ...mockDeviceCodeApiResponse, interval: 1 }),
        } as Response)
        // Mock first poll - pending (error response from exchangeDeviceCode)
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          json: async () => ({
            error: 'authorization_pending',
            error_description: 'Waiting for user',
          }),
        } as Response)
        // Mock second poll - success
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockTokenApiResponse,
        } as Response);

      // Start authentication (don't await yet)
      const scopes = ['Sites.Read.All', 'Files.Read.All'];
      const tokensPromise = authenticator.authenticate(scopes, () => {});

      // Advance timers to trigger each poll interval
      await vi.advanceTimersByTimeAsync(1500); // First poll
      await vi.advanceTimersByTimeAsync(1500); // Second poll

      const tokens = await tokensPromise;

      expect(tokens.accessToken).toBe('test-access-token');
      expect(tokens.refreshToken).toBe('test-refresh-token');
      expect(tokens.scope).toContain('Sites.Read.All');
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it('should handle slow_down during polling', async () => {
      vi.useFakeTimers();

      const provider = new MicrosoftOAuthProvider({
        clientId: 'test-client-id',
        tenantId: 'organizations',
      });

      const authenticator = new DeviceCodeFlowAuthenticator(provider);

      global.fetch = vi
        .fn()
        // Device code request with short interval
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ ...mockDeviceCodeApiResponse, interval: 1 }),
        } as Response)
        // First poll - slow down (increases interval by 5 seconds)
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          json: async () => ({ error: 'slow_down', error_description: 'Slow down' }),
        } as Response)
        // Second poll - pending
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          json: async () => ({ error: 'authorization_pending', error_description: 'Waiting' }),
        } as Response)
        // Third poll - success
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockTokenApiResponse,
        } as Response);

      const scopes = ['Sites.Read.All'];
      const tokensPromise = authenticator.authenticate(scopes, () => {});

      // Advance timers: 1s (first poll) + 6s (slow_down: 1+5) + 6s (third poll)
      await vi.advanceTimersByTimeAsync(1500);
      await vi.advanceTimersByTimeAsync(7000);
      await vi.advanceTimersByTimeAsync(7000);

      const tokens = await tokensPromise;

      expect(tokens.accessToken).toBeDefined();
      // Should have made all polling attempts
      expect(global.fetch).toHaveBeenCalledTimes(4);
    });

    it('should handle device code expiration', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const provider = new MicrosoftOAuthProvider({
        clientId: 'test-client-id',
        tenantId: 'organizations',
      });

      const authenticator = new DeviceCodeFlowAuthenticator(provider);

      global.fetch = vi
        .fn()
        // Device code request - set interval to 1 second and expires in 2 seconds
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ ...mockDeviceCodeApiResponse, expires_in: 2, interval: 1 }),
        } as Response)
        // Poll - expired_token
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          json: async () => ({ error: 'expired_token', error_description: 'Device code expired' }),
        } as Response);

      const scopes = ['Sites.Read.All'];

      await expect(authenticator.authenticate(scopes, () => {})).rejects.toThrow();
    });

    it('should handle user denial', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const provider = new MicrosoftOAuthProvider({
        clientId: 'test-client-id',
        tenantId: 'organizations',
      });

      const authenticator = new DeviceCodeFlowAuthenticator(provider);

      global.fetch = vi
        .fn()
        // Device code request
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ ...mockDeviceCodeApiResponse, interval: 1 }),
        } as Response)
        // Poll - denied
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          json: async () => ({ error: 'access_denied', error_description: 'User denied' }),
        } as Response);

      const scopes = ['Sites.Read.All'];

      await expect(authenticator.authenticate(scopes, () => {})).rejects.toThrow();
    });
  });

  // ===========================================================================
  // TOKEN REFRESH INTEGRATION
  // ===========================================================================

  describe('Token Refresh Integration', () => {
    it('should refresh expired token', async () => {
      const provider = new MicrosoftOAuthProvider({
        clientId: 'test-client-id',
        tenantId: 'organizations',
      });

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 3600,
        }),
      } as Response);

      const tokens = await provider.refreshToken('old-refresh-token');

      expect(tokens.accessToken).toBe('new-access-token');
      expect(tokens.refreshToken).toBe('new-refresh-token');

      // Verify correct endpoint was called
      expect(global.fetch).toHaveBeenCalledWith(
        'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
        expect.objectContaining({
          method: 'POST',
        }),
      );
    });

    it('should handle refresh token expiration', async () => {
      const provider = new MicrosoftOAuthProvider({
        clientId: 'test-client-id',
        tenantId: 'organizations',
      });

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          error: 'invalid_grant',
          error_description: 'Refresh token expired',
        }),
      } as Response);

      await expect(provider.refreshToken('expired-refresh-token')).rejects.toThrow();
    });

    it('should handle network errors during refresh', async () => {
      const provider = new MicrosoftOAuthProvider({
        clientId: 'test-client-id',
        tenantId: 'organizations',
      });

      // refreshToken does not have built-in retry - it just throws
      global.fetch = vi.fn().mockRejectedValueOnce(new Error('Network timeout'));

      await expect(provider.refreshToken('refresh-token')).rejects.toThrow('Network timeout');
    });
  });

  // ===========================================================================
  // SCOPE MANAGEMENT INTEGRATION
  // ===========================================================================

  describe('Scope Management Integration', () => {
    it('should request correct scopes for content-only access', async () => {
      const provider = new MicrosoftOAuthProvider({
        clientId: 'test-client-id',
        tenantId: 'organizations',
      });

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockDeviceCodeApiResponse,
      } as Response);

      const scopes = ['Sites.Read.All', 'Files.Read.All'];
      await provider.requestDeviceCode(scopes);

      // Verify scopes were sent correctly
      const fetchCall = (global.fetch as any).mock.calls[0];
      const body = fetchCall[1].body;

      // body is URLSearchParams - convert to string for checking
      const bodyStr = body.toString();
      expect(bodyStr).toContain('Sites.Read.All');
      expect(bodyStr).toContain('Files.Read.All');
    });

    it('should request elevated scopes for permission crawling', async () => {
      const provider = new MicrosoftOAuthProvider({
        clientId: 'test-client-id',
        tenantId: 'organizations',
      });

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockDeviceCodeApiResponse,
      } as Response);

      const scopes = [
        'Sites.FullControl.All',
        'Files.Read.All',
        'Directory.Read.All', // For group expansion
      ];

      await provider.requestDeviceCode(scopes);

      const fetchCall = (global.fetch as any).mock.calls[0];
      const bodyStr = fetchCall[1].body.toString();

      expect(bodyStr).toContain('Sites.FullControl.All');
      expect(bodyStr).toContain('Directory.Read.All');
    });

    it('should upgrade scopes when enabling features', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const provider = new MicrosoftOAuthProvider({
        clientId: 'test-client-id',
        tenantId: 'organizations',
      });

      // Initial auth with basic scopes
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ ...mockDeviceCodeApiResponse, interval: 1 }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ...mockTokenApiResponse,
            scope: 'Sites.Read.All Files.Read.All',
          }),
        } as Response);

      const authenticator = new DeviceCodeFlowAuthenticator(provider);
      const initialTokens = await authenticator.authenticate(
        ['Sites.Read.All', 'Files.Read.All'],
        () => {},
      );

      expect(initialTokens.scope).not.toContain('Directory.Read.All');

      // Re-authenticate with upgraded scopes
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ ...mockDeviceCodeApiResponse, interval: 1 }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ...mockTokenApiResponse,
            scope: 'Sites.Read.All Files.Read.All Directory.Read.All',
          }),
        } as Response);

      const upgradedTokens = await authenticator.authenticate(
        ['Sites.Read.All', 'Files.Read.All', 'Directory.Read.All'],
        () => {},
      );

      expect(upgradedTokens.scope).toContain('Directory.Read.All');
    });
  });

  // ===========================================================================
  // TOKEN REVOCATION INTEGRATION
  // ===========================================================================

  describe('Token Revocation Integration', () => {
    it('should handle revocation gracefully (Microsoft v2.0 has no revocation endpoint)', async () => {
      const provider = new MicrosoftOAuthProvider({
        clientId: 'test-client-id',
        tenantId: 'organizations',
      });

      // MicrosoftOAuthProvider.revokeToken() just logs a warning because
      // Microsoft OAuth v2.0 does not support a token revocation endpoint.
      // It should NOT throw.
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(provider.revokeToken('access-token-to-revoke')).resolves.not.toThrow();
      consoleSpy.mockRestore();
    });
  });

  // ===========================================================================
  // ERROR HANDLING INTEGRATION
  // ===========================================================================

  describe('Error Handling Integration', () => {
    it('should handle network errors during device code request', async () => {
      const provider = new MicrosoftOAuthProvider({
        clientId: 'test-client-id',
        tenantId: 'organizations',
      });

      // requestDeviceCode does not have built-in retry - it throws on first error
      global.fetch = vi.fn().mockRejectedValueOnce(new Error('Network unavailable'));

      await expect(provider.requestDeviceCode(['Sites.Read.All'])).rejects.toThrow(
        'Network unavailable',
      );
    });

    it('should handle API error responses during device code request', async () => {
      const provider = new MicrosoftOAuthProvider({
        clientId: 'test-client-id',
        tenantId: 'organizations',
      });

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          error: 'invalid_request',
          error_description: 'Invalid client_id',
        }),
      } as Response);

      await expect(provider.requestDeviceCode(['Sites.Read.All'])).rejects.toThrow(
        'Failed to request device code',
      );
    });

    it('should handle API error responses during token exchange', async () => {
      const provider = new MicrosoftOAuthProvider({
        clientId: 'test-client-id',
        tenantId: 'organizations',
      });

      // exchangeDeviceCode reads the error field from the response body
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          error: 'bad_verification_code',
          error_description: 'Invalid device code',
        }),
      } as Response);

      await expect(provider.exchangeDeviceCode('invalid-code')).rejects.toThrow();
    });
  });

  // ===========================================================================
  // CONCURRENT REQUESTS INTEGRATION
  // ===========================================================================

  describe('Concurrent Requests Integration', () => {
    it('should handle multiple simultaneous device code requests', async () => {
      const provider = new MicrosoftOAuthProvider({
        clientId: 'test-client-id',
        tenantId: 'organizations',
      });

      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ ...mockDeviceCodeApiResponse, user_code: 'CODE-1' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ ...mockDeviceCodeApiResponse, user_code: 'CODE-2' }),
        } as Response);

      const [response1, response2] = await Promise.all([
        provider.requestDeviceCode(['Sites.Read.All']),
        provider.requestDeviceCode(['Files.Read.All']),
      ]);

      expect(response1.userCode).toBe('CODE-1');
      expect(response2.userCode).toBe('CODE-2');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should handle concurrent token refreshes', async () => {
      const provider = new MicrosoftOAuthProvider({
        clientId: 'test-client-id',
        tenantId: 'organizations',
      });

      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ ...mockTokenApiResponse, access_token: 'token-1' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ ...mockTokenApiResponse, access_token: 'token-2' }),
        } as Response);

      const [tokens1, tokens2] = await Promise.all([
        provider.refreshToken('refresh-1'),
        provider.refreshToken('refresh-2'),
      ]);

      expect(tokens1.accessToken).toBe('token-1');
      expect(tokens2.accessToken).toBe('token-2');
    });
  });
});

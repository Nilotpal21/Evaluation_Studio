import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MSTeamsOAuthProvider } from '../msteams-oauth-provider.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('MSTeamsOAuthProvider', () => {
  let provider: MSTeamsOAuthProvider;

  beforeEach(() => {
    provider = new MSTeamsOAuthProvider({
      appId: 'test-app-id',
      clientSecret: 'test-client-secret',
      azureTenantId: 'test-tenant-id',
    });
    mockFetch.mockReset();
  });

  it('has channelType "msteams"', () => {
    expect(provider.channelType).toBe('msteams');
  });

  describe('buildAuthorizeUrl', () => {
    it('builds correct Azure AD OAuth URL', () => {
      const url = provider.buildAuthorizeUrl('state-123', 'https://example.com/callback');
      const parsed = new URL(url);

      expect(parsed.origin + parsed.pathname).toBe(
        'https://login.microsoftonline.com/test-tenant-id/oauth2/v2.0/authorize',
      );
      expect(parsed.searchParams.get('client_id')).toBe('test-app-id');
      expect(parsed.searchParams.get('scope')).toBe('https://api.botframework.com/.default');
      expect(parsed.searchParams.get('response_type')).toBe('code');
      expect(parsed.searchParams.get('state')).toBe('state-123');
      expect(parsed.searchParams.get('redirect_uri')).toBe('https://example.com/callback');
    });
  });

  describe('exchangeCode', () => {
    it('exchanges code and returns credentials + metadata', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'test-access-token',
          token_type: 'Bearer',
        }),
      });

      const result = await provider.exchangeCode('auth-code', 'https://example.com/callback');

      expect(result.credentials).toEqual({
        app_id: 'test-app-id',
        client_secret: 'test-client-secret',
        tenant_id: 'test-tenant-id',
      });
      expect(result.externalIdentifier).toBe('test-app-id');
      expect(result.displayName).toBe('Microsoft Teams - test-app-id');
      expect(result.metadata).toEqual({
        appId: 'test-app-id',
        azureTenantId: 'test-tenant-id',
      });
    });

    it('throws when Azure AD returns error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          error: 'invalid_grant',
          error_description: 'The code has expired',
        }),
      });

      await expect(
        provider.exchangeCode('bad-code', 'https://example.com/callback'),
      ).rejects.toThrow(/invalid_grant/);
    });

    it('throws when HTTP request fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      await expect(provider.exchangeCode('code', 'https://example.com/callback')).rejects.toThrow(
        /500/,
      );
    });
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MetaOAuthProvider } from '../meta-oauth-provider.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock randomBytes for deterministic verify_token
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: () => Buffer.from('a'.repeat(16)),
  };
});

describe('MetaOAuthProvider', () => {
  describe('WhatsApp', () => {
    let provider: MetaOAuthProvider;

    beforeEach(() => {
      provider = new MetaOAuthProvider({
        channelType: 'whatsapp',
        appId: 'test-meta-app-id',
        appSecret: 'test-meta-app-secret',
      });
      mockFetch.mockReset();
    });

    it('has channelType "whatsapp"', () => {
      expect(provider.channelType).toBe('whatsapp');
    });

    describe('buildAuthorizeUrl', () => {
      it('builds correct Facebook Login URL with WhatsApp scopes', () => {
        const url = provider.buildAuthorizeUrl('state-123', 'https://example.com/callback');
        const parsed = new URL(url);

        expect(parsed.origin + parsed.pathname).toBe('https://www.facebook.com/v21.0/dialog/oauth');
        expect(parsed.searchParams.get('client_id')).toBe('test-meta-app-id');
        expect(parsed.searchParams.get('scope')).toBe(
          'whatsapp_business_management,whatsapp_business_messaging',
        );
        expect(parsed.searchParams.get('state')).toBe('state-123');
        expect(parsed.searchParams.get('redirect_uri')).toBe('https://example.com/callback');
        expect(parsed.searchParams.get('response_type')).toBe('code');
      });
    });

    describe('exchangeCode', () => {
      it('exchanges code and returns WhatsApp credentials', async () => {
        // Token exchange
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: 'test-user-token' }),
        });
        // Accounts API
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: [{ id: 'page-123', name: 'Test Business', access_token: 'page-token-123' }],
          }),
        });

        const result = await provider.exchangeCode('auth-code', 'https://example.com/callback');

        expect(result.credentials.access_token).toBe('test-user-token');
        expect(result.credentials.app_secret).toBe('test-meta-app-secret');
        expect(result.credentials.verify_token).toBeDefined();
        expect(result.externalIdentifier).toBe('page-123');
        expect(result.displayName).toBe('WhatsApp - Test Business');
      });

      it('throws when token exchange fails', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: async () => 'Bad Request',
        });

        await expect(
          provider.exchangeCode('bad-code', 'https://example.com/callback'),
        ).rejects.toThrow(/400/);
      });

      it('throws when token response has error', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ error: { message: 'Invalid code' } }),
        });

        await expect(
          provider.exchangeCode('bad-code', 'https://example.com/callback'),
        ).rejects.toThrow(/Invalid code/);
      });
    });
  });

  describe('Messenger', () => {
    let provider: MetaOAuthProvider;

    beforeEach(() => {
      provider = new MetaOAuthProvider({
        channelType: 'messenger',
        appId: 'test-meta-app-id',
        appSecret: 'test-meta-app-secret',
      });
      mockFetch.mockReset();
    });

    it('has channelType "messenger"', () => {
      expect(provider.channelType).toBe('messenger');
    });

    describe('buildAuthorizeUrl', () => {
      it('builds correct Facebook Login URL with Messenger scopes', () => {
        const url = provider.buildAuthorizeUrl('state-123', 'https://example.com/callback');
        const parsed = new URL(url);

        expect(parsed.searchParams.get('scope')).toBe(
          'pages_messaging,pages_read_engagement,pages_manage_metadata',
        );
      });
    });

    describe('exchangeCode', () => {
      it('exchanges code and returns Messenger credentials with page_access_token', async () => {
        // Token exchange
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: 'test-user-token' }),
        });
        // Accounts API
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: [{ id: 'page-456', name: 'Test Page', access_token: 'page-token-456' }],
          }),
        });

        const result = await provider.exchangeCode('auth-code', 'https://example.com/callback');

        expect(result.credentials.page_access_token).toBe('page-token-456');
        expect(result.credentials.app_secret).toBe('test-meta-app-secret');
        expect(result.credentials.verify_token).toBeDefined();
        expect(result.externalIdentifier).toBe('page-456');
        expect(result.displayName).toBe('Messenger - Test Page');
      });

      it('throws when accounts API fails', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: 'test-user-token' }),
        });
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
});

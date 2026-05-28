import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SlackOAuthProvider } from '../slack-oauth-provider.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('SlackOAuthProvider', () => {
  let provider: SlackOAuthProvider;

  beforeEach(() => {
    provider = new SlackOAuthProvider({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      signingSecret: 'test-signing-secret',
      scopes: ['chat:write', 'im:history'],
    });
    mockFetch.mockReset();
  });

  it('has channelType "slack"', () => {
    expect(provider.channelType).toBe('slack');
  });

  describe('buildAuthorizeUrl', () => {
    it('builds correct Slack OAuth V2 URL', () => {
      const url = provider.buildAuthorizeUrl('state-123', 'https://example.com/callback');
      const parsed = new URL(url);

      expect(parsed.origin + parsed.pathname).toBe('https://slack.com/oauth/v2/authorize');
      expect(parsed.searchParams.get('client_id')).toBe('test-client-id');
      expect(parsed.searchParams.get('scope')).toBe('chat:write,im:history');
      expect(parsed.searchParams.get('state')).toBe('state-123');
      expect(parsed.searchParams.get('redirect_uri')).toBe('https://example.com/callback');
    });
  });

  describe('exchangeCode', () => {
    it('exchanges code and returns credentials + metadata', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          access_token: 'xoxb-test-token',
          bot_user_id: 'U123BOT',
          app_id: 'A456APP',
          team: { id: 'T789TEAM', name: 'Test Workspace' },
        }),
      });

      const result = await provider.exchangeCode('auth-code', 'https://example.com/callback');

      expect(result.credentials).toEqual({
        bot_token: 'xoxb-test-token',
        signing_secret: 'test-signing-secret',
      });
      expect(result.externalIdentifier).toBe('T789TEAM:A456APP');
      expect(result.displayName).toBe('Slack - Test Workspace');
      expect(result.metadata).toEqual({
        teamId: 'T789TEAM',
        teamName: 'Test Workspace',
        botUserId: 'U123BOT',
        appId: 'A456APP',
      });
    });

    it('throws when Slack API returns ok: false', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: false, error: 'invalid_code' }),
      });

      await expect(
        provider.exchangeCode('bad-code', 'https://example.com/callback'),
      ).rejects.toThrow(/invalid_code/);
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

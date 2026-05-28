import { describe, it, expect } from 'vitest';
import {
  mapAuthMode,
  mapNangoProvider,
  mapAllProviders,
  filterOAuth2Providers,
  type NangoProvider,
} from '../adapters/nango/provider-mapper.js';
import { importProviders, generateProviderJson } from '../adapters/nango/importer.js';

describe('Nango Provider Mapper', () => {
  describe('mapAuthMode', () => {
    it('maps OAUTH2 → oauth2', () => {
      expect(mapAuthMode('OAUTH2')).toBe('oauth2');
    });

    it('maps OAUTH1 → oauth1', () => {
      expect(mapAuthMode('OAUTH1')).toBe('oauth1');
    });

    it('maps API_KEY → api_key', () => {
      expect(mapAuthMode('API_KEY')).toBe('api_key');
    });

    it('maps BASIC → basic', () => {
      expect(mapAuthMode('BASIC')).toBe('basic');
    });

    it('maps NONE → none', () => {
      expect(mapAuthMode('NONE')).toBe('none');
    });
  });

  describe('mapNangoProvider', () => {
    it('maps a full OAuth2 provider', () => {
      const nango: NangoProvider = {
        auth_mode: 'OAUTH2',
        authorization_url: 'https://slack.com/oauth/v2/authorize',
        token_url: 'https://slack.com/api/oauth.v2.access',
        scope_separator: ',',
        default_scopes: ['chat:write', 'channels:read'],
        pkce: false,
        docs: 'https://api.slack.com/docs',
        connection_config: {
          subdomain: {
            type: 'string',
            title: 'Subdomain',
            description: 'Workspace subdomain',
            doc_section: '#workspace-subdomain',
          },
        },
        proxy: {
          base_url: 'https://slack.com/api',
        },
      };

      const result = mapNangoProvider('slack', nango);
      expect(result).toMatchObject({
        name: 'slack',
        authMode: 'oauth2',
        authorizationUrl: 'https://slack.com/oauth/v2/authorize',
        tokenUrl: 'https://slack.com/api/oauth.v2.access',
        scopeSeparator: ',',
        defaultScopes: ['chat:write', 'channels:read'],
        pkce: false,
        connectionConfig: {
          subdomain: {
            type: 'string',
            title: 'Subdomain',
            description: 'Workspace subdomain',
            docSection: '#workspace-subdomain',
          },
        },
        proxyBaseUrl: 'https://slack.com/api',
      });
    });

    it('defaults scope separator to space', () => {
      const result = mapNangoProvider('test', { auth_mode: 'OAUTH2' });
      expect(result.scopeSeparator).toBe(' ');
    });

    it('defaults pkce to false', () => {
      const result = mapNangoProvider('test', { auth_mode: 'OAUTH2' });
      expect(result.pkce).toBe(false);
    });

    it('defaults scopes to empty array', () => {
      const result = mapNangoProvider('test', { auth_mode: 'OAUTH2' });
      expect(result.defaultScopes).toEqual([]);
    });

    it('uses token_url as refreshUrl when refresh_url missing', () => {
      const result = mapNangoProvider('test', {
        auth_mode: 'OAUTH2',
        token_url: 'https://example.com/token',
      });
      expect(result.refreshUrl).toBe('https://example.com/token');
    });

    it('uses explicit refresh_url when provided', () => {
      const result = mapNangoProvider('test', {
        auth_mode: 'OAUTH2',
        token_url: 'https://example.com/token',
        refresh_url: 'https://example.com/refresh',
      });
      expect(result.refreshUrl).toBe('https://example.com/refresh');
    });
  });

  describe('mapAllProviders', () => {
    it('maps multiple providers', () => {
      const providers: Record<string, NangoProvider> = {
        slack: { auth_mode: 'OAUTH2' },
        stripe: { auth_mode: 'API_KEY' },
        github: { auth_mode: 'OAUTH2' },
      };

      const result = mapAllProviders(providers);
      expect(result).toHaveLength(3);
      expect(result.map((r) => r.name)).toEqual(['slack', 'stripe', 'github']);
    });
  });

  describe('filterOAuth2Providers', () => {
    it('filters to OAuth2 only', () => {
      const providers: Record<string, NangoProvider> = {
        slack: { auth_mode: 'OAUTH2' },
        stripe: { auth_mode: 'API_KEY' },
        github: { auth_mode: 'OAUTH2' },
      };

      const all = mapAllProviders(providers);
      const oauth2 = filterOAuth2Providers(all);
      expect(oauth2).toHaveLength(2);
      expect(oauth2.every((c) => c.authMode === 'oauth2')).toBe(true);
    });
  });
});

describe('Nango Importer', () => {
  it('imports and returns ProviderConfig array', () => {
    const raw: Record<string, NangoProvider> = {
      slack: { auth_mode: 'OAUTH2', authorization_url: 'https://slack.com/auth' },
      stripe: { auth_mode: 'API_KEY' },
    };

    const result = importProviders(raw);
    expect(result).toHaveLength(2);
  });

  it('filters to oauth2 when option set', () => {
    const raw: Record<string, NangoProvider> = {
      slack: { auth_mode: 'OAUTH2' },
      stripe: { auth_mode: 'API_KEY' },
    };

    const result = importProviders(raw, { oauth2Only: true });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('slack');
  });

  it('generates valid JSON', () => {
    const raw: Record<string, NangoProvider> = {
      slack: { auth_mode: 'OAUTH2', authorization_url: 'https://slack.com/auth' },
    };

    const configs = importProviders(raw);
    const json = generateProviderJson(configs[0]);
    const parsed = JSON.parse(json);
    expect(parsed.name).toBe('slack');
    expect(parsed.authMode).toBe('oauth2');
  });
});

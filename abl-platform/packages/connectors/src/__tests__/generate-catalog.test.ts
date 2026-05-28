import { describe, it, expect } from 'vitest';
import {
  NANGO_ALIAS_MAP,
  NANGO_SECONDARY_PROVIDERS,
  extractCatalogEntry,
  enrichWithOAuth,
  selectPreferredNangoProvider,
} from '../catalog/extract-entry.js';
import type { CatalogEntry } from '../catalog/extract-entry.js';
import type { ProviderConfig } from '../adapters/nango/provider-mapper.js';
import type { Connector } from '../types.js';

const mockConnector: Connector = {
  name: 'test-connector',
  displayName: 'Test Connector',
  version: '1.0.0',
  description: 'A test connector',
  auth: {
    type: 'api_key',
    fields: [{ name: 'apiKey', displayName: 'API Key', required: true, sensitive: true }],
  },
  triggers: [
    {
      name: 'new_item',
      displayName: 'New Item',
      description: 'Fires on new item',
      triggerType: 'webhook' as const,
      props: [],
      onEnable: async () => {},
      onDisable: async () => {},
      run: async () => [],
    },
  ],
  actions: [
    {
      name: 'create_item',
      displayName: 'Create Item',
      description: 'Creates an item',
      props: [],
      run: async () => ({}),
    },
    {
      name: 'list_items',
      displayName: 'List Items',
      description: 'Lists items',
      props: [],
      run: async () => ({}),
    },
  ],
};

describe('extractCatalogEntry', () => {
  it('extracts display metadata from a Connector', () => {
    const entry = extractCatalogEntry(mockConnector, 'productivity');
    expect(entry).toEqual({
      name: 'test-connector',
      displayName: 'Test Connector',
      version: '1.0.0',
      description: 'A test connector',
      category: 'productivity',
      authType: 'api_key',
      actions: [
        { name: 'create_item', displayName: 'Create Item', description: 'Creates an item' },
        { name: 'list_items', displayName: 'List Items', description: 'Lists items' },
      ],
      triggers: [
        { name: 'new_item', displayName: 'New Item', description: 'Fires on new item', props: [] },
      ],
    });
  });

  it('omits functions — result is JSON-serializable', () => {
    const entry = extractCatalogEntry(mockConnector, 'productivity');
    const serialized = JSON.parse(JSON.stringify(entry));
    expect(serialized).toEqual(entry);
  });
});

describe('enrichWithOAuth', () => {
  it('fills OAuth2 config from Nango provider when the catalog entry has no OAuth metadata', () => {
    const entry: CatalogEntry = {
      name: 'slack',
      displayName: 'Slack',
      version: '1.0.0',
      description: 'Slack connector',
      category: 'communication',
      authType: 'oauth2',
      actions: [],
      triggers: [],
    };

    const provider: ProviderConfig = {
      name: 'slack',
      authMode: 'oauth2',
      authorizationUrl: 'https://slack.com/oauth/v2/authorize',
      tokenUrl: 'https://slack.com/api/oauth.v2.access',
      refreshUrl: 'https://slack.com/api/oauth.v2.access',
      authorizationParams: { access_type: 'offline' },
      tokenParams: { grant_type: 'authorization_code' },
      connectionConfig: {
        workspace: { type: 'string', title: 'Workspace' },
      },
      scopeSeparator: ',',
      defaultScopes: ['chat:write', 'channels:read'],
      pkce: false,
    };

    const enriched = enrichWithOAuth(entry, [provider]);
    expect(enriched.oauth2).toEqual({
      authorizationUrl: 'https://slack.com/oauth/v2/authorize',
      tokenUrl: 'https://slack.com/api/oauth.v2.access',
      refreshUrl: 'https://slack.com/api/oauth.v2.access',
      authorizationParams: { access_type: 'offline' },
      tokenParams: { grant_type: 'authorization_code' },
      connectionConfig: {
        workspace: { type: 'string', title: 'Workspace' },
      },
      defaultScopes: ['chat:write', 'channels:read'],
      scopeSeparator: ',',
      pkce: false,
    });
  });

  it('preserves existing connector OAuth metadata while filling missing provider fields', () => {
    const entry: CatalogEntry = {
      name: 'slack',
      displayName: 'Slack',
      version: '1.0.0',
      description: 'Slack connector',
      category: 'communication',
      authType: 'oauth2',
      actions: [],
      triggers: [],
      oauth2: {
        authorizationUrl: 'https://platform.example.com/oauth/authorize',
        tokenUrl: 'https://platform.example.com/oauth/token',
        defaultScopes: ['chat:write', 'channels:read'],
        scopeSeparator: ' ',
        pkce: false,
      },
    };

    const provider: ProviderConfig = {
      name: 'slack',
      authMode: 'oauth2',
      authorizationUrl: 'https://slack.com/oauth/v2/authorize',
      tokenUrl: 'https://slack.com/api/oauth.v2.access',
      refreshUrl: 'https://slack.com/api/oauth.v2.access',
      authorizationParams: { access_type: 'offline' },
      tokenParams: { grant_type: 'authorization_code' },
      scopeSeparator: ',',
      defaultScopes: [],
      pkce: true,
    };

    const enriched = enrichWithOAuth(entry, [provider]);
    expect(enriched.oauth2).toEqual({
      authorizationUrl: 'https://platform.example.com/oauth/authorize',
      tokenUrl: 'https://platform.example.com/oauth/token',
      refreshUrl: 'https://slack.com/api/oauth.v2.access',
      authorizationParams: { access_type: 'offline' },
      tokenParams: { grant_type: 'authorization_code' },
      defaultScopes: ['chat:write', 'channels:read'],
      scopeSeparator: ',',
      pkce: true,
    });
  });

  it('prefers provider URLs for legacy templated OAuth entries while keeping connector scopes', () => {
    const entry: CatalogEntry = {
      name: 'salesforce',
      displayName: 'Salesforce',
      version: '1.0.0',
      description: 'Salesforce connector',
      category: 'crm',
      authType: 'oauth2',
      actions: [],
      triggers: [],
      oauth2: {
        authorizationUrl: 'https://{environment}.salesforce.com/services/oauth2/authorize',
        tokenUrl: 'https://{environment}.salesforce.com/services/oauth2/token',
        defaultScopes: ['full', 'api'],
        scopeSeparator: ' ',
        pkce: false,
      },
    };

    const provider: ProviderConfig = {
      name: 'salesforce',
      authMode: 'oauth2',
      authorizationUrl:
        'https://${connectionConfig.hostname}/services/oauth2/authorize || https://login.salesforce.com/services/oauth2/authorize',
      tokenUrl:
        'https://${connectionConfig.hostname}/services/oauth2/token || https://login.salesforce.com/services/oauth2/token',
      refreshUrl:
        'https://${connectionConfig.hostname}/services/oauth2/token || https://login.salesforce.com/services/oauth2/token',
      authorizationParams: { prompt: 'consent' },
      scopeSeparator: ' ',
      defaultScopes: ['offline_access'],
      pkce: false,
      connectionConfig: {
        hostname: {
          type: 'string',
          title: 'Hostname',
          optional: true,
        },
      },
    };

    const enriched = enrichWithOAuth(entry, [provider]);
    expect(enriched.oauth2).toEqual({
      authorizationUrl:
        'https://${connectionConfig.hostname}/services/oauth2/authorize || https://login.salesforce.com/services/oauth2/authorize',
      tokenUrl:
        'https://${connectionConfig.hostname}/services/oauth2/token || https://login.salesforce.com/services/oauth2/token',
      refreshUrl:
        'https://${connectionConfig.hostname}/services/oauth2/token || https://login.salesforce.com/services/oauth2/token',
      authorizationParams: { prompt: 'consent' },
      tokenParams: undefined,
      connectionConfig: {
        hostname: {
          type: 'string',
          title: 'Hostname',
          optional: true,
          format: 'hostname',
          prefix: 'https://',
        },
      },
      defaultScopes: ['full', 'api'],
      scopeSeparator: ' ',
      pkce: false,
    });
  });

  it('skips enrichment when no matching provider exists', () => {
    const entry: CatalogEntry = {
      name: 'custom-http',
      displayName: 'HTTP',
      version: '1.0.0',
      description: 'HTTP connector',
      category: 'custom',
      authType: 'none',
      actions: [],
      triggers: [],
    };
    const enriched = enrichWithOAuth(entry, []);
    expect(enriched.oauth2).toBeUndefined();
  });

  it('enriches even when authType is not oauth2 (integration auth profiles need OAuth metadata for all matching providers)', () => {
    const entry: CatalogEntry = {
      name: 'test',
      displayName: 'Test',
      version: '1.0.0',
      description: 'Test',
      category: 'custom',
      authType: 'api_key',
      actions: [],
      triggers: [],
    };
    const provider: ProviderConfig = {
      name: 'test',
      authMode: 'oauth2',
      authorizationUrl: 'https://example.com/auth',
      tokenUrl: 'https://example.com/token',
      scopeSeparator: ' ',
      defaultScopes: [],
      pkce: false,
    };
    const enriched = enrichWithOAuth(entry, [provider]);
    expect(enriched.oauth2).toBeDefined();
    expect(enriched.oauth2?.authorizationUrl).toBe('https://example.com/auth');
    expect(enriched.oauth2?.tokenUrl).toBe('https://example.com/token');
  });

  it('prefers the alias provider when the exact provider lacks OAuth URLs', () => {
    const entry: CatalogEntry = {
      name: 'microsoft-teams',
      displayName: 'Microsoft Teams',
      version: '1.0.0',
      description: 'Teams connector',
      category: 'communication',
      authType: 'oauth2',
      actions: [],
      triggers: [],
    };

    const exactProvider: ProviderConfig = {
      name: 'microsoft-teams',
      authMode: 'none',
      scopeSeparator: ' ',
      defaultScopes: [],
      pkce: false,
    };

    const aliasProvider: ProviderConfig = {
      name: 'microsoft',
      authMode: 'oauth2',
      authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      scopeSeparator: ' ',
      defaultScopes: ['offline_access', '.default'],
      pkce: false,
    };

    const enriched = enrichWithOAuth(entry, [exactProvider, aliasProvider]);
    expect(enriched.oauth2?.authorizationUrl).toBe(aliasProvider.authorizationUrl);
    expect(enriched.oauth2?.tokenUrl).toBe(aliasProvider.tokenUrl);
    expect(enriched.oauth2?.defaultScopes).toEqual(aliasProvider.defaultScopes);
  });
});

describe('selectPreferredNangoProvider', () => {
  it('keeps the exact provider when it already exposes OAuth URLs', () => {
    const exactProvider = {
      authorizationUrl: 'https://exact.example.com/auth',
      tokenUrl: 'https://exact.example.com/token',
    };
    const aliasProvider = {
      authorizationUrl: 'https://alias.example.com/auth',
      tokenUrl: 'https://alias.example.com/token',
    };

    expect(selectPreferredNangoProvider(exactProvider, aliasProvider)).toEqual(exactProvider);
  });

  it('falls back to the alias provider when the exact provider is not OAuth-capable', () => {
    const exactProvider = {};
    const aliasProvider = {
      authorizationUrl: 'https://alias.example.com/auth',
      tokenUrl: 'https://alias.example.com/token',
    };

    expect(selectPreferredNangoProvider(exactProvider, aliasProvider)).toEqual(aliasProvider);
    expect(NANGO_ALIAS_MAP['microsoft-dynamics-365-business-central']).toBe(
      'microsoft-business-central',
    );
    expect(NANGO_SECONDARY_PROVIDERS['shopify']).toEqual(['shopify-cc', 'shopify-api-key']);
  });
});

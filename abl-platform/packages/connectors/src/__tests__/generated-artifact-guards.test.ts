import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '../adapters/nango/provider-mapper.js';
import type { CatalogEntry } from '../catalog/extract-entry.js';
import {
  assertCatalogOAuthProvidersAvailable,
  assertGeneratedCatalogPopulated,
  assertGeneratedProvidersPopulated,
} from '../generated-artifact-guards.js';

const oauth2CatalogEntry: CatalogEntry = {
  name: 'slack',
  displayName: 'Slack',
  version: '1.0.0',
  description: 'Slack connector',
  category: 'communication',
  authType: 'oauth2',
  actions: [],
  triggers: [],
};

const apiKeyCatalogEntry: CatalogEntry = {
  ...oauth2CatalogEntry,
  name: 'claude',
  displayName: 'Claude',
  authType: 'api_key',
};

const providerConfig: ProviderConfig = {
  name: 'slack',
  authMode: 'oauth2',
  authorizationUrl: 'https://slack.com/oauth/v2/authorize',
  tokenUrl: 'https://slack.com/api/oauth.v2.access',
  refreshUrl: 'https://slack.com/api/oauth.v2.access',
  scopeSeparator: ' ',
  defaultScopes: [],
  pkce: false,
};

describe('generated artifact guards', () => {
  it('rejects an empty providers registry', () => {
    expect(() => assertGeneratedProvidersPopulated([], 'test context')).toThrow(
      'empty Nango provider registry',
    );
  });

  it('rejects an empty connector catalog', () => {
    expect(() => assertGeneratedCatalogPopulated([], 'test context')).toThrow(
      'empty connector catalog',
    );
  });

  it('rejects OAuth2 catalog generation without provider data', () => {
    expect(() => assertCatalogOAuthProvidersAvailable([oauth2CatalogEntry], [])).toThrow(
      'OAuth2 connectors',
    );
  });

  it('allows non-OAuth catalogs to skip provider data', () => {
    expect(() => assertCatalogOAuthProvidersAvailable([apiKeyCatalogEntry], [])).not.toThrow();
  });

  it('allows OAuth2 catalog generation when provider data exists', () => {
    expect(() =>
      assertCatalogOAuthProvidersAvailable([oauth2CatalogEntry], [providerConfig]),
    ).not.toThrow();
  });
});

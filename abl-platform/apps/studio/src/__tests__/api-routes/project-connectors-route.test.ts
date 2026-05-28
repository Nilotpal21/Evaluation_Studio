/**
 * Pure-function test for the connector-catalog enrichment used by
 * GET /api/projects/:id/connectors. Exercises the helpers directly so the
 * suite does not need to mock `@abl/compiler/platform`,
 * `@agent-platform/connectors/catalog/json`, or any Studio infrastructure.
 *
 * The Next.js route is a thin wrapper around `enrichProvidersWithCatalog`
 * and is exercised end-to-end by `tool-invocations-api.e2e.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import realCatalog from '@agent-platform/connectors/catalog/json';
import {
  enrichProvidersWithCatalog,
  pickPrimaryAuthType,
  PROJECT_CONNECTOR_HIDDEN_NAMES,
  type ConnectorCatalogEntry,
  type EnrichmentProvider,
} from '@/lib/connector-catalog-enrichment';

describe('PROJECT_CONNECTOR_HIDDEN_NAMES', () => {
  it('hides the built-in HTTP and Postgres utility connectors', () => {
    expect(PROJECT_CONNECTOR_HIDDEN_NAMES.has('http')).toBe(true);
    expect(PROJECT_CONNECTOR_HIDDEN_NAMES.has('postgres')).toBe(true);
  });

  it('does not hide real third-party integrations', () => {
    expect(PROJECT_CONNECTOR_HIDDEN_NAMES.has('shopify')).toBe(false);
    expect(PROJECT_CONNECTOR_HIDDEN_NAMES.has('microsoft-sharepoint')).toBe(false);
  });
});

describe('pickPrimaryAuthType', () => {
  it('prefers oauth2 over header-style auth types', () => {
    expect(pickPrimaryAuthType(['api_key', 'oauth2', 'basic'])).toBe('oauth2');
  });

  it('falls back through the priority list', () => {
    expect(pickPrimaryAuthType(['mtls', 'aws_iam', 'basic'])).toBe('basic');
    expect(pickPrimaryAuthType(['mtls', 'aws_iam'])).toBe('aws_iam');
    expect(pickPrimaryAuthType(['mtls'])).toBe('mtls');
  });

  it('returns the first available type when none of the priority list matches', () => {
    expect(pickPrimaryAuthType(['custom_header', 'digest'])).toBe('custom_header');
  });

  it('returns "none" when the available list is empty', () => {
    expect(pickPrimaryAuthType([])).toBe('none');
  });
});

describe('enrichProvidersWithCatalog', () => {
  const fakeCatalog: ConnectorCatalogEntry[] = [
    {
      name: 'shopify',
      displayName: 'Shopify',
      actions: [{ name: 'create-order', displayName: 'Create Order' }],
      triggers: [{ name: 'order-created', displayName: 'Order Created' }],
    },
  ];

  it('falls back to empty actions/triggers for connectors not in the catalog', () => {
    const providers: EnrichmentProvider[] = [
      {
        connectorName: 'http',
        displayName: 'HTTP',
        description: 'Utility HTTP connector',
        category: 'custom',
        availableAuthTypes: ['api_key'],
      },
      {
        connectorName: 'postgres',
        displayName: 'Postgres',
        description: 'Database utility connector',
        category: 'database',
        availableAuthTypes: ['basic'],
      },
    ];

    const enriched = enrichProvidersWithCatalog(providers, fakeCatalog);

    expect(enriched).toEqual([
      expect.objectContaining({
        name: 'http',
        authType: 'api_key',
        availableAuthTypes: ['api_key'],
        actions: [],
        triggers: [],
      }),
      expect.objectContaining({
        name: 'postgres',
        authType: 'basic',
        availableAuthTypes: ['basic'],
        actions: [],
        triggers: [],
      }),
    ]);
  });

  it('attaches catalog actions and triggers when the connector is present', () => {
    const providers: EnrichmentProvider[] = [
      {
        connectorName: 'shopify',
        displayName: 'Shopify',
        description: 'Storefront and admin integration',
        category: 'e-commerce',
        availableAuthTypes: ['oauth2', 'oauth2_client_credentials', 'api_key'],
        oauth2: {
          authorizationUrl: 'https://shop.example.com/oauth/authorize',
          tokenUrl: 'https://shop.example.com/oauth/token',
          authorizationParams: { prompt: 'consent' },
          tokenParams: { audience: 'admin' },
          defaultScopes: ['orders:read', 'orders:write'],
          scopeSeparator: ',',
          pkce: false,
        },
      },
    ];

    const [enriched] = enrichProvidersWithCatalog(providers, fakeCatalog);

    expect(enriched).toEqual(
      expect.objectContaining({
        name: 'shopify',
        authType: 'oauth2',
        availableAuthTypes: ['oauth2', 'oauth2_client_credentials', 'api_key'],
        oauth2: expect.objectContaining({
          authorizationParams: { prompt: 'consent' },
          tokenParams: { audience: 'admin' },
          defaultScopes: ['orders:read', 'orders:write'],
          scopeSeparator: ',',
        }),
        actions: [{ name: 'create-order', displayName: 'Create Order' }],
        triggers: [{ name: 'order-created', displayName: 'Order Created' }],
      }),
    );
  });

  it('projects oauth2 connectionConfig only for fields declared in connectionConfigFields', () => {
    const providers: EnrichmentProvider[] = [
      {
        connectorName: 'sample',
        displayName: 'Sample',
        availableAuthTypes: ['oauth2'],
        oauth2: {
          authorizationUrl: 'https://provider.example/oauth/authorize',
          tokenUrl: 'https://provider.example/oauth/token',
          defaultScopes: ['read'],
          pkce: false,
          connectionConfigFields: ['subdomain'],
        },
        connectionConfig: {
          subdomain: { type: 'string', title: 'Subdomain' },
          clientLevelConfig: { type: 'string', title: 'Should be dropped' },
        },
      },
    ];

    const [enriched] = enrichProvidersWithCatalog(providers, fakeCatalog);

    expect(enriched.oauth2?.connectionConfig).toEqual({
      subdomain: { type: 'string', title: 'Subdomain' },
    });
    expect(enriched.oauth2?.scopeSeparator).toBe(' ');
  });

  it('uses the real connector catalog without crashing for the broad input set', () => {
    // Smoke test: the real catalog has dozens of entries with deeply nested
    // action/trigger metadata. Enriching every provider against the real
    // catalog should never throw and should preserve provider order.
    const providers: EnrichmentProvider[] = (realCatalog as ConnectorCatalogEntry[])
      .slice(0, 5)
      .map((entry) => ({
        connectorName: entry.name,
        displayName: entry.displayName,
        availableAuthTypes: entry.authType ? [entry.authType] : ['oauth2'],
      }));

    const enriched = enrichProvidersWithCatalog(providers, realCatalog as ConnectorCatalogEntry[]);

    expect(enriched).toHaveLength(providers.length);
    expect(enriched.map((entry) => entry.name)).toEqual(
      providers.map((entry) => entry.connectorName),
    );
    for (const entry of enriched) {
      expect(Array.isArray(entry.actions)).toBe(true);
      expect(Array.isArray(entry.triggers)).toBe(true);
    }
  });
});

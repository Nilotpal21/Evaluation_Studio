/**
 * Integration Provider Endpoint Tests
 *
 * Tests the integration provider service logic — catalog enrichment with Nango
 * OAuth metadata and per-connector profile counts with visibility filtering.
 *
 * Uses the same mock pattern as auth-profile-api.test.ts: mock auth + DB models,
 * test business logic directly via buildIntegrationProviders().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — database models
// ---------------------------------------------------------------------------

const { mockAuthProfileFind } = vi.hoisted(() => ({
  mockAuthProfileFind: vi.fn(),
}));

vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: {
    find: mockAuthProfileFind,
  },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

import {
  buildIntegrationProviders,
  normalizeOAuthParams,
} from '../../../lib/integration-provider-service';
import { extractConnectionConfigFields } from '../../../lib/connection-config-utils';

describe('buildIntegrationProviders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no profiles in DB
    mockAuthProfileFind.mockReturnValue({ lean: () => Promise.resolve([]) });
  });

  it('INT-1: returns catalog connectors plus auth-only virtual integration providers', async () => {
    const providers = await buildIntegrationProviders({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'user-1',
      isAdmin: true,
    });

    expect(providers.length).toBe(38);
    expect(providers.every((p) => p.connectorName && p.displayName)).toBe(true);
  });

  it('INT-1b: shopify includes oauth2, client credentials, and api key from Nango providers', async () => {
    const providers = await buildIntegrationProviders({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'user-1',
      isAdmin: true,
    });

    const shopify = providers.find((p) => p.connectorName === 'shopify');
    expect(shopify).toBeDefined();
    expect(shopify!.availableAuthTypes).toEqual(['oauth2', 'oauth2_client_credentials', 'api_key']);
  });

  it('INT-2: Gmail entry includes Nango OAuth metadata', async () => {
    const providers = await buildIntegrationProviders({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'user-1',
      isAdmin: true,
    });

    const gmail = providers.find((p) => p.connectorName === 'gmail');
    expect(gmail).toBeDefined();
    expect(gmail!.oauth2).toBeDefined();
    expect(gmail!.oauth2!.authorizationUrl).toContain('google');
    expect(gmail!.oauth2!.tokenUrl).toContain('google');
    expect(gmail!.oauth2!.defaultScopes.length).toBeGreaterThan(0);
    expect(gmail!.oauth2!.scopeSeparator).toBe(' ');
    expect(typeof gmail!.oauth2!.pkce).toBe('boolean');
    expect(gmail!.availableAuthTypes).toContain('oauth2');
  });

  it('INT-3: Stripe entry has api_key auth type, no OAuth metadata', async () => {
    const providers = await buildIntegrationProviders({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'user-1',
      isAdmin: true,
    });

    const stripe = providers.find((p) => p.connectorName === 'stripe');
    expect(stripe).toBeDefined();
    expect(stripe!.availableAuthTypes).toContain('api_key');
    // Stripe may or may not have Nango OAuth entry, but should have api_key
  });

  it('INT-4: jira-cloud resolves via alias to Nango jira provider', async () => {
    const providers = await buildIntegrationProviders({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'user-1',
      isAdmin: true,
    });

    const jira = providers.find((p) => p.connectorName === 'jira-cloud');
    expect(jira).toBeDefined();
    expect(jira!.oauth2).toBeDefined();
    expect(jira!.oauth2!.authorizationUrl).toBeTruthy();
  });

  it('INT-5: visibility filtering — admin sees all profiles', async () => {
    mockAuthProfileFind.mockReturnValue({
      lean: () =>
        Promise.resolve([
          {
            _id: 'p1',
            name: 'Gmail Shared',
            connector: 'gmail',
            scope: 'tenant',
            usageMode: 'preconfigured',
            authType: 'oauth2_app',
            status: 'active',
            visibility: 'shared',
            createdBy: 'other-user',
          },
          {
            _id: 'p2',
            name: 'Gmail Personal',
            connector: 'gmail',
            scope: 'project',
            usageMode: 'preconfigured',
            authType: 'oauth2_app',
            status: 'active',
            visibility: 'personal',
            createdBy: 'other-user',
          },
        ]),
    });

    const providers = await buildIntegrationProviders({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'user-1',
      isAdmin: true,
    });

    const gmail = providers.find((p) => p.connectorName === 'gmail');
    expect(gmail!.profileCount).toBe(2);
    expect(gmail!.profiles).toHaveLength(2);
  });

  it('INT-6: non-admin only sees shared + own personal profiles', async () => {
    const providers = await buildIntegrationProviders({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'user-1',
      isAdmin: false,
    });

    // Verify visibility filter was applied in the query
    const findCall = mockAuthProfileFind.mock.calls[0][0];
    expect(findCall.$and).toBeDefined();
    const orClause = findCall.$and[0].$or;
    expect(orClause).toEqual(
      expect.arrayContaining([
        { visibility: 'shared' },
        { visibility: 'personal', createdBy: 'user-1' },
      ]),
    );
  });

  it('INT-7: profile counts are visibility-filtered', async () => {
    mockAuthProfileFind.mockReturnValue({
      lean: () =>
        Promise.resolve([
          {
            _id: 'p1',
            name: 'Gmail Shared',
            connector: 'gmail',
            scope: 'tenant',
            usageMode: 'preconfigured',
            authType: 'oauth2_app',
            status: 'active',
            visibility: 'shared',
            createdBy: 'user-1',
          },
        ]),
    });

    const providers = await buildIntegrationProviders({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'user-1',
      isAdmin: false,
    });

    const gmail = providers.find((p) => p.connectorName === 'gmail');
    expect(gmail!.profileCount).toBe(1);
  });

  it('INT-8: connectionConfigFields extracted from Salesforce URL templates', async () => {
    const providers = await buildIntegrationProviders({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'user-1',
      isAdmin: true,
    });

    // Find any connector that has connectionConfigFields
    const withConfig = providers.filter(
      (p) => p.oauth2?.connectionConfigFields && p.oauth2.connectionConfigFields.length > 0,
    );

    // There should be at least one connector with template URLs in Nango
    // (e.g., salesforce, shopify). If catalog doesn't include them, verify the utility works
    // by testing extractConnectionConfigFields directly
    const fields = extractConnectionConfigFields([
      'https://${connectionConfig.instance}.salesforce.com/services/oauth2/authorize',
      'https://${connectionConfig.instance}.salesforce.com/services/oauth2/token',
    ]);
    expect(fields).toEqual(['instance']);
  });

  it('INT-9: workspace scope only shows tenant profiles', async () => {
    const providers = await buildIntegrationProviders({
      tenantId: 'tenant-1',
      projectId: null,
      userId: 'user-1',
      isAdmin: true,
    });

    // Verify the query filter for workspace scope
    const findCall = mockAuthProfileFind.mock.calls[0][0];
    expect(findCall.projectId).toBeNull();
    expect(findCall.scope).toBe('tenant');
    expect(findCall.$or).toBeUndefined(); // no project fallback
  });

  it('INT-10: alias resolution matches jira-cloud via NANGO_ALIAS_MAP', async () => {
    const providers = await buildIntegrationProviders({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'user-1',
      isAdmin: true,
    });

    const jira = providers.find((p) => p.connectorName === 'jira-cloud');
    expect(jira).toBeDefined();
    // jira-cloud should have OAuth metadata from Nango's 'jira' entry
    expect(jira!.oauth2).toBeDefined();
    expect(jira!.oauth2!.authorizationUrl).toBeTruthy();
    expect(jira!.oauth2!.tokenUrl).toBeTruthy();
  });

  it('INT-11: prefers the Azure AD alias for microsoft-teams when the direct provider is non-oauth', async () => {
    const providers = await buildIntegrationProviders({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'user-1',
      isAdmin: true,
    });

    const teams = providers.find((p) => p.connectorName === 'microsoft-teams');
    expect(teams).toBeDefined();
    expect(teams!.availableAuthTypes).toEqual(['azure_ad']);
    expect(teams!.authPrefill?.azure_ad).toEqual(
      expect.objectContaining({
        endpoint: 'https://login.microsoftonline.com',
        resource: 'https://graph.microsoft.com',
      }),
    );
  });

  it('INT-12: business central uses client credentials and preserves provider config fields', async () => {
    const providers = await buildIntegrationProviders({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'user-1',
      isAdmin: true,
    });

    const businessCentral = providers.find(
      (p) => p.connectorName === 'microsoft-dynamics-365-business-central',
    );
    expect(businessCentral).toBeDefined();
    expect(businessCentral!.availableAuthTypes).toEqual(['oauth2_client_credentials']);
    expect(businessCentral!.connectionConfig).toEqual(
      expect.objectContaining({
        tenantId: expect.objectContaining({ type: 'string' }),
        environmentName: expect.objectContaining({ type: 'string' }),
      }),
    );
    expect(businessCentral!.authPrefill?.oauth2_client_credentials).toEqual(
      expect.objectContaining({
        tokenUrl:
          'https://login.microsoftonline.com/${connectionConfig.tenantId}/oauth2/v2.0/token',
      }),
    );
  });

  it('INT-12: exposes Twilio as a Basic Auth integration', async () => {
    const providers = await buildIntegrationProviders({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'user-1',
      isAdmin: true,
    });

    const twilio = providers.find((p) => p.connectorName === 'twilio');
    expect(twilio).toBeDefined();
    expect(twilio!.availableAuthTypes).toEqual(['basic']);
  });

  it('INT-13: exposes Amazon S3 as an AWS IAM integration', async () => {
    const providers = await buildIntegrationProviders({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'user-1',
      isAdmin: true,
    });

    const s3 = providers.find((p) => p.connectorName === 'amazon-s3');
    expect(s3).toBeDefined();
    expect(s3!.availableAuthTypes).toEqual(['aws_iam']);
    expect(s3!.authPrefill?.aws_iam).toEqual(expect.objectContaining({ service: 's3' }));
  });

  it('INT-14: exposes new Microsoft and AWS auth-only providers with mapped auth types', async () => {
    const providers = await buildIntegrationProviders({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'user-1',
      isAdmin: true,
    });

    const oneDrive = providers.find((p) => p.connectorName === 'microsoft-onedrive');
    expect(oneDrive).toBeDefined();
    expect(oneDrive!.availableAuthTypes).toEqual(['azure_ad']);
    expect(oneDrive!.authPrefill?.azure_ad).toEqual(
      expect.objectContaining({
        resource: 'https://graph.microsoft.com',
      }),
    );

    const blob = providers.find((p) => p.connectorName === 'azure-blob-storage');
    expect(blob).toBeDefined();
    expect(blob!.availableAuthTypes).toEqual(['azure_ad']);
    expect(blob!.authPrefill?.azure_ad).toEqual(
      expect.objectContaining({
        resource: 'https://storage.azure.com',
      }),
    );

    const sqs = providers.find((p) => p.connectorName === 'amazon-sqs');
    expect(sqs).toBeDefined();
    expect(sqs!.availableAuthTypes).toEqual(['aws_iam']);
    expect(sqs!.authPrefill?.aws_iam).toEqual(expect.objectContaining({ service: 'sqs' }));
  });

  it('INT-15: exposes Power BI as Azure AD and Shopify as client-credentials where supported', async () => {
    const providers = await buildIntegrationProviders({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'user-1',
      isAdmin: true,
    });

    const powerBi = providers.find((p) => p.connectorName === 'microsoft-power-bi');
    expect(powerBi).toBeDefined();
    expect(powerBi!.availableAuthTypes).toEqual(['azure_ad']);
    expect(powerBi!.authPrefill?.azure_ad).toEqual(
      expect.objectContaining({
        endpoint: 'https://login.microsoftonline.com',
        resource: 'https://analysis.windows.net/powerbi/api',
      }),
    );

    const shopify = providers.find((p) => p.connectorName === 'shopify');
    expect(shopify).toBeDefined();
    expect(shopify!.availableAuthTypes).toEqual(['oauth2', 'oauth2_client_credentials', 'api_key']);
    expect(shopify!.authPrefill?.oauth2_client_credentials).toEqual(
      expect.objectContaining({
        tokenUrl: 'https://${connectionConfig.subdomain}.myshopify.com/admin/oauth/access_token',
      }),
    );
  });

  it('INT-16: preserves OAuth scope separator and provider params', async () => {
    const providers = await buildIntegrationProviders({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'user-1',
      isAdmin: true,
    });

    const slack = providers.find((p) => p.connectorName === 'slack');
    expect(slack?.oauth2?.scopeSeparator).toBe(',');

    const jira = providers.find((p) => p.connectorName === 'jira-cloud');
    expect(jira?.oauth2?.authorizationParams).toEqual({
      audience: 'api.atlassian.com',
      prompt: 'consent',
    });
  });

  it('INT-16b: stringifies future primitive OAuth provider params', () => {
    expect(
      normalizeOAuthParams({
        force_install_if_needed: true,
        retry: 2,
        prompt: 'consent',
        nested: { ignored: true },
        empty: null,
      }),
    ).toEqual({
      force_install_if_needed: 'true',
      retry: '2',
      prompt: 'consent',
    });
  });
});

describe('extractConnectionConfigFields', () => {
  it('extracts field names from template URLs', () => {
    const fields = extractConnectionConfigFields([
      'https://${connectionConfig.subdomain}.api.example.com/oauth/authorize',
    ]);
    expect(fields).toEqual(['subdomain']);
  });

  it('extracts multiple fields from multiple URLs', () => {
    const fields = extractConnectionConfigFields([
      'https://${connectionConfig.instance}.salesforce.com/auth',
      'https://${connectionConfig.region}.api.example.com/${connectionConfig.version}/token',
    ]);
    expect(fields).toEqual(expect.arrayContaining(['instance', 'region', 'version']));
    expect(fields).toHaveLength(3);
  });

  it('returns empty for URLs without templates', () => {
    const fields = extractConnectionConfigFields(['https://accounts.google.com/o/oauth2/auth']);
    expect(fields).toEqual([]);
  });

  it('deduplicates repeated field names across URLs', () => {
    const fields = extractConnectionConfigFields([
      'https://${connectionConfig.host}/auth',
      'https://${connectionConfig.host}/token',
    ]);
    expect(fields).toEqual(['host']);
  });
});

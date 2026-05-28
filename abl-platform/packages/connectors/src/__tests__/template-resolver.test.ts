import { describe, expect, it, vi } from 'vitest';
import {
  normalizeConnectionConfig,
  resolveTemplatedParams,
  resolveTemplatedUrl,
} from '../auth/template-resolver.js';

const salesforceSource = {
  authorizationUrl:
    'https://${connectionConfig.hostname}/services/oauth2/authorize || https://login.salesforce.com/services/oauth2/authorize',
  tokenUrl:
    'https://${connectionConfig.hostname}/services/oauth2/token || https://login.salesforce.com/services/oauth2/token',
  proxyBaseUrl: '${connectionConfig.instance_url}',
  tokenParams: {
    audience: '${connectionConfig.hostname}',
    force_verify: false,
  },
  connectionConfig: {
    hostname: {
      type: 'string',
      title: 'Hostname',
      optional: true,
      format: 'hostname',
    },
    instance_url: {
      type: 'string',
      title: 'Instance Url',
      optional: false,
      format: 'uri',
    },
  },
};

describe('template-resolver', () => {
  it('normalizes catalog-backed connection config and resolves templated URLs and params', () => {
    const connectionConfig = normalizeConnectionConfig(
      {
        hostname: ' acme.my.salesforce.com ',
        instance_url: ' https://acme.my.salesforce.com ',
      },
      salesforceSource,
    );
    const validateResolvedUrl = vi.fn().mockReturnValue({ safe: true });

    const authorizationUrl = resolveTemplatedUrl(salesforceSource.authorizationUrl, {
      connectionConfig,
      validateResolvedUrl,
    });
    const tokenParams = resolveTemplatedParams(salesforceSource.tokenParams, { connectionConfig });

    expect(connectionConfig).toEqual({
      hostname: 'acme.my.salesforce.com',
      instance_url: 'https://acme.my.salesforce.com',
    });
    expect(authorizationUrl).toBe('https://acme.my.salesforce.com/services/oauth2/authorize');
    expect(tokenParams).toEqual({
      audience: 'acme.my.salesforce.com',
      force_verify: 'false',
    });
    expect(validateResolvedUrl).toHaveBeenCalledWith(
      'https://acme.my.salesforce.com/services/oauth2/authorize',
    );
  });

  it('supports dotted and hyphenated templated connectionConfig keys', () => {
    const dottedKeySource = {
      tokenUrl:
        'https://sentry.io/api/0/sentry-app-installations/${connectionConfig.installation.uuid}/authorizations/',
    };
    const dottedKeyConfig = normalizeConnectionConfig(
      { 'installation.uuid': 'install-123' },
      dottedKeySource,
    );

    expect(
      resolveTemplatedUrl(dottedKeySource.tokenUrl, {
        connectionConfig: dottedKeyConfig,
      }),
    ).toBe('https://sentry.io/api/0/sentry-app-installations/install-123/authorizations/');

    const hyphenKeySource = {
      tokenUrl: 'https://${connectionConfig.accounts-server}/oauth/v2/token',
    };
    const hyphenKeyConfig = normalizeConnectionConfig(
      { 'accounts-server': 'accounts.zoho.eu' },
      hyphenKeySource,
    );

    expect(
      resolveTemplatedUrl(hyphenKeySource.tokenUrl, {
        connectionConfig: hyphenKeyConfig,
      }),
    ).toBe('https://accounts.zoho.eu/oauth/v2/token');
  });

  it('rejects general connection config values that try to break URL structure', () => {
    const source = {
      authorizationUrl:
        'https://${connectionConfig.subdomain}.zendesk.com/oauth/authorizations/new',
      tokenUrl: 'https://${connectionConfig.subdomain}.zendesk.com/oauth/tokens',
      connectionConfig: {
        subdomain: { type: 'string', title: 'Subdomain', optional: false },
      },
    };

    for (const value of ['acme/path', 'acme?foo=1', 'acme#fragment', 'acme:8443', 'acme%2fprod']) {
      expect(() => normalizeConnectionConfig({ subdomain: value }, source)).toThrow(
        'connectionConfig.subdomain contains forbidden characters',
      );
    }
  });

  it('rejects invalid hostname and unsupported keys', () => {
    expect(() =>
      normalizeConnectionConfig(
        {
          hostname: 'acme.my.salesforce.com:8443',
          instance_url: 'https://acme.my.salesforce.com',
        },
        salesforceSource,
      ),
    ).toThrow('connectionConfig.hostname must be a valid hostname');

    expect(() =>
      normalizeConnectionConfig(
        {
          hostname: 'acme.my.salesforce.com',
          instance_url: 'https://acme.my.salesforce.com',
          unexpected: 'oops',
        },
        salesforceSource,
      ),
    ).toThrow('Unsupported connection configuration key: unexpected');
  });

  it('rejects values outside enum-constrained connection config options', () => {
    expect(() =>
      normalizeConnectionConfig(
        {
          extension: 'uk',
        },
        {
          connectionConfig: {
            extension: {
              type: 'string',
              title: 'Extension',
              optional: false,
              enum: ['com', 'eu'],
            },
          },
        },
      ),
    ).toThrow('connectionConfig.extension must be one of: com, eu');
  });

  it('rejects values that fail connection config pattern validation', () => {
    expect(() =>
      normalizeConnectionConfig(
        {
          tenantId: 'Tenant 01',
        },
        {
          connectionConfig: {
            tenantId: {
              type: 'string',
              title: 'Tenant ID',
              optional: false,
              pattern: '^[a-z0-9-]+$',
            },
          },
        },
      ),
    ).toThrow('connectionConfig.tenantId must match pattern ^[a-z0-9-]+$');
  });

  it('rejects connection config key and value overflow', () => {
    expect(() =>
      normalizeConnectionConfig(
        {
          hostname: 'acme.my.salesforce.com',
          instance_url: 'https://acme.my.salesforce.com',
          alpha: '1',
          beta: '2',
          gamma: '3',
          delta: '4',
          epsilon: '5',
          zeta: '6',
          eta: '7',
          theta: '8',
          iota: '9',
        },
        salesforceSource,
      ),
    ).toThrow('connectionConfig supports at most 10 keys');

    expect(() =>
      normalizeConnectionConfig(
        {
          hostname: 'a'.repeat(257),
          instance_url: 'https://acme.my.salesforce.com',
        },
        salesforceSource,
      ),
    ).toThrow('connectionConfig.hostname exceeds 256 characters');
  });
});

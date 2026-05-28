/**
 * ABLP-1123 — getAllowedConfigKeys is the schema-driven projection helper
 * used by the auth-profile slide-over to filter config payloads down to
 * exactly what the backend's strict Zod schema accepts. Locks the contract.
 */
import { describe, it, expect } from 'vitest';
import { getAllowedConfigKeys } from '../../validation/auth-profile.schema';

describe('getAllowedConfigKeys', () => {
  // ── Per auth type: keys that MUST be allowed, keys that MUST NOT leak.
  // The negative list is the value of this helper — projection drops them
  // even when the UI accidentally puts them in form state.
  const cases: Array<{
    authType: string;
    expected: string[];
    forbidden: string[];
  }> = [
    {
      authType: 'none',
      expected: [],
      forbidden: ['apiKey', 'connectionConfig', 'authorizationUrl', 'tokenUrl'],
    },
    {
      authType: 'api_key',
      expected: ['headerName', 'placement', 'prefix', 'connectionConfig'],
      forbidden: ['authorizationUrl', 'tokenUrl', 'refreshUrl', 'tenantId', 'region'],
    },
    {
      authType: 'bearer',
      expected: ['prefix', 'connectionConfig'],
      forbidden: ['authorizationUrl', 'tokenUrl', 'headerName', 'region'],
    },
    {
      authType: 'oauth2_app',
      // The schema declares authorizationUrl/tokenUrl/scopes/connectionConfig
      // plus a handful of OIDC and provider-metadata fields. Project does not
      // need to be exhaustive — these are the keys consumers rely on.
      expected: ['authorizationUrl', 'tokenUrl', 'scopes', 'connectionConfig'],
      forbidden: ['headerName', 'region', 'tenantId', 'bucket'],
    },
    {
      authType: 'oauth2_token',
      // User-token shape doesn't carry OAuth URLs — those live on the parent
      // oauth2_app config the token was issued against.
      expected: ['provider', 'scopes', 'tokenType', 'issuedAt'],
      forbidden: ['region', 'bucket', 'tenantId', 'authorizationUrl', 'connectionConfig'],
    },
    {
      authType: 'oauth2_client_credentials',
      expected: ['tokenUrl'],
      // Schemas of THIS family explicitly reject these — the leak fix lives here.
      forbidden: ['authorizationUrl', 'refreshUrl', 'connectionConfig', 'headerName'],
    },
    {
      authType: 'basic',
      expected: [],
      forbidden: ['authorizationUrl', 'tokenUrl', 'connectionConfig', 'username', 'password'],
    },
    {
      authType: 'aws_iam',
      expected: ['region', 'service', 'bucket', 'endpoint'],
      forbidden: ['authorizationUrl', 'tokenUrl', 'connectionConfig', 'tenantId', 'headerName'],
    },
    {
      authType: 'azure_ad',
      expected: ['tenantId', 'resource', 'endpoint', 'scopes'],
      forbidden: ['authorizationUrl', 'tokenUrl', 'connectionConfig', 'region', 'bucket'],
    },
  ];

  for (const { authType, expected, forbidden } of cases) {
    it(`${authType}: returns the schema-declared keys and excludes foreign keys`, () => {
      const allowed = getAllowedConfigKeys(authType);
      // It returns a Set we can introspect.
      expect(allowed).toBeInstanceOf(Set);
      // Every declared key is present.
      for (const key of expected) {
        expect(allowed.has(key)).toBe(true);
      }
      // Every foreign key the projection must strip is NOT present.
      for (const key of forbidden) {
        expect(allowed.has(key)).toBe(false);
      }
    });
  }

  it('returns an empty set for an unknown auth type (defensive)', () => {
    const allowed = getAllowedConfigKeys('not-a-real-auth-type');
    expect(allowed).toBeInstanceOf(Set);
    expect(allowed.size).toBe(0);
  });

  it('projection used as Object.fromEntries filter drops a leaked key', () => {
    // Reproduces the Shopify-style bug: a UI accidentally writes OAuth URLs
    // into an api_key config payload. Projection must drop them so the API
    // does not 400 with VALIDATION_ERROR.
    const config = {
      headerName: 'x-shopify-access-token',
      placement: 'header',
      authorizationUrl: 'https://korestorera.myshopify.com/admin/oauth/authorize',
      tokenUrl: 'https://korestorera.myshopify.com/admin/oauth/access_token',
      connectionConfig: { subdomain: 'korestorera' },
    };
    const allowed = getAllowedConfigKeys('api_key');
    const projected = Object.fromEntries(Object.entries(config).filter(([k]) => allowed.has(k)));
    expect(projected).toEqual({
      headerName: 'x-shopify-access-token',
      placement: 'header',
      connectionConfig: { subdomain: 'korestorera' },
    });
    expect(projected).not.toHaveProperty('authorizationUrl');
    expect(projected).not.toHaveProperty('tokenUrl');
  });
});

import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequireAuth = vi.fn();
const mockRequireProjectAccess = vi.fn();
const mockValidateUrlForSSRF = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  isAuthError: (value: unknown) => value instanceof NextResponse,
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: unknown[]) => mockRequireProjectAccess(...args),
  isAccessError: (value: unknown) => value instanceof NextResponse,
}));

vi.mock('@agent-platform/shared/security', () => ({
  validateUrlForSSRF: (...args: unknown[]) => mockValidateUrlForSSRF(...args),
}));

vi.mock('@agent-platform/shared-kernel/security', () => ({
  getDevSSRFOptions: () => ({}),
}));

import {
  BLOCKED_OAUTH_URL_ERROR_MESSAGE,
  INVALID_CONNECTION_CONFIG_ERROR_MESSAGE,
  consumePendingState,
  getInitiateConnectorOAuthErrorResponse,
  initiateConnectorOAuth,
} from '@/lib/connector-oauth';
import { POST } from '@/app/api/projects/[id]/connections/oauth/initiate/route';

function makeInitiateRequest(body: unknown): NextRequest {
  return makeInitiateRequestWithUrl(
    body,
    'http://localhost:3000/api/projects/proj-1/connections/oauth/initiate',
  );
}

function makeInitiateRequestWithUrl(body: unknown, url: string): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      origin: 'https://evil.example.com',
      'x-forwarded-host': 'evil.example.com',
      'x-forwarded-proto': 'https',
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.STUDIO_OAUTH_ALLOWED_ORIGINS;
  process.env.OAUTH_PROVIDER_SALESFORCE_CLIENT_ID = 'salesforce-client-id';
  process.env.OAUTH_PROVIDER_SALESFORCE_CLIENT_SECRET = 'salesforce-client-secret';
  process.env.OAUTH_PROVIDER_ZENDESK_CLIENT_ID = 'zendesk-client-id';
  process.env.OAUTH_PROVIDER_ZENDESK_CLIENT_SECRET = 'zendesk-client-secret';
  mockRequireAuth.mockResolvedValue({
    id: 'user-1',
    tenantId: 'tenant-1',
    permissions: ['connection:write'],
  });
  mockRequireProjectAccess.mockResolvedValue({
    project: { id: 'proj-1', tenantId: 'tenant-1' },
  });
  mockValidateUrlForSSRF.mockReturnValue({ safe: true });
});

describe('connector-oauth', () => {
  it('stores connection context and preserves provider-specific params', () => {
    const catalog = [
      {
        name: 'salesforce',
        oauth2: {
          authorizationUrl:
            'https://${connectionConfig.hostname}/services/oauth2/authorize || https://login.salesforce.com/services/oauth2/authorize',
          tokenUrl:
            'https://${connectionConfig.hostname}/services/oauth2/token || https://login.salesforce.com/services/oauth2/token',
          authorizationParams: { prompt: 'consent', force_verify: false },
          tokenParams: { request: 'token' },
          connectionConfig: {
            hostname: { type: 'string', title: 'Hostname', optional: true },
          },
          defaultScopes: ['full', 'api'],
          scopeSeparator: ' ',
          pkce: false,
        },
      },
    ];

    const { authUrl, state } = initiateConnectorOAuth(
      catalog,
      'salesforce',
      'https://studio.example.com/oauth/callback',
      { hostname: 'acme.my.salesforce.com' },
      'Acme Salesforce',
    );
    const parsedAuthUrl = new URL(authUrl);
    const pending = consumePendingState(state);

    expect(parsedAuthUrl.origin).toBe('https://acme.my.salesforce.com');
    expect(parsedAuthUrl.searchParams.get('prompt')).toBe('consent');
    expect(parsedAuthUrl.searchParams.get('force_verify')).toBe('false');
    expect(parsedAuthUrl.searchParams.get('scope')).toBe('full api');
    expect(pending).toMatchObject({
      displayName: 'Acme Salesforce',
      connectionConfig: { hostname: 'acme.my.salesforce.com' },
      tokenUrl: 'https://acme.my.salesforce.com/services/oauth2/token',
      tokenParams: { request: 'token' },
    });
  });

  it('uses fallback OAuth URLs when optional connection config is omitted', () => {
    const catalog = [
      {
        name: 'salesforce',
        oauth2: {
          authorizationUrl:
            'https://${connectionConfig.hostname}/services/oauth2/authorize || https://login.salesforce.com/services/oauth2/authorize',
          tokenUrl:
            'https://${connectionConfig.hostname}/services/oauth2/token || https://login.salesforce.com/services/oauth2/token',
          defaultScopes: ['api'],
          scopeSeparator: ' ',
          pkce: false,
        },
      },
    ];

    const { authUrl, state } = initiateConnectorOAuth(
      catalog,
      'salesforce',
      'https://studio.example.com/oauth/callback',
    );
    const parsedAuthUrl = new URL(authUrl);
    const pending = consumePendingState(state);

    expect(parsedAuthUrl.origin).toBe('https://login.salesforce.com');
    expect(pending?.tokenUrl).toBe('https://login.salesforce.com/services/oauth2/token');
  });

  it('resolves templated OAuth URLs with provided connection config', () => {
    const catalog = [
      {
        name: 'salesforce',
        oauth2: {
          authorizationUrl:
            'https://${connectionConfig.hostname}/services/oauth2/authorize || https://login.salesforce.com/services/oauth2/authorize',
          tokenUrl:
            'https://${connectionConfig.hostname}/services/oauth2/token || https://login.salesforce.com/services/oauth2/token',
          defaultScopes: ['api'],
          scopeSeparator: ' ',
          pkce: false,
        },
      },
    ];

    const { authUrl, state } = initiateConnectorOAuth(
      catalog,
      'salesforce',
      'https://studio.example.com/oauth/callback',
      { hostname: 'acme.my.salesforce.com' },
    );
    const parsedAuthUrl = new URL(authUrl);
    const pending = consumePendingState(state);

    expect(parsedAuthUrl.origin).toBe('https://acme.my.salesforce.com');
    expect(pending?.tokenUrl).toBe('https://acme.my.salesforce.com/services/oauth2/token');
  });

  it('rejects connectors with unresolved required connection config', () => {
    const catalog = [
      {
        name: 'zendesk',
        oauth2: {
          authorizationUrl:
            'https://${connectionConfig.subdomain}.zendesk.com/oauth/authorizations/new',
          tokenUrl: 'https://${connectionConfig.subdomain}.zendesk.com/oauth/tokens',
          defaultScopes: ['tickets:read'],
          scopeSeparator: ' ',
          pkce: false,
        },
      },
    ];

    expect(() =>
      initiateConnectorOAuth(catalog, 'zendesk', 'https://studio.example.com/oauth/callback'),
    ).toThrow('Missing required connection configuration: subdomain');
  });

  it('rejects connectionConfig values that try to rewrite the OAuth URL structure', () => {
    const catalog = [
      {
        name: 'zendesk',
        oauth2: {
          authorizationUrl:
            'https://${connectionConfig.subdomain}.zendesk.com/oauth/authorizations/new',
          tokenUrl: 'https://${connectionConfig.subdomain}.zendesk.com/oauth/tokens',
          connectionConfig: {
            subdomain: { type: 'string', title: 'Subdomain', optional: false },
          },
          defaultScopes: ['tickets:read'],
          scopeSeparator: ' ',
          pkce: false,
        },
      },
    ];

    expect(() =>
      initiateConnectorOAuth(catalog, 'zendesk', 'https://studio.example.com/oauth/callback', {
        subdomain: 'acme:8443/custom?x=1',
      }),
    ).toThrow('connectionConfig.subdomain contains forbidden characters');
  });

  it('rejects unsupported or oversized connectionConfig payloads', () => {
    const catalog = [
      {
        name: 'salesforce',
        oauth2: {
          authorizationUrl:
            'https://${connectionConfig.hostname}/services/oauth2/authorize || https://login.salesforce.com/services/oauth2/authorize',
          tokenUrl:
            'https://${connectionConfig.hostname}/services/oauth2/token || https://login.salesforce.com/services/oauth2/token',
          connectionConfig: {
            hostname: { type: 'string', title: 'Hostname', optional: true, format: 'hostname' },
          },
          defaultScopes: ['api'],
          scopeSeparator: ' ',
          pkce: false,
        },
      },
    ];

    expect(() =>
      initiateConnectorOAuth(catalog, 'salesforce', 'https://studio.example.com/oauth/callback', {
        hostname: 'acme.my.salesforce.com',
        unexpected: 'oops',
      }),
    ).toThrow('Unsupported connection configuration key: unexpected');

    expect(() =>
      initiateConnectorOAuth(catalog, 'salesforce', 'https://studio.example.com/oauth/callback', {
        hostname: 'a'.repeat(257),
      }),
    ).toThrow('connectionConfig.hostname exceeds 256 characters');
  });

  it('blocks SSRF-unsafe resolved OAuth URLs', () => {
    mockValidateUrlForSSRF.mockReturnValue({ safe: false, reason: 'blocked by SSRF policy' });

    const catalog = [
      {
        name: 'salesforce',
        oauth2: {
          authorizationUrl:
            'https://${connectionConfig.hostname}/services/oauth2/authorize || https://login.salesforce.com/services/oauth2/authorize',
          tokenUrl:
            'https://${connectionConfig.hostname}/services/oauth2/token || https://login.salesforce.com/services/oauth2/token',
          defaultScopes: ['api'],
          scopeSeparator: ' ',
          pkce: false,
        },
      },
    ];

    expect(() =>
      initiateConnectorOAuth(catalog, 'salesforce', 'https://studio.example.com/oauth/callback', {
        hostname: '169.254.169.254',
      }),
    ).toThrow('blocked by SSRF policy');
  });

  it('maps missing connectionConfig details to the public client error contract', () => {
    expect(
      getInitiateConnectorOAuthErrorResponse(
        new Error('Missing required connection configuration: subdomain'),
      ),
    ).toEqual({
      status: 400,
      message: INVALID_CONNECTION_CONFIG_ERROR_MESSAGE,
    });
  });
});

describe('deprecated connection oauth initiate route', () => {
  it('returns 410 with guidance to use auth profile OAuth flows', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://studio.example.com/workspace';

    const response = await POST(makeInitiateRequest({ connectorName: 'salesforce' }), {
      params: Promise.resolve({ id: 'proj-1' }),
    });
    const payload = await response.json();

    expect(response.status).toBe(410);
    expect(payload).toEqual({
      success: false,
      error:
        'OAuth connections are now created via auth profiles. Use the auth profile OAuth flow to initiate authorization.',
    });
  });

  it('short-circuits before any legacy OAuth URL validation', async () => {
    const response = await POST(
      makeInitiateRequestWithUrl(
        {
          connectorName: 'salesforce',
          connectionConfig: { hostname: '169.254.169.254' },
        },
        'https://eu.studio.example.com/api/projects/proj-1/connections/oauth/initiate',
      ),
      {
        params: Promise.resolve({ id: 'proj-1' }),
      },
    );
    const payload = await response.json();

    expect(response.status).toBe(410);
    expect(payload.error).toContain('auth profiles');
    expect(mockValidateUrlForSSRF).not.toHaveBeenCalled();
  });
});

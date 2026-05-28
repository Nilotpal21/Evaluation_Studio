/**
 * OAuth Initiate Integration Tests
 *
 * Tests authorizationParams merging and unresolved template variable validation
 * in the OAuth initiate route. Mocks external boundaries only (auth, DB,
 * Redis, security) — the route handler logic under test is real.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks — auth (external boundary)
// ---------------------------------------------------------------------------

const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);

vi.mock('@/lib/auth', () => ({
  requireAuth: mockRequireAuth,
  isAuthError: mockIsAuthError,
  formatUserLabel: (user: { name?: string; email?: string; id: string }) =>
    user.name || user.email || user.id,
}));

vi.mock('@/services/auth-service', () => ({
  verifyAccessToken: vi.fn(),
}));

vi.mock('@/repos/auth-repo', () => ({
  findUserById: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mocks — project access (external boundary)
// ---------------------------------------------------------------------------

const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn(() => false);

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: mockRequireProjectAccess,
  isAccessError: mockIsAccessError,
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mocks — database models (external boundary)
// ---------------------------------------------------------------------------

const mockAuthProfileFindOne = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  AuthProfile: {
    findOne: mockAuthProfileFindOne,
  },
  // ABLP-619: AuthProfileStatusSchema (in shared/validation) is sourced from
  // this const at module-init time, so the mock must expose it.
  AUTH_PROFILE_STATUSES: [
    'active',
    'expired',
    'revoked',
    'invalid',
    'pending_authorization',
  ] as const,
}));

// ---------------------------------------------------------------------------
// Mocks — Redis (external boundary)
// ---------------------------------------------------------------------------

const mockRedisSet = vi.fn().mockResolvedValue('OK');
vi.mock('@/lib/redis-client', () => ({
  getRedisClient: vi.fn(() => ({
    set: mockRedisSet,
  })),
}));

// ---------------------------------------------------------------------------
// Mocks — Security (external boundary)
// ---------------------------------------------------------------------------

vi.mock('@agent-platform/shared/security', () => ({
  validateUrlForSSRF: vi.fn().mockReturnValue({ safe: true }),
}));

vi.mock('@agent-platform/shared-kernel/security', () => ({
  getDevSSRFOptions: vi.fn(() => ({})),
}));

vi.mock('@/app/api/auth-profiles/_auth-profile-route-utils', async () => {
  const actual = await vi.importActual<
    typeof import('@/app/api/auth-profiles/_auth-profile-route-utils')
  >('@/app/api/auth-profiles/_auth-profile-route-utils');

  return {
    ...actual,
    ensureUsableOAuthAppProfile: vi.fn(() => null),
    resolveOAuthCallbackOrigin: vi.fn(() => 'http://localhost:5173'),
    buildPkceChallenge: vi.fn(() => ({})),
  };
});

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const TENANT_ID = 'tenant-oauth-1';
const PROJECT_ID = 'project-oauth-1';
const USER_ID = 'user-oauth-1';

const defaultUser = {
  id: USER_ID,
  email: 'test@example.com',
  tenantId: TENANT_ID,
  permissions: ['*:*'],
};

function setupAuth() {
  mockRequireAuth.mockResolvedValue(defaultUser);
  mockRequireProjectAccess.mockResolvedValue({
    project: { id: PROJECT_ID, tenantId: TENANT_ID },
  });
}

function makeProfile(configOverrides: Record<string, unknown> = {}) {
  const baseConfig = {
    authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    defaultScopes: ['email', 'profile'],
  };
  return {
    _id: 'profile-oauth-1',
    name: 'Google OAuth',
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    scope: 'project',
    authType: 'oauth2_app',
    connector: 'google',
    status: 'active',
    visibility: 'shared',
    encryptedSecrets: JSON.stringify({ clientId: 'test-client-id', clientSecret: 'test-secret' }),
    config: { ...baseConfig, ...configOverrides },
  };
}

// ---------------------------------------------------------------------------
// Tests — Initiate Route
// ---------------------------------------------------------------------------

describe('OAuth Initiate — authorizationParams & template validation', () => {
  let POST: (
    req: NextRequest,
    ctx: { params: Promise<Record<string, string>> },
  ) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import('../../../app/api/projects/[id]/auth-profiles/oauth/initiate/route');
    POST = mod.POST;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    setupAuth();
  });

  it('INT-1: authorizationParams merged as query params in authorization URL', async () => {
    mockAuthProfileFindOne.mockResolvedValue(
      makeProfile({
        authorizationParams: { access_type: 'offline', prompt: 'consent' },
      }),
    );

    const req = new NextRequest(
      'http://localhost/api/projects/project-oauth-1/auth-profiles/oauth/initiate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
        body: JSON.stringify({
          connectorName: 'google',
          authProfileId: 'profile-oauth-1',
        }),
      },
    );

    const res = await POST(req, { params: Promise.resolve({ id: PROJECT_ID }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    const authUrl = new URL(body.data.authUrl);
    expect(authUrl.searchParams.get('access_type')).toBe('offline');
    expect(authUrl.searchParams.get('prompt')).toBe('consent');
  });

  it('INT-2: standard OAuth params NOT overwritten by authorizationParams', async () => {
    mockAuthProfileFindOne.mockResolvedValue(
      makeProfile({
        authorizationParams: {
          client_id: 'attacker-id',
          redirect_uri: 'https://evil.com/callback',
          response_type: 'token',
        },
      }),
    );

    const req = new NextRequest(
      'http://localhost/api/projects/project-oauth-1/auth-profiles/oauth/initiate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
        body: JSON.stringify({
          connectorName: 'google',
          authProfileId: 'profile-oauth-1',
        }),
      },
    );

    const res = await POST(req, { params: Promise.resolve({ id: PROJECT_ID }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    const authUrl = new URL(body.data.authUrl);
    // Standard params must NOT be overwritten
    expect(authUrl.searchParams.get('client_id')).toBe('test-client-id');
    expect(authUrl.searchParams.get('redirect_uri')).toContain('localhost');
    expect(authUrl.searchParams.get('response_type')).toBe('code');
  });

  it('INT-3: empty authorizationParams has no effect on URL (backward compatible)', async () => {
    mockAuthProfileFindOne.mockResolvedValue(makeProfile());

    const req = new NextRequest(
      'http://localhost/api/projects/project-oauth-1/auth-profiles/oauth/initiate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
        body: JSON.stringify({
          connectorName: 'google',
          authProfileId: 'profile-oauth-1',
        }),
      },
    );

    const res = await POST(req, { params: Promise.resolve({ id: PROJECT_ID }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    const authUrl = new URL(body.data.authUrl);
    expect(authUrl.searchParams.get('client_id')).toBe('test-client-id');
    expect(authUrl.searchParams.get('response_type')).toBe('code');
    expect(authUrl.searchParams.has('access_type')).toBe(false);
    expect(authUrl.searchParams.has('prompt')).toBe(false);
  });

  it('INT-4: connectionConfig values stored in config accessible at initiate time', async () => {
    mockAuthProfileFindOne.mockResolvedValue(
      makeProfile({
        authorizationUrl: 'https://mycompany.salesforce.com/services/oauth2/authorize',
        tokenUrl: 'https://mycompany.salesforce.com/services/oauth2/token',
        defaultScopes: ['full'],
        connectionConfig: { subdomain: 'mycompany' },
      }),
    );

    const req = new NextRequest(
      'http://localhost/api/projects/project-oauth-1/auth-profiles/oauth/initiate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
        body: JSON.stringify({
          connectorName: 'salesforce',
          authProfileId: 'profile-oauth-1',
        }),
      },
    );

    const res = await POST(req, { params: Promise.resolve({ id: PROJECT_ID }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    const authUrl = new URL(body.data.authUrl);
    expect(authUrl.hostname).toBe('mycompany.salesforce.com');
  });

  it('INT-5: returns 400 when URL contains unresolved template patterns', async () => {
    mockAuthProfileFindOne.mockResolvedValue(
      makeProfile({
        authorizationUrl:
          'https://${connectionConfig.subdomain}.salesforce.com/services/oauth2/authorize',
        tokenUrl: 'https://${connectionConfig.subdomain}.salesforce.com/services/oauth2/token',
        defaultScopes: ['full'],
      }),
    );

    const req = new NextRequest(
      'http://localhost/api/projects/project-oauth-1/auth-profiles/oauth/initiate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
        body: JSON.stringify({
          connectorName: 'salesforce',
          authProfileId: 'profile-oauth-1',
        }),
      },
    );

    const res = await POST(req, { params: Promise.resolve({ id: PROJECT_ID }) });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.errors[0].msg).toContain('Unresolved template variables');
    expect(body.errors[0].msg).toContain('subdomain');
  });
});

/**
 * Tests for SSO API Routes
 *
 * Covers:
 *   POST /api/sso/config               - Create/update SSO configuration
 *   GET  /api/sso/init                  - Determine SSO flow from email domain
 *   POST /api/sso/exchange              - Exchange one-time auth code for tokens
 *   POST /api/sso/domains               - Claim a domain for SSO
 *   POST /api/sso/domains/verify        - Verify domain via DNS
 *   GET  /api/sso/oidc/callback         - Handle OIDC callback
 *   POST /api/sso/saml/callback         - Handle SAML callback
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);
const mockLogAuditEvent = vi.fn();
const mockResolveTxt = vi.fn();
const mockFetch = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireAuth: mockRequireAuth,
  isAuthError: mockIsAuthError,
}));

const mockCreateTokenPair = vi.fn(() => ({
  accessToken: 'new-access-token',
  refreshToken: 'new-refresh-token',
  expiresIn: 900,
}));
const mockResolveUserContextOrAutoAcceptInvite = vi.fn(() => ({
  tenantContext: { tenantId: 'tenant-1', role: 'member' },
  pendingInvitationChoice: false,
}));
const mockCreatePartialToken = vi.fn(() => 'mfa-partial-token');

vi.mock('@/services/auth-service', () => ({
  verifyAccessToken: vi.fn(),
  createTokenPair: mockCreateTokenPair,
  createPartialToken: mockCreatePartialToken,
  resolveUserContextOrAutoAcceptInvite: mockResolveUserContextOrAutoAcceptInvite,
  resolveUserTenantContext: vi.fn(() => ({ tenantId: 'tenant-1', role: 'member' })),
}));

const mockFindUserByEmail = vi.fn();
const mockCreateUser = vi.fn(() => ({ id: 'user-new', email: 'new@test.com', name: 'New User' }));
const mockUpdateUser = vi.fn(() => ({ id: 'user-1', email: 'test@test.com', name: 'Test User' }));

vi.mock('@/repos/auth-repo', () => ({
  findUserById: vi.fn(),
  findUserByEmail: mockFindUserByEmail,
  createUser: mockCreateUser,
  updateUser: mockUpdateUser,
}));

const mockFindTenantById = vi.fn();
const mockFindTenantMemberByUserIdAndRoles = vi.fn();

vi.mock('@/repos/workspace-repo', () => ({
  findTenantById: mockFindTenantById,
  findTenantMemberByUserIdAndRoles: mockFindTenantMemberByUserIdAndRoles,
}));

const mockCreateSSOConfig = vi.fn();
const mockFindDomainMapping = vi.fn();
const mockUpsertDomainMapping = vi.fn();
const mockFindSSOConfig = vi.fn();
const mockUpdateDomainMapping = vi.fn();
const mockEncryptForTenantAuto = vi.fn(async (value: string) => `encrypted:${value}`);
const mockDecryptForTenantAuto = vi.fn(async (value: string) => value);
const mockIsTenantEncryptionReady = vi.fn(() => true);

vi.mock('@/repos/org-repo', () => ({
  createSSOConfig: mockCreateSSOConfig,
  findDomainMapping: mockFindDomainMapping,
  upsertDomainMapping: mockUpsertDomainMapping,
  findSSOConfig: mockFindSSOConfig,
  updateDomainMapping: mockUpdateDomainMapping,
  findOrgBySAMLIssuer: vi.fn(),
}));

vi.mock('@/services/audit-service', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
  AuditActions: {
    LOGIN: 'login',
    SSO_CONFIG_CREATED: 'sso_config_created',
    SSO_DOMAIN_VERIFIED: 'sso_domain_verified',
    SSO_LOGIN: 'sso_login',
    SSO_LOGIN_FAILED: 'sso_login_failed',
    SSO_ASSERTION_REPLAY_DETECTED: 'sso_assertion_replay_detected',
  },
}));

vi.mock('@agent-platform/shared/encryption', () => ({
  isEncryptionAvailable: vi.fn(() => false),
  getEncryptionService: vi.fn(),
  encryptForTenantAuto: (...args: unknown[]) =>
    mockEncryptForTenantAuto(...(args as Parameters<typeof mockEncryptForTenantAuto>)),
  decryptForTenantAuto: (...args: unknown[]) =>
    mockDecryptForTenantAuto(...(args as Parameters<typeof mockDecryptForTenantAuto>)),
  isTenantEncryptionReady: (...args: unknown[]) =>
    mockIsTenantEncryptionReady(...(args as Parameters<typeof mockIsTenantEncryptionReady>)),
}));

vi.mock('@/config', () => ({
  getConfig: vi.fn(() => ({
    jwt: { secret: 'test-secret' },
    server: { apiUrl: 'http://localhost:3000', frontendUrl: 'http://localhost:5173' },
    auth: {
      tokens: {
        refreshCookieMaxAgeSeconds: 7 * 24 * 60 * 60,
        mfaCookieMaxAgeSeconds: 300,
      },
      validation: {
        emailRegex: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
      },
      rateLimits: {
        ssoDomains: { maxAttempts: 10, windowMs: 60 * 60 * 1000 },
      },
      sso: {
        samlAssertionTtlSeconds: 3600,
      },
    },
  })),
  isConfigLoaded: vi.fn(() => true),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));

const mockConsumeAuthCode = vi.fn();
const mockStoreAuthCode = vi.fn();
vi.mock('@/lib/sso-auth-codes', () => ({
  consumeAuthCode: mockConsumeAuthCode,
  storeAuthCode: mockStoreAuthCode,
}));

const mockConsumeOIDCState = vi.fn();
const mockStoreOIDCState = vi.fn();
vi.mock('@/lib/sso-state-store', () => ({
  storeOIDCState: mockStoreOIDCState,
  consumeOIDCState: mockConsumeOIDCState,
}));

const mockGetMFAStatus = vi.fn();
vi.mock('@/services/auth/mfa-service', () => ({
  getMFAStatus: mockGetMFAStatus,
}));

const mockValidateSamlResponse = vi.fn().mockResolvedValue({
  profile: { nameID: 'user@test.com', email: 'user@test.com' },
});

vi.mock('@node-saml/node-saml', () => ({
  SAML: vi.fn(function MockSAML() {
    return {
      validatePostResponseAsync: mockValidateSamlResponse,
    };
  }),
}));

vi.mock('dns', () => ({
  resolveTxt: (...args: unknown[]) => mockResolveTxt(...args),
}));

vi.mock('util', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  promisify: (fn: unknown) => fn,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testUser = {
  id: 'user-1',
  email: 'test@test.com',
  name: 'Test User',
  tenantId: 'tenant-1',
  role: 'admin',
};

function makeRequest(url: string, body?: unknown, method = 'POST'): NextRequest {
  const opts: Record<string, unknown> = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  return new NextRequest(new URL(url, 'http://localhost:3000'), opts);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockReset();
  mockRequireAuth.mockResolvedValue(testUser);
  mockIsAuthError.mockReturnValue(false);
  mockIsTenantEncryptionReady.mockReturnValue(true);
  mockEncryptForTenantAuto.mockResolvedValue('encrypted:config');
  mockDecryptForTenantAuto.mockImplementation(async (value: string) => value);
  mockResolveUserContextOrAutoAcceptInvite.mockResolvedValue({
    tenantContext: { tenantId: 'tenant-1', role: 'member' },
    pendingInvitationChoice: false,
  });
  mockGetMFAStatus.mockResolvedValue({ enabled: false });
  mockValidateSamlResponse.mockResolvedValue({
    profile: { nameID: 'user@test.com', email: 'user@test.com' },
  });
  mockFindUserByEmail.mockResolvedValue(null);
  mockCreateUser.mockResolvedValue({ id: 'user-new', email: 'new@test.com', name: 'New User' });
  mockUpdateUser.mockResolvedValue({ id: 'user-1', email: 'test@test.com', name: 'Test User' });
  mockLogAuditEvent.mockReset();
  mockResolveTxt.mockReset();
  global.fetch = mockFetch as typeof global.fetch;
});

// ===========================================================================
// POST /api/sso/config
// ===========================================================================

describe('POST /api/sso/config', () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/sso/config/route');
    handler = mod.POST;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const res = await handler(makeRequest('/api/sso/config', { protocol: 'saml' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid protocol', async () => {
    const res = await handler(makeRequest('/api/sso/config', { protocol: 'invalid' }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('Invalid protocol');
  });

  it('returns 400 for missing protocol', async () => {
    const res = await handler(makeRequest('/api/sso/config', {}));
    expect(res.status).toBe(400);
  });

  it('returns 403 when user is not admin', async () => {
    mockFindTenantMemberByUserIdAndRoles.mockResolvedValue(null);

    const res = await handler(makeRequest('/api/sso/config', { protocol: 'saml' }));
    expect(res.status).toBe(403);
  });

  it('returns 403 when tenant has no org', async () => {
    mockFindTenantMemberByUserIdAndRoles.mockResolvedValue({ tenantId: 'tenant-1' });
    mockFindTenantById.mockResolvedValue({ id: 'tenant-1', organizationId: null });

    const res = await handler(makeRequest('/api/sso/config', { protocol: 'saml' }));
    expect(res.status).toBe(403);
  });

  it('creates SSO config successfully', async () => {
    mockFindTenantMemberByUserIdAndRoles.mockResolvedValue({ tenantId: 'tenant-1' });
    mockFindTenantById.mockResolvedValue({ id: 'tenant-1', organizationId: 'org-1' });
    mockCreateSSOConfig.mockResolvedValue({
      id: 'sso-1',
      protocol: 'saml',
      forceSso: false,
      allowGoogleFallback: true,
    });

    const res = await handler(
      makeRequest('/api/sso/config', {
        protocol: 'saml',
        saml: { ssoUrl: 'https://idp.example.com/sso' },
      }),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.id).toBe('sso-1');
    expect(body.protocol).toBe('saml');
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        action: 'sso_config_created',
        metadata: expect.objectContaining({
          organizationId: 'org-1',
          protocol: 'saml',
          resourceId: 'sso-1',
        }),
      }),
    );
  });

  it('creates OIDC config successfully', async () => {
    mockFindTenantMemberByUserIdAndRoles.mockResolvedValue({ tenantId: 'tenant-1' });
    mockFindTenantById.mockResolvedValue({ id: 'tenant-1', organizationId: 'org-1' });
    mockCreateSSOConfig.mockResolvedValue({
      id: 'sso-2',
      protocol: 'oidc',
      forceSso: true,
      allowGoogleFallback: false,
    });

    const res = await handler(
      makeRequest('/api/sso/config', {
        protocol: 'oidc',
        forceSso: true,
        allowGoogleFallback: false,
        oidc: { clientId: 'client-id', authorizationUrl: 'https://auth.example.com/authorize' },
      }),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.protocol).toBe('oidc');
    expect(body.forceSso).toBe(true);
  });

  it('returns 500 on service error', async () => {
    mockFindTenantMemberByUserIdAndRoles.mockResolvedValue({ tenantId: 'tenant-1' });
    mockFindTenantById.mockResolvedValue({ id: 'tenant-1', organizationId: 'org-1' });
    mockCreateSSOConfig.mockRejectedValue(new Error('DB error'));

    const res = await handler(makeRequest('/api/sso/config', { protocol: 'saml' }));
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// GET /api/sso/init
// ===========================================================================

describe('GET /api/sso/init', () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/sso/init/route');
    handler = mod.GET;
  });

  it('returns 400 for missing email', async () => {
    const req = new NextRequest(new URL('/api/sso/init', 'http://localhost:3000'));
    const res = await handler(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('email');
  });

  it('returns 400 for invalid email', async () => {
    const req = new NextRequest(
      new URL('/api/sso/init?email=not-an-email', 'http://localhost:3000'),
    );
    const res = await handler(req);
    expect(res.status).toBe(400);
  });

  it('returns ssoEnabled false when no domain mapping found', async () => {
    mockFindDomainMapping.mockResolvedValue(null);

    const req = new NextRequest(
      new URL('/api/sso/init?email=user@unknown.com', 'http://localhost:3000'),
    );
    const res = await handler(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ssoEnabled).toBe(false);
  });

  it('returns ssoEnabled false when domain not verified', async () => {
    mockFindDomainMapping.mockResolvedValue({
      domain: 'example.com',
      verified: false,
      organizationId: 'org-1',
    });

    const req = new NextRequest(
      new URL('/api/sso/init?email=user@example.com', 'http://localhost:3000'),
    );
    const res = await handler(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ssoEnabled).toBe(false);
  });

  it('returns ssoEnabled false when no active SSO config', async () => {
    mockFindDomainMapping.mockResolvedValue({
      domain: 'example.com',
      verified: true,
      organizationId: 'org-1',
    });
    mockFindSSOConfig.mockResolvedValue(null);

    const req = new NextRequest(
      new URL('/api/sso/init?email=user@example.com', 'http://localhost:3000'),
    );
    const res = await handler(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ssoEnabled).toBe(false);
  });

  it('returns SAML redirect URL for SAML config', async () => {
    mockFindDomainMapping.mockResolvedValue({
      domain: 'example.com',
      verified: true,
      organizationId: 'org-1',
    });
    mockFindSSOConfig.mockResolvedValue({
      organizationId: 'org-1',
      protocol: 'saml',
      isActive: true,
      encryptedConfig: JSON.stringify({
        protocol: 'saml',
        saml: { ssoUrl: 'https://idp.example.com/saml/sso' },
      }),
    });

    const req = new NextRequest(
      new URL('/api/sso/init?email=user@example.com', 'http://localhost:3000'),
    );
    const res = await handler(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ssoEnabled).toBe(true);
    expect(body.protocol).toBe('saml');
    expect(body.redirectUrl).toContain('idp.example.com');
  });

  it('returns OIDC redirect URL for OIDC config', async () => {
    mockFindDomainMapping.mockResolvedValue({
      domain: 'corp.com',
      verified: true,
      organizationId: 'org-2',
    });
    mockFindSSOConfig.mockResolvedValue({
      organizationId: 'org-2',
      protocol: 'oidc',
      isActive: true,
      encryptedConfig: JSON.stringify({
        protocol: 'oidc',
        oidc: {
          authorizationUrl: 'https://auth.corp.com/authorize',
          clientId: 'client-abc',
          scopes: ['openid', 'email'],
        },
      }),
    });

    const req = new NextRequest(
      new URL('/api/sso/init?email=user@corp.com', 'http://localhost:3000'),
    );
    const res = await handler(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ssoEnabled).toBe(true);
    expect(body.protocol).toBe('oidc');
    expect(body.redirectUrl).toContain('auth.corp.com');
    expect(body.redirectUrl).toContain('client_id=client-abc');
  });

  it('redirects browser-mode enterprise login back to the IdP and preserves the admin callback', async () => {
    mockFindDomainMapping.mockResolvedValue({
      domain: 'corp.com',
      verified: true,
      organizationId: 'org-2',
    });
    mockFindSSOConfig.mockResolvedValue({
      organizationId: 'org-2',
      protocol: 'oidc',
      isActive: true,
      encryptedConfig: JSON.stringify({
        protocol: 'oidc',
        oidc: {
          authorizationUrl: 'https://auth.corp.com/authorize',
          clientId: 'client-abc',
          scopes: ['openid', 'email'],
        },
      }),
    });

    const req = new NextRequest(
      new URL(
        '/api/sso/init?email=user@corp.com&mode=redirect&admin_redirect=http%3A%2F%2Flocalhost%3A3003%2Fapi%2Fauth%2Fstudio%2Fcallback%3Fredirect%3D%252Ftenants',
        'http://localhost:3000',
      ),
    );
    const res = await handler(req);

    expect(res.status).toBe(307);

    const location = res.headers.get('location');
    expect(location).toBeTruthy();

    const url = new URL(location!);
    expect(url.origin).toBe('https://auth.corp.com');
    expect(url.pathname).toBe('/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-abc');
    expect(mockStoreOIDCState).toHaveBeenCalledWith(
      expect.any(String),
      'org-2',
      'http://localhost:3003/api/auth/studio/callback?redirect=%2Ftenants',
    );
  });

  it('redirects admin users back to the admin login when no SSO config exists in browser mode', async () => {
    mockFindDomainMapping.mockResolvedValue(null);

    const req = new NextRequest(
      new URL(
        '/api/sso/init?email=user@unknown.com&mode=redirect&admin_redirect=http%3A%2F%2Flocalhost%3A3003%2Fapi%2Fauth%2Fstudio%2Fcallback%3Fredirect%3D%252Ftenants',
        'http://localhost:3000',
      ),
    );
    const res = await handler(req);

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'http://localhost:3003/login?redirect=%2Ftenants&error=sso_not_configured',
    );
  });

  it('returns 500 on service error', async () => {
    mockFindDomainMapping.mockRejectedValue(new Error('DB error'));

    const req = new NextRequest(
      new URL('/api/sso/init?email=user@example.com', 'http://localhost:3000'),
    );
    const res = await handler(req);
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// POST /api/sso/exchange
// ===========================================================================

describe('POST /api/sso/exchange', () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/sso/exchange/route');
    handler = mod.POST;
  });

  it('returns 400 for missing code', async () => {
    const res = await handler(makeRequest('/api/sso/exchange', {}));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('Missing auth code');
  });

  it('returns 400 for null code', async () => {
    const res = await handler(makeRequest('/api/sso/exchange', { code: null }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid or expired code', async () => {
    mockConsumeAuthCode.mockReturnValue(null);

    const res = await handler(makeRequest('/api/sso/exchange', { code: 'expired-code' }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('Invalid or expired');
  });

  it('returns tokens on valid code', async () => {
    mockConsumeAuthCode.mockReturnValue({
      accessToken: 'at-123',
      refreshToken: 'rt-456',
      expiresIn: 900,
    });

    const res = await handler(makeRequest('/api/sso/exchange', { code: 'valid-code' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.accessToken).toBe('at-123');
    expect(body.expiresIn).toBe(900);
  });

  it('includes needsOnboarding when true', async () => {
    mockConsumeAuthCode.mockReturnValue({
      accessToken: 'at-123',
      refreshToken: 'rt-456',
      expiresIn: 900,
      needsOnboarding: true,
    });

    const res = await handler(makeRequest('/api/sso/exchange', { code: 'valid-code' }));
    const body = await res.json();
    expect(body.needsOnboarding).toBe(true);
  });

  it('includes pendingInvitations when > 0', async () => {
    mockConsumeAuthCode.mockReturnValue({
      accessToken: 'at-123',
      refreshToken: 'rt-456',
      expiresIn: 900,
      pendingInvitations: 3,
    });

    const res = await handler(makeRequest('/api/sso/exchange', { code: 'valid-code' }));
    const body = await res.json();
    expect(body.pendingInvitations).toBe(3);
  });

  it('does not include pendingInvitations when 0', async () => {
    mockConsumeAuthCode.mockReturnValue({
      accessToken: 'at-123',
      refreshToken: 'rt-456',
      expiresIn: 900,
      pendingInvitations: 0,
    });

    const res = await handler(makeRequest('/api/sso/exchange', { code: 'valid-code' }));
    const body = await res.json();
    expect(body.pendingInvitations).toBeUndefined();
  });

  it('returns 500 on service error', async () => {
    mockConsumeAuthCode.mockImplementation(() => {
      throw new Error('Store error');
    });

    const res = await handler(makeRequest('/api/sso/exchange', { code: 'crash-code' }));
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// POST /api/sso/domains
// ===========================================================================

describe('POST /api/sso/domains', () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/sso/domains/route');
    handler = mod.POST;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const res = await handler(makeRequest('/api/sso/domains', { domain: 'example.com' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid domain format', async () => {
    const res = await handler(makeRequest('/api/sso/domains', { domain: 'not valid' }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('Invalid domain');
  });

  it('returns 400 for missing domain', async () => {
    const res = await handler(makeRequest('/api/sso/domains', {}));
    expect(res.status).toBe(400);
  });

  it('returns 403 when user is not admin', async () => {
    mockFindTenantMemberByUserIdAndRoles.mockResolvedValue(null);

    const res = await handler(makeRequest('/api/sso/domains', { domain: 'example.com' }));
    expect(res.status).toBe(403);
  });

  it('returns 409 when domain already claimed', async () => {
    mockFindTenantMemberByUserIdAndRoles.mockResolvedValue({ tenantId: 'tenant-1' });
    mockFindTenantById.mockResolvedValue({ id: 'tenant-1', organizationId: 'org-1' });
    mockFindDomainMapping.mockResolvedValue({ domain: 'example.com', organizationId: 'other-org' });

    const res = await handler(makeRequest('/api/sso/domains', { domain: 'example.com' }));
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.error).toContain('already claimed');
  });

  it('claims domain successfully', async () => {
    mockFindTenantMemberByUserIdAndRoles.mockResolvedValue({ tenantId: 'tenant-1' });
    mockFindTenantById.mockResolvedValue({ id: 'tenant-1', organizationId: 'org-1' });
    mockFindDomainMapping.mockResolvedValue(null);
    mockUpsertDomainMapping.mockResolvedValue(undefined);

    const res = await handler(makeRequest('/api/sso/domains', { domain: 'newdomain.com' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.domain).toBe('newdomain.com');
    expect(body.verificationToken).toBeDefined();
    expect(body.instructions).toContain('TXT record');
  });

  it('returns 500 on service error', async () => {
    mockFindTenantMemberByUserIdAndRoles.mockResolvedValue({ tenantId: 'tenant-1' });
    mockFindTenantById.mockResolvedValue({ id: 'tenant-1', organizationId: 'org-1' });
    mockFindDomainMapping.mockRejectedValue(new Error('DB error'));

    const res = await handler(makeRequest('/api/sso/domains', { domain: 'test.com' }));
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// POST /api/sso/domains/verify
// ===========================================================================

describe('POST /api/sso/domains/verify', () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/sso/domains/verify/route');
    handler = mod.POST;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const res = await handler(makeRequest('/api/sso/domains/verify', { domain: 'example.com' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid domain format', async () => {
    const res = await handler(makeRequest('/api/sso/domains/verify', { domain: '..invalid' }));
    expect(res.status).toBe(400);
  });

  it('returns 403 when user is not admin', async () => {
    mockFindTenantMemberByUserIdAndRoles.mockResolvedValue(null);

    const res = await handler(makeRequest('/api/sso/domains/verify', { domain: 'example.com' }));
    expect(res.status).toBe(403);
  });

  it('returns 404 when domain not found', async () => {
    mockFindTenantMemberByUserIdAndRoles.mockResolvedValue({ tenantId: 'tenant-1' });
    mockFindTenantById.mockResolvedValue({ id: 'tenant-1', organizationId: 'org-1' });
    mockFindDomainMapping.mockResolvedValue(null);

    const res = await handler(makeRequest('/api/sso/domains/verify', { domain: 'unknown.com' }));
    expect(res.status).toBe(404);
  });

  it('returns 404 when domain belongs to different org', async () => {
    mockFindTenantMemberByUserIdAndRoles.mockResolvedValue({ tenantId: 'tenant-1' });
    mockFindTenantById.mockResolvedValue({ id: 'tenant-1', organizationId: 'org-1' });
    mockFindDomainMapping.mockResolvedValue({
      domain: 'example.com',
      organizationId: 'other-org',
      verified: false,
      verificationToken: 'tok-123',
    });

    const res = await handler(makeRequest('/api/sso/domains/verify', { domain: 'example.com' }));
    expect(res.status).toBe(404);
  });

  it('returns already verified when domain is verified', async () => {
    mockFindTenantMemberByUserIdAndRoles.mockResolvedValue({ tenantId: 'tenant-1' });
    mockFindTenantById.mockResolvedValue({ id: 'tenant-1', organizationId: 'org-1' });
    mockFindDomainMapping.mockResolvedValue({
      domain: 'example.com',
      organizationId: 'org-1',
      verified: true,
    });

    const res = await handler(makeRequest('/api/sso/domains/verify', { domain: 'example.com' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.verified).toBe(true);
    expect(body.message).toContain('already verified');
  });

  it('marks domain verified and writes an audit event when DNS verification succeeds', async () => {
    mockFindTenantMemberByUserIdAndRoles.mockResolvedValue({ tenantId: 'tenant-1' });
    mockFindTenantById.mockResolvedValue({ id: 'tenant-1', organizationId: 'org-1' });
    mockFindDomainMapping.mockResolvedValue({
      domain: 'example.com',
      organizationId: 'org-1',
      verified: false,
      verificationToken: 'tok-123',
    });
    mockResolveTxt.mockResolvedValue([['tok-123']]);

    const res = await handler(makeRequest('/api/sso/domains/verify', { domain: 'example.com' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.verified).toBe(true);
    expect(mockUpdateDomainMapping).toHaveBeenCalledWith('example.com', { verified: true });
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sso_domain_verified',
        metadata: expect.objectContaining({
          domain: 'example.com',
          organizationId: 'org-1',
          resourceId: 'example.com',
        }),
      }),
    );
  });

  it('returns 500 on unexpected error', async () => {
    mockFindTenantMemberByUserIdAndRoles.mockRejectedValue(new Error('DB crash'));

    const res = await handler(makeRequest('/api/sso/domains/verify', { domain: 'example.com' }));
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// GET /api/sso/oidc/callback
// ===========================================================================

describe('GET /api/sso/oidc/callback', () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/sso/oidc/callback/route');
    handler = mod.GET;
  });

  it('returns 400 when OIDC provider returns error', async () => {
    const req = new NextRequest(
      new URL('/api/sso/oidc/callback?error=access_denied', 'http://localhost:3000'),
    );
    const res = await handler(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('OIDC authentication failed');
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sso_login_failed',
        metadata: expect.objectContaining({
          reason: 'provider_error',
          providerError: 'access_denied',
        }),
      }),
    );
  });

  it('redirects admin SSO callbacks back to admin login when the IdP denies access', async () => {
    mockConsumeOIDCState.mockReturnValue({
      orgId: 'org-1',
      adminRedirect: 'http://localhost:3003/api/auth/studio/callback?redirect=%2Ftenants',
    });

    const req = new NextRequest(
      new URL(
        '/api/sso/oidc/callback?error=access_denied&state=state-123',
        'http://localhost:3000',
      ),
    );
    const res = await handler(req);

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'http://localhost:3003/login?redirect=%2Ftenants&error=access_denied',
    );
  });

  it('returns 400 when code or state is missing', async () => {
    const req = new NextRequest(
      new URL('/api/sso/oidc/callback?code=abc', 'http://localhost:3000'),
    );
    const res = await handler(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('Missing code or state');
  });

  it('returns 403 when state is invalid (CSRF protection)', async () => {
    mockConsumeOIDCState.mockReturnValue(null);

    const req = new NextRequest(
      new URL('/api/sso/oidc/callback?code=abc&state=invalid', 'http://localhost:3000'),
    );
    const res = await handler(req);
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toContain('Invalid or expired state');
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sso_login_failed',
        metadata: expect.objectContaining({ reason: 'invalid_state', provider: 'oidc' }),
      }),
    );
  });

  it('returns 400 when no OIDC config found', async () => {
    mockConsumeOIDCState.mockReturnValue({ orgId: 'org-1' });
    mockFindSSOConfig.mockResolvedValue(null);

    const req = new NextRequest(
      new URL('/api/sso/oidc/callback?code=abc&state=valid', 'http://localhost:3000'),
    );
    const res = await handler(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('No OIDC config');
  });

  it('returns 400 when OIDC config is inactive', async () => {
    mockConsumeOIDCState.mockReturnValue({ orgId: 'org-1' });
    mockFindSSOConfig.mockResolvedValue({
      protocol: 'oidc',
      isActive: false,
      encryptedConfig: '{}',
    });

    const req = new NextRequest(
      new URL('/api/sso/oidc/callback?code=abc&state=valid', 'http://localhost:3000'),
    );
    const res = await handler(req);
    expect(res.status).toBe(400);
  });

  it('writes tenant-scoped login and sso_login audit events when OIDC login is MFA-pending', async () => {
    mockConsumeOIDCState.mockReturnValue({ orgId: 'org-1' });
    mockFindSSOConfig.mockResolvedValue({
      protocol: 'oidc',
      isActive: true,
      organizationId: 'org-1',
      encryptedConfig: JSON.stringify({
        oidc: {
          tokenUrl: 'https://idp.example.com/token',
          userInfoUrl: 'https://idp.example.com/userinfo',
          clientId: 'client-id',
          clientSecret: 'client-secret',
        },
      }),
    });
    mockFindUserByEmail.mockResolvedValue({
      id: 'user-1',
      email: 'user@test.com',
      name: 'Test User',
    });
    mockGetMFAStatus.mockResolvedValue({ enabled: true });
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'oidc-token' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ email: 'user@test.com', name: 'Test User' }),
      });

    const req = new NextRequest(
      new URL('/api/sso/oidc/callback?code=abc&state=valid', 'http://localhost:3000'),
    );
    const res = await handler(req);

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost:5173/auth/mfa');
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'login',
        userId: 'user-1',
        tenantId: 'tenant-1',
        metadata: expect.objectContaining({ provider: 'oidc', mfaPending: true }),
      }),
    );
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sso_login',
        userId: 'user-1',
        tenantId: 'tenant-1',
        metadata: expect.objectContaining({ provider: 'oidc', mfaPending: true }),
      }),
    );
  });
});

// ===========================================================================
// POST /api/sso/saml/callback
// ===========================================================================

describe('POST /api/sso/saml/callback', () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/sso/saml/callback/route');
    handler = mod.POST;
  });

  it('returns 400 when SAMLResponse is missing', async () => {
    const formData = new FormData();
    formData.append('RelayState', 'org-1');

    const req = new NextRequest(new URL('/api/sso/saml/callback', 'http://localhost:3000'), {
      method: 'POST',
      body: formData,
    });
    const res = await handler(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('Missing SAML response');
  });

  it('returns 400 when RelayState is missing', async () => {
    const formData = new FormData();
    formData.append('SAMLResponse', 'base64-encoded-response');

    const req = new NextRequest(new URL('/api/sso/saml/callback', 'http://localhost:3000'), {
      method: 'POST',
      body: formData,
    });
    const res = await handler(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('Cannot determine organization');
  });

  it('returns 400 when no SAML config found', async () => {
    mockFindSSOConfig.mockResolvedValue(null);

    const formData = new FormData();
    formData.append('SAMLResponse', 'base64-encoded');
    formData.append('RelayState', 'org-1');

    const req = new NextRequest(new URL('/api/sso/saml/callback', 'http://localhost:3000'), {
      method: 'POST',
      body: formData,
    });
    const res = await handler(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('No SAML config');
  });

  it('returns 400 when config protocol is not saml', async () => {
    mockFindSSOConfig.mockResolvedValue({
      protocol: 'oidc',
      isActive: true,
      encryptedConfig: '{}',
    });

    const formData = new FormData();
    formData.append('SAMLResponse', 'base64-encoded');
    formData.append('RelayState', 'org-1');

    const req = new NextRequest(new URL('/api/sso/saml/callback', 'http://localhost:3000'), {
      method: 'POST',
      body: formData,
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
  });

  it('returns 501 when SAML config has no certificate', async () => {
    mockFindSSOConfig.mockResolvedValue({
      protocol: 'saml',
      isActive: true,
      organizationId: 'org-1',
      encryptedConfig: JSON.stringify({ saml: { ssoUrl: 'https://idp.example.com' } }),
    });

    const formData = new FormData();
    formData.append('SAMLResponse', 'base64-encoded');
    formData.append('RelayState', 'org-1');

    const req = new NextRequest(new URL('/api/sso/saml/callback', 'http://localhost:3000'), {
      method: 'POST',
      body: formData,
    });
    const res = await handler(req);
    expect(res.status).toBe(501);

    const body = await res.json();
    expect(body.error).toContain('certificate');
  });

  it('redirects admin SAML logins back to admin when MFA is required', async () => {
    mockFindSSOConfig.mockResolvedValue({
      protocol: 'saml',
      isActive: true,
      organizationId: 'org-1',
      encryptedConfig: JSON.stringify({
        saml: {
          ssoUrl: 'https://idp.example.com',
          certificate: 'test-cert',
        },
      }),
    });
    mockFindUserByEmail.mockResolvedValue({
      id: 'user-1',
      email: 'user@test.com',
      name: 'Test User',
    });
    mockGetMFAStatus.mockResolvedValue({ enabled: true });

    const relayState = Buffer.from(
      JSON.stringify({
        orgId: 'org-1',
        adminRedirect: 'http://localhost:3003/api/auth/studio/callback?redirect=%2Ftenants',
      }),
      'utf8',
    ).toString('base64url');

    const formData = new FormData();
    formData.append('SAMLResponse', 'base64-encoded');
    formData.append('RelayState', relayState);

    const req = new NextRequest(new URL('/api/sso/saml/callback', 'http://localhost:3000'), {
      method: 'POST',
      body: formData,
    });
    const res = await handler(req);

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'http://localhost:3003/login?redirect=%2Ftenants&error=mfa_unsupported',
    );
  });

  it('writes tenant-scoped login and sso_login audit events when SAML login is MFA-pending', async () => {
    mockFindSSOConfig.mockResolvedValue({
      protocol: 'saml',
      isActive: true,
      organizationId: 'org-1',
      encryptedConfig: JSON.stringify({
        saml: {
          ssoUrl: 'https://idp.example.com',
          certificate: 'test-cert',
        },
      }),
    });
    mockFindUserByEmail.mockResolvedValue({
      id: 'user-1',
      email: 'user@test.com',
      name: 'Test User',
    });
    mockGetMFAStatus.mockResolvedValue({ enabled: true });

    const formData = new FormData();
    formData.append('SAMLResponse', 'base64-encoded');
    formData.append('RelayState', 'org-1');

    const req = new NextRequest(new URL('/api/sso/saml/callback', 'http://localhost:3000'), {
      method: 'POST',
      body: formData,
    });
    const res = await handler(req);

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost:5173/auth/mfa');
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'login',
        userId: 'user-1',
        tenantId: 'tenant-1',
        metadata: expect.objectContaining({ provider: 'saml', mfaPending: true }),
      }),
    );
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sso_login',
        userId: 'user-1',
        tenantId: 'tenant-1',
        metadata: expect.objectContaining({ provider: 'saml', mfaPending: true }),
      }),
    );
  });
});

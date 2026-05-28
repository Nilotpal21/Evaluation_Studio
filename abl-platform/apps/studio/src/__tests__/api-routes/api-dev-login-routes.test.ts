/**
 * Dev Login Route Tests
 *
 * Unit tests for /api/auth/dev-login endpoint.
 * NOTE: E2E tests in tool-invocations-api.e2e.test.ts provide comprehensive coverage
 * by exercising dev-login through the real HTTP API.
 *
 * These tests focus on verifying the critical race condition fix:
 * When creating a new user + tenant, the returned JWT token must contain the
 * tenantId claim immediately (not after a database query that might miss the write).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

// Mocks for dev-login dependencies
vi.mock('server-only', () => ({}));

const mockFindUserByEmail = vi.fn();
const mockCreateUser = vi.fn();
const mockUpdateUser = vi.fn();
const mockCreateTokenPair = vi.fn();
const mockResolveUserTenantContext = vi.fn();
const mockResolveUserContextOrAutoAcceptInvite = vi.fn();
const mockCreateTenant = vi.fn();
const mockCreateTenantMember = vi.fn();
const mockFindTenantBySlug = vi.fn();
const mockCheckRateLimit = vi.fn();
const mockCheckIsSuperAdmin = vi.fn();
const mockIsPlatformAdminUser = vi.fn();
const mockSeedTenantBootstrapDefaults = vi.fn();
const mockSeedTenantPipelineConfigs = vi.fn();

vi.mock('@/services/auth-service', () => ({
  createTokenPair: (...args: unknown[]) => mockCreateTokenPair(...args),
  resolveUserTenantContext: (...args: unknown[]) => mockResolveUserTenantContext(...args),
  resolveUserContextOrAutoAcceptInvite: (...args: unknown[]) =>
    mockResolveUserContextOrAutoAcceptInvite(...args),
}));

vi.mock('@/repos/auth-repo', () => ({
  findUserByEmail: (...args: unknown[]) => mockFindUserByEmail(...args),
  createUser: (...args: unknown[]) => mockCreateUser(...args),
  updateUser: (...args: unknown[]) => mockUpdateUser(...args),
}));

vi.mock('@/repos/workspace-repo', () => ({
  createTenant: (...args: unknown[]) => mockCreateTenant(...args),
  createTenantMember: (...args: unknown[]) => mockCreateTenantMember(...args),
  findTenantBySlug: (...args: unknown[]) => mockFindTenantBySlug(...args),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

vi.mock('@/lib/auth', () => ({
  checkIsSuperAdmin: (...args: unknown[]) => mockCheckIsSuperAdmin(...args),
}));

vi.mock('@/lib/platform-auth-policy', () => ({
  isPlatformAdminUser: (...args: unknown[]) => mockIsPlatformAdminUser(...args),
}));

vi.mock('@agent-platform/database', () => ({
  seedTenantBootstrapDefaults: (...args: unknown[]) => mockSeedTenantBootstrapDefaults(...args),
}));

vi.mock('@agent-platform/database/models', () => ({
  Tenant: {
    findOne: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      }),
    }),
  },
}));

vi.mock('@agent-platform/pipeline-engine', () => ({
  seedTenantPipelineConfigs: (...args: unknown[]) => mockSeedTenantPipelineConfigs(...args),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function decodeToken(token: string): any {
  return jwt.decode(token);
}

function makeTokenPair(tenantId: string, role: string) {
  const accessToken = jwt.sign(
    {
      userId: 'user-1',
      email: 'test@example.com',
      tenantId,
      role,
      permissions: ['*:*'],
    },
    'test-secret',
    { expiresIn: '15m' },
  );

  return {
    accessToken,
    refreshToken: 'refresh-token-xyz',
    expiresIn: 900,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Dev Login - Race Condition Fix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENABLE_DEV_LOGIN = 'true';
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
    mockCheckIsSuperAdmin.mockReturnValue(false);
    mockIsPlatformAdminUser.mockResolvedValue(false);
    mockFindTenantBySlug.mockResolvedValue(null);
    mockSeedTenantBootstrapDefaults.mockResolvedValue({ roleCount: 5, policyEnsured: true });
    mockSeedTenantPipelineConfigs.mockResolvedValue(9);
    mockResolveUserContextOrAutoAcceptInvite.mockResolvedValue({
      tenantContext: null,
      pendingInvitationChoice: false,
    });
  });

  it('verifies JWT token contains tenantId claim immediately after new tenant creation', async () => {
    /**
     * CRITICAL TEST: Verifies the race condition fix
     *
     * Before fix: createTenantMember() write + immediate resolveUserTenantContext() query
     *            meant the query might not see the write yet, so token lacked tenantId
     *
     * After fix:  Construct tenantContext directly from newly created tenant object
     *             Token contains tenantId from the start
     */
    const newUser = { id: 'user-1', email: 'new@example.com', name: 'New User', avatarUrl: null };
    const newTenant = {
      id: 'tenant-1',
      name: 'Workspace',
      slug: 'ws',
      organizationId: 'org-1',
      createdAt: new Date(),
    };
    const tokens = makeTokenPair('tenant-1', 'OWNER');

    mockFindUserByEmail.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue(newUser);
    mockResolveUserTenantContext.mockResolvedValue(null);
    mockCreateTenant.mockResolvedValue(newTenant);
    mockCreateTenantMember.mockResolvedValue({
      tenantId: 'tenant-1',
      userId: 'user-1',
      role: 'OWNER',
    });
    mockCreateTokenPair.mockResolvedValue(tokens);

    const { POST } = await import('../../app/api/auth/dev-login/route');
    const request = new Request('http://localhost/api/auth/dev-login', {
      method: 'POST',
      body: JSON.stringify({ email: 'new@example.com', name: 'New User' }),
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
    });

    const response = await POST(request as any, { params: Promise.resolve({}) } as any);

    expect(response.status).toBe(200);
    const json = await response.json();

    // Verify tenantId is in the token immediately
    const decoded = decodeToken(json.accessToken);
    expect(decoded.tenantId).toBe('tenant-1');
    expect(decoded.role).toBe('OWNER');

    // Verify createTokenPair was called with tenantContext containing tenantId
    expect(mockCreateTokenPair).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ tenantId: 'tenant-1', role: 'OWNER' }),
    );
  });

  it('constructs tenantContext directly on duplicate-key (11000) fallback', async () => {
    /**
     * When createTenantMember throws a duplicate key error (member already exists),
     * the fallback should construct tenantContext directly from firstTenant
     * instead of calling resolveUserTenantContext (same race-condition avoidance).
     */
    const newUser = { id: 'user-dup', email: 'dup@example.com', name: 'Dup User', avatarUrl: null };
    const existingTenant = {
      _id: 'tenant-dup',
      id: 'tenant-dup',
      name: 'Existing Workspace',
      slug: 'ws-dup',
      organizationId: 'org-dup',
      createdAt: new Date(),
    };
    const tokens = makeTokenPair('tenant-dup', 'OWNER');

    mockFindUserByEmail.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue(newUser);
    mockResolveUserTenantContext.mockResolvedValue(null);
    mockCreateTenantMember.mockRejectedValue(Object.assign(new Error('dup key'), { code: 11000 }));
    mockCreateTokenPair.mockResolvedValue(tokens);

    // Mock Tenant.findOne to return an existing tenant
    const { Tenant } = await import('@agent-platform/database/models');
    (Tenant.findOne as any).mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(existingTenant),
      }),
    });

    const { POST } = await import('../../app/api/auth/dev-login/route');
    const request = new Request('http://localhost/api/auth/dev-login', {
      method: 'POST',
      body: JSON.stringify({ email: 'dup@example.com', name: 'Dup User' }),
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
    });

    const response = await POST(request as any, { params: Promise.resolve({}) } as any);

    expect(response.status).toBe(200);

    // Key assertion: createTokenPair receives tenantContext built directly (not from resolveUserTenantContext)
    expect(mockCreateTokenPair).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ tenantId: 'tenant-dup', role: 'OWNER', orgId: 'org-dup' }),
    );

    // resolveUserContextOrAutoAcceptInvite should have been called once (returns null context),
    // and NOT called again after the 11000 fallback — context is built directly
    expect(mockResolveUserContextOrAutoAcceptInvite).toHaveBeenCalledTimes(1);
  });

  it('joins existing tenant with direct context construction (no new tenant created)', async () => {
    /**
     * When a new user joins an existing tenant (firstTenant found in DB),
     * tenantContext should be constructed directly — not queried.
     */
    const newUser = { id: 'user-join', email: 'join@example.com', name: 'Joiner', avatarUrl: null };
    const existingTenant = {
      _id: 'tenant-existing',
      id: 'tenant-existing',
      name: 'Team Workspace',
      slug: 'team',
      organizationId: 'org-team',
      createdAt: new Date(),
    };
    const tokens = makeTokenPair('tenant-existing', 'OWNER');

    mockFindUserByEmail.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue(newUser);
    mockResolveUserTenantContext.mockResolvedValue(null);
    mockCreateTenantMember.mockResolvedValue({
      tenantId: 'tenant-existing',
      userId: 'user-join',
      role: 'OWNER',
    });
    mockCreateTokenPair.mockResolvedValue(tokens);

    // Mock Tenant.findOne to return an existing tenant
    const { Tenant } = await import('@agent-platform/database/models');
    (Tenant.findOne as any).mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(existingTenant),
      }),
    });

    const { POST } = await import('../../app/api/auth/dev-login/route');
    const request = new Request('http://localhost/api/auth/dev-login', {
      method: 'POST',
      body: JSON.stringify({ email: 'join@example.com', name: 'Joiner' }),
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
    });

    const response = await POST(request as any, { params: Promise.resolve({}) } as any);

    expect(response.status).toBe(200);

    // tenantContext built directly from firstTenant, not from resolveUserTenantContext
    expect(mockCreateTokenPair).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ tenantId: 'tenant-existing', role: 'OWNER', orgId: 'org-team' }),
    );

    // createTenant should NOT have been called — we joined an existing tenant
    expect(mockCreateTenant).not.toHaveBeenCalled();
  });

  it('prefers the seeded dev workspace before falling back to the oldest tenant', async () => {
    const newUser = {
      id: 'user-seeded',
      email: 'seeded@example.com',
      name: 'Seeded User',
      avatarUrl: null,
    };
    const seededTenant = {
      id: 'tenant-seeded',
      name: 'Dev Workspace',
      slug: 'dev-workspace',
      organizationId: 'org-seeded',
      createdAt: new Date(),
    };
    const tokens = makeTokenPair('tenant-seeded', 'OWNER');

    mockFindUserByEmail.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue(newUser);
    mockResolveUserTenantContext.mockResolvedValue(null);
    mockFindTenantBySlug.mockResolvedValue(seededTenant);
    mockCreateTenantMember.mockResolvedValue({
      tenantId: 'tenant-seeded',
      userId: 'user-seeded',
      role: 'OWNER',
    });
    mockCreateTokenPair.mockResolvedValue(tokens);

    const { Tenant } = await import('@agent-platform/database/models');
    (Tenant.findOne as any).mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: 'tenant-oldest',
          name: 'Old Workspace',
          slug: 'old-workspace',
          organizationId: 'org-oldest',
        }),
      }),
    });

    const { POST } = await import('../../app/api/auth/dev-login/route');
    const request = new Request('http://localhost/api/auth/dev-login', {
      method: 'POST',
      body: JSON.stringify({ email: 'seeded@example.com', name: 'Seeded User' }),
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
    });

    const response = await POST(request as any, { params: Promise.resolve({}) } as any);

    expect(response.status).toBe(200);
    expect(mockCreateTokenPair).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ tenantId: 'tenant-seeded', role: 'OWNER', orgId: 'org-seeded' }),
    );
    expect(Tenant.findOne).not.toHaveBeenCalled();
  });

  it('routes @e2e-smoke.test users into the dedicated e2e workspace instead of dev-workspace', async () => {
    const newUser = {
      id: 'user-e2e',
      email: 'suite@e2e-smoke.test',
      name: 'Suite User',
      avatarUrl: null,
    };
    const e2eTenant = {
      id: 'tenant-e2e',
      name: 'E2E Workspace',
      slug: 'e2e-workspace',
      organizationId: 'org-e2e',
      createdAt: new Date(),
    };
    const tokens = makeTokenPair('tenant-e2e', 'OWNER');

    mockFindUserByEmail.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue(newUser);
    mockResolveUserTenantContext.mockResolvedValue(null);
    mockFindTenantBySlug.mockImplementation(async (slug: string) =>
      slug === 'e2e-workspace' ? e2eTenant : null,
    );
    mockCreateTenantMember.mockResolvedValue({
      tenantId: 'tenant-e2e',
      userId: 'user-e2e',
      role: 'OWNER',
    });
    mockCreateTokenPair.mockResolvedValue(tokens);

    const { Tenant } = await import('@agent-platform/database/models');
    (Tenant.findOne as any).mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: 'tenant-oldest',
          name: 'Old Workspace',
          slug: 'dev-workspace',
          organizationId: 'org-oldest',
        }),
      }),
    });

    const { POST } = await import('../../app/api/auth/dev-login/route');
    const request = new Request('http://localhost/api/auth/dev-login', {
      method: 'POST',
      body: JSON.stringify({ email: 'suite@e2e-smoke.test', name: 'Suite User' }),
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
    });

    const response = await POST(request as any, { params: Promise.resolve({}) } as any);

    expect(response.status).toBe(200);
    expect(mockCreateTokenPair).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ tenantId: 'tenant-e2e', role: 'OWNER', orgId: 'org-e2e' }),
    );
    expect(mockFindTenantBySlug).toHaveBeenCalledWith('e2e-workspace');
    expect(Tenant.findOne).not.toHaveBeenCalled();
  });

  it('routes allowlisted kore.ai E2E users into the dedicated e2e workspace', async () => {
    const newUser = {
      id: 'user-docs',
      email: 'studio-theme-docs@kore.ai',
      name: 'Studio Theme Docs E2E',
      avatarUrl: null,
    };
    const e2eTenant = {
      id: 'tenant-e2e',
      name: 'E2E Workspace',
      slug: 'e2e-workspace',
      organizationId: 'org-e2e',
      createdAt: new Date(),
    };
    const tokens = makeTokenPair('tenant-e2e', 'OWNER');

    mockFindUserByEmail.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue(newUser);
    mockResolveUserTenantContext.mockResolvedValue(null);
    mockFindTenantBySlug.mockImplementation(async (slug: string) =>
      slug === 'e2e-workspace' ? e2eTenant : null,
    );
    mockCreateTenantMember.mockResolvedValue({
      tenantId: 'tenant-e2e',
      userId: 'user-docs',
      role: 'OWNER',
    });
    mockCreateTokenPair.mockResolvedValue(tokens);

    const { Tenant } = await import('@agent-platform/database/models');
    (Tenant.findOne as any).mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: 'tenant-oldest',
          name: 'Dev Workspace',
          slug: 'dev-workspace',
          organizationId: 'org-dev',
        }),
      }),
    });

    const { POST } = await import('../../app/api/auth/dev-login/route');
    const request = new Request('http://localhost/api/auth/dev-login', {
      method: 'POST',
      body: JSON.stringify({ email: 'studio-theme-docs@kore.ai', name: 'Studio Theme Docs E2E' }),
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
    });

    const response = await POST(request as any, { params: Promise.resolve({}) } as any);

    expect(response.status).toBe(200);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockCreateTokenPair).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ tenantId: 'tenant-e2e', role: 'OWNER', orgId: 'org-e2e' }),
    );
    expect(mockFindTenantBySlug).toHaveBeenCalledWith('e2e-workspace');
    expect(Tenant.findOne).not.toHaveBeenCalled();
  });

  it('verifies existing user can login with tenant context', async () => {
    const existingUser = {
      id: 'user-2',
      email: 'existing@example.com',
      name: 'Existing',
      avatarUrl: null,
    };
    const tenantContext = { tenantId: 'tenant-2', role: 'OWNER', orgId: 'org-2' };
    const tokens = makeTokenPair('tenant-2', 'OWNER');

    mockFindUserByEmail.mockResolvedValue(existingUser);
    mockUpdateUser.mockResolvedValue(existingUser);
    mockResolveUserContextOrAutoAcceptInvite.mockResolvedValue({
      tenantContext,
      pendingInvitationChoice: false,
    });
    mockCreateTokenPair.mockResolvedValue(tokens);

    const { POST } = await import('../../app/api/auth/dev-login/route');
    const request = new Request('http://localhost/api/auth/dev-login', {
      method: 'POST',
      body: JSON.stringify({ email: 'existing@example.com' }),
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
    });

    const response = await POST(request as any, { params: Promise.resolve({}) } as any);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.user.email).toBe('existing@example.com');

    // Verify token contains tenantId
    const decoded = decodeToken(json.accessToken);
    expect(decoded.tenantId).toBe('tenant-2');
  });
});

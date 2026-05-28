/**
 * Vendor-Grouped Profiles Route Tests — INT-10
 *
 * Tests GET /api/projects/:pid/auth-profiles/integrations
 * which returns vendor-grouped profiles filtered by profileType: 'integration'.
 *
 * NOTE: This is NOT an integration test — the file name refers to the "integrations"
 * API endpoint (vendor-grouped profiles). Auth and DB are mocked per Studio route
 * test conventions.
 *
 * Covers:
 *   - Returns vendor-grouped profiles sorted alphabetically
 *   - Determines isAuthorized per usageMode (preconfigured vs jit)
 *   - Returns empty vendor list when no profiles exist
 *   - Groups multiple profiles under same connector
 *   - Returns 401 when not authenticated
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks — auth
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
// Mocks — project access
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
// Mocks — database models
// ---------------------------------------------------------------------------

const mockAuthProfileFind = vi.fn();
const mockEndUserOAuthTokenFindOne = vi.fn();
const mockGetIntegrationCatalog = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  AuthProfile: {
    find: mockAuthProfileFind,
    findOne: vi.fn(),
  },
  EndUserOAuthToken: {
    findOne: mockEndUserOAuthTokenFindOne,
  },
}));

// ---------------------------------------------------------------------------
// Mocks — shared services
// ---------------------------------------------------------------------------

vi.mock('@agent-platform/shared/services/auth-profile', () => ({
  buildAuthProfileOAuthProviderKey: (profileId: string) => `auth-profile:${profileId}`,
  computeIsAuthorized: vi.fn(
    async (
      profile: {
        _id: string;
        usageMode?: string;
        encryptedSecrets?: string | null;
        authType: string;
        status?: string;
        visibility?: 'shared' | 'personal';
      },
      ctx: { tenantId: string; projectId: string | null; userId?: string },
      deps: {
        findOne: (
          filter: Record<string, unknown>,
          projection: Record<string, number>,
        ) => Promise<{ _id: string } | null>;
      },
    ) => {
      if (
        profile.status === 'pending_authorization' ||
        profile.status === 'revoked' ||
        profile.status === 'expired' ||
        profile.status === 'invalid'
      ) {
        return false;
      }

      if (profile.authType !== 'oauth2_app') {
        return Boolean(profile.encryptedSecrets);
      }

      const token = await deps.findOne(
        {
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
          userId: profile.visibility === 'personal' ? ctx.userId : '__tenant__',
          provider: `auth-profile:${profile._id}`,
          revokedAt: null,
        },
        { _id: 1 },
      );
      return Boolean(token);
    },
  ),
  getIntegrationCatalog: () => mockGetIntegrationCatalog(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_A = 'tenant-a';
const PROJECT_ID = 'proj-1';
const USER_ID = 'user-1';

function makeUser(tenantId = TENANT_A, perms: string[] = ['*:*'], id = USER_ID) {
  return {
    id,
    email: `${id}@test.com`,
    name: 'Test User',
    tenantId,
    role: 'editor',
    permissions: perms,
  };
}

function makeProject(tenantId = TENANT_A, projectId = PROJECT_ID) {
  return {
    id: projectId,
    name: 'Test Project',
    slug: 'test-project',
    ownerId: USER_ID,
    tenantId,
  };
}

type RouteCtx = { params: Promise<Record<string, string>> };

function routeCtx(params: Record<string, string>): RouteCtx {
  return { params: Promise.resolve(params) };
}

function makeRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-jwt',
    },
  });
}

function vendorProfile(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'int-profile-1',
    name: 'GitHub Profile',
    connector: 'github',
    status: 'active',
    usageMode: 'preconfigured',
    authType: 'oauth2_app',
    encryptedSecrets: '{"clientId":"cid","clientSecret":"csec"}',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  mockRequireAuth.mockResolvedValue(makeUser());
  mockIsAuthError.mockReturnValue(false);
  mockRequireProjectAccess.mockResolvedValue({ project: makeProject() });
  mockIsAccessError.mockReturnValue(false);

  // Default: find returns empty
  mockAuthProfileFind.mockReturnValue({
    select: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([]),
      }),
    }),
  });

  mockEndUserOAuthTokenFindOne.mockResolvedValue(null);
  mockGetIntegrationCatalog.mockReturnValue([]);
});

// ===========================================================================
// Tests
// ===========================================================================

describe('GET /api/projects/:pid/auth-profiles/integrations', () => {
  let handler: (req: NextRequest, ctx: RouteCtx) => Promise<Response>;

  beforeAll(async () => {
    const mod = await import('@/app/api/projects/[id]/auth-profiles/integrations/route');
    handler = mod.GET;
  }, 60_000);

  it('returns vendor-grouped profiles', async () => {
    const profiles = [
      vendorProfile(),
      vendorProfile({
        _id: 'int-profile-2',
        name: 'Slack Profile',
        connector: 'slack',
      }),
    ];

    mockAuthProfileFind.mockReturnValue({
      select: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(profiles),
        }),
      }),
    });

    const req = makeRequest('/api/projects/proj-1/auth-profiles/integrations');
    const res = await handler(req, routeCtx({ id: PROJECT_ID }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.vendors).toHaveLength(2);

    // Sorted alphabetically by connector
    expect(body.data.vendors[0].connector).toBe('github');
    expect(body.data.vendors[0].profileCount).toBe(1);
    expect(body.data.vendors[0].profiles[0].id).toBe('int-profile-1');
    expect(body.data.vendors[0].profiles[0].name).toBe('GitHub Profile');
    expect(body.data.vendors[1].connector).toBe('slack');
  });

  it('determines isAuthorized=false for OAuth app profiles without a durable grant', async () => {
    mockAuthProfileFind.mockReturnValue({
      select: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([vendorProfile({ usageMode: 'preconfigured' })]),
        }),
      }),
    });

    const req = makeRequest('/api/projects/proj-1/auth-profiles/integrations');
    const res = await handler(req, routeCtx({ id: PROJECT_ID }));
    const body = await res.json();

    expect(body.data.vendors[0].profiles[0].isAuthorized).toBe(false);
  });

  it('determines isAuthorized=false for preconfigured profiles without secrets', async () => {
    mockAuthProfileFind.mockReturnValue({
      select: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([
            vendorProfile({
              usageMode: 'preconfigured',
              encryptedSecrets: null,
            }),
          ]),
        }),
      }),
    });

    const req = makeRequest('/api/projects/proj-1/auth-profiles/integrations');
    const res = await handler(req, routeCtx({ id: PROJECT_ID }));
    const body = await res.json();

    expect(body.data.vendors[0].profiles[0].isAuthorized).toBe(false);
  });

  it('checks EndUserOAuthToken for jit usageMode profiles', async () => {
    mockAuthProfileFind.mockReturnValue({
      select: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([
            vendorProfile({
              usageMode: 'jit',
              visibility: 'personal',
              encryptedSecrets: null,
            }),
          ]),
        }),
      }),
    });

    // User has an active token for this profile
    mockEndUserOAuthTokenFindOne.mockResolvedValue({ _id: 'token-1' });

    const req = makeRequest('/api/projects/proj-1/auth-profiles/integrations');
    const res = await handler(req, routeCtx({ id: PROJECT_ID }));
    const body = await res.json();

    expect(body.data.vendors[0].profiles[0].isAuthorized).toBe(true);
    expect(mockEndUserOAuthTokenFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_A,
        projectId: PROJECT_ID,
        userId: USER_ID,
        provider: 'auth-profile:int-profile-1',
        revokedAt: null,
      }),
      { _id: 1 },
    );
  });

  it('checks the tenant sentinel grant for shared OAuth app profiles', async () => {
    mockAuthProfileFind.mockReturnValue({
      select: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([
            vendorProfile({
              visibility: 'shared',
              usageMode: 'preconfigured',
            }),
          ]),
        }),
      }),
    });

    mockEndUserOAuthTokenFindOne.mockResolvedValue({ _id: 'token-1' });

    const req = makeRequest('/api/projects/proj-1/auth-profiles/integrations');
    const res = await handler(req, routeCtx({ id: PROJECT_ID }));
    const body = await res.json();

    expect(body.data.vendors[0].profiles[0].isAuthorized).toBe(true);
    expect(mockEndUserOAuthTokenFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_A,
        projectId: PROJECT_ID,
        userId: '__tenant__',
        provider: 'auth-profile:int-profile-1',
        revokedAt: null,
      }),
      { _id: 1 },
    );
  });

  it('returns empty vendor list when no profiles exist', async () => {
    mockAuthProfileFind.mockReturnValue({
      select: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      }),
    });

    const req = makeRequest('/api/projects/proj-1/auth-profiles/integrations');
    const res = await handler(req, routeCtx({ id: PROJECT_ID }));
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data.vendors).toEqual([]);
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = makeRequest('/api/projects/proj-1/auth-profiles/integrations');
    const res = await handler(req, routeCtx({ id: PROJECT_ID }));
    expect(res.status).toBe(401);
  });

  it('groups multiple profiles under the same connector', async () => {
    const profiles = [
      vendorProfile({ _id: 'p1', name: 'GH 1', connector: 'github' }),
      vendorProfile({ _id: 'p2', name: 'GH 2', connector: 'github' }),
    ];

    mockAuthProfileFind.mockReturnValue({
      select: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(profiles),
        }),
      }),
    });

    const req = makeRequest('/api/projects/proj-1/auth-profiles/integrations');
    const res = await handler(req, routeCtx({ id: PROJECT_ID }));
    const body = await res.json();

    expect(body.data.vendors).toHaveLength(1);
    expect(body.data.vendors[0].connector).toBe('github');
    expect(body.data.vendors[0].profileCount).toBe(2);
    expect(body.data.vendors[0].profiles).toHaveLength(2);
  });
});

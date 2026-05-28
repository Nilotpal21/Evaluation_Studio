/**
 * Revoke User Tokens Route Tests — INT-23a/b
 *
 * Tests POST /api/projects/:pid/auth-profiles/:profileId/revoke-user-tokens
 * which deletes EndUserOAuthToken rows and emits audit events.
 *
 * Covers:
 *   - Revokes all user tokens for a profile (INT-23a)
 *   - Revokes tokens for a specific userId (INT-23b)
 *   - Returns 404 for non-existent profile
 *   - Returns 404 for cross-tenant access
 *   - Emits audit event and publishes Redis invalidation
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

const mockAuthProfileFindOne = vi.fn();
const mockEndUserOAuthTokenDistinct = vi.fn();
const mockEndUserOAuthTokenDeleteMany = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  AuthProfile: {
    findOne: mockAuthProfileFindOne,
  },
  EndUserOAuthToken: {
    distinct: mockEndUserOAuthTokenDistinct,
    deleteMany: mockEndUserOAuthTokenDeleteMany,
  },
}));

// ---------------------------------------------------------------------------
// Mocks — shared services
// ---------------------------------------------------------------------------

const mockEmitAuditEvent = vi.fn();
const mockPublishInvalidate = vi.fn();

vi.mock('@agent-platform/shared/services/auth-profile', () => ({
  buildAuthProfileOAuthProviderKey: (profileId: string) => `auth-profile:${profileId}`,
  getAuthProfileMigrationState: () => null,
  emitAuthProfileAuditEvent: mockEmitAuditEvent,
  publishAuthProfileInvalidate: mockPublishInvalidate,
}));

// ---------------------------------------------------------------------------
// Mocks — Redis
// ---------------------------------------------------------------------------

const mockRedisClient = { publish: vi.fn() };
vi.mock('@/lib/redis-client', () => ({
  getRedisClient: () => mockRedisClient,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const PROJECT_ID = 'proj-1';
const USER_ID = 'user-1';
const PROFILE_ID = 'profile-1';

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
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-jwt',
    },
  });
}

function storedProfile(overrides: Record<string, unknown> = {}) {
  return {
    _id: PROFILE_ID,
    name: 'My OAuth App',
    tenantId: TENANT_A,
    projectId: PROJECT_ID,
    scope: 'project',
    visibility: 'shared',
    createdBy: USER_ID,
    authType: 'oauth2_app',
    config: {},
    status: 'active',
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

  mockAuthProfileFindOne.mockResolvedValue(null);
  mockEndUserOAuthTokenDistinct.mockResolvedValue([]);
  mockEndUserOAuthTokenDeleteMany.mockResolvedValue({ deletedCount: 0 });
  mockEmitAuditEvent.mockResolvedValue(undefined);
  mockPublishInvalidate.mockResolvedValue(0);
});

// ===========================================================================
// Tests
// ===========================================================================

describe('POST /api/projects/:pid/auth-profiles/:profileId/revoke-user-tokens', () => {
  let handler: (req: NextRequest, ctx: RouteCtx) => Promise<Response>;

  beforeAll(async () => {
    const mod =
      await import('@/app/api/projects/[id]/auth-profiles/[profileId]/revoke-user-tokens/route');
    handler = mod.POST;
  }, 60_000);

  it('revokes all user tokens for a profile', async () => {
    mockAuthProfileFindOne.mockResolvedValue(storedProfile());
    mockEndUserOAuthTokenDistinct.mockResolvedValue(['user-2', 'user-3']);
    mockEndUserOAuthTokenDeleteMany.mockResolvedValue({ deletedCount: 5 });

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}/revoke-user-tokens`);
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.deletedCount).toBe(5);
    expect(body.data.affectedUsers).toBe(2);

    // Verify audit event was emitted with scope: 'all_users'
    expect(mockEmitAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_A,
        projectId: PROJECT_ID,
        profileId: PROFILE_ID,
        eventType: 'tokens_revoked',
        actorUserId: USER_ID,
        eventPayload: expect.objectContaining({
          scope: 'all_users',
          count: 5,
        }),
      }),
    );
  });

  it('revokes tokens for a specific userId', async () => {
    mockAuthProfileFindOne.mockResolvedValue(storedProfile());
    mockEndUserOAuthTokenDistinct.mockResolvedValue(['user-2']);
    mockEndUserOAuthTokenDeleteMany.mockResolvedValue({ deletedCount: 2 });

    const req = makeRequest(
      `/api/projects/proj-1/auth-profiles/${PROFILE_ID}/revoke-user-tokens?userId=user-2`,
    );
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.deletedCount).toBe(2);
    expect(body.data.affectedUsers).toBe(1);

    // Verify audit event was emitted with scope: 'single_user'
    expect(mockEmitAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventPayload: expect.objectContaining({
          scope: 'single_user',
          userId: 'user-2',
        }),
      }),
    );
  });

  it('handles zero tokens gracefully', async () => {
    mockAuthProfileFindOne.mockResolvedValue(storedProfile());
    mockEndUserOAuthTokenDistinct.mockResolvedValue([]);
    mockEndUserOAuthTokenDeleteMany.mockResolvedValue({ deletedCount: 0 });

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}/revoke-user-tokens`);
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.deletedCount).toBe(0);
    expect(body.data.affectedUsers).toBe(0);
  });

  it('returns 404 for non-existent profile', async () => {
    mockAuthProfileFindOne.mockResolvedValue(null);

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/nonexistent/revoke-user-tokens`);
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: 'nonexistent' }));
    expect(res.status).toBe(404);
  });

  it('returns 404 for cross-tenant access', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(TENANT_B));
    mockRequireProjectAccess.mockResolvedValue({ project: makeProject(TENANT_B) });
    mockAuthProfileFindOne.mockResolvedValue(null);

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}/revoke-user-tokens`);
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(404);
  });

  it('returns 404 for personal profiles of other users', async () => {
    mockAuthProfileFindOne.mockResolvedValue(
      storedProfile({ visibility: 'personal', createdBy: 'other-user' }),
    );
    mockRequireAuth.mockResolvedValue(makeUser(TENANT_A, ['auth-profile:write'], USER_ID));

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}/revoke-user-tokens`);
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(404);
  });

  it('publishes Redis invalidation after token deletion', async () => {
    mockAuthProfileFindOne.mockResolvedValue(storedProfile());
    mockEndUserOAuthTokenDistinct.mockResolvedValue(['user-2']);
    mockEndUserOAuthTokenDeleteMany.mockResolvedValue({ deletedCount: 1 });

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}/revoke-user-tokens`);
    await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));

    expect(mockPublishInvalidate).toHaveBeenCalledWith(
      { profileId: PROFILE_ID, tenantId: TENANT_A, projectId: PROJECT_ID },
      mockRedisClient,
    );
  });
});

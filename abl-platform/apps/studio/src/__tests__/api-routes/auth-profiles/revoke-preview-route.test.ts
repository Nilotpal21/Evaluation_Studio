/**
 * Revoke Preview Route Tests — INT-24
 *
 * Tests GET /api/projects/:pid/auth-profiles/:profileId/revoke-preview
 * which returns blast-radius payload for revoke/delete operations.
 *
 * Covers:
 *   - Returns blast radius for profile-type revoke
 *   - Returns blast radius for tokens-type revoke with userId filter
 *   - Validates query params (type is required)
 *   - Returns 404 for non-existent profile
 *   - Respects tenant isolation
 *   - Hides personal profiles from non-owners
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

vi.mock('@agent-platform/database/models', () => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  AuthProfile: {
    findOne: mockAuthProfileFindOne,
  },
}));

// ---------------------------------------------------------------------------
// Mocks — shared services (blast radius aggregator)
// ---------------------------------------------------------------------------

const mockAggregateBlastRadius = vi.fn();

vi.mock('@agent-platform/shared/services/auth-profile', () => ({
  aggregateBlastRadius: mockAggregateBlastRadius,
  getAuthProfileMigrationState: () => null,
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
    method: 'GET',
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

function blastRadiusPayload(type: 'profile' | 'tokens') {
  return {
    type,
    affectedConsumers: {
      tools: 0,
      integrationNodes: 0,
      mcpServers: 1,
      a2aServers: 0,
      connectorConnections: 2,
      channelConnections: 0,
      serviceNodes: 0,
      gitIntegrations: 0,
      triggerRegistrations: 0,
    },
    affectedUsers: 3,
    activeSessions: 0,
    ...(type === 'profile' ? { irreversible: true, cascadeDeletesTokens: 5 } : {}),
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

  mockAuthProfileFindOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue(null),
  });
});

// ===========================================================================
// Tests
// ===========================================================================

describe('GET /api/projects/:pid/auth-profiles/:profileId/revoke-preview', () => {
  let handler: (req: NextRequest, ctx: RouteCtx) => Promise<Response>;

  beforeAll(async () => {
    const mod =
      await import('@/app/api/projects/[id]/auth-profiles/[profileId]/revoke-preview/route');
    handler = mod.GET;
  }, 60_000);

  it('returns blast radius for profile-type revoke', async () => {
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(storedProfile()),
    });
    mockAggregateBlastRadius.mockResolvedValue(blastRadiusPayload('profile'));

    const req = makeRequest(
      `/api/projects/proj-1/auth-profiles/${PROFILE_ID}/revoke-preview?type=profile`,
    );
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.type).toBe('profile');
    expect(body.data.irreversible).toBe(true);
    expect(body.data.cascadeDeletesTokens).toBe(5);
    expect(body.data.affectedConsumers.mcpServers).toBe(1);
    expect(body.data.affectedUsers).toBe(3);
  });

  it('returns blast radius for tokens-type revoke with userId filter', async () => {
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(storedProfile()),
    });
    mockAggregateBlastRadius.mockResolvedValue(blastRadiusPayload('tokens'));

    const req = makeRequest(
      `/api/projects/proj-1/auth-profiles/${PROFILE_ID}/revoke-preview?type=tokens&userId=user-2`,
    );
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.type).toBe('tokens');

    // Verify aggregator was called with userId
    expect(mockAggregateBlastRadius).toHaveBeenCalledWith(PROFILE_ID, TENANT_A, PROJECT_ID, {
      type: 'tokens',
      userId: 'user-2',
    });
  });

  it('rejects missing type query parameter', async () => {
    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}/revoke-preview`);
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('rejects invalid type value', async () => {
    const req = makeRequest(
      `/api/projects/proj-1/auth-profiles/${PROFILE_ID}/revoke-preview?type=invalid`,
    );
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent profile', async () => {
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });

    const req = makeRequest(
      `/api/projects/proj-1/auth-profiles/nonexistent/revoke-preview?type=profile`,
    );
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: 'nonexistent' }));
    expect(res.status).toBe(404);
  });

  it('returns 404 for cross-tenant access', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(TENANT_B));
    mockRequireProjectAccess.mockResolvedValue({ project: makeProject(TENANT_B) });

    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });

    const req = makeRequest(
      `/api/projects/proj-1/auth-profiles/${PROFILE_ID}/revoke-preview?type=profile`,
    );
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(404);
  });

  it('returns 404 for personal profiles of other users', async () => {
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi
        .fn()
        .mockResolvedValue(storedProfile({ visibility: 'personal', createdBy: 'other-user' })),
    });

    // Non-admin user
    mockRequireAuth.mockResolvedValue(makeUser(TENANT_A, ['auth-profile:write'], USER_ID));

    const req = makeRequest(
      `/api/projects/proj-1/auth-profiles/${PROFILE_ID}/revoke-preview?type=profile`,
    );
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(404);
  });
});

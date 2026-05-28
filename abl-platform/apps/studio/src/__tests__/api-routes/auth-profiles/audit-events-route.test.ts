/**
 * Audit Events Route Tests — INT-30/31
 *
 * Tests GET /api/projects/:pid/auth-profiles/:profileId/audit-events
 * which returns paginated audit events for a profile.
 *
 * Covers:
 *   - Returns paginated audit events (INT-30)
 *   - Cursor-based pagination with hasMore detection (INT-31)
 *   - Filters by eventType
 *   - Validates invalid eventType
 *   - Returns 404 for non-existent profile
 *   - Respects tenant isolation
 *   - Returns empty events list
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
const mockAuditEventFind = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  AuthProfile: {
    findOne: mockAuthProfileFindOne,
  },
  AuthProfileAuditEvent: {
    find: mockAuditEventFind,
  },
  AUTH_PROFILE_AUDIT_EVENT_TYPES: [
    'authorized',
    'authorize_failed',
    'token_refreshed',
    'token_refresh_failed',
    'profile_revoked',
    'tokens_revoked',
    'profile_updated',
    'sensitive_field_changed',
    'profile_deleted',
    'scope_insufficient_detected',
  ],
}));

// ---------------------------------------------------------------------------
// Mocks — shared services
// ---------------------------------------------------------------------------

vi.mock('@agent-platform/shared/services/auth-profile', () => ({
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

function auditEvent(eventType: string, createdAt: string, overrides: Record<string, unknown> = {}) {
  return {
    _id: `event-${createdAt}`,
    tenantId: TENANT_A,
    projectId: PROJECT_ID,
    profileId: PROFILE_ID,
    eventType,
    actorUserId: USER_ID,
    actorContext: { source: 'profile' },
    eventPayload: {},
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
    ...overrides,
  };
}

function setupAuditEventFind(events: unknown[]) {
  mockAuditEventFind.mockReturnValue({
    sort: vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(events),
      }),
    }),
  });
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

  setupAuditEventFind([]);
});

// ===========================================================================
// Tests
// ===========================================================================

describe('GET /api/projects/:pid/auth-profiles/:profileId/audit-events', () => {
  let handler: (req: NextRequest, ctx: RouteCtx) => Promise<Response>;

  beforeAll(async () => {
    const mod =
      await import('@/app/api/projects/[id]/auth-profiles/[profileId]/audit-events/route');
    handler = mod.GET;
  }, 60_000);

  it('returns audit events for a profile', async () => {
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(storedProfile()),
    });

    const events = [
      auditEvent('profile_updated', '2025-06-01T12:00:00Z'),
      auditEvent('authorized', '2025-06-01T11:00:00Z'),
    ];
    setupAuditEventFind(events);

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}/audit-events`);
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.events).toHaveLength(2);
    expect(body.data.events[0].eventType).toBe('profile_updated');
    expect(body.data.nextCursor).toBeNull();
  });

  it('detects hasMore via limit+1 pattern and returns nextCursor', async () => {
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(storedProfile()),
    });

    // With limit=2, route fetches 3 (limit+1). Return 3 events to indicate hasMore.
    const events = [
      auditEvent('profile_updated', '2025-06-03T12:00:00Z'),
      auditEvent('authorized', '2025-06-02T12:00:00Z'),
      auditEvent('tokens_revoked', '2025-06-01T12:00:00Z'), // extra event
    ];
    setupAuditEventFind(events);

    const req = makeRequest(
      `/api/projects/proj-1/auth-profiles/${PROFILE_ID}/audit-events?limit=2`,
    );
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));

    const body = await res.json();
    expect(body.data.events).toHaveLength(2);
    expect(body.data.nextCursor).toBe('2025-06-02T12:00:00.000Z');
  });

  it('filters by eventType', async () => {
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(storedProfile()),
    });
    setupAuditEventFind([auditEvent('authorized', '2025-06-01T12:00:00Z')]);

    const req = makeRequest(
      `/api/projects/proj-1/auth-profiles/${PROFILE_ID}/audit-events?eventType=authorized`,
    );
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(200);

    // Verify the filter passed to find() includes eventType
    const filterArg = mockAuditEventFind.mock.calls[0][0];
    expect(filterArg.eventType).toBe('authorized');
  });

  it('rejects invalid eventType', async () => {
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(storedProfile()),
    });

    const req = makeRequest(
      `/api/projects/proj-1/auth-profiles/${PROFILE_ID}/audit-events?eventType=bogus`,
    );
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(400);
  });

  it('returns empty events list for profile with no events', async () => {
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(storedProfile()),
    });
    setupAuditEventFind([]);

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}/audit-events`);
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.events).toEqual([]);
    expect(body.data.nextCursor).toBeNull();
  });

  it('returns 404 for non-existent profile', async () => {
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/nonexistent/audit-events`);
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: 'nonexistent' }));
    expect(res.status).toBe(404);
  });

  it('returns 404 for cross-tenant access', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(TENANT_B));
    mockRequireProjectAccess.mockResolvedValue({ project: makeProject(TENANT_B) });
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}/audit-events`);
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(404);
  });

  it('defaults limit to 50 when not specified', async () => {
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(storedProfile()),
    });
    setupAuditEventFind([]);

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}/audit-events`);
    await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));

    // The limit call should be 51 (50 + 1 for hasMore detection)
    const sortMock = mockAuditEventFind.mock.results[0].value.sort;
    const limitMock = sortMock.mock.results[0].value.limit;
    expect(limitMock).toHaveBeenCalledWith(51);
  });

  it('caps limit at 100', async () => {
    mockAuthProfileFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(storedProfile()),
    });
    setupAuditEventFind([]);

    const req = makeRequest(
      `/api/projects/proj-1/auth-profiles/${PROFILE_ID}/audit-events?limit=500`,
    );
    await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));

    // The limit call should be 101 (100 + 1 for hasMore detection)
    const sortMock = mockAuditEventFind.mock.results[0].value.sort;
    const limitMock = sortMock.mock.results[0].value.limit;
    expect(limitMock).toHaveBeenCalledWith(101);
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = makeRequest(`/api/projects/proj-1/auth-profiles/${PROFILE_ID}/audit-events`);
    const res = await handler(req, routeCtx({ id: PROJECT_ID, profileId: PROFILE_ID }));
    expect(res.status).toBe(401);
  });
});

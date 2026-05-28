/**
 * User Lifecycle API — behavioral tests
 *
 * Tests: profile CRUD, deactivation/reactivation, offboarding cascade,
 * session revocation. Validates tenant isolation, role enforcement, and
 * concealment (404 not 403).
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ─── External boundary mocks ────────────────────────────────────────────

const {
  mockApplyMemberLifecycleStatus,
  mockRequireAuth,
  mockRequireMemberLifecycleContext,
  mockCheckIsSuperAdmin,
  mockCheckRateLimit,
  mockCreatePartialToken,
  mockCreateTokenPair,
  mockIsEmailAllowedForAuth,
  mockIsPlatformAdminUser,
  mockGetMFAStatus,
  mockLogAuditEvent,
  mockResolveUserContextOrAutoAcceptInvite,
  mockResolveUserTenantContext,
  mockVerifyPassword,
} = vi.hoisted(() => ({
  mockApplyMemberLifecycleStatus: vi.fn(),
  mockRequireAuth: vi.fn(),
  mockRequireMemberLifecycleContext: vi.fn(),
  mockCheckIsSuperAdmin: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockCreatePartialToken: vi.fn(),
  mockCreateTokenPair: vi.fn(),
  mockIsEmailAllowedForAuth: vi.fn(),
  mockIsPlatformAdminUser: vi.fn(),
  mockGetMFAStatus: vi.fn(),
  mockLogAuditEvent: vi.fn(),
  mockResolveUserContextOrAutoAcceptInvite: vi.fn(),
  mockResolveUserTenantContext: vi.fn(),
  mockVerifyPassword: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  applyMemberLifecycleStatus: (...args: unknown[]) => mockApplyMemberLifecycleStatus(...args),
  getAuthErrorInfo: (error: unknown) => {
    if (!(error instanceof Error)) {
      return null;
    }

    const errorWithStatus = error as Error & {
      status?: unknown;
      statusCode?: unknown;
    };
    const status =
      typeof errorWithStatus.statusCode === 'number'
        ? errorWithStatus.statusCode
        : typeof errorWithStatus.status === 'number'
          ? errorWithStatus.status
          : null;

    if (typeof status !== 'number' || status < 400 || status >= 500) {
      return null;
    }

    return {
      message: error.message,
      status,
    };
  },
  requireAuth: mockRequireAuth,
  requireMemberLifecycleContext: (...args: unknown[]) => mockRequireMemberLifecycleContext(...args),
  isAuthError: (r: unknown) => r instanceof NextResponse,
}));

vi.mock('@/lib/ensure-db', () => ({ ensureDb: vi.fn() }));

vi.mock('@/lib/api-response', () => {
  const ErrorCode = {
    NOT_FOUND: 'NOT_FOUND',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    FORBIDDEN: 'FORBIDDEN',
  };
  return {
    ErrorCode,
    errorJson: (message: string | string[], status: number, code = 'INTERNAL_ERROR') => {
      const msgs = Array.isArray(message) ? message : [message];
      return NextResponse.json(
        { success: false, errors: msgs.map((msg: string) => ({ msg, code })) },
        { status },
      );
    },
    handleApiError: (_error: unknown, _context: string) =>
      NextResponse.json(
        { success: false, errors: [{ msg: 'Internal server error', code: 'INTERNAL_ERROR' }] },
        { status: 500 },
      ),
  };
});

// ─── In-memory stores ───────────────────────────────────────────────────

const users = new Map<string, any>();
const tenantMembers = new Map<string, any>();
let revokedUserIds: string[] = [];
const ADMIN_ROLES = new Set(['OWNER', 'ADMIN']);

function memberKey(tenantId: string, userId: string) {
  return `${tenantId}:${userId}`;
}

vi.mock('@/repos/auth-repo', () => ({
  findUserById: vi.fn((id: string) => Promise.resolve(users.get(id) || null)),
  findUserByEmail: vi.fn((email: string) => {
    const normalized = email.toLowerCase().trim();
    const user = Array.from(users.values()).find((candidate) => candidate.email === normalized);
    return Promise.resolve(user || null);
  }),
  updateUser: vi.fn((id: string, data: any) => {
    const u = users.get(id);
    if (!u) return Promise.resolve(null);
    const updated = { ...u, ...data };
    users.set(id, updated);
    return Promise.resolve(updated);
  }),
  incrementFailedLoginAttempts: vi.fn(
    (userId: string, maxFailedAttempts = 5, lockDurationMs = 15 * 60 * 1000) => {
      const user = users.get(userId);
      if (!user) {
        return Promise.resolve({ failedCount: 1, locked: false });
      }

      const failedCount = (user.failedLoginAttempts ?? 0) + 1;
      let loginLockedUntil = user.loginLockedUntil ?? null;
      let locked = false;

      if (failedCount >= maxFailedAttempts) {
        loginLockedUntil = new Date(Date.now() + lockDurationMs);
        locked = true;

        for (const [key, membership] of tenantMembers.entries()) {
          if (membership.userId === userId && membership.status === 'active') {
            tenantMembers.set(key, { ...membership, status: 'locked' });
          }
        }
        revokedUserIds.push(userId);
      }

      users.set(userId, {
        ...user,
        failedLoginAttempts: failedCount,
        loginLockedUntil,
      });

      return Promise.resolve({ failedCount, locked });
    },
  ),
  resetFailedLoginAttempts: vi.fn(
    (userId: string, options?: { restoreLockedMemberships?: 'whenExpired' | 'always' }) => {
      const user = users.get(userId);
      if (!user) {
        return Promise.resolve();
      }

      const previousLockedUntil = user.loginLockedUntil ? new Date(user.loginLockedUntil) : null;
      users.set(userId, {
        ...user,
        failedLoginAttempts: 0,
        loginLockedUntil: null,
      });

      const shouldRestore =
        options?.restoreLockedMemberships === 'always' ||
        (previousLockedUntil && previousLockedUntil <= new Date());

      if (shouldRestore) {
        for (const [key, membership] of tenantMembers.entries()) {
          if (membership.userId === userId && membership.status === 'locked') {
            tenantMembers.set(key, { ...membership, status: 'active' });
          }
        }
      }

      return Promise.resolve();
    },
  ),
}));

vi.mock('@/repos/workspace-repo', () => ({
  findTenantMember: vi.fn((tenantId: string, userId: string) => {
    return Promise.resolve(tenantMembers.get(memberKey(tenantId, userId)) || null);
  }),
  updateTenantMember: vi.fn((tenantId: string, userId: string, data: any) => {
    const key = memberKey(tenantId, userId);
    const m = tenantMembers.get(key);
    if (!m) throw new Error('Not found');
    const updated = { ...m, ...data };
    tenantMembers.set(key, updated);
    return Promise.resolve(updated);
  }),
  deleteTenantMember: vi.fn((tenantId: string, userId: string) => {
    tenantMembers.delete(memberKey(tenantId, userId));
    return Promise.resolve();
  }),
}));

vi.mock('@/repos/project-repo', () => ({
  removeUserFromTenantProjects: vi.fn(() => Promise.resolve(3)),
}));

vi.mock('@/services/auth-service', () => ({
  createTokenPair: (...args: unknown[]) => mockCreateTokenPair(...args),
  createPartialToken: (...args: unknown[]) => mockCreatePartialToken(...args),
  revokeAllUserTokens: vi.fn((userId: string) => {
    revokedUserIds.push(userId);
    return Promise.resolve();
  }),
  resolveUserContextOrAutoAcceptInvite: (...args: unknown[]) =>
    mockResolveUserContextOrAutoAcceptInvite(...args),
  resolveUserTenantContext: (...args: unknown[]) => mockResolveUserTenantContext(...args),
}));

vi.mock('@/services/audit-service', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
  AuditActions: {
    ACCOUNT_LOCKED: 'account_locked',
    LOGIN: 'login',
    LOGIN_FAILED: 'login_failed',
    MEMBER_DEACTIVATED: 'member_deactivated',
    MEMBER_LOCKED: 'member_locked',
    MEMBER_REACTIVATED: 'member_reactivated',
    MEMBER_SUSPENDED: 'member_suspended',
    MEMBER_UNLOCKED: 'member_unlocked',
    SESSIONS_REVOKED: 'sessions_revoked',
    MEMBER_REMOVED: 'member_removed',
    MEMBER_ROLE_CHANGED: 'member_role_changed',
  },
}));

vi.mock('@/services/auth/password-service', () => ({
  verifyPassword: (...args: unknown[]) => mockVerifyPassword(...args),
}));

vi.mock('@/services/auth/mfa-service', () => ({
  getMFAStatus: (...args: unknown[]) => mockGetMFAStatus(...args),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

vi.mock('@/config', () => ({
  getConfig: () => ({
    auth: {
      lockout: { maxFailedAttempts: 5, lockDurationMs: 15 * 60 * 1000 },
      rateLimits: { login: { maxAttempts: 10, windowMs: 15 * 60 * 1000 } },
      tokens: {
        mfaCookieMaxAgeSeconds: 300,
        refreshCookieMaxAgeSeconds: 7 * 24 * 60 * 60,
      },
    },
  }),
  isConfigLoaded: () => true,
}));

vi.mock('@/lib/super-admin', () => ({
  checkIsSuperAdmin: (...args: unknown[]) => mockCheckIsSuperAdmin(...args),
}));

vi.mock('@/lib/platform-auth-policy', () => ({
  isEmailAllowedForAuth: (...args: unknown[]) => mockIsEmailAllowedForAuth(...args),
  isPlatformAdminUser: (...args: unknown[]) => mockIsPlatformAdminUser(...args),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@abl/compiler/platform/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@agent-platform/openapi/nextjs', () => ({
  withOpenAPI: (_opts: any, handler: any) => handler,
}));

// ─── Helpers ────────────────────────────────────────────────────────────

type NextRequestInit = ConstructorParameters<typeof NextRequest>[1];

function makeRequest(path: string, opts?: NextRequestInit): NextRequest {
  return new NextRequest(new URL(path, 'http://localhost'), opts);
}

function seedUser(id: string, overrides: Partial<any> = {}) {
  const u = {
    id,
    email: `${id}@test.com`,
    name: `User ${id}`,
    avatarUrl: null,
    authProvider: 'email',
    createdAt: new Date('2026-01-01'),
    emailVerified: true,
    failedLoginAttempts: 0,
    lastLoginAt: null,
    loginLockedUntil: null,
    passwordHash: 'hashed-password',
    ...overrides,
  };
  users.set(id, u);
  return u;
}

function seedMember(tenantId: string, userId: string, role: string, status = 'active') {
  const m = { tenantId, userId, role, status, id: `tm-${tenantId}-${userId}` };
  tenantMembers.set(memberKey(tenantId, userId), m);
  return m;
}

function adminAuth(userId = 'admin-1', tenantId = 'tenant-1') {
  mockRequireAuth.mockResolvedValue({
    id: userId,
    email: `${userId}@test.com`,
    name: 'Admin',
    tenantId,
    role: 'ADMIN',
    permissions: [],
  });
}

const memberParams = (userId: string) => Promise.resolve({ tenantId: 'tenant-1', userId });

function resetExternalMocks() {
  mockApplyMemberLifecycleStatus.mockImplementation(
    async (
      _request: NextRequest,
      context: any,
      nextStatus: string,
      action: string,
      options?: { clearUserLoginLock?: boolean; revokeTokens?: boolean },
    ) => {
      const key = memberKey(context.tenantId, context.userId);
      const currentMembership = tenantMembers.get(key);
      tenantMembers.set(key, { ...currentMembership, status: nextStatus });

      if (options?.clearUserLoginLock) {
        const user = users.get(context.userId);
        if (user) {
          users.set(context.userId, {
            ...user,
            failedLoginAttempts: 0,
            loginLockedUntil: null,
          });
        }

        for (const [key, membership] of tenantMembers.entries()) {
          if (membership.userId === context.userId && membership.status === 'locked') {
            tenantMembers.set(key, { ...membership, status: 'active' });
          }
        }
      }

      if (options?.revokeTokens !== false) {
        revokedUserIds.push(context.userId);
      }

      await mockLogAuditEvent({
        userId: context.authResult.id,
        tenantId: context.tenantId,
        action,
        metadata: {
          targetUserId: context.userId,
          previousStatus: context.targetMembership.status || 'active',
          nextStatus,
        },
      });

      return NextResponse.json({ success: true, status: nextStatus });
    },
  );
  mockRequireMemberLifecycleContext.mockImplementation(
    async (request: NextRequest, params: Promise<{ tenantId: string; userId: string }>) => {
      const { tenantId, userId } = await params;
      const authResult = await mockRequireAuth(request);
      if (authResult instanceof NextResponse) {
        return authResult;
      }

      if (authResult.tenantId && tenantId !== authResult.tenantId) {
        return NextResponse.json(
          { success: false, errors: [{ msg: 'Not found', code: 'NOT_FOUND' }] },
          { status: 404 },
        );
      }

      const actorMembership = tenantMembers.get(memberKey(tenantId, authResult.id));
      if (!actorMembership || !ADMIN_ROLES.has(actorMembership.role)) {
        return NextResponse.json(
          { success: false, errors: [{ msg: 'Not found', code: 'NOT_FOUND' }] },
          { status: 404 },
        );
      }

      const targetMembership = tenantMembers.get(memberKey(tenantId, userId));
      if (!targetMembership) {
        return NextResponse.json(
          { success: false, errors: [{ msg: 'Member not found', code: 'NOT_FOUND' }] },
          { status: 404 },
        );
      }

      return {
        authResult,
        tenantId,
        userId,
        actorMembership,
        targetMembership,
      };
    },
  );
  mockCheckIsSuperAdmin.mockReturnValue(false);
  mockCheckRateLimit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  mockCreatePartialToken.mockReturnValue('partial-token');
  mockCreateTokenPair.mockResolvedValue({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresIn: 900,
  });
  mockIsEmailAllowedForAuth.mockResolvedValue(true);
  mockIsPlatformAdminUser.mockResolvedValue(false);
  mockGetMFAStatus.mockResolvedValue({ enabled: false });
  mockLogAuditEvent.mockResolvedValue(undefined);
  mockResolveUserContextOrAutoAcceptInvite.mockResolvedValue({
    tenantContext: {
      tenantId: 'tenant-1',
      role: 'MEMBER',
    },
    pendingInvitationChoice: false,
  });
  mockResolveUserTenantContext.mockResolvedValue(null);
  mockVerifyPassword.mockResolvedValue(true);
}

// ─── Profile Tests ──────────────────────────────────────────────────────

describe('GET /api/user/profile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    users.clear();
    tenantMembers.clear();
    revokedUserIds = [];
    resetExternalMocks();
  });

  test('returns user profile', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'a@test.com',
      name: 'Alice',
      permissions: [],
    });
    seedUser('user-1', { name: 'Alice', avatarUrl: 'https://example.com/avatar.png' });

    const { GET } = await import('../../app/api/user/profile/route');
    const res = await GET(makeRequest('/api/user/profile'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile.name).toBe('Alice');
    expect(body.profile.avatarUrl).toBe('https://example.com/avatar.png');
    expect(body.profile.email).toBe('user-1@test.com');
  });

  test('returns 401 when not authenticated', async () => {
    mockRequireAuth.mockResolvedValue(NextResponse.json({ success: false }, { status: 401 }));

    const { GET } = await import('../../app/api/user/profile/route');
    const res = await GET(makeRequest('/api/user/profile'));

    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/user/profile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    users.clear();
    tenantMembers.clear();
    revokedUserIds = [];
    resetExternalMocks();
  });

  test('updates name', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'a@test.com',
      name: 'Alice',
      permissions: [],
    });
    seedUser('user-1');

    const { PATCH } = await import('../../app/api/user/profile/route');
    const res = await PATCH(
      makeRequest('/api/user/profile', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'New Name' }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile.name).toBe('New Name');
  });

  test('rejects empty name', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'a@test.com',
      name: 'Alice',
      permissions: [],
    });
    seedUser('user-1');

    const { PATCH } = await import('../../app/api/user/profile/route');
    const res = await PATCH(
      makeRequest('/api/user/profile', {
        method: 'PATCH',
        body: JSON.stringify({ name: '' }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    expect(res.status).toBe(400);
  });

  test('rejects empty body', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'a@test.com',
      name: 'Alice',
      permissions: [],
    });
    seedUser('user-1');

    const { PATCH } = await import('../../app/api/user/profile/route');
    const res = await PATCH(
      makeRequest('/api/user/profile', {
        method: 'PATCH',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    expect(res.status).toBe(400);
  });

  test('updates avatarUrl', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'a@test.com',
      name: 'Alice',
      permissions: [],
    });
    seedUser('user-1');

    const { PATCH } = await import('../../app/api/user/profile/route');
    const res = await PATCH(
      makeRequest('/api/user/profile', {
        method: 'PATCH',
        body: JSON.stringify({ avatarUrl: 'https://example.com/new.png' }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile.avatarUrl).toBe('https://example.com/new.png');
  });

  test('clears avatarUrl with null', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'a@test.com',
      name: 'Alice',
      permissions: [],
    });
    seedUser('user-1', { avatarUrl: 'https://old.com/pic.png' });

    const { PATCH } = await import('../../app/api/user/profile/route');
    const res = await PATCH(
      makeRequest('/api/user/profile', {
        method: 'PATCH',
        body: JSON.stringify({ avatarUrl: null }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile.avatarUrl).toBeNull();
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    users.clear();
    tenantMembers.clear();
    revokedUserIds = [];
    resetExternalMocks();
  });

  test('locks active memberships when failed attempts reach the threshold', async () => {
    seedUser('user-1', {
      failedLoginAttempts: 4,
    });
    seedMember('tenant-1', 'user-1', 'MEMBER');
    mockVerifyPassword.mockResolvedValue(false);

    const { POST } = await import('../../app/api/auth/login/route');
    const res = await POST(
      makeRequest('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'user-1@test.com', password: 'wrong-password' }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    expect(res.status).toBe(423);
    expect(users.get('user-1')?.loginLockedUntil).toBeInstanceOf(Date);
    expect(tenantMembers.get(memberKey('tenant-1', 'user-1'))?.status).toBe('locked');
    expect(revokedUserIds).toContain('user-1');
  });

  test('successful login clears an expired membership lock and user lockout state', async () => {
    seedUser('user-1', {
      failedLoginAttempts: 5,
      loginLockedUntil: new Date(Date.now() - 60_000),
    });
    seedMember('tenant-1', 'user-1', 'MEMBER', 'locked');

    const { POST } = await import('../../app/api/auth/login/route');
    const res = await POST(
      makeRequest('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'user-1@test.com', password: 'correct-password' }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    expect(res.status).toBe(200);
    expect(users.get('user-1')?.failedLoginAttempts).toBe(0);
    expect(users.get('user-1')?.loginLockedUntil).toBeNull();
    expect(tenantMembers.get(memberKey('tenant-1', 'user-1'))?.status).toBe('active');

    const body = await res.json();
    expect(body.accessToken).toBe('access-token');
    expect(body.needsOnboarding).toBe(false);
  });

  test('returns 403 when tenant context resolution rejects an inactive membership', async () => {
    seedUser('user-1');
    mockResolveUserContextOrAutoAcceptInvite.mockRejectedValue(
      Object.assign(new Error('Workspace membership is not active'), { statusCode: 403 }),
    );

    const { POST } = await import('../../app/api/auth/login/route');
    const res = await POST(
      makeRequest('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'user-1@test.com', password: 'correct-password' }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    expect(res.status).toBe(403);
    expect(mockCreateTokenPair).not.toHaveBeenCalled();
  });

  test('platform admin login resolves tenant context with admin email and does not require onboarding', async () => {
    seedUser('admin-user', { email: 'admin@example.com' });
    mockIsPlatformAdminUser.mockResolvedValue(true);
    mockResolveUserTenantContext.mockResolvedValue(null);

    const { POST } = await import('../../app/api/auth/login/route');
    const res = await POST(
      makeRequest('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'admin@example.com', password: 'correct-password' }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    expect(res.status).toBe(200);
    expect(mockResolveUserTenantContext).toHaveBeenCalledWith('admin-user', {
      platformAdminEmail: 'admin@example.com',
    });
    expect(mockResolveUserContextOrAutoAcceptInvite).not.toHaveBeenCalled();
    expect(mockCreateTokenPair).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'admin-user', email: 'admin@example.com' }),
      null,
    );
    const body = await res.json();
    expect(body.needsOnboarding).toBe(false);
    expect(body.isSuperAdmin).toBe(true);
  });
});

// ─── Deactivation Tests ─────────────────────────────────────────────────

describe('POST /api/workspaces/:tenantId/members/:userId/deactivate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    users.clear();
    tenantMembers.clear();
    revokedUserIds = [];
    resetExternalMocks();
  });

  test('admin can deactivate a member', async () => {
    adminAuth();
    seedMember('tenant-1', 'admin-1', 'ADMIN');
    seedMember('tenant-1', 'user-2', 'MEMBER');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/deactivate/route');
    const res = await POST(makeRequest('/deactivate', { method: 'POST' }), {
      params: memberParams('user-2'),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('deactivated');
    expect(revokedUserIds).toContain('user-2');
    expect(tenantMembers.get(memberKey('tenant-1', 'user-2'))?.status).toBe('deactivated');
  });

  test('deactivating a locked member clears login lockout before reactivation and login', async () => {
    adminAuth();
    seedUser('user-2', {
      failedLoginAttempts: 5,
      loginLockedUntil: new Date(Date.now() + 15 * 60 * 1000),
    });
    seedMember('tenant-1', 'admin-1', 'ADMIN');
    seedMember('tenant-1', 'user-2', 'MEMBER', 'locked');
    seedMember('tenant-2', 'user-2', 'MEMBER', 'locked');

    const { POST: deactivatePost } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/deactivate/route');
    const deactivateRes = await deactivatePost(makeRequest('/deactivate', { method: 'POST' }), {
      params: memberParams('user-2'),
    });

    expect(deactivateRes.status).toBe(200);
    expect(tenantMembers.get(memberKey('tenant-1', 'user-2'))?.status).toBe('deactivated');
    expect(tenantMembers.get(memberKey('tenant-2', 'user-2'))?.status).toBe('active');
    expect(users.get('user-2')?.failedLoginAttempts).toBe(0);
    expect(users.get('user-2')?.loginLockedUntil).toBeNull();
    expect(revokedUserIds.filter((id) => id === 'user-2')).toHaveLength(1);

    const { POST: reactivatePost } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/reactivate/route');
    const reactivateRes = await reactivatePost(makeRequest('/reactivate', { method: 'POST' }), {
      params: memberParams('user-2'),
    });

    expect(reactivateRes.status).toBe(200);
    expect(tenantMembers.get(memberKey('tenant-1', 'user-2'))?.status).toBe('active');
    expect(users.get('user-2')?.loginLockedUntil).toBeNull();
    expect(revokedUserIds.filter((id) => id === 'user-2')).toHaveLength(1);

    const { POST: loginPost } = await import('../../app/api/auth/login/route');
    const loginRes = await loginPost(
      makeRequest('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'user-2@test.com', password: 'correct-password' }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    expect(loginRes.status).toBe(200);
    const loginBody = await loginRes.json();
    expect(loginBody.accessToken).toBe('access-token');
    expect(users.get('user-2')?.failedLoginAttempts).toBe(0);
    expect(users.get('user-2')?.loginLockedUntil).toBeNull();
  });

  test('cannot deactivate OWNER', async () => {
    adminAuth();
    seedMember('tenant-1', 'admin-1', 'ADMIN');
    seedMember('tenant-1', 'owner-1', 'OWNER');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/deactivate/route');
    const res = await POST(makeRequest('/deactivate', { method: 'POST' }), {
      params: memberParams('owner-1'),
    });

    expect(res.status).toBe(403);
  });

  test('cannot deactivate yourself', async () => {
    adminAuth();
    seedMember('tenant-1', 'admin-1', 'ADMIN');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/deactivate/route');
    const res = await POST(makeRequest('/deactivate', { method: 'POST' }), {
      params: memberParams('admin-1'),
    });

    expect(res.status).toBe(400);
  });

  test('non-admin gets 404 (concealment)', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'u@test.com',
      name: 'User',
      tenantId: 'tenant-1',
      role: 'MEMBER',
      permissions: [],
    });
    seedMember('tenant-1', 'user-1', 'MEMBER');
    seedMember('tenant-1', 'user-2', 'MEMBER');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/deactivate/route');
    const res = await POST(makeRequest('/deactivate', { method: 'POST' }), {
      params: memberParams('user-2'),
    });

    expect(res.status).toBe(404);
  });

  test('cross-tenant gets 404', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'admin-1',
      email: 'a@test.com',
      name: 'Admin',
      tenantId: 'tenant-2', // different tenant
      role: 'ADMIN',
      permissions: [],
    });
    seedMember('tenant-1', 'admin-1', 'ADMIN');
    seedMember('tenant-1', 'user-2', 'MEMBER');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/deactivate/route');
    const res = await POST(makeRequest('/deactivate', { method: 'POST' }), {
      params: memberParams('user-2'),
    });

    expect(res.status).toBe(404);
  });

  test('already deactivated returns 400', async () => {
    adminAuth();
    seedMember('tenant-1', 'admin-1', 'ADMIN');
    seedMember('tenant-1', 'user-2', 'MEMBER', 'deactivated');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/deactivate/route');
    const res = await POST(makeRequest('/deactivate', { method: 'POST' }), {
      params: memberParams('user-2'),
    });

    expect(res.status).toBe(400);
  });
});

// ─── Reactivation Tests ─────────────────────────────────────────────────

describe('POST /api/workspaces/:tenantId/members/:userId/reactivate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    users.clear();
    tenantMembers.clear();
    revokedUserIds = [];
    resetExternalMocks();
  });

  test('admin can reactivate a deactivated member', async () => {
    adminAuth();
    seedMember('tenant-1', 'admin-1', 'ADMIN');
    seedMember('tenant-1', 'user-2', 'MEMBER', 'deactivated');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/reactivate/route');
    const res = await POST(makeRequest('/reactivate', { method: 'POST' }), {
      params: memberParams('user-2'),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('active');
    expect(tenantMembers.get(memberKey('tenant-1', 'user-2'))?.status).toBe('active');
  });

  test('admin can reactivate a locked member', async () => {
    adminAuth();
    seedUser('user-2', {
      failedLoginAttempts: 5,
      loginLockedUntil: new Date(Date.now() + 15 * 60 * 1000),
    });
    seedMember('tenant-1', 'admin-1', 'ADMIN');
    seedMember('tenant-1', 'user-2', 'MEMBER', 'locked');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/reactivate/route');
    const res = await POST(makeRequest('/reactivate', { method: 'POST' }), {
      params: memberParams('user-2'),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('active');
    expect(tenantMembers.get(memberKey('tenant-1', 'user-2'))?.status).toBe('active');
    expect(users.get('user-2')?.failedLoginAttempts).toBe(0);
    expect(users.get('user-2')?.loginLockedUntil).toBeNull();
  });

  test('admin can reactivate a suspended member', async () => {
    adminAuth();
    seedMember('tenant-1', 'admin-1', 'ADMIN');
    seedMember('tenant-1', 'user-2', 'MEMBER', 'suspended');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/reactivate/route');
    const res = await POST(makeRequest('/reactivate', { method: 'POST' }), {
      params: memberParams('user-2'),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('active');
    expect(tenantMembers.get(memberKey('tenant-1', 'user-2'))?.status).toBe('active');
  });

  test('reactivating active member returns 400', async () => {
    adminAuth();
    seedMember('tenant-1', 'admin-1', 'ADMIN');
    seedMember('tenant-1', 'user-2', 'MEMBER', 'active');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/reactivate/route');
    const res = await POST(makeRequest('/reactivate', { method: 'POST' }), {
      params: memberParams('user-2'),
    });

    expect(res.status).toBe(400);
  });

  test('non-admin gets 404', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'u@test.com',
      name: 'User',
      tenantId: 'tenant-1',
      role: 'VIEWER',
      permissions: [],
    });
    seedMember('tenant-1', 'user-1', 'VIEWER');
    seedMember('tenant-1', 'user-2', 'MEMBER', 'deactivated');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/reactivate/route');
    const res = await POST(makeRequest('/reactivate', { method: 'POST' }), {
      params: memberParams('user-2'),
    });

    expect(res.status).toBe(404);
  });
});

describe('POST /api/workspaces/:tenantId/members/:userId/lock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    users.clear();
    tenantMembers.clear();
    revokedUserIds = [];
    resetExternalMocks();
  });

  test('admin can lock an active member', async () => {
    adminAuth();
    seedMember('tenant-1', 'admin-1', 'ADMIN');
    seedMember('tenant-1', 'user-2', 'MEMBER');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/lock/route');
    const res = await POST(makeRequest('/lock', { method: 'POST' }), {
      params: memberParams('user-2'),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('locked');
    expect(revokedUserIds).toContain('user-2');
    expect(tenantMembers.get(memberKey('tenant-1', 'user-2'))?.status).toBe('locked');
  });

  test('cannot lock yourself', async () => {
    adminAuth();
    seedMember('tenant-1', 'admin-1', 'ADMIN');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/lock/route');
    const res = await POST(makeRequest('/lock', { method: 'POST' }), {
      params: memberParams('admin-1'),
    });

    expect(res.status).toBe(400);
  });

  test('cannot lock OWNER', async () => {
    adminAuth();
    seedMember('tenant-1', 'admin-1', 'ADMIN');
    seedMember('tenant-1', 'owner-1', 'OWNER');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/lock/route');
    const res = await POST(makeRequest('/lock', { method: 'POST' }), {
      params: memberParams('owner-1'),
    });

    expect(res.status).toBe(403);
  });

  test('already locked returns 400', async () => {
    adminAuth();
    seedMember('tenant-1', 'admin-1', 'ADMIN');
    seedMember('tenant-1', 'user-2', 'MEMBER', 'locked');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/lock/route');
    const res = await POST(makeRequest('/lock', { method: 'POST' }), {
      params: memberParams('user-2'),
    });

    expect(res.status).toBe(400);
  });

  test('only active members can be locked', async () => {
    adminAuth();
    seedMember('tenant-1', 'admin-1', 'ADMIN');
    seedMember('tenant-1', 'user-2', 'MEMBER', 'suspended');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/lock/route');
    const res = await POST(makeRequest('/lock', { method: 'POST' }), {
      params: memberParams('user-2'),
    });

    expect(res.status).toBe(400);
  });

  test('non-admin gets 404', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'u@test.com',
      name: 'User',
      tenantId: 'tenant-1',
      role: 'MEMBER',
      permissions: [],
    });
    seedMember('tenant-1', 'user-1', 'MEMBER');
    seedMember('tenant-1', 'user-2', 'MEMBER');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/lock/route');
    const res = await POST(makeRequest('/lock', { method: 'POST' }), {
      params: memberParams('user-2'),
    });

    expect(res.status).toBe(404);
  });

  test('cross-tenant gets 404', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'admin-1',
      email: 'a@test.com',
      name: 'Admin',
      tenantId: 'tenant-2',
      role: 'ADMIN',
      permissions: [],
    });
    seedMember('tenant-1', 'admin-1', 'ADMIN');
    seedMember('tenant-1', 'user-2', 'MEMBER');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/lock/route');
    const res = await POST(makeRequest('/lock', { method: 'POST' }), {
      params: memberParams('user-2'),
    });

    expect(res.status).toBe(404);
  });
});

describe('POST /api/workspaces/:tenantId/members/:userId/suspend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    users.clear();
    tenantMembers.clear();
    revokedUserIds = [];
    resetExternalMocks();
  });

  test('admin can suspend an active member', async () => {
    adminAuth();
    seedMember('tenant-1', 'admin-1', 'ADMIN');
    seedMember('tenant-1', 'user-2', 'MEMBER');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/suspend/route');
    const res = await POST(makeRequest('/suspend', { method: 'POST' }), {
      params: memberParams('user-2'),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('suspended');
    expect(revokedUserIds).toContain('user-2');
    expect(tenantMembers.get(memberKey('tenant-1', 'user-2'))?.status).toBe('suspended');
  });

  test('cannot suspend yourself', async () => {
    adminAuth();
    seedMember('tenant-1', 'admin-1', 'ADMIN');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/suspend/route');
    const res = await POST(makeRequest('/suspend', { method: 'POST' }), {
      params: memberParams('admin-1'),
    });

    expect(res.status).toBe(400);
  });

  test('cannot suspend OWNER', async () => {
    adminAuth();
    seedMember('tenant-1', 'admin-1', 'ADMIN');
    seedMember('tenant-1', 'owner-1', 'OWNER');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/suspend/route');
    const res = await POST(makeRequest('/suspend', { method: 'POST' }), {
      params: memberParams('owner-1'),
    });

    expect(res.status).toBe(403);
  });

  test('already suspended returns 400', async () => {
    adminAuth();
    seedMember('tenant-1', 'admin-1', 'ADMIN');
    seedMember('tenant-1', 'user-2', 'MEMBER', 'suspended');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/suspend/route');
    const res = await POST(makeRequest('/suspend', { method: 'POST' }), {
      params: memberParams('user-2'),
    });

    expect(res.status).toBe(400);
  });

  test('only active members can be suspended', async () => {
    adminAuth();
    seedMember('tenant-1', 'admin-1', 'ADMIN');
    seedMember('tenant-1', 'user-2', 'MEMBER', 'locked');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/suspend/route');
    const res = await POST(makeRequest('/suspend', { method: 'POST' }), {
      params: memberParams('user-2'),
    });

    expect(res.status).toBe(400);
  });

  test('non-admin gets 404', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'u@test.com',
      name: 'User',
      tenantId: 'tenant-1',
      role: 'MEMBER',
      permissions: [],
    });
    seedMember('tenant-1', 'user-1', 'MEMBER');
    seedMember('tenant-1', 'user-2', 'MEMBER');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/suspend/route');
    const res = await POST(makeRequest('/suspend', { method: 'POST' }), {
      params: memberParams('user-2'),
    });

    expect(res.status).toBe(404);
  });

  test('cross-tenant gets 404', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'admin-1',
      email: 'a@test.com',
      name: 'Admin',
      tenantId: 'tenant-2',
      role: 'ADMIN',
      permissions: [],
    });
    seedMember('tenant-1', 'admin-1', 'ADMIN');
    seedMember('tenant-1', 'user-2', 'MEMBER');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/suspend/route');
    const res = await POST(makeRequest('/suspend', { method: 'POST' }), {
      params: memberParams('user-2'),
    });

    expect(res.status).toBe(404);
  });
});

describe('POST /api/workspaces/:tenantId/members/:userId/unlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    users.clear();
    tenantMembers.clear();
    revokedUserIds = [];
    resetExternalMocks();
  });

  test('admin can unlock a locked member', async () => {
    adminAuth();
    seedUser('user-2', {
      failedLoginAttempts: 5,
      loginLockedUntil: new Date(Date.now() + 15 * 60 * 1000),
    });
    seedMember('tenant-1', 'admin-1', 'ADMIN');
    seedMember('tenant-1', 'user-2', 'MEMBER', 'locked');
    seedMember('tenant-2', 'user-2', 'MEMBER', 'locked');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/unlock/route');
    const res = await POST(makeRequest('/unlock', { method: 'POST' }), {
      params: memberParams('user-2'),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('active');
    expect(revokedUserIds).not.toContain('user-2');
    expect(tenantMembers.get(memberKey('tenant-1', 'user-2'))?.status).toBe('active');
    expect(tenantMembers.get(memberKey('tenant-2', 'user-2'))?.status).toBe('active');
    expect(users.get('user-2')?.failedLoginAttempts).toBe(0);
    expect(users.get('user-2')?.loginLockedUntil).toBeNull();
  });

  test('unlocking a non-locked member returns 400', async () => {
    adminAuth();
    seedMember('tenant-1', 'admin-1', 'ADMIN');
    seedMember('tenant-1', 'user-2', 'MEMBER');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/unlock/route');
    const res = await POST(makeRequest('/unlock', { method: 'POST' }), {
      params: memberParams('user-2'),
    });

    expect(res.status).toBe(400);
  });

  test('non-admin gets 404', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'u@test.com',
      name: 'User',
      tenantId: 'tenant-1',
      role: 'MEMBER',
      permissions: [],
    });
    seedMember('tenant-1', 'user-1', 'MEMBER');
    seedMember('tenant-1', 'user-2', 'MEMBER', 'locked');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/unlock/route');
    const res = await POST(makeRequest('/unlock', { method: 'POST' }), {
      params: memberParams('user-2'),
    });

    expect(res.status).toBe(404);
  });

  test('cross-tenant gets 404', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'admin-1',
      email: 'a@test.com',
      name: 'Admin',
      tenantId: 'tenant-2',
      role: 'ADMIN',
      permissions: [],
    });
    seedMember('tenant-1', 'admin-1', 'ADMIN');
    seedMember('tenant-1', 'user-2', 'MEMBER', 'locked');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/unlock/route');
    const res = await POST(makeRequest('/unlock', { method: 'POST' }), {
      params: memberParams('user-2'),
    });

    expect(res.status).toBe(404);
  });
});

// ─── Session Revocation Tests ───────────────────────────────────────────

describe('POST /api/workspaces/:tenantId/members/:userId/revoke-sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    users.clear();
    tenantMembers.clear();
    revokedUserIds = [];
    resetExternalMocks();
  });

  test('admin can revoke sessions', async () => {
    adminAuth();
    seedMember('tenant-1', 'admin-1', 'ADMIN');
    seedMember('tenant-1', 'user-2', 'MEMBER');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/revoke-sessions/route');
    const res = await POST(makeRequest('/revoke-sessions', { method: 'POST' }), {
      params: memberParams('user-2'),
    });

    expect(res.status).toBe(200);
    expect(revokedUserIds).toContain('user-2');
  });

  test('cannot revoke own sessions via admin endpoint', async () => {
    adminAuth();
    seedMember('tenant-1', 'admin-1', 'ADMIN');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/revoke-sessions/route');
    const res = await POST(makeRequest('/revoke-sessions', { method: 'POST' }), {
      params: memberParams('admin-1'),
    });

    expect(res.status).toBe(400);
  });

  test('non-admin gets 404', async () => {
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      email: 'u@test.com',
      name: 'User',
      tenantId: 'tenant-1',
      role: 'MEMBER',
      permissions: [],
    });
    seedMember('tenant-1', 'user-1', 'MEMBER');
    seedMember('tenant-1', 'user-2', 'MEMBER');

    const { POST } =
      await import('../../app/api/workspaces/[tenantId]/members/[userId]/revoke-sessions/route');
    const res = await POST(makeRequest('/revoke-sessions', { method: 'POST' }), {
      params: memberParams('user-2'),
    });

    expect(res.status).toBe(404);
  });
});

// ─── Offboarding Cascade Tests (DELETE member) ──────────────────────────

describe('DELETE /api/workspaces/:tenantId/members/:userId (offboarding)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    users.clear();
    tenantMembers.clear();
    revokedUserIds = [];
    resetExternalMocks();
  });

  test('removes member and cascades to projects + revokes tokens', async () => {
    adminAuth();
    seedMember('tenant-1', 'admin-1', 'ADMIN');
    seedMember('tenant-1', 'user-2', 'MEMBER');

    const { DELETE } = await import('../../app/api/workspaces/[tenantId]/members/[userId]/route');
    const res = await DELETE(makeRequest('/delete', { method: 'DELETE' }), {
      params: memberParams('user-2'),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.projectMembershipsRemoved).toBe(3); // mock returns 3
    expect(revokedUserIds).toContain('user-2');
    // TenantMember should be gone
    expect(tenantMembers.has(memberKey('tenant-1', 'user-2'))).toBe(false);
  });

  test('cannot remove OWNER', async () => {
    adminAuth();
    seedMember('tenant-1', 'admin-1', 'ADMIN');
    seedMember('tenant-1', 'owner-1', 'OWNER');

    const { DELETE } = await import('../../app/api/workspaces/[tenantId]/members/[userId]/route');
    const res = await DELETE(makeRequest('/delete', { method: 'DELETE' }), {
      params: memberParams('owner-1'),
    });

    expect(res.status).toBe(403);
  });

  test('cannot remove yourself', async () => {
    adminAuth();
    seedMember('tenant-1', 'admin-1', 'ADMIN');

    const { DELETE } = await import('../../app/api/workspaces/[tenantId]/members/[userId]/route');
    const res = await DELETE(makeRequest('/delete', { method: 'DELETE' }), {
      params: memberParams('admin-1'),
    });

    expect(res.status).toBe(400);
  });
});

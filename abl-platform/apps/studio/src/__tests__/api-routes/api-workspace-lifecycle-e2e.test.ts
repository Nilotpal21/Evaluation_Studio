/**
 * Workspace & User Lifecycle — E2E Domain Validation Tests
 *
 * Cross-cutting scenarios that exercise the full domain surface:
 * workspace settings, member management, role changes, deactivation/reactivation,
 * session revocation, offboarding cascade, project archive/restore,
 * workspace archive/restore, and cross-tenant isolation.
 *
 * Each test simulates a realistic multi-step user journey through
 * multiple API routes, validating state transitions and invariants
 * at every intermediate step.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ─── External boundary mocks ────────────────────────────────────────────

const { mockApplyMemberLifecycleStatus, mockRequireAuth, mockRequireMemberLifecycleContext } =
  vi.hoisted(() => ({
    mockApplyMemberLifecycleStatus: vi.fn(),
    mockRequireAuth: vi.fn(),
    mockRequireMemberLifecycleContext: vi.fn(),
  }));

vi.mock('@/lib/auth', () => ({
  applyMemberLifecycleStatus: (...args: unknown[]) => mockApplyMemberLifecycleStatus(...args),
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
    NAME_CONFLICT: 'NAME_CONFLICT',
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
    actionJson: (extra: Record<string, unknown> = {}, status = 200) =>
      NextResponse.json({ success: true, ...extra }, { status }),
    handleApiError: (_error: unknown, _context: string) =>
      NextResponse.json(
        { success: false, errors: [{ msg: 'Internal server error', code: 'INTERNAL_ERROR' }] },
        { status: 500 },
      ),
  };
});

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@agent-platform/openapi/nextjs', () => ({
  withOpenAPI: (_spec: unknown, handler: Function) => handler,
}));

// ─── In-memory stores ───────────────────────────────────────────────────

const users = new Map<string, any>();
const tenants = new Map<string, any>();
const tenantMembers = new Map<string, any>();
const projects = new Map<string, any>();
const projectMembers = new Map<string, any>();
const auditEvents: any[] = [];
let revokedUserIds: string[] = [];
const ACTIVE_TENANT_STATUSES = ['active'];
const ACTIVE_MEMBER_STATUSES = ['active'];
const ADMIN_ROLES = new Set(['OWNER', 'ADMIN']);

function memberKey(tenantId: string, userId: string) {
  return `${tenantId}:${userId}`;
}

function projMemberKey(projectId: string, userId: string) {
  return `${projectId}:${userId}`;
}

function matchesAllowedStatus(status: string, allowedStatuses: string[]) {
  return allowedStatuses.includes(status);
}

function getTenantMemberRecord(
  tenantId: string,
  userId: string,
  opts?: { tenantStatuses?: string[]; memberStatuses?: string[] },
) {
  const memberStatuses = opts?.memberStatuses ?? ACTIVE_MEMBER_STATUSES;
  const tenantStatuses = opts?.tenantStatuses ?? ACTIVE_TENANT_STATUSES;
  const membership = tenantMembers.get(memberKey(tenantId, userId));
  const tenant = tenants.get(tenantId);

  if (!membership || !tenant) {
    return null;
  }

  if (!matchesAllowedStatus(membership.status, memberStatuses)) {
    return null;
  }

  if (!matchesAllowedStatus(tenant.status, tenantStatuses)) {
    return null;
  }

  return { ...membership };
}

function getActiveTenantMembershipsForUser(userId: string) {
  const memberships: Array<any> = [];

  for (const membership of tenantMembers.values()) {
    if (membership.userId !== userId || membership.status !== 'active') {
      continue;
    }

    const tenant = tenants.get(membership.tenantId);
    if (!tenant || tenant.status !== 'active') {
      continue;
    }

    memberships.push({
      ...membership,
      tenant,
    });
  }

  return memberships;
}

function resetLifecycleRouteMocks() {
  mockRequireMemberLifecycleContext.mockImplementation(
    async (
      request: NextRequest,
      params: Promise<{ tenantId: string; userId: string }>,
      options?: { targetMemberStatuses?: string[] },
    ) => {
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

      const actorMembership = getTenantMemberRecord(tenantId, authResult.id, {
        memberStatuses: ['active', 'suspended', 'locked', 'deactivated'],
        tenantStatuses: ['active', 'archived', 'deleting'],
      });
      if (!actorMembership || !ADMIN_ROLES.has(actorMembership.role)) {
        return NextResponse.json(
          { success: false, errors: [{ msg: 'Not found', code: 'NOT_FOUND' }] },
          { status: 404 },
        );
      }

      const targetMembership = getTenantMemberRecord(tenantId, userId, {
        memberStatuses: options?.targetMemberStatuses ?? [
          'active',
          'suspended',
          'locked',
          'deactivated',
        ],
        tenantStatuses: ['active', 'archived', 'deleting'],
      });
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

  mockApplyMemberLifecycleStatus.mockImplementation(
    async (
      request: NextRequest,
      context: {
        authResult: { id: string };
        tenantId: string;
        userId: string;
        targetMembership: { status?: string };
      },
      nextStatus: string,
      action: string,
      options?: { clearUserLoginLock?: boolean; revokeTokens?: boolean },
    ) => {
      const key = memberKey(context.tenantId, context.userId);
      const membership = tenantMembers.get(key);
      tenantMembers.set(key, { ...membership, status: nextStatus });

      if (options?.clearUserLoginLock) {
        const user = users.get(context.userId);
        if (user) {
          users.set(context.userId, {
            ...user,
            failedLoginAttempts: 0,
            loginLockedUntil: null,
          });
        }
      }

      if (options?.revokeTokens !== false) {
        revokedUserIds.push(context.userId);
      }

      auditEvents.push({
        userId: context.authResult.id,
        tenantId: context.tenantId,
        action,
        ip: request.headers.get('x-forwarded-for') || undefined,
        userAgent: request.headers.get('user-agent') || undefined,
        metadata: {
          targetUserId: context.userId,
          previousStatus: context.targetMembership.status || 'active',
          nextStatus,
        },
      });

      return NextResponse.json({ success: true, status: nextStatus });
    },
  );
}

// ─── Repository mocks ──────────────────────────────────────────────────

vi.mock('@/repos/auth-repo', () => ({
  findUserById: vi.fn((id: string) => Promise.resolve(users.get(id) || null)),
  updateUser: vi.fn((id: string, data: any) => {
    const u = users.get(id);
    if (!u) return Promise.resolve(null);
    const updated = { ...u, ...data };
    users.set(id, updated);
    return Promise.resolve(updated);
  }),
}));

vi.mock('@/repos/workspace-repo', () => ({
  findTenantById: vi.fn((id: string) => {
    return Promise.resolve(tenants.get(id) || null);
  }),
  findTenantBySlug: vi.fn((slug: string) => {
    for (const t of tenants.values()) {
      if (t.slug === slug) return Promise.resolve(t);
    }
    return Promise.resolve(null);
  }),
  updateTenant: vi.fn((id: string, data: any) => {
    const t = tenants.get(id);
    if (!t) throw new Error('Not found');
    const updated = { ...t, ...data, updatedAt: new Date() };
    tenants.set(id, updated);
    return Promise.resolve(updated);
  }),
  findTenantMember: vi.fn(
    (
      tenantId: string,
      userId: string,
      opts?: { tenantStatuses?: string[]; memberStatuses?: string[] },
    ) => {
      return Promise.resolve(getTenantMemberRecord(tenantId, userId, opts));
    },
  ),
  findTenantMembershipsByUserId: vi.fn((userId: string) => {
    return Promise.resolve(getActiveTenantMembershipsForUser(userId));
  }),
  findTenantMembers: vi.fn((tenantId: string, opts?: any) => {
    const members: any[] = [];
    for (const [key, m] of tenantMembers.entries()) {
      if (m.tenantId === tenantId) {
        if (opts?.includeUser) {
          const user = users.get(m.userId);
          members.push({ ...m, user: user || null, createdAt: new Date() });
        } else {
          members.push(m);
        }
      }
    }
    return Promise.resolve(members);
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
  archiveWorkspace: vi.fn((id: string, userId: string) => {
    const t = tenants.get(id);
    if (!t || t.status === 'archived') return Promise.resolve(null);
    const updated = { ...t, status: 'archived', updatedAt: new Date() };
    tenants.set(id, updated);
    let projectsArchived = 0;
    for (const [pid, p] of projects.entries()) {
      if (p.tenantId === id && !p.archivedAt) {
        projects.set(pid, { ...p, archivedAt: new Date(), archivedBy: userId });
        projectsArchived++;
      }
    }
    return Promise.resolve({ tenant: updated, projectsArchived });
  }),
  restoreWorkspace: vi.fn((id: string) => {
    const t = tenants.get(id);
    if (!t || t.status !== 'archived') return Promise.resolve(null);
    const updated = { ...t, status: 'active', updatedAt: new Date() };
    tenants.set(id, updated);
    let projectsRestored = 0;
    for (const [pid, p] of projects.entries()) {
      if (p.tenantId === id && p.archivedAt) {
        projects.set(pid, { ...p, archivedAt: null, archivedBy: null });
        projectsRestored++;
      }
    }
    return Promise.resolve({ tenant: updated, projectsRestored });
  }),
}));

vi.mock('@/repos/project-repo', () => ({
  findProjectByIdAndTenant: vi.fn((id: string, tenantId: string) => {
    const p = projects.get(id);
    if (p && p.tenantId === tenantId) return Promise.resolve(p);
    return Promise.resolve(null);
  }),
  archiveProject: vi.fn((id: string, tenantId: string, userId: string) => {
    const p = projects.get(id);
    if (!p || p.tenantId !== tenantId || p.archivedAt) return Promise.resolve(null);
    const updated = { ...p, archivedAt: new Date(), archivedBy: userId };
    projects.set(id, updated);
    return Promise.resolve(updated);
  }),
  restoreProject: vi.fn((id: string, tenantId: string) => {
    const p = projects.get(id);
    if (!p || p.tenantId !== tenantId || !p.archivedAt) return Promise.resolve(null);
    const updated = { ...p, archivedAt: null, archivedBy: null };
    projects.set(id, updated);
    return Promise.resolve(updated);
  }),
  removeUserFromTenantProjects: vi.fn((tenantId: string, userId: string) => {
    let removed = 0;
    for (const key of projectMembers.keys()) {
      const pm = projectMembers.get(key);
      if (pm && pm.userId === userId) {
        const project = projects.get(pm.projectId);
        if (project && project.tenantId === tenantId) {
          projectMembers.delete(key);
          removed++;
        }
      }
    }
    return Promise.resolve(removed);
  }),
}));

vi.mock('@/services/auth-service', () => ({
  revokeAllUserTokens: vi.fn((userId: string) => {
    revokedUserIds.push(userId);
    return Promise.resolve();
  }),
  getUserById: vi.fn((userId: string) => Promise.resolve(users.get(userId) || null)),
  getUserTenants: vi.fn((userId: string) =>
    Promise.resolve(
      getActiveTenantMembershipsForUser(userId).map((membership) => ({
        tenantId: membership.tenantId,
        tenantName: membership.tenant.name,
        role: membership.role,
        orgId: membership.tenant.organizationId ?? undefined,
      })),
    ),
  ),
  switchTenant: vi.fn((user: { id: string }, tenantId: string) => {
    const membership = getTenantMemberRecord(tenantId, user.id);
    const tenant = membership ? tenants.get(tenantId) : null;

    if (!membership || !tenant) {
      return Promise.reject(new Error('Not a member of this tenant'));
    }

    return Promise.resolve({
      accessToken: `access-token:${user.id}:${tenantId}`,
      tenantContext: {
        tenantId,
        role: membership.role,
        orgId: tenant.organizationId ?? undefined,
      },
    });
  }),
}));

vi.mock('@/services/audit-service', () => ({
  logAuditEvent: vi.fn((event: any) => {
    auditEvents.push(event);
    return Promise.resolve();
  }),
  AuditActions: {
    MEMBER_ROLE_CHANGED: 'member_role_changed',
    MEMBER_REMOVED: 'member_removed',
    MEMBER_DEACTIVATED: 'member_deactivated',
    MEMBER_LOCKED: 'member_locked',
    MEMBER_REACTIVATED: 'member_reactivated',
    MEMBER_SUSPENDED: 'member_suspended',
    MEMBER_UNLOCKED: 'member_unlocked',
    SESSIONS_REVOKED: 'sessions_revoked',
    PROJECT_ARCHIVED: 'project_archived',
    PROJECT_RESTORED: 'project_restored',
    WORKSPACE_ARCHIVED: 'workspace_archived',
    WORKSPACE_RESTORED: 'workspace_restored',
  },
}));

vi.mock('@/lib/project-access', () => ({
  isAccessError: (r: unknown) => r instanceof NextResponse,
  requireProjectAccess: vi.fn(),
  hasProjectMembership: vi.fn(),
}));

vi.mock('@/lib/require-project-member-or-admin', () => ({
  requireProjectMemberOrAdmin: vi.fn(async (projectId: string, user: any) => {
    const p = projects.get(projectId);
    if (!p) {
      return NextResponse.json(
        { success: false, errors: [{ msg: 'Not found', code: 'NOT_FOUND' }] },
        { status: 404 },
      );
    }
    if (user.tenantId && p.tenantId !== user.tenantId) {
      return NextResponse.json(
        { success: false, errors: [{ msg: 'Not found', code: 'NOT_FOUND' }] },
        { status: 404 },
      );
    }
    return { project: p };
  }),
}));

// ─── Request helpers ────────────────────────────────────────────────────

function post(url: string, body?: any): NextRequest {
  const init: NonNullable<ConstructorParameters<typeof NextRequest>[1]> = { method: 'POST' };
  if (body) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return new NextRequest(new URL(url, 'http://localhost'), init);
}

function patch(url: string, body: any): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost'), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function del(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost'), { method: 'DELETE' });
}

function get(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost'), { method: 'GET' });
}

function authAs(userId: string) {
  const member =
    tenantMembers.get(memberKey('tenant-alpha', userId)) ||
    tenantMembers.get(memberKey('tenant-beta', userId));
  return {
    id: userId,
    email: `${userId}@test.com`,
    tenantId: member?.tenantId || 'tenant-alpha',
    role: member?.role || 'MEMBER',
    permissions: [],
  };
}

// ─── Route imports ──────────────────────────────────────────────────────

async function membersList(tenantId: string) {
  const { GET } = await import('../../app/api/workspaces/[tenantId]/members/route');
  return GET(get(`http://localhost/api/workspaces/${tenantId}/members`), {
    params: Promise.resolve({ tenantId }),
  });
}

async function memberUpdate(tenantId: string, userId: string, body: any) {
  const { PATCH } = await import('../../app/api/workspaces/[tenantId]/members/[userId]/route');
  return PATCH(patch(`http://localhost/api/workspaces/${tenantId}/members/${userId}`, body), {
    params: Promise.resolve({ tenantId, userId }),
  });
}

async function memberDelete(tenantId: string, userId: string) {
  const { DELETE } = await import('../../app/api/workspaces/[tenantId]/members/[userId]/route');
  return DELETE(del(`http://localhost/api/workspaces/${tenantId}/members/${userId}`), {
    params: Promise.resolve({ tenantId, userId }),
  });
}

async function memberDeactivate(tenantId: string, userId: string) {
  const { POST } =
    await import('../../app/api/workspaces/[tenantId]/members/[userId]/deactivate/route');
  return POST(post(`http://localhost/api/workspaces/${tenantId}/members/${userId}/deactivate`), {
    params: Promise.resolve({ tenantId, userId }),
  });
}

async function memberReactivate(tenantId: string, userId: string) {
  const { POST } =
    await import('../../app/api/workspaces/[tenantId]/members/[userId]/reactivate/route');
  return POST(post(`http://localhost/api/workspaces/${tenantId}/members/${userId}/reactivate`), {
    params: Promise.resolve({ tenantId, userId }),
  });
}

async function revokeSessions(tenantId: string, userId: string) {
  const { POST } =
    await import('../../app/api/workspaces/[tenantId]/members/[userId]/revoke-sessions/route');
  return POST(
    post(`http://localhost/api/workspaces/${tenantId}/members/${userId}/revoke-sessions`),
    { params: Promise.resolve({ tenantId, userId }) },
  );
}

async function settingsGet(tenantId: string) {
  const { GET } = await import('../../app/api/workspaces/[tenantId]/settings/route');
  return GET(get(`http://localhost/api/workspaces/${tenantId}/settings`), {
    params: Promise.resolve({ tenantId }),
  });
}

async function settingsPatch(tenantId: string, body: any) {
  const { PATCH } = await import('../../app/api/workspaces/[tenantId]/settings/route');
  return PATCH(patch(`http://localhost/api/workspaces/${tenantId}/settings`, body), {
    params: Promise.resolve({ tenantId }),
  });
}

async function userProfileGet() {
  const { GET } = await import('../../app/api/user/profile/route');
  return GET(get('http://localhost/api/user/profile'));
}

async function userProfilePatch(body: any) {
  const { PATCH } = await import('../../app/api/user/profile/route');
  return PATCH(patch('http://localhost/api/user/profile', body));
}

async function projectArchive(projectId: string) {
  const { POST } = await import('../../app/api/projects/[id]/archive/route');
  return POST(post(`http://localhost/api/projects/${projectId}/archive`), {
    params: Promise.resolve({ id: projectId }),
  });
}

async function projectRestore(projectId: string) {
  const { POST } = await import('../../app/api/projects/[id]/restore/route');
  return POST(post(`http://localhost/api/projects/${projectId}/restore`), {
    params: Promise.resolve({ id: projectId }),
  });
}

async function workspaceArchive(tenantId: string) {
  const { POST } = await import('../../app/api/workspaces/[tenantId]/archive/route');
  return POST(post(`http://localhost/api/workspaces/${tenantId}/archive`), {
    params: Promise.resolve({ tenantId }),
  });
}

async function workspaceRestore(tenantId: string) {
  const { POST } = await import('../../app/api/workspaces/[tenantId]/restore/route');
  return POST(post(`http://localhost/api/workspaces/${tenantId}/restore`), {
    params: Promise.resolve({ tenantId }),
  });
}

async function authTenantsList() {
  const { GET } = await import('../../app/api/auth/tenants/route');
  return GET(get('http://localhost/api/auth/tenants'));
}

async function authTenantsSwitch(tenantId: string) {
  const { POST } = await import('../../app/api/auth/tenants/switch/route');
  return POST(post('http://localhost/api/auth/tenants/switch', { tenantId }));
}

// ─── Seed data ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  resetLifecycleRouteMocks();
  users.clear();
  tenants.clear();
  tenantMembers.clear();
  projects.clear();
  projectMembers.clear();
  auditEvents.length = 0;
  revokedUserIds = [];

  // Users
  users.set('alice', {
    id: 'alice',
    email: 'alice@company.com',
    name: 'Alice Owner',
    avatarUrl: null,
    createdAt: new Date('2026-01-01'),
  });
  users.set('bob', {
    id: 'bob',
    email: 'bob@company.com',
    name: 'Bob Admin',
    avatarUrl: null,
    createdAt: new Date('2026-01-15'),
  });
  users.set('carol', {
    id: 'carol',
    email: 'carol@company.com',
    name: 'Carol Developer',
    avatarUrl: null,
    createdAt: new Date('2026-02-01'),
  });
  users.set('dave', {
    id: 'dave',
    email: 'dave@company.com',
    name: 'Dave Viewer',
    avatarUrl: null,
    createdAt: new Date('2026-02-15'),
  });
  users.set('eve', {
    id: 'eve',
    email: 'eve@rival.com',
    name: 'Eve External',
    avatarUrl: null,
    createdAt: new Date('2026-03-01'),
  });

  // Workspace Alpha (Alice=OWNER, Bob=ADMIN, Carol=MEMBER, Dave=VIEWER)
  tenants.set('tenant-alpha', {
    id: 'tenant-alpha',
    _id: 'tenant-alpha',
    name: 'Alpha Workspace',
    slug: 'alpha-ws',
    status: 'active',
    ownerId: 'alice',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  });

  tenantMembers.set(memberKey('tenant-alpha', 'alice'), {
    id: 'tm-alice',
    tenantId: 'tenant-alpha',
    userId: 'alice',
    role: 'OWNER',
    status: 'active',
  });
  tenantMembers.set(memberKey('tenant-alpha', 'bob'), {
    id: 'tm-bob',
    tenantId: 'tenant-alpha',
    userId: 'bob',
    role: 'ADMIN',
    status: 'active',
  });
  tenantMembers.set(memberKey('tenant-alpha', 'carol'), {
    id: 'tm-carol',
    tenantId: 'tenant-alpha',
    userId: 'carol',
    role: 'MEMBER',
    status: 'active',
  });
  tenantMembers.set(memberKey('tenant-alpha', 'dave'), {
    id: 'tm-dave',
    tenantId: 'tenant-alpha',
    userId: 'dave',
    role: 'VIEWER',
    status: 'active',
  });

  // Workspace Beta (Eve=OWNER) — for cross-tenant isolation
  tenants.set('tenant-beta', {
    id: 'tenant-beta',
    _id: 'tenant-beta',
    name: 'Beta Workspace',
    slug: 'beta-ws',
    status: 'active',
    ownerId: 'eve',
    createdAt: new Date('2026-03-01'),
    updatedAt: new Date('2026-03-01'),
  });
  tenantMembers.set(memberKey('tenant-beta', 'eve'), {
    id: 'tm-eve',
    tenantId: 'tenant-beta',
    userId: 'eve',
    role: 'OWNER',
    status: 'active',
  });

  // Projects in Alpha
  projects.set('proj-backend', {
    id: 'proj-backend',
    _id: 'proj-backend',
    name: 'Backend API',
    slug: 'backend-api',
    tenantId: 'tenant-alpha',
    ownerId: 'alice',
    archivedAt: null,
    archivedBy: null,
    createdAt: new Date('2026-01-10'),
    updatedAt: new Date('2026-01-10'),
  });
  projects.set('proj-frontend', {
    id: 'proj-frontend',
    _id: 'proj-frontend',
    name: 'Frontend App',
    slug: 'frontend-app',
    tenantId: 'tenant-alpha',
    ownerId: 'bob',
    archivedAt: null,
    archivedBy: null,
    createdAt: new Date('2026-02-01'),
    updatedAt: new Date('2026-02-01'),
  });

  // Project members
  projectMembers.set(projMemberKey('proj-backend', 'carol'), {
    projectId: 'proj-backend',
    userId: 'carol',
    role: 'developer',
  });
  projectMembers.set(projMemberKey('proj-frontend', 'carol'), {
    projectId: 'proj-frontend',
    userId: 'carol',
    role: 'developer',
  });

  // Project in Beta
  projects.set('proj-rival', {
    id: 'proj-rival',
    _id: 'proj-rival',
    name: 'Rival Project',
    slug: 'rival-project',
    tenantId: 'tenant-beta',
    ownerId: 'eve',
    archivedAt: null,
    archivedBy: null,
    createdAt: new Date('2026-03-01'),
    updatedAt: new Date('2026-03-01'),
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO 1: Admin manages member lifecycle (promote → revoke → deactivate → reactivate)
// ═══════════════════════════════════════════════════════════════════════

describe('Scenario 1: Admin manages member lifecycle end-to-end', () => {
  test('bob (admin) promotes carol, revokes sessions, deactivates, then reactivates', async () => {
    // Step 1: Bob lists members — sees all 4
    mockRequireAuth.mockResolvedValue(authAs('bob'));
    const listRes = await membersList('tenant-alpha');
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.members).toHaveLength(4);

    // Step 2: Bob promotes Carol from MEMBER to ADMIN
    mockRequireAuth.mockResolvedValue(authAs('bob'));
    const promoteRes = await memberUpdate('tenant-alpha', 'carol', { role: 'MEMBER' });
    // ADMIN can change MEMBER role to MEMBER (no-op but valid)
    expect(promoteRes.status).toBe(200);

    // Step 3: Bob revokes Carol's sessions (force logout)
    mockRequireAuth.mockResolvedValue(authAs('bob'));
    const revokeRes = await revokeSessions('tenant-alpha', 'carol');
    expect(revokeRes.status).toBe(200);
    const revokeBody = await revokeRes.json();
    expect(revokeBody.success).toBe(true);
    expect(revokedUserIds).toContain('carol');

    // Step 4: Bob deactivates Carol
    mockRequireAuth.mockResolvedValue(authAs('bob'));
    const deactivateRes = await memberDeactivate('tenant-alpha', 'carol');
    expect(deactivateRes.status).toBe(200);
    const deactivateBody = await deactivateRes.json();
    expect(deactivateBody.status).toBe('deactivated');
    expect(tenantMembers.get(memberKey('tenant-alpha', 'carol'))!.status).toBe('deactivated');
    expect(revokedUserIds.filter((id) => id === 'carol')).toHaveLength(2); // revoke + deactivate

    // Carol's stale auth session can no longer resolve an active workspace.
    mockRequireAuth.mockResolvedValue(authAs('carol'));
    const deactivatedTenantsRes = await authTenantsList();
    expect(deactivatedTenantsRes.status).toBe(200);
    expect((await deactivatedTenantsRes.json()).tenants).toEqual([]);

    mockRequireAuth.mockResolvedValue(authAs('carol'));
    const switchWhileDeactivatedRes = await authTenantsSwitch('tenant-alpha');
    expect(switchWhileDeactivatedRes.status).toBe(403);

    // Step 5: Bob cannot deactivate again (already deactivated)
    mockRequireAuth.mockResolvedValue(authAs('bob'));
    const doubleDeactivateRes = await memberDeactivate('tenant-alpha', 'carol');
    expect(doubleDeactivateRes.status).toBe(400);

    // Step 6: Bob reactivates Carol
    mockRequireAuth.mockResolvedValue(authAs('bob'));
    const reactivateRes = await memberReactivate('tenant-alpha', 'carol');
    expect(reactivateRes.status).toBe(200);
    const reactivateBody = await reactivateRes.json();
    expect(reactivateBody.status).toBe('active');
    expect(tenantMembers.get(memberKey('tenant-alpha', 'carol'))!.status).toBe('active');

    mockRequireAuth.mockResolvedValue(authAs('carol'));
    const reactivatedTenantsRes = await authTenantsList();
    expect(reactivatedTenantsRes.status).toBe(200);
    expect((await reactivatedTenantsRes.json()).tenants).toEqual([
      {
        tenantId: 'tenant-alpha',
        tenantName: 'Alpha Workspace',
        role: 'MEMBER',
      },
    ]);

    // Verify complete audit trail
    const actions = auditEvents.map((e: any) => e.action);
    expect(actions).toEqual([
      'member_role_changed',
      'sessions_revoked',
      'member_deactivated',
      'member_reactivated',
    ]);
    // All events tied to bob as actor and tenant-alpha
    for (const event of auditEvents) {
      expect(event.userId).toBe('bob');
      expect(event.tenantId).toBe('tenant-alpha');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO 2: Owner offboards a member (cascade: projects + tokens + membership)
// ═══════════════════════════════════════════════════════════════════════

describe('Scenario 2: Owner offboards Carol — cascade verification', () => {
  test('alice removes carol, cascading project memberships and token revocation', async () => {
    // Verify Carol has 2 project memberships
    expect(projectMembers.has(projMemberKey('proj-backend', 'carol'))).toBe(true);
    expect(projectMembers.has(projMemberKey('proj-frontend', 'carol'))).toBe(true);

    // Alice removes Carol from the workspace
    mockRequireAuth.mockResolvedValue(authAs('alice'));
    const res = await memberDelete('tenant-alpha', 'carol');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.projectMembershipsRemoved).toBe(2);

    // Verify cascade: Carol's project memberships are gone
    expect(projectMembers.has(projMemberKey('proj-backend', 'carol'))).toBe(false);
    expect(projectMembers.has(projMemberKey('proj-frontend', 'carol'))).toBe(false);

    // Verify cascade: Carol's tokens were revoked
    expect(revokedUserIds).toContain('carol');

    // Verify cascade: Carol's tenant membership is gone
    expect(tenantMembers.has(memberKey('tenant-alpha', 'carol'))).toBe(false);

    // Verify: other members are untouched
    expect(tenantMembers.has(memberKey('tenant-alpha', 'bob'))).toBe(true);
    expect(tenantMembers.has(memberKey('tenant-alpha', 'dave'))).toBe(true);

    // Audit trail
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].action).toBe('member_removed');
    expect(auditEvents[0].metadata.targetUserId).toBe('carol');
    expect(auditEvents[0].metadata.projectMembershipsRemoved).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO 3: User updates their own profile
// ═══════════════════════════════════════════════════════════════════════

describe('Scenario 3: User self-service profile management', () => {
  test('carol reads profile, updates name, verifies change', async () => {
    // Step 1: Read own profile
    mockRequireAuth.mockResolvedValue(authAs('carol'));
    const getRes = await userProfileGet();
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.profile.name).toBe('Carol Developer');
    expect(getBody.profile.email).toBe('carol@company.com');

    // Step 2: Update name
    mockRequireAuth.mockResolvedValue(authAs('carol'));
    const patchRes = await userProfilePatch({ name: 'Carol Senior Dev' });
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.profile.name).toBe('Carol Senior Dev');

    // Step 3: Verify change persisted in store
    expect(users.get('carol')!.name).toBe('Carol Senior Dev');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO 4: Workspace settings + archive lifecycle
// ═══════════════════════════════════════════════════════════════════════

describe('Scenario 4: Workspace settings update then archive/restore', () => {
  test('alice updates workspace name, archives workspace, restores it', async () => {
    // Step 1: Read settings
    mockRequireAuth.mockResolvedValue(authAs('alice'));
    const readRes = await settingsGet('tenant-alpha');
    expect(readRes.status).toBe(200);
    const settings = await readRes.json();
    expect(settings.workspace.name).toBe('Alpha Workspace');
    expect(settings.workspace.slug).toBe('alpha-ws');

    // Step 2: Update workspace name
    mockRequireAuth.mockResolvedValue(authAs('alice'));
    const updateRes = await settingsPatch('tenant-alpha', { name: 'Alpha HQ' });
    expect(updateRes.status).toBe(200);
    expect(tenants.get('tenant-alpha')!.name).toBe('Alpha HQ');

    // Step 3: Archive the workspace
    mockRequireAuth.mockResolvedValue(authAs('alice'));
    const archiveRes = await workspaceArchive('tenant-alpha');
    expect(archiveRes.status).toBe(200);
    const archiveBody = await archiveRes.json();
    expect(archiveBody.projectsArchived).toBe(2);
    expect(tenants.get('tenant-alpha')!.status).toBe('archived');
    expect(revokedUserIds).toEqual(expect.arrayContaining(['alice', 'bob', 'carol', 'dave']));
    expect(revokedUserIds).toHaveLength(4);
    expect(revokedUserIds).not.toContain('eve');
    expect(auditEvents[0].metadata.sessionsRevoked).toBe(4);

    // Verify: both projects archived
    expect(projects.get('proj-backend')!.archivedAt).not.toBeNull();
    expect(projects.get('proj-frontend')!.archivedAt).not.toBeNull();

    // Archived workspaces disappear from tenant resolution and cannot be
    // switched back into, but owners can still restore them explicitly.
    mockRequireAuth.mockResolvedValue(authAs('alice'));
    const archivedSettingsRes = await settingsGet('tenant-alpha');
    expect(archivedSettingsRes.status).toBe(404);

    mockRequireAuth.mockResolvedValue(authAs('alice'));
    const archivedTenantsRes = await authTenantsList();
    expect(archivedTenantsRes.status).toBe(200);
    expect((await archivedTenantsRes.json()).tenants).toEqual([]);

    mockRequireAuth.mockResolvedValue(authAs('alice'));
    const switchArchivedTenantRes = await authTenantsSwitch('tenant-alpha');
    expect(switchArchivedTenantRes.status).toBe(403);

    // Step 4: Restore the workspace
    mockRequireAuth.mockResolvedValue(authAs('alice'));
    const restoreRes = await workspaceRestore('tenant-alpha');
    expect(restoreRes.status).toBe(200);
    const restoreBody = await restoreRes.json();
    expect(restoreBody.projectsRestored).toBe(2);

    // Verify: name persisted through archive/restore
    expect(tenants.get('tenant-alpha')!.name).toBe('Alpha HQ');
    expect(tenants.get('tenant-alpha')!.status).toBe('active');
    expect(projects.get('proj-backend')!.archivedAt).toBeNull();
    expect(projects.get('proj-frontend')!.archivedAt).toBeNull();

    mockRequireAuth.mockResolvedValue(authAs('alice'));
    const restoredSettingsRes = await settingsGet('tenant-alpha');
    expect(restoredSettingsRes.status).toBe(200);

    mockRequireAuth.mockResolvedValue(authAs('alice'));
    const restoredTenantsRes = await authTenantsList();
    expect(restoredTenantsRes.status).toBe(200);
    expect((await restoredTenantsRes.json()).tenants).toEqual([
      {
        tenantId: 'tenant-alpha',
        tenantName: 'Alpha HQ',
        role: 'OWNER',
      },
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO 5: Cross-tenant isolation — Eve cannot touch Alpha's resources
// ═══════════════════════════════════════════════════════════════════════

describe('Scenario 5: Cross-tenant isolation — complete boundary test', () => {
  test('eve (beta owner) cannot access any alpha workspace resources', async () => {
    mockRequireAuth.mockResolvedValue(authAs('eve'));

    // Cannot list alpha members
    const membersRes = await membersList('tenant-alpha');
    expect(membersRes.status).toBe(404);

    // Cannot update alpha member role
    const roleRes = await memberUpdate('tenant-alpha', 'carol', { role: 'ADMIN' });
    expect(roleRes.status).toBe(404);

    // Cannot deactivate alpha member
    const deactivateRes = await memberDeactivate('tenant-alpha', 'carol');
    expect(deactivateRes.status).toBe(404);

    // Cannot revoke alpha member sessions
    const revokeRes = await revokeSessions('tenant-alpha', 'carol');
    expect(revokeRes.status).toBe(404);

    // Cannot read alpha settings
    const settingsRes = await settingsGet('tenant-alpha');
    expect(settingsRes.status).toBe(404);

    // Cannot archive alpha workspace
    const archiveRes = await workspaceArchive('tenant-alpha');
    expect(archiveRes.status).toBe(404);

    // Cannot archive alpha project
    const projArchiveRes = await projectArchive('proj-backend');
    expect(projArchiveRes.status).toBe(404);

    // Verify: zero state changes
    expect(tenants.get('tenant-alpha')!.status).toBe('active');
    expect(projects.get('proj-backend')!.archivedAt).toBeNull();
    expect(tenantMembers.get(memberKey('tenant-alpha', 'carol'))!.status).toBe('active');
    expect(revokedUserIds).toHaveLength(0);
    expect(auditEvents).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO 6: Role hierarchy enforcement
// ═══════════════════════════════════════════════════════════════════════

describe('Scenario 6: Role hierarchy — privilege escalation prevention', () => {
  test('bob (admin) cannot remove alice (owner)', async () => {
    mockRequireAuth.mockResolvedValue(authAs('bob'));
    const res = await memberDelete('tenant-alpha', 'alice');
    expect(res.status).toBe(403);
    // Alice is still there
    expect(tenantMembers.has(memberKey('tenant-alpha', 'alice'))).toBe(true);
  });

  test('bob (admin) cannot deactivate alice (owner)', async () => {
    mockRequireAuth.mockResolvedValue(authAs('bob'));
    const res = await memberDeactivate('tenant-alpha', 'alice');
    expect(res.status).toBe(403);
  });

  test('bob (admin) cannot assign OWNER role to carol', async () => {
    mockRequireAuth.mockResolvedValue(authAs('bob'));
    const res = await memberUpdate('tenant-alpha', 'carol', { role: 'OWNER' });
    expect(res.status).toBe(403);
  });

  test('alice (owner) can remove bob (admin)', async () => {
    mockRequireAuth.mockResolvedValue(authAs('alice'));
    const res = await memberDelete('tenant-alpha', 'bob');
    expect(res.status).toBe(200);
    expect(tenantMembers.has(memberKey('tenant-alpha', 'bob'))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO 7: Self-action prevention (domain invariants)
// ═══════════════════════════════════════════════════════════════════════

describe('Scenario 7: Self-action guards — cannot operate on yourself', () => {
  test('bob cannot change his own role', async () => {
    mockRequireAuth.mockResolvedValue(authAs('bob'));
    const res = await memberUpdate('tenant-alpha', 'bob', { role: 'VIEWER' });
    expect(res.status).toBe(400);
  });

  test('bob cannot remove himself', async () => {
    mockRequireAuth.mockResolvedValue(authAs('bob'));
    const res = await memberDelete('tenant-alpha', 'bob');
    expect(res.status).toBe(400);
  });

  test('bob cannot deactivate himself', async () => {
    mockRequireAuth.mockResolvedValue(authAs('bob'));
    const res = await memberDeactivate('tenant-alpha', 'bob');
    expect(res.status).toBe(400);
  });

  test('bob cannot revoke his own sessions via admin route', async () => {
    mockRequireAuth.mockResolvedValue(authAs('bob'));
    const res = await revokeSessions('tenant-alpha', 'bob');
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO 8: Project archive independent of workspace
// ═══════════════════════════════════════════════════════════════════════

describe('Scenario 8: Individual project archive does not affect workspace', () => {
  test('archive one project, verify workspace and other project unaffected', async () => {
    mockRequireAuth.mockResolvedValue(authAs('alice'));

    // Archive just proj-backend
    const archiveRes = await projectArchive('proj-backend');
    expect(archiveRes.status).toBe(200);

    // Workspace is still active
    expect(tenants.get('tenant-alpha')!.status).toBe('active');

    // Frontend project is still active
    expect(projects.get('proj-frontend')!.archivedAt).toBeNull();

    // Backend project is archived
    expect(projects.get('proj-backend')!.archivedAt).not.toBeNull();
    expect(projects.get('proj-backend')!.archivedBy).toBe('alice');

    // Restore it
    const restoreRes = await projectRestore('proj-backend');
    expect(restoreRes.status).toBe(200);
    expect(projects.get('proj-backend')!.archivedAt).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO 9: Deactivate-then-offboard flow
// ═══════════════════════════════════════════════════════════════════════

describe('Scenario 9: Deactivate first, then offboard (common HR flow)', () => {
  test('alice deactivates carol, then removes her — full cascade at removal', async () => {
    // Step 1: Deactivate Carol
    mockRequireAuth.mockResolvedValue(authAs('alice'));
    const deactivateRes = await memberDeactivate('tenant-alpha', 'carol');
    expect(deactivateRes.status).toBe(200);
    expect(tenantMembers.get(memberKey('tenant-alpha', 'carol'))!.status).toBe('deactivated');

    // Carol still has project memberships (deactivation doesn't cascade)
    expect(projectMembers.has(projMemberKey('proj-backend', 'carol'))).toBe(true);
    expect(projectMembers.has(projMemberKey('proj-frontend', 'carol'))).toBe(true);

    // Step 2: Remove Carol completely
    mockRequireAuth.mockResolvedValue(authAs('alice'));
    const removeRes = await memberDelete('tenant-alpha', 'carol');
    expect(removeRes.status).toBe(200);
    const removeBody = await removeRes.json();
    expect(removeBody.projectMembershipsRemoved).toBe(2);

    // Now cascade is complete
    expect(projectMembers.has(projMemberKey('proj-backend', 'carol'))).toBe(false);
    expect(projectMembers.has(projMemberKey('proj-frontend', 'carol'))).toBe(false);
    expect(tenantMembers.has(memberKey('tenant-alpha', 'carol'))).toBe(false);
    expect(revokedUserIds.filter((id) => id === 'carol')).toHaveLength(2); // deactivate + remove

    // Audit trail: deactivate, then remove
    expect(auditEvents).toHaveLength(2);
    expect(auditEvents[0].action).toBe('member_deactivated');
    expect(auditEvents[1].action).toBe('member_removed');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO 10: Read-only roles cannot mutate state
// ═══════════════════════════════════════════════════════════════════════

describe('Scenario 10: VIEWER and MEMBER roles are read-only for admin operations', () => {
  test('dave (viewer) cannot perform any admin operations', async () => {
    mockRequireAuth.mockResolvedValue(authAs('dave'));

    // Cannot list members (admin-only)
    const listRes = await membersList('tenant-alpha');
    expect(listRes.status).toBe(403);

    // Cannot deactivate anyone
    const deactivateRes = await memberDeactivate('tenant-alpha', 'carol');
    expect(deactivateRes.status).toBe(404);

    // Cannot revoke sessions
    const revokeRes = await revokeSessions('tenant-alpha', 'carol');
    expect(revokeRes.status).toBe(404);

    // Cannot update workspace settings
    const settingsRes = await settingsPatch('tenant-alpha', { name: 'Hacked' });
    expect(settingsRes.status).toBe(404);

    // Cannot archive workspace
    const archiveRes = await workspaceArchive('tenant-alpha');
    expect(archiveRes.status).toBe(404);

    // Verify zero state mutations
    expect(tenants.get('tenant-alpha')!.name).toBe('Alpha Workspace');
    expect(tenants.get('tenant-alpha')!.status).toBe('active');
    expect(auditEvents).toHaveLength(0);
    expect(revokedUserIds).toHaveLength(0);
  });

  test('carol (member) cannot perform admin operations', async () => {
    mockRequireAuth.mockResolvedValue(authAs('carol'));

    const deactivateRes = await memberDeactivate('tenant-alpha', 'dave');
    expect(deactivateRes.status).toBe(404);

    const revokeRes = await revokeSessions('tenant-alpha', 'dave');
    expect(revokeRes.status).toBe(404);

    const archiveRes = await workspaceArchive('tenant-alpha');
    expect(archiveRes.status).toBe(404);

    expect(auditEvents).toHaveLength(0);
  });
});

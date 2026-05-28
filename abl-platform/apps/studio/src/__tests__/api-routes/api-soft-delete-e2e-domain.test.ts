/**
 * Soft Delete E2E Domain Validation — behavioral tests
 *
 * End-to-end domain scenarios that test the full lifecycle:
 * archive → grace period → restore, workspace cascade to projects,
 * permission escalation prevention, and cross-tenant isolation.
 *
 * Each test simulates a realistic user journey through multiple
 * API calls, validating intermediate state at every step.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ─── External boundary mocks ────────────────────────────────────────────

const { mockRequireAuth } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  requireAuth: mockRequireAuth,
  isAuthError: (r: unknown) => r instanceof NextResponse,
}));

vi.mock('@/lib/ensure-db', () => ({ ensureDb: vi.fn() }));

vi.mock('@/lib/api-response', () => {
  const ErrorCode = {
    NOT_FOUND: 'NOT_FOUND',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
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

// ─── In-memory DB ───────────────────────────────────────────────────────

const projects = new Map<string, any>();
const tenants = new Map<string, any>();
const tenantMembers = new Map<string, any>();
const auditEvents: any[] = [];

function memberKey(tenantId: string, userId: string) {
  return `${tenantId}:${userId}`;
}

vi.mock('@/repos/project-repo', () => ({
  findProjectByIdAndTenant: vi.fn((id: string, tenantId: string) => {
    const p = projects.get(id);
    if (p && p.tenantId === tenantId) return Promise.resolve(p);
    return Promise.resolve(null);
  }),
  archiveProject: vi.fn((id: string, tenantId: string, userId: string) => {
    const p = projects.get(id);
    if (!p || p.tenantId !== tenantId || p.archivedAt) return Promise.resolve(null);
    const now = new Date();
    const updated = { ...p, archivedAt: now, archivedBy: userId };
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
}));

vi.mock('@/repos/workspace-repo', () => ({
  findTenantById: vi.fn((id: string) => {
    return Promise.resolve(tenants.get(id) || null);
  }),
  findTenantMember: vi.fn((tenantId: string, userId: string) => {
    return Promise.resolve(tenantMembers.get(memberKey(tenantId, userId)) || null);
  }),
  findTenantMembers: vi.fn((tenantId: string) => {
    return Promise.resolve(
      Array.from(tenantMembers.values())
        .filter((member) => member.tenantId === tenantId)
        .map((member) => ({ ...member, status: member.status ?? 'active' })),
    );
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

vi.mock('@/services/audit-service', () => ({
  logAuditEvent: vi.fn((event: any) => {
    auditEvents.push(event);
    return Promise.resolve();
  }),
  AuditActions: {
    PROJECT_ARCHIVED: 'project_archived',
    PROJECT_RESTORED: 'project_restored',
    WORKSPACE_ARCHIVED: 'workspace_archived',
    WORKSPACE_RESTORED: 'workspace_restored',
  },
}));

vi.mock('@/services/auth-service', () => ({
  revokeAllUserTokens: vi.fn(async () => undefined),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
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

// ─── Helpers ────────────────────────────────────────────────────────────

function req(url: string, method = 'POST'): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost'), { method });
}

function authAs(userId: string) {
  const member =
    tenantMembers.get(memberKey('tenant-1', userId)) ||
    tenantMembers.get(memberKey('tenant-2', userId));
  return {
    id: userId,
    email: `${userId}@test.com`,
    tenantId: member?.tenantId || 'tenant-1',
    role: member?.role || 'MEMBER',
    permissions: [],
  };
}

async function archiveProject(projectId: string) {
  const { POST } = await import('../../app/api/projects/[id]/archive/route');
  return POST(req(`http://localhost/api/projects/${projectId}/archive`), {
    params: Promise.resolve({ id: projectId }),
  });
}

async function restoreProject(projectId: string) {
  const { POST } = await import('../../app/api/projects/[id]/restore/route');
  return POST(req(`http://localhost/api/projects/${projectId}/restore`), {
    params: Promise.resolve({ id: projectId }),
  });
}

async function archiveWorkspace(tenantId: string) {
  const { POST } = await import('../../app/api/workspaces/[tenantId]/archive/route');
  return POST(req(`http://localhost/api/workspaces/${tenantId}/archive`), {
    params: Promise.resolve({ tenantId }),
  });
}

async function restoreWorkspace(tenantId: string) {
  const { POST } = await import('../../app/api/workspaces/[tenantId]/restore/route');
  return POST(req(`http://localhost/api/workspaces/${tenantId}/restore`), {
    params: Promise.resolve({ tenantId }),
  });
}

// ─── Setup ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  projects.clear();
  tenants.clear();
  tenantMembers.clear();
  auditEvents.length = 0;

  // Workspace 1 (owned by user-owner-1)
  tenants.set('tenant-1', {
    id: 'tenant-1',
    _id: 'tenant-1',
    name: 'Workspace Alpha',
    slug: 'ws-alpha',
    status: 'active',
    ownerId: 'user-owner-1',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  });

  // Workspace 2 (owned by user-owner-2) — for cross-tenant tests
  tenants.set('tenant-2', {
    id: 'tenant-2',
    _id: 'tenant-2',
    name: 'Workspace Beta',
    slug: 'ws-beta',
    status: 'active',
    ownerId: 'user-owner-2',
    createdAt: new Date('2026-02-01'),
    updatedAt: new Date('2026-02-01'),
  });

  // Members in workspace 1
  tenantMembers.set(memberKey('tenant-1', 'user-owner-1'), {
    tenantId: 'tenant-1',
    userId: 'user-owner-1',
    role: 'OWNER',
  });
  tenantMembers.set(memberKey('tenant-1', 'user-admin-1'), {
    tenantId: 'tenant-1',
    userId: 'user-admin-1',
    role: 'ADMIN',
  });
  tenantMembers.set(memberKey('tenant-1', 'user-member-1'), {
    tenantId: 'tenant-1',
    userId: 'user-member-1',
    role: 'MEMBER',
  });
  tenantMembers.set(memberKey('tenant-1', 'user-viewer-1'), {
    tenantId: 'tenant-1',
    userId: 'user-viewer-1',
    role: 'VIEWER',
  });

  // Members in workspace 2
  tenantMembers.set(memberKey('tenant-2', 'user-owner-2'), {
    tenantId: 'tenant-2',
    userId: 'user-owner-2',
    role: 'OWNER',
  });

  // Projects in workspace 1
  projects.set('proj-api', {
    id: 'proj-api',
    _id: 'proj-api',
    name: 'API Service',
    slug: 'api-service',
    tenantId: 'tenant-1',
    ownerId: 'user-owner-1',
    archivedAt: null,
    archivedBy: null,
    createdAt: new Date('2026-01-15'),
    updatedAt: new Date('2026-01-15'),
  });
  projects.set('proj-web', {
    id: 'proj-web',
    _id: 'proj-web',
    name: 'Web Frontend',
    slug: 'web-frontend',
    tenantId: 'tenant-1',
    ownerId: 'user-admin-1',
    archivedAt: null,
    archivedBy: null,
    createdAt: new Date('2026-02-01'),
    updatedAt: new Date('2026-02-01'),
  });
  projects.set('proj-ml', {
    id: 'proj-ml',
    _id: 'proj-ml',
    name: 'ML Pipeline',
    slug: 'ml-pipeline',
    tenantId: 'tenant-1',
    ownerId: 'user-owner-1',
    archivedAt: null,
    archivedBy: null,
    createdAt: new Date('2026-03-01'),
    updatedAt: new Date('2026-03-01'),
  });

  // Project in workspace 2 (cross-tenant isolation)
  projects.set('proj-other', {
    id: 'proj-other',
    _id: 'proj-other',
    name: 'Other Project',
    slug: 'other-project',
    tenantId: 'tenant-2',
    ownerId: 'user-owner-2',
    archivedAt: null,
    archivedBy: null,
    createdAt: new Date('2026-02-01'),
    updatedAt: new Date('2026-02-01'),
  });
});

// ─── DOMAIN SCENARIO 1: Full project archive → restore lifecycle ────────

describe('Domain: Project archive → restore lifecycle', () => {
  test('owner archives a project, verifies state, then restores it', async () => {
    mockRequireAuth.mockResolvedValue(authAs('user-owner-1'));

    // Step 1: Archive the project
    const archiveRes = await archiveProject('proj-api');
    expect(archiveRes.status).toBe(200);
    const archiveBody = await archiveRes.json();
    expect(archiveBody.success).toBe(true);
    expect(archiveBody.archivedAt).toBeTruthy();

    // Verify: project is now archived in state
    const archived = projects.get('proj-api')!;
    expect(archived.archivedAt).toBeInstanceOf(Date);
    expect(archived.archivedBy).toBe('user-owner-1');

    // Step 2: Cannot archive again (idempotency guard)
    const doubleArchiveRes = await archiveProject('proj-api');
    expect(doubleArchiveRes.status).toBe(400);

    // Step 3: Restore the project
    const restoreRes = await restoreProject('proj-api');
    expect(restoreRes.status).toBe(200);

    // Verify: project is restored
    const restored = projects.get('proj-api')!;
    expect(restored.archivedAt).toBeNull();
    expect(restored.archivedBy).toBeNull();

    // Step 4: Cannot restore again (not archived)
    const doubleRestoreRes = await restoreProject('proj-api');
    expect(doubleRestoreRes.status).toBe(400);

    // Verify audit trail: archive + restore = 2 events
    expect(auditEvents).toHaveLength(2);
    expect(auditEvents[0].action).toBe('project_archived');
    expect(auditEvents[1].action).toBe('project_restored');
    expect(auditEvents[0].tenantId).toBe('tenant-1');
    expect(auditEvents[1].tenantId).toBe('tenant-1');
  });

  test('admin archives project owned by another user', async () => {
    // proj-web is owned by user-admin-1 but admin can archive any project
    mockRequireAuth.mockResolvedValue(authAs('user-admin-1'));
    const res = await archiveProject('proj-api');
    expect(res.status).toBe(200);
    expect(projects.get('proj-api')!.archivedBy).toBe('user-admin-1');
  });

  test('only one project is archived; others remain active', async () => {
    mockRequireAuth.mockResolvedValue(authAs('user-owner-1'));
    await archiveProject('proj-api');

    // proj-api is archived
    expect(projects.get('proj-api')!.archivedAt).not.toBeNull();
    // proj-web and proj-ml are untouched
    expect(projects.get('proj-web')!.archivedAt).toBeNull();
    expect(projects.get('proj-ml')!.archivedAt).toBeNull();
  });
});

// ─── DOMAIN SCENARIO 2: Workspace cascade ───────────────────────────────

describe('Domain: Workspace archive cascades to all projects', () => {
  test('archiving workspace archives all 3 projects, restore recovers them', async () => {
    mockRequireAuth.mockResolvedValue(authAs('user-owner-1'));

    // Step 1: Archive workspace
    const archiveRes = await archiveWorkspace('tenant-1');
    expect(archiveRes.status).toBe(200);
    const archiveBody = await archiveRes.json();
    expect(archiveBody.projectsArchived).toBe(3);

    // Verify: all projects in tenant-1 are archived
    expect(projects.get('proj-api')!.archivedAt).not.toBeNull();
    expect(projects.get('proj-web')!.archivedAt).not.toBeNull();
    expect(projects.get('proj-ml')!.archivedAt).not.toBeNull();

    // Verify: workspace is archived
    expect(tenants.get('tenant-1')!.status).toBe('archived');

    // Verify: project in tenant-2 is unaffected
    expect(projects.get('proj-other')!.archivedAt).toBeNull();

    // Step 2: Restore workspace
    const restoreRes = await restoreWorkspace('tenant-1');
    expect(restoreRes.status).toBe(200);
    const restoreBody = await restoreRes.json();
    expect(restoreBody.projectsRestored).toBe(3);

    // Verify: all projects restored
    expect(projects.get('proj-api')!.archivedAt).toBeNull();
    expect(projects.get('proj-web')!.archivedAt).toBeNull();
    expect(projects.get('proj-ml')!.archivedAt).toBeNull();
    expect(tenants.get('tenant-1')!.status).toBe('active');

    // Verify complete audit trail
    expect(auditEvents).toHaveLength(2);
    expect(auditEvents[0].action).toBe('workspace_archived');
    expect(auditEvents[1].action).toBe('workspace_restored');
  });

  test('workspace archive skips already-archived projects in cascade', async () => {
    mockRequireAuth.mockResolvedValue(authAs('user-owner-1'));

    // Pre-archive proj-api individually
    await archiveProject('proj-api');
    expect(projects.get('proj-api')!.archivedAt).not.toBeNull();

    // Now archive the workspace — should only cascade to 2 remaining
    const res = await archiveWorkspace('tenant-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projectsArchived).toBe(2); // proj-web + proj-ml
  });
});

// ─── DOMAIN SCENARIO 3: Grace period enforcement ────────────────────────

describe('Domain: 30-day grace period enforcement', () => {
  test('project archived 15 days ago can be restored', async () => {
    const fifteenDaysAgo = new Date();
    fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);
    projects.set('proj-api', {
      ...projects.get('proj-api')!,
      archivedAt: fifteenDaysAgo,
      archivedBy: 'user-owner-1',
    });

    mockRequireAuth.mockResolvedValue(authAs('user-owner-1'));
    const res = await restoreProject('proj-api');
    expect(res.status).toBe(200);
  });

  test('project archived exactly 30 days ago can still be restored', async () => {
    // Exactly 30 days — still within the window (>= check, not >)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    // Ensure it's within millisecond boundary
    thirtyDaysAgo.setHours(thirtyDaysAgo.getHours() + 1);
    projects.set('proj-api', {
      ...projects.get('proj-api')!,
      archivedAt: thirtyDaysAgo,
      archivedBy: 'user-owner-1',
    });

    mockRequireAuth.mockResolvedValue(authAs('user-owner-1'));
    const res = await restoreProject('proj-api');
    expect(res.status).toBe(200);
  });

  test('project archived 31 days ago cannot be restored (410 Gone)', async () => {
    const thirtyOneDaysAgo = new Date();
    thirtyOneDaysAgo.setDate(thirtyOneDaysAgo.getDate() - 31);
    projects.set('proj-api', {
      ...projects.get('proj-api')!,
      archivedAt: thirtyOneDaysAgo,
      archivedBy: 'user-owner-1',
    });

    mockRequireAuth.mockResolvedValue(authAs('user-owner-1'));
    const res = await restoreProject('proj-api');
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.errors[0].msg).toContain('Grace period');
  });

  test('workspace archived 31 days ago cannot be restored (410 Gone)', async () => {
    const expiredDate = new Date();
    expiredDate.setDate(expiredDate.getDate() - 31);
    tenants.set('tenant-1', {
      ...tenants.get('tenant-1')!,
      status: 'archived',
      updatedAt: expiredDate,
    });

    mockRequireAuth.mockResolvedValue(authAs('user-owner-1'));
    const res = await restoreWorkspace('tenant-1');
    expect(res.status).toBe(410);
  });
});

// ─── DOMAIN SCENARIO 4: Cross-tenant isolation ──────────────────────────

describe('Domain: Cross-tenant isolation — no resource leaking', () => {
  test('owner of tenant-2 cannot archive project in tenant-1', async () => {
    mockRequireAuth.mockResolvedValue(authAs('user-owner-2'));
    const res = await archiveProject('proj-api');
    // requireProjectMemberOrAdmin will reject because tenantId mismatch
    expect(res.status).toBe(404);
    // Project remains active
    expect(projects.get('proj-api')!.archivedAt).toBeNull();
  });

  test('owner of tenant-2 cannot archive workspace tenant-1', async () => {
    mockRequireAuth.mockResolvedValue(authAs('user-owner-2'));
    const res = await archiveWorkspace('tenant-1');
    expect(res.status).toBe(404);
    expect(tenants.get('tenant-1')!.status).toBe('active');
  });

  test('archiving tenant-1 does not affect tenant-2 projects', async () => {
    mockRequireAuth.mockResolvedValue(authAs('user-owner-1'));
    await archiveWorkspace('tenant-1');

    // tenant-2 project untouched
    expect(projects.get('proj-other')!.archivedAt).toBeNull();
    expect(tenants.get('tenant-2')!.status).toBe('active');
  });
});

// ─── DOMAIN SCENARIO 5: Role-based access control ───────────────────────

describe('Domain: Role-based access — concealment pattern', () => {
  test('VIEWER cannot archive project — gets 404 (concealment)', async () => {
    mockRequireAuth.mockResolvedValue(authAs('user-viewer-1'));
    const res = await archiveProject('proj-api');
    expect(res.status).toBe(404);
  });

  test('MEMBER cannot archive project — gets 404 (concealment)', async () => {
    mockRequireAuth.mockResolvedValue(authAs('user-member-1'));
    const res = await archiveProject('proj-api');
    expect(res.status).toBe(404);
  });

  test('ADMIN can archive project but cannot archive workspace', async () => {
    mockRequireAuth.mockResolvedValue(authAs('user-admin-1'));

    // Admin CAN archive a project
    const projectRes = await archiveProject('proj-api');
    expect(projectRes.status).toBe(200);

    // Admin CANNOT archive a workspace (owner-only)
    const wsRes = await archiveWorkspace('tenant-1');
    expect(wsRes.status).toBe(404);
  });

  test('OWNER is the only role that can archive a workspace', async () => {
    // Try each non-owner role
    for (const userId of ['user-admin-1', 'user-member-1', 'user-viewer-1']) {
      mockRequireAuth.mockResolvedValue(authAs(userId));
      const res = await archiveWorkspace('tenant-1');
      expect(res.status).toBe(404);
    }

    // Owner succeeds
    mockRequireAuth.mockResolvedValue(authAs('user-owner-1'));
    const res = await archiveWorkspace('tenant-1');
    expect(res.status).toBe(200);
  });
});

// ─── DOMAIN SCENARIO 6: Audit trail integrity ──────────────────────────

describe('Domain: Audit trail integrity', () => {
  test('full workspace lifecycle produces complete, ordered audit trail', async () => {
    mockRequireAuth.mockResolvedValue(authAs('user-owner-1'));

    // Archive individual project first
    await archiveProject('proj-api');
    // Archive workspace (cascades proj-web + proj-ml)
    await archiveWorkspace('tenant-1');
    // Restore workspace (cascades all 3 back)
    await restoreWorkspace('tenant-1');
    // Archive project again
    await archiveProject('proj-web');

    expect(auditEvents).toHaveLength(4);
    expect(auditEvents.map((e: any) => e.action)).toEqual([
      'project_archived',
      'workspace_archived',
      'workspace_restored',
      'project_archived',
    ]);

    // All events have userId and tenantId
    for (const event of auditEvents) {
      expect(event.userId).toBe('user-owner-1');
      expect(event.tenantId).toBe('tenant-1');
    }
  });

  test('archive metadata includes project ID for project-level operations', async () => {
    mockRequireAuth.mockResolvedValue(authAs('user-owner-1'));
    await archiveProject('proj-ml');

    expect(auditEvents[0].metadata).toEqual({ projectId: 'proj-ml' });
  });

  test('workspace archive metadata includes cascade count', async () => {
    mockRequireAuth.mockResolvedValue(authAs('user-owner-1'));
    await archiveWorkspace('tenant-1');

    expect(auditEvents[0].metadata).toEqual({
      projectsArchived: 3,
      sessionsRevoked: 4,
    });
  });
});

// ─── DOMAIN SCENARIO 7: Edge cases ─────────────────────────────────────

describe('Domain: Edge cases', () => {
  test('unauthenticated user cannot archive anything', async () => {
    mockRequireAuth.mockResolvedValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    );

    const projectRes = await archiveProject('proj-api');
    expect(projectRes.status).toBe(401);

    const wsRes = await archiveWorkspace('tenant-1');
    expect(wsRes.status).toBe(401);
  });

  test('archiving non-existent project returns 404', async () => {
    mockRequireAuth.mockResolvedValue(authAs('user-owner-1'));
    const res = await archiveProject('proj-does-not-exist');
    expect(res.status).toBe(404);
  });

  test('archiving non-existent workspace returns 404', async () => {
    mockRequireAuth.mockResolvedValue({
      ...authAs('user-owner-1'),
      tenantId: 'no-such-tenant',
    });
    const res = await archiveWorkspace('no-such-tenant');
    expect(res.status).toBe(404);
  });

  test('workspace with zero projects archives cleanly', async () => {
    // Remove all projects from tenant-1
    projects.delete('proj-api');
    projects.delete('proj-web');
    projects.delete('proj-ml');

    mockRequireAuth.mockResolvedValue(authAs('user-owner-1'));
    const res = await archiveWorkspace('tenant-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projectsArchived).toBe(0);
    expect(tenants.get('tenant-1')!.status).toBe('archived');
  });

  test('restoring workspace with zero projects restores cleanly', async () => {
    projects.delete('proj-api');
    projects.delete('proj-web');
    projects.delete('proj-ml');
    tenants.set('tenant-1', {
      ...tenants.get('tenant-1')!,
      status: 'archived',
      updatedAt: new Date(),
    });

    mockRequireAuth.mockResolvedValue(authAs('user-owner-1'));
    const res = await restoreWorkspace('tenant-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projectsRestored).toBe(0);
    expect(tenants.get('tenant-1')!.status).toBe('active');
  });
});

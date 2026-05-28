/**
 * Soft delete (archive/restore) API — behavioral tests
 *
 * Tests project archive/restore, workspace archive/restore,
 * cascade behavior, grace period, and permission gating.
 * Auth and DB are mocked at the boundary.
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
      [...tenantMembers.values()]
        .filter((member) => member.tenantId === tenantId)
        .map((member) => ({ ...member, status: member.status ?? 'active' })),
    );
  }),
  archiveWorkspace: vi.fn((id: string, userId: string) => {
    const t = tenants.get(id);
    if (!t || t.status === 'archived') return Promise.resolve(null);
    const updated = { ...t, status: 'archived', updatedAt: new Date() };
    tenants.set(id, updated);
    // Cascade: archive all active projects
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
    // Cascade: restore all archived projects
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
  revokeAllUserTokens: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

// Mock project-access for project routes
vi.mock('@/lib/project-access', () => ({
  isAccessError: (r: unknown) => r instanceof NextResponse,
  requireProjectAccess: vi.fn(),
  hasProjectMembership: vi.fn(),
}));

vi.mock('@/lib/require-project-member-or-admin', () => {
  return {
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
  };
});

// ─── Helpers ────────────────────────────────────────────────────────────

function req(url: string, method = 'POST'): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost'), { method });
}

function authUser(overrides: Partial<any> = {}) {
  return {
    id: 'user-owner',
    email: 'owner@test.com',
    tenantId: 'tenant-1',
    role: 'OWNER',
    permissions: [],
    ...overrides,
  };
}

// ─── Setup ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  projects.clear();
  tenants.clear();
  tenantMembers.clear();
  auditEvents.length = 0;

  // Seed
  tenants.set('tenant-1', {
    id: 'tenant-1',
    _id: 'tenant-1',
    name: 'Test Workspace',
    slug: 'test-ws',
    status: 'active',
    ownerId: 'user-owner',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  });

  tenantMembers.set(memberKey('tenant-1', 'user-owner'), {
    tenantId: 'tenant-1',
    userId: 'user-owner',
    role: 'OWNER',
    status: 'active',
  });
  tenantMembers.set(memberKey('tenant-1', 'user-admin'), {
    tenantId: 'tenant-1',
    userId: 'user-admin',
    role: 'ADMIN',
    status: 'active',
  });
  tenantMembers.set(memberKey('tenant-1', 'user-member'), {
    tenantId: 'tenant-1',
    userId: 'user-member',
    role: 'MEMBER',
    status: 'active',
  });

  projects.set('proj-1', {
    id: 'proj-1',
    _id: 'proj-1',
    name: 'Project One',
    slug: 'project-one',
    tenantId: 'tenant-1',
    ownerId: 'user-owner',
    archivedAt: null,
    archivedBy: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  });
  projects.set('proj-2', {
    id: 'proj-2',
    _id: 'proj-2',
    name: 'Project Two',
    slug: 'project-two',
    tenantId: 'tenant-1',
    ownerId: 'user-owner',
    archivedAt: null,
    archivedBy: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  });
});

// ─── PROJECT ARCHIVE ────────────────────────────────────────────────────

describe('POST /api/projects/:id/archive', () => {
  async function callArchive(projectId: string) {
    const { POST } = await import('../../app/api/projects/[id]/archive/route');
    return POST(req(`http://localhost/api/projects/${projectId}/archive`), {
      params: Promise.resolve({ id: projectId }),
    });
  }

  test('owner can archive a project', async () => {
    mockRequireAuth.mockResolvedValue(authUser());
    const res = await callArchive('proj-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.archivedAt).toBeTruthy();
    // Verify project state
    expect(projects.get('proj-1')!.archivedAt).not.toBeNull();
    expect(projects.get('proj-1')!.archivedBy).toBe('user-owner');
  });

  test('admin can archive a project', async () => {
    mockRequireAuth.mockResolvedValue(authUser({ id: 'user-admin', role: 'ADMIN' }));
    const res = await callArchive('proj-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test('member cannot archive a project — returns 404', async () => {
    mockRequireAuth.mockResolvedValue(authUser({ id: 'user-member', role: 'MEMBER' }));
    const res = await callArchive('proj-1');
    expect(res.status).toBe(404);
  });

  test('already archived project returns 400', async () => {
    projects.set('proj-1', {
      ...projects.get('proj-1')!,
      archivedAt: new Date(),
      archivedBy: 'user-owner',
    });
    mockRequireAuth.mockResolvedValue(authUser());
    const res = await callArchive('proj-1');
    expect(res.status).toBe(400);
  });

  test('non-existent project returns 404', async () => {
    mockRequireAuth.mockResolvedValue(authUser());
    const res = await callArchive('no-such-project');
    expect(res.status).toBe(404);
  });

  test('audit event is logged on archive', async () => {
    mockRequireAuth.mockResolvedValue(authUser());
    await callArchive('proj-1');
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].action).toBe('project_archived');
    expect(auditEvents[0].metadata.projectId).toBe('proj-1');
  });

  test('unauthenticated request is rejected', async () => {
    mockRequireAuth.mockResolvedValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    );
    const res = await callArchive('proj-1');
    expect(res.status).toBe(401);
  });
});

// ─── PROJECT RESTORE ────────────────────────────────────────────────────

describe('POST /api/projects/:id/restore', () => {
  async function callRestore(projectId: string) {
    const { POST } = await import('../../app/api/projects/[id]/restore/route');
    return POST(req(`http://localhost/api/projects/${projectId}/restore`), {
      params: Promise.resolve({ id: projectId }),
    });
  }

  test('owner can restore an archived project', async () => {
    projects.set('proj-1', {
      ...projects.get('proj-1')!,
      archivedAt: new Date(),
      archivedBy: 'user-owner',
    });
    mockRequireAuth.mockResolvedValue(authUser());
    const res = await callRestore('proj-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(projects.get('proj-1')!.archivedAt).toBeNull();
  });

  test('restoring a non-archived project returns 400', async () => {
    mockRequireAuth.mockResolvedValue(authUser());
    const res = await callRestore('proj-1');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors[0].msg).toContain('not archived');
  });

  test('grace period expired returns 410', async () => {
    const expiredDate = new Date();
    expiredDate.setDate(expiredDate.getDate() - 31);
    projects.set('proj-1', {
      ...projects.get('proj-1')!,
      archivedAt: expiredDate,
      archivedBy: 'user-owner',
    });
    mockRequireAuth.mockResolvedValue(authUser());
    const res = await callRestore('proj-1');
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.errors[0].msg).toContain('Grace period');
  });

  test('within grace period (day 29) succeeds', async () => {
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 29);
    projects.set('proj-1', {
      ...projects.get('proj-1')!,
      archivedAt: recentDate,
      archivedBy: 'user-owner',
    });
    mockRequireAuth.mockResolvedValue(authUser());
    const res = await callRestore('proj-1');
    expect(res.status).toBe(200);
  });

  test('member cannot restore — returns 404', async () => {
    projects.set('proj-1', {
      ...projects.get('proj-1')!,
      archivedAt: new Date(),
      archivedBy: 'user-owner',
    });
    mockRequireAuth.mockResolvedValue(authUser({ id: 'user-member', role: 'MEMBER' }));
    const res = await callRestore('proj-1');
    expect(res.status).toBe(404);
  });

  test('audit event is logged on restore', async () => {
    projects.set('proj-1', {
      ...projects.get('proj-1')!,
      archivedAt: new Date(),
      archivedBy: 'user-owner',
    });
    mockRequireAuth.mockResolvedValue(authUser());
    await callRestore('proj-1');
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].action).toBe('project_restored');
  });
});

// ─── WORKSPACE ARCHIVE ──────────────────────────────────────────────────

describe('POST /api/workspaces/:tenantId/archive', () => {
  async function callArchiveWS(tenantId: string) {
    const { POST } = await import('../../app/api/workspaces/[tenantId]/archive/route');
    return POST(req(`http://localhost/api/workspaces/${tenantId}/archive`), {
      params: Promise.resolve({ tenantId }),
    });
  }

  test('owner can archive a workspace, cascading to projects', async () => {
    mockRequireAuth.mockResolvedValue(authUser());
    const res = await callArchiveWS('tenant-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.projectsArchived).toBe(2);
    // Both projects should now be archived
    expect(projects.get('proj-1')!.archivedAt).not.toBeNull();
    expect(projects.get('proj-2')!.archivedAt).not.toBeNull();
    // Workspace status should be archived
    expect(tenants.get('tenant-1')!.status).toBe('archived');
  });

  test('admin cannot archive workspace — owner only', async () => {
    mockRequireAuth.mockResolvedValue(authUser({ id: 'user-admin', role: 'ADMIN' }));
    const res = await callArchiveWS('tenant-1');
    expect(res.status).toBe(404);
  });

  test('member cannot archive workspace — returns 404', async () => {
    mockRequireAuth.mockResolvedValue(authUser({ id: 'user-member', role: 'MEMBER' }));
    const res = await callArchiveWS('tenant-1');
    expect(res.status).toBe(404);
  });

  test('already archived workspace returns 400', async () => {
    tenants.set('tenant-1', { ...tenants.get('tenant-1')!, status: 'archived' });
    mockRequireAuth.mockResolvedValue(authUser());
    const res = await callArchiveWS('tenant-1');
    expect(res.status).toBe(400);
  });

  test('cross-tenant request returns 404', async () => {
    mockRequireAuth.mockResolvedValue(authUser({ tenantId: 'other-tenant' }));
    const res = await callArchiveWS('tenant-1');
    expect(res.status).toBe(404);
  });

  test('audit event logged with project count', async () => {
    mockRequireAuth.mockResolvedValue(authUser());
    await callArchiveWS('tenant-1');
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].action).toBe('workspace_archived');
    expect(auditEvents[0].metadata.projectsArchived).toBe(2);
  });
});

// ─── WORKSPACE RESTORE ──────────────────────────────────────────────────

describe('POST /api/workspaces/:tenantId/restore', () => {
  async function callRestoreWS(tenantId: string) {
    const { POST } = await import('../../app/api/workspaces/[tenantId]/restore/route');
    return POST(req(`http://localhost/api/workspaces/${tenantId}/restore`), {
      params: Promise.resolve({ tenantId }),
    });
  }

  test('owner can restore an archived workspace, cascading to projects', async () => {
    tenants.set('tenant-1', {
      ...tenants.get('tenant-1')!,
      status: 'archived',
      updatedAt: new Date(),
    });
    projects.set('proj-1', {
      ...projects.get('proj-1')!,
      archivedAt: new Date(),
      archivedBy: 'user-owner',
    });
    projects.set('proj-2', {
      ...projects.get('proj-2')!,
      archivedAt: new Date(),
      archivedBy: 'user-owner',
    });
    mockRequireAuth.mockResolvedValue(authUser());
    const res = await callRestoreWS('tenant-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.projectsRestored).toBe(2);
    expect(tenants.get('tenant-1')!.status).toBe('active');
    expect(projects.get('proj-1')!.archivedAt).toBeNull();
    expect(projects.get('proj-2')!.archivedAt).toBeNull();
  });

  test('restoring a non-archived workspace returns 400', async () => {
    mockRequireAuth.mockResolvedValue(authUser());
    const res = await callRestoreWS('tenant-1');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors[0].msg).toContain('not archived');
  });

  test('grace period expired returns 410', async () => {
    const expiredDate = new Date();
    expiredDate.setDate(expiredDate.getDate() - 31);
    tenants.set('tenant-1', {
      ...tenants.get('tenant-1')!,
      status: 'archived',
      updatedAt: expiredDate,
    });
    mockRequireAuth.mockResolvedValue(authUser());
    const res = await callRestoreWS('tenant-1');
    expect(res.status).toBe(410);
  });

  test('within grace period (day 29) succeeds', async () => {
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 29);
    tenants.set('tenant-1', {
      ...tenants.get('tenant-1')!,
      status: 'archived',
      updatedAt: recentDate,
    });
    projects.set('proj-1', {
      ...projects.get('proj-1')!,
      archivedAt: recentDate,
      archivedBy: 'user-owner',
    });
    mockRequireAuth.mockResolvedValue(authUser());
    const res = await callRestoreWS('tenant-1');
    expect(res.status).toBe(200);
    expect(tenants.get('tenant-1')!.status).toBe('active');
  });

  test('admin cannot restore workspace — owner only', async () => {
    tenants.set('tenant-1', {
      ...tenants.get('tenant-1')!,
      status: 'archived',
      updatedAt: new Date(),
    });
    mockRequireAuth.mockResolvedValue(authUser({ id: 'user-admin', role: 'ADMIN' }));
    const res = await callRestoreWS('tenant-1');
    expect(res.status).toBe(404);
  });

  test('audit event logged with project count', async () => {
    tenants.set('tenant-1', {
      ...tenants.get('tenant-1')!,
      status: 'archived',
      updatedAt: new Date(),
    });
    projects.set('proj-1', {
      ...projects.get('proj-1')!,
      archivedAt: new Date(),
      archivedBy: 'user-owner',
    });
    mockRequireAuth.mockResolvedValue(authUser());
    await callRestoreWS('tenant-1');
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].action).toBe('workspace_restored');
    expect(auditEvents[0].metadata.projectsRestored).toBe(1);
  });
});

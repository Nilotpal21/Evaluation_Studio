/**
 * Custom role CRUD API — behavioral tests
 *
 * Tests REAL permission validation (validateCustomRolePermissions),
 * REAL ceiling enforcement (getPermissionCeiling), and REAL Zod schemas.
 * Only DB and auth JWT verification are mocked.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import {
  validateCustomRolePermissions,
  VALID_CUSTOM_ROLE_PERMISSIONS,
} from '@agent-platform/shared/rbac';

// ─── External boundary mocks ────────────────────────────────────────────

const { mockRequireAuth } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  requireAuth: mockRequireAuth,
  isAuthError: (r: unknown) => r instanceof NextResponse,
}));

vi.mock('@/lib/ensure-db', () => ({ ensureDb: vi.fn() }));

// ─── DB mock: in-memory store that behaves like Mongoose ─────────────────

const db = {
  roles: new Map<string, any>(),
  tenantMembers: new Map<string, any>(),
  projectMembers: [] as any[],
  idCounter: 0,
};

vi.mock('@/repos/workspace-repo', () => ({
  findTenantMember: (tenantId: string, userId: string) => {
    return Promise.resolve(db.tenantMembers.get(`${tenantId}:${userId}`) ?? null);
  },
}));

vi.mock('@agent-platform/database/models', () => ({
  RoleDefinition: {
    find: (filter: any) => ({
      lean: () =>
        Promise.resolve(
          [...db.roles.values()].filter(
            (r) =>
              r.tenantId === filter.tenantId &&
              (filter.isSystem === undefined || r.isSystem === filter.isSystem),
          ),
        ),
      sort: () => ({
        lean: () =>
          Promise.resolve(
            [...db.roles.values()].filter(
              (r) =>
                r.tenantId === filter.tenantId &&
                (filter.isSystem === undefined || r.isSystem === filter.isSystem),
            ),
          ),
      }),
    }),
    findOne: (filter: any) => ({
      lean: () => {
        const found = [...db.roles.values()].find(
          (r) => r._id === filter._id && r.tenantId === filter.tenantId,
        );
        return Promise.resolve(found ?? null);
      },
    }),
    findOneAndUpdate: (filter: any, update: any, opts: any) => ({
      lean: () => {
        const found = [...db.roles.values()].find(
          (r) =>
            r._id === filter._id &&
            r.tenantId === filter.tenantId &&
            (filter.isSystem === undefined || r.isSystem === filter.isSystem),
        );
        if (!found) return Promise.resolve(null);
        const updated = { ...found, ...update.$set, updatedAt: new Date() };
        db.roles.set(found._id, updated);
        return Promise.resolve(updated);
      },
    }),
    create: (data: any) => {
      const id = `role-${++db.idCounter}`;
      const doc = { _id: id, ...data, createdAt: new Date(), updatedAt: new Date() };
      db.roles.set(id, doc);
      return Promise.resolve({ toObject: () => doc });
    },
    deleteOne: (filter: any) => {
      const found = [...db.roles.values()].find(
        (r) =>
          r._id === filter._id &&
          r.tenantId === filter.tenantId &&
          (filter.isSystem === undefined || r.isSystem === filter.isSystem),
      );
      if (found) db.roles.delete(found._id);
      return Promise.resolve({ deletedCount: found ? 1 : 0 });
    },
  },
  Project: {
    find: (filter: any) => ({
      lean: () =>
        Promise.resolve(
          [
            { _id: 'p1', tenantId: 'tenant-1' },
            { _id: 'p2', tenantId: 'tenant-2' },
          ].filter((project) => project.tenantId === filter.tenantId),
        ),
    }),
  },
  ProjectMember: {
    updateMany: (filter: any, update: any) => {
      let count = 0;
      for (const pm of db.projectMembers) {
        const matchesFilter = Object.entries(filter).every(([key, value]) => {
          if (
            value &&
            typeof value === 'object' &&
            '$in' in value &&
            Array.isArray((value as { $in: unknown[] }).$in)
          ) {
            return (value as { $in: unknown[] }).$in.includes(pm[key]);
          }
          return pm[key] === value;
        });
        if (matchesFilter) {
          Object.assign(pm, update.$set);
          count++;
        }
      }
      return Promise.resolve({ modifiedCount: count });
    },
  },
}));

// ─── Helpers ─────────────────────────────────────────────────────────────

function authedOwner(tenantId = 'tenant-1') {
  return {
    id: 'owner-1',
    email: 'owner@test.com',
    name: 'Owner',
    tenantId,
    role: 'OWNER',
    permissions: ['*:*'],
  };
}

function authedMember(tenantId = 'tenant-1') {
  return {
    id: 'member-1',
    email: 'member@test.com',
    name: 'Member',
    tenantId,
    role: 'MEMBER',
    permissions: ['agent:read'],
  };
}

function authedAdmin(tenantId = 'tenant-1') {
  return {
    id: 'admin-1',
    email: 'admin@test.com',
    name: 'Admin',
    tenantId,
    role: 'ADMIN',
    permissions: ['tenant:read', 'tenant:manage_members'],
  };
}

function r(method: string, path: string, body?: unknown) {
  const opts: RequestInit = { method };
  if (body) {
    opts.body = JSON.stringify(body);
    opts.headers = { 'content-type': 'application/json' };
  }
  return new NextRequest(`http://localhost${path}`, opts);
}

function pctx(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function seedRole(id: string, name: string, permissions: string[], opts?: Partial<any>) {
  db.roles.set(id, {
    _id: id,
    tenantId: 'tenant-1',
    name,
    description: null,
    isSystem: false,
    permissions,
    parentRoleId: null,
    createdBy: 'owner-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...opts,
  });
}

// ─── Setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.restoreAllMocks();
  db.roles.clear();
  db.tenantMembers.clear();
  db.projectMembers = [];
  db.idCounter = 0;

  mockRequireAuth.mockResolvedValue(authedOwner());
  db.tenantMembers.set('tenant-1:owner-1', {
    _id: 'tm-owner',
    tenantId: 'tenant-1',
    userId: 'owner-1',
    role: 'OWNER',
  });
  db.tenantMembers.set('tenant-1:member-1', {
    _id: 'tm-member',
    tenantId: 'tenant-1',
    userId: 'member-1',
    role: 'MEMBER',
  });
  db.tenantMembers.set('tenant-1:admin-1', {
    _id: 'tm-admin',
    tenantId: 'tenant-1',
    userId: 'admin-1',
    role: 'ADMIN',
  });
});

// ─── Pure domain logic tests (ZERO mocks) ────────────────────────────────

describe('validateCustomRolePermissions (pure function)', () => {
  test('accepts valid explicit permissions', () => {
    const { valid, invalid } = validateCustomRolePermissions(['agent:read', 'tool:write']);
    expect(valid).toBe(true);
    expect(invalid).toEqual([]);
  });

  test('accepts pii reveal only as an explicit permission', () => {
    const { valid, invalid } = validateCustomRolePermissions(['pii:reveal']);
    expect(valid).toBe(true);
    expect(invalid).toEqual([]);
    expect(VALID_CUSTOM_ROLE_PERMISSIONS).toContain('pii:reveal');
  });

  test('rejects wildcard permissions', () => {
    const { valid, invalid } = validateCustomRolePermissions(['*:*', 'agent:read']);
    expect(valid).toBe(false);
    expect(invalid).toContain('*:*');
  });

  test('rejects resource wildcards', () => {
    const { valid, invalid } = validateCustomRolePermissions(['agent:*']);
    expect(valid).toBe(false);
    expect(invalid).toContain('agent:*');
  });

  test('rejects unknown permission strings', () => {
    const { valid, invalid } = validateCustomRolePermissions(['agent:read', 'magic:fly']);
    expect(valid).toBe(false);
    expect(invalid).toContain('magic:fly');
  });

  test('the allowlist has at least 50 permissions', () => {
    expect(VALID_CUSTOM_ROLE_PERMISSIONS.length).toBeGreaterThan(50);
  });
});

// ─── GET — List roles ───────────────────────────────────────────────────

describe('GET /api/workspaces/:tenantId/roles', () => {
  test('returns only custom (non-system) roles', async () => {
    seedRole('r1', 'Analyst', ['agent:read', 'analytics:read']);
    seedRole('r2', 'System Admin', ['*:*'], { isSystem: true });

    const { GET } = await import('../../app/api/workspaces/[tenantId]/roles/route');
    const res = await GET(
      r('GET', '/api/workspaces/tenant-1/roles'),
      pctx({ tenantId: 'tenant-1' }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.roles).toHaveLength(1);
    expect(json.roles[0].name).toBe('Analyst');
  });

  test('returns 404 for members without workspace member-management permission', async () => {
    seedRole('r1', 'Analyst', ['agent:read']);

    mockRequireAuth.mockResolvedValue(authedMember());
    const { GET } = await import('../../app/api/workspaces/[tenantId]/roles/route');
    const res = await GET(
      r('GET', '/api/workspaces/tenant-1/roles'),
      pctx({ tenantId: 'tenant-1' }),
    );

    expect(res.status).toBe(404);
  });

  test('does not leak roles from another tenant', async () => {
    seedRole('r1', 'Analyst', ['agent:read']);

    mockRequireAuth.mockResolvedValue(authedOwner('tenant-2'));
    const { GET } = await import('../../app/api/workspaces/[tenantId]/roles/route');
    const res = await GET(
      r('GET', '/api/workspaces/tenant-1/roles'),
      pctx({ tenantId: 'tenant-1' }),
    );
    expect(res.status).toBe(404);
  });
});

// ─── POST — Create role ─────────────────────────────────────────────────

describe('POST /api/workspaces/:tenantId/roles', () => {
  test('creates a role with valid permissions', async () => {
    const { POST } = await import('../../app/api/workspaces/[tenantId]/roles/route');
    const res = await POST(
      r('POST', '/api/workspaces/tenant-1/roles', {
        name: 'Analyst',
        permissions: ['agent:read', 'analytics:read', 'session:read'],
      }),
      pctx({ tenantId: 'tenant-1' }),
    );
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.role.name).toBe('Analyst');
    expect(json.role.permissions).toContain('analytics:read');
    expect(json.role.createdBy).toBe('owner-1');
    expect(db.roles.size).toBe(1);
  });

  test('rejects role with wildcard permissions (real validation)', async () => {
    const { POST } = await import('../../app/api/workspaces/[tenantId]/roles/route');
    const res = await POST(
      r('POST', '/api/workspaces/tenant-1/roles', {
        name: 'God Mode',
        permissions: ['*:*'],
      }),
      pctx({ tenantId: 'tenant-1' }),
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.errors[0].msg).toContain('*:*');
    expect(db.roles.size).toBe(0);
  });

  test('rejects role with unknown permissions (real validation)', async () => {
    const { POST } = await import('../../app/api/workspaces/[tenantId]/roles/route');
    const res = await POST(
      r('POST', '/api/workspaces/tenant-1/roles', {
        name: 'Hacker',
        permissions: ['agent:read', 'nuke:launch'],
      }),
      pctx({ tenantId: 'tenant-1' }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.errors[0].msg).toContain('nuke:launch');
  });

  test('Zod rejects empty permissions array', async () => {
    const { POST } = await import('../../app/api/workspaces/[tenantId]/roles/route');
    const res = await POST(
      r('POST', '/api/workspaces/tenant-1/roles', {
        name: 'Empty',
        permissions: [],
      }),
      pctx({ tenantId: 'tenant-1' }),
    );
    expect(res.status).toBe(400);
  });

  test('Zod rejects missing name', async () => {
    const { POST } = await import('../../app/api/workspaces/[tenantId]/roles/route');
    const res = await POST(
      r('POST', '/api/workspaces/tenant-1/roles', {
        permissions: ['agent:read'],
      }),
      pctx({ tenantId: 'tenant-1' }),
    );
    expect(res.status).toBe(400);
  });

  test('non-admin member cannot create roles (concealed 404)', async () => {
    mockRequireAuth.mockResolvedValue(authedMember());

    const { POST } = await import('../../app/api/workspaces/[tenantId]/roles/route');
    const res = await POST(
      r('POST', '/api/workspaces/tenant-1/roles', {
        name: 'Sneaky',
        permissions: ['agent:read'],
      }),
      pctx({ tenantId: 'tenant-1' }),
    );
    expect(res.status).toBe(404);
  });

  test('rejects inherited parent permissions above the creator ceiling', async () => {
    mockRequireAuth.mockResolvedValue(authedAdmin());
    seedRole('privacy-parent', 'Privacy Parent', ['pii:reveal']);

    const { POST } = await import('../../app/api/workspaces/[tenantId]/roles/route');
    const res = await POST(
      r('POST', '/api/workspaces/tenant-1/roles', {
        name: 'Inherited Privacy',
        permissions: ['agent:read'],
        parentRoleId: 'privacy-parent',
      }),
      pctx({ tenantId: 'tenant-1' }),
    );

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.errors[0].msg).toContain('pii:reveal');
  });
});

// ─── PATCH — Update role ────────────────────────────────────────────────

describe('PATCH /api/workspaces/:tenantId/roles/:roleId', () => {
  test('updates role name and permissions', async () => {
    seedRole('r1', 'Analyst', ['agent:read']);

    const { PATCH } = await import('../../app/api/workspaces/[tenantId]/roles/[roleId]/route');
    const res = await PATCH(
      r('PATCH', '/api/workspaces/tenant-1/roles/r1', {
        name: 'Senior Analyst',
        permissions: ['agent:read', 'analytics:read', 'session:read'],
      }),
      pctx({ tenantId: 'tenant-1', roleId: 'r1' }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.role.name).toBe('Senior Analyst');
    expect(json.role.permissions).toContain('analytics:read');
    // Verify DB was mutated
    expect(db.roles.get('r1')?.name).toBe('Senior Analyst');
  });

  test('cannot modify system roles', async () => {
    seedRole('sys-admin', 'System Admin', ['*:*'], { isSystem: true });

    const { PATCH } = await import('../../app/api/workspaces/[tenantId]/roles/[roleId]/route');
    const res = await PATCH(
      r('PATCH', '/api/workspaces/tenant-1/roles/sys-admin', {
        name: 'Pwned',
      }),
      pctx({ tenantId: 'tenant-1', roleId: 'sys-admin' }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.errors[0].msg).toContain('system');
  });

  test('rejects update with wildcard permissions (real validation)', async () => {
    seedRole('r1', 'Analyst', ['agent:read']);

    const { PATCH } = await import('../../app/api/workspaces/[tenantId]/roles/[roleId]/route');
    const res = await PATCH(
      r('PATCH', '/api/workspaces/tenant-1/roles/r1', {
        permissions: ['agent:*'],
      }),
      pctx({ tenantId: 'tenant-1', roleId: 'r1' }),
    );
    expect(res.status).toBe(400);
  });

  test('returns 404 for nonexistent role', async () => {
    const { PATCH } = await import('../../app/api/workspaces/[tenantId]/roles/[roleId]/route');
    const res = await PATCH(
      r('PATCH', '/api/workspaces/tenant-1/roles/nonexistent', { name: 'X' }),
      pctx({ tenantId: 'tenant-1', roleId: 'nonexistent' }),
    );
    expect(res.status).toBe(404);
  });

  test('rejects parentRoleId updates that inherit permissions above the creator ceiling', async () => {
    mockRequireAuth.mockResolvedValue(authedAdmin());
    seedRole('privacy-parent', 'Privacy Parent', ['pii:reveal']);
    seedRole('r1', 'Analyst', ['agent:read']);

    const { PATCH } = await import('../../app/api/workspaces/[tenantId]/roles/[roleId]/route');
    const res = await PATCH(
      r('PATCH', '/api/workspaces/tenant-1/roles/r1', {
        parentRoleId: 'privacy-parent',
      }),
      pctx({ tenantId: 'tenant-1', roleId: 'r1' }),
    );

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.errors[0].msg).toContain('pii:reveal');
  });
});

// ─── DELETE — Delete role ───────────────────────────────────────────────

describe('DELETE /api/workspaces/:tenantId/roles/:roleId', () => {
  test('deletes a custom role and cascades to project members', async () => {
    seedRole('r1', 'Analyst', ['agent:read']);
    db.projectMembers.push(
      { _id: 'pm-1', projectId: 'p1', userId: 'u1', role: 'custom', customRoleId: 'r1' },
      { _id: 'pm-2', projectId: 'p1', userId: 'u2', role: 'developer', customRoleId: null },
    );

    const { DELETE } = await import('../../app/api/workspaces/[tenantId]/roles/[roleId]/route');
    const res = await DELETE(
      r('DELETE', '/api/workspaces/tenant-1/roles/r1'),
      pctx({ tenantId: 'tenant-1', roleId: 'r1' }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    // Role removed from DB
    expect(db.roles.has('r1')).toBe(false);
    // Project member was cascaded to viewer fallback
    expect(db.projectMembers[0].role).toBe('viewer');
    expect(db.projectMembers[0].customRoleId).toBeNull();
    // Other member untouched
    expect(db.projectMembers[1].role).toBe('developer');
  });

  test('cannot delete system roles', async () => {
    seedRole('sys-1', 'System Role', ['*:*'], { isSystem: true });

    const { DELETE } = await import('../../app/api/workspaces/[tenantId]/roles/[roleId]/route');
    const res = await DELETE(
      r('DELETE', '/api/workspaces/tenant-1/roles/sys-1'),
      pctx({ tenantId: 'tenant-1', roleId: 'sys-1' }),
    );
    expect(res.status).toBe(400);
    // System role still in DB
    expect(db.roles.has('sys-1')).toBe(true);
  });

  test('returns 404 for nonexistent role', async () => {
    const { DELETE } = await import('../../app/api/workspaces/[tenantId]/roles/[roleId]/route');
    const res = await DELETE(
      r('DELETE', '/api/workspaces/tenant-1/roles/ghost'),
      pctx({ tenantId: 'tenant-1', roleId: 'ghost' }),
    );
    expect(res.status).toBe(404);
  });
});

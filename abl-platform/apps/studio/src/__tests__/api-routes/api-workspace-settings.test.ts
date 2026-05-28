/**
 * Workspace settings API — behavioral tests
 *
 * Tests GET/PATCH for workspace settings, admin gating, slug uniqueness,
 * and Zod validation. Auth and DB are mocked at the boundary.
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

// Forward api-response to real-ish implementations
vi.mock('@/lib/api-response', () => {
  const ErrorCode = {
    NOT_FOUND: 'NOT_FOUND',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
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
    handleApiError: (_error: unknown, _context: string) =>
      NextResponse.json(
        { success: false, errors: [{ msg: 'Internal server error', code: 'INTERNAL_ERROR' }] },
        { status: 500 },
      ),
  };
});

// ─── In-memory DB ───────────────────────────────────────────────────────

const tenants = new Map<string, any>();
const tenantMembers = new Map<string, any>();

function memberKey(tenantId: string, userId: string) {
  return `${tenantId}:${userId}`;
}

vi.mock('@/repos/workspace-repo', () => ({
  findTenantById: vi.fn((id: string) => {
    const t = tenants.get(id);
    return Promise.resolve(t || null);
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
  findTenantMember: vi.fn((tenantId: string, userId: string) => {
    return Promise.resolve(tenantMembers.get(memberKey(tenantId, userId)) || null);
  }),
}));

// ─── Helpers ────────────────────────────────────────────────────────────

function makeRequest(path: string, opts?: RequestInit): NextRequest {
  return new NextRequest(new URL(path, 'http://localhost'), opts);
}

const params = Promise.resolve({ tenantId: 'tenant-1' });

function seedTenant(overrides: Partial<any> = {}) {
  const t = {
    id: 'tenant-1',
    name: 'Acme Corp',
    slug: 'acme-corp',
    status: 'active',
    ownerId: 'user-1',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
  tenants.set(t.id, t);
  return t;
}

function seedMember(tenantId: string, userId: string, role: string) {
  const m = { tenantId, userId, role };
  tenantMembers.set(memberKey(tenantId, userId), m);
  return m;
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('Workspace Settings API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenants.clear();
    tenantMembers.clear();
  });

  describe('GET /api/workspaces/:tenantId/settings', () => {
    test('returns 401 when not authenticated', async () => {
      mockRequireAuth.mockResolvedValue(NextResponse.json({ success: false }, { status: 401 }));

      const { GET } = await import('../../app/api/workspaces/[tenantId]/settings/route');
      const res = await GET(makeRequest('/api/workspaces/tenant-1/settings'), { params });

      expect(res.status).toBe(401);
    });

    test('returns 404 for non-admin member (concealment)', async () => {
      mockRequireAuth.mockResolvedValue({
        id: 'user-2',
        email: 'b@b.com',
        name: 'Bob',
        tenantId: 'tenant-1',
        role: 'MEMBER',
        permissions: [],
      });

      seedTenant();
      seedMember('tenant-1', 'user-2', 'MEMBER');

      const { GET } = await import('../../app/api/workspaces/[tenantId]/settings/route');
      const res = await GET(makeRequest('/api/workspaces/tenant-1/settings'), { params });

      expect(res.status).toBe(404);
    });

    test('returns workspace for ADMIN', async () => {
      mockRequireAuth.mockResolvedValue({
        id: 'user-1',
        email: 'a@b.com',
        name: 'Admin',
        tenantId: 'tenant-1',
        role: 'ADMIN',
        permissions: [],
      });

      seedTenant();
      seedMember('tenant-1', 'user-1', 'ADMIN');

      const { GET } = await import('../../app/api/workspaces/[tenantId]/settings/route');
      const res = await GET(makeRequest('/api/workspaces/tenant-1/settings'), { params });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.workspace.name).toBe('Acme Corp');
      expect(body.workspace.slug).toBe('acme-corp');
      expect(body.workspace.status).toBe('active');
    });

    test('returns workspace for OWNER', async () => {
      mockRequireAuth.mockResolvedValue({
        id: 'user-1',
        email: 'a@b.com',
        name: 'Owner',
        tenantId: 'tenant-1',
        role: 'OWNER',
        permissions: [],
      });

      seedTenant();
      seedMember('tenant-1', 'user-1', 'OWNER');

      const { GET } = await import('../../app/api/workspaces/[tenantId]/settings/route');
      const res = await GET(makeRequest('/api/workspaces/tenant-1/settings'), { params });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    test('returns 404 for cross-tenant access', async () => {
      mockRequireAuth.mockResolvedValue({
        id: 'user-1',
        email: 'a@b.com',
        name: 'Admin',
        tenantId: 'tenant-2', // different tenant
        role: 'ADMIN',
        permissions: [],
      });

      seedTenant();
      seedMember('tenant-1', 'user-1', 'ADMIN');

      const { GET } = await import('../../app/api/workspaces/[tenantId]/settings/route');
      const res = await GET(makeRequest('/api/workspaces/tenant-1/settings'), { params });

      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/workspaces/:tenantId/settings', () => {
    test('updates workspace name', async () => {
      mockRequireAuth.mockResolvedValue({
        id: 'user-1',
        email: 'a@b.com',
        name: 'Admin',
        tenantId: 'tenant-1',
        role: 'ADMIN',
        permissions: [],
      });

      seedTenant();
      seedMember('tenant-1', 'user-1', 'ADMIN');

      const { PATCH } = await import('../../app/api/workspaces/[tenantId]/settings/route');
      const res = await PATCH(
        makeRequest('/api/workspaces/tenant-1/settings', {
          method: 'PATCH',
          body: JSON.stringify({ name: 'New Corp' }),
          headers: { 'Content-Type': 'application/json' },
        }),
        { params },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.workspace.name).toBe('New Corp');
      expect(body.workspace.slug).toBe('acme-corp'); // unchanged
    });

    test('updates workspace slug', async () => {
      mockRequireAuth.mockResolvedValue({
        id: 'user-1',
        email: 'a@b.com',
        name: 'Admin',
        tenantId: 'tenant-1',
        role: 'ADMIN',
        permissions: [],
      });

      seedTenant();
      seedMember('tenant-1', 'user-1', 'ADMIN');

      const { PATCH } = await import('../../app/api/workspaces/[tenantId]/settings/route');
      const res = await PATCH(
        makeRequest('/api/workspaces/tenant-1/settings', {
          method: 'PATCH',
          body: JSON.stringify({ slug: 'new-corp' }),
          headers: { 'Content-Type': 'application/json' },
        }),
        { params },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.workspace.slug).toBe('new-corp');
    });

    test('rejects slug conflict', async () => {
      mockRequireAuth.mockResolvedValue({
        id: 'user-1',
        email: 'a@b.com',
        name: 'Admin',
        tenantId: 'tenant-1',
        role: 'ADMIN',
        permissions: [],
      });

      seedTenant();
      seedTenant({ id: 'tenant-2', slug: 'taken-slug' }); // existing tenant with target slug
      seedMember('tenant-1', 'user-1', 'ADMIN');

      const { PATCH } = await import('../../app/api/workspaces/[tenantId]/settings/route');
      const res = await PATCH(
        makeRequest('/api/workspaces/tenant-1/settings', {
          method: 'PATCH',
          body: JSON.stringify({ slug: 'taken-slug' }),
          headers: { 'Content-Type': 'application/json' },
        }),
        { params },
      );

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.errors[0].code).toBe('NAME_CONFLICT');
    });

    test('rejects invalid slug format', async () => {
      mockRequireAuth.mockResolvedValue({
        id: 'user-1',
        email: 'a@b.com',
        name: 'Admin',
        tenantId: 'tenant-1',
        role: 'ADMIN',
        permissions: [],
      });

      seedTenant();
      seedMember('tenant-1', 'user-1', 'ADMIN');

      const { PATCH } = await import('../../app/api/workspaces/[tenantId]/settings/route');
      const res = await PATCH(
        makeRequest('/api/workspaces/tenant-1/settings', {
          method: 'PATCH',
          body: JSON.stringify({ slug: 'INVALID SLUG!' }),
          headers: { 'Content-Type': 'application/json' },
        }),
        { params },
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    test('rejects empty body', async () => {
      mockRequireAuth.mockResolvedValue({
        id: 'user-1',
        email: 'a@b.com',
        name: 'Admin',
        tenantId: 'tenant-1',
        role: 'ADMIN',
        permissions: [],
      });

      seedTenant();
      seedMember('tenant-1', 'user-1', 'ADMIN');

      const { PATCH } = await import('../../app/api/workspaces/[tenantId]/settings/route');
      const res = await PATCH(
        makeRequest('/api/workspaces/tenant-1/settings', {
          method: 'PATCH',
          body: JSON.stringify({}),
          headers: { 'Content-Type': 'application/json' },
        }),
        { params },
      );

      expect(res.status).toBe(400);
    });

    test('non-admin cannot update', async () => {
      mockRequireAuth.mockResolvedValue({
        id: 'user-2',
        email: 'b@b.com',
        name: 'Bob',
        tenantId: 'tenant-1',
        role: 'MEMBER',
        permissions: [],
      });

      seedTenant();
      seedMember('tenant-1', 'user-2', 'MEMBER');

      const { PATCH } = await import('../../app/api/workspaces/[tenantId]/settings/route');
      const res = await PATCH(
        makeRequest('/api/workspaces/tenant-1/settings', {
          method: 'PATCH',
          body: JSON.stringify({ name: 'Hacked' }),
          headers: { 'Content-Type': 'application/json' },
        }),
        { params },
      );

      expect(res.status).toBe(404);
    });

    test('allows same slug if owned by same tenant', async () => {
      mockRequireAuth.mockResolvedValue({
        id: 'user-1',
        email: 'a@b.com',
        name: 'Admin',
        tenantId: 'tenant-1',
        role: 'ADMIN',
        permissions: [],
      });

      seedTenant(); // slug is 'acme-corp'
      seedMember('tenant-1', 'user-1', 'ADMIN');

      const { PATCH } = await import('../../app/api/workspaces/[tenantId]/settings/route');
      const res = await PATCH(
        makeRequest('/api/workspaces/tenant-1/settings', {
          method: 'PATCH',
          body: JSON.stringify({ name: 'Updated Name', slug: 'acme-corp' }), // same slug
          headers: { 'Content-Type': 'application/json' },
        }),
        { params },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.workspace.name).toBe('Updated Name');
    });
  });
});

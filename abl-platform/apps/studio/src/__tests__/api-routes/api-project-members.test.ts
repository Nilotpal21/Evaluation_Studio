/**
 * Project member management API — route contract tests
 *
 * Keeps real Zod parsing plus route-handler auth/access plumbing, while the
 * extracted project-member-service owns the member-management business rules.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const {
  mockRequireAuth,
  mockRequireProjectMemberOrAdmin,
  mockCanActorManageMembers,
  mockListProjectMembers,
  mockListAvailableProjectMembers,
  mockAddProjectMember,
  mockUpdateProjectMember,
  mockRemoveProjectMember,
  mockIsProjectMemberServiceError,
} = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockRequireProjectMemberOrAdmin: vi.fn(),
  mockCanActorManageMembers: vi.fn(),
  mockListProjectMembers: vi.fn(),
  mockListAvailableProjectMembers: vi.fn(),
  mockAddProjectMember: vi.fn(),
  mockUpdateProjectMember: vi.fn(),
  mockRemoveProjectMember: vi.fn(),
  mockIsProjectMemberServiceError: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  requireAuth: mockRequireAuth,
  isAuthError: (result: unknown) => result instanceof NextResponse,
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: vi.fn(),
  isAccessError: (result: unknown) => result instanceof NextResponse,
}));

vi.mock('@/lib/require-project-member-or-admin', () => ({
  requireProjectMemberOrAdmin: mockRequireProjectMemberOrAdmin,
}));

vi.mock('@agent-platform/shared/validation', () => ({
  parseInput: vi.fn((schema: any, data: any) => {
    const result = schema.safeParse(data);
    return result.success
      ? { success: true, data: result.data }
      : { success: false, issues: result.error.issues };
  }),
}));

vi.mock('@/lib/ensure-db', () => ({ ensureDb: vi.fn() }));
vi.mock('@/lib/rate-limiter', () => ({
  rateLimiter: { check: () => ({ allowed: true, resetMs: 0 }), clear: vi.fn() },
  buildRateLimitKey: () => 'key',
}));
vi.mock('@/lib/feature-resolver', () => ({ isFeatureEnabled: vi.fn().mockResolvedValue(true) }));
vi.mock('@/lib/response-sanitizer', () => ({
  sanitizeResponseData: vi.fn((value: unknown) => value),
}));

vi.mock('@/services/project-member-service', () => ({
  canActorManageMembers: mockCanActorManageMembers,
  listProjectMembers: mockListProjectMembers,
  listAvailableProjectMembers: mockListAvailableProjectMembers,
  addProjectMember: mockAddProjectMember,
  updateProjectMember: mockUpdateProjectMember,
  removeProjectMember: mockRemoveProjectMember,
  isProjectMemberServiceError: mockIsProjectMemberServiceError,
}));

const PROJECT = {
  id: 'proj-1',
  _id: 'proj-1',
  name: 'Test Project',
  slug: 'test-project',
  ownerId: 'owner-1',
  tenantId: 'tenant-1',
};

function authedAdmin(userId = 'admin-1') {
  return {
    id: userId,
    email: `${userId}@test.com`,
    name: 'Admin',
    tenantId: 'tenant-1',
    role: 'ADMIN',
    permissions: ['*:*'],
  };
}

function authedViewer(userId = 'viewer-1') {
  return {
    id: userId,
    email: `${userId}@test.com`,
    name: 'Viewer',
    tenantId: 'tenant-1',
    role: 'VIEWER',
    permissions: ['agent:read'],
  };
}

function request(method: string, path: string, body?: unknown) {
  const init: ConstructorParameters<typeof NextRequest>[1] = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  return new NextRequest(`http://localhost${path}`, init);
}

function ctx(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function serviceError(message: string, statusCode: number, code: string) {
  const error = new Error(message) as Error & {
    __isProjectMemberServiceError: true;
    code: string;
    statusCode: number;
    status: number;
  };
  error.name = 'ProjectMemberServiceError';
  error.__isProjectMemberServiceError = true;
  error.code = code;
  error.statusCode = statusCode;
  error.status = statusCode;
  return error;
}

beforeEach(() => {
  vi.clearAllMocks();

  mockRequireAuth.mockResolvedValue(authedAdmin());
  mockRequireProjectMemberOrAdmin.mockResolvedValue({ project: PROJECT, accessPath: 'tenant' });
  mockCanActorManageMembers.mockResolvedValue(true);
  mockIsProjectMemberServiceError.mockImplementation((error: unknown) =>
    Boolean((error as { __isProjectMemberServiceError?: boolean })?.__isProjectMemberServiceError),
  );
});

describe('GET /api/projects/:id/members', () => {
  test('lists members via strict project access and service result mapping', async () => {
    mockListProjectMembers.mockResolvedValue([
      {
        id: 'pm-1',
        userId: 'dev-1',
        role: 'developer',
        customRoleId: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        user: { id: 'dev-1', email: 'dev@test.com', name: 'Developer' },
      },
    ]);

    const { GET } = await import('../../app/api/projects/[id]/members/route');
    const res = await GET(request('GET', '/api/projects/proj-1/members'), ctx({ id: 'proj-1' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(mockRequireProjectMemberOrAdmin).toHaveBeenCalledWith('proj-1', expect.any(Object));
    expect(mockListProjectMembers).toHaveBeenCalledWith(PROJECT);
    expect(json.members).toEqual([
      {
        id: 'pm-1',
        userId: 'dev-1',
        email: 'dev@test.com',
        name: 'Developer',
        role: 'developer',
        customRoleId: null,
        joinedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    expect(json.canManageMembers).toBe(true);
    expect(mockCanActorManageMembers).toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({
        userId: 'admin-1',
        role: 'ADMIN',
        permissions: ['*:*'],
      }),
    );
  });

  test('returns 401 when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    );

    const { GET } = await import('../../app/api/projects/[id]/members/route');
    const res = await GET(request('GET', '/api/projects/proj-1/members'), ctx({ id: 'proj-1' }));

    expect(res.status).toBe(401);
  });

  test('returns canManageMembers=false for read-only project members', async () => {
    mockCanActorManageMembers.mockResolvedValue(false);
    mockRequireAuth.mockResolvedValue(authedViewer());
    mockListProjectMembers.mockResolvedValue([]);

    const { GET } = await import('../../app/api/projects/[id]/members/route');
    const res = await GET(request('GET', '/api/projects/proj-1/members'), ctx({ id: 'proj-1' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.canManageMembers).toBe(false);
  });
});

describe('GET /api/projects/:id/members/available', () => {
  test('lists available workspace members through the project-scoped route', async () => {
    mockListAvailableProjectMembers.mockResolvedValue([
      {
        id: 'tm-1',
        userId: 'candidate-1',
        role: 'MEMBER',
        status: 'active',
        createdAt: new Date('2026-01-03T00:00:00.000Z'),
        user: { id: 'candidate-1', email: 'candidate@test.com', name: 'Candidate User' },
      },
    ]);

    const { GET } = await import('../../app/api/projects/[id]/members/available/route');
    const res = await GET(
      request('GET', '/api/projects/proj-1/members/available'),
      ctx({ id: 'proj-1' }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(mockRequireProjectMemberOrAdmin).toHaveBeenCalledWith('proj-1', expect.any(Object));
    expect(mockListAvailableProjectMembers).toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({
        userId: 'admin-1',
        role: 'ADMIN',
        permissions: ['*:*'],
      }),
    );
    expect(json.members).toEqual([
      {
        id: 'tm-1',
        userId: 'candidate-1',
        email: 'candidate@test.com',
        name: 'Candidate User',
        workspaceRole: 'MEMBER',
        status: 'active',
        joinedAt: '2026-01-03T00:00:00.000Z',
      },
    ]);
  });

  test('maps service authorization failures to 403', async () => {
    mockListAvailableProjectMembers.mockRejectedValue(
      serviceError('Insufficient permissions to manage project members', 403, 'FORBIDDEN'),
    );

    const { GET } = await import('../../app/api/projects/[id]/members/available/route');
    const res = await GET(
      request('GET', '/api/projects/proj-1/members/available'),
      ctx({ id: 'proj-1' }),
    );
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.errors[0]).toMatchObject({
      msg: 'Insufficient permissions to manage project members',
      code: 'FORBIDDEN',
    });
  });
});

describe('POST /api/projects/:id/members', () => {
  test('creates a member and passes actor context to the service', async () => {
    mockAddProjectMember.mockResolvedValue({
      id: 'pm-dev',
      userId: 'dev-1',
      role: 'developer',
      customRoleId: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const { POST } = await import('../../app/api/projects/[id]/members/route');
    const res = await POST(
      request('POST', '/api/projects/proj-1/members', { userId: 'dev-1', role: 'developer' }),
      ctx({ id: 'proj-1' }),
    );
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(mockAddProjectMember).toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({
        userId: 'admin-1',
        role: 'ADMIN',
        permissions: ['*:*'],
        ip: undefined,
        userAgent: undefined,
      }),
      { userId: 'dev-1', role: 'developer' },
    );
    expect(json.member).toEqual({
      id: 'pm-dev',
      userId: 'dev-1',
      role: 'developer',
      customRoleId: null,
      joinedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  test('rejects invalid body via Zod', async () => {
    const { POST } = await import('../../app/api/projects/[id]/members/route');
    const res = await POST(
      request('POST', '/api/projects/proj-1/members', { userId: '', role: 'viewer' }),
      ctx({ id: 'proj-1' }),
    );

    expect(res.status).toBe(400);
    expect(mockAddProjectMember).not.toHaveBeenCalled();
  });

  test('maps service authorization failures to 403', async () => {
    mockRequireAuth.mockResolvedValue(authedViewer());
    mockAddProjectMember.mockRejectedValue(
      serviceError('Insufficient permissions to manage project members', 403, 'FORBIDDEN'),
    );

    const { POST } = await import('../../app/api/projects/[id]/members/route');
    const res = await POST(
      request('POST', '/api/projects/proj-1/members', { userId: 'dev-1', role: 'viewer' }),
      ctx({ id: 'proj-1' }),
    );
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.errors[0]).toMatchObject({
      msg: 'Insufficient permissions to manage project members',
      code: 'FORBIDDEN',
    });
  });

  test('returns route-level 404 when strict project access fails', async () => {
    mockRequireProjectMemberOrAdmin.mockResolvedValue(
      NextResponse.json({ error: 'Not found' }, { status: 404 }),
    );

    const { POST } = await import('../../app/api/projects/[id]/members/route');
    const res = await POST(
      request('POST', '/api/projects/proj-1/members', { userId: 'dev-1', role: 'viewer' }),
      ctx({ id: 'proj-1' }),
    );

    expect(res.status).toBe(404);
    expect(mockAddProjectMember).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/projects/:id/members/:memberId', () => {
  test('updates a member through the service', async () => {
    mockUpdateProjectMember.mockResolvedValue({
      id: 'pm-dev',
      userId: 'dev-1',
      role: 'viewer',
      customRoleId: null,
    });

    const { PATCH } = await import('../../app/api/projects/[id]/members/[memberId]/route');
    const res = await PATCH(
      request('PATCH', '/api/projects/proj-1/members/dev-1', { role: 'viewer' }),
      ctx({ id: 'proj-1', memberId: 'dev-1' }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(mockUpdateProjectMember).toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({ userId: 'admin-1' }),
      'dev-1',
      { role: 'viewer' },
    );
    expect(json.member).toEqual({
      id: 'pm-dev',
      userId: 'dev-1',
      role: 'viewer',
      customRoleId: null,
    });
  });

  test('maps service validation failures to 400', async () => {
    mockUpdateProjectMember.mockRejectedValue(
      serviceError("Cannot change the project owner's role", 400, 'VALIDATION_ERROR'),
    );

    const { PATCH } = await import('../../app/api/projects/[id]/members/[memberId]/route');
    const res = await PATCH(
      request('PATCH', '/api/projects/proj-1/members/owner-1', { role: 'viewer' }),
      ctx({ id: 'proj-1', memberId: 'owner-1' }),
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.errors[0].msg).toContain("project owner's role");
  });
});

describe('DELETE /api/projects/:id/members/:memberId', () => {
  test('removes a member through the service', async () => {
    mockRemoveProjectMember.mockResolvedValue(undefined);

    const { DELETE } = await import('../../app/api/projects/[id]/members/[memberId]/route');
    const res = await DELETE(
      request('DELETE', '/api/projects/proj-1/members/dev-1'),
      ctx({ id: 'proj-1', memberId: 'dev-1' }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(mockRemoveProjectMember).toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({ userId: 'admin-1' }),
      'dev-1',
    );
    expect(json).toEqual({ success: true, message: 'Member removed' });
  });

  test('maps service not-found failures to 404', async () => {
    mockRemoveProjectMember.mockRejectedValue(serviceError('Not found', 404, 'NOT_FOUND'));

    const { DELETE } = await import('../../app/api/projects/[id]/members/[memberId]/route');
    const res = await DELETE(
      request('DELETE', '/api/projects/proj-1/members/ghost'),
      ctx({ id: 'proj-1', memberId: 'ghost' }),
    );
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.errors[0]).toMatchObject({ msg: 'Not found', code: 'NOT_FOUND' });
  });
});

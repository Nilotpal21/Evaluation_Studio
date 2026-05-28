/**
 * Tests for withRouteHandler RBAC integration
 *
 * Covers: permission enforcement (403), wildcard matching, missing permissions,
 * rate limiting (429), response sanitization.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { withRouteHandler } from '../../lib/route-handler';
import { rateLimiter } from '../../lib/rate-limiter';
import { StudioPermission } from '../../lib/permissions';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const {
  mockRequireAuth,
  mockRequireProjectAccess,
  mockRequireProjectMemberOrAdmin,
  mockCanProjectPermissionContextPerform,
  mockResolveProjectPermissionContext,
  mockResolveStudioProjectPermissionAliases,
  mockWithAuditActor,
} = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockRequireProjectAccess: vi.fn(),
  mockRequireProjectMemberOrAdmin: vi.fn(),
  mockCanProjectPermissionContextPerform: vi.fn(),
  mockResolveProjectPermissionContext: vi.fn(),
  mockResolveStudioProjectPermissionAliases: vi.fn(),
  mockWithAuditActor: vi.fn((actor: unknown, fn: () => unknown) => fn()),
}));

vi.mock('../../lib/auth', () => ({
  requireAuth: mockRequireAuth,
  isAuthError: (r: unknown) => r instanceof NextResponse,
}));

vi.mock('../../lib/project-access', () => ({
  requireProjectAccess: mockRequireProjectAccess,
  isAccessError: (r: unknown) => r instanceof NextResponse,
}));

vi.mock('../../lib/require-project-member-or-admin', () => ({
  requireProjectMemberOrAdmin: mockRequireProjectMemberOrAdmin,
}));

vi.mock('../../lib/project-permission', () => ({
  canProjectPermissionContextPerform: (...args: unknown[]) =>
    mockCanProjectPermissionContextPerform(...args),
  resolveProjectPermissionContext: (...args: unknown[]) =>
    mockResolveProjectPermissionContext(...args),
  resolveStudioProjectPermissionAliases: (...args: unknown[]) =>
    mockResolveStudioProjectPermissionAliases(...args),
}));

vi.mock('@agent-platform/database/mongo', () => ({
  setAuditHandler: vi.fn(),
  withAuditActor: (...args: unknown[]) => mockWithAuditActor(...args),
}));

vi.mock('@agent-platform/shared/validation', () => ({
  parseInput: vi.fn((schema: any, data: any) => ({ success: true, data })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(perms: string[] = [], tenantId = 'tenant-1') {
  return {
    id: 'user-1',
    email: 'test@example.com',
    name: 'Test',
    tenantId,
    role: 'editor',
    permissions: perms,
  };
}

function makeRequest(method = 'GET', path = '/api/projects/proj-1/tools') {
  return new NextRequest(`http://localhost${path}`, { method });
}

function makeRouteCtx(params: Record<string, string> = { id: 'proj-1' }) {
  return { params: Promise.resolve(params) };
}

const successHandler = async () => NextResponse.json({ success: true });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.restoreAllMocks();
  rateLimiter.clear();
  mockResolveStudioProjectPermissionAliases.mockReturnValue(null);
  mockResolveProjectPermissionContext.mockResolvedValue({
    project: { id: 'proj-1', tenantId: 'tenant-1', ownerId: 'owner-1' },
    accessLevel: 'project_member',
    role: 'developer',
    customRolePermissions: [],
  });
  mockCanProjectPermissionContextPerform.mockReturnValue(false);
});

describe('withRouteHandler — permission enforcement', () => {
  test('uses the trusted rightmost forwarded IP for rate-limit and audit actor context', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(['tool:read']));
    mockRequireProjectAccess.mockResolvedValue({ project: { id: 'proj-1', tenantId: 'tenant-1' } });

    const handler = withRouteHandler(
      {
        requireProject: true,
        permissions: StudioPermission.TOOL_READ,
        rateLimit: { limit: 10, windowMs: 60_000, scope: 'ip' },
      },
      successHandler,
    );

    const response = await handler(
      new NextRequest('http://localhost/api/projects/proj-1/tools', {
        headers: { 'x-forwarded-for': '198.51.100.10, 10.0.0.5' },
      }),
      makeRouteCtx(),
    );

    expect(response.status).toBe(200);
    expect(mockWithAuditActor).toHaveBeenCalledWith(
      expect.objectContaining({ ip: '10.0.0.5' }),
      expect.any(Function),
    );
  });

  test('allows request when user has exact permission', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(['tool:read']));
    mockRequireProjectAccess.mockResolvedValue({ project: { id: 'proj-1', tenantId: 'tenant-1' } });

    const handler = withRouteHandler(
      { requireProject: true, permissions: StudioPermission.TOOL_READ },
      successHandler,
    );

    const response = await handler(makeRequest(), makeRouteCtx());
    expect(response.status).toBe(200);
  });

  test('uses strict project member/admin gate when configured', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(['tool:read']));
    mockRequireProjectMemberOrAdmin.mockResolvedValue({
      project: { id: 'proj-1', tenantId: 'tenant-1', ownerId: 'owner-1' },
    });

    const handler = withRouteHandler(
      {
        requireProjectMemberOrAdmin: true,
        permissions: StudioPermission.TOOL_READ,
      },
      successHandler,
    );

    const response = await handler(makeRequest(), makeRouteCtx());
    expect(response.status).toBe(200);
    expect(mockRequireProjectMemberOrAdmin).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({ id: 'user-1' }),
    );
  });

  test('returns project access denial before permissions when requireProject is configured', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(['tool:read']));
    mockRequireProjectAccess.mockResolvedValue(
      NextResponse.json(
        { success: false, errors: [{ msg: 'Not found', code: 'NOT_FOUND' }] },
        { status: 404 },
      ),
    );

    const handler = withRouteHandler(
      { requireProject: true, permissions: StudioPermission.TOOL_READ },
      successHandler,
    );

    const response = await handler(makeRequest(), makeRouteCtx());
    expect(response.status).toBe(404);
    expect(mockRequireProjectAccess).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({ id: 'user-1' }),
    );
  });

  test('returns strict gate denial before permissions when configured', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(['tool:read']));
    mockRequireProjectMemberOrAdmin.mockResolvedValue(
      NextResponse.json(
        { success: false, errors: [{ msg: 'Not found', code: 'NOT_FOUND' }] },
        { status: 404 },
      ),
    );

    const handler = withRouteHandler(
      {
        requireProjectMemberOrAdmin: true,
        permissions: StudioPermission.TOOL_READ,
      },
      successHandler,
    );

    const response = await handler(makeRequest(), makeRouteCtx());
    expect(response.status).toBe(404);
    expect(mockRequireProjectMemberOrAdmin).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({ id: 'user-1' }),
    );
  });

  test('uses project-role permission evaluation for mapped project permissions', async () => {
    mockRequireAuth.mockResolvedValue(makeUser([]));
    mockRequireProjectAccess.mockResolvedValue({
      project: { id: 'proj-1', tenantId: 'tenant-1', ownerId: 'owner-1' },
      accessPath: 'membership',
    });
    mockResolveStudioProjectPermissionAliases.mockReturnValue(['tool:write']);
    mockCanProjectPermissionContextPerform.mockReturnValue(true);

    const handler = withRouteHandler(
      { requireProject: true, permissions: StudioPermission.TOOL_WRITE },
      successHandler,
    );

    const response = await handler(makeRequest(), makeRouteCtx());
    expect(response.status).toBe(200);
    expect(mockResolveProjectPermissionContext).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({ id: 'user-1' }),
      {
        project: { id: 'proj-1', tenantId: 'tenant-1', ownerId: 'owner-1' },
      },
    );
    expect(mockCanProjectPermissionContextPerform).toHaveBeenCalledWith(
      expect.objectContaining({ accessLevel: 'project_member', role: 'developer' }),
      ['tool:write'],
    );
  });

  test('returns 403 when mapped project permissions deny the request', async () => {
    mockRequireAuth.mockResolvedValue(makeUser([]));
    mockRequireProjectAccess.mockResolvedValue({
      project: { id: 'proj-1', tenantId: 'tenant-1', ownerId: 'owner-1' },
      accessPath: 'membership',
    });
    mockResolveStudioProjectPermissionAliases.mockReturnValue(['tool:write']);
    mockCanProjectPermissionContextPerform.mockReturnValue(false);

    const handler = withRouteHandler(
      { requireProject: true, permissions: StudioPermission.TOOL_WRITE },
      successHandler,
    );

    const response = await handler(makeRequest(), makeRouteCtx());
    expect(response.status).toBe(403);
  });

  test('does not let project ownership imply pii reveal on Studio routes', async () => {
    mockRequireAuth.mockResolvedValue(makeUser([]));
    mockRequireProjectAccess.mockResolvedValue({
      project: { id: 'proj-1', tenantId: 'tenant-1', ownerId: 'user-1' },
      accessPath: 'tenant',
    });
    mockResolveStudioProjectPermissionAliases.mockReturnValue(['pii:reveal']);
    mockCanProjectPermissionContextPerform.mockClear();

    const handler = withRouteHandler(
      { requireProject: true, permissions: StudioPermission.PII_REVEAL },
      successHandler,
    );

    const response = await handler(makeRequest(), makeRouteCtx());
    expect(response.status).toBe(403);
    expect(mockCanProjectPermissionContextPerform).not.toHaveBeenCalled();
  });

  test('does not let project wildcard authority imply pii reveal on Studio routes', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(['project:*']));
    mockRequireProjectAccess.mockResolvedValue({
      project: { id: 'proj-1', tenantId: 'tenant-1', ownerId: 'owner-1' },
      accessPath: 'tenant_rbac',
    });
    mockResolveStudioProjectPermissionAliases.mockReturnValue(['pii:reveal']);

    const handler = withRouteHandler(
      { requireProject: true, permissions: StudioPermission.PII_REVEAL },
      successHandler,
    );

    const response = await handler(makeRequest(), makeRouteCtx());
    expect(response.status).toBe(403);
  });

  test('allows pii reveal on Studio routes when exact permission is present', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(['project:*', 'pii:reveal']));
    mockRequireProjectAccess.mockResolvedValue({
      project: { id: 'proj-1', tenantId: 'tenant-1', ownerId: 'owner-1' },
      accessPath: 'tenant_rbac',
    });
    mockResolveStudioProjectPermissionAliases.mockReturnValue(['pii:reveal']);

    const handler = withRouteHandler(
      { requireProject: true, permissions: StudioPermission.PII_REVEAL },
      successHandler,
    );

    const response = await handler(makeRequest(), makeRouteCtx());
    expect(response.status).toBe(200);
  });

  test('rejects with 403 when user lacks required permission', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(['tool:read']));

    const handler = withRouteHandler({ permissions: StudioPermission.TOOL_WRITE }, successHandler);

    const response = await handler(makeRequest(), makeRouteCtx());
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.errors[0].code).toBe('FORBIDDEN');
  });

  test('allows request when user has wildcard permission (tool:*)', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(['tool:*']));

    const handler = withRouteHandler({ permissions: StudioPermission.TOOL_WRITE }, successHandler);

    const response = await handler(makeRequest(), makeRouteCtx());
    expect(response.status).toBe(200);
  });

  test('allows request when user has super-admin permission (*:*)', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(['*:*']));

    const handler = withRouteHandler({ permissions: StudioPermission.TOOL_DELETE }, successHandler);

    const response = await handler(makeRequest(), makeRouteCtx());
    expect(response.status).toBe(200);
  });

  test('allows when any of multiple permissions match', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(['tool:read']));

    const handler = withRouteHandler(
      { permissions: [StudioPermission.TOOL_READ, StudioPermission.TOOL_WRITE] },
      successHandler,
    );

    const response = await handler(makeRequest(), makeRouteCtx());
    expect(response.status).toBe(200);
  });

  test('rejects when none of multiple permissions match', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(['agent:read']));

    const handler = withRouteHandler(
      { permissions: [StudioPermission.TOOL_WRITE, StudioPermission.TOOL_DELETE] },
      successHandler,
    );

    const response = await handler(makeRequest(), makeRouteCtx());
    expect(response.status).toBe(403);
  });

  test('skips permission check when permissions not configured', async () => {
    mockRequireAuth.mockResolvedValue(makeUser([]));

    const handler = withRouteHandler({}, successHandler);
    const response = await handler(makeRequest(), makeRouteCtx());
    expect(response.status).toBe(200);
  });

  test('does not throw when route params resolve to undefined (static API routes)', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(['tool:read'], 'tenant-1'));

    const handler = withRouteHandler({ permissions: StudioPermission.TOOL_READ }, successHandler);

    const response = await handler(makeRequest('GET', '/api/auth-profiles'), {
      params: Promise.resolve(undefined as unknown as Record<string, string>),
    });
    expect(response.status).toBe(200);
  });

  test('wraps handler execution in an audit actor context', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(['tool:read'], 'tenant-1'));

    const handler = withRouteHandler({ permissions: StudioPermission.TOOL_READ }, successHandler);
    const response = await handler(
      new NextRequest('http://localhost/api/auth-profiles', {
        headers: {
          'x-forwarded-for': '10.0.0.1',
          'user-agent': 'vitest-agent',
        },
      }),
      { params: Promise.resolve({}) },
    );

    expect(response.status).toBe(200);
    expect(mockWithAuditActor).toHaveBeenCalledWith(
      {
        userId: 'user-1',
        email: 'test@example.com',
        ip: '10.0.0.1',
        userAgent: 'vitest-agent',
      },
      expect.any(Function),
    );
  });
});

describe('withRouteHandler — rate limiting', () => {
  test('allows requests within rate limit', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(['tool:read']));

    const handler = withRouteHandler(
      { permissions: StudioPermission.TOOL_READ, rateLimit: { limit: 3, windowMs: 60_000 } },
      successHandler,
    );

    const req = makeRequest();
    const ctx = makeRouteCtx();

    for (let i = 0; i < 3; i++) {
      const response = await handler(req, ctx);
      expect(response.status).toBe(200);
    }
  });

  test('returns 429 when rate limit exceeded', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(['tool:execute']));

    const handler = withRouteHandler(
      { permissions: StudioPermission.TOOL_EXECUTE, rateLimit: { limit: 2, windowMs: 60_000 } },
      successHandler,
    );

    const req = makeRequest('POST', '/api/projects/proj-1/tools/t1/test');
    const ctx = makeRouteCtx();

    await handler(req, ctx);
    await handler(req, ctx);
    const response = await handler(req, ctx);

    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.errors[0].code).toBe('RATE_LIMITED');
    expect(response.headers.get('Retry-After')).toBeTruthy();
  });
});

describe('withRouteHandler — auth error passthrough', () => {
  test('returns 401 when auth fails', async () => {
    mockRequireAuth.mockResolvedValue(
      NextResponse.json(
        { success: false, errors: [{ msg: 'Unauthorized', code: 'UNAUTHORIZED' }] },
        { status: 401 },
      ),
    );

    const handler = withRouteHandler({ permissions: StudioPermission.TOOL_READ }, successHandler);

    const response = await handler(makeRequest(), makeRouteCtx());
    expect(response.status).toBe(401);
  });
});

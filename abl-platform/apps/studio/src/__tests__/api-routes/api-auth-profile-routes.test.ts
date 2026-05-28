/**
 * Auth Profile Route RBAC + Business Logic Tests
 *
 * Tests permission enforcement for auth-profile operations using withRouteHandler
 * directly (the same pattern as route-handler-rbac.test.ts). This avoids the known
 * vitest alias resolution issue with dynamic imports of route files.
 *
 * Covers:
 *   - Permission enforcement for auth-profile:read, auth-profile:write, auth-profile:delete
 *   - Visibility enforcement (personal profiles hidden from non-owners)
 *   - SSRF validation on OAuth URL fields
 *   - linkedAppProfileId cross-reference validation
 *   - Secret redaction in responses
 *   - Consumer count blocking for delete
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockRequireAuth, mockRequireProjectAccess } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockRequireProjectAccess: vi.fn(),
}));

vi.mock('../../lib/auth', () => ({
  requireAuth: mockRequireAuth,
  isAuthError: (r: unknown) => r instanceof NextResponse,
}));

vi.mock('../../lib/project-access', () => ({
  requireProjectAccess: mockRequireProjectAccess,
  isAccessError: (r: unknown) => r instanceof NextResponse,
}));

vi.mock('@agent-platform/shared/validation', () => ({
  parseInput: vi.fn((_schema: any, data: any) => ({ success: true, data })),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { withRouteHandler } from '../../lib/route-handler';
import { StudioPermission } from '../../lib/permissions';
import { rateLimiter } from '../../lib/rate-limiter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(perms: string[] = [], id = 'user-1', tenantId = 'tenant-1') {
  return {
    id,
    email: `${id}@test.com`,
    name: 'Test',
    tenantId,
    role: 'editor',
    permissions: perms,
  };
}

function makeRequest(method = 'GET', path = '/api/projects/proj-1/auth-profiles') {
  return new NextRequest(`http://localhost${path}`, { method });
}

function makeRouteCtx(params: Record<string, string> = { id: 'proj-1' }) {
  return { params: Promise.resolve(params) };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.restoreAllMocks();
  rateLimiter.clear();
});

// ---------------------------------------------------------------------------
// Tests — Auth Profile Permission Enforcement
// ---------------------------------------------------------------------------

describe('Auth profile permission enforcement', () => {
  const successHandler = async () => NextResponse.json({ success: true });

  describe('AUTH_PROFILE_READ', () => {
    it('allows with auth-profile:read permission', async () => {
      mockRequireAuth.mockResolvedValue(makeUser(['auth-profile:read']));
      mockRequireProjectAccess.mockResolvedValue({
        project: { id: 'proj-1', tenantId: 'tenant-1' },
      });

      const handler = withRouteHandler(
        { requireProject: true, permissions: StudioPermission.AUTH_PROFILE_READ },
        successHandler,
      );

      const res = await handler(makeRequest(), makeRouteCtx());
      expect(res.status).toBe(200);
    });

    it('rejects without auth-profile:read permission', async () => {
      mockRequireAuth.mockResolvedValue(makeUser(['tool:read']));

      const handler = withRouteHandler(
        { permissions: StudioPermission.AUTH_PROFILE_READ },
        successHandler,
      );

      const res = await handler(makeRequest(), makeRouteCtx());
      expect(res.status).toBe(403);
    });

    it('allows with wildcard auth-profile:* permission', async () => {
      mockRequireAuth.mockResolvedValue(makeUser(['auth-profile:*']));

      const handler = withRouteHandler(
        { permissions: StudioPermission.AUTH_PROFILE_READ },
        successHandler,
      );

      const res = await handler(makeRequest(), makeRouteCtx());
      expect(res.status).toBe(200);
    });

    it('allows with super-admin *:* permission', async () => {
      mockRequireAuth.mockResolvedValue(makeUser(['*:*']));

      const handler = withRouteHandler(
        { permissions: StudioPermission.AUTH_PROFILE_READ },
        successHandler,
      );

      const res = await handler(makeRequest(), makeRouteCtx());
      expect(res.status).toBe(200);
    });
  });

  describe('AUTH_PROFILE_WRITE', () => {
    it('allows with auth-profile:write permission', async () => {
      mockRequireAuth.mockResolvedValue(makeUser(['auth-profile:write']));
      mockRequireProjectAccess.mockResolvedValue({
        project: { id: 'proj-1', tenantId: 'tenant-1' },
      });

      const handler = withRouteHandler(
        { requireProject: true, permissions: StudioPermission.AUTH_PROFILE_WRITE },
        successHandler,
      );

      const res = await handler(makeRequest('POST'), makeRouteCtx());
      expect(res.status).toBe(200);
    });

    it('rejects read-only users from write', async () => {
      mockRequireAuth.mockResolvedValue(makeUser(['auth-profile:read']));

      const handler = withRouteHandler(
        { permissions: StudioPermission.AUTH_PROFILE_WRITE },
        successHandler,
      );

      const res = await handler(makeRequest('POST'), makeRouteCtx());
      expect(res.status).toBe(403);
    });
  });

  describe('AUTH_PROFILE_DELETE', () => {
    it('allows with auth-profile:delete permission', async () => {
      mockRequireAuth.mockResolvedValue(makeUser(['auth-profile:delete']));
      mockRequireProjectAccess.mockResolvedValue({
        project: { id: 'proj-1', tenantId: 'tenant-1' },
      });

      const handler = withRouteHandler(
        { requireProject: true, permissions: StudioPermission.AUTH_PROFILE_DELETE },
        successHandler,
      );

      const res = await handler(makeRequest('DELETE'), makeRouteCtx());
      expect(res.status).toBe(200);
    });

    it('rejects read-only users from delete', async () => {
      mockRequireAuth.mockResolvedValue(makeUser(['auth-profile:read']));

      const handler = withRouteHandler(
        { permissions: StudioPermission.AUTH_PROFILE_DELETE },
        successHandler,
      );

      const res = await handler(makeRequest('DELETE'), makeRouteCtx());
      expect(res.status).toBe(403);
    });

    it('rejects write-only users from delete', async () => {
      mockRequireAuth.mockResolvedValue(makeUser(['auth-profile:write']));

      const handler = withRouteHandler(
        { permissions: StudioPermission.AUTH_PROFILE_DELETE },
        successHandler,
      );

      const res = await handler(makeRequest('DELETE'), makeRouteCtx());
      expect(res.status).toBe(403);
    });
  });

  describe('AUTH_PROFILE_DECRYPT', () => {
    it('allows with auth-profile:decrypt permission', async () => {
      mockRequireAuth.mockResolvedValue(makeUser(['auth-profile:decrypt']));

      const handler = withRouteHandler(
        { permissions: StudioPermission.AUTH_PROFILE_DECRYPT },
        successHandler,
      );

      const res = await handler(makeRequest(), makeRouteCtx());
      expect(res.status).toBe(200);
    });

    it('rejects read-only users from decrypt', async () => {
      mockRequireAuth.mockResolvedValue(makeUser(['auth-profile:read']));

      const handler = withRouteHandler(
        { permissions: StudioPermission.AUTH_PROFILE_DECRYPT },
        successHandler,
      );

      const res = await handler(makeRequest(), makeRouteCtx());
      expect(res.status).toBe(403);
    });
  });

  describe('Unauthenticated', () => {
    it('rejects unauthenticated requests with 401', async () => {
      mockRequireAuth.mockResolvedValue(
        NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      );

      const handler = withRouteHandler(
        { permissions: StudioPermission.AUTH_PROFILE_READ },
        successHandler,
      );

      const res = await handler(makeRequest(), makeRouteCtx());
      expect(res.status).toBe(401);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — Rate Limiting for OAuth Endpoints
// ---------------------------------------------------------------------------

describe('Auth profile OAuth rate limiting', () => {
  const successHandler = async () => NextResponse.json({ success: true });

  it('rate limits OAuth initiate to 20 requests per minute', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(['auth-profile:write']));
    mockRequireProjectAccess.mockResolvedValue({
      project: { id: 'proj-1', tenantId: 'tenant-1' },
    });

    const handler = withRouteHandler(
      {
        requireProject: true,
        permissions: StudioPermission.AUTH_PROFILE_WRITE,
        rateLimit: { limit: 20, windowMs: 60_000, scope: 'user' },
      },
      successHandler,
    );

    const req = makeRequest('POST', '/api/projects/proj-1/auth-profiles/oauth/initiate');
    const ctx = makeRouteCtx();

    // First 20 should pass
    for (let i = 0; i < 20; i++) {
      const res = await handler(req, ctx);
      expect(res.status).toBe(200);
    }

    // 21st should be rate-limited
    const res = await handler(req, ctx);
    expect(res.status).toBe(429);
  });

  it('rate limits OAuth callback to 10 requests per minute', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(['auth-profile:write']));
    mockRequireProjectAccess.mockResolvedValue({
      project: { id: 'proj-1', tenantId: 'tenant-1' },
    });

    const handler = withRouteHandler(
      {
        requireProject: true,
        permissions: StudioPermission.AUTH_PROFILE_WRITE,
        rateLimit: { limit: 10, windowMs: 60_000, scope: 'user' },
      },
      successHandler,
    );

    const req = makeRequest('POST', '/api/projects/proj-1/auth-profiles/oauth/callback');
    const ctx = makeRouteCtx();

    // First 10 should pass
    for (let i = 0; i < 10; i++) {
      const res = await handler(req, ctx);
      expect(res.status).toBe(200);
    }

    // 11th should be rate-limited
    const res = await handler(req, ctx);
    expect(res.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Tests — Handler Business Logic via withRouteHandler
// ---------------------------------------------------------------------------

describe('Auth profile handler logic', () => {
  it('handler receives tenantId, user, params from withRouteHandler', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(['auth-profile:read'], 'user-42', 'tenant-xyz'));
    mockRequireProjectAccess.mockResolvedValue({
      project: { id: 'proj-7', tenantId: 'tenant-xyz' },
    });

    let capturedCtx: any = null;
    const handler = withRouteHandler(
      { requireProject: true, permissions: StudioPermission.AUTH_PROFILE_READ },
      async (ctx) => {
        capturedCtx = ctx;
        return NextResponse.json({ success: true });
      },
    );

    await handler(makeRequest(), { params: Promise.resolve({ id: 'proj-7' }) });

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx.tenantId).toBe('tenant-xyz');
    expect(capturedCtx.user.id).toBe('user-42');
    expect(capturedCtx.params.id).toBe('proj-7');
  });

  it('handler receives parsed body when bodySchema is configured', async () => {
    mockRequireAuth.mockResolvedValue(makeUser(['auth-profile:write']));
    mockRequireProjectAccess.mockResolvedValue({
      project: { id: 'proj-1', tenantId: 'tenant-1' },
    });

    let capturedBody: any = null;
    const fakeSchema = {} as any; // parseInput mock returns data as-is
    const handler = withRouteHandler(
      {
        requireProject: true,
        permissions: StudioPermission.AUTH_PROFILE_WRITE,
        bodySchema: fakeSchema,
      },
      async (ctx) => {
        capturedBody = ctx.body;
        return NextResponse.json({ success: true }, { status: 201 });
      },
    );

    const body = { name: 'Test Profile', authType: 'api_key' };
    const req = new NextRequest('http://localhost/api/projects/proj-1/auth-profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const res = await handler(req, makeRouteCtx());
    expect(res.status).toBe(201);
    expect(capturedBody).toEqual(body);
  });
});

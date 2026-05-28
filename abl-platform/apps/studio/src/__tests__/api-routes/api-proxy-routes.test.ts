/**
 * Studio → Runtime API Route Tests
 *
 * Verifies that studio Next.js API routes correctly handle session operations.
 * GET /sessions — proxies to Runtime so Studio sees live in-memory sessions too.
 * GET /sessions/:id — proxies to Runtime for full session data (messages + traces).
 * Write routes (DELETE, POST close, POST bulk-close) proxy to Runtime.
 *
 * Routes under test:
 *   GET    /api/runtime/sessions?projectId=X         → proxy to Runtime
 *   GET    /api/runtime/sessions/:id?projectId=X     → proxy to Runtime
 *   DELETE /api/runtime/sessions/:id?projectId=X     → DELETE ${RUNTIME_URL}/api/projects/X/sessions/:id
 *   POST   /api/runtime/sessions/:id/close?projectId=X → POST ${RUNTIME_URL}/api/projects/X/sessions/:id/close
 *   POST   /api/runtime/sessions/bulk-close           → POST ${RUNTIME_URL}/api/projects/X/sessions/bulk-close
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// =============================================================================
// MOCKS
// =============================================================================

const { mockRequireProjectPermission } = vi.hoisted(() => ({
  mockRequireProjectPermission: vi.fn(),
}));

// Mock the auth module — all routes use requireTenantAuth + isAuthError
vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn(async () => ({
    id: 'user-1',
    email: 'test@test.com',
    name: 'Test User',
    tenantId: 'tenant-1',
  })),
  requireTenantAuth: vi.fn(async () => ({
    id: 'user-1',
    email: 'test@test.com',
    name: 'Test User',
    tenantId: 'tenant-1',
  })),
  isAuthError: vi.fn(() => false),
}));

vi.mock('@/lib/project-permission', () => ({
  requireProjectPermission: (...args: unknown[]) => mockRequireProjectPermission(...args),
  isProjectPermissionError: (result: unknown) => result instanceof Response,
}));

// Mock @/services/auth-service (transitive dependency of auth)
vi.mock('@/services/auth-service', () => ({
  verifyAccessToken: vi.fn(),
}));

// Mock @/repos/auth-repo (transitive dependency of auth)
vi.mock('@/repos/auth-repo', () => ({
  findUserById: vi.fn(),
}));

// Mock session repo (legacy dependency kept to ensure the list route no longer uses it)
const mockListSessions = vi.fn();
const mockFindSession = vi.fn();
vi.mock('@/repos/session-repo', () => ({
  listSessionsForProject: mockListSessions,
  findSessionById: mockFindSession,
}));

// Mock @/lib/ensure-db (transitive dep of session-repo)
vi.mock('@/lib/ensure-db', () => ({
  ensureDb: vi.fn(),
}));

// Mock runtime config
vi.mock('@/config/runtime.server', () => ({
  getRuntimeUrl: () => 'http://localhost:3112',
}));

// Mock createLogger (used by session detail proxy route)
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

// Mock safe-proxy to avoid response.text() issues with mock fetch
vi.mock('@/lib/safe-proxy', () => ({
  safeJsonParse: vi.fn(
    async (response: { ok: boolean; status: number; json: () => Promise<unknown> }) => {
      const data = await response.json();
      return { data, ok: response.ok, status: response.status };
    },
  ),
}));

// Track fetch calls
const mockFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  // Install mock fetch — the proxy routes call global fetch()
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ success: true, data: 'proxied' }),
    text: async () => JSON.stringify({ success: true, data: 'proxied' }),
    headers: new Headers(),
  });
  vi.stubGlobal('fetch', mockFetch);
  mockRequireProjectPermission.mockResolvedValue({
    project: { id: 'proj-1', tenantId: 'tenant-1', ownerId: 'owner-1' },
    accessLevel: 'project_member',
    role: 'custom',
    actorPermissions: ['pii:reveal'],
    customRolePermissions: ['pii:reveal'],
  });

  // Default session repo responses
  mockListSessions.mockResolvedValue({
    total: 0,
    offset: 0,
    limit: 50,
    sessions: [],
  });
  mockFindSession.mockResolvedValue(null);
});

// =============================================================================
// HELPERS
// =============================================================================

function makeRequest(url: string, opts: Record<string, any> = {}) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    ...opts,
    headers: {
      Authorization: 'Bearer test-jwt-token',
      'X-Tenant-Id': 'tenant-1',
      'Content-Type': 'application/json',
      ...((opts.headers as Record<string, string>) || {}),
    },
  });
}

// =============================================================================
// TESTS
// =============================================================================

describe('Studio → Runtime API Routes', () => {
  // ---------------------------------------------------------------------------
  // GET /api/runtime/sessions — session list (proxy to Runtime)
  // ---------------------------------------------------------------------------
  describe('GET /api/runtime/sessions', () => {
    test('proxies GET to project-scoped runtime URL with auth headers', async () => {
      const { GET } = await import('@/app/api/runtime/sessions/route');

      const req = makeRequest('http://localhost:3000/api/runtime/sessions?projectId=proj-1');
      const res = await GET(req);

      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3112/api/projects/proj-1/sessions',
        expect.objectContaining({
          cache: 'no-store',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-jwt-token',
            'X-Tenant-Id': 'tenant-1',
          }),
        }),
      );
      expect(mockListSessions).not.toHaveBeenCalled();
    });

    test('returns 400 when projectId is missing', async () => {
      const { GET } = await import('@/app/api/runtime/sessions/route');

      const req = makeRequest('http://localhost:3000/api/runtime/sessions');
      const res = await GET(req);

      expect(res.status).toBe(400);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test('forwards status, channel, and pagination filters to runtime', async () => {
      const { GET } = await import('@/app/api/runtime/sessions/route');

      const req = makeRequest(
        'http://localhost:3000/api/runtime/sessions?projectId=proj-1&status=active&channel=web&limit=100&offset=20',
      );
      await GET(req);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3112/api/projects/proj-1/sessions?status=active&channel=web&limit=100&offset=20',
        expect.any(Object),
      );
    });

    test('returns 502 when runtime proxy fails', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Runtime unavailable'));

      const { GET } = await import('@/app/api/runtime/sessions/route');

      const req = makeRequest('http://localhost:3000/api/runtime/sessions?projectId=proj-1');
      const res = await GET(req);

      expect(res.status).toBe(502);
    });
  });

  describe('GET /api/runtime/sessions/current', () => {
    test('proxies current developer session lookup to the project-scoped runtime URL', async () => {
      const { GET } = await import('@/app/api/runtime/sessions/current/route');

      const req = makeRequest(
        'http://localhost:3000/api/runtime/sessions/current?projectId=proj-1&channel=web_debug',
      );
      const res = await GET(req);

      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3112/api/projects/proj-1/sessions/current?channel=web_debug',
        expect.objectContaining({
          cache: 'no-store',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-jwt-token',
            'X-Tenant-Id': 'tenant-1',
          }),
        }),
      );
    });

    test('returns 400 when projectId is missing for current developer session lookup', async () => {
      const { GET } = await import('@/app/api/runtime/sessions/current/route');

      const req = makeRequest('http://localhost:3000/api/runtime/sessions/current');
      const res = await GET(req);

      expect(res.status).toBe(400);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/runtime/sessions/attach', () => {
    test('proxies attach validation to the project-scoped runtime URL', async () => {
      const { POST } = await import('@/app/api/runtime/sessions/attach/route');

      const req = makeRequest(
        'http://localhost:3000/api/runtime/sessions/attach?projectId=proj-1',
        {
          method: 'POST',
          body: JSON.stringify({ sessionId: 'sess-123' }),
        },
      );
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3112/api/projects/proj-1/sessions/attach',
        expect.objectContaining({
          method: 'POST',
          cache: 'no-store',
          body: JSON.stringify({ sessionId: 'sess-123' }),
          headers: expect.objectContaining({
            Authorization: 'Bearer test-jwt-token',
            'X-Tenant-Id': 'tenant-1',
            'Content-Type': 'application/json',
          }),
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/runtime/sessions/:id — session detail (proxies to Runtime)
  // ---------------------------------------------------------------------------
  describe('GET /api/runtime/sessions/:id', () => {
    test('proxies GET to project-scoped runtime URL with auth headers', async () => {
      const { GET } = await import('@/app/api/runtime/sessions/[id]/route');

      const req = makeRequest(
        'http://localhost:3000/api/runtime/sessions/sess-123?projectId=proj-1',
      );
      const res = await GET(req, { params: Promise.resolve({ id: 'sess-123' }) });

      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3112/api/projects/proj-1/sessions/sess-123',
        expect.objectContaining({
          cache: 'no-store',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-jwt-token',
            'X-Tenant-Id': 'tenant-1',
          }),
        }),
      );
      // Should NOT use direct MongoDB — proxies to Runtime
      expect(mockFindSession).not.toHaveBeenCalled();
    });

    test('returns 400 when projectId is missing', async () => {
      const { GET } = await import('@/app/api/runtime/sessions/[id]/route');

      const req = makeRequest('http://localhost:3000/api/runtime/sessions/sess-123');
      const res = await GET(req, { params: Promise.resolve({ id: 'sess-123' }) });

      expect(res.status).toBe(400);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test('passes AbortSignal to fetch for timeout protection', async () => {
      const { GET } = await import('@/app/api/runtime/sessions/[id]/route');

      const req = makeRequest(
        'http://localhost:3000/api/runtime/sessions/sess-123?projectId=proj-1',
      );
      await GET(req, { params: Promise.resolve({ id: 'sess-123' }) });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
    });

    test('forwards non-project query params to the runtime detail route', async () => {
      const { GET } = await import('@/app/api/runtime/sessions/[id]/route');

      const req = makeRequest(
        'http://localhost:3000/api/runtime/sessions/sess-123?projectId=proj-1&includeTraces=false',
      );
      await GET(req, { params: Promise.resolve({ id: 'sess-123' }) });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3112/api/projects/proj-1/sessions/sess-123?includeTraces=false',
        expect.any(Object),
      );
    });

    test('returns no-store Cache-Control even when upstream is cacheable', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, session: {} }),
        text: async () => JSON.stringify({ success: true, session: {} }),
        headers: new Headers({ 'Cache-Control': 'public, max-age=300' }),
      });

      const { GET } = await import('@/app/api/runtime/sessions/[id]/route');

      const req = makeRequest(
        'http://localhost:3000/api/runtime/sessions/sess-123?projectId=proj-1',
      );
      const res = await GET(req, { params: Promise.resolve({ id: 'sess-123' }) });

      expect(res.headers.get('Cache-Control')).toBe('no-store');
    });

    test('returns 502 with structured error body when runtime fetch fails', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const { GET } = await import('@/app/api/runtime/sessions/[id]/route');

      const req = makeRequest(
        'http://localhost:3000/api/runtime/sessions/sess-123?projectId=proj-1',
      );
      const res = await GET(req, { params: Promise.resolve({ id: 'sess-123' }) });

      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body).toEqual({
        success: false,
        error: { code: 'PROXY_ERROR', message: 'Failed to fetch session from runtime' },
      });
    });

    test('forwards upstream status code from Runtime', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ success: false, error: 'Session not found' }),
        text: async () => JSON.stringify({ success: false, error: 'Session not found' }),
        headers: new Headers(),
      });

      const { GET } = await import('@/app/api/runtime/sessions/[id]/route');

      const req = makeRequest(
        'http://localhost:3000/api/runtime/sessions/sess-123?projectId=proj-1',
      );
      const res = await GET(req, { params: Promise.resolve({ id: 'sess-123' }) });

      expect(res.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/runtime/sessions/:id/traces — session traces (proxies to Runtime)
  // ---------------------------------------------------------------------------
  describe('GET /api/runtime/sessions/:id/traces', () => {
    test('proxies GET to project-scoped traces URL with auth headers and no-store cache', async () => {
      const { GET } = await import('@/app/api/runtime/sessions/[id]/traces/route');

      const req = makeRequest(
        'http://localhost:3000/api/runtime/sessions/sess-123/traces?projectId=proj-1&limit=50',
      );
      const res = await GET(req, { params: Promise.resolve({ id: 'sess-123' }) });

      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3112/api/projects/proj-1/sessions/sess-123/traces?limit=50',
        expect.objectContaining({
          cache: 'no-store',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-jwt-token',
            'X-Tenant-Id': 'tenant-1',
          }),
        }),
      );
    });

    test('returns no-store Cache-Control for traces responses', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, traces: [] }),
        text: async () => JSON.stringify({ success: true, traces: [] }),
        headers: new Headers({ 'Cache-Control': 'public, max-age=300' }),
      });

      const { GET } = await import('@/app/api/runtime/sessions/[id]/traces/route');

      const req = makeRequest(
        'http://localhost:3000/api/runtime/sessions/sess-123/traces?projectId=proj-1',
      );
      const res = await GET(req, { params: Promise.resolve({ id: 'sess-123' }) });

      expect(res.headers.get('Cache-Control')).toBe('no-store');
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/runtime/sessions/:id/agent-spec — session agent spec (proxies to Runtime)
  // ---------------------------------------------------------------------------
  describe('GET /api/runtime/sessions/:id/agent-spec', () => {
    test('proxies GET to project-scoped agent-spec URL with auth headers and no-store cache', async () => {
      const { GET } = await import('@/app/api/runtime/sessions/[id]/agent-spec/route');

      const req = makeRequest(
        'http://localhost:3000/api/runtime/sessions/sess-123/agent-spec?projectId=proj-1',
      );
      const res = await GET(req, { params: Promise.resolve({ id: 'sess-123' }) });

      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3112/api/projects/proj-1/sessions/sess-123/agent-spec',
        expect.objectContaining({
          cache: 'no-store',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-jwt-token',
            'X-Tenant-Id': 'tenant-1',
          }),
        }),
      );
    });

    test('returns 400 when projectId is missing', async () => {
      const { GET } = await import('@/app/api/runtime/sessions/[id]/agent-spec/route');

      const req = makeRequest('http://localhost:3000/api/runtime/sessions/sess-123/agent-spec');
      const res = await GET(req, { params: Promise.resolve({ id: 'sess-123' }) });

      expect(res.status).toBe(400);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/runtime/sessions/:id — session delete (proxies to runtime)
  // ---------------------------------------------------------------------------
  describe('DELETE /api/runtime/sessions/:id', () => {
    test('proxies DELETE to project-scoped runtime URL', async () => {
      const { DELETE } = await import('@/app/api/runtime/sessions/[id]/route');

      const req = makeRequest(
        'http://localhost:3000/api/runtime/sessions/sess-123?projectId=proj-1',
        {
          method: 'DELETE',
        },
      );
      await DELETE(req, { params: Promise.resolve({ id: 'sess-123' }) });

      const [url, fetchOpts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:3112/api/projects/proj-1/sessions/sess-123');
      expect(fetchOpts.method).toBe('DELETE');
    });

    test('returns 400 when projectId is missing', async () => {
      const { DELETE } = await import('@/app/api/runtime/sessions/[id]/route');

      const req = makeRequest('http://localhost:3000/api/runtime/sessions/sess-123', {
        method: 'DELETE',
      });
      const res = await DELETE(req, { params: Promise.resolve({ id: 'sess-123' }) });

      expect(res.status).toBe(400);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test('forwards runtime status code', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        json: async () => ({ success: true }),
        text: async () => JSON.stringify({ success: true }),
      });

      const { DELETE } = await import('@/app/api/runtime/sessions/[id]/route');

      const req = makeRequest(
        'http://localhost:3000/api/runtime/sessions/sess-123?projectId=proj-1',
        {
          method: 'DELETE',
        },
      );
      const res = await DELETE(req, { params: Promise.resolve({ id: 'sess-123' }) });

      expect(res.status).toBe(204);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/runtime/sessions/:id/close — proxies to runtime
  // ---------------------------------------------------------------------------
  describe('POST /api/runtime/sessions/:id/close', () => {
    test('proxies POST to project-scoped runtime URL', async () => {
      const { POST } = await import('@/app/api/runtime/sessions/[id]/close/route');

      const body = JSON.stringify({ disposition: 'completed' });
      const req = makeRequest(
        'http://localhost:3000/api/runtime/sessions/sess-123/close?projectId=proj-1',
        {
          method: 'POST',
          body,
        },
      );
      await POST(req, { params: Promise.resolve({ id: 'sess-123' }) });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, fetchOpts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:3112/api/projects/proj-1/sessions/sess-123/close');
      expect(fetchOpts.method).toBe('POST');
    });

    test('returns 400 when projectId is missing', async () => {
      const { POST } = await import('@/app/api/runtime/sessions/[id]/close/route');

      const req = makeRequest('http://localhost:3000/api/runtime/sessions/sess-1/close', {
        method: 'POST',
        body: '{}',
      });
      const res = await POST(req, { params: Promise.resolve({ id: 'sess-1' }) });

      expect(res.status).toBe(400);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test('returns 502 on fetch failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('connection reset'));

      const { POST } = await import('@/app/api/runtime/sessions/[id]/close/route');

      const req = makeRequest(
        'http://localhost:3000/api/runtime/sessions/sess-1/close?projectId=proj-1',
        {
          method: 'POST',
          body: '{}',
        },
      );
      const res = await POST(req, { params: Promise.resolve({ id: 'sess-1' }) });
      const body = await res.json();

      expect(res.status).toBe(502);
      expect(body.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/runtime/sessions/:id/pii/reveal — exact-gated PII reveal proxy
  // ---------------------------------------------------------------------------
  describe('POST /api/runtime/sessions/:id/pii/reveal', () => {
    test('proxies reveal to project-scoped runtime URL only after exact pii reveal permission', async () => {
      const { POST } = await import('@/app/api/runtime/sessions/[id]/pii/reveal/route');

      const body = JSON.stringify({
        reason: 'Compliance review',
        sourceRefs: [{ sourceMessageId: 'msg-1' }],
      });
      const req = makeRequest(
        'http://localhost:3000/api/runtime/sessions/sess-123/pii/reveal?projectId=proj-1',
        {
          method: 'POST',
          body,
        },
      );
      const res = await POST(req, { params: Promise.resolve({ id: 'sess-123' }) });

      expect(res.status).toBe(200);
      expect(mockRequireProjectPermission).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({ id: 'user-1' }),
        'pii:reveal',
      );
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3112/api/projects/proj-1/sessions/sess-123/pii/reveal',
        expect.objectContaining({
          method: 'POST',
          body,
          cache: 'no-store',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-jwt-token',
            'Content-Type': 'application/json',
            'X-Tenant-Id': 'tenant-1',
          }),
        }),
      );
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    });

    test('returns 400 when projectId is missing', async () => {
      const { POST } = await import('@/app/api/runtime/sessions/[id]/pii/reveal/route');

      const req = makeRequest('http://localhost:3000/api/runtime/sessions/sess-1/pii/reveal', {
        method: 'POST',
        body: '{}',
      });
      const res = await POST(req, { params: Promise.resolve({ id: 'sess-1' }) });

      expect(res.status).toBe(400);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(mockRequireProjectPermission).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test('does not proxy when exact pii reveal permission is denied', async () => {
      mockRequireProjectPermission.mockResolvedValueOnce(
        NextResponse.json(
          { success: false, errors: [{ msg: 'Forbidden', code: 'FORBIDDEN' }] },
          { status: 403 },
        ),
      );
      const { POST } = await import('@/app/api/runtime/sessions/[id]/pii/reveal/route');

      const req = makeRequest(
        'http://localhost:3000/api/runtime/sessions/sess-1/pii/reveal?projectId=proj-1',
        {
          method: 'POST',
          body: '{}',
        },
      );
      const res = await POST(req, { params: Promise.resolve({ id: 'sess-1' }) });

      expect(res.status).toBe(403);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/projects/:id/permissions/pii-reveal — exact permission probe
  // ---------------------------------------------------------------------------
  describe('GET /api/projects/:id/permissions/pii-reveal', () => {
    test('returns canRevealPII true when exact permission resolves', async () => {
      const { GET } = await import('@/app/api/projects/[id]/permissions/pii-reveal/route');

      const req = makeRequest('http://localhost:3000/api/projects/proj-1/permissions/pii-reveal');
      const res = await GET(req, { params: Promise.resolve({ id: 'proj-1' }) });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ success: true, canRevealPII: true });
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(mockRequireProjectPermission).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({ id: 'user-1' }),
        'pii:reveal',
      );
    });

    test('returns exact permission denial response', async () => {
      mockRequireProjectPermission.mockResolvedValueOnce(
        NextResponse.json(
          { success: false, errors: [{ msg: 'Forbidden', code: 'FORBIDDEN' }] },
          { status: 403 },
        ),
      );
      const { GET } = await import('@/app/api/projects/[id]/permissions/pii-reveal/route');

      const req = makeRequest('http://localhost:3000/api/projects/proj-1/permissions/pii-reveal');
      const res = await GET(req, { params: Promise.resolve({ id: 'proj-1' }) });

      expect(res.status).toBe(403);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/runtime/sessions/bulk-close — proxies to runtime
  // ---------------------------------------------------------------------------
  describe('POST /api/runtime/sessions/bulk-close', () => {
    test('proxies POST to project-scoped runtime URL', async () => {
      const { POST } = await import('@/app/api/runtime/sessions/bulk-close/route');

      const body = JSON.stringify({ projectId: 'proj-1' });
      const req = makeRequest('http://localhost:3000/api/runtime/sessions/bulk-close', {
        method: 'POST',
        body,
      });
      await POST(req);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, fetchOpts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:3112/api/projects/proj-1/sessions/bulk-close');
      expect(fetchOpts.method).toBe('POST');
    });

    test('returns 400 when projectId is missing from body', async () => {
      const { POST } = await import('@/app/api/runtime/sessions/bulk-close/route');

      const req = makeRequest('http://localhost:3000/api/runtime/sessions/bulk-close', {
        method: 'POST',
        body: '{}',
      });
      const res = await POST(req);

      expect(res.status).toBe(400);
    });

    test('forwards request body to runtime', async () => {
      const { POST } = await import('@/app/api/runtime/sessions/bulk-close/route');

      const reqBody = JSON.stringify({ projectId: 'proj-1', agentName: 'my_agent' });
      const req = makeRequest('http://localhost:3000/api/runtime/sessions/bulk-close', {
        method: 'POST',
        body: reqBody,
      });
      await POST(req);

      const [, fetchOpts] = mockFetch.mock.calls[0];
      expect(fetchOpts.body).toBe(reqBody);
    });

    test('returns 502 on fetch failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('DNS fail'));

      const { POST } = await import('@/app/api/runtime/sessions/bulk-close/route');

      const req = makeRequest('http://localhost:3000/api/runtime/sessions/bulk-close', {
        method: 'POST',
        body: JSON.stringify({ projectId: 'proj-1' }),
      });
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(502);
      expect(body.success).toBe(false);
    });
  });

  describe('GET /api/runtime/pipeline-analytics', () => {
    test('translates query-shaped Studio request to project-scoped runtime path', async () => {
      const { GET } = await import('@/app/api/runtime/pipeline-analytics/route');

      const req = makeRequest(
        'http://localhost:3000/api/runtime/pipeline-analytics?projectId=proj-1&pipelineType=knowledge_gap&endpoint=breakdown&period=7d&dimension=agent_name',
      );
      const res = await GET(req);

      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3112/api/projects/proj-1/pipeline-analytics/knowledge_gap/breakdown?period=7d&dimension=agent_name',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-jwt-token',
            'X-Tenant-Id': 'tenant-1',
            'Content-Type': 'application/json',
          }),
        }),
      );
    });

    test('rejects missing pipeline analytics routing parameters', async () => {
      const { GET } = await import('@/app/api/runtime/pipeline-analytics/route');

      const req = makeRequest(
        'http://localhost:3000/api/runtime/pipeline-analytics?projectId=proj-1&pipelineType=knowledge_gap',
      );
      const res = await GET(req);
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body).toEqual({
        success: false,
        error: {
          code: 'MISSING_PARAM',
          message: 'projectId, pipelineType, and endpoint query parameters are required',
        },
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('Project config proxy permissions', () => {
    test('runtime-config proxy uses runtime_config object permissions', async () => {
      const route = await import('@/app/api/projects/[id]/runtime-config/route');
      const params = { params: Promise.resolve({ id: 'proj-1' }) };

      await route.GET(
        makeRequest('http://localhost:3000/api/projects/proj-1/runtime-config'),
        params,
      );
      await route.PUT(
        makeRequest('http://localhost:3000/api/projects/proj-1/runtime-config', {
          method: 'PUT',
          body: JSON.stringify({ extraction: { strategy: 'hybrid' } }),
        }),
        params,
      );
      await route.DELETE(
        makeRequest('http://localhost:3000/api/projects/proj-1/runtime-config', {
          method: 'DELETE',
        }),
        params,
      );

      expect(mockRequireProjectPermission).toHaveBeenNthCalledWith(
        1,
        'proj-1',
        expect.objectContaining({ tenantId: 'tenant-1' }),
        'runtime_config:read',
      );
      expect(mockRequireProjectPermission).toHaveBeenNthCalledWith(
        2,
        'proj-1',
        expect.objectContaining({ tenantId: 'tenant-1' }),
        'runtime_config:write',
      );
      expect(mockRequireProjectPermission).toHaveBeenNthCalledWith(
        3,
        'proj-1',
        expect.objectContaining({ tenantId: 'tenant-1' }),
        'runtime_config:write',
      );
    });

    test('llm-config proxy uses model_config object permissions', async () => {
      const route = await import('@/app/api/projects/[id]/llm-config/route');
      const params = { params: Promise.resolve({ id: 'proj-1' }) };

      await route.GET(makeRequest('http://localhost:3000/api/projects/proj-1/llm-config'), params);
      await route.PUT(
        makeRequest('http://localhost:3000/api/projects/proj-1/llm-config', {
          method: 'PUT',
          body: JSON.stringify({ operationTierOverrides: { response_gen: 'powerful' } }),
        }),
        params,
      );

      expect(mockRequireProjectPermission).toHaveBeenNthCalledWith(
        1,
        'proj-1',
        expect.objectContaining({ tenantId: 'tenant-1' }),
        'model_config:read',
      );
      expect(mockRequireProjectPermission).toHaveBeenNthCalledWith(
        2,
        'proj-1',
        expect.objectContaining({ tenantId: 'tenant-1' }),
        'model_config:write',
      );
    });

    test('llm-config proxy URL-encodes project ids before calling runtime', async () => {
      const route = await import('@/app/api/projects/[id]/llm-config/route');
      const params = { params: Promise.resolve({ id: 'project with/slash' }) };

      await route.GET(
        makeRequest('http://localhost:3000/api/projects/project%20with%2Fslash/llm-config'),
        params,
      );

      expect(mockRequireProjectPermission).toHaveBeenCalledWith(
        'project with/slash',
        expect.objectContaining({ tenantId: 'tenant-1' }),
        'model_config:read',
      );
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3112/api/projects/project%20with%2Fslash/llm-config',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-jwt-token',
            'X-Tenant-Id': 'tenant-1',
          }),
        }),
      );
    });
  });

  describe('Insights dashboard analytics proxy routes', () => {
    test('GET /api/runtime/analytics proxies to the project analytics endpoint with forwarded filters', async () => {
      const { GET } = await import('@/app/api/runtime/analytics/route');

      const req = makeRequest(
        'http://localhost:3000/api/runtime/analytics?projectId=proj-1&endpoint=session-metrics&range=30d',
      );
      const res = await GET(req);

      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3112/api/projects/proj-1/analytics/session-metrics?range=30d',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-jwt-token',
            'X-Tenant-Id': 'tenant-1',
          }),
        }),
      );
    });

    test('GET /api/runtime/pipeline-analytics proxies to the pipeline endpoint with query params preserved', async () => {
      const { GET } = await import('@/app/api/runtime/pipeline-analytics/route');

      const req = makeRequest(
        'http://localhost:3000/api/runtime/pipeline-analytics?projectId=proj-1&pipelineType=quality_evaluation&endpoint=breakdown&period=30d&dimension=agent_name',
      );
      const res = await GET(req);

      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3112/api/projects/proj-1/pipeline-analytics/quality_evaluation/breakdown?period=30d&dimension=agent_name',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-jwt-token',
            'X-Tenant-Id': 'tenant-1',
          }),
        }),
      );
    });

    test('GET /api/runtime/insights proxies to the project insights endpoint with days preserved', async () => {
      const { GET } = await import('@/app/api/runtime/insights/route');

      const req = makeRequest(
        'http://localhost:3000/api/runtime/insights?projectId=proj-1&endpoint=timeseries&days=90',
      );
      const res = await GET(req);

      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3112/api/projects/proj-1/insights/timeseries?days=90',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-jwt-token',
            'X-Tenant-Id': 'tenant-1',
          }),
        }),
      );
    });

    test.each([
      ['analytics', '@/app/api/runtime/analytics/route', 'projectId=proj-1'],
      ['pipeline-analytics', '@/app/api/runtime/pipeline-analytics/route', 'projectId=proj-1'],
      ['insights', '@/app/api/runtime/insights/route', 'projectId=proj-1'],
    ])('GET /api/runtime/%s rejects incomplete proxy parameters', async (_name, routePath, qs) => {
      const { GET } = await import(routePath);

      const req = makeRequest(`http://localhost:3000/api/runtime/unused?${qs}`);
      const res = await GET(req);

      expect(res.status).toBe(400);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-cutting: Auth rejection
  // ---------------------------------------------------------------------------
  describe('Auth rejection', () => {
    test('returns auth error when requireTenantAuth fails', async () => {
      const { requireTenantAuth, isAuthError } = await import('@/lib/auth');
      const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      vi.mocked(requireTenantAuth).mockResolvedValueOnce(authResponse as any);
      vi.mocked(isAuthError).mockReturnValueOnce(true);

      const { GET } = await import('@/app/api/runtime/sessions/route');

      const req = makeRequest('http://localhost:3000/api/runtime/sessions?projectId=proj-1');
      const res = await GET(req);

      expect(res.status).toBe(401);
      // Should NOT have queried database or proxied to runtime
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/tenant-models', () => {
    test('forwards tenant model filters and pagination to runtime', async () => {
      const { GET } = await import('@/app/api/tenant-models/route');

      const req = makeRequest('http://localhost:3000/api/tenant-models?isActive=true&limit=100');
      const res = await GET(req);

      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3112/api/tenants/tenant-1/models?isActive=true&limit=100',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-jwt-token',
            'X-Tenant-Id': 'tenant-1',
          }),
        }),
      );
    });
  });
});

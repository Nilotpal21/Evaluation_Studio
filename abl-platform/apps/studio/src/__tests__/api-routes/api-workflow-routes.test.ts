/**
 * Workflow CRUD API Route Tests
 *
 * Verifies that Studio Next.js API routes correctly proxy workflow operations
 * to the runtime (CRUD) and workflow-engine (execution) services.
 *
 * Routes under test:
 *   GET    /api/projects/:id/workflows                          → Runtime  GET  /api/projects/:id/workflows
 *   POST   /api/projects/:id/workflows                          → Runtime  POST /api/projects/:id/workflows
 *   GET    /api/projects/:id/workflows/:wfId                    → Runtime  GET  /api/projects/:id/workflows/:wfId
 *   PATCH  /api/projects/:id/workflows/:wfId                    → Runtime  PUT  /api/projects/:id/workflows/:wfId
 *   DELETE /api/projects/:id/workflows/:wfId                    → Runtime  POST /api/projects/:id/workflows/:wfId/archive
 *   POST   /api/projects/:id/workflows/:wfId/execute            → Runtime  POST /api/projects/:id/workflows/:wfId/executions/execute?mode=async
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { getRuntimeUrl } from '../../config/runtime.server';

// =============================================================================
// MOCKS
// =============================================================================

// Auth — withRouteHandler calls requireAuth + isAuthError internally
const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);

vi.mock('@/lib/auth', () => ({
  requireAuth: mockRequireAuth,
  isAuthError: mockIsAuthError,
}));

// Transitive auth dependencies
vi.mock('@/services/auth-service', () => ({ verifyAccessToken: vi.fn() }));
vi.mock('@/repos/auth-repo', () => ({ findUserById: vi.fn() }));

// Project access — withRouteHandler calls requireProjectAccess + isAccessError
const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn(() => false);

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: mockRequireProjectAccess,
  isAccessError: mockIsAccessError,
}));

// Permissions — withRouteHandler checks hasPermission/hasAnyPermission
vi.mock('@/lib/permission-resolver', () => ({
  hasPermission: vi.fn(() => true),
  hasAnyPermission: vi.fn(() => true),
}));

// =============================================================================
// CONSTANTS
// =============================================================================

const ENGINE_URL = 'http://localhost:9080';
const PROJECT_ID = 'proj-1';
const WORKFLOW_ID = 'wf-abc-123';

const testUser = {
  id: 'user-1',
  email: 'test@test.com',
  name: 'Test User',
  tenantId: 'tenant-1',
  permissions: [
    'workflow:read',
    'workflow:create',
    'workflow:update',
    'workflow:delete',
    'workflow:execute',
  ],
};

const testProject = {
  _id: PROJECT_ID,
  tenantId: 'tenant-1',
  name: 'Test Project',
};

// =============================================================================
// HELPERS
// =============================================================================

const mockFetch = vi.fn();

function makeRequest(url: string, opts: Record<string, any> = {}) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    ...opts,
    headers: {
      Authorization: 'Bearer test-jwt-token',
      'Content-Type': 'application/json',
      ...((opts.headers as Record<string, string>) || {}),
    },
  });
}

/** Route context with params wrapped in a Promise (Next.js 15 convention) */
function routeCtx(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function expectedRuntimeUrl(): string {
  return getRuntimeUrl();
}

// =============================================================================
// SETUP
// =============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();

  // Auth succeeds by default
  mockRequireAuth.mockResolvedValue(testUser);
  mockIsAuthError.mockReturnValue(false);

  // Project access succeeds by default
  mockRequireProjectAccess.mockResolvedValue({ project: testProject });
  mockIsAccessError.mockReturnValue(false);

  // Fetch returns a standard success response
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ success: true, data: [] }),
  });
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// =============================================================================
// TESTS
// =============================================================================

describe('Workflow CRUD API Route Proxies', () => {
  // ---------------------------------------------------------------------------
  // GET /workflows — List
  // ---------------------------------------------------------------------------
  describe('GET /workflows (list)', () => {
    test('proxies to runtime with correct path', async () => {
      const { GET } = await import('@/app/api/projects/[id]/workflows/route');
      const req = makeRequest(`http://localhost:3000/api/projects/${PROJECT_ID}/workflows`);

      await GET(req, routeCtx({ id: PROJECT_ID }));

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${expectedRuntimeUrl()}/api/projects/${PROJECT_ID}/workflows`);
      expect(opts.method).toBe('GET');
    });

    test('forwards X-Tenant-Id header', async () => {
      const { GET } = await import('@/app/api/projects/[id]/workflows/route');
      const req = makeRequest(`http://localhost:3000/api/projects/${PROJECT_ID}/workflows`);

      await GET(req, routeCtx({ id: PROJECT_ID }));

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers['X-Tenant-Id']).toBe('tenant-1');
    });
  });

  // ---------------------------------------------------------------------------
  // POST /workflows — Create
  // ---------------------------------------------------------------------------
  describe('POST /workflows (create)', () => {
    test('proxies to runtime with body forwarded', async () => {
      const { POST } = await import('@/app/api/projects/[id]/workflows/route');
      const body = { name: 'My Workflow', description: 'Does stuff' };
      const req = makeRequest(`http://localhost:3000/api/projects/${PROJECT_ID}/workflows`, {
        method: 'POST',
        body: JSON.stringify(body),
      });

      await POST(req, routeCtx({ id: PROJECT_ID }));

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${expectedRuntimeUrl()}/api/projects/${PROJECT_ID}/workflows`);
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual(body);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /workflows/:wfId — Detail
  // ---------------------------------------------------------------------------
  describe('GET /workflows/:wfId (detail)', () => {
    test('proxies to runtime with workflow ID in path', async () => {
      const { GET } = await import('@/app/api/projects/[id]/workflows/[workflowId]/route');
      const req = makeRequest(
        `http://localhost:3000/api/projects/${PROJECT_ID}/workflows/${WORKFLOW_ID}`,
      );

      await GET(req, routeCtx({ id: PROJECT_ID, workflowId: WORKFLOW_ID }));

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe(
        `${expectedRuntimeUrl()}/api/projects/${PROJECT_ID}/workflows/${WORKFLOW_ID}`,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // PATCH /workflows/:wfId — Update (translated to PUT)
  // ---------------------------------------------------------------------------
  describe('PATCH /workflows/:wfId (update → PUT)', () => {
    test('translates PATCH to PUT when proxying to runtime', async () => {
      const { PATCH } = await import('@/app/api/projects/[id]/workflows/[workflowId]/route');
      const body = { name: 'Updated Name', steps: [] };
      const req = makeRequest(
        `http://localhost:3000/api/projects/${PROJECT_ID}/workflows/${WORKFLOW_ID}`,
        { method: 'PATCH', body: JSON.stringify(body) },
      );

      await PATCH(req, routeCtx({ id: PROJECT_ID, workflowId: WORKFLOW_ID }));

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(
        `${expectedRuntimeUrl()}/api/projects/${PROJECT_ID}/workflows/${WORKFLOW_ID}`,
      );
      expect(opts.method).toBe('PUT');
      expect(JSON.parse(opts.body)).toEqual(body);
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /workflows/:wfId — Soft-delete
  // ---------------------------------------------------------------------------
  describe('DELETE /workflows/:wfId', () => {
    test('proxies DELETE to runtime', async () => {
      const { DELETE } = await import('@/app/api/projects/[id]/workflows/[workflowId]/route');
      const req = makeRequest(
        `http://localhost:3000/api/projects/${PROJECT_ID}/workflows/${WORKFLOW_ID}`,
        { method: 'DELETE' },
      );

      await DELETE(req, routeCtx({ id: PROJECT_ID, workflowId: WORKFLOW_ID }));

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(
        `${expectedRuntimeUrl()}/api/projects/${PROJECT_ID}/workflows/${WORKFLOW_ID}`,
      );
      expect(opts.method).toBe('DELETE');
    });
  });

  // ---------------------------------------------------------------------------
  // POST /workflows/:wfId/execute — Execute (proxied to workflow-engine)
  // ---------------------------------------------------------------------------
  describe('POST /workflows/:wfId/execute (→ engine)', () => {
    test('proxies to workflow-engine with the async execution path', async () => {
      const { POST } = await import('@/app/api/projects/[id]/workflows/[workflowId]/execute/route');
      const body = { input: { message: 'hello' } };
      const req = makeRequest(
        `http://localhost:3000/api/projects/${PROJECT_ID}/workflows/${WORKFLOW_ID}/execute`,
        { method: 'POST', body: JSON.stringify(body) },
      );

      await POST(req, routeCtx({ id: PROJECT_ID, workflowId: WORKFLOW_ID }));

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(
        `${expectedRuntimeUrl()}/api/projects/${PROJECT_ID}/workflows/${WORKFLOW_ID}/executions/execute?mode=async`,
      );
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual(body);
    });

    test('forwards X-Tenant-Id header to workflow-engine', async () => {
      const { POST } = await import('@/app/api/projects/[id]/workflows/[workflowId]/execute/route');
      const req = makeRequest(
        `http://localhost:3000/api/projects/${PROJECT_ID}/workflows/${WORKFLOW_ID}/execute`,
        { method: 'POST', body: JSON.stringify({}) },
      );

      await POST(req, routeCtx({ id: PROJECT_ID, workflowId: WORKFLOW_ID }));

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers['X-Tenant-Id']).toBe('tenant-1');
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-cutting: Auth rejection
  // ---------------------------------------------------------------------------
  describe('Auth rejection', () => {
    test('returns 401 when requireAuth fails', async () => {
      const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      mockRequireAuth.mockResolvedValue(authResponse);
      mockIsAuthError.mockReturnValue(true);

      const { GET } = await import('@/app/api/projects/[id]/workflows/route');
      const req = makeRequest(`http://localhost:3000/api/projects/${PROJECT_ID}/workflows`);

      const res = await GET(req, routeCtx({ id: PROJECT_ID }));

      expect(res.status).toBe(401);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-cutting: Project access rejection
  // ---------------------------------------------------------------------------
  describe('Project access rejection', () => {
    test('returns 403 when requireProjectAccess fails', async () => {
      const accessResponse = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      mockRequireProjectAccess.mockResolvedValue(accessResponse);
      mockIsAccessError.mockReturnValue(true);

      const { GET } = await import('@/app/api/projects/[id]/workflows/route');
      const req = makeRequest(`http://localhost:3000/api/projects/${PROJECT_ID}/workflows`);

      const res = await GET(req, routeCtx({ id: PROJECT_ID }));

      expect(res.status).toBe(403);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});

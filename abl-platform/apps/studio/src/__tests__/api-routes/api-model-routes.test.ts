/**
 * Tests for Model / Tenant-Model API Routes
 *
 * Covers:
 *   GET/POST /api/tenant-models                              - List / create tenant models (proxy)
 *   GET/PATCH/DELETE /api/tenant-models/:id                   - Detail / update / deactivate (proxy)
 *   GET/POST /api/tenant-models/:id/connections               - List / create connections (proxy)
 *   PATCH/DELETE /api/tenant-models/:id/connections/:connId   - Update / remove connections (proxy)
 *   POST /api/tenant-models/:id/toggle-inference              - Toggle inference (proxy)
 *   GET  /api/model-catalog                                   - Model catalog (proxy)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);

vi.mock('@/lib/auth', () => ({
  requireAuth: mockRequireAuth,
  requireTenantAuth: mockRequireAuth,
  isAuthError: mockIsAuthError,
}));

vi.mock('@/services/auth-service', () => ({
  verifyAccessToken: vi.fn(),
}));

vi.mock('@/repos/auth-repo', () => ({
  findUserById: vi.fn(),
}));

const mockProxyToRuntime = vi.fn();
vi.mock('@/lib/runtime-proxy', () => ({
  proxyToRuntime: mockProxyToRuntime,
  buildRuntimeProxyHeaders: vi.fn((request: any, tenantId: string) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const auth = request.headers?.get?.('Authorization');
    if (auth) headers['Authorization'] = auth;
    headers['X-Tenant-Id'] = tenantId;
    return headers;
  }),
}));

vi.mock('@agent-platform/openapi/nextjs', () => ({
  withOpenAPI: (_schema: unknown, handler: Function) => handler,
}));

// Mock global fetch for the routes that directly use fetch (not proxyToRuntime)
const mockFetch = vi.fn();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testUser = { id: 'user-1', email: 'test@test.com', name: 'Test User', tenantId: 'tenant-1' };

function makeRequest(url: string, body?: unknown, method = 'POST'): NextRequest {
  const opts: any = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-jwt',
    },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  return new NextRequest(new URL(url, 'http://localhost:3000'), opts);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue(testUser);
  mockIsAuthError.mockReturnValue(false);

  // Default fetch mock
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ success: true }),
  });
  vi.stubGlobal('fetch', mockFetch);
});

// ===========================================================================
// GET /api/tenant-models
// ===========================================================================

describe('GET /api/tenant-models', () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/tenant-models/route');
    handler = mod.GET;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = new NextRequest(new URL('/api/tenant-models', 'http://localhost:3000'));
    const res = await handler(req);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no tenant context', async () => {
    // requireTenantAuth returns 403 when tenantId is missing
    const authResponse = NextResponse.json(
      { success: false, error: { code: 'FORBIDDEN', message: 'Tenant context required' } },
      { status: 403 },
    );
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = new NextRequest(new URL('/api/tenant-models', 'http://localhost:3000'));
    const res = await handler(req);
    expect(res.status).toBe(403);
  });

  it('proxies to runtime on success', async () => {
    mockProxyToRuntime.mockResolvedValue(
      NextResponse.json({ models: [{ id: 'm-1', name: 'GPT-4' }] }),
    );

    const req = new NextRequest(new URL('/api/tenant-models', 'http://localhost:3000'));
    const res = await handler(req);
    expect(res.status).toBe(200);

    expect(mockProxyToRuntime).toHaveBeenCalledWith(
      req,
      '/api/tenants/tenant-1/models',
      expect.objectContaining({ tenantId: 'tenant-1' }),
    );
  });

  it('returns 502 when proxy fails', async () => {
    mockProxyToRuntime.mockRejectedValue(new Error('Connection refused'));

    const req = new NextRequest(new URL('/api/tenant-models', 'http://localhost:3000'));
    const res = await handler(req);
    expect(res.status).toBe(502);

    const body = await res.json();
    expect(body.error).toContain('Failed to fetch');
  });
});

// ===========================================================================
// POST /api/tenant-models
// ===========================================================================

describe('POST /api/tenant-models', () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/tenant-models/route');
    handler = mod.POST;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = makeRequest('/api/tenant-models', { displayName: 'Model' });
    const res = await handler(req);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no tenant context', async () => {
    // requireTenantAuth returns 403 when tenantId is missing
    mockRequireAuth.mockResolvedValue(
      NextResponse.json(
        { success: false, error: { code: 'FORBIDDEN', message: 'Tenant context required' } },
        { status: 403 },
      ),
    );
    mockIsAuthError.mockReturnValue(true);

    const req = makeRequest('/api/tenant-models', { displayName: 'Model' });
    const res = await handler(req);
    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid body (missing displayName)', async () => {
    const req = makeRequest('/api/tenant-models', {});
    const res = await handler(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('Invalid request');
  });

  it('proxies to runtime on success', async () => {
    mockProxyToRuntime.mockResolvedValue(
      NextResponse.json({ id: 'm-new', name: 'My Model' }, { status: 201 }),
    );

    const req = makeRequest('/api/tenant-models', {
      displayName: 'My Model',
      provider: 'openai',
      modelId: 'gpt-4',
    });
    const res = await handler(req);
    expect(res.status).toBe(201); // Response comes from proxyToRuntime with 201

    expect(mockProxyToRuntime).toHaveBeenCalledWith(
      req,
      '/api/tenants/tenant-1/models',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({ displayName: 'My Model' }),
      }),
    );
  });

  it('returns 502 when proxy fails', async () => {
    mockProxyToRuntime.mockRejectedValue(new Error('Timeout'));

    const req = makeRequest('/api/tenant-models', { displayName: 'Model' });
    const res = await handler(req);
    expect(res.status).toBe(502);
  });
});

// ===========================================================================
// GET /api/tenant-models/:id
// ===========================================================================

describe('GET /api/tenant-models/:id', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/tenant-models/[id]/route');
    handler = mod.GET;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = new NextRequest(new URL('/api/tenant-models/m-1', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no tenant context', async () => {
    // requireTenantAuth returns 403 when tenantId is missing
    mockRequireAuth.mockResolvedValue(
      NextResponse.json(
        { success: false, error: { code: 'FORBIDDEN', message: 'Tenant context required' } },
        { status: 403 },
      ),
    );
    mockIsAuthError.mockReturnValue(true);

    const req = new NextRequest(new URL('/api/tenant-models/m-1', 'http://localhost:3000'));
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1' }) });
    expect(res.status).toBe(403);
  });

  it('proxies to runtime on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: 'm-1', name: 'GPT-4', provider: 'openai' }),
    });

    const req = new NextRequest(new URL('/api/tenant-models/m-1', 'http://localhost:3000'), {
      headers: { Authorization: 'Bearer test-jwt' },
    });
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1' }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.id).toBe('m-1');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/tenants/tenant-1/models/m-1');
  });

  it('returns 502 when runtime fetch fails', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const req = new NextRequest(new URL('/api/tenant-models/m-1', 'http://localhost:3000'), {
      headers: { Authorization: 'Bearer test-jwt' },
    });
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1' }) });
    expect(res.status).toBe(502);
  });
});

// ===========================================================================
// PATCH /api/tenant-models/:id
// ===========================================================================

describe('PATCH /api/tenant-models/:id', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/tenant-models/[id]/route');
    handler = mod.PATCH;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = makeRequest('/api/tenant-models/m-1', { name: 'Updated' }, 'PATCH');
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no tenant context', async () => {
    // requireTenantAuth returns 403 when tenantId is missing
    mockRequireAuth.mockResolvedValue(
      NextResponse.json(
        { success: false, error: { code: 'FORBIDDEN', message: 'Tenant context required' } },
        { status: 403 },
      ),
    );
    mockIsAuthError.mockReturnValue(true);

    const req = makeRequest('/api/tenant-models/m-1', { name: 'Updated' }, 'PATCH');
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1' }) });
    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid body', async () => {
    const req = makeRequest(
      '/api/tenant-models/m-1',
      {
        name: '', // min 1 char
      },
      'PATCH',
    );
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1' }) });
    expect(res.status).toBe(400);
  });

  it('proxies to runtime on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: 'm-1', name: 'Updated', isActive: true }),
    });

    const req = makeRequest('/api/tenant-models/m-1', { name: 'Updated' }, 'PATCH');
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1' }) });
    expect(res.status).toBe(200);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/tenants/tenant-1/models/m-1');
    expect(opts.method).toBe('PATCH');
  });

  it('returns 502 when runtime fetch fails', async () => {
    mockFetch.mockRejectedValue(new Error('Timeout'));

    const req = makeRequest('/api/tenant-models/m-1', { name: 'X' }, 'PATCH');
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1' }) });
    expect(res.status).toBe(502);
  });
});

// ===========================================================================
// DELETE /api/tenant-models/:id
// ===========================================================================

describe('DELETE /api/tenant-models/:id', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/tenant-models/[id]/route');
    handler = mod.DELETE;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = new NextRequest(new URL('/api/tenant-models/m-1', 'http://localhost:3000'), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-jwt' },
    });
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no tenant context', async () => {
    // requireTenantAuth returns 403 when tenantId is missing
    mockRequireAuth.mockResolvedValue(
      NextResponse.json(
        { success: false, error: { code: 'FORBIDDEN', message: 'Tenant context required' } },
        { status: 403 },
      ),
    );
    mockIsAuthError.mockReturnValue(true);

    const req = new NextRequest(new URL('/api/tenant-models/m-1', 'http://localhost:3000'), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-jwt' },
    });
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1' }) });
    expect(res.status).toBe(403);
  });

  it('proxies DELETE to runtime on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true }),
    });

    const req = new NextRequest(new URL('/api/tenant-models/m-1', 'http://localhost:3000'), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-jwt' },
    });
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1' }) });
    expect(res.status).toBe(200);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/tenants/tenant-1/models/m-1');
    expect(opts.method).toBe('DELETE');
  });

  it('returns 502 when runtime fetch fails', async () => {
    mockFetch.mockRejectedValue(new Error('Connection reset'));

    const req = new NextRequest(new URL('/api/tenant-models/m-1', 'http://localhost:3000'), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-jwt' },
    });
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1' }) });
    expect(res.status).toBe(502);
  });
});

// ===========================================================================
// GET /api/tenant-models/:id/connections
// ===========================================================================

describe('GET /api/tenant-models/:id/connections', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/tenant-models/[id]/connections/route');
    handler = mod.GET;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = new NextRequest(
      new URL('/api/tenant-models/m-1/connections', 'http://localhost:3000'),
    );
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no tenant context', async () => {
    // requireTenantAuth returns 403 when tenantId is missing
    mockRequireAuth.mockResolvedValue(
      NextResponse.json(
        { success: false, error: { code: 'FORBIDDEN', message: 'Tenant context required' } },
        { status: 403 },
      ),
    );
    mockIsAuthError.mockReturnValue(true);

    const req = new NextRequest(
      new URL('/api/tenant-models/m-1/connections', 'http://localhost:3000'),
    );
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1' }) });
    expect(res.status).toBe(403);
  });

  it('proxies to runtime on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ connections: [{ id: 'c-1', name: 'Production' }] }),
    });

    const req = new NextRequest(
      new URL('/api/tenant-models/m-1/connections', 'http://localhost:3000'),
      {
        headers: { Authorization: 'Bearer test-jwt' },
      },
    );
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1' }) });
    expect(res.status).toBe(200);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/tenants/tenant-1/models/m-1/connections');
  });

  it('returns 502 when runtime fetch fails', async () => {
    mockFetch.mockRejectedValue(new Error('DNS fail'));

    const req = new NextRequest(
      new URL('/api/tenant-models/m-1/connections', 'http://localhost:3000'),
      {
        headers: { Authorization: 'Bearer test-jwt' },
      },
    );
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1' }) });
    expect(res.status).toBe(502);
  });
});

// ===========================================================================
// POST /api/tenant-models/:id/connections
// ===========================================================================

describe('POST /api/tenant-models/:id/connections', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/tenant-models/[id]/connections/route');
    handler = mod.POST;
  });

  it('returns 403 when user has no tenant context', async () => {
    // requireTenantAuth returns 403 when tenantId is missing
    mockRequireAuth.mockResolvedValue(
      NextResponse.json(
        { success: false, error: { code: 'FORBIDDEN', message: 'Tenant context required' } },
        { status: 403 },
      ),
    );
    mockIsAuthError.mockReturnValue(true);

    const req = makeRequest('/api/tenant-models/m-1/connections', { name: 'New' });
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1' }) });
    expect(res.status).toBe(403);
  });

  it('proxies POST to runtime on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ id: 'c-new', name: 'Production' }),
    });

    const req = makeRequest('/api/tenant-models/m-1/connections', {
      name: 'Production',
      apiKey: 'sk-xxx',
    });
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1' }) });
    expect(res.status).toBe(201);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/tenants/tenant-1/models/m-1/connections');
    expect(opts.method).toBe('POST');
  });

  it('returns 502 when runtime fetch fails', async () => {
    mockFetch.mockRejectedValue(new Error('Timeout'));

    const req = makeRequest('/api/tenant-models/m-1/connections', { name: 'X' });
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1' }) });
    expect(res.status).toBe(502);
  });
});

// ===========================================================================
// PATCH /api/tenant-models/:id/connections/:connId
// ===========================================================================

describe('PATCH /api/tenant-models/:id/connections/:connId', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/tenant-models/[id]/connections/[connId]/route');
    handler = mod.PATCH;
  });

  it('returns 403 when user has no tenant context', async () => {
    // requireTenantAuth returns 403 when tenantId is missing
    mockRequireAuth.mockResolvedValue(
      NextResponse.json(
        { success: false, error: { code: 'FORBIDDEN', message: 'Tenant context required' } },
        { status: 403 },
      ),
    );
    mockIsAuthError.mockReturnValue(true);

    const req = makeRequest('/api/tenant-models/m-1/connections/c-1', { name: 'Updated' }, 'PATCH');
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1', connId: 'c-1' }) });
    expect(res.status).toBe(403);
  });

  it('proxies PATCH to runtime on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: 'c-1', name: 'Updated' }),
    });

    const req = makeRequest('/api/tenant-models/m-1/connections/c-1', { name: 'Updated' }, 'PATCH');
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1', connId: 'c-1' }) });
    expect(res.status).toBe(200);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/tenants/tenant-1/models/m-1/connections/c-1');
    expect(opts.method).toBe('PATCH');
  });

  it('returns 502 when runtime fetch fails', async () => {
    mockFetch.mockRejectedValue(new Error('Timeout'));

    const req = makeRequest('/api/tenant-models/m-1/connections/c-1', { name: 'X' }, 'PATCH');
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1', connId: 'c-1' }) });
    expect(res.status).toBe(502);
  });
});

// ===========================================================================
// DELETE /api/tenant-models/:id/connections/:connId
// ===========================================================================

describe('DELETE /api/tenant-models/:id/connections/:connId', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/tenant-models/[id]/connections/[connId]/route');
    handler = mod.DELETE;
  });

  it('returns 403 when user has no tenant context', async () => {
    // requireTenantAuth returns 403 when tenantId is missing
    mockRequireAuth.mockResolvedValue(
      NextResponse.json(
        { success: false, error: { code: 'FORBIDDEN', message: 'Tenant context required' } },
        { status: 403 },
      ),
    );
    mockIsAuthError.mockReturnValue(true);

    const req = new NextRequest(
      new URL('/api/tenant-models/m-1/connections/c-1', 'http://localhost:3000'),
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer test-jwt' },
      },
    );
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1', connId: 'c-1' }) });
    expect(res.status).toBe(403);
  });

  it('proxies DELETE to runtime on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true }),
    });

    const req = new NextRequest(
      new URL('/api/tenant-models/m-1/connections/c-1', 'http://localhost:3000'),
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer test-jwt' },
      },
    );
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1', connId: 'c-1' }) });
    expect(res.status).toBe(200);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/tenants/tenant-1/models/m-1/connections/c-1');
    expect(opts.method).toBe('DELETE');
  });

  it('returns 502 when runtime fetch fails', async () => {
    mockFetch.mockRejectedValue(new Error('Connection reset'));

    const req = new NextRequest(
      new URL('/api/tenant-models/m-1/connections/c-1', 'http://localhost:3000'),
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer test-jwt' },
      },
    );
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1', connId: 'c-1' }) });
    expect(res.status).toBe(502);
  });
});

// ===========================================================================
// POST /api/tenant-models/:id/toggle-inference
// ===========================================================================

describe('POST /api/tenant-models/:id/toggle-inference', () => {
  let handler: (req: NextRequest, ctx: any) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/tenant-models/[id]/toggle-inference/route');
    handler = mod.POST;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = makeRequest('/api/tenant-models/m-1/toggle-inference', {
      enabled: true,
    });
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no tenant context', async () => {
    // requireTenantAuth returns 403 when tenantId is missing
    mockRequireAuth.mockResolvedValue(
      NextResponse.json(
        { success: false, error: { code: 'FORBIDDEN', message: 'Tenant context required' } },
        { status: 403 },
      ),
    );
    mockIsAuthError.mockReturnValue(true);

    const req = makeRequest('/api/tenant-models/m-1/toggle-inference', { enabled: true });
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1' }) });
    expect(res.status).toBe(403);
  });

  it('proxies POST to runtime on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ inferenceEnabled: true }),
    });

    const req = makeRequest('/api/tenant-models/m-1/toggle-inference', {
      enabled: true,
    });
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1' }) });
    expect(res.status).toBe(200);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/tenants/tenant-1/models/m-1/toggle-inference');
    expect(opts.method).toBe('POST');
  });

  it('returns 502 when runtime fetch fails', async () => {
    mockFetch.mockRejectedValue(new Error('Connection refused'));

    const req = makeRequest('/api/tenant-models/m-1/toggle-inference', {
      enabled: true,
    });
    const res = await handler(req, { params: Promise.resolve({ id: 'm-1' }) });
    expect(res.status).toBe(502);
  });
});

// ===========================================================================
// GET /api/model-catalog
// ===========================================================================

describe('GET /api/model-catalog', () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/model-catalog/route');
    handler = mod.GET;
  });

  it('returns 401 when not authenticated', async () => {
    const authResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireAuth.mockResolvedValue(authResponse);
    mockIsAuthError.mockReturnValue(true);

    const req = new NextRequest(new URL('/api/model-catalog', 'http://localhost:3000'));
    const res = await handler(req);
    expect(res.status).toBe(401);
  });

  it('proxies to runtime on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          models: [
            { id: 'gpt-4', name: 'GPT-4', provider: 'openai' },
            { id: 'claude-3', name: 'Claude 3', provider: 'anthropic' },
          ],
        }),
    });

    const req = new NextRequest(new URL('/api/model-catalog', 'http://localhost:3000'), {
      headers: { Authorization: 'Bearer test-jwt' },
    });
    const res = await handler(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.models).toHaveLength(2);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/model-catalog');
  });

  it('forwards Authorization header', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ models: [] }),
    });

    const req = new NextRequest(new URL('/api/model-catalog', 'http://localhost:3000'), {
      headers: { Authorization: 'Bearer my-jwt-token' },
    });
    await handler(req);

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers.Authorization).toBe('Bearer my-jwt-token');
  });

  it('returns 502 when runtime fetch fails', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const req = new NextRequest(new URL('/api/model-catalog', 'http://localhost:3000'), {
      headers: { Authorization: 'Bearer test-jwt' },
    });
    const res = await handler(req);
    expect(res.status).toBe(502);

    const body = await res.json();
    expect(body.error).toContain('Failed to fetch model catalog');
  });
});

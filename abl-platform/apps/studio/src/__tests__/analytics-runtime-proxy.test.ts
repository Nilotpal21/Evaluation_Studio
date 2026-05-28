import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockRequireTenantAuth = vi.fn();
const mockIsAuthError = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireTenantAuth: (...args: unknown[]) => mockRequireTenantAuth(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
}));

vi.mock('@/services/auth-service', () => ({
  verifyAccessToken: vi.fn(),
}));

vi.mock('@/repos/auth-repo', () => ({
  findUserById: vi.fn(),
}));

vi.mock('@/config/runtime.server', () => ({
  getRuntimeUrl: () => 'http://localhost:3112',
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockFetch = vi.fn();

const authenticatedUser = {
  id: 'user-1',
  email: 'test@test.com',
  name: 'Test User',
  tenantId: 'tenant-1',
  permissions: ['*:*'],
};

function makeRequest(url: string, opts: RequestInit = {}) {
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

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireTenantAuth.mockResolvedValue(authenticatedUser);
  mockIsAuthError.mockReturnValue(false);
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        success: true,
        data: { ok: true },
      }),
  });
  vi.stubGlobal('fetch', mockFetch);
});

import {
  GET as getRuntimeAnalytics,
  POST as postRuntimeAnalytics,
} from '@/app/api/runtime/analytics/route';
import { GET as getRuntimeSessionTraces } from '@/app/api/runtime/sessions/[id]/traces/route';

describe('runtime analytics Studio proxy', () => {
  test('GET forwards project, endpoint, time range, and tenant headers to runtime', async () => {
    const response = await getRuntimeAnalytics(
      makeRequest(
        '/api/runtime/analytics?projectId=project-abc&endpoint=event-counts&from=2026-04-20T00%3A00%3A00.000Z&to=2026-04-20T03%3A00%3A00.000Z',
      ),
    );
    const body = await response.json();

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'http://localhost:3112/api/projects/project-abc/analytics/event-counts?from=2026-04-20T00%3A00%3A00.000Z&to=2026-04-20T03%3A00%3A00.000Z',
    );
    expect(init).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-jwt-token',
          'X-Tenant-Id': 'tenant-1',
          'Content-Type': 'application/json',
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, data: { ok: true } });
  });

  test('POST forwards SQL query body including selected time range unchanged', async () => {
    const requestBody = {
      sql: 'SELECT event_type FROM abl_platform.platform_events WHERE tenant_id = {tenantId:String} AND project_id = {projectId:String} AND timestamp >= {from:DateTime64(3)} AND timestamp <= {to:DateTime64(3)}',
      timeRange: {
        from: '2026-04-20T00:00:00.000Z',
        to: '2026-04-20T03:00:00.000Z',
      },
    };

    const response = await postRuntimeAnalytics(
      makeRequest('/api/runtime/analytics?projectId=project-abc&endpoint=sql-query', {
        method: 'POST',
        body: JSON.stringify(requestBody),
      }),
    );

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3112/api/projects/project-abc/analytics/sql-query');
    expect(init).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(requestBody),
        headers: expect.objectContaining({
          Authorization: 'Bearer test-jwt-token',
          'X-Tenant-Id': 'tenant-1',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  test('requires projectId and endpoint before proxying analytics requests', async () => {
    const missingProject = await getRuntimeAnalytics(
      makeRequest('/api/runtime/analytics?endpoint=event-counts'),
    );
    const missingEndpoint = await getRuntimeAnalytics(
      makeRequest('/api/runtime/analytics?projectId=project-abc'),
    );

    expect(missingProject.status).toBe(400);
    expect(missingEndpoint.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('returns auth errors without proxying analytics requests', async () => {
    const authError = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireTenantAuth.mockResolvedValue(authError);
    mockIsAuthError.mockReturnValue(true);

    const response = await getRuntimeAnalytics(
      makeRequest('/api/runtime/analytics?projectId=project-abc&endpoint=event-counts'),
    );

    expect(response.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('runtime session traces Studio proxy', () => {
  test('forwards Analytics Traces Explorer requests to the project-scoped runtime route', async () => {
    const response = await getRuntimeSessionTraces(
      makeRequest('/api/runtime/sessions/session-1/traces?projectId=project-abc&limit=500'),
      { params: Promise.resolve({ id: 'session-1' }) },
    );
    const body = await response.json();

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'http://localhost:3112/api/projects/project-abc/sessions/session-1/traces?limit=500',
    );
    expect(init).toEqual(
      expect.objectContaining({
        cache: 'no-store',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-jwt-token',
          'X-Tenant-Id': 'tenant-1',
        }),
      }),
    );
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body).toEqual({ success: true, data: { ok: true } });
  });

  test('requires projectId before proxying trace requests', async () => {
    const response = await getRuntimeSessionTraces(
      makeRequest('/api/runtime/sessions/session-1/traces?limit=500'),
      { params: Promise.resolve({ id: 'session-1' }) },
    );

    expect(response.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

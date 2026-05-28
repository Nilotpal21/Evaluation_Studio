import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const {
  mockFetch,
  mockIsAuthError,
  mockIsProjectPermissionError,
  mockRequireProjectPermission,
  mockRequireTenantAuth,
} = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockIsAuthError: vi.fn(),
  mockIsProjectPermissionError: vi.fn(),
  mockRequireProjectPermission: vi.fn(),
  mockRequireTenantAuth: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  requireTenantAuth: (...args: unknown[]) => mockRequireTenantAuth(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
}));

vi.mock('@/lib/project-permission', () => ({
  requireProjectPermission: (...args: unknown[]) => mockRequireProjectPermission(...args),
  isProjectPermissionError: (...args: unknown[]) => mockIsProjectPermissionError(...args),
}));

vi.mock('@/config/runtime.server', () => ({
  getRuntimeUrl: () => 'http://localhost:3112',
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

import { GET } from '@/app/api/runtime/traces/route';

const authenticatedUser = {
  id: 'user-1',
  email: 'user@example.test',
  tenantId: 'tenant-1',
  permissions: ['project:*'],
};

function makeRequest(url: string) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    headers: {
      Authorization: 'Bearer studio-token',
      'Content-Type': 'application/json',
    },
  });
}

describe('runtime traces Studio proxy parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireTenantAuth.mockResolvedValue(authenticatedUser);
    mockIsAuthError.mockReturnValue(false);
    mockRequireProjectPermission.mockResolvedValue({ project: { id: 'project-1' } });
    mockIsProjectPermissionError.mockReturnValue(false);
    mockFetch.mockResolvedValue({
      status: 200,
      text: async () =>
        JSON.stringify({
          success: true,
          total: 1,
          traces: [
            {
              traceId: 'trace-1',
              spanId: 'span-1',
              sessionId: 'session-1',
              agentName: 'CignaRouter',
              environment: 'production',
              channel: 'web_chat',
              type: 'llm_call',
              status: 'ok',
              startedAt: '2026-05-12T16:00:00.000Z',
              durationMs: 842,
              inputTokens: 128,
              outputTokens: 32,
              totalTokens: 160,
              estimatedCost: 0.004322,
              eventCount: 3,
              errorCount: 0,
              preview: 'llm.call.completed',
            },
          ],
        }),
    });
    vi.stubGlobal('fetch', mockFetch);
  });

  test('forwards trace explorer filters to the project-scoped runtime route', async () => {
    const response = await GET(
      makeRequest(
        '/api/runtime/traces?projectId=project-1&q=span-1&agentName=CignaRouter&environment=production&channel=web_chat&type=llm_call&status=ok&minLatencyMs=100&maxLatencyMs=1000&minTokens=100&maxTokens=200&minCost=0.001&maxCost=0.01&sortBy=totalTokens&sortDir=asc&limit=25',
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body.traces[0]).toMatchObject({
      traceId: 'trace-1',
      spanId: 'span-1',
      environment: 'production',
      totalTokens: 160,
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockRequireProjectPermission).toHaveBeenCalledWith(
      'project-1',
      authenticatedUser,
      'session:read',
    );
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://localhost:3112/api/projects/project-1/traces?q=span-1&agentName=CignaRouter&environment=production&channel=web_chat&type=llm_call&status=ok&minLatencyMs=100&maxLatencyMs=1000&minTokens=100&maxTokens=200&minCost=0.001&maxCost=0.01&sortBy=totalTokens&sortDir=asc&limit=25',
    );
    expect(init).toEqual(
      expect.objectContaining({
        cache: 'no-store',
        headers: expect.objectContaining({
          Authorization: 'Bearer studio-token',
          'X-Tenant-Id': 'tenant-1',
        }),
      }),
    );
  });

  test('requires projectId before proxying trace explorer requests', async () => {
    const response = await GET(makeRequest('/api/runtime/traces?environment=production'));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: 'MISSING_PARAM' },
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('returns project permission errors without proxying trace explorer requests', async () => {
    const permissionError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    mockRequireProjectPermission.mockResolvedValue(permissionError);
    mockIsProjectPermissionError.mockReturnValue(true);

    const response = await GET(makeRequest('/api/runtime/traces?projectId=project-1'));

    expect(response.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('returns auth errors without proxying trace explorer requests', async () => {
    const authError = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireTenantAuth.mockResolvedValue(authError);
    mockIsAuthError.mockReturnValue(true);

    const response = await GET(makeRequest('/api/runtime/traces?projectId=project-1'));

    expect(response.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

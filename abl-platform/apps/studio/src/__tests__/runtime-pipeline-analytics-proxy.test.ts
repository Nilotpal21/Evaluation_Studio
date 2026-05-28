import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockRequireTenantAuth = vi.fn();
const mockIsAuthError = vi.fn();
const mockFetch = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireTenantAuth: (...args: unknown[]) => mockRequireTenantAuth(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
}));

vi.mock('@/config/runtime.server', () => ({
  getRuntimeUrl: () => 'http://runtime.local',
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const authenticatedUser = {
  id: 'user-1',
  tenantId: 'tenant-1',
  email: 'user@example.com',
};

function makeRequest(url: string) {
  return new NextRequest(new URL(url, 'http://studio.local'), {
    headers: {
      Authorization: 'Bearer studio-token',
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireTenantAuth.mockResolvedValue(authenticatedUser);
  mockIsAuthError.mockReturnValue(false);
  mockFetch.mockResolvedValue({
    status: 200,
    text: async () => JSON.stringify({ success: true, data: [{ day: '2026-05-01' }] }),
  });
  vi.stubGlobal('fetch', mockFetch);
});

import { GET } from '@/app/api/runtime/pipeline-analytics/route';

describe('/api/runtime/pipeline-analytics proxy', () => {
  test('forwards to the project-scoped runtime endpoint and preserves analytics query params', async () => {
    const response = await GET(
      makeRequest(
        '/api/runtime/pipeline-analytics?projectId=proj-1&pipelineType=intent_classification&endpoint=breakdown&period=30d&dimension=intent',
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, data: [{ day: '2026-05-01' }] });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://runtime.local/api/projects/proj-1/pipeline-analytics/intent_classification/breakdown?period=30d&dimension=intent',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer studio-token',
          'X-Tenant-Id': 'tenant-1',
        }),
      }),
    );
  });

  test('requires the routing params before calling runtime', async () => {
    const response = await GET(makeRequest('/api/runtime/pipeline-analytics?projectId=proj-1'));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toEqual({
      code: 'MISSING_PARAM',
      message: 'projectId, pipelineType, and endpoint query parameters are required',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('returns auth errors without calling runtime', async () => {
    const authError = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireTenantAuth.mockResolvedValue(authError);
    mockIsAuthError.mockReturnValue(true);

    const response = await GET(
      makeRequest(
        '/api/runtime/pipeline-analytics?projectId=proj-1&pipelineType=sentiment_analysis&endpoint=summary&period=7d',
      ),
    );

    expect(response.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

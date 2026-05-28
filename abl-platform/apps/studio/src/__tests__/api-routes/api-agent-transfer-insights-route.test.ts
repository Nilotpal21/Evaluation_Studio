/**
 * Boundary tests for GET /api/projects/:id/agent-transfer/insights
 *
 * F-1 (data-flow audit): insights route must NOT return raw error details
 * (upstream text or internal error messages) to the client — mirrors the
 * error-sanitization contract already enforced on the CSAT submit route.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockEnsureDb = vi.fn();
const mockConnectorConnectionFindOne = vi.fn();
const mockAuthProfileFindOne = vi.fn();
const mockResolve = vi.fn();
const mockCreateAuthProfileResolver = vi.fn();
const mockValidateUrlForSSRF = vi.fn();
const mockGetDevSSRFOptions = vi.fn(() => ({}));
const mockFetch = vi.fn();

vi.mock('@/lib/route-handler', () => ({
  withRouteHandler:
    (_options: unknown, handler: Function) =>
    async (request: NextRequest, ctx: { params: Promise<Record<string, string>> }) => {
      const params = await ctx.params;
      return handler({
        request,
        tenantId: 'tenant-1',
        params,
        user: {
          id: 'user-1',
          tenantId: 'tenant-1',
          permissions: ['connection:read'],
        },
        project: { id: params.id, tenantId: 'tenant-1' },
      });
    },
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: (...args: unknown[]) => mockEnsureDb(...args),
}));

vi.mock('@agent-platform/database/models', () => ({
  ConnectorConnection: {
    findOne: (...args: unknown[]) => mockConnectorConnectionFindOne(...args),
  },
  AuthProfile: {
    findOne: (...args: unknown[]) => mockAuthProfileFindOne(...args),
  },
}));

vi.mock('@agent-platform/connectors/services', () => ({
  createAuthProfileResolver: (...args: unknown[]) => mockCreateAuthProfileResolver(...args),
}));

vi.mock('@agent-platform/shared/security', () => ({
  validateUrlForSSRF: (...args: unknown[]) => mockValidateUrlForSSRF(...args),
}));

vi.mock('@agent-platform/shared-kernel/security', () => ({
  getDevSSRFOptions: (...args: unknown[]) => mockGetDevSSRFOptions(...args),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

function makeRequest(type = 'chat'): NextRequest {
  return new NextRequest(
    new URL(`/api/projects/proj-1/agent-transfer/insights?type=${type}`, 'http://localhost:3000'),
    {
      method: 'GET',
      headers: {
        Authorization: 'Bearer test-token',
      },
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mockFetch);
  mockEnsureDb.mockResolvedValue(undefined);
  mockCreateAuthProfileResolver.mockReturnValue({ resolve: mockResolve });
  mockValidateUrlForSSRF.mockReturnValue({ safe: true });
  // Default: AuthProfile has no match → fall back to ConnectorConnection
  mockAuthProfileFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
  mockConnectorConnectionFindOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue({
      authProfileId: 'auth-profile-1',
      metadata: { baseUrl: 'https://smartassist.example.com' },
    }),
  });
  mockResolve.mockResolvedValue({ apiKey: 'smartassist-key' });
});

describe('GET /api/projects/[id]/agent-transfer/insights', () => {
  it('does not return raw upstream error text to the client (F-1)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      text: vi.fn().mockResolvedValue('upstream stack trace: token=secret clientId=cid'),
    });

    const { GET } = await import('@/app/api/projects/[id]/agent-transfer/insights/route');
    const response = await GET(makeRequest('chat'), {
      params: Promise.resolve({ id: 'proj-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'UPSTREAM_ERROR',
        message: 'KoreAgentAssist analytics request failed',
      },
    });
    // Raw upstream text must NOT appear anywhere in the response
    expect(JSON.stringify(body)).not.toContain('token=secret');
    expect(JSON.stringify(body)).not.toContain('clientId=cid');
    expect(body.error.detail).toBeUndefined();
    expect(body.error.upstreamStatus).toBeUndefined();
  });

  it('does not return internal error messages to the client (F-1)', async () => {
    // Simulate an exception thrown during credential resolution (e.g. disabled profile)
    mockResolve.mockRejectedValue(
      new Error('Auth profile "SmartAssist Prod" is disabled. Re-enable it in Auth Profiles.'),
    );

    const { GET } = await import('@/app/api/projects/[id]/agent-transfer/insights/route');
    const response = await GET(makeRequest('chat'), {
      params: Promise.resolve({ id: 'proj-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch agent transfer analytics',
      },
    });
    // Internal exception message must NOT leak to the client
    expect(JSON.stringify(body)).not.toContain('SmartAssist Prod');
    expect(JSON.stringify(body)).not.toContain('is disabled');
    expect(body.error.detail).toBeUndefined();
    expect(body.error.stack).toBeUndefined();
  });

  it('returns 200 with analytics data on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ totalChats: 42, avgHandleTime: 180 }),
    });

    const { GET } = await import('@/app/api/projects/[id]/agent-transfer/insights/route');
    const response = await GET(makeRequest('chat'), {
      params: Promise.resolve({ id: 'proj-1' }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ totalChats: 42, avgHandleTime: 180 });
  });
});

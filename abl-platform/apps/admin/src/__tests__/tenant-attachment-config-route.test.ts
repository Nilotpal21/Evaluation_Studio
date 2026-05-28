import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockBuildRuntimeHeaders = vi.fn();
const mockFetch = vi.fn();
const mockLogger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
};

type MockAdminRouteContext = {
  request: NextRequest;
  params: Record<string, string>;
  token: string;
  user: {
    userId: string;
    email: string;
    role: string;
    ipAddress: string;
    isSuperAdmin: boolean;
  };
};

vi.mock('../lib/with-admin-route', () => ({
  withAdminRoute:
    (_options: unknown, handler: (ctx: MockAdminRouteContext) => Promise<Response>) =>
    async (request: NextRequest, routeCtx?: { params?: Promise<Record<string, string>> }) =>
      handler({
        request,
        params: routeCtx?.params ? await routeCtx.params : {},
        token: 'admin-token',
        user: {
          userId: 'admin-user',
          email: 'admin@example.com',
          role: 'SUPER_ADMIN',
          ipAddress: '127.0.0.1',
          isSuperAdmin: true,
        },
      }),
}));

vi.mock('../lib/runtime-proxy', () => ({
  getRuntimeBaseUrl: () => 'http://localhost:3112',
  buildRuntimeHeaders: (...args: unknown[]) => mockBuildRuntimeHeaders(...args),
}));

vi.mock('../lib/logger', () => ({
  createLogger: () => mockLogger,
}));

function makePutRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest(
    'http://localhost:3003/api/admin/tenant-attachment-config?tenantId=tenant-123',
    {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
      },
    },
  );
}

const emptyRouteContext = { params: Promise.resolve({}) };

beforeEach(() => {
  vi.clearAllMocks();
  mockBuildRuntimeHeaders.mockReturnValue({
    'Content-Type': 'application/json',
    Authorization: 'Bearer admin-token',
  });
  mockFetch.mockResolvedValue({
    status: 200,
    json: async () => ({ success: true }),
  });
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Tenant attachment config admin proxy route', () => {
  test('rejects unexpected request body fields instead of forwarding them to runtime', async () => {
    const { PUT } = await import('../app/api/admin/tenant-attachment-config/route.js');

    const response = await PUT(
      makePutRequest({
        maxFileSizeBytes: 2048,
        unexpected: true,
      }),
      emptyRouteContext,
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request body',
      },
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('forwards valid updates with verified admin runtime headers', async () => {
    const { PUT } = await import('../app/api/admin/tenant-attachment-config/route.js');
    const body = { maxFileSizeBytes: 2048 };

    const response = await PUT(makePutRequest(body), emptyRouteContext);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({ success: true });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3112/api/platform/admin/tenant-attachment-config?tenantId=tenant-123',
      expect.objectContaining({
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer admin-token',
        },
        body: JSON.stringify(body),
      }),
    );
  });
});

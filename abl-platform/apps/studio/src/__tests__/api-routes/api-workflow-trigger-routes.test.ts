/**
 * Workflow trigger route proxy tests
 *
 * Verifies that Studio's trigger lifecycle routes proxy to runtime with the
 * expected path, method, and tenant headers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockProxyToRuntime = vi.fn();

vi.mock('@/lib/runtime-proxy', () => ({
  proxyToRuntime: (...args: unknown[]) => mockProxyToRuntime(...args),
}));

vi.mock('@/lib/route-handler', () => ({
  withRouteHandler:
    (_options: unknown, handler: Function) => async (request: NextRequest, ctx: any) =>
      handler({
        request,
        tenantId: 'tenant-1',
        params: await ctx.params,
      }),
}));

function makeRequest(url: string, method = 'POST'): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method,
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
  });
}

function routeCtx(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockProxyToRuntime.mockResolvedValue(NextResponse.json({ success: true }));
});

describe('Workflow trigger route proxies', () => {
  it('DELETE /workflows/triggers/:triggerId proxies to the runtime delete endpoint', async () => {
    const { DELETE } = await import('@/app/api/projects/[id]/workflows/triggers/[triggerId]/route');

    await DELETE(
      makeRequest(
        'http://localhost:3000/api/projects/proj-1/workflows/triggers/trigger-1',
        'DELETE',
      ),
      routeCtx({ id: 'proj-1', triggerId: 'trigger-1' }),
    );

    expect(mockProxyToRuntime).toHaveBeenCalledWith(
      expect.any(NextRequest),
      '/api/projects/proj-1/workflows/triggers/trigger-1',
      expect.objectContaining({
        method: 'DELETE',
        tenantId: 'tenant-1',
      }),
    );
  });

  it('POST /workflows/triggers/:triggerId/fire proxies to the runtime fire endpoint', async () => {
    const { POST } =
      await import('@/app/api/projects/[id]/workflows/triggers/[triggerId]/fire/route');

    await POST(
      makeRequest('http://localhost:3000/api/projects/proj-1/workflows/triggers/trigger-1/fire'),
      routeCtx({ id: 'proj-1', triggerId: 'trigger-1' }),
    );

    expect(mockProxyToRuntime).toHaveBeenCalledWith(
      expect.any(NextRequest),
      '/api/projects/proj-1/workflows/triggers/trigger-1/fire',
      expect.objectContaining({
        method: 'POST',
        tenantId: 'tenant-1',
      }),
    );
  });
});

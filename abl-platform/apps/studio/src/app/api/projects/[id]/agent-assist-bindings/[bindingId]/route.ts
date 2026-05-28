/**
 * GET    /api/projects/:id/agent-assist-bindings/:bindingId — Get binding
 * PATCH  /api/projects/:id/agent-assist-bindings/:bindingId — Update binding
 * DELETE /api/projects/:id/agent-assist-bindings/:bindingId — Delete binding
 *
 * Proxies to runtime /api/projects/:projectId/agent-assist-bindings/:bindingId
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';

const RUNTIME_BASE = process.env.RUNTIME_URL || 'http://localhost:3112';

function buildRuntimeUrl(projectId: string, bindingId: string): string {
  return `${RUNTIME_BASE}/api/projects/${encodeURIComponent(projectId)}/agent-assist-bindings/${encodeURIComponent(bindingId)}`;
}

function buildHeaders(request: Request, tenantId: string): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Tenant-Id': tenantId,
    'Content-Type': 'application/json',
  };
  const auth = request.headers.get('authorization');
  if (auth) headers['Authorization'] = auth;
  return headers;
}

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.CONNECTION_READ },
  async ({ request, tenantId, params }) => {
    try {
      const runtimeRes = await fetch(buildRuntimeUrl(params.id, params.bindingId), {
        headers: buildHeaders(request, tenantId),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await runtimeRes.json();
      return NextResponse.json(body, { status: runtimeRes.status });
    } catch {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'RUNTIME_UNREACHABLE', message: 'Runtime service unavailable' },
        },
        { status: 502 },
      );
    }
  },
);

export const PATCH = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.CONNECTION_WRITE },
  async ({ request, tenantId, params }) => {
    const body = await request.json();
    try {
      const runtimeRes = await fetch(buildRuntimeUrl(params.id, params.bindingId), {
        method: 'PATCH',
        headers: buildHeaders(request, tenantId),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      const responseBody = await runtimeRes.json();
      return NextResponse.json(responseBody, { status: runtimeRes.status });
    } catch {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'RUNTIME_UNREACHABLE', message: 'Runtime service unavailable' },
        },
        { status: 502 },
      );
    }
  },
);

export const DELETE = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.CONNECTION_WRITE },
  async ({ request, tenantId, params }) => {
    try {
      const runtimeRes = await fetch(buildRuntimeUrl(params.id, params.bindingId), {
        method: 'DELETE',
        headers: buildHeaders(request, tenantId),
        signal: AbortSignal.timeout(10_000),
      });
      const responseBody = await runtimeRes.json();
      return NextResponse.json(responseBody, { status: runtimeRes.status });
    } catch {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'RUNTIME_UNREACHABLE', message: 'Runtime service unavailable' },
        },
        { status: 502 },
      );
    }
  },
);

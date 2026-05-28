/**
 * POST /api/projects/:id/agent-assist-bindings/:bindingId/generate-api-key
 *
 * Proxies to runtime /api/projects/:projectId/agent-assist-bindings/:bindingId/generate-api-key
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';

const RUNTIME_BASE = process.env.RUNTIME_URL || 'http://localhost:3112';

export const POST = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.CONNECTION_WRITE },
  async ({ request, tenantId, params }) => {
    try {
      const runtimeUrl = `${RUNTIME_BASE}/api/projects/${encodeURIComponent(params.id)}/agent-assist-bindings/${encodeURIComponent(params.bindingId)}/generate-api-key`;
      const headers: Record<string, string> = {
        'X-Tenant-Id': tenantId,
        'Content-Type': 'application/json',
      };
      const auth = request.headers.get('authorization');
      if (auth) headers['Authorization'] = auth;

      const runtimeRes = await fetch(runtimeUrl, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(15_000),
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

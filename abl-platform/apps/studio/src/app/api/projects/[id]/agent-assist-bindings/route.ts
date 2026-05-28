/**
 * GET  /api/projects/:id/agent-assist-bindings — List bindings
 * POST /api/projects/:id/agent-assist-bindings — Create binding
 *
 * Proxies to runtime /api/projects/:projectId/agent-assist-bindings
 */

import { NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';

const log = createLogger('studio:agent-assist-bindings:proxy');
const RUNTIME_BASE = process.env.RUNTIME_URL || 'http://localhost:3112';

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.CONNECTION_READ },
  async ({ request, tenantId, params }) => {
    const projectId = params.id;
    const url = new URL(request.url);
    const qs = url.search;

    try {
      const runtimeUrl = `${RUNTIME_BASE}/api/projects/${encodeURIComponent(projectId)}/agent-assist-bindings${qs}`;
      const headers: Record<string, string> = {
        'X-Tenant-Id': tenantId,
        'Content-Type': 'application/json',
      };
      const auth = request.headers.get('authorization');
      if (auth) headers['Authorization'] = auth;

      const runtimeRes = await fetch(runtimeUrl, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });

      const body = await runtimeRes.json();
      return NextResponse.json(body, { status: runtimeRes.status });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Runtime bindings GET proxy failed', { projectId, error: message });
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

export const POST = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.CONNECTION_WRITE },
  async ({ request, tenantId, params }) => {
    const projectId = params.id;
    const body = await request.json();

    try {
      const runtimeUrl = `${RUNTIME_BASE}/api/projects/${encodeURIComponent(projectId)}/agent-assist-bindings`;
      const headers: Record<string, string> = {
        'X-Tenant-Id': tenantId,
        'Content-Type': 'application/json',
      };
      const auth = request.headers.get('authorization');
      if (auth) headers['Authorization'] = auth;

      const runtimeRes = await fetch(runtimeUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });

      const responseBody = await runtimeRes.json();
      return NextResponse.json(responseBody, { status: runtimeRes.status });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Runtime bindings POST proxy failed', { projectId, error: message });
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

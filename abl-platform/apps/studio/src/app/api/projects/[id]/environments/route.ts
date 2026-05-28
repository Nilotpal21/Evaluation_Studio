/**
 * GET /api/projects/:id/environments — List project environments
 *
 * Proxies to runtime /api/projects/:projectId/environments
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';

const RUNTIME_BASE = process.env.RUNTIME_URL || 'http://localhost:3112';

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.CONNECTION_READ },
  async ({ request, tenantId, params }) => {
    const projectId = params.id;

    try {
      const runtimeUrl = `${RUNTIME_BASE}/api/projects/${encodeURIComponent(projectId)}/environments`;
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

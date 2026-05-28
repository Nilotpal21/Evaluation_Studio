/**
 * POST /api/projects/[id]/prompt-library/test/stream
 * SSE streaming proxy to runtime prompt library test endpoint.
 */

import { withRouteHandler } from '@/lib/route-handler';
import { buildRuntimeProxyHeaders } from '@/lib/runtime-proxy';
import { getRuntimeUrl } from '@/config/runtime.server';
import { NextResponse } from 'next/server';
import { StudioPermission } from '@/lib/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.PROMPT_TEST },
  async ({ request, tenantId, params }) => {
    const body = await request.json();
    const headers = buildRuntimeProxyHeaders(request, tenantId);

    let runtimeRes: Response;
    try {
      runtimeRes = await fetch(
        `${getRuntimeUrl()}/api/projects/${encodeURIComponent(params.id)}/prompt-library/test/stream`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(65_000),
        },
      );
    } catch {
      return NextResponse.json(
        { success: false, error: { code: 'RUNTIME_UNAVAILABLE', message: 'Runtime unreachable' } },
        { status: 502 },
      );
    }

    if (!runtimeRes.ok) {
      const errBody = await runtimeRes.json().catch(() => ({}));
      return NextResponse.json(errBody, { status: runtimeRes.status });
    }

    if (!runtimeRes.body) {
      return NextResponse.json(
        { success: false, error: { code: 'STREAM_ERROR', message: 'No response body' } },
        { status: 502 },
      );
    }

    return new NextResponse(runtimeRes.body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  },
);

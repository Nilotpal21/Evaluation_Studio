/**
 * POST /api/projects/:id/agent-transfer/sessions/:sessionId/end — End a transfer session
 *
 * Proxies to the runtime's end-session endpoint.
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';

const RUNTIME_BASE = process.env.RUNTIME_URL || 'http://localhost:3112';

export const POST = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.CONNECTION_WRITE },
  async ({ request, tenantId, params }) => {
    const projectId = params.id;
    const sessionId = params.sessionId;

    // Runtime must verify session.projectId matches X-Project-Id to prevent
    // cross-project session termination within the same tenant.
    const runtimeUrl = `${RUNTIME_BASE}/api/v1/agent-transfer/sessions/${encodeURIComponent(sessionId)}/end`;
    const headers: Record<string, string> = {
      'X-Tenant-Id': tenantId,
      'X-Project-Id': projectId,
      'Content-Type': 'application/json',
    };
    const auth = request.headers.get('Authorization');
    if (auth) headers['Authorization'] = auth;

    const runtimeRes = await fetch(runtimeUrl, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (runtimeRes.ok) {
      const body = await runtimeRes.json();
      return NextResponse.json({ success: true, data: body.data ?? null });
    }

    const status = runtimeRes.status;
    // Consume the body to avoid connection leaks
    await runtimeRes.text().catch(() => '');
    return NextResponse.json(
      { success: false, error: { code: 'RUNTIME_ERROR', message: 'Failed to end session' } },
      { status: status >= 400 && status < 600 ? status : 502 },
    );
  },
);

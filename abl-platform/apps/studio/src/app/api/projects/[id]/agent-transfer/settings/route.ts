/**
 * GET/PUT /api/projects/:id/agent-transfer/settings — Agent transfer settings
 *
 * Dedicated route for agent-transfer configuration so it does not piggyback
 * on the generic /api/projects/:id/settings endpoint which may ignore unknown keys.
 * Proxies to the runtime's agent-transfer settings endpoints.
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
      const runtimeUrl = `${RUNTIME_BASE}/api/v1/agent-transfer/settings`;
      const headers: Record<string, string> = {
        'X-Tenant-Id': tenantId,
        'X-Project-Id': projectId,
        'Content-Type': 'application/json',
      };
      const auth = request.headers.get('authorization');
      if (auth) headers['Authorization'] = auth;

      const runtimeRes = await fetch(runtimeUrl, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });

      if (runtimeRes.ok) {
        const body = await runtimeRes.json();
        return NextResponse.json({ success: true, data: body.data ?? body.settings ?? null });
      }

      // Genuine error — log and return failure. (Historically a 404 here was
      // mapped to `data: null` on the assumption that the runtime returned 404
      // when no settings doc existed; that assumption was wrong — the runtime
      // returns `200 { data: null }` for "missing settings" and only 404s on
      // an authorization denial. Surfacing the real status lets the UI
      // distinguish "not configured" from "forbidden".)
      const errorText = await runtimeRes.text().catch(() => '');
      console.error('[agent-transfer-settings] Runtime GET failed', {
        status: runtimeRes.status,
        body: errorText.slice(0, 200),
      });
      return NextResponse.json(
        { success: false, error: { code: 'RUNTIME_ERROR', message: 'Failed to load settings' } },
        { status: runtimeRes.status >= 400 && runtimeRes.status < 600 ? runtimeRes.status : 502 },
      );
    } catch (err) {
      // Runtime unreachable — return null so UI degrades to defaults
      console.error('[agent-transfer-settings] Runtime unreachable', {
        error: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json({ success: true, data: null });
    }
  },
);

export const PUT = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.CONNECTION_WRITE },
  async ({ request, tenantId, params }) => {
    const projectId = params.id;
    const body = await request.json();

    const runtimeUrl = `${RUNTIME_BASE}/api/v1/agent-transfer/settings`;
    const headers: Record<string, string> = {
      'X-Tenant-Id': tenantId,
      'X-Project-Id': projectId,
      'Content-Type': 'application/json',
    };
    const auth = request.headers.get('authorization');
    if (auth) headers['Authorization'] = auth;

    const runtimeRes = await fetch(runtimeUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (runtimeRes.ok) {
      const responseBody = await runtimeRes.json();
      return NextResponse.json({ success: true, data: responseBody.data ?? null });
    }

    const status = runtimeRes.status;
    return NextResponse.json(
      {
        success: false,
        error: { code: 'RUNTIME_ERROR', message: 'Failed to save agent transfer settings' },
      },
      { status: status >= 400 && status < 600 ? status : 502 },
    );
  },
);

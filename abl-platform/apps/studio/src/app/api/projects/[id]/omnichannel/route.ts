/**
 * GET/PATCH /api/projects/:id/omnichannel — Omnichannel session continuity settings
 *
 * Proxies to the runtime's omnichannel settings endpoints so Studio
 * can read and update per-project omnichannel configuration.
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';

const RUNTIME_BASE = process.env.RUNTIME_URL || 'http://localhost:3112';

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.PROJECT_READ },
  async ({ tenantId, params }) => {
    const projectId = params.id;

    try {
      const runtimeUrl = `${RUNTIME_BASE}/api/projects/${projectId}/omnichannel`;
      const runtimeRes = await fetch(runtimeUrl, {
        headers: {
          'X-Tenant-Id': tenantId,
          'X-Project-Id': projectId,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (runtimeRes.ok) {
        const body = await runtimeRes.json();
        return NextResponse.json({ success: true, data: body.data ?? null });
      }

      // 404 = settings don't exist yet — return null so UI uses defaults
      if (runtimeRes.status === 404) {
        return NextResponse.json({ success: true, data: null });
      }

      // Genuine error — log and return failure
      const errorText = await runtimeRes.text().catch(() => '');
      console.error('[omnichannel-settings] Runtime GET failed', {
        status: runtimeRes.status,
        body: errorText.slice(0, 200),
      });
      return NextResponse.json(
        { success: false, error: { code: 'RUNTIME_ERROR', message: 'Failed to load settings' } },
        { status: runtimeRes.status >= 400 && runtimeRes.status < 600 ? runtimeRes.status : 502 },
      );
    } catch (err) {
      // Runtime unreachable — return null so UI degrades to defaults
      console.error('[omnichannel-settings] Runtime unreachable', {
        error: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json({ success: true, data: null });
    }
  },
);

export const PATCH = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.CONNECTION_WRITE },
  async ({ request, tenantId, params }) => {
    const projectId = params.id;
    const body = await request.json();

    const runtimeUrl = `${RUNTIME_BASE}/api/projects/${projectId}/omnichannel`;
    const runtimeRes = await fetch(runtimeUrl, {
      method: 'PATCH',
      headers: {
        'X-Tenant-Id': tenantId,
        'X-Project-Id': projectId,
        'Content-Type': 'application/json',
      },
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
        error: { code: 'RUNTIME_ERROR', message: 'Failed to save omnichannel settings' },
      },
      { status: status >= 400 && status < 600 ? status : 502 },
    );
  },
);

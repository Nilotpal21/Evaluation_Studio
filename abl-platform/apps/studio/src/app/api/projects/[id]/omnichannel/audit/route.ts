/**
 * GET /api/projects/:id/omnichannel/audit — Omnichannel audit events
 *
 * Proxies to the runtime's omnichannel audit query endpoint so Studio
 * can display a read-only view of recent omnichannel audit events.
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
      const runtimeUrl = `${RUNTIME_BASE}/api/projects/${projectId}/omnichannel/audit?limit=50`;
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
        return NextResponse.json({
          success: true,
          data: body.data ?? { events: [] },
        });
      }

      const errorText = await runtimeRes.text().catch(() => '');
      console.error('[omnichannel-audit] Runtime GET failed', {
        status: runtimeRes.status,
        body: errorText.slice(0, 200),
      });
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'RUNTIME_ERROR',
            message: 'Failed to load audit events',
          },
        },
        {
          status: runtimeRes.status >= 400 && runtimeRes.status < 600 ? runtimeRes.status : 502,
        },
      );
    } catch (err) {
      console.error('[omnichannel-audit] Runtime unreachable', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Return empty events on failure so UI degrades gracefully
      return NextResponse.json({ success: true, data: { events: [] } });
    }
  },
);

/**
 * GET  /api/projects/:id/connections — List connections in project
 * POST /api/projects/:id/connections — Create a new connection
 *
 * Direct MongoDB access via shared ConnectionService (no WE proxy).
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { getConnectionService } from '@/lib/connection-service';
import { ConnectionServiceError } from '@agent-platform/connectors/services';
import { StudioPermission } from '@/lib/permissions';

// ─── GET (List) ─────────────────────────────────────────────────────────

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.CONNECTION_READ },
  async ({ tenantId, params }) => {
    const svc = await getConnectionService();
    const data = await svc.list(tenantId, params.id);
    return NextResponse.json({ success: true, data });
  },
);

// ─── POST (Create) ──────────────────────────────────────────────────────

export const POST = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.CONNECTION_WRITE },
  async ({ request, tenantId, params }) => {
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
    }

    const svc = await getConnectionService();

    try {
      const data = await svc.create(tenantId, params.id, {
        connectorName: body.connectorName as string,
        displayName: (body.displayName || body.name) as string,
        authProfileId: body.authProfileId as string,
        metadata:
          body.metadata && typeof body.metadata === 'object'
            ? (body.metadata as Record<string, unknown>)
            : undefined,
        scope: body.scope as 'tenant' | 'user' | undefined,
      });
      return NextResponse.json({ success: true, data }, { status: 201 });
    } catch (err) {
      if (err instanceof ConnectionServiceError) {
        return NextResponse.json({ success: false, error: err.message }, { status: 400 });
      }
      throw err;
    }
  },
);

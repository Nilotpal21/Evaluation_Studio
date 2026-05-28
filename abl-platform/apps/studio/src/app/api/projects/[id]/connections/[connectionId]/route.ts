/**
 * GET    /api/projects/:id/connections/:connectionId — Get connection detail
 * PUT    /api/projects/:id/connections/:connectionId — Update connection
 * DELETE /api/projects/:id/connections/:connectionId — Delete connection
 *
 * Direct MongoDB access via shared ConnectionService (no WE proxy).
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { getConnectionService } from '@/lib/connection-service';
import { StudioPermission } from '@/lib/permissions';

// ─── GET (Detail) ───────────────────────────────────────────────────────

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.CONNECTION_READ },
  async ({ tenantId, params }) => {
    const svc = await getConnectionService();
    const data = await svc.getById(tenantId, params.id, params.connectionId);

    if (!data) {
      return NextResponse.json({ success: false, error: 'Connection not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data });
  },
);

// ─── PUT (Update) ───────────────────────────────────────────────────────

export const PUT = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.CONNECTION_WRITE },
  async ({ request, tenantId, params }) => {
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
    }

    const svc = await getConnectionService();

    const data = await svc.update(tenantId, params.id, params.connectionId, {
      displayName: (body.displayName || body.name) as string | undefined,
      authProfileId: body.authProfileId as string | undefined,
      metadata: (body.metadata as Record<string, unknown> | null | undefined) ?? undefined,
      status: body.status as 'active' | 'expired' | 'revoked' | undefined,
    });

    if (!data) {
      return NextResponse.json({ success: false, error: 'Connection not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data });
  },
);

// ─── DELETE ─────────────────────────────────────────────────────────────

export const DELETE = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.CONNECTION_DELETE },
  async ({ tenantId, params }) => {
    const svc = await getConnectionService();
    const deleted = await svc.delete(tenantId, params.id, params.connectionId);

    if (!deleted) {
      return NextResponse.json({ success: false, error: 'Connection not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  },
);

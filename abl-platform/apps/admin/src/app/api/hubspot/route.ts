/**
 * POST /api/hubspot — Proxy to runtime HubSpot sync endpoint
 *
 * Forwards sync requests to runtime /api/platform/admin/hubspot/sync.
 */

import { NextResponse } from 'next/server';
import { withAdminRoute, type AdminRouteContext } from '../../../lib/with-admin-route';
import { getRuntimeBaseUrl, buildRuntimeHeaders } from '../../../lib/runtime-proxy';
import { hubSpotSyncRequestSchema } from '../../../lib/admin-proxy-schemas';
import { readValidatedJsonBody } from '../../../lib/validated-json-body';

export const POST = withAdminRoute({ role: 'ADMIN' }, async (ctx: AdminRouteContext) => {
  const parsedBody = await readValidatedJsonBody(ctx.request, hubSpotSyncRequestSchema);
  if (!parsedBody.success) {
    return parsedBody.response;
  }

  try {
    const res = await fetch(`${getRuntimeBaseUrl()}/api/platform/admin/hubspot/sync`, {
      method: 'POST',
      headers: buildRuntimeHeaders(ctx),
      body: JSON.stringify(parsedBody.data),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      { success: false, error: 'Failed to connect to runtime' },
      { status: 502 },
    );
  }
});

export const GET = withAdminRoute({ role: 'VIEWER' }, async (ctx: AdminRouteContext) => {
  try {
    const res = await fetch(`${getRuntimeBaseUrl()}/api/platform/admin/hubspot/status`, {
      headers: buildRuntimeHeaders(ctx),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      { success: false, error: 'Failed to connect to runtime' },
      { status: 502 },
    );
  }
});

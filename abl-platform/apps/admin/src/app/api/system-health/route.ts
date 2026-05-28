import { NextResponse } from 'next/server';
import { withAdminRoute, type AdminRouteContext } from '../../../lib/with-admin-route';
import { getRuntimeBaseUrl, buildRuntimeHeaders } from '../../../lib/runtime-proxy';

export const GET = withAdminRoute({ role: 'VIEWER' }, async (ctx: AdminRouteContext) => {
  try {
    const res = await fetch(`${getRuntimeBaseUrl()}/api/platform/admin/system-health`, {
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

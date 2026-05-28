import { NextResponse } from 'next/server';
import { withAdminRoute, type AdminRouteContext } from '../../../../../../lib/with-admin-route';
import { getRuntimeBaseUrl, buildRuntimeHeaders } from '../../../../../../lib/runtime-proxy';

export const GET = withAdminRoute({ role: 'VIEWER' }, async (ctx: AdminRouteContext) => {
  const { tenantId } = ctx.params;
  const searchParams = ctx.request.nextUrl.searchParams.toString();
  const url = `${getRuntimeBaseUrl()}/api/platform/admin/billing-policy/${encodeURIComponent(tenantId)}/materializations/publication-status${searchParams ? `?${searchParams}` : ''}`;

  try {
    const res = await fetch(url, { headers: buildRuntimeHeaders(ctx) });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      { success: false, error: 'Failed to connect to runtime' },
      { status: 502 },
    );
  }
});

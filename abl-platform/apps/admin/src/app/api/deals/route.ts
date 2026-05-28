import { NextResponse } from 'next/server';
import { withAdminRoute, type AdminRouteContext } from '../../../lib/with-admin-route';
import { getRuntimeBaseUrl, buildRuntimeHeaders } from '../../../lib/runtime-proxy';
import { createDealSchema } from '../../../lib/admin-proxy-schemas';
import { readValidatedJsonBody } from '../../../lib/validated-json-body';

export const GET = withAdminRoute({ role: 'VIEWER' }, async (ctx: AdminRouteContext) => {
  const searchParams = ctx.request.nextUrl.searchParams.toString();
  const url = `${getRuntimeBaseUrl()}/api/platform/admin/deals${searchParams ? `?${searchParams}` : ''}`;

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

export const POST = withAdminRoute({ role: 'ADMIN' }, async (ctx: AdminRouteContext) => {
  const parsedBody = await readValidatedJsonBody(ctx.request, createDealSchema);
  if (!parsedBody.success) {
    return parsedBody.response;
  }

  try {
    const res = await fetch(`${getRuntimeBaseUrl()}/api/platform/admin/deals`, {
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

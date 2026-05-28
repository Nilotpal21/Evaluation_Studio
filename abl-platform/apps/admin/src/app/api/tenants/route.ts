import { NextResponse } from 'next/server';
import { withAdminRoute, type AdminRouteContext } from '../../../lib/with-admin-route';
import { getRuntimeBaseUrl, buildRuntimeHeaders } from '../../../lib/runtime-proxy';
import { createTenantSchema } from '../../../lib/admin-proxy-schemas';
import { readValidatedJsonBody } from '../../../lib/validated-json-body';

export const GET = withAdminRoute({ role: 'VIEWER' }, async (ctx: AdminRouteContext) => {
  const searchParams = ctx.request.nextUrl.searchParams.toString();
  const url = `${getRuntimeBaseUrl()}/api/platform/admin/tenants${searchParams ? `?${searchParams}` : ''}`;

  try {
    const res = await fetch(url, { headers: buildRuntimeHeaders(ctx) });
    const data = await res.json();
    if (!res.ok) {
      const rawError = (data as { error?: unknown }).error;
      const errorMsg =
        typeof rawError === 'string'
          ? rawError
          : rawError && typeof rawError === 'object' && 'message' in rawError
            ? String((rawError as { message: unknown }).message)
            : `Runtime returned ${res.status}`;
      return NextResponse.json({ success: false, error: errorMsg }, { status: res.status });
    }
    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { success: false, error: 'Failed to connect to runtime' },
      { status: 502 },
    );
  }
});

export const POST = withAdminRoute({ role: 'ADMIN' }, async (ctx: AdminRouteContext) => {
  const parsedBody = await readValidatedJsonBody(ctx.request, createTenantSchema);
  if (!parsedBody.success) {
    return parsedBody.response;
  }

  try {
    const res = await fetch(`${getRuntimeBaseUrl()}/api/platform/admin/tenants`, {
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

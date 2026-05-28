import { NextResponse } from 'next/server';
import { withAdminRoute, type AdminRouteContext } from '../../../../../../lib/with-admin-route';
import { getRuntimeBaseUrl, buildRuntimeHeaders } from '../../../../../../lib/runtime-proxy';
import { updateTenantMemberRoleSchema } from '../../../../../../lib/admin-proxy-schemas';
import { readValidatedJsonBody } from '../../../../../../lib/validated-json-body';

export const DELETE = withAdminRoute({ role: 'ADMIN' }, async (ctx: AdminRouteContext) => {
  const { tenantId, userId } = ctx.params;

  try {
    const res = await fetch(
      `${getRuntimeBaseUrl()}/api/platform/admin/tenants/${encodeURIComponent(tenantId)}/members/${encodeURIComponent(userId)}`,
      {
        method: 'DELETE',
        headers: buildRuntimeHeaders(ctx),
      },
    );
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      { success: false, error: 'Failed to connect to runtime' },
      { status: 502 },
    );
  }
});

export const PATCH = withAdminRoute({ role: 'ADMIN' }, async (ctx: AdminRouteContext) => {
  const { tenantId, userId } = ctx.params;
  const parsedBody = await readValidatedJsonBody(ctx.request, updateTenantMemberRoleSchema);
  if (!parsedBody.success) {
    return parsedBody.response;
  }

  try {
    const res = await fetch(
      `${getRuntimeBaseUrl()}/api/platform/admin/tenants/${encodeURIComponent(tenantId)}/members/${encodeURIComponent(userId)}`,
      {
        method: 'PATCH',
        headers: buildRuntimeHeaders(ctx),
        body: JSON.stringify(parsedBody.data),
      },
    );
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      { success: false, error: 'Failed to connect to runtime' },
      { status: 502 },
    );
  }
});

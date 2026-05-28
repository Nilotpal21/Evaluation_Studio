import { NextResponse } from 'next/server';
import { withAdminRoute, type AdminRouteContext } from '../../../../../../lib/with-admin-route';
import { getRuntimeBaseUrl, buildRuntimeHeaders } from '../../../../../../lib/runtime-proxy';
import { updateDealLineItemSchema } from '../../../../../../lib/admin-proxy-schemas';
import { readValidatedJsonBody } from '../../../../../../lib/validated-json-body';

export const PATCH = withAdminRoute({ role: 'ADMIN' }, async (ctx: AdminRouteContext) => {
  const { id, lineItemId } = ctx.params;
  const parsedBody = await readValidatedJsonBody(ctx.request, updateDealLineItemSchema);
  if (!parsedBody.success) {
    return parsedBody.response;
  }

  try {
    const res = await fetch(
      `${getRuntimeBaseUrl()}/api/platform/admin/deals/${encodeURIComponent(id)}/line-items/${encodeURIComponent(lineItemId)}`,
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

export const DELETE = withAdminRoute({ role: 'ADMIN' }, async (ctx: AdminRouteContext) => {
  const { id, lineItemId } = ctx.params;

  try {
    const res = await fetch(
      `${getRuntimeBaseUrl()}/api/platform/admin/deals/${encodeURIComponent(id)}/line-items/${encodeURIComponent(lineItemId)}`,
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

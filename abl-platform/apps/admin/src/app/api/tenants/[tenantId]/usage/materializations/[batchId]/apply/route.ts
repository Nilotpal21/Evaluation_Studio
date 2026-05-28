import { NextResponse } from 'next/server';
import {
  withAdminRoute,
  type AdminRouteContext,
} from '../../../../../../../../lib/with-admin-route';
import { getRuntimeBaseUrl, buildRuntimeHeaders } from '../../../../../../../../lib/runtime-proxy';

export const POST = withAdminRoute(
  { role: 'OPERATOR' },
  async (
    ctx: AdminRouteContext<{
      tenantId: string;
      batchId: string;
    }>,
  ) => {
    const { tenantId, batchId } = ctx.params;

    try {
      const res = await fetch(
        `${getRuntimeBaseUrl()}/api/platform/admin/billing-policy/${encodeURIComponent(tenantId)}/materializations/${encodeURIComponent(batchId)}/apply`,
        {
          method: 'POST',
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
  },
);

import { NextResponse } from 'next/server';
import { withAdminRoute, type AdminRouteContext } from '../../../../lib/with-admin-route';
import {
  getTemplateStoreUrl,
  buildTemplateStoreHeaders,
} from '../../../../lib/template-store-proxy';
import { createLogger } from '../../../../lib/logger';

const log = createLogger('admin-templates-upload-proxy');

export const POST = withAdminRoute({ role: 'ADMIN' }, async (ctx: AdminRouteContext) => {
  try {
    const body = await ctx.request.json();

    // The superadmin portal has already verified isSuperAdmin via withAdminRoute.
    // Inject publisherTenantId: 'platform' so the template-store creates a global
    // template, regardless of what tenantId the JWT contains.
    const enrichedBody = {
      ...body,
      publisherTenantId: 'platform',
    };

    const res = await fetch(`${getTemplateStoreUrl()}/api/v1/admin/templates/upload`, {
      method: 'POST',
      headers: buildTemplateStoreHeaders(ctx),
      body: JSON.stringify(enrichedBody),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: unknown) {
    log.error('Failed to proxy POST /templates/upload to template-store', {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        success: false,
        error: { code: 'PROXY_ERROR', message: 'Failed to connect to template store' },
      },
      { status: 502 },
    );
  }
});

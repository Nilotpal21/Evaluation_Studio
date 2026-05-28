import { NextResponse } from 'next/server';
import { withAdminRoute, type AdminRouteContext } from '../../../lib/with-admin-route';
import { getTemplateStoreUrl, buildTemplateStoreHeaders } from '../../../lib/template-store-proxy';
import { createLogger } from '../../../lib/logger';

const log = createLogger('admin-templates-proxy');

export const GET = withAdminRoute({ role: 'VIEWER' }, async (ctx: AdminRouteContext) => {
  // Superadmin portal only manages global (platform) templates.
  // Force publisherTenantId=platform in the query to ensure tenant-scoped
  // templates don't appear in the superadmin view.
  const params = new URLSearchParams(ctx.request.nextUrl.searchParams);
  params.set('publisherTenantId', 'platform');
  const url = `${getTemplateStoreUrl()}/api/v1/admin/templates?${params.toString()}`;

  try {
    const res = await fetch(url, { headers: buildTemplateStoreHeaders(ctx) });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: unknown) {
    log.error('Failed to proxy GET /templates to template-store', {
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

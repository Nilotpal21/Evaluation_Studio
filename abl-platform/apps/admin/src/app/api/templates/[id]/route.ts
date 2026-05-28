import { NextResponse } from 'next/server';
import { withAdminRoute, type AdminRouteContext } from '../../../../lib/with-admin-route';
import {
  getTemplateStoreUrl,
  buildTemplateStoreHeaders,
} from '../../../../lib/template-store-proxy';
import { createLogger } from '../../../../lib/logger';

const log = createLogger('admin-template-detail-proxy');

export const GET = withAdminRoute({ role: 'VIEWER' }, async (ctx: AdminRouteContext) => {
  const { id } = ctx.params;
  try {
    const res = await fetch(
      `${getTemplateStoreUrl()}/api/v1/admin/templates/${encodeURIComponent(String(id))}`,
      { headers: buildTemplateStoreHeaders(ctx) },
    );
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: unknown) {
    log.error('Failed to proxy GET /templates/:id to template-store', {
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

export const PATCH = withAdminRoute({ role: 'ADMIN' }, async (ctx: AdminRouteContext) => {
  const { id } = ctx.params;
  try {
    const body = await ctx.request.json();
    const res = await fetch(
      `${getTemplateStoreUrl()}/api/v1/admin/templates/${encodeURIComponent(String(id))}`,
      {
        method: 'PATCH',
        headers: buildTemplateStoreHeaders(ctx),
        body: JSON.stringify(body),
      },
    );
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: unknown) {
    log.error('Failed to proxy PATCH /templates/:id to template-store', {
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

export const DELETE = withAdminRoute({ role: 'ADMIN' }, async (ctx: AdminRouteContext) => {
  const { id } = ctx.params;
  try {
    const res = await fetch(
      `${getTemplateStoreUrl()}/api/v1/admin/templates/${encodeURIComponent(String(id))}`,
      {
        method: 'DELETE',
        headers: buildTemplateStoreHeaders(ctx),
      },
    );
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: unknown) {
    log.error('Failed to proxy DELETE /templates/:id to template-store', {
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

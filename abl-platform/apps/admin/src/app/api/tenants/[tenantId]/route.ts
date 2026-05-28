import { NextResponse } from 'next/server';
import { withAdminRoute, type AdminRouteContext } from '../../../../lib/with-admin-route';
import { getRuntimeBaseUrl, buildRuntimeHeaders } from '../../../../lib/runtime-proxy';
import { createLogger } from '../../../../lib/logger';
import {
  tenantFeatureFlagSchema,
  tenantStatusChangeSchema,
} from '../../../../lib/admin-proxy-schemas';
import { readValidatedJsonBody } from '../../../../lib/validated-json-body';

const log = createLogger('admin-tenant-route');

export const GET = withAdminRoute({ role: 'VIEWER' }, async (ctx: AdminRouteContext) => {
  const { tenantId } = ctx.params;
  try {
    const res = await fetch(
      `${getRuntimeBaseUrl()}/api/platform/admin/tenants/${encodeURIComponent(tenantId)}`,
      { headers: buildRuntimeHeaders(ctx) },
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
  const { tenantId } = ctx.params;
  const parsedBody = await readValidatedJsonBody(ctx.request, tenantStatusChangeSchema);
  if (!parsedBody.success) {
    return parsedBody.response;
  }

  try {
    const res = await fetch(
      `${getRuntimeBaseUrl()}/api/platform/admin/tenants/${encodeURIComponent(tenantId)}/status`,
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

/** Toggle tenant feature flags (e.g. codeToolsEnabled) */
export const POST = withAdminRoute({ role: 'ADMIN' }, async (ctx: AdminRouteContext) => {
  const { tenantId } = ctx.params;
  const parsedBody = await readValidatedJsonBody(ctx.request, tenantFeatureFlagSchema);
  if (!parsedBody.success) {
    return parsedBody.response;
  }
  log.info('Received tenant feature toggle request', { tenantId, body: parsedBody.data });

  const url = `${getRuntimeBaseUrl()}/api/platform/admin/tenants/${encodeURIComponent(tenantId)}/features`;
  log.info('Forwarding tenant feature toggle request to runtime', { tenantId, url });

  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: buildRuntimeHeaders(ctx),
      body: JSON.stringify(parsedBody.data),
    });
    const data = await res.json();
    log.info('Runtime responded to tenant feature toggle request', {
      tenantId,
      status: res.status,
      data,
    });
    return NextResponse.json(data, { status: res.status });
  } catch (err: unknown) {
    log.error('Tenant feature toggle runtime connection failed', {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { success: false, error: 'Failed to connect to runtime' },
      { status: 502 },
    );
  }
});

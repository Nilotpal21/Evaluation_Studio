/**
 * Admin API Route — Tenant Attachment Configuration
 *
 * Proxies attachment config requests to the runtime's platform-admin
 * attachment config endpoint.
 *
 * GET:  Requires VIEWER role — reads tenant attachment configuration
 * PUT:  Requires ADMIN role — updates tenant attachment configuration
 */

import { NextResponse } from 'next/server';
import { withAdminRoute, type AdminRouteContext } from '../../../../lib/with-admin-route';
import { getRuntimeBaseUrl, buildRuntimeHeaders } from '../../../../lib/runtime-proxy';
import { createLogger } from '../../../../lib/logger';
import { tenantAttachmentConfigUpdateSchema } from '../../../../lib/admin-proxy-schemas';
import { readValidatedJsonBody } from '../../../../lib/validated-json-body';

const log = createLogger('admin-tenant-attachment-config-route');

async function getTenantAttachmentConfig(ctx: AdminRouteContext) {
  const { request } = ctx;
  const searchParams = request.nextUrl.searchParams.toString();
  const url = `${getRuntimeBaseUrl()}/api/platform/admin/tenant-attachment-config${searchParams ? `?${searchParams}` : ''}`;

  try {
    const res = await fetch(url, {
      headers: buildRuntimeHeaders(ctx),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: unknown) {
    log.error('Tenant attachment config GET proxy error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        success: false,
        error: { code: 'PROXY_ERROR', message: 'Failed to connect to runtime' },
      },
      { status: 502 },
    );
  }
}

async function updateTenantAttachmentConfig(ctx: AdminRouteContext) {
  const { request } = ctx;
  const searchParams = request.nextUrl.searchParams.toString();
  const url = `${getRuntimeBaseUrl()}/api/platform/admin/tenant-attachment-config${searchParams ? `?${searchParams}` : ''}`;

  const parsedBody = await readValidatedJsonBody(request, tenantAttachmentConfigUpdateSchema);
  if (!parsedBody.success) {
    return parsedBody.response;
  }

  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: buildRuntimeHeaders(ctx),
      body: JSON.stringify(parsedBody.data),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: unknown) {
    log.error('Tenant attachment config PUT proxy error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        success: false,
        error: { code: 'PROXY_ERROR', message: 'Failed to connect to runtime' },
      },
      { status: 502 },
    );
  }
}

export const GET = withAdminRoute({ role: 'VIEWER' }, getTenantAttachmentConfig);

export const PUT = withAdminRoute({ role: 'ADMIN' }, updateTenantAttachmentConfig);

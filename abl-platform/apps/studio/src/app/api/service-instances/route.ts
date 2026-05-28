/**
 * GET  /api/service-instances — List tenant service instances
 * POST /api/service-instances — Create a new service instance
 *
 * Proxies to runtime /api/tenants/:tenantId/service-instances
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { proxyToRuntime } from '@/lib/runtime-proxy';

async function getHandler(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const tenantId = user.tenantId;

  try {
    // Forward query params (e.g., serviceType filter)
    const serviceType = request.nextUrl.searchParams.get('serviceType');
    const isActive = request.nextUrl.searchParams.get('isActive');
    let path = `/api/tenants/${encodeURIComponent(tenantId)}/service-instances`;
    const searchParams = new URLSearchParams();
    if (serviceType) {
      searchParams.set('serviceType', serviceType);
    }
    if (isActive) {
      searchParams.set('isActive', isActive);
    }
    const queryString = searchParams.toString();
    if (queryString) {
      path += `?${queryString}`;
    }
    return await proxyToRuntime(request, path, { tenantId });
  } catch (error) {
    console.error('[ServiceInstances] Proxy GET error:', error);
    return NextResponse.json(
      {
        success: false,
        error: { code: 'PROXY_ERROR', message: 'Failed to fetch service instances from runtime' },
      },
      { status: 502 },
    );
  }
}

async function postHandler(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const tenantId = user.tenantId;

  try {
    const body = await request.json();
    return await proxyToRuntime(
      request,
      `/api/tenants/${encodeURIComponent(tenantId)}/service-instances`,
      {
        method: 'POST',
        body,
        tenantId,
      },
    );
  } catch (error) {
    console.error('[ServiceInstances] Proxy POST error:', error);
    return NextResponse.json(
      {
        success: false,
        error: { code: 'PROXY_ERROR', message: 'Failed to create service instance via runtime' },
      },
      { status: 502 },
    );
  }
}

export const GET = getHandler;
export const POST = postHandler;

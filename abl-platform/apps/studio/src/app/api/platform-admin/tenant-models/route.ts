/**
 * GET  /api/platform-admin/tenant-models — List tenant models across tenants (admin)
 * POST /api/platform-admin/tenant-models — Provision a tenant model (admin)
 *
 * Platform admin proxy routes. The targetTenantId comes from query params (GET)
 * or the request body (POST), NOT from the authenticated user's tenant context,
 * because admins operate across tenants.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  requireAuth,
  isAuthError,
  requirePlatformAdminAccess,
  requirePlatformAdminIpAccess,
} from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';

function buildProxyHeaders(request: NextRequest): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const auth = request.headers.get('Authorization');
  if (auth) headers['Authorization'] = auth;
  return headers;
}

export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const forbidden = await requirePlatformAdminAccess(user);
  if (forbidden) return forbidden;
  const ipBlocked = requirePlatformAdminIpAccess(request);
  if (ipBlocked) return ipBlocked;

  try {
    const searchParams = request.nextUrl.searchParams;
    const queryString = searchParams.toString();
    const url = `${getRuntimeUrl()}/api/platform/admin/tenant-models${queryString ? `?${queryString}` : ''}`;

    const headers = buildProxyHeaders(request);
    const response = await fetch(url, { headers });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('[PlatformAdmin:TenantModels] Proxy GET error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch tenant models from runtime' },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const forbidden = await requirePlatformAdminAccess(user);
  if (forbidden) return forbidden;
  const ipBlocked = requirePlatformAdminIpAccess(request);
  if (ipBlocked) return ipBlocked;

  try {
    const body = await request.json();
    const headers = buildProxyHeaders(request);
    const response = await fetch(`${getRuntimeUrl()}/api/platform/admin/tenant-models`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('[PlatformAdmin:TenantModels] Proxy POST error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create tenant model via runtime' },
      { status: 502 },
    );
  }
}

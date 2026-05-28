/**
 * GET   /api/platform-admin/tenant-models/:id — Get tenant model detail (admin)
 * PATCH /api/platform-admin/tenant-models/:id — Update a tenant model (admin)
 *
 * Platform admin proxy routes for individual tenant model operations.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  requireAuth,
  isAuthError,
  requirePlatformAdminAccess,
  requirePlatformAdminIpAccess,
} from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';

type RouteParams = { params: Promise<{ id: string }> };

function buildProxyHeaders(request: NextRequest): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const auth = request.headers.get('Authorization');
  if (auth) headers['Authorization'] = auth;
  return headers;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const forbidden = await requirePlatformAdminAccess(user);
  if (forbidden) return forbidden;
  const ipBlocked = requirePlatformAdminIpAccess(request);
  if (ipBlocked) return ipBlocked;

  const { id } = await params;

  try {
    const headers = buildProxyHeaders(request);
    const response = await fetch(`${getRuntimeUrl()}/api/platform/admin/tenant-models/${id}`, {
      headers,
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('[PlatformAdmin:TenantModels] Proxy GET detail error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch tenant model detail from runtime' },
      { status: 502 },
    );
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const forbidden = await requirePlatformAdminAccess(user);
  if (forbidden) return forbidden;
  const ipBlocked = requirePlatformAdminIpAccess(request);
  if (ipBlocked) return ipBlocked;

  const { id } = await params;

  try {
    const body = await request.json();
    const headers = buildProxyHeaders(request);
    const response = await fetch(`${getRuntimeUrl()}/api/platform/admin/tenant-models/${id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('[PlatformAdmin:TenantModels] Proxy PATCH error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update tenant model via runtime' },
      { status: 502 },
    );
  }
}

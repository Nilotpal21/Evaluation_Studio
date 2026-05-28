/**
 * PATCH  /api/platform-admin/tenant-models/:id/connections/:connId — Update a connection (admin)
 * DELETE /api/platform-admin/tenant-models/:id/connections/:connId — Remove a connection (admin)
 *
 * Platform admin proxy routes for managing individual connections on tenant models.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  requireAuth,
  isAuthError,
  requirePlatformAdminAccess,
  requirePlatformAdminIpAccess,
} from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';

type RouteParams = { params: Promise<{ id: string; connId: string }> };

function buildProxyHeaders(request: NextRequest): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const auth = request.headers.get('Authorization');
  if (auth) headers['Authorization'] = auth;
  return headers;
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const forbidden = await requirePlatformAdminAccess(user);
  if (forbidden) return forbidden;
  const ipBlocked = requirePlatformAdminIpAccess(request);
  if (ipBlocked) return ipBlocked;

  const { id, connId } = await params;

  try {
    const body = await request.json();
    const headers = buildProxyHeaders(request);
    const response = await fetch(
      `${getRuntimeUrl()}/api/platform/admin/tenant-models/${id}/connections/${connId}`,
      { method: 'PATCH', headers, body: JSON.stringify(body) },
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('[PlatformAdmin:TenantModels] Proxy PATCH connection error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update connection via runtime' },
      { status: 502 },
    );
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const forbidden = await requirePlatformAdminAccess(user);
  if (forbidden) return forbidden;
  const ipBlocked = requirePlatformAdminIpAccess(request);
  if (ipBlocked) return ipBlocked;

  const { id, connId } = await params;

  try {
    const headers = buildProxyHeaders(request);
    const response = await fetch(
      `${getRuntimeUrl()}/api/platform/admin/tenant-models/${id}/connections/${connId}`,
      { method: 'DELETE', headers },
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('[PlatformAdmin:TenantModels] Proxy DELETE connection error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to remove connection via runtime' },
      { status: 502 },
    );
  }
}

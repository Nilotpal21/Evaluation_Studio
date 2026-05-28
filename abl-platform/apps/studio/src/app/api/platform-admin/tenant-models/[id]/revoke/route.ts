/**
 * POST /api/platform-admin/tenant-models/:id/revoke — Revoke a tenant model (admin)
 *
 * Platform admin proxy route for revoking (deprovisioning) a tenant model.
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

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const forbidden = await requirePlatformAdminAccess(user);
  if (forbidden) return forbidden;
  const ipBlocked = requirePlatformAdminIpAccess(request);
  if (ipBlocked) return ipBlocked;

  const { id } = await params;

  try {
    const headers = buildProxyHeaders(request);
    const response = await fetch(
      `${getRuntimeUrl()}/api/platform/admin/tenant-models/${id}/revoke`,
      {
        method: 'POST',
        headers,
      },
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('[PlatformAdmin:TenantModels] Proxy POST revoke error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to revoke tenant model via runtime' },
      { status: 502 },
    );
  }
}

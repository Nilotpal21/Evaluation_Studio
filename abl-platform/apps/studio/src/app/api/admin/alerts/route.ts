/**
 * GET/POST /api/admin/alerts — Proxy to runtime tenant alert configs
 *
 * Forwards to runtime /api/tenants/:tenantId/alerts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError, requireAdminRole } from '@/lib/auth';
import { proxyToRuntime } from '@/lib/runtime-proxy';

export async function GET(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;
  const adminErr = await requireAdminRole(user.id, user.tenantId);
  if (adminErr) return adminErr;

  const path = `/api/tenants/${user.tenantId}/alerts`;

  try {
    return await proxyToRuntime(request, path, { tenantId: user.tenantId });
  } catch {
    return NextResponse.json(
      { success: false, error: 'Failed to fetch alert configs from runtime' },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;
  const adminErr = await requireAdminRole(user.id, user.tenantId);
  if (adminErr) return adminErr;

  const body = await request.json();
  const path = `/api/tenants/${user.tenantId}/alerts`;

  try {
    return await proxyToRuntime(request, path, { method: 'POST', body, tenantId: user.tenantId });
  } catch {
    return NextResponse.json(
      { success: false, error: 'Failed to create alert config' },
      { status: 502 },
    );
  }
}

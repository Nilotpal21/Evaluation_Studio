/**
 * POST /api/tenant-models/:id/connections/:connId/validate — Validate a connection credential
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';

type RouteParams = { params: Promise<{ id: string; connId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id, connId } = await params;
  const tenantId = user.tenantId;

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const auth = request.headers.get('Authorization');
    if (auth) headers['Authorization'] = auth;
    headers['X-Tenant-Id'] = tenantId;

    const response = await fetch(
      `${getRuntimeUrl()}/api/tenants/${encodeURIComponent(tenantId)}/models/${encodeURIComponent(id)}/connections/${encodeURIComponent(connId)}/validate`,
      { method: 'POST', headers },
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('[TenantModels] Proxy validate connection error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to validate connection via runtime' },
      { status: 502 },
    );
  }
}

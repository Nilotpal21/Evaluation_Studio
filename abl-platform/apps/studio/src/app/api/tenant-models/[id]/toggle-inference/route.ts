/**
 * POST /api/tenant-models/:id/toggle-inference — Proxy to runtime
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;
  const tenantId = user.tenantId;

  try {
    const body = await request.json();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const auth = request.headers.get('Authorization');
    if (auth) headers['Authorization'] = auth;
    headers['X-Tenant-Id'] = tenantId;

    const response = await fetch(
      `${getRuntimeUrl()}/api/tenants/${tenantId}/models/${id}/toggle-inference`,
      { method: 'POST', headers, body: JSON.stringify(body) },
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('[TenantModels] Proxy toggle-inference error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to toggle inference via runtime' },
      { status: 502 },
    );
  }
}

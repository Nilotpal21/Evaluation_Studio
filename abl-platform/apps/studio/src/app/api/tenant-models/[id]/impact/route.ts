/**
 * GET /api/tenant-models/:id/impact — Proxy to runtime
 *
 * Returns the list of projects that would be affected by disabling this model.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;
  const tenantId = request.nextUrl.searchParams.get('tenantId');
  if (!tenantId) {
    return NextResponse.json({ error: 'tenantId query parameter is required' }, { status: 400 });
  }

  try {
    const headers: Record<string, string> = {};
    const auth = request.headers.get('Authorization');
    if (auth) headers['Authorization'] = auth;
    headers['X-Tenant-Id'] = tenantId;

    const response = await fetch(`${getRuntimeUrl()}/api/tenants/${tenantId}/models/${id}/impact`, {
      method: 'GET',
      headers,
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('[TenantModels] Proxy impact check error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to check model impact via runtime' },
      { status: 502 },
    );
  }
}

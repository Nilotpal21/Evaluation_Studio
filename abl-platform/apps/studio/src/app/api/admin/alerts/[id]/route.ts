/**
 * PATCH/DELETE /api/admin/alerts/:id — Proxy to runtime tenant alert configs
 *
 * Forwards to runtime /api/tenants/:tenantId/alerts/:id.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyToRuntime } from '@/lib/runtime-proxy';

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const tenantId = request.nextUrl.searchParams.get('tenantId');
  if (!tenantId) {
    return NextResponse.json({ error: 'tenantId query parameter is required' }, { status: 400 });
  }

  const { id } = await params;
  const body = await request.json();
  const path = `/api/tenants/${tenantId}/alerts/${id}`;

  try {
    return await proxyToRuntime(request, path, { method: 'PATCH', body, tenantId });
  } catch {
    return NextResponse.json(
      { success: false, error: 'Failed to update alert config' },
      { status: 502 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const tenantId = request.nextUrl.searchParams.get('tenantId');
  if (!tenantId) {
    return NextResponse.json({ error: 'tenantId query parameter is required' }, { status: 400 });
  }

  const { id } = await params;
  const path = `/api/tenants/${tenantId}/alerts/${id}`;

  try {
    return await proxyToRuntime(request, path, { method: 'DELETE', body: {}, tenantId });
  } catch {
    return NextResponse.json(
      { success: false, error: 'Failed to delete alert config' },
      { status: 502 },
    );
  }
}

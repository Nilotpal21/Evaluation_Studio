/**
 * PATCH  /api/tenant-models/:id/connections/:connId — Update a connection
 * DELETE /api/tenant-models/:id/connections/:connId — Remove a connection
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { buildRuntimeProxyHeaders } from '@/lib/runtime-proxy';
import { getRuntimeUrl } from '@/config/runtime.server';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('studio:tenant-model-connection');

type RouteParams = { params: Promise<{ id: string; connId: string }> };

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id, connId } = await params;
  const tenantId = user.tenantId;

  try {
    const body = await request.json();
    const headers = buildRuntimeProxyHeaders(request, tenantId);
    const response = await fetch(
      `${getRuntimeUrl()}/api/tenants/${tenantId}/models/${id}/connections/${connId}`,
      { method: 'PATCH', headers, body: JSON.stringify(body) },
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error('Proxy PATCH connection failed', { error: msg, tenantModelId: id, connId });
    return NextResponse.json(
      { success: false, error: 'Failed to update connection via runtime' },
      { status: 502 },
    );
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id, connId } = await params;
  const tenantId = user.tenantId;

  try {
    const headers = buildRuntimeProxyHeaders(request, tenantId);
    const response = await fetch(
      `${getRuntimeUrl()}/api/tenants/${tenantId}/models/${id}/connections/${connId}`,
      { method: 'DELETE', headers },
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error('Proxy DELETE connection failed', { error: msg, tenantModelId: id, connId });
    return NextResponse.json(
      { success: false, error: 'Failed to remove connection via runtime' },
      { status: 502 },
    );
  }
}

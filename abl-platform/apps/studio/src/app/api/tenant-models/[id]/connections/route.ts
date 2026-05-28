/**
 * GET  /api/tenant-models/:id/connections — List connections for a tenant model
 * POST /api/tenant-models/:id/connections — Create a new connection
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { buildRuntimeProxyHeaders } from '@/lib/runtime-proxy';
import { getRuntimeUrl } from '@/config/runtime.server';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('studio:tenant-model-connections');

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;
  const tenantId = user.tenantId;

  try {
    const headers = buildRuntimeProxyHeaders(request, tenantId);
    const response = await fetch(
      `${getRuntimeUrl()}/api/tenants/${tenantId}/models/${id}/connections`,
      { headers },
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error('Proxy GET connections failed', { error: msg, tenantModelId: id });
    return NextResponse.json(
      { success: false, error: 'Failed to fetch connections from runtime' },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;
  const tenantId = user.tenantId;

  try {
    const body = await request.json();
    const headers = buildRuntimeProxyHeaders(request, tenantId);
    const response = await fetch(
      `${getRuntimeUrl()}/api/tenants/${tenantId}/models/${id}/connections`,
      { method: 'POST', headers, body: JSON.stringify(body) },
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error('Proxy POST connection failed', { error: msg, tenantModelId: id });
    return NextResponse.json(
      { success: false, error: 'Failed to create connection via runtime' },
      { status: 502 },
    );
  }
}

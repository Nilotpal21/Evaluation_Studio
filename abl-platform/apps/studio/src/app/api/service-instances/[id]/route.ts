/**
 * GET    /api/service-instances/:id — Get a single service instance
 * PATCH  /api/service-instances/:id — Update a service instance
 * DELETE /api/service-instances/:id — Delete a service instance
 *
 * Proxies to runtime /api/tenants/:tenantId/service-instances/:id
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { proxyToRuntime } from '@/lib/runtime-proxy';

async function getHandler(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;
  const tenantId = user.tenantId;

  try {
    return await proxyToRuntime(
      request,
      `/api/tenants/${encodeURIComponent(tenantId)}/service-instances/${encodeURIComponent(id)}`,
      { tenantId },
    );
  } catch (error) {
    console.error('[ServiceInstances] Proxy GET/:id error:', error);
    return NextResponse.json(
      {
        success: false,
        error: { code: 'PROXY_ERROR', message: 'Failed to fetch service instance from runtime' },
      },
      { status: 502 },
    );
  }
}

async function patchHandler(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;
  const tenantId = user.tenantId;

  try {
    const body = await request.json();
    return await proxyToRuntime(
      request,
      `/api/tenants/${encodeURIComponent(tenantId)}/service-instances/${encodeURIComponent(id)}`,
      { method: 'PATCH', body, tenantId },
    );
  } catch (error) {
    console.error('[ServiceInstances] Proxy PATCH error:', error);
    return NextResponse.json(
      {
        success: false,
        error: { code: 'PROXY_ERROR', message: 'Failed to update service instance via runtime' },
      },
      { status: 502 },
    );
  }
}

async function deleteHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;
  const tenantId = user.tenantId;

  try {
    return await proxyToRuntime(
      request,
      `/api/tenants/${encodeURIComponent(tenantId)}/service-instances/${encodeURIComponent(id)}`,
      { method: 'DELETE', tenantId },
    );
  } catch (error) {
    console.error('[ServiceInstances] Proxy DELETE error:', error);
    return NextResponse.json(
      {
        success: false,
        error: { code: 'PROXY_ERROR', message: 'Failed to delete service instance via runtime' },
      },
      { status: 502 },
    );
  }
}

export const GET = getHandler;
export const PATCH = patchHandler;
export const DELETE = deleteHandler;

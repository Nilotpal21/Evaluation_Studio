/**
 * GET/POST/PUT/DELETE /api/admin/channel-connections
 *
 * Proxy to runtime /api/tenants/:tenantId/channel-connections
 * with auth headers and tenant context.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError, requireAdminRole } from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('admin-channel-connections');

function buildHeaders(request: NextRequest, tenantId: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const auth = request.headers.get('Authorization');
  if (auth) headers['Authorization'] = auth;
  headers['X-Tenant-Id'] = tenantId;
  return headers;
}

function buildUrl(tenantId: string, request: NextRequest): string {
  const connectionId = request.nextUrl.searchParams.get('connectionId');
  const forwardParams = new URLSearchParams(request.nextUrl.searchParams);
  forwardParams.delete('connectionId');
  const qs = forwardParams.toString();
  const queryString = qs ? `?${qs}` : '';
  const idPath = connectionId ? `/${encodeURIComponent(connectionId)}` : '';
  return `${getRuntimeUrl()}/api/tenants/${encodeURIComponent(tenantId)}/channel-connections${idPath}${queryString}`;
}

export async function GET(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;
  const adminErr = await requireAdminRole(user.id, user.tenantId);
  if (adminErr) return adminErr;

  try {
    const url = buildUrl(user.tenantId, request);
    const response = await fetch(url, {
      headers: buildHeaders(request, user.tenantId),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    log.error('Proxy GET failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;
  const adminErr = await requireAdminRole(user.id, user.tenantId);
  if (adminErr) return adminErr;

  try {
    const body = await request.json();
    const url = buildUrl(user.tenantId, request);
    const response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(request, user.tenantId),
      body: JSON.stringify(body),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    log.error('Proxy POST failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 502 });
  }
}

export async function PUT(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;
  const adminErr = await requireAdminRole(user.id, user.tenantId);
  if (adminErr) return adminErr;

  try {
    const body = await request.json();
    const url = buildUrl(user.tenantId, request);
    const response = await fetch(url, {
      method: 'PUT',
      headers: buildHeaders(request, user.tenantId),
      body: JSON.stringify(body),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    log.error('Proxy PUT failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 502 });
  }
}

export async function DELETE(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;
  const adminErr = await requireAdminRole(user.id, user.tenantId);
  if (adminErr) return adminErr;

  try {
    const url = buildUrl(user.tenantId, request);
    const response = await fetch(url, {
      method: 'DELETE',
      headers: buildHeaders(request, user.tenantId),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    log.error('Proxy DELETE failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 502 });
  }
}

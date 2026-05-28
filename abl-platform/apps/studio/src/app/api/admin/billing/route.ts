/**
 * GET/POST /api/admin/billing — Proxy to runtime Workspace Billing API
 *
 * Forwards requests to /api/tenants/:tenantId/billing/* with auth headers
 * and tenant context.
 */

import { NextRequest, NextResponse } from 'next/server';
import { BILLING_READ_PERMISSION } from '@agent-platform/shared/rbac';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';
import { hasPermission } from '@/lib/permission-resolver';

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
  const endpoint = request.nextUrl.searchParams.get('endpoint') || '';
  const forwardParams = new URLSearchParams(request.nextUrl.searchParams);
  forwardParams.delete('endpoint');
  const qs = forwardParams.toString();
  const queryString = qs ? `?${qs}` : '';
  const path = endpoint ? `/${endpoint}` : '';
  return `${getRuntimeUrl()}/api/tenants/${encodeURIComponent(tenantId)}/billing${path}${queryString}`;
}

function requireBillingAccess(userPermissions: string[]): NextResponse | null {
  if (hasPermission(userPermissions, BILLING_READ_PERMISSION)) {
    return null;
  }

  return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
}

export async function GET(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;
  const billingAccessError = requireBillingAccess(user.permissions);
  if (billingAccessError) return billingAccessError;

  try {
    const url = buildUrl(user.tenantId, request);
    const response = await fetch(url, {
      headers: buildHeaders(request, user.tenantId),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { success: false, error: `Billing proxy GET failed: ${message}` },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;
  const billingAccessError = requireBillingAccess(user.permissions);
  if (billingAccessError) return billingAccessError;

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
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { success: false, error: `Billing proxy POST failed: ${message}` },
      { status: 502 },
    );
  }
}

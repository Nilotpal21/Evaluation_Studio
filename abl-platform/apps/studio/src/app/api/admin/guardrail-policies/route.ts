/**
 * GET/POST/PUT/DELETE /api/admin/guardrail-policies
 *
 * Proxy to runtime /api/guardrail-policies or
 * /api/projects/:projectId/guardrail-policies with auth headers and tenant
 * context. Project ID is optional and comes from the query param when present.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  requireTenantAuth,
  isAuthError,
  requireAdminRole,
  type TenantAuthenticatedUser,
} from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { isProjectPermissionError, requireProjectPermission } from '@/lib/project-permission';
import { StudioPermission } from '@/lib/permissions';

const log = createLogger('admin-guardrail-policies');

function buildHeaders(request: NextRequest, tenantId: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const auth = request.headers.get('Authorization');
  if (auth) headers['Authorization'] = auth;
  headers['X-Tenant-Id'] = tenantId;
  return headers;
}

const ALLOWED_POLICY_ACTIONS = new Set(['activate']);

function buildUrl(projectId: string | null, request: NextRequest): string {
  const policyId = request.nextUrl.searchParams.get('policyId');
  const action = request.nextUrl.searchParams.get('action');
  if (action && !ALLOWED_POLICY_ACTIONS.has(action)) {
    throw new Error(`Invalid action: ${action}`);
  }
  const forwardParams = new URLSearchParams(request.nextUrl.searchParams);
  forwardParams.delete('projectId');
  forwardParams.delete('policyId');
  forwardParams.delete('action');
  const qs = forwardParams.toString();
  const queryString = qs ? `?${qs}` : '';
  const idPath = policyId ? `/${encodeURIComponent(policyId)}` : '';
  const actionPath = action ? `/${encodeURIComponent(action)}` : '';
  const basePath = projectId
    ? `/api/projects/${encodeURIComponent(projectId)}/guardrail-policies`
    : '/api/guardrail-policies';
  return `${getRuntimeUrl()}${basePath}${idPath}${actionPath}${queryString}`;
}

async function requireGuardrailProxyPermission(
  request: NextRequest,
  user: TenantAuthenticatedUser,
  permission: StudioPermission,
): Promise<NextResponse | null> {
  const projectId = request.nextUrl.searchParams.get('projectId');
  if (!projectId) {
    return requireAdminRole(user.id, user.tenantId);
  }

  const access = await requireProjectPermission(projectId, user, permission);
  return isProjectPermissionError(access) ? access : null;
}

export async function GET(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;
  const permissionErr = await requireGuardrailProxyPermission(
    request,
    user,
    StudioPermission.GUARDRAIL_READ,
  );
  if (permissionErr) return permissionErr;

  try {
    const projectId = request.nextUrl.searchParams.get('projectId');
    const url = buildUrl(projectId, request);
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
  const permissionErr = await requireGuardrailProxyPermission(
    request,
    user,
    StudioPermission.GUARDRAIL_WRITE,
  );
  if (permissionErr) return permissionErr;

  try {
    const body = await request.json();
    const projectId = request.nextUrl.searchParams.get('projectId');
    const url = buildUrl(projectId, request);
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
  const permissionErr = await requireGuardrailProxyPermission(
    request,
    user,
    StudioPermission.GUARDRAIL_WRITE,
  );
  if (permissionErr) return permissionErr;

  try {
    const body = await request.json();
    const projectId = request.nextUrl.searchParams.get('projectId');
    const url = buildUrl(projectId, request);
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
  const permissionErr = await requireGuardrailProxyPermission(
    request,
    user,
    StudioPermission.GUARDRAIL_WRITE,
  );
  if (permissionErr) return permissionErr;

  try {
    const projectId = request.nextUrl.searchParams.get('projectId');
    const url = buildUrl(projectId, request);
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

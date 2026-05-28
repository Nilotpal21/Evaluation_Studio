/**
 * GET/POST /api/projects/:id/settings/versions — Proxy to runtime
 *
 * GET  — List settings versions
 * POST — Create a new settings version from working copy
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';
import { isProjectPermissionError, requireProjectPermission } from '@/lib/project-permission';

type RouteParams = { params: Promise<{ id: string }> };

async function proxyToRuntime(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;

  const requiredPermissions =
    request.method === 'GET' ? ['project:read', 'project:update'] : ['project:update'];
  const access = await requireProjectPermission(projectId, user, requiredPermissions);
  if (isProjectPermissionError(access)) return access;

  const url = new URL(request.url);
  const query = url.search;
  const runtimePath = `${getRuntimeUrl()}/api/projects/${projectId}/settings/versions${query}`;

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const auth = request.headers.get('authorization');
    if (auth) headers['Authorization'] = auth;
    headers['X-Tenant-Id'] = user.tenantId;

    const init: RequestInit = {
      method: request.method,
      headers,
    };

    if (request.method === 'POST') {
      init.body = await request.text();
    }

    const res = await fetch(runtimePath, init);
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (error) {
    console.error('[ProjectSettingsVersions Proxy] Error:', error);
    return NextResponse.json({ error: 'Failed to proxy to runtime' }, { status: 502 });
  }
}

export async function GET(request: NextRequest, ctx: RouteParams) {
  return proxyToRuntime(request, ctx);
}

export async function POST(request: NextRequest, ctx: RouteParams) {
  return proxyToRuntime(request, ctx);
}

/**
 * GET/PUT /api/projects/:id/settings — Proxy to runtime
 *
 * Proxies project execution settings (working copy) to the runtime API.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';
import { handleApiError } from '@/lib/api-response';
import { isProjectPermissionError, requireProjectPermission } from '@/lib/project-permission';

const log = createLogger('api:projects:settings');

type RouteParams = { params: Promise<{ id: string }> };

async function proxyToRuntime(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;

  const requiredPermissions =
    request.method === 'GET' ? ['project:read', 'project:update'] : ['project:update'];
  const access = await requireProjectPermission(projectId, user, requiredPermissions);
  if (isProjectPermissionError(access)) return access;

  const runtimePath = `${getRuntimeUrl()}/api/projects/${projectId}/settings`;

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const auth = request.headers.get('authorization');
    if (auth) headers['Authorization'] = auth;
    headers['X-Tenant-Id'] = user.tenantId;
    headers['X-Project-Id'] = projectId;
    headers['X-User-Id'] = user.id;

    const init: RequestInit = {
      method: request.method,
      headers,
    };

    if (request.method === 'PUT' || request.method === 'POST') {
      init.body = await request.text();
    }

    const res = await fetch(runtimePath, init);
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (error) {
    return handleApiError(error, 'ProjectSettings.proxy');
  }
}

export async function GET(request: NextRequest, ctx: RouteParams) {
  return proxyToRuntime(request, ctx);
}

export async function PUT(request: NextRequest, ctx: RouteParams) {
  return proxyToRuntime(request, ctx);
}

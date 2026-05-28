/**
 * GET/PATCH/PUT /api/projects/:id/session-lifecycle — Proxy to runtime
 *
 * Proxies project session lifecycle configuration, including transfer TTL
 * overrides, to the runtime API.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';
import { isProjectPermissionError, requireProjectPermission } from '@/lib/project-permission';

const log = createLogger('studio:project-session-lifecycle');

type RouteParams = { params: Promise<{ id: string }> };

async function proxyToRuntime(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;

  const requiredPermissions =
    request.method === 'GET' ? ['project:read', 'project:update'] : ['project:update'];
  const access = await requireProjectPermission(projectId, user, requiredPermissions);
  if (isProjectPermissionError(access)) return access;

  const runtimePath = `${getRuntimeUrl()}/api/projects/${projectId}/session-lifecycle`;

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Tenant-Id': user.tenantId,
    };
    const auth = request.headers.get('authorization');
    if (auth) headers['Authorization'] = auth;

    const init: RequestInit = {
      method: request.method,
      headers,
    };

    if (request.method === 'PUT' || request.method === 'PATCH' || request.method === 'POST') {
      init.body = await request.text();
    }

    const res = await fetch(runtimePath, init);
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (error) {
    log.error('Failed to proxy project session lifecycle request to runtime', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
      method: request.method,
    });
    return NextResponse.json({ error: 'Failed to proxy to runtime' }, { status: 502 });
  }
}

export async function GET(request: NextRequest, ctx: RouteParams) {
  return proxyToRuntime(request, ctx);
}

export async function PATCH(request: NextRequest, ctx: RouteParams) {
  return proxyToRuntime(request, ctx);
}

export async function PUT(request: NextRequest, ctx: RouteParams) {
  return proxyToRuntime(request, ctx);
}

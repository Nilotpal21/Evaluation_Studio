/**
 * GET/PUT/DELETE /api/projects/:id/runtime-config — Proxy to runtime
 *
 * Proxies project runtime configuration (extraction, multi-intent, inference,
 * conversion, lookup tables) to the runtime API.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';
import { isProjectPermissionError, requireProjectPermission } from '@/lib/project-permission';

const log = createLogger('api:projects:runtime-config');

type RouteParams = { params: Promise<{ id: string }> };

async function proxyToRuntime(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;

  const requiredPermissions =
    request.method === 'GET' ? 'runtime_config:read' : 'runtime_config:write';
  const access = await requireProjectPermission(projectId, user, requiredPermissions);
  if (isProjectPermissionError(access)) return access;

  const runtimePath = `${getRuntimeUrl()}/api/projects/${projectId}/runtime-config`;

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

    if (request.method === 'PUT' || request.method === 'POST') {
      init.body = await request.text();
    }

    const res = await fetch(runtimePath, init);
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (error) {
    log.error('Runtime config proxy failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to proxy to runtime' }, { status: 502 });
  }
}

export async function GET(request: NextRequest, ctx: RouteParams) {
  return proxyToRuntime(request, ctx);
}

export async function PUT(request: NextRequest, ctx: RouteParams) {
  return proxyToRuntime(request, ctx);
}

export async function DELETE(request: NextRequest, ctx: RouteParams) {
  return proxyToRuntime(request, ctx);
}

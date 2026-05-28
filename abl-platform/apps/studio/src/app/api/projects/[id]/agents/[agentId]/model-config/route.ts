/**
 * GET /api/projects/:id/agents/:agentId/model-config — proxy to runtime
 * PUT /api/projects/:id/agents/:agentId/model-config — proxy to runtime
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { getRuntimeUrl } from '@/config/runtime.server';

type RouteParams = { params: Promise<{ id: string; agentId: string }> };

async function proxyToRuntime(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, agentId: agentName } = await params;

  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;
  const runtimePath = `${getRuntimeUrl()}/api/projects/${projectId}/agents/${agentName}/model-config`;

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    // Forward auth headers — use authenticated user's tenantId, never client-supplied headers
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
    console.error('[ModelConfig Proxy] Error:', error);
    return NextResponse.json({ error: 'Failed to proxy to runtime' }, { status: 502 });
  }
}

export async function GET(request: NextRequest, ctx: RouteParams) {
  return proxyToRuntime(request, ctx);
}

export async function PUT(request: NextRequest, ctx: RouteParams) {
  return proxyToRuntime(request, ctx);
}

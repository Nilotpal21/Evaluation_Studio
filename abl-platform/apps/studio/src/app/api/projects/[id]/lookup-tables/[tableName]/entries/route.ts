/**
 * GET/POST/DELETE /api/projects/:id/lookup-tables/:tableName/entries
 *
 * Proxies lookup table entry CRUD operations to the runtime API.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { getRuntimeUrl } from '@/config/runtime.server';

type RouteParams = { params: Promise<{ id: string; tableName: string }> };

async function proxyToRuntime(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, tableName } = await params;

  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  const searchParams = request.nextUrl.searchParams.toString();
  const qs = searchParams ? `?${searchParams}` : '';
  const runtimePath = `${getRuntimeUrl()}/api/projects/${projectId}/lookup-tables/${encodeURIComponent(tableName)}/entries${qs}`;

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

    if (request.method === 'POST' || request.method === 'PUT') {
      init.body = await request.text();
    }

    const res = await fetch(runtimePath, init);
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (error) {
    console.error('[LookupTableEntries Proxy] Error:', error);
    return NextResponse.json({ error: 'Failed to proxy to runtime' }, { status: 502 });
  }
}

export async function GET(request: NextRequest, ctx: RouteParams) {
  return proxyToRuntime(request, ctx);
}

export async function POST(request: NextRequest, ctx: RouteParams) {
  return proxyToRuntime(request, ctx);
}

export async function DELETE(request: NextRequest, ctx: RouteParams) {
  return proxyToRuntime(request, ctx);
}

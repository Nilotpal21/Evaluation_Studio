/**
 * POST /api/projects/:id/lookup-tables/:tableName/upload
 *
 * Proxies CSV/JSON file upload for lookup table entries to the runtime API.
 * Passes through the Content-Type header so the runtime can distinguish
 * between text/csv and application/json payloads.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { getRuntimeUrl } from '@/config/runtime.server';

type RouteParams = { params: Promise<{ id: string; tableName: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, tableName } = await params;

  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  const runtimePath = `${getRuntimeUrl()}/api/projects/${projectId}/lookup-tables/${encodeURIComponent(tableName)}/upload`;

  try {
    const contentType = request.headers.get('content-type') ?? 'application/json';
    const body = await request.text();

    const headers: Record<string, string> = {
      'Content-Type': contentType,
    };
    const auth = request.headers.get('authorization');
    if (auth) headers['Authorization'] = auth;
    headers['X-Tenant-Id'] = user.tenantId;

    const res = await fetch(runtimePath, {
      method: 'POST',
      headers,
      body,
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (error) {
    console.error('[LookupTableUpload Proxy] Error:', error);
    return NextResponse.json({ error: 'Failed to proxy to runtime' }, { status: 502 });
  }
}

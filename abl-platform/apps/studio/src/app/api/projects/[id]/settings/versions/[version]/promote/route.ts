/**
 * POST /api/projects/:id/settings/versions/:version/promote — Proxy to runtime
 *
 * Promote a settings version to a new lifecycle status.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';
import { isProjectPermissionError, requireProjectPermission } from '@/lib/project-permission';

type RouteParams = { params: Promise<{ id: string; version: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, version } = await params;

  const access = await requireProjectPermission(projectId, user, 'project:update');
  if (isProjectPermissionError(access)) return access;

  const runtimePath = `${getRuntimeUrl()}/api/projects/${projectId}/settings/versions/${version}/promote`;

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const auth = request.headers.get('authorization');
    if (auth) headers['Authorization'] = auth;
    headers['X-Tenant-Id'] = user.tenantId;

    const res = await fetch(runtimePath, {
      method: 'POST',
      headers,
      body: await request.text(),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (error) {
    console.error('[ProjectSettingsVersionPromote Proxy] Error:', error);
    return NextResponse.json({ error: 'Failed to proxy to runtime' }, { status: 502 });
  }
}

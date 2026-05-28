/**
 * GET /api/projects/:id/billing/usage — Proxy to runtime project billing usage
 *
 * Proxies project-scoped published billing usage reports to the runtime API
 * after tenant auth and project access checks pass.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { getRuntimeUrl } from '@/config/runtime.server';

const log = createLogger('studio:project-billing-usage');

type RouteParams = { params: Promise<{ id: string }> };

function buildRuntimePath(projectId: string, request: NextRequest): string {
  const queryString = request.nextUrl.searchParams.toString();
  return `${getRuntimeUrl()}/api/projects/${encodeURIComponent(projectId)}/billing/usage${queryString ? `?${queryString}` : ''}`;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Tenant-Id': user.tenantId,
    };
    const auth = request.headers.get('authorization');
    if (auth) headers['Authorization'] = auth;

    const response = await fetch(buildRuntimePath(projectId, request), {
      method: 'GET',
      headers,
      cache: 'no-store',
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    log.error('Failed to proxy project billing usage request to runtime', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to proxy to runtime' }, { status: 502 });
  }
}

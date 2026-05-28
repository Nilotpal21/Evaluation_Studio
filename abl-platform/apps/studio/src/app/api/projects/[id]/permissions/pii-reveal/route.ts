/**
 * GET /api/projects/:id/permissions/pii-reveal
 *
 * Returns whether the current actor has the exact sensitive `pii:reveal`
 * project permission. This intentionally uses the same Studio project
 * permission resolver as reveal actions instead of broad local role checks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { isProjectPermissionError, requireProjectPermission } from '@/lib/project-permission';

type RouteParams = { params: Promise<{ id: string }> };

const NO_STORE_CACHE_CONTROL = 'no-store';

function withNoStore(response: NextResponse | Response): NextResponse | Response {
  response.headers.set('Cache-Control', NO_STORE_CACHE_CONTROL);
  return response;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(_request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectPermission(projectId, user, 'pii:reveal');
  if (isProjectPermissionError(access)) {
    return withNoStore(access);
  }

  return withNoStore(NextResponse.json({ success: true, canRevealPII: true }));
}

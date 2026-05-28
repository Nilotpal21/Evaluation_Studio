/**
 * GET  /api/archives - List archives for the current organization
 * POST /api/archives/sessions - Archive sessions (handled by sub-routes)
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { findTenantMembership } from '@/repos/auth-repo';
import { findArchiveManifests } from '@/repos/archive-repo';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('archives-list-route');

export async function GET(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  try {
    const tenantMembership = await findTenantMembership(user.id, user.tenantId);
    if (!tenantMembership) {
      return NextResponse.json({ archives: [], nextCursor: undefined });
    }

    const type = request.nextUrl.searchParams.get('type') || undefined;
    const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '50'), 100);
    const cursor = request.nextUrl.searchParams.get('cursor') || undefined;

    const where: any = { tenantId: user.tenantId };
    if (type) where.type = type;

    const archives = await findArchiveManifests(where, {
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { createdAt: 'desc' },
    });

    const hasMore = archives.length > limit;
    if (hasMore) archives.pop();

    return NextResponse.json({
      archives,
      nextCursor: hasMore ? archives[archives.length - 1]?.id : undefined,
    });
  } catch (error) {
    log.error('Archive list error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

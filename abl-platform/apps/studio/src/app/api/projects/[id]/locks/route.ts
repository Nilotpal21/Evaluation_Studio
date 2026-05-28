/**
 * GET /api/projects/:id/locks — List all active locks in project
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { ensureConnected, AgentLock } from '@agent-platform/database/models';
import { createLogger } from '@abl/compiler/platform/logger.js';

type RouteParams = { params: Promise<{ id: string }> };
const log = createLogger('project-locks-route');

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  try {
    await ensureConnected();

    const locks = await AgentLock.find({
      tenantId: user.tenantId,
      projectId,
      expiresAt: { $gt: new Date() },
    }).lean();

    return NextResponse.json({ locks });
  } catch (error: unknown) {
    log.error('Failed to list locks', {
      projectId,
      tenantId: user.tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to list locks' }, { status: 500 });
  }
}

/**
 * POST   /api/projects/:id/agents/:agentId/lock — Acquire lock
 * DELETE /api/projects/:id/agents/:agentId/lock — Release lock
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { ensureConnected, AgentLock } from '@agent-platform/database/models';
import { createLogger } from '@abl/compiler/platform/logger.js';

type RouteParams = { params: Promise<{ id: string; agentId: string }> };

const DEFAULT_LOCK_TTL_MS = 30 * 60 * 1000; // 30 minutes
const log = createLogger('agent-lock-route');

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, agentId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;
  const tenantId = user.tenantId;

  let body: { lockType?: string; agentName?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const lockType = (body.lockType === 'deploy' ? 'deploy' : 'edit') as 'edit' | 'deploy';
  const agentName = body.agentName ?? agentId;

  try {
    await ensureConnected();

    // Check for existing active lock
    const existing = await AgentLock.findOne({
      tenantId,
      projectId,
      agentId,
      lockType,
      expiresAt: { $gt: new Date() },
    }).lean();

    if (existing && existing.lockedBy !== user.id) {
      return NextResponse.json(
        {
          error: 'Agent is locked by another user',
          lock: {
            lockedBy: existing.lockedBy,
            lockedAt: existing.lockedAt,
            expiresAt: existing.expiresAt,
          },
        },
        { status: 409 },
      );
    }

    if (existing && existing.lockedBy === user.id) {
      // Refresh existing lock
      const refreshed = await AgentLock.findOneAndUpdate(
        { _id: existing._id, tenantId, projectId },
        { expiresAt: new Date(Date.now() + DEFAULT_LOCK_TTL_MS) },
        { new: true },
      ).lean();
      return NextResponse.json({ lock: refreshed });
    }

    // Clean up expired locks
    await AgentLock.deleteMany({
      tenantId,
      projectId,
      agentId,
      lockType,
      expiresAt: { $lte: new Date() },
    });

    const now = new Date();
    const lock = await AgentLock.create({
      tenantId,
      projectId,
      agentId,
      agentName,
      lockedBy: user.id,
      lockedAt: now,
      expiresAt: new Date(now.getTime() + DEFAULT_LOCK_TTL_MS),
      lockType,
    });

    return NextResponse.json({ lock }, { status: 201 });
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as { code?: number }).code === 11000) {
      // Race condition: another request created the lock between our findOne and create.
      // Re-fetch to check if it's the same user — if so, refresh instead of rejecting.
      const conflicting = await AgentLock.findOne({
        tenantId,
        projectId,
        agentId,
        lockType,
      }).lean();
      if (conflicting && conflicting.lockedBy === user.id) {
        const refreshed = await AgentLock.findOneAndUpdate(
          { _id: conflicting._id, tenantId, projectId },
          { expiresAt: new Date(Date.now() + DEFAULT_LOCK_TTL_MS) },
          { new: true },
        ).lean();
        return NextResponse.json({ lock: refreshed });
      }
      return NextResponse.json(
        {
          error: 'Agent is locked by another user',
          lock: conflicting
            ? {
                lockedBy: conflicting.lockedBy,
                lockedAt: conflicting.lockedAt,
                expiresAt: conflicting.expiresAt,
              }
            : undefined,
        },
        { status: 409 },
      );
    }
    log.error('Failed to acquire lock', {
      tenantId,
      projectId,
      agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to acquire lock' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, agentId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;
  const tenantId = user.tenantId;

  const lockType = request.nextUrl.searchParams.get('lockType') ?? 'edit';

  try {
    await ensureConnected();

    const lock = await AgentLock.findOne({ tenantId, projectId, agentId, lockType }).lean();
    if (!lock) {
      return NextResponse.json({ success: true }); // No lock to release
    }

    if (lock.lockedBy !== user.id) {
      return NextResponse.json(
        { error: 'Cannot release lock held by another user' },
        { status: 403 },
      );
    }

    await AgentLock.deleteOne({ _id: lock._id, tenantId, projectId });
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    log.error('Failed to release lock', {
      tenantId,
      projectId,
      agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to release lock' }, { status: 500 });
  }
}

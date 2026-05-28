/**
 * GET    /api/projects/:id/agents/:agentId/ownership — Get agent ownership
 * PUT    /api/projects/:id/agents/:agentId/ownership — Assign/transfer ownership
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { ensureConnected, AgentOwnership } from '@agent-platform/database/models';

type RouteParams = { params: Promise<{ id: string; agentId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, agentId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  try {
    await ensureConnected();
    const ownership = await AgentOwnership.findOne({ projectId, agentId }).lean();

    if (!ownership) {
      return NextResponse.json({ ownership: null });
    }

    return NextResponse.json({ ownership });
  } catch (error) {
    console.error('[Ownership GET] Error:', error);
    return NextResponse.json({ error: 'Failed to get ownership' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, agentId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  let body: { ownerId?: string; ownerTeamId?: string; agentName?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    await ensureConnected();

    // Authorization + write in a single atomic findOneAndUpdate to prevent TOCTOU.
    // Admins/owners bypass the ownerId filter; regular users must be the current owner.
    const isAdmin = user.role === 'ADMIN' || user.role === 'OWNER';
    const filter = isAdmin
      ? { projectId, agentId }
      : {
          projectId,
          agentId,
          $or: [
            { ownerId: user.id }, // Current owner can transfer
            { ownerId: { $exists: false } }, // Unowned — anyone can claim
            { ownerId: null }, // Explicitly null — anyone can claim
          ],
        };

    const ownership = await AgentOwnership.findOneAndUpdate(
      filter,
      {
        $set: {
          ownerId: body.ownerId ?? null,
          ownerTeamId: body.ownerTeamId ?? null,
          agentName: body.agentName ?? agentId,
        },
        $setOnInsert: { projectId, agentId },
      },
      { upsert: isAdmin, new: true },
    ).lean();

    if (!ownership) {
      // Non-admin user tried to transfer ownership of an agent they don't own
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    return NextResponse.json({ ownership });
  } catch (error) {
    console.error('[Ownership PUT] Error:', error);
    return NextResponse.json({ error: 'Failed to update ownership' }, { status: 500 });
  }
}

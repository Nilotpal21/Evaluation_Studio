/**
 * POST   /api/projects/:id/agents/:agentId/permissions — Grant permission
 * DELETE /api/projects/:id/agents/:agentId/permissions/:principalId — Revoke
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { ensureConnected, AgentOwnership, Project } from '@agent-platform/database/models';

type RouteParams = { params: Promise<{ id: string; agentId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, agentId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  let body: {
    principalType: 'user' | 'team';
    principalId: string;
    operations: string[];
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.principalType || !body.principalId || !body.operations?.length) {
    return NextResponse.json(
      { error: 'principalType, principalId, and operations are required' },
      { status: 400 },
    );
  }

  try {
    await ensureConnected();

    // Only project owner or admin can grant permissions
    const project = await Project.findOne({ _id: projectId, tenantId: user.tenantId }).lean();
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }
    const isOwnerOrAdmin = String(project.ownerId) === user.id || user.role === 'ADMIN';
    if (!isOwnerOrAdmin) {
      return NextResponse.json(
        { error: 'Only the project owner or admin can grant permissions' },
        { status: 403 },
      );
    }

    const grant = {
      principalType: body.principalType,
      principalId: body.principalId,
      operations: body.operations,
      grantedBy: user.id,
      expiresAt: null,
    };

    await AgentOwnership.findOneAndUpdate(
      { projectId, agentId },
      {
        $pull: { permissions: { principalId: body.principalId } },
      },
    );

    await AgentOwnership.findOneAndUpdate(
      { projectId, agentId },
      {
        $push: { permissions: grant },
        $setOnInsert: { projectId, agentId, agentName: agentId, ownerId: null, ownerTeamId: null },
      },
      { upsert: true },
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[Permissions POST] Error:', error);
    return NextResponse.json({ error: 'Failed to grant permission' }, { status: 500 });
  }
}

/**
 * PATCH/DELETE /api/workspaces/:tenantId/members/:userId
 * Update member role or remove member from workspace
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { requireAuth, isAuthError } from '@/lib/auth';
import { WORKSPACE_PERMISSIONS, requireWorkspacePermission } from '@/lib/workspace-permission';
import { findTenantMember, updateTenantMember, deleteTenantMember } from '@/repos/workspace-repo';
import { removeUserFromTenantProjects } from '@/repos/project-repo';
import { revokeAllUserTokens } from '@/services/auth-service';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('member-management');

const MANAGED_MEMBER_STATUSES = ['active', 'deactivated', 'suspended'];
const ROLE_HIERARCHY: Record<string, number> = {
  OWNER: 50,
  ADMIN: 40,
  OPERATOR: 30,
  MEMBER: 20,
  VIEWER: 10,
};

const paramsSchema = z.object({
  tenantId: z.string().min(1),
  userId: z.string().min(1),
});

const updateMemberRequestSchema = z.object({
  role: z.enum(['OWNER', 'ADMIN', 'OPERATOR', 'MEMBER', 'VIEWER']),
});

const updateMemberResponseSchema = z.object({
  success: z.boolean(),
  role: z.string(),
});

const deleteMemberResponseSchema = z.object({
  success: z.boolean(),
});

type RouteContext = { params: Promise<{ tenantId: string; userId: string }> };

async function patchHandler(request: NextRequest, { params }: RouteContext) {
  const authResult = await requireAuth(request);
  if (isAuthError(authResult)) return authResult;

  const { tenantId, userId } = await params;

  // Tenant isolation
  if (authResult.tenantId && tenantId !== authResult.tenantId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const workspaceAccess = await requireWorkspacePermission(
    tenantId,
    authResult,
    WORKSPACE_PERMISSIONS.MANAGE_MEMBERS,
    {
      denyBehavior: 'forbidden',
    },
  );
  if (workspaceAccess instanceof NextResponse) {
    return workspaceAccess;
  }
  const actorMembership = workspaceAccess.membership;

  // Cannot change own role
  if (userId === authResult.id) {
    return NextResponse.json({ error: 'Cannot change your own role' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const parsed = updateMemberRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
  }

  const targetMembership = await findTenantMember(tenantId, userId, {
    memberStatuses: MANAGED_MEMBER_STATUSES,
  });
  if (!targetMembership) {
    return NextResponse.json({ error: 'Member not found' }, { status: 404 });
  }

  // Prevent privilege escalation: can't assign a role higher than your own
  const actorLevel = ROLE_HIERARCHY[actorMembership.role] ?? 0;
  const targetCurrentLevel = ROLE_HIERARCHY[targetMembership.role] ?? 0;
  const newLevel = ROLE_HIERARCHY[parsed.data.role] ?? 0;

  if (newLevel > actorLevel) {
    return NextResponse.json(
      { error: 'Cannot assign a role higher than your own' },
      { status: 403 },
    );
  }

  // Can't change role of someone at or above your level (unless you're OWNER)
  if (actorMembership.role !== 'OWNER' && targetCurrentLevel >= actorLevel) {
    return NextResponse.json({ error: 'Cannot change the role of this member' }, { status: 403 });
  }

  try {
    await updateTenantMember(tenantId, userId, { role: parsed.data.role });

    await logAuditEvent({
      userId: authResult.id,
      tenantId,
      action: AuditActions.MEMBER_ROLE_CHANGED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: {
        targetUserId: userId,
        previousRole: targetMembership.role,
        newRole: parsed.data.role,
      },
    });

    return NextResponse.json({ success: true, role: parsed.data.role });
  } catch (error) {
    log.error('Update member role error', {
      err: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function deleteHandler(request: NextRequest, { params }: RouteContext) {
  const authResult = await requireAuth(request);
  if (isAuthError(authResult)) return authResult;

  const { tenantId, userId } = await params;

  // Tenant isolation
  if (authResult.tenantId && tenantId !== authResult.tenantId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const workspaceAccess = await requireWorkspacePermission(
    tenantId,
    authResult,
    WORKSPACE_PERMISSIONS.MANAGE_MEMBERS,
    {
      denyBehavior: 'forbidden',
    },
  );
  if (workspaceAccess instanceof NextResponse) {
    return workspaceAccess;
  }
  const actorMembership = workspaceAccess.membership;

  // Cannot remove yourself
  if (userId === authResult.id) {
    return NextResponse.json({ error: 'Cannot remove yourself' }, { status: 400 });
  }

  const targetMembership = await findTenantMember(tenantId, userId, {
    memberStatuses: MANAGED_MEMBER_STATUSES,
  });
  if (!targetMembership) {
    return NextResponse.json({ error: 'Member not found' }, { status: 404 });
  }

  // Cannot remove OWNER
  if (targetMembership.role === 'OWNER') {
    return NextResponse.json({ error: 'Cannot remove the workspace owner' }, { status: 403 });
  }

  // Can't remove someone at or above your level (unless you're OWNER)
  const actorLevel = ROLE_HIERARCHY[actorMembership.role] ?? 0;
  const targetLevel = ROLE_HIERARCHY[targetMembership.role] ?? 0;
  if (actorMembership.role !== 'OWNER' && targetLevel >= actorLevel) {
    return NextResponse.json({ error: 'Cannot remove this member' }, { status: 403 });
  }

  try {
    // Cascade: remove from all projects in this tenant, revoke tokens, then remove membership
    const projectMembershipsRemoved = await removeUserFromTenantProjects(tenantId, userId);
    await revokeAllUserTokens(userId);
    await deleteTenantMember(tenantId, userId);

    await logAuditEvent({
      userId: authResult.id,
      tenantId,
      action: AuditActions.MEMBER_REMOVED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: {
        targetUserId: userId,
        role: targetMembership.role,
        projectMembershipsRemoved,
      },
    });

    return NextResponse.json({ success: true, projectMembershipsRemoved });
  } catch (error) {
    log.error('Remove member error', {
      err: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const PATCH = withOpenAPI(
  {
    summary: 'Update member role',
    description:
      'Change the role of a workspace member. Requires admin role. Cannot escalate above your own role.',
    tags: ['Workspaces'],
    params: paramsSchema,
    body: updateMemberRequestSchema,
    response: updateMemberResponseSchema,
    successStatus: 200,
    auth: true,
  },
  patchHandler as any,
);

export const DELETE = withOpenAPI(
  {
    summary: 'Remove workspace member',
    description:
      'Remove a member from the workspace. Requires admin role. Cannot remove the workspace owner.',
    tags: ['Workspaces'],
    params: paramsSchema,
    response: deleteMemberResponseSchema,
    successStatus: 200,
    auth: true,
  },
  deleteHandler as any,
);

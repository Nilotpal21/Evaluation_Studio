/**
 * DELETE /api/workspaces/:tenantId/invitations/:invitationId
 * Revoke a workspace invitation
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { requireAuth, isAuthError } from '@/lib/auth';
import { WORKSPACE_PERMISSIONS, requireWorkspacePermission } from '@/lib/workspace-permission';
import { findInvitationById, deleteInvitation } from '@/repos/workspace-repo';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('invitations');

// Path parameter schema
const paramsSchema = z.object({
  tenantId: z.string(),
  invitationId: z.string(),
});

// Response schema
const deleteInvitationResponseSchema = z.object({
  success: z.boolean(),
});

async function deleteHandler(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; invitationId: string }> },
) {
  const authResult = await requireAuth(request);
  if (isAuthError(authResult)) return authResult;

  const { tenantId, invitationId } = await params;

  // Tenant isolation: users can only access their own tenant's invitations
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

  try {
    // Tenant-scoped lookup — ensures invitation belongs to this tenant at query level
    const invitation = await findInvitationById(invitationId, tenantId);

    if (!invitation) {
      return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
    }

    await deleteInvitation(invitationId, tenantId);

    await logAuditEvent({
      userId: authResult.id,
      tenantId,
      action: AuditActions.INVITATION_REVOKED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: { invitationId, email: invitation.email },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    log.error('Revoke invitation error', {
      err: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const DELETE = withOpenAPI(
  {
    summary: 'Revoke workspace invitation',
    description: 'Revoke a pending workspace invitation. Requires admin role.',
    tags: ['Workspaces', 'Invitations'],
    params: paramsSchema,
    response: deleteInvitationResponseSchema,
    successStatus: 200,
    auth: true,
  },
  deleteHandler as any,
);

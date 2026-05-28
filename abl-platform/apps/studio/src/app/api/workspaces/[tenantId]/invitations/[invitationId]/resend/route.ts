/**
 * POST /api/workspaces/:tenantId/invitations/:invitationId/resend
 * Resend a workspace invitation (deletes old, creates new with fresh token/expiry)
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { WORKSPACE_PERMISSIONS, requireWorkspacePermission } from '@/lib/workspace-permission';
import { findInvitationById, deleteInvitation } from '@/repos/workspace-repo';
import { createInvitation } from '@/services/invitation-service';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('invitation-resend');

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; invitationId: string }> },
) {
  const authResult = await requireAuth(request);
  if (isAuthError(authResult)) return authResult;

  const { tenantId, invitationId } = await params;

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

  try {
    // Find the existing invitation (tenant-scoped)
    const existing = await findInvitationById(invitationId, tenantId);
    if (!existing) {
      return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
    }

    if (existing.status === 'accepted') {
      return NextResponse.json(
        { error: 'This invitation has already been accepted' },
        { status: 400 },
      );
    }

    // Delete the old invitation so the unique (tenantId, email) index is freed
    await deleteInvitation(invitationId, tenantId);

    // Create a fresh invitation (sends email internally)
    const newInvitation = await createInvitation({
      tenantId,
      email: existing.email,
      role: existing.role,
      invitedBy: authResult.id,
    });

    await logAuditEvent({
      userId: authResult.id,
      tenantId,
      action: AuditActions.INVITATION_RESENT,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: { email: existing.email, role: existing.role },
    });

    return NextResponse.json({ invitation: newInvitation }, { status: 201 });
  } catch (error) {
    log.error('Resend invitation error', {
      err: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to resend invitation' }, { status: 500 });
  }
}

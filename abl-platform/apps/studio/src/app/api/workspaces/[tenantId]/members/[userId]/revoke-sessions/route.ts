/**
 * POST /api/workspaces/:tenantId/members/:userId/revoke-sessions
 *
 * Force-logout a workspace member by revoking all their refresh tokens.
 * Admin-only. Does not deactivate the member — they can log back in.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { errorJson, ErrorCode, handleApiError } from '@/lib/api-response';
import { WORKSPACE_PERMISSIONS, requireWorkspacePermission } from '@/lib/workspace-permission';
import { findTenantMember } from '@/repos/workspace-repo';
import { revokeAllUserTokens } from '@/services/auth-service';
import { logAuditEvent, AuditActions } from '@/services/audit-service';

type RouteContext = { params: Promise<{ tenantId: string; userId: string }> };

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { tenantId, userId } = await params;

    const authResult = await requireAuth(request);
    if (isAuthError(authResult)) return authResult;

    if (authResult.tenantId && tenantId !== authResult.tenantId) {
      return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
    }

    const workspaceAccess = await requireWorkspacePermission(
      tenantId,
      authResult,
      WORKSPACE_PERMISSIONS.MANAGE_MEMBERS,
      {
        denyBehavior: 'not_found',
      },
    );
    if (workspaceAccess instanceof NextResponse) {
      return workspaceAccess;
    }

    // Cannot revoke your own sessions via admin route
    if (userId === authResult.id) {
      return errorJson(
        'Use /api/auth/logout for your own sessions',
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const targetMembership = await findTenantMember(tenantId, userId);
    if (!targetMembership) {
      return errorJson('Member not found', 404, ErrorCode.NOT_FOUND);
    }

    await revokeAllUserTokens(userId);

    await logAuditEvent({
      userId: authResult.id,
      tenantId,
      action: AuditActions.SESSIONS_REVOKED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: { targetUserId: userId },
    });

    return NextResponse.json({ success: true, message: 'All sessions revoked' });
  } catch (error: unknown) {
    return handleApiError(error, 'RevokeSessions.POST');
  }
}

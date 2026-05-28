/**
 * POST /api/workspaces/:tenantId/archive
 *
 * Soft-delete a workspace by setting status='archived'.
 * Owner-only. Cascades: all active projects are archived too.
 * The workspace can be restored within the grace period (default 30 days).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { errorJson, ErrorCode, handleApiError } from '@/lib/api-response';
import { requireWorkspaceRole } from '@/lib/workspace-permission';
import { findTenantById, findTenantMembers, archiveWorkspace } from '@/repos/workspace-repo';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { revokeAllUserTokens } from '@/services/auth-service';

type RouteContext = { params: Promise<{ tenantId: string }> };
const ACTIVE_TENANT_STATUSES = ['active'];
const ACTIVE_MEMBER_STATUSES = ['active'];

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { tenantId } = await params;

    const authResult = await requireAuth(request);
    if (isAuthError(authResult)) return authResult;

    // Tenant isolation
    if (authResult.tenantId && tenantId !== authResult.tenantId) {
      return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
    }

    const workspaceAccess = await requireWorkspaceRole(tenantId, authResult, 'OWNER', {
      denyBehavior: 'not_found',
      tenantStatuses: ACTIVE_TENANT_STATUSES,
      memberStatuses: ACTIVE_MEMBER_STATUSES,
    });
    if (workspaceAccess instanceof NextResponse) {
      return workspaceAccess;
    }

    const tenant = await findTenantById(tenantId);
    if (!tenant) {
      return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
    }

    if (tenant.status === 'archived') {
      return errorJson('Workspace is already archived', 400, ErrorCode.VALIDATION_ERROR);
    }

    const activeMemberUserIds = [
      ...new Set(
        (await findTenantMembers(tenantId))
          .filter((member) => ACTIVE_MEMBER_STATUSES.includes(member.status))
          .map((member) => member.userId),
      ),
    ];

    const result = await archiveWorkspace(tenantId, authResult.id);
    if (!result) {
      return errorJson('Workspace not found or already archived', 404, ErrorCode.NOT_FOUND);
    }

    await Promise.all(activeMemberUserIds.map((userId) => revokeAllUserTokens(userId)));

    await logAuditEvent({
      userId: authResult.id,
      tenantId,
      action: AuditActions.WORKSPACE_ARCHIVED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: {
        projectsArchived: result.projectsArchived,
        sessionsRevoked: activeMemberUserIds.length,
      },
    });

    return NextResponse.json({
      success: true,
      projectsArchived: result.projectsArchived,
    });
  } catch (error: unknown) {
    return handleApiError(error, 'WorkspaceArchive.POST');
  }
}

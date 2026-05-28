/**
 * POST /api/workspaces/:tenantId/restore
 *
 * Restore an archived workspace by setting status='active'.
 * Owner-only. Cascades: all archived projects are restored too.
 * Only works within the configured grace period (default 30 days).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { errorJson, ErrorCode, handleApiError } from '@/lib/api-response';
import { requireWorkspaceRole } from '@/lib/workspace-permission';
import { findTenantById, restoreWorkspace } from '@/repos/workspace-repo';
import { logAuditEvent, AuditActions } from '@/services/audit-service';

const DEFAULT_GRACE_PERIOD_DAYS = 30;
const RESTORABLE_TENANT_STATUSES = ['active', 'archived'];

type RouteContext = { params: Promise<{ tenantId: string }> };

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
      tenantStatuses: RESTORABLE_TENANT_STATUSES,
    });
    if (workspaceAccess instanceof NextResponse) {
      return workspaceAccess;
    }

    const tenant = await findTenantById(tenantId);
    if (!tenant) {
      return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
    }

    if (tenant.status !== 'archived') {
      return errorJson('Workspace is not archived', 400, ErrorCode.VALIDATION_ERROR);
    }

    // Check grace period using updatedAt (when status was changed to 'archived')
    const archivedAt = new Date(tenant.updatedAt);
    const gracePeriodMs = DEFAULT_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
    const expiresAt = new Date(archivedAt.getTime() + gracePeriodMs);
    if (new Date() > expiresAt) {
      return errorJson(
        'Grace period has expired. Workspace cannot be restored.',
        410,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const result = await restoreWorkspace(tenantId);
    if (!result) {
      return errorJson('Workspace not found or not archived', 404, ErrorCode.NOT_FOUND);
    }

    await logAuditEvent({
      userId: authResult.id,
      tenantId,
      action: AuditActions.WORKSPACE_RESTORED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: { projectsRestored: result.projectsRestored },
    });

    return NextResponse.json({
      success: true,
      projectsRestored: result.projectsRestored,
    });
  } catch (error: unknown) {
    return handleApiError(error, 'WorkspaceRestore.POST');
  }
}

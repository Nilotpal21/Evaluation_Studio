/**
 * POST /api/projects/:id/restore
 *
 * Restore an archived project by clearing archivedAt/archivedBy.
 * Requires project owner or tenant admin. Only works within the
 * configured grace period (default 30 days).
 */

import { NextRequest } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { isAccessError } from '@/lib/project-access';
import { requireProjectMemberOrAdmin } from '@/lib/require-project-member-or-admin';
import { errorJson, actionJson, handleApiError, ErrorCode } from '@/lib/api-response';
import { restoreProject } from '@/repos/project-repo';
import { logAuditEvent, AuditActions } from '@/services/audit-service';

const ADMIN_ROLES = new Set(['OWNER', 'ADMIN']);
const DEFAULT_GRACE_PERIOD_DAYS = 30;

type RouteContext = { params: Promise<{ id: string }> };

function parseArchivedAt(value: unknown): Date | null {
  if (!(value instanceof Date) && typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireAuth(request);
    if (isAuthError(user)) return user;

    const { id } = await params;

    const access = await requireProjectMemberOrAdmin(id, user);
    if (isAccessError(access)) return access;

    // Only project owner or tenant admin can restore
    const isOwner = access.project.ownerId === user.id;
    const isAdmin = typeof user.role === 'string' && ADMIN_ROLES.has(user.role);
    if (!isOwner && !isAdmin) {
      return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
    }

    if (!access.project.archivedAt) {
      return errorJson('Project is not archived', 400, ErrorCode.VALIDATION_ERROR);
    }

    // Check grace period
    const archivedAt = parseArchivedAt(access.project.archivedAt);
    if (!archivedAt) {
      return errorJson('Project archive metadata is invalid', 500, ErrorCode.INTERNAL_ERROR);
    }

    const gracePeriodMs = DEFAULT_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
    const expiresAt = new Date(archivedAt.getTime() + gracePeriodMs);
    if (new Date() > expiresAt) {
      return errorJson(
        'Grace period has expired. Project cannot be restored.',
        410,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const restored = await restoreProject(id, access.project.tenantId);
    if (!restored) {
      return errorJson('Project not found or not archived', 404, ErrorCode.NOT_FOUND);
    }

    await logAuditEvent({
      userId: user.id,
      tenantId: access.project.tenantId,
      action: AuditActions.PROJECT_RESTORED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: {
        projectId: id,
        resourceType: 'project',
        resourceId: id,
      },
    });

    return actionJson();
  } catch (error: unknown) {
    return handleApiError(error, 'ProjectRestore.POST');
  }
}

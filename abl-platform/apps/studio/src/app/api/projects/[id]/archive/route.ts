/**
 * POST /api/projects/:id/archive
 *
 * Soft-delete a project by setting archivedAt/archivedBy.
 * Requires project owner or tenant admin. The project can be restored
 * within the configured grace period (default 30 days).
 */

import { NextRequest } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { isAccessError } from '@/lib/project-access';
import { requireProjectMemberOrAdmin } from '@/lib/require-project-member-or-admin';
import { errorJson, actionJson, handleApiError, ErrorCode } from '@/lib/api-response';
import { archiveProject } from '@/repos/project-repo';
import { logAuditEvent, AuditActions } from '@/services/audit-service';

const ADMIN_ROLES = new Set(['OWNER', 'ADMIN']);

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireAuth(request);
    if (isAuthError(user)) return user;

    const { id } = await params;

    const access = await requireProjectMemberOrAdmin(id, user);
    if (isAccessError(access)) return access;

    // Only project owner or tenant admin can archive
    const isOwner = access.project.ownerId === user.id;
    const isAdmin = typeof user.role === 'string' && ADMIN_ROLES.has(user.role);
    if (!isOwner && !isAdmin) {
      return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
    }

    if (access.project.archivedAt) {
      return errorJson('Project is already archived', 400, ErrorCode.VALIDATION_ERROR);
    }

    const archived = await archiveProject(id, access.project.tenantId, user.id);
    if (!archived) {
      return errorJson('Project not found or already archived', 404, ErrorCode.NOT_FOUND);
    }

    await logAuditEvent({
      userId: user.id,
      tenantId: access.project.tenantId,
      action: AuditActions.PROJECT_ARCHIVED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: {
        projectId: id,
        resourceType: 'project',
        resourceId: id,
      },
    });

    return actionJson({ archivedAt: archived.archivedAt });
  } catch (error: unknown) {
    return handleApiError(error, 'ProjectArchive.POST');
  }
}

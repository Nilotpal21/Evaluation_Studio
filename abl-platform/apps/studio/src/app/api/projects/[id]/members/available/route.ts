/**
 * GET /api/projects/:id/members/available — List addable workspace members
 *
 * Returns active workspace members who are not already assigned to the
 * project. Access is restricted to project-member managers (project owner,
 * workspace admin, or project admin).
 */

import { type NextRequest } from 'next/server';
import type { AuthenticatedUser } from '@/lib/auth';
import { withRouteHandler, type RouteContext } from '@/lib/route-handler';
import { errorJson, successJson, ErrorCode, handleApiError } from '@/lib/api-response';
import {
  isProjectMemberServiceError,
  listAvailableProjectMembers,
  type ProjectMemberActor,
} from '@/services/project-member-service';

function toActor(user: AuthenticatedUser, request: NextRequest): ProjectMemberActor {
  return {
    userId: user.id,
    role: user.role,
    permissions: user.permissions ?? [],
    ip: request.headers.get('x-forwarded-for') || undefined,
    userAgent: request.headers.get('user-agent') || undefined,
  };
}

function handleProjectMemberError(error: unknown, context: string) {
  if (isProjectMemberServiceError(error)) {
    return errorJson(error.message, error.statusCode, error.code);
  }
  return handleApiError(error, context);
}

export const GET = withRouteHandler(
  { requireProjectMemberOrAdmin: true },
  async (ctx: RouteContext) => {
    try {
      if (!ctx.project) {
        return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
      }

      const members = await listAvailableProjectMembers(
        ctx.project,
        toActor(ctx.user, ctx.request),
      );

      return successJson(
        'members',
        members.map((member: any) => ({
          id: member.id,
          userId: member.userId,
          email: member.user?.email || null,
          name: member.user?.name || null,
          workspaceRole: member.role,
          status: member.status || 'active',
          joinedAt: member.createdAt ? new Date(member.createdAt).toISOString() : null,
        })),
      );
    } catch (error: unknown) {
      return handleProjectMemberError(error, 'ProjectMembersAvailable.GET');
    }
  },
);

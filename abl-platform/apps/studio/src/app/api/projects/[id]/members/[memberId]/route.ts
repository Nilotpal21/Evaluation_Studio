/**
 * PATCH  /api/projects/:id/members/:memberId — Update a member's role
 * DELETE /api/projects/:id/members/:memberId — Remove a member from the project
 *
 * Canonical implementation. The route parameter is `memberId` (the member's
 * userId) — this matches the LLD naming and avoids ambiguity with `userId`
 * in the actor context.
 */

import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { PROJECT_ROLE_NAMES } from '@agent-platform/shared/rbac';
import type { AuthenticatedUser } from '@/lib/auth';
import { withRouteHandler, type RouteContext } from '@/lib/route-handler';
import { errorJson, actionJson, successJson, ErrorCode, handleApiError } from '@/lib/api-response';
import {
  isProjectMemberServiceError,
  removeProjectMember,
  type ProjectMemberActor,
  updateProjectMember,
  type UpdateProjectMemberInput,
} from '@/services/project-member-service';

const VALID_ROLES = [...PROJECT_ROLE_NAMES, 'custom'] as const;

// ─── Validation ───────────────────────────────────────────────────────────

const updateMemberSchema = z.object({
  role: z.enum(VALID_ROLES as unknown as [string, ...string[]]).optional(),
  customRoleId: z.string().min(1).nullish(),
});

type UpdateMemberBody = z.infer<typeof updateMemberSchema>;

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

// ─── PATCH — Update member role ──────────────────────────────────────────

export const PATCH = withRouteHandler<UpdateMemberBody>(
  {
    requireProjectMemberOrAdmin: true,
    bodySchema: updateMemberSchema,
  },
  async (ctx: RouteContext<UpdateMemberBody>) => {
    try {
      if (!ctx.project) {
        return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
      }

      const updated = await updateProjectMember(
        ctx.project,
        toActor(ctx.user, ctx.request),
        ctx.params.memberId,
        ctx.body as UpdateProjectMemberInput,
      );

      return successJson('member', {
        id: updated.id,
        userId: updated.userId,
        role: updated.role,
        customRoleId: updated.customRoleId || null,
      });
    } catch (error: unknown) {
      return handleProjectMemberError(error, 'ProjectMember.PATCH');
    }
  },
);

// ─── DELETE — Remove member from project ─────────────────────────────────

export const DELETE = withRouteHandler(
  { requireProjectMemberOrAdmin: true },
  async (ctx: RouteContext) => {
    try {
      if (!ctx.project) {
        return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
      }

      await removeProjectMember(ctx.project, toActor(ctx.user, ctx.request), ctx.params.memberId);

      return actionJson({ message: 'Member removed' });
    } catch (error: unknown) {
      return handleProjectMemberError(error, 'ProjectMember.DELETE');
    }
  },
);

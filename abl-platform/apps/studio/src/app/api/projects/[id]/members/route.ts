/**
 * GET  /api/projects/:id/members — List project members
 * POST /api/projects/:id/members — Add a member to the project
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { PROJECT_ROLE_NAMES } from '@agent-platform/shared/rbac';
import type { AuthenticatedUser } from '@/lib/auth';
import { withRouteHandler, type RouteContext } from '@/lib/route-handler';
import { successJson, errorJson, ErrorCode, handleApiError } from '@/lib/api-response';
import {
  addProjectMember,
  canActorManageMembers,
  isProjectMemberServiceError,
  listProjectMembers,
  type AddProjectMemberInput,
  type ProjectMemberActor,
} from '@/services/project-member-service';

const VALID_ROLES = [...PROJECT_ROLE_NAMES, 'custom'] as const;

const addMemberSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  role: z.enum(VALID_ROLES as unknown as [string, ...string[]]),
  customRoleId: z.string().min(1).nullish(),
});

type AddMemberBody = z.infer<typeof addMemberSchema>;

function toActor(user: AuthenticatedUser, request: NextRequest): ProjectMemberActor {
  return {
    userId: user.id,
    role: user.role,
    permissions: user.permissions ?? [],
    ip: request.headers.get('x-forwarded-for') || undefined,
    userAgent: request.headers.get('user-agent') || undefined,
  };
}

function toMemberResponse(member: any) {
  return {
    id: member.id,
    userId: member.userId,
    email: member.user?.email || null,
    name: member.user?.name || null,
    role: member.role,
    customRoleId: member.customRoleId || null,
    joinedAt: member.createdAt ? new Date(member.createdAt).toISOString() : null,
  };
}

function handleProjectMemberError(error: unknown, context: string): NextResponse {
  if (isProjectMemberServiceError(error)) {
    return errorJson(error.message, error.statusCode, error.code);
  }
  return handleApiError(error, context);
}

// ─── GET — List project members ──────────────────────────────────────────

export const GET = withRouteHandler(
  { requireProjectMemberOrAdmin: true },
  async (ctx: RouteContext) => {
    try {
      if (!ctx.project) {
        return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
      }

      const actor = toActor(ctx.user, ctx.request);
      const members = await listProjectMembers(ctx.project);
      const result = members.map(toMemberResponse);
      const canManageMembers = await canActorManageMembers(ctx.project, actor);

      return NextResponse.json({
        success: true,
        members: result,
        canManageMembers,
      });
    } catch (error: unknown) {
      return handleProjectMemberError(error, 'ProjectMembers.GET');
    }
  },
);

// ─── POST — Add a member to the project ──────────────────────────────────

export const POST = withRouteHandler<AddMemberBody>(
  {
    requireProjectMemberOrAdmin: true,
    bodySchema: addMemberSchema,
  },
  async (ctx: RouteContext<AddMemberBody>) => {
    try {
      if (!ctx.project) {
        return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
      }

      const member = await addProjectMember(
        ctx.project,
        toActor(ctx.user, ctx.request),
        ctx.body as AddProjectMemberInput,
      );

      return successJson(
        'member',
        {
          id: member.id,
          userId: member.userId,
          role: member.role,
          customRoleId: member.customRoleId || null,
          joinedAt: member.createdAt
            ? new Date(member.createdAt).toISOString()
            : new Date().toISOString(),
        },
        201,
      );
    } catch (error: unknown) {
      return handleProjectMemberError(error, 'ProjectMembers.POST');
    }
  },
);

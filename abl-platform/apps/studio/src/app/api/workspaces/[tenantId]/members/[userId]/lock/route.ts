/**
 * POST /api/workspaces/:tenantId/members/:userId/lock
 *
 * Lock a workspace member. Sets status to 'locked' and revokes refresh tokens.
 * Admin-only. Cannot lock OWNER or yourself.
 */

import { NextRequest, NextResponse } from 'next/server';
import { applyMemberLifecycleStatus, requireMemberLifecycleContext } from '@/lib/auth';
import { errorJson, ErrorCode, handleApiError } from '@/lib/api-response';
import { AuditActions } from '@/services/audit-service';

type RouteContext = { params: Promise<{ tenantId: string; userId: string }> };

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const context = await requireMemberLifecycleContext(request, params, {
      targetMemberStatuses: ['active', 'locked', 'suspended', 'deactivated'],
    });
    if (context instanceof NextResponse) {
      return context;
    }

    if (context.userId === context.authResult.id) {
      return errorJson('Cannot lock yourself', 400, ErrorCode.VALIDATION_ERROR);
    }

    if (context.targetMembership.role === 'OWNER') {
      return errorJson('Cannot lock the workspace owner', 403, ErrorCode.FORBIDDEN);
    }

    if (context.targetMembership.status === 'locked') {
      return errorJson('Member is already locked', 400, ErrorCode.VALIDATION_ERROR);
    }

    if (context.targetMembership.status !== 'active') {
      return errorJson('Only active members can be locked', 400, ErrorCode.VALIDATION_ERROR);
    }

    return applyMemberLifecycleStatus(request, context, 'locked', AuditActions.MEMBER_LOCKED);
  } catch (error: unknown) {
    return handleApiError(error, 'MemberLock.POST');
  }
}

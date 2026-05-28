/**
 * POST /api/workspaces/:tenantId/members/:userId/deactivate
 *
 * Deactivate a workspace member. Sets status to 'deactivated', revokes all tokens.
 * Admin-only. Cannot deactivate OWNER or yourself.
 */

import { NextRequest, NextResponse } from 'next/server';
import { applyMemberLifecycleStatus, requireMemberLifecycleContext } from '@/lib/auth';
import { errorJson, ErrorCode, handleApiError } from '@/lib/api-response';
import { AuditActions } from '@/services/audit-service';

type RouteContext = { params: Promise<{ tenantId: string; userId: string }> };

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const context = await requireMemberLifecycleContext(request, params, {
      targetMemberStatuses: ['active', 'suspended', 'locked', 'deactivated'],
    });
    if (context instanceof NextResponse) {
      return context;
    }

    // Cannot deactivate yourself
    if (context.userId === context.authResult.id) {
      return errorJson('Cannot deactivate yourself', 400, ErrorCode.VALIDATION_ERROR);
    }

    // Cannot deactivate OWNER
    if (context.targetMembership.role === 'OWNER') {
      return errorJson('Cannot deactivate the workspace owner', 403, ErrorCode.FORBIDDEN);
    }

    // Already deactivated
    if (context.targetMembership.status === 'deactivated') {
      return errorJson('Member is already deactivated', 400, ErrorCode.VALIDATION_ERROR);
    }

    return applyMemberLifecycleStatus(
      request,
      context,
      'deactivated',
      AuditActions.MEMBER_DEACTIVATED,
      {
        clearUserLoginLock: context.targetMembership.status === 'locked',
      },
    );
  } catch (error: unknown) {
    return handleApiError(error, 'MemberDeactivate.POST');
  }
}

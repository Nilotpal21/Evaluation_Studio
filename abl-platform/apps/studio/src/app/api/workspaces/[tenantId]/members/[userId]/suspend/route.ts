/**
 * POST /api/workspaces/:tenantId/members/:userId/suspend
 *
 * Suspend a workspace member. Sets status to 'suspended' and revokes refresh tokens.
 * Admin-only. Cannot suspend OWNER or yourself.
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
      return errorJson('Cannot suspend yourself', 400, ErrorCode.VALIDATION_ERROR);
    }

    if (context.targetMembership.role === 'OWNER') {
      return errorJson('Cannot suspend the workspace owner', 403, ErrorCode.FORBIDDEN);
    }

    if (context.targetMembership.status === 'suspended') {
      return errorJson('Member is already suspended', 400, ErrorCode.VALIDATION_ERROR);
    }

    if (context.targetMembership.status !== 'active') {
      return errorJson('Only active members can be suspended', 400, ErrorCode.VALIDATION_ERROR);
    }

    return applyMemberLifecycleStatus(request, context, 'suspended', AuditActions.MEMBER_SUSPENDED);
  } catch (error: unknown) {
    return handleApiError(error, 'MemberSuspend.POST');
  }
}

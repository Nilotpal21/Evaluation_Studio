/**
 * POST /api/workspaces/:tenantId/members/:userId/unlock
 *
 * Unlock a workspace member. Sets status back to 'active'.
 * Admin-only.
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
      return errorJson('Cannot unlock yourself', 400, ErrorCode.VALIDATION_ERROR);
    }

    if (context.targetMembership.status !== 'locked') {
      return errorJson('Member is not locked', 400, ErrorCode.VALIDATION_ERROR);
    }

    return applyMemberLifecycleStatus(request, context, 'active', AuditActions.MEMBER_UNLOCKED, {
      clearUserLoginLock: true,
      revokeTokens: false,
    });
  } catch (error: unknown) {
    return handleApiError(error, 'MemberUnlock.POST');
  }
}

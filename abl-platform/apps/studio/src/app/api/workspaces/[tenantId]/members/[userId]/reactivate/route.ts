/**
 * POST /api/workspaces/:tenantId/members/:userId/reactivate
 *
 * Reactivate a deactivated workspace member. Sets status back to 'active'.
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
      targetMemberStatuses: ['active', 'suspended', 'locked', 'deactivated'],
    });
    if (context instanceof NextResponse) {
      return context;
    }

    if (
      context.targetMembership.status !== 'deactivated' &&
      context.targetMembership.status !== 'suspended' &&
      context.targetMembership.status !== 'locked'
    ) {
      return errorJson(
        'Member must be deactivated, suspended, or locked to reactivate',
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    return applyMemberLifecycleStatus(request, context, 'active', AuditActions.MEMBER_REACTIVATED, {
      clearUserLoginLock: context.targetMembership.status === 'locked',
      revokeTokens: false,
    });
  } catch (error: unknown) {
    return handleApiError(error, 'MemberReactivate.POST');
  }
}

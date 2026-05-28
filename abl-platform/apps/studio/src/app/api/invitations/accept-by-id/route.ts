/**
 * POST /api/invitations/accept-by-id
 * Accept a workspace invitation by its database ID.
 * Used by the invitation picker page when accepting invitations
 * found by email (where we don't have the raw token).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { acceptInvitationById } from '@/services/invitation-service';
import { createTokenPair } from '@/services/auth-service';
import { logWorkspaceInvitationAcceptanceAudit } from '@/services/audit-service';
import { AppError } from '@agent-platform/shared/errors';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('invitations');

export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (isAuthError(authResult)) return authResult;

  try {
    const body = await request.json();
    const { invitationId } = body;

    if (!invitationId || typeof invitationId !== 'string') {
      return NextResponse.json({ error: 'Invitation ID is required' }, { status: 400 });
    }

    const result = await acceptInvitationById(invitationId, authResult.id, authResult.email);

    // Issue new token pair scoped to the new workspace
    const tenantContext = {
      tenantId: result.tenantId,
      role: result.role,
    };

    const tokenPair = await createTokenPair(
      { id: authResult.id, email: authResult.email },
      tenantContext,
    );

    await logWorkspaceInvitationAcceptanceAudit({
      userId: authResult.id,
      tenantId: result.tenantId,
      role: result.role,
      membershipCreated: result.membershipCreated,
      invitationId,
      acceptMethod: 'picker',
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
    });

    const response = NextResponse.json({
      tenantId: result.tenantId,
      role: result.role,
      accessToken: tokenPair.accessToken,
      expiresIn: tokenPair.expiresIn,
    });

    response.cookies.set('refresh_token', tokenPair.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60,
      path: '/',
    });

    return response;
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    log.error('Accept invitation by ID error', {
      err: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

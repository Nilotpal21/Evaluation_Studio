/**
 * POST /api/invitations/accept
 * Accept a workspace invitation
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { requireAuth, isAuthError } from '@/lib/auth';
import { acceptInvitation } from '@/services/invitation-service';
import { createTokenPair } from '@/services/auth-service';
import { logWorkspaceInvitationAcceptanceAudit } from '@/services/audit-service';
import { AppError } from '@agent-platform/shared/errors';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('invitations');

// Request body schema
const acceptInvitationRequestSchema = z.object({
  token: z.string(),
});

// Response schema
const acceptInvitationResponseSchema = z.object({
  tenantId: z.string(),
  role: z.enum(['OWNER', 'ADMIN', 'OPERATOR', 'MEMBER', 'VIEWER']),
  accessToken: z.string(),
  expiresIn: z.number(),
});

async function postHandler(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (isAuthError(authResult)) return authResult;

  try {
    const body = await request.json();
    const { token } = body;

    if (!token) {
      return NextResponse.json({ error: 'Invitation token is required' }, { status: 400 });
    }

    const result = await acceptInvitation(token, authResult.id, authResult.email);

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
      acceptMethod: 'token',
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
    log.error('Accept invitation error', {
      err: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const POST = withOpenAPI(
  {
    summary: 'Accept workspace invitation',
    description:
      'Accept a pending workspace invitation using the invitation token. Returns new access token scoped to the workspace.',
    tags: ['Invitations'],
    body: acceptInvitationRequestSchema,
    response: acceptInvitationResponseSchema,
    successStatus: 200,
    auth: true,
  },
  postHandler as any,
);

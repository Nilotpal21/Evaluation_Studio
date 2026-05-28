import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { getRefreshTokenAuditContext, revokeRefreshToken } from '@/services/auth-service';
import { AuditActions, logAuditEvent } from '@/services/audit-service';
import { authError, getAuthRouteClientIp, parseOptionalJsonBody } from '../route-utils';

const log = createLogger('auth-logout');

// Request body schema (optional)
const logoutRequestSchema = z
  .object({
    refreshToken: z.string().optional(),
  })
  .optional();

// Response schema
const logoutResponseSchema = z.object({
  success: z.literal(true),
});

async function getSafeRefreshTokenAuditContext(
  token: string | undefined,
): Promise<Awaited<ReturnType<typeof getRefreshTokenAuditContext>> | null> {
  if (!token) {
    return null;
  }

  try {
    return await getRefreshTokenAuditContext(token);
  } catch (error) {
    log.warn('Continuing logout without refresh-token audit attribution', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function handler(request: NextRequest) {
  try {
    const body = (await parseOptionalJsonBody<{ refreshToken?: string }>(request)) ?? {};
    const requestToken =
      typeof body.refreshToken === 'string' && body.refreshToken.length > 0
        ? body.refreshToken
        : undefined;
    const cookieToken = request.cookies.get('refresh_token')?.value;
    let auditContext = await getSafeRefreshTokenAuditContext(requestToken);

    // Revoke token from body (legacy clients)
    if (requestToken) {
      await revokeRefreshToken(requestToken);
    }

    // Also revoke token from httpOnly cookie
    if (cookieToken && cookieToken !== requestToken) {
      if (!auditContext) {
        auditContext = await getSafeRefreshTokenAuditContext(cookieToken);
      }
      await revokeRefreshToken(cookieToken);
    }

    await logAuditEvent({
      userId: auditContext?.userId,
      tenantId: auditContext?.tenantId ?? undefined,
      action: AuditActions.LOGOUT,
      ip: getAuthRouteClientIp(request),
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: {
        refreshTokenSources: {
          body: Boolean(requestToken),
          cookie: Boolean(cookieToken),
        },
      },
    });

    // Clear the httpOnly cookie at both paths (old and new)
    const response = NextResponse.json({ success: true });
    response.cookies.set('refresh_token', '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 0,
      path: '/',
    });
    // Also clear any stale cookie from the old /api/auth path
    response.headers.append(
      'Set-Cookie',
      `refresh_token=; HttpOnly; SameSite=Lax;${process.env.NODE_ENV === 'production' ? ' Secure;' : ''} Max-Age=0; Path=/api/auth`,
    );

    return response;
  } catch (error) {
    log.error('Logout error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return authError('Internal server error', 500);
  }
}

export const POST = withOpenAPI(
  {
    summary: 'Logout user',
    description:
      'Revoke refresh tokens from both httpOnly cookie and request body (if provided). Clears authentication cookies.',
    body: logoutRequestSchema,
    response: logoutResponseSchema,
    successStatus: 200,
    auth: false,
  },
  handler as any,
);

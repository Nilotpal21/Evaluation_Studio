import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('auth');
import { refreshTokens } from '@/services/auth-service';
import { checkRateLimit } from '@/lib/rate-limit';
import { getConfig, isConfigLoaded } from '@/config';
import { AUTH_CONFIG_DEFAULTS } from '@/lib/auth-constants';
import { AuditActions, logAuditEvent } from '@/services/audit-service';
import { authError, getAuthRouteClientIp, parseOptionalJsonBody } from '../route-utils';

// Request body schema (optional, can also use cookie)
const refreshRequestSchema = z
  .object({
    refresh_token: z.string().optional(),
    tenantId: z.string().optional(),
  })
  .optional();

// Response schema
const refreshResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(), // Only present in programmatic flow
  expiresIn: z.number(),
});

async function handler(request: NextRequest) {
  try {
    const ip = getAuthRouteClientIp(request);
    const authConfig = isConfigLoaded() ? getConfig().auth : null;
    const rlConfig = authConfig?.rateLimits.refresh ?? AUTH_CONFIG_DEFAULTS.rateLimits.refresh;
    const rl = await checkRateLimit(`refresh:${ip}`, rlConfig.maxAttempts, rlConfig.windowMs);
    if (!rl.allowed) {
      return authError('Too many attempts. Please try again later.', 429);
    }

    const body = await parseOptionalJsonBody<{ refresh_token?: string; tenantId?: string }>(
      request,
    );
    let refreshToken = request.cookies.get('refresh_token')?.value;
    const fromCookie = !!refreshToken;

    if (!refreshToken) {
      refreshToken = body?.refresh_token;
    }

    if (!refreshToken) {
      return authError('Refresh token required', 400);
    }

    const requestedTenantId =
      typeof body?.tenantId === 'string' && body.tenantId.length > 0 ? body.tenantId : undefined;

    const tokenPair = await refreshTokens(refreshToken, requestedTenantId);
    if (!tokenPair) {
      return authError('Invalid or expired refresh token', 401);
    }

    await logAuditEvent({
      userId: tokenPair.userId,
      tenantId: tokenPair.tenantId ?? undefined,
      action: AuditActions.TOKEN_REFRESH,
      ip,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: {
        refreshTokenSource: fromCookie ? 'cookie' : 'body',
        requestedTenantId: requestedTenantId ?? null,
      },
    });

    if (fromCookie) {
      // Browser flow: token in cookie, access token in body
      const response = NextResponse.json({
        accessToken: tokenPair.accessToken,
        expiresIn: tokenPair.expiresIn,
      });

      const refreshCookieMaxAge = authConfig?.tokens.refreshCookieMaxAgeSeconds ?? 7 * 24 * 60 * 60;
      response.cookies.set('refresh_token', tokenPair.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: refreshCookieMaxAge,
        path: '/',
      });

      // Clear any stale cookie from the old /api/auth path
      response.headers.append(
        'Set-Cookie',
        'refresh_token=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/api/auth',
      );

      return response;
    } else {
      // Programmatic flow: both tokens in body
      return NextResponse.json({
        accessToken: tokenPair.accessToken,
        refreshToken: tokenPair.refreshToken,
        expiresIn: tokenPair.expiresIn,
      });
    }
  } catch (error) {
    log.error('Refresh error', { err: error instanceof Error ? error.message : String(error) });
    return authError('Internal server error', 500);
  }
}

export const POST = withOpenAPI(
  {
    summary: 'Refresh access token',
    description:
      'Exchange a refresh token for a new access token. Accepts refresh token from httpOnly cookie or request body.',
    body: refreshRequestSchema,
    response: refreshResponseSchema,
    successStatus: 200,
    auth: false,
  },
  handler as any,
);

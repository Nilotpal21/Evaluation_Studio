/**
 * POST /api/mfa/recovery - Verify using a recovery code (single-use)
 * POST /api/mfa/recovery/regenerate is handled by sub-route
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { requireAuthOrMFAPending, isAuthError } from '@/lib/auth';
import { verifyRecoveryCode } from '@/services/auth/mfa-service';
import { createTokenPair, resolveUserTenantContext } from '@/services/auth-service';
import { checkRateLimit } from '@/lib/rate-limit';
import { getConfig, isConfigLoaded } from '@/config';
import { AUTH_CONFIG_DEFAULTS } from '@/lib/auth-constants';

const recoveryRequestSchema = z.object({
  code: z.string().min(1, 'Recovery code is required'),
});

const recoveryResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number(),
});

async function handler(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const authConfig = isConfigLoaded() ? getConfig().auth : null;
  const rlConfig =
    authConfig?.rateLimits.mfaRecovery ?? AUTH_CONFIG_DEFAULTS.rateLimits.mfaRecovery;
  const rl = await checkRateLimit(`mfa-recovery:${ip}`, rlConfig.maxAttempts, rlConfig.windowMs);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many attempts. Please try again later.' },
      { status: 429 },
    );
  }

  const user = await requireAuthOrMFAPending(request);
  if (isAuthError(user)) return user;

  try {
    const { code } = await request.json();

    const recoveryCodeLength = authConfig?.mfa.recoveryCodeLength ?? 8;
    if (!code || typeof code !== 'string' || code.length !== recoveryCodeLength) {
      return NextResponse.json({ error: 'Invalid recovery code format.' }, { status: 400 });
    }

    const verified = await verifyRecoveryCode(user.id, code);

    if (!verified) {
      return NextResponse.json({ error: 'Invalid recovery code.' }, { status: 401 });
    }

    // Resolve tenant context for role-based access
    const tenantContext = await resolveUserTenantContext(user.id);

    // Issue full token pair via auth service (includes role in JWT)
    const tokenPair = await createTokenPair(user, tenantContext);

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

    return response;
  } catch (error) {
    console.error('[MFA] Recovery error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const POST = withOpenAPI(
  {
    summary: 'Verify recovery code',
    description:
      'Authenticate using a single-use recovery code. Returns access token and sets refresh token cookie. Rate limited.',
    body: recoveryRequestSchema,
    response: recoveryResponseSchema,
    successStatus: 200,
    auth: false, // Uses requireAuthOrMFAPending internally
  },
  handler as any,
);

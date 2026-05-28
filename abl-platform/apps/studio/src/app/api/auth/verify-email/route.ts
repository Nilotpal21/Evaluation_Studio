/**
 * POST /api/auth/verify-email
 * Verify email address using token
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('auth');
import { createTokenPair, resolveUserContextOrAutoAcceptInvite } from '@/services/auth-service';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { hashToken } from '@/lib/token-hash';
import { checkRateLimit } from '@/lib/rate-limit';
import { getConfig, isConfigLoaded } from '@/config';
import { AUTH_CONFIG_DEFAULTS } from '@/lib/auth-constants';
import { findEmailVerificationToken, updateUser } from '@/repos/auth-repo';
import { isPlatformAdminUser } from '@/lib/platform-auth-policy';
import { authError, getAuthRouteClientIp } from '../route-utils';

// Request body schema
const verifyEmailRequestSchema = z.object({
  token: z.string().min(1).describe('Email verification token from signup email'),
});

// Success response schema
const verifyEmailResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    avatarUrl: z.string().nullable(),
  }),
  accessToken: z.string().describe('JWT access token for authentication'),
  expiresIn: z.number().describe('Token expiration time in seconds'),
  needsOnboarding: z.boolean().describe('Whether user needs to complete onboarding'),
  pendingInvitations: z.number().describe('Number of pending workspace invitations'),
});

async function handler(request: NextRequest) {
  try {
    const clientIp = getAuthRouteClientIp(request);
    const userAgent = request.headers.get('user-agent') || undefined;
    const authConfig = isConfigLoaded() ? getConfig().auth : null;
    const rlConfig =
      authConfig?.rateLimits.verifyEmail ?? AUTH_CONFIG_DEFAULTS.rateLimits.verifyEmail;
    const rl = await checkRateLimit(
      `verify-email:${clientIp}`,
      rlConfig.maxAttempts,
      rlConfig.windowMs,
    );
    if (!rl.allowed) {
      return authError('Too many attempts. Please try again later.', 429);
    }

    const body = await request.json();
    const { token } = body;

    if (!token || typeof token !== 'string') {
      return authError('Verification token is required', 400);
    }

    const hashedToken = hashToken(token);

    // Atomic conditional update: mark token as used only if not already used and not expired.
    // This prevents TOCTOU race conditions where two concurrent requests could both
    // pass the check and use the same token.
    const { EmailVerificationToken } = await import('@agent-platform/database/models');
    const result = await EmailVerificationToken.updateMany(
      {
        token: hashedToken,
        usedAt: null,
        expiresAt: { $gt: new Date() },
      },
      { $set: { usedAt: new Date() } },
    );
    const updateCount = result.modifiedCount || 0;

    if (updateCount === 0) {
      // Token was not found, already used, or expired
      return authError('Invalid or expired verification token', 400);
    }

    // Now fetch the token record to get the user
    const { User } = await import('@agent-platform/database/models');
    let verificationToken: any;
    const tokenDoc = await EmailVerificationToken.findOne({ token: hashedToken }).lean();
    if (tokenDoc) {
      // TENANT_EXCEPTION: Unauthenticated flow — no tenant context available.
      // The token is validated via cryptographic hash + expiry, and userId is trusted
      // from the token document. Tenant scoping is not possible here.
      const userDoc = await User.findOne({ _id: tokenDoc.userId }).lean();
      verificationToken = {
        ...tokenDoc,
        id: tokenDoc._id,
        user: userDoc ? { ...userDoc, id: userDoc._id } : null,
      };
    }

    if (!verificationToken) {
      return authError('Invalid verification token', 400);
    }

    // Mark user as verified
    await updateUser(verificationToken.userId, {
      emailVerified: true,
      lastLoginAt: new Date(),
    });

    // Resolve tenant context, auto-accepting single pending invitation
    const { tenantContext, pendingInvitationChoice } = await resolveUserContextOrAutoAcceptInvite(
      String(verificationToken.userId),
      verificationToken.user.email,
    );

    // Issue tokens
    const tokenPair = await createTokenPair(verificationToken.user, tenantContext);

    await logAuditEvent({
      userId: verificationToken.userId,
      action: AuditActions.EMAIL_VERIFIED,
      ip: clientIp,
      userAgent,
      metadata: {
        autoAccepted: !!tenantContext && !pendingInvitationChoice,
      },
    });

    const response = NextResponse.json({
      user: {
        id: verificationToken.user.id,
        email: verificationToken.user.email,
        name: verificationToken.user.name,
        avatarUrl: verificationToken.user.avatarUrl,
      },
      accessToken: tokenPair.accessToken,
      expiresIn: tokenPair.expiresIn,
      needsOnboarding:
        !tenantContext &&
        !pendingInvitationChoice &&
        !(await isPlatformAdminUser({
          id: String(verificationToken.userId),
          email: verificationToken.user.email,
        })),
      pendingInvitationChoice,
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
    log.error('Verify email error', {
      err: error instanceof Error ? error.message : String(error),
    });
    return authError('Internal server error', 500);
  }
}

export const POST = withOpenAPI(
  {
    summary: 'Verify email address with token',
    description:
      'Verify user email address using token from signup email. Marks email as verified and returns authentication tokens. Also sets refresh_token cookie.',
    body: verifyEmailRequestSchema,
    response: verifyEmailResponseSchema,
    successStatus: 200,
    auth: false,
  },
  handler as any,
);

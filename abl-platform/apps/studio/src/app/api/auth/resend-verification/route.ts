/**
 * POST /api/auth/resend-verification
 * Resend email verification link
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import crypto from 'crypto';
import { createEmailService, verificationEmail } from '@agent-platform/shared';
import { checkRateLimit } from '@/lib/rate-limit';
import { getConfig, isConfigLoaded } from '@/config';
import { AUTH_CONFIG_DEFAULTS } from '@/lib/auth-constants';
import { hashToken } from '@/lib/token-hash';
import { getFrontendUrl } from '@/lib/auth-helpers';
import { findUserByEmail, createEmailVerificationToken } from '@/repos/auth-repo';
import { authError, getAuthRouteClientIp } from '../route-utils';

const resendVerificationRequestSchema = z.object({
  email: z.string().email('Invalid email format'),
});

const resendVerificationResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

async function handler(request: NextRequest) {
  try {
    // Rate limit per IP
    const ip = getAuthRouteClientIp(request);
    const authConfig = isConfigLoaded() ? getConfig().auth : null;
    const rlConfig =
      authConfig?.rateLimits.resendVerification ??
      AUTH_CONFIG_DEFAULTS.rateLimits.resendVerification;
    const rl = await checkRateLimit(
      `resend-verification:${ip}`,
      rlConfig.maxAttempts,
      rlConfig.windowMs,
    );
    if (!rl.allowed) {
      return authError('Too many attempts. Please try again later.', 429, {
        'Retry-After': String(rl.retryAfter),
      });
    }

    const body = await request.json();
    const { email } = body;

    if (!email || typeof email !== 'string') {
      return authError('Email is required', 400);
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Find user — always return success to prevent email enumeration
    const user = await findUserByEmail(normalizedEmail);

    if (user && !user.emailVerified && user.authProvider === 'email') {
      // Invalidate all existing unused tokens for this user
      const { EmailVerificationToken } = await import('@agent-platform/database/models');
      await EmailVerificationToken.deleteMany({ userId: user.id, usedAt: null });

      // Generate new verification token
      const token = crypto.randomBytes(64).toString('hex');
      const hashedToken = hashToken(token);
      const verificationTokenTtlMs =
        authConfig?.password.verificationTokenTtlMs ?? 24 * 60 * 60 * 1000;
      const expiresAt = new Date(Date.now() + verificationTokenTtlMs);

      await createEmailVerificationToken({
        userId: user.id,
        token: hashedToken,
        expiresAt,
      });

      // Send verification email — raw token goes in the URL sent to user
      const frontendUrl = getFrontendUrl();
      const verificationUrl = `${frontendUrl}/auth/verify-email?token=${token}`;
      const emailContent = verificationEmail({
        name: user.name || undefined,
        verificationUrl,
      });

      const emailService = createEmailService();
      await emailService.sendEmail(user.email, emailContent.subject, emailContent.html);
    }

    // Always return success to prevent email enumeration
    return NextResponse.json({
      success: true,
      message: 'If an account exists with this email, a verification link has been sent.',
    });
  } catch (error) {
    console.error('[Auth] Resend verification error:', error);
    return authError('Internal server error', 500);
  }
}

export const POST = withOpenAPI(
  {
    summary: 'Resend verification email',
    description:
      'Resend email verification link. Always returns success to prevent email enumeration.',
    body: resendVerificationRequestSchema,
    response: resendVerificationResponseSchema,
    successStatus: 200,
    auth: false,
  },
  handler as any,
);

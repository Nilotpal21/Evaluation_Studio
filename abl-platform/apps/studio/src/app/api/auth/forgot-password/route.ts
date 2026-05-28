/**
 * POST /api/auth/forgot-password
 * Send password reset email
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('auth');
import { createEmailService, passwordResetEmail } from '@agent-platform/shared';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { checkRateLimit } from '@/lib/rate-limit';
import { hashToken } from '@/lib/token-hash';
import { findUserByEmail, createPasswordResetToken } from '@/repos/auth-repo';
import { getConfig, isConfigLoaded } from '@/config';
import { getFrontendUrl } from '@/lib/auth-helpers';
import { AUTH_CONFIG_DEFAULTS } from '@/lib/auth-constants';

function getAuthConfig() {
  if (!isConfigLoaded()) return AUTH_CONFIG_DEFAULTS;
  return getConfig().auth;
}

// Request body schema
const forgotPasswordRequestSchema = z.object({
  email: z.string().email('Invalid email format').max(254).describe('User email address'),
});

// Success response schema
const forgotPasswordResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().describe('Generic success message (same whether email exists or not)'),
});

async function handler(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const parsed = forgotPasswordRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 });
    }

    const normalizedEmail = parsed.data.email.toLowerCase().trim();

    const authConfig = getAuthConfig();
    // Rate limit per email
    const rl = await checkRateLimit(
      `forgot-password:${normalizedEmail}`,
      authConfig.rateLimits.forgotPassword.maxAttempts,
      authConfig.rateLimits.forgotPassword.windowMs,
    );
    if (!rl.allowed) {
      // Still return 200 to prevent email enumeration, but don't actually send
      return NextResponse.json({
        success: true,
        message: 'If an account with that email exists, we sent a password reset link.',
      });
    }
    const startTime = Date.now();

    // Always return 200 to prevent email enumeration
    const user = await findUserByEmail(normalizedEmail);

    if (!user) {
      log.info('Password reset requested for non-existent email', { email: normalizedEmail });
    } else {
      if (!user.passwordHash) {
        log.info('Password reset requested for SSO user (first-time password set)', {
          userId: user.id,
          authProvider: user.authProvider,
        });
      }

      // Generate reset token
      const token = crypto.randomBytes(64).toString('hex');
      const hashedToken = hashToken(token);
      const expiresAt = new Date(Date.now() + authConfig.password.resetTokenTtlMs);

      await createPasswordResetToken({
        userId: user.id,
        token: hashedToken,
        expiresAt,
      });

      // Send password reset email — raw token goes in the URL sent to user
      const frontendUrl = getFrontendUrl();
      const resetUrl = `${frontendUrl}/auth/reset-password?token=${token}`;
      const emailContent = passwordResetEmail({
        name: user.name || undefined,
        resetUrl,
      });

      const emailService = createEmailService();
      await emailService.sendEmail(user.email, emailContent.subject, emailContent.html);

      await logAuditEvent({
        userId: user.id,
        action: AuditActions.PASSWORD_RESET_REQUESTED,
        ip: request.headers.get('x-forwarded-for') || undefined,
        userAgent: request.headers.get('user-agent') || undefined,
      });
    }

    // Add consistent delay to prevent timing attacks
    const elapsed = Date.now() - startTime;
    const minResponseMs = authConfig.timingProtection.minResponseMs;
    if (elapsed < minResponseMs) {
      await new Promise((resolve) => setTimeout(resolve, minResponseMs - elapsed));
    }

    // Always return success to prevent email enumeration
    return NextResponse.json({
      success: true,
      message: 'If an account with that email exists, we sent a password reset link.',
    });
  } catch (error) {
    log.error('Forgot password error', {
      err: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const POST = withOpenAPI(
  {
    summary: 'Request password reset email',
    description:
      'Send password reset email if account exists. Returns success message regardless to prevent email enumeration. Rate limited to 3 attempts per 15 minutes per email.',
    body: forgotPasswordRequestSchema,
    response: forgotPasswordResponseSchema,
    successStatus: 200,
    auth: false,
  },
  handler as any,
);

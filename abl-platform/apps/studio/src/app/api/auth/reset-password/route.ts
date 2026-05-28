/**
 * POST /api/auth/reset-password
 * Reset password using token
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('auth');
import {
  hashPassword,
  validatePasswordStrength,
  isPasswordInHistory,
} from '@/services/auth/password-service';
import { revokeAllUserTokens } from '@/services/auth-service';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { checkRateLimit } from '@/lib/rate-limit';
import { hashToken } from '@/lib/token-hash';
import { findPasswordResetToken, updateUser, pushPasswordHistory } from '@/repos/auth-repo';
import { getConfig, isConfigLoaded } from '@/config';
import { AUTH_CONFIG_DEFAULTS } from '@/lib/auth-constants';
import { authError, getAuthRouteClientIp, parseOptionalJsonBody } from '../route-utils';

function getAuthConfig() {
  if (!isConfigLoaded()) return AUTH_CONFIG_DEFAULTS;
  return getConfig().auth;
}

// Request body schema (min/max validated dynamically from config in handler)
const resetPasswordRequestSchema = z.object({
  token: z.string().min(1).describe('Password reset token from forgot-password email'),
  newPassword: z.string().min(1).describe('New password (must meet strength requirements)'),
});

// Success response schema
const resetPasswordResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().describe('Confirmation message'),
});

async function handler(request: NextRequest) {
  try {
    const authConfig = getAuthConfig();
    const clientIp = getAuthRouteClientIp(request);
    const userAgent = request.headers.get('user-agent') || undefined;
    const rl = await checkRateLimit(
      `reset-password:${clientIp}`,
      authConfig.rateLimits.resetPassword.maxAttempts,
      authConfig.rateLimits.resetPassword.windowMs,
    );
    if (!rl.allowed) {
      return authError('Too many attempts. Please try again later.', 429);
    }

    const body = await parseOptionalJsonBody<{
      token?: unknown;
      newPassword?: unknown;
    }>(request);
    if (!body) {
      return authError('Invalid request body', 400);
    }
    const { token, newPassword } = body;

    if (!token || typeof token !== 'string' || !newPassword || typeof newPassword !== 'string') {
      return authError('Token and new password are required', 400);
    }

    if (newPassword.length < authConfig.password.minLength) {
      return authError(
        `Password must be at least ${authConfig.password.minLength} characters`,
        400,
      );
    }

    if (newPassword.length > authConfig.validation.maxPasswordLength) {
      return authError('Password too long', 400);
    }

    // Validate password strength
    const passwordCheck = validatePasswordStrength(newPassword);
    if (!passwordCheck.valid) {
      return authError('Password too weak', 400);
    }

    const hashedToken = hashToken(token);

    // Step 1: Look up token + user (read-only) to validate and check password history
    // BEFORE consuming the token. This ensures the token stays valid if the user
    // picks a recently-used password and needs to try again.
    const { PasswordResetToken, User } = await import('@agent-platform/database/models');
    const tokenDoc = await PasswordResetToken.findOne({
      token: hashedToken,
      usedAt: null,
      expiresAt: { $gt: new Date() },
    }).lean();

    if (!tokenDoc?.userId) {
      return authError('Invalid or expired reset token', 400);
    }

    // TENANT_EXCEPTION: Unauthenticated flow — no tenant context available.
    // The token is validated via cryptographic hash + expiry, and userId is trusted
    // from the token document. Tenant scoping is not possible here.
    // Must NOT use .lean() — encryption plugin post-find hook decrypts passwordHash.
    // Must include ire/cek/iv/fieldsToEncrypt so the plugin can decrypt.
    const userDoc = await User.findOne({ _id: tokenDoc.userId }).select(
      'passwordHash passwordHistory ire cek iv fieldsToEncrypt',
    );

    // Step 2: Check password history — reject reuse before consuming the token
    if (userDoc) {
      const allHistory = [
        ...(userDoc.passwordHash ? [{ hash: userDoc.passwordHash }] : []),
        ...(userDoc.passwordHistory ?? []),
      ];
      if (await isPasswordInHistory(newPassword, allHistory)) {
        return NextResponse.json(
          { error: 'Cannot reuse a recent password. Please choose a different one.' },
          { status: 400 },
        );
      }
    }

    // Step 3: Atomically consume the token now that we know the password is valid.
    // Prevents TOCTOU race conditions — only one request can consume the token.
    const updateResult = await PasswordResetToken.updateMany(
      {
        token: hashedToken,
        usedAt: null,
        expiresAt: { $gt: new Date() },
      },
      { $set: { usedAt: new Date() } },
    );

    if ((updateResult.modifiedCount || 0) === 0) {
      // Token was consumed by a concurrent request between our read and this update
      return authError('Invalid or expired reset token', 400);
    }

    // Step 4: Hash new password and update user
    const hashed = await hashPassword(newPassword);

    // Push the OLD password hash to history before overwriting with the new one
    if (userDoc?.passwordHash) {
      await pushPasswordHistory(
        String(tokenDoc.userId),
        userDoc.passwordHash,
        authConfig.password.historyCount,
      );
    }

    await updateUser(String(tokenDoc.userId), { passwordHash: hashed });

    // Revoke all refresh tokens (force re-login everywhere)
    await revokeAllUserTokens(String(tokenDoc.userId));

    await logAuditEvent({
      userId: String(tokenDoc.userId),
      action: AuditActions.PASSWORD_RESET_COMPLETED,
      ip: clientIp,
      userAgent,
    });

    return NextResponse.json({
      success: true,
      message: 'Password reset successful. Please log in.',
    });
  } catch (error) {
    log.error('Reset password error', {
      err: error instanceof Error ? error.message : String(error),
    });
    return authError('Internal server error', 500);
  }
}

export const POST = withOpenAPI(
  {
    summary: 'Reset password with token',
    description:
      'Reset user password using token from forgot-password email. Revokes all existing refresh tokens to force re-login on all devices.',
    body: resetPasswordRequestSchema,
    response: resetPasswordResponseSchema,
    successStatus: 200,
    auth: false,
  },
  handler as any,
);

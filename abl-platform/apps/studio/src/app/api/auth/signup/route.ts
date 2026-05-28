/**
 * POST /api/auth/signup
 * Email/password signup
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { hashPassword, validatePasswordStrength } from '@/services/auth/password-service';
import { createEmailService, verificationEmail } from '@agent-platform/shared';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { checkRateLimit } from '@/lib/rate-limit';
import { hashToken } from '@/lib/token-hash';
import { findUserByEmail, createUser, createEmailVerificationToken } from '@/repos/auth-repo';
import { getConfig, isConfigLoaded } from '@/config';
import { getFrontendUrl, getEmailRegex } from '@/lib/auth-helpers';
import { AUTH_CONFIG_DEFAULTS } from '@/lib/auth-constants';
import { authError, getAuthRouteClientIp, parseOptionalJsonBody } from '../route-utils';
import { isEmailAllowedForAuth } from '@/lib/platform-auth-policy';

const log = createLogger('auth:signup');

function getAuthConfig() {
  if (!isConfigLoaded()) return AUTH_CONFIG_DEFAULTS;
  return getConfig().auth;
}

// Request body schema
const signupRequestSchema = z.object({
  email: z.string().email('Invalid email format').max(254).describe('User email address'),
  password: z.string().min(8).max(128).describe('Password (must meet strength requirements)'),
  name: z.string().max(200).optional().describe('User display name (optional)'),
  inviteToken: z
    .string()
    .max(512)
    .optional()
    .describe('Invitation token from workspace invite link'),
});

const signupSuccessSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});

const signupExistsSchema = z.object({
  accountExists: z.literal(true),
  message: z.string(),
});

const signupResponseSchema = z.union([signupSuccessSchema, signupExistsSchema]);

async function handler(request: NextRequest) {
  try {
    const authConfig = getAuthConfig();
    const clientIp = getAuthRouteClientIp(request);
    const userAgent = request.headers.get('user-agent') || undefined;
    // Rate limit per IP
    const rl = await checkRateLimit(
      `signup:${clientIp}`,
      authConfig.rateLimits.signup.maxAttempts,
      authConfig.rateLimits.signup.windowMs,
    );
    if (!rl.allowed) {
      return authError('Too many signup attempts. Please try again later.', 429, {
        'Retry-After': String(rl.retryAfter),
      });
    }

    const body = await parseOptionalJsonBody<{
      email?: unknown;
      password?: unknown;
      name?: unknown;
      inviteToken?: unknown;
    }>(request);
    if (!body) {
      return authError('Invalid request body', 400);
    }
    const { email, password, name, inviteToken } = body;

    // Type validation
    if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
      return authError('Email and password are required', 400);
    }
    if (name !== undefined && typeof name !== 'string') {
      return authError('Invalid name', 400);
    }

    // Length bounds
    if (
      email.length > authConfig.validation.maxEmailLength ||
      password.length > authConfig.validation.maxPasswordLength ||
      (name && name.length > authConfig.validation.maxNameLength)
    ) {
      return authError('Input too long', 400);
    }

    // Normalize email
    const normalizedEmail = email.toLowerCase().trim();

    // Validate email format
    if (!getEmailRegex().test(normalizedEmail)) {
      return authError('Invalid email format', 400);
    }

    const parsedInvite =
      typeof inviteToken === 'string' && inviteToken.length > 0 && inviteToken.length <= 512
        ? inviteToken
        : undefined;

    if (!(await isEmailAllowedForAuth(normalizedEmail, { inviteToken: parsedInvite }))) {
      return NextResponse.json(
        {
          error: 'This email domain is not approved for self-service access.',
          code: 'DOMAIN_NOT_ALLOWED',
        },
        { status: 403 },
      );
    }

    // Validate password strength
    const passwordCheck = validatePasswordStrength(password);
    if (!passwordCheck.valid) {
      return authError('Password too weak', 400);
    }

    // Check if email already exists — inform the client so they can redirect to login
    const existingUser = await findUserByEmail(normalizedEmail);
    if (existingUser) {
      log.info('Signup attempt for existing email');
      await logAuditEvent({
        userId: existingUser.id,
        action: AuditActions.SIGNUP,
        ip: clientIp,
        userAgent,
        metadata: { provider: 'email', result: 'duplicate_email' },
      });
      return NextResponse.json({
        accountExists: true,
        message: 'An account with this email already exists.',
      });
    }

    // Hash password and create user
    const hashed = await hashPassword(password);
    const sanitizedName = name
      ? name.trim().slice(0, authConfig.validation.maxNameLength)
      : normalizedEmail.split('@')[0];
    const user = await createUser({
      email: normalizedEmail,
      name: sanitizedName,
      passwordHash: hashed,
      authProvider: 'email',
      emailVerified: false,
    });

    // Generate verification token
    const token = crypto.randomBytes(64).toString('hex');
    const hashedToken = hashToken(token);
    const expiresAt = new Date(Date.now() + authConfig.password.verificationTokenTtlMs);

    await createEmailVerificationToken({
      userId: user.id,
      token: hashedToken,
      expiresAt,
    });

    // Send verification email
    const frontendUrl = getFrontendUrl();
    const inviteParam = parsedInvite ? `&invite=${encodeURIComponent(parsedInvite)}` : '';
    const verificationUrl = `${frontendUrl}/auth/verify-email?token=${token}${inviteParam}`;
    if (process.env.NODE_ENV !== 'production') {
      log.info('Verification URL (dev only)', { verificationUrl });
    }
    const emailContent = verificationEmail({
      name: user.name || undefined,
      verificationUrl,
    });

    const emailService = createEmailService();
    await emailService.sendEmail(user.email, emailContent.subject, emailContent.html);

    await logAuditEvent({
      userId: user.id,
      action: AuditActions.SIGNUP,
      ip: clientIp,
      userAgent,
      metadata: { provider: 'email' },
    });

    return NextResponse.json({
      success: true,
      message: 'Account created. Please check your email to verify your account.',
    });
  } catch (error) {
    log.error('Signup error', { err: error instanceof Error ? error.message : String(error) });
    return authError('Internal server error', 500);
  }
}

export const POST = withOpenAPI(
  {
    summary: 'Create new account with email/password',
    description:
      'Create a new user account and send email verification. Returns accountExists flag if the email is already registered.',
    body: signupRequestSchema,
    response: signupResponseSchema,
    successStatus: 200,
    auth: false,
  },
  handler as any,
);

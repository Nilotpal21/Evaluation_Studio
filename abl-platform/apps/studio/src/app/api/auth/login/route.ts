/**
 * POST /api/auth/login
 * Email/password login
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { getAuthErrorInfo } from '@/lib/auth';

const log = createLogger('auth');
import { verifyPassword } from '@/services/auth/password-service';
import {
  createTokenPair,
  createPartialToken,
  resolveUserTenantContext,
  resolveUserContextOrAutoAcceptInvite,
} from '@/services/auth-service';
import { isPlatformAdminUser } from '@/lib/platform-auth-policy';
import { getMFAStatus } from '@/services/auth/mfa-service';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { checkRateLimit } from '@/lib/rate-limit';
import {
  findUserByEmail,
  updateUser,
  incrementFailedLoginAttempts,
  resetFailedLoginAttempts,
} from '@/repos/auth-repo';
import { getConfig, isConfigLoaded } from '@/config';
import { AUTH_CONFIG_DEFAULTS } from '@/lib/auth-constants';
import { authError, getAuthRouteClientIp, parseOptionalJsonBody } from '../route-utils';

function getAuthConfig() {
  if (!isConfigLoaded()) return AUTH_CONFIG_DEFAULTS;
  return getConfig().auth;
}

// Request body schema
const loginRequestSchema = z.object({
  email: z.string().email('Invalid email format').max(254),
  password: z.string().min(1).max(128),
  inviteToken: z.string().max(512).optional(),
});

// Success response schema (when MFA is not required)
const loginSuccessResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    avatarUrl: z.string().nullable(),
  }),
  accessToken: z.string(),
  expiresIn: z.number(),
  needsOnboarding: z.boolean(),
});

// MFA required response schema
const mfaRequiredResponseSchema = z.object({
  mfaRequired: z.literal(true),
});

// Union of both response types
const loginResponseSchema = z.union([loginSuccessResponseSchema, mfaRequiredResponseSchema]);

async function handler(request: NextRequest) {
  try {
    const authConfig = getAuthConfig();
    const clientIp = getAuthRouteClientIp(request);
    const userAgent = request.headers.get('user-agent') || undefined;
    // Rate limit per IP
    const rl = await checkRateLimit(
      `login:${clientIp}`,
      authConfig.rateLimits.login.maxAttempts,
      authConfig.rateLimits.login.windowMs,
    );
    if (!rl.allowed) {
      return authError('Too many login attempts. Please try again later.', 429, {
        'Retry-After': String(rl.retryAfter),
      });
    }

    const body = await parseOptionalJsonBody<unknown>(request);
    if (!body) {
      return authError('Invalid request body', 400);
    }

    const parsed = loginRequestSchema.safeParse(body);
    if (!parsed.success) {
      return authError('Email and password are required', 400);
    }
    const { email, password } = parsed.data;

    // Normalize email
    const normalizedEmail = email.toLowerCase().trim();

    // Existing users can always sign in; the allowlist only gates new account
    // creation, so login does not consult it. Return a uniform 401 for
    // non-existent users to prevent account enumeration.
    const user = await findUserByEmail(normalizedEmail);
    if (!user) {
      return authError('Invalid email or password', 401);
    }

    // Check that user has a password set — SSO users who haven't set a password cannot password-login
    if (!user.passwordHash) {
      log.info('Password login attempted for user without password', {
        userId: user.id,
        authProvider: user.authProvider,
      });
      return authError('Invalid email or password', 401);
    }

    // Check account lockout
    if (user.loginLockedUntil && new Date(user.loginLockedUntil) > new Date()) {
      const remainingMs = new Date(user.loginLockedUntil).getTime() - Date.now();
      const remainingMin = Math.ceil(remainingMs / 60_000);
      return authError(
        `Account temporarily locked due to too many failed attempts. Try again in ${remainingMin} minute${remainingMin === 1 ? '' : 's'}.`,
        423,
      );
    }

    // Verify password
    if (!user.passwordHash) {
      return authError('Invalid email or password', 401);
    }

    const validPassword = await verifyPassword(password, user.passwordHash);
    if (!validPassword) {
      const auditTenantContext = await resolveUserTenantContext(user.id).catch(() => null);
      // Atomically increment failed attempts and lock if threshold reached
      const { failedCount, locked } = await incrementFailedLoginAttempts(
        user.id,
        authConfig.lockout.maxFailedAttempts,
        authConfig.lockout.lockDurationMs,
      );
      if (locked) {
        await logAuditEvent({
          userId: user.id,
          tenantId: auditTenantContext?.tenantId,
          action: AuditActions.ACCOUNT_LOCKED,
          ip: clientIp,
          userAgent,
          metadata: { provider: 'email', failedAttempts: failedCount },
        });
      }
      await logAuditEvent({
        userId: user.id,
        tenantId: auditTenantContext?.tenantId,
        action: AuditActions.LOGIN_FAILED,
        ip: clientIp,
        userAgent,
        metadata: { provider: 'email', reason: 'invalid_password' },
      });
      if (locked) {
        const lockMin = Math.ceil(authConfig.lockout.lockDurationMs / 60_000);
        return authError(
          `Account temporarily locked due to too many failed attempts. Try again in ${lockMin} minute${lockMin === 1 ? '' : 's'}.`,
          423,
        );
      }
      const remaining = authConfig.lockout.maxFailedAttempts - failedCount;
      if (remaining <= 2 && remaining > 0) {
        return authError(
          `Invalid email or password. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining before account is locked.`,
          401,
        );
      }
      return authError('Invalid email or password', 401);
    }

    // Password is correct — now check email verification.
    // We check AFTER password verification so we don't reveal verification
    // status to someone who doesn't know the password.
    if (!user.emailVerified) {
      return authError('Please verify your email address before signing in.', 403);
    }

    // Successful login — reset failed attempts and update last login
    await resetFailedLoginAttempts(user.id);
    await updateUser(user.id, { lastLoginAt: new Date() });

    // Check MFA
    const mfaStatus = await getMFAStatus(user.id);
    if (mfaStatus.enabled) {
      const auditTenantContext = await resolveUserTenantContext(user.id).catch(() => null);
      const partialToken = createPartialToken(user);
      await logAuditEvent({
        userId: user.id,
        tenantId: auditTenantContext?.tenantId,
        action: AuditActions.LOGIN,
        ip: clientIp,
        userAgent,
        metadata: { provider: 'email', mfaPending: true },
      });
      // Set partial token in httpOnly cookie instead of response body
      const mfaResponse = NextResponse.json({
        mfaRequired: true,
      });
      mfaResponse.cookies.set('mfa_partial', partialToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: authConfig.tokens.mfaCookieMaxAgeSeconds,
        path: '/api/mfa',
      });
      return mfaResponse;
    }

    // Super admins get tokens without requiring tenant context
    const isSuperAdmin = await isPlatformAdminUser(user);

    if (isSuperAdmin) {
      const existingContext = await resolveUserTenantContext(user.id, {
        platformAdminEmail: user.email,
      });
      const tokenPair = await createTokenPair(user, existingContext);

      await logAuditEvent({
        userId: user.id,
        tenantId: existingContext?.tenantId,
        action: AuditActions.LOGIN,
        ip: clientIp,
        userAgent,
        metadata: { provider: 'email', isSuperAdmin: true },
      });

      const response = NextResponse.json({
        user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl },
        accessToken: tokenPair.accessToken,
        expiresIn: tokenPair.expiresIn,
        needsOnboarding: false,
        isSuperAdmin: true,
      });

      response.cookies.set('refresh_token', tokenPair.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: authConfig.tokens.refreshCookieMaxAgeSeconds,
        path: '/',
      });
      response.headers.append(
        'Set-Cookie',
        'refresh_token=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/api/auth',
      );
      return response;
    }

    // Resolve tenant context with invitation-aware logic
    const { tenantContext, pendingInvitationChoice } = await resolveUserContextOrAutoAcceptInvite(
      user.id,
      user.email,
    );

    // Issue tokens
    const tokenPair = await createTokenPair(user, tenantContext);

    await logAuditEvent({
      userId: user.id,
      tenantId: tenantContext?.tenantId,
      action: AuditActions.LOGIN,
      ip: clientIp,
      userAgent,
      metadata: { provider: 'email' },
    });

    const response = NextResponse.json({
      user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl },
      accessToken: tokenPair.accessToken,
      expiresIn: tokenPair.expiresIn,
      needsOnboarding: !tenantContext && !pendingInvitationChoice,
      pendingInvitationChoice: pendingInvitationChoice || undefined,
    });

    // Set refresh token as httpOnly cookie (not in response body)
    response.cookies.set('refresh_token', tokenPair.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: authConfig.tokens.refreshCookieMaxAgeSeconds,
      path: '/',
    });

    // Clear any stale cookie from the old /api/auth path (append AFTER cookies.set)
    response.headers.append(
      'Set-Cookie',
      'refresh_token=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/api/auth',
    );

    return response;
  } catch (error) {
    const mappedError = getAuthErrorInfo(error);
    if (mappedError) {
      return authError(mappedError.message, mappedError.status);
    }
    log.error('Login error', { err: error instanceof Error ? error.message : String(error) });
    return authError('Internal server error', 500);
  }
}

export const POST = withOpenAPI(
  {
    summary: 'Email/password login',
    description:
      'Authenticate user with email and password. Returns access token on success or MFA requirement if enabled.',
    body: loginRequestSchema,
    response: loginResponseSchema,
    successStatus: 200,
    auth: false, // Login endpoint does not require auth
  },
  handler as any,
);

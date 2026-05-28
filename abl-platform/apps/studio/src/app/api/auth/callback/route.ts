/**
 * GET /api/auth/callback
 * Handle Google OAuth callback
 */

import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { OAuth2Client } from 'google-auth-library';
import { AppError } from '@agent-platform/shared/errors';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('auth');
import {
  findOrCreateGoogleUser,
  createTokenPair,
  createPartialToken,
  resolveUserContextOrAutoAcceptInvite,
} from '@/services/auth-service';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { getMFAStatus } from '@/services/auth/mfa-service';
import { storeAuthCode } from '@/lib/sso-auth-codes';
import { getConfig, isConfigLoaded } from '@/config';
import { findDefaultTenantMembership } from '@/repos/auth-repo';
import { getFrontendUrl } from '@/lib/auth-helpers';
import { isEmailAllowedForAuth, isPlatformAdminUser } from '@/lib/platform-auth-policy';
import {
  buildAuthCodeRedirect,
  buildAuthErrorRedirect,
  clearAdminRedirectCookie,
  getAdminRedirectCookie,
} from '@/lib/admin-auth-handoff';

const FRONTEND_URL = getFrontendUrl();

let cachedClient: OAuth2Client | null = null;

function getOAuth2Client(): OAuth2Client {
  if (!cachedClient) {
    const cfg = isConfigLoaded() ? getConfig() : null;
    const clientId = cfg?.oauth.google.clientId || process.env.GOOGLE_CLIENT_ID;
    const clientSecret = cfg?.oauth.google.clientSecret || process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = `${cfg?.server.frontendUrl || process.env.FRONTEND_URL || 'http://localhost:5173'}/api/auth/callback`;

    if (!clientId || !clientSecret) {
      throw new Error(
        `Google OAuth misconfigured: clientId=${clientId ? 'set' : 'MISSING'}, clientSecret=${clientSecret ? 'set' : 'MISSING'}`,
      );
    }

    cachedClient = new OAuth2Client(clientId, clientSecret, redirectUri);
  }
  return cachedClient;
}

// Query parameters schema
const callbackQuerySchema = z.object({
  code: z.string().optional(),
  error: z.string().optional(),
  state: z.string().optional(),
});

// No response schema as this endpoint redirects to frontend
async function handler(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const error = searchParams.get('error');
  const stateParam = searchParams.get('state');
  const adminRedirect = getAdminRedirectCookie(request, stateParam);

  const clearOAuthCookies = (response: NextResponse) => {
    response.cookies.set('oauth_state', '', { maxAge: 0, path: '/api/auth' });
    response.cookies.set('oauth_invite', '', { maxAge: 0, path: '/api/auth' });
    clearAdminRedirectCookie(response);
    return response;
  };

  const redirectToAuthError = (errorCode: string, params?: Record<string, string>) =>
    clearOAuthCookies(
      NextResponse.redirect(buildAuthErrorRedirect(errorCode, adminRedirect, params)),
    );

  if (error || !code) {
    return redirectToAuthError(error || 'no_code');
  }

  // Validate CSRF state parameter
  const storedState = request.cookies.get('oauth_state')?.value;
  if (!stateParam || !storedState || stateParam !== storedState) {
    return redirectToAuthError('invalid_state');
  }

  let client: OAuth2Client;
  try {
    client = getOAuth2Client();
  } catch (cfgErr) {
    log.error('OAuth misconfigured', {
      err: cfgErr instanceof Error ? cfgErr.message : String(cfgErr),
    });
    return redirectToAuthError('oauth_not_configured');
  }

  try {
    const { tokens } = await client.getToken(code);

    if (!tokens.id_token) {
      throw new Error('No ID token received');
    }

    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience:
        (isConfigLoaded() ? getConfig().oauth.google.clientId : null) ||
        process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.sub || !payload.email) {
      throw new Error('Invalid token payload');
    }

    if (payload.email_verified === false) {
      return redirectToAuthError('email_not_verified');
    }

    const inviteToken = request.cookies.get('oauth_invite')?.value;

    if (!(await isEmailAllowedForAuth(payload.email, { inviteToken: inviteToken || undefined }))) {
      return redirectToAuthError('domain_not_allowed', { email: payload.email });
    }

    let user;
    try {
      user = await findOrCreateGoogleUser(
        {
          googleId: payload.sub,
          email: payload.email,
          name: payload.name,
          avatarUrl: payload.picture,
        },
        {
          requireExistingUser: adminRedirect !== null,
        },
      );
    } catch (linkError) {
      if (linkError instanceof AppError) {
        if (linkError.code === 'FORBIDDEN' || linkError.code === 'CONFLICT') {
          return redirectToAuthError('account_conflict');
        }

        if (linkError.code === 'NOT_FOUND') {
          return redirectToAuthError('studio_account_required');
        }
      }
      log.error('User lookup failed', {
        err: linkError instanceof Error ? linkError.message : String(linkError),
      });
      return redirectToAuthError('service_unavailable');
    }

    // Check if org enforces SSO via tenant membership
    const tenantMembership = await findDefaultTenantMembership(user.id);

    if (tenantMembership?.tenant.organizationId) {
      const { Organization } = await import('@agent-platform/database/models');
      const org = await Organization.findOne({
        _id: tenantMembership.tenant.organizationId,
      }).lean();
      const ssoConfig = org?.ssoConfigs?.find((c: any) => c.isActive);
      if (ssoConfig?.forceSso && !ssoConfig?.allowGoogleFallback) {
        return redirectToAuthError('sso_required');
      }
    }

    // Check MFA
    const mfaStatus = await getMFAStatus(user.id);

    if (mfaStatus.enabled) {
      if (adminRedirect) {
        return redirectToAuthError('mfa_unsupported');
      }

      const partialToken = createPartialToken(user);
      await logAuditEvent({
        userId: user.id,
        action: AuditActions.LOGIN,
        ip: request.headers.get('x-forwarded-for') || undefined,
        userAgent: request.headers.get('user-agent') || undefined,
        metadata: { provider: 'google', mfaPending: true },
      });
      // Store MFA partial token in httpOnly cookie instead of URL
      const response = NextResponse.redirect(`${FRONTEND_URL}/auth/mfa`);
      response.cookies.set('mfa_partial', partialToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 300, // 5 minutes
        path: '/api/mfa',
      });
      return clearOAuthCookies(response);
    }

    // Resolve tenant context, auto-accepting single pending invitation
    const { tenantContext, pendingInvitationChoice } = await resolveUserContextOrAutoAcceptInvite(
      user.id,
      user.email,
    );

    // Issue full tokens with tenant context
    const tokenPair = await createTokenPair(user, tenantContext);

    await logAuditEvent({
      userId: user.id,
      action: AuditActions.LOGIN,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: { provider: 'google' },
    });

    // Generate a one-time auth code instead of putting tokens in the URL
    const authCode = crypto.randomBytes(32).toString('hex');
    await storeAuthCode(authCode, {
      accessToken: tokenPair.accessToken,
      refreshToken: tokenPair.refreshToken,
      expiresIn: tokenPair.expiresIn,
      needsOnboarding:
        !tenantContext && !pendingInvitationChoice && !(await isPlatformAdminUser(user)),
      pendingInvitationChoice,
      inviteToken: inviteToken || undefined,
    });

    return clearOAuthCookies(NextResponse.redirect(buildAuthCodeRedirect(authCode, adminRedirect)));
  } catch (err) {
    log.error('OAuth callback error', { err: err instanceof Error ? err.message : String(err) });
    return redirectToAuthError('oauth_failed');
  }
}

export const GET = withOpenAPI(
  {
    summary: 'Google OAuth callback',
    description:
      'Handle Google OAuth callback, validate CSRF state, exchange code for tokens, and redirect to frontend with one-time auth code. Handles MFA, SSO enforcement, and pending invitations.',
    query: callbackQuerySchema,
    successStatus: 302,
    auth: false,
  },
  handler as any,
);

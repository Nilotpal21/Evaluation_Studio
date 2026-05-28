/**
 * GET /api/auth/linkedin/callback
 * Handle LinkedIn OAuth callback
 */

import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { AppError } from '@agent-platform/shared/errors';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('auth-oauth');
import {
  findOrCreateLinkedInUser,
  createTokenPair,
  createPartialToken,
  resolveUserContextOrAutoAcceptInvite,
} from '@/services/auth-service';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { getMFAStatus } from '@/services/auth/mfa-service';
import { storeAuthCode } from '@/lib/sso-auth-codes';
import { httpsPost, httpsGet } from '@/lib/oauth-http';
import { findDefaultTenantMembership } from '@/repos/auth-repo';
import { getFrontendUrl, getLinkedInConfig } from '@/lib/auth-helpers';
import { isEmailAllowedForAuth, isPlatformAdminUser } from '@/lib/platform-auth-policy';
import {
  OAUTH_STATE_COOKIE_LINKEDIN,
  OAUTH_COOKIE_PATH_LINKEDIN,
  MFA_PARTIAL_COOKIE_NAME,
  MFA_COOKIE_PATH,
} from '@/lib/auth-constants';

const callbackQuerySchema = z.object({
  code: z.string().optional(),
  error: z.string().optional(),
  state: z.string().optional(),
});

async function handler(request: NextRequest) {
  const FRONTEND_URL = getFrontendUrl();
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const error = searchParams.get('error');
  const stateParam = searchParams.get('state');
  const redirectToAuthError = (errorCode: string, params?: Record<string, string>) => {
    const url = new URL('/auth/error', FRONTEND_URL);
    url.searchParams.set('error', errorCode);
    for (const [key, value] of Object.entries(params ?? {})) {
      url.searchParams.set(key, value);
    }
    return NextResponse.redirect(url);
  };

  if (error || !code) {
    return redirectToAuthError(error || 'no_code');
  }

  // Validate CSRF state parameter
  const storedState = request.cookies.get(OAUTH_STATE_COOKIE_LINKEDIN)?.value;
  if (!stateParam || !storedState || stateParam !== storedState) {
    return redirectToAuthError('invalid_state');
  }

  const { clientId, clientSecret, redirectUri, tokenUrl, profileUrl, mfaCookieMaxAge } =
    getLinkedInConfig();

  if (!clientId || !clientSecret) {
    log.error('OAuth misconfigured — missing clientId or clientSecret');
    return redirectToAuthError('oauth_not_configured');
  }

  try {
    // Exchange code for access token (uses https module to avoid undici ETIMEDOUT on dual-stack hosts)
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString();

    const tokenResponse = await httpsPost(tokenUrl, tokenBody, {
      'Content-Type': 'application/x-www-form-urlencoded',
    });

    if (!tokenResponse.ok) {
      log.error('OAuth token exchange failed', {
        provider: 'linkedin',
        status: tokenResponse.status,
      });
      throw new Error('Token exchange failed');
    }

    const tokens = JSON.parse(tokenResponse.body);
    const accessToken = tokens.access_token;

    if (!accessToken) {
      throw new Error('No access token received from LinkedIn');
    }

    // Fetch user info from LinkedIn's OpenID Connect userinfo endpoint
    const profileResponse = await httpsGet(profileUrl, {
      Authorization: `Bearer ${accessToken}`,
    });

    if (!profileResponse.ok) {
      log.error('Profile fetch failed', { provider: 'linkedin', status: profileResponse.status });
      throw new Error('Failed to fetch LinkedIn profile');
    }

    const profile = JSON.parse(profileResponse.body);

    const email = profile.email;
    if (!email) {
      throw new Error('No email in LinkedIn profile');
    }

    const inviteToken = request.cookies.get('oauth_invite')?.value;

    if (!(await isEmailAllowedForAuth(email, { inviteToken: inviteToken || undefined }))) {
      return redirectToAuthError('domain_not_allowed', { email });
    }

    // LinkedIn userinfo returns email_verified — reject unverified emails
    if (profile.email_verified === false) {
      return NextResponse.redirect(
        `${FRONTEND_URL}/auth/error?error=${encodeURIComponent('email_not_verified')}`,
      );
    }

    const displayName =
      [profile.given_name, profile.family_name].filter(Boolean).join(' ') ||
      profile.name ||
      email.split('@')[0];

    let user;
    try {
      user = await findOrCreateLinkedInUser({
        email,
        name: displayName,
        avatarUrl: profile.picture || undefined,
      });
    } catch (linkError) {
      if (linkError instanceof AppError && linkError.code === 'FORBIDDEN') {
        return NextResponse.redirect(`${FRONTEND_URL}/auth/error?error=account_conflict`);
      }
      log.error('User lookup failed', {
        err: linkError instanceof Error ? linkError.message : String(linkError),
      });
      return NextResponse.redirect(`${FRONTEND_URL}/auth/error?error=service_unavailable`);
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
        return NextResponse.redirect(`${FRONTEND_URL}/auth/error?error=sso_required`);
      }
    }

    // Check MFA
    const mfaStatus = await getMFAStatus(user.id);

    if (mfaStatus.enabled) {
      const partialToken = createPartialToken(user);
      await logAuditEvent({
        userId: user.id,
        action: AuditActions.LOGIN,
        ip: request.headers.get('x-forwarded-for') || undefined,
        userAgent: request.headers.get('user-agent') || undefined,
        metadata: { provider: 'linkedin', mfaPending: true },
      });
      const response = NextResponse.redirect(`${FRONTEND_URL}/auth/mfa`);
      response.cookies.set(MFA_PARTIAL_COOKIE_NAME, partialToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: mfaCookieMaxAge,
        path: MFA_COOKIE_PATH,
      });
      response.cookies.set(OAUTH_STATE_COOKIE_LINKEDIN, '', {
        maxAge: 0,
        path: OAUTH_COOKIE_PATH_LINKEDIN,
      });
      return response;
    }

    // Resolve tenant context, auto-accepting single pending invitation
    const { tenantContext, pendingInvitationChoice } = await resolveUserContextOrAutoAcceptInvite(
      user.id,
      user.email,
    );
    const tokenPair = await createTokenPair(user, tenantContext);

    await logAuditEvent({
      userId: user.id,
      action: AuditActions.LOGIN,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: { provider: 'linkedin' },
    });

    // Generate one-time auth code
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

    const redirectUrl = new URL(`${FRONTEND_URL}/auth/callback`);
    redirectUrl.searchParams.set('code', authCode);

    const response = NextResponse.redirect(redirectUrl);
    response.cookies.set(OAUTH_STATE_COOKIE_LINKEDIN, '', {
      maxAge: 0,
      path: OAUTH_COOKIE_PATH_LINKEDIN,
    });
    response.cookies.set('oauth_invite', '', { maxAge: 0, path: '/api/auth' });

    return response;
  } catch (err) {
    log.error('OAuth callback error', { err: err instanceof Error ? err.message : String(err) });
    return NextResponse.redirect(`${FRONTEND_URL}/auth/error?error=oauth_failed`);
  }
}

export const GET = withOpenAPI(
  {
    summary: 'LinkedIn OAuth callback',
    description:
      'Handle LinkedIn OAuth callback, validate CSRF state, exchange code for tokens, fetch profile from LinkedIn userinfo, and redirect to frontend with one-time auth code.',
    query: callbackQuerySchema,
    successStatus: 302,
    auth: false,
  },
  handler as any,
);

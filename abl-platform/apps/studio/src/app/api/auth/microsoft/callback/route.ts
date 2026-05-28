/**
 * GET /api/auth/microsoft/callback
 * Handle Microsoft OAuth callback
 */

import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { AppError } from '@agent-platform/shared/errors';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('auth-oauth');
import {
  findOrCreateMicrosoftUser,
  createTokenPair,
  createPartialToken,
  resolveUserContextOrAutoAcceptInvite,
} from '@/services/auth-service';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { getMFAStatus } from '@/services/auth/mfa-service';
import { storeAuthCode } from '@/lib/sso-auth-codes';
import { httpsPost, httpsGet } from '@/lib/oauth-http';
import { findDefaultTenantMembership } from '@/repos/auth-repo';
import { getFrontendUrl, getMicrosoftConfig } from '@/lib/auth-helpers';
import { isEmailAllowedForAuth, isPlatformAdminUser } from '@/lib/platform-auth-policy';
import {
  OAUTH_STATE_COOKIE_MICROSOFT,
  OAUTH_COOKIE_PATH_MICROSOFT,
  MFA_PARTIAL_COOKIE_NAME,
  MFA_COOKIE_PATH,
} from '@/lib/auth-constants';
import {
  buildAuthCodeRedirect,
  buildAuthErrorRedirect,
  clearAdminRedirectCookie,
  getAdminRedirectCookie,
} from '@/lib/admin-auth-handoff';

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
  const adminRedirect = getAdminRedirectCookie(request, stateParam);

  const clearOAuthCookies = (response: NextResponse) => {
    response.cookies.set(OAUTH_STATE_COOKIE_MICROSOFT, '', {
      maxAge: 0,
      path: OAUTH_COOKIE_PATH_MICROSOFT,
    });
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
  const storedState = request.cookies.get(OAUTH_STATE_COOKIE_MICROSOFT)?.value;
  if (!stateParam || !storedState || stateParam !== storedState) {
    return redirectToAuthError('invalid_state');
  }

  const { clientId, clientSecret, tenantId, redirectUri, tokenUrl, profileUrl, mfaCookieMaxAge } =
    getMicrosoftConfig();

  if (!clientId || !clientSecret) {
    log.error('OAuth misconfigured — missing clientId or clientSecret');
    return redirectToAuthError('oauth_not_configured');
  }

  try {
    // Exchange code for tokens (uses https module to avoid undici ETIMEDOUT on dual-stack hosts)
    const tokenBody = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString();

    const resolvedTokenUrl = tokenUrl.replace('{tenant}', encodeURIComponent(tenantId));
    const tokenResponse = await httpsPost(resolvedTokenUrl, tokenBody, {
      'Content-Type': 'application/x-www-form-urlencoded',
    });

    if (!tokenResponse.ok) {
      log.error('OAuth token exchange failed', {
        provider: 'microsoft',
        status: tokenResponse.status,
      });
      throw new Error('Token exchange failed');
    }

    const tokens = JSON.parse(tokenResponse.body);
    const accessToken = tokens.access_token;

    if (!accessToken) {
      throw new Error('No access token received from Microsoft');
    }

    // Fetch user profile from Microsoft Graph
    const profileResponse = await httpsGet(profileUrl, {
      Authorization: `Bearer ${accessToken}`,
    });

    if (!profileResponse.ok) {
      log.error('Profile fetch failed', { provider: 'microsoft', status: profileResponse.status });
      throw new Error('Failed to fetch Microsoft profile');
    }

    const profile = JSON.parse(profileResponse.body);

    // Extract email: mail field first, then userPrincipalName (matches koreserver pattern)
    const email = profile.mail || profile.userPrincipalName;
    if (!email) {
      throw new Error('No email in Microsoft profile');
    }

    const inviteToken = request.cookies.get('oauth_invite')?.value;

    if (!(await isEmailAllowedForAuth(email, { inviteToken: inviteToken || undefined }))) {
      return redirectToAuthError('domain_not_allowed', { email });
    }

    // Verify the email address is confirmed by Microsoft.
    // id_token may carry email_verified; for org accounts (AAD),
    // a valid mail field from Graph implies verified ownership.
    const idTokenVerified = tokens.id_token
      ? (() => {
          try {
            const payload = JSON.parse(
              Buffer.from(tokens.id_token.split('.')[1], 'base64').toString(),
            );
            return payload.email_verified;
          } catch {
            return undefined;
          }
        })()
      : undefined;

    // Personal MS accounts may have unverified emails — require explicit verification
    if (idTokenVerified === false) {
      return redirectToAuthError('email_not_verified');
    }

    const displayName =
      [profile.givenName, profile.surname].filter(Boolean).join(' ') ||
      profile.displayName ||
      email.split('@')[0];

    let user;
    try {
      user = await findOrCreateMicrosoftUser(
        {
          email,
          name: displayName,
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
        metadata: { provider: 'microsoft', mfaPending: true },
      });
      const response = NextResponse.redirect(`${FRONTEND_URL}/auth/mfa`);
      response.cookies.set(MFA_PARTIAL_COOKIE_NAME, partialToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: mfaCookieMaxAge,
        path: MFA_COOKIE_PATH,
      });
      return clearOAuthCookies(response);
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
      metadata: { provider: 'microsoft' },
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

    return clearOAuthCookies(NextResponse.redirect(buildAuthCodeRedirect(authCode, adminRedirect)));
  } catch (err) {
    log.error('OAuth callback error', { err: err instanceof Error ? err.message : String(err) });
    return redirectToAuthError('oauth_failed');
  }
}

export const GET = withOpenAPI(
  {
    summary: 'Microsoft OAuth callback',
    description:
      'Handle Microsoft OAuth callback, validate CSRF state, exchange code for tokens, fetch profile from MS Graph, and redirect to frontend with one-time auth code.',
    query: callbackQuerySchema,
    successStatus: 302,
    auth: false,
  },
  handler as any,
);

/**
 * GET /api/sso/oidc/callback - Handle OIDC authorization code callback
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { findUserByEmail, createUser, updateUser } from '@/repos/auth-repo';
import { findSSOConfig } from '@/repos/org-repo';
import {
  createPartialToken,
  createTokenPair,
  resolveUserContextOrAutoAcceptInvite,
} from '@/services/auth-service';
import { storeAuthCode } from '@/lib/sso-auth-codes';
import { getConfig, isConfigLoaded } from '@/config';
import { consumeOIDCState } from '@/lib/sso-state-store';
import { getEmailRegex } from '@/lib/auth-helpers';
import { decryptSSOConfig } from '@/lib/sso-helpers';
import {
  MFA_COOKIE_PATH,
  MFA_PARTIAL_COOKIE_NAME,
  SSO_OIDC_PROVIDER_PREFIX,
} from '@/lib/auth-constants';
import { isEmailAllowedForAuth, isPlatformAdminUser } from '@/lib/platform-auth-policy';
import { AuditActions, logAuditEvent } from '@/services/audit-service';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { getMFAStatus } from '@/services/auth/mfa-service';
import {
  buildAuthCodeRedirect,
  buildAuthErrorRedirect,
  parseAdminCallbackUrl,
} from '@/lib/admin-auth-handoff';

const log = createLogger('auth-sso');

/** Validate that a URL is an allowed external HTTPS endpoint (SSRF protection). */
function isAllowedExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const h = parsed.hostname;
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return false;
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|0\.)/.test(h)) return false;
    if (h === '169.254.169.254') return false;
    // Block IPv6-mapped IPv4 private addresses
    if (h.startsWith('::ffff:')) {
      const mapped = h.slice(7);
      if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|0\.)/.test(mapped)) return false;
    }
    // Block numeric IP formats (decimal, hex, octal) that bypass hostname checks
    if (/^\d+$/.test(h)) return false;
    if (/^0x/i.test(h)) return false;
    if (/^0\d/.test(h.split('.')[0] || '')) return false;
    return true;
  } catch {
    return false;
  }
}

async function logOidcAudit(
  request: NextRequest,
  action: string,
  metadata: Record<string, unknown>,
  userId?: string,
  tenantId?: string,
): Promise<void> {
  await logAuditEvent({
    userId,
    tenantId,
    action,
    ip: request.headers.get('x-forwarded-for') || undefined,
    userAgent: request.headers.get('user-agent') || undefined,
    metadata: {
      provider: 'oidc',
      ...metadata,
    },
  });
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  const oidcError = request.nextUrl.searchParams.get('error');
  let orgIdForAudit: string | undefined;

  if (oidcError) {
    await logOidcAudit(request, AuditActions.SSO_LOGIN_FAILED, {
      reason: 'provider_error',
      providerError: oidcError,
    });
    log.error('OIDC provider error', { oidcError });
    const stateData = state ? await consumeOIDCState(state) : null;
    const adminRedirect = parseAdminCallbackUrl(stateData?.adminRedirect);

    if (adminRedirect) {
      return NextResponse.redirect(buildAuthErrorRedirect(oidcError, adminRedirect));
    }

    return NextResponse.json({ error: 'OIDC authentication failed' }, { status: 400 });
  }

  if (!code || !state) {
    return NextResponse.json({ error: 'Missing code or state' }, { status: 400 });
  }

  // Validate state parameter against stored value (CSRF protection)
  const stateData = await consumeOIDCState(state);
  if (!stateData) {
    await logOidcAudit(request, AuditActions.SSO_LOGIN_FAILED, {
      reason: 'invalid_state',
    });
    log.error('Invalid or expired OIDC state parameter — possible CSRF attack');
    return NextResponse.json({ error: 'Invalid or expired state parameter' }, { status: 403 });
  }
  orgIdForAudit = stateData.orgId;

  const adminRedirect = parseAdminCallbackUrl(stateData.adminRedirect);
  const authFailure = (error: string, status: number, message: string) => {
    if (adminRedirect) {
      return NextResponse.redirect(buildAuthErrorRedirect(error, adminRedirect));
    }

    return NextResponse.json({ error: message }, { status });
  };

  try {
    // Scope SSO config lookup to the organization from the validated state
    const ssoConfig = await findSSOConfig(stateData.orgId);

    if (!ssoConfig || ssoConfig.protocol !== 'oidc' || !ssoConfig.isActive) {
      await logOidcAudit(request, AuditActions.SSO_LOGIN_FAILED, {
        reason: 'missing_or_inactive_config',
        organizationId: stateData.orgId,
      });
      return authFailure('sso_not_configured', 400, 'No OIDC config found for organization');
    }

    // Decrypt and parse OIDC configuration
    let configData: any;
    try {
      configData = await decryptSSOConfig(ssoConfig.encryptedConfig, ssoConfig.organizationId);
    } catch {
      await logOidcAudit(request, AuditActions.SSO_LOGIN_FAILED, {
        reason: 'invalid_config',
        organizationId: stateData.orgId,
      });
      return authFailure('sso_misconfigured', 400, 'Invalid OIDC configuration');
    }

    if (!configData.oidc) {
      await logOidcAudit(request, AuditActions.SSO_LOGIN_FAILED, {
        reason: 'missing_oidc_config',
        organizationId: stateData.orgId,
      });
      return authFailure('sso_misconfigured', 400, 'Invalid OIDC configuration');
    }

    const cfg = isConfigLoaded() ? getConfig() : null;
    const baseUrl =
      cfg?.server.apiUrl ||
      process.env.API_URL ||
      cfg?.server.frontendUrl ||
      process.env.FRONTEND_URL ||
      'http://localhost:5173';
    const frontendUrl =
      cfg?.server.frontendUrl || process.env.FRONTEND_URL || 'http://localhost:5173';
    const mfaCookieMaxAge = cfg?.auth.tokens.mfaCookieMaxAgeSeconds ?? 300;
    const authRequestRedirect = (errorCode: string, email: string) => {
      if (adminRedirect) {
        return NextResponse.redirect(buildAuthErrorRedirect(errorCode, adminRedirect));
      }

      const url = new URL('/auth/error', frontendUrl);
      url.searchParams.set('error', errorCode);
      url.searchParams.set('email', email);
      return NextResponse.redirect(url);
    };

    // SSRF protection: validate OIDC URLs before making outbound requests
    if (!isAllowedExternalUrl(configData.oidc.tokenUrl)) {
      log.error('OIDC tokenUrl failed SSRF validation', { url: configData.oidc.tokenUrl });
      return authFailure('sso_misconfigured', 400, 'Invalid OIDC token endpoint');
    }
    if (!isAllowedExternalUrl(configData.oidc.userInfoUrl)) {
      log.error('OIDC userInfoUrl failed SSRF validation', { url: configData.oidc.userInfoUrl });
      return authFailure('sso_misconfigured', 400, 'Invalid OIDC userinfo endpoint');
    }

    // Exchange code for tokens
    // NOTE: DNS rebinding not fully mitigated — would require pre-fetch DNS resolution
    const tokenResponse = await fetch(configData.oidc.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${baseUrl}/api/sso/oidc/callback`,
        client_id: configData.oidc.clientId,
        client_secret: configData.oidc.clientSecret,
      }),
      redirect: 'error',
    });

    if (!tokenResponse.ok) {
      await logOidcAudit(request, AuditActions.SSO_LOGIN_FAILED, {
        reason: 'token_exchange_failed',
        organizationId: stateData.orgId,
      });
      return authFailure('oidc_auth_failed', 401, 'Token exchange failed');
    }

    const tokens = await tokenResponse.json();

    // Get user info
    const userInfoResponse = await fetch(configData.oidc.userInfoUrl, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      redirect: 'error',
    });

    if (!userInfoResponse.ok) {
      await logOidcAudit(request, AuditActions.SSO_LOGIN_FAILED, {
        reason: 'userinfo_fetch_failed',
        organizationId: stateData.orgId,
      });
      return authFailure('oidc_auth_failed', 401, 'Failed to get user info');
    }

    const userInfo = await userInfoResponse.json();
    const rawEmail = userInfo.email;

    if (!rawEmail) {
      await logOidcAudit(request, AuditActions.SSO_LOGIN_FAILED, {
        reason: 'missing_email',
        organizationId: stateData.orgId,
      });
      return authFailure('oidc_auth_failed', 401, 'No email in user info');
    }

    // Normalize and validate the email from the OIDC provider
    const email = rawEmail.toLowerCase().trim();
    if (!getEmailRegex().test(email)) {
      await logOidcAudit(request, AuditActions.SSO_LOGIN_FAILED, {
        reason: 'invalid_email',
        organizationId: stateData.orgId,
      });
      return authFailure('oidc_auth_failed', 401, 'Invalid email from OIDC provider');
    }

    // Read invite token BEFORE the allow-list check so invited users on
    // non-allowlisted domains can still sign in via SSO.
    const inviteToken = request.cookies.get('oauth_invite')?.value;

    if (!(await isEmailAllowedForAuth(email, { inviteToken: inviteToken || undefined }))) {
      await logOidcAudit(request, AuditActions.SSO_LOGIN_FAILED, {
        reason: 'domain_not_allowed',
        organizationId: stateData.orgId,
      });
      return authRequestRedirect('domain_not_allowed', email);
    }

    // Find or create user — look up by email first, never reuse googleId with predictable values
    let user = await findUserByEmail(email);
    if (!user) {
      user = await createUser({
        email,
        name: userInfo.name || email.split('@')[0],
        googleId: `${SSO_OIDC_PROVIDER_PREFIX}${crypto.randomUUID()}`,
        emailVerified: true,
        authProvider: 'oidc',
      });
    } else {
      // Update last login and ensure emailVerified for existing SSO users
      user = await updateUser(user.id, {
        lastLoginAt: new Date(),
        emailVerified: true,
      });
    }

    // Resolve tenant context, auto-accepting single pending invitation
    const { tenantContext, pendingInvitationChoice } = await resolveUserContextOrAutoAcceptInvite(
      user.id,
      user.email,
    );

    const mfaStatus = await getMFAStatus(user.id);
    if (mfaStatus.enabled) {
      if (adminRedirect) {
        return NextResponse.redirect(buildAuthErrorRedirect('mfa_unsupported', adminRedirect));
      }

      const partialToken = createPartialToken(user);
      await logAuditEvent({
        userId: user.id,
        tenantId: tenantContext?.tenantId,
        action: AuditActions.LOGIN,
        ip: request.headers.get('x-forwarded-for') || undefined,
        userAgent: request.headers.get('user-agent') || undefined,
        metadata: { provider: 'oidc', mfaPending: true },
      });
      await logOidcAudit(
        request,
        AuditActions.SSO_LOGIN,
        {
          organizationId: stateData.orgId,
          resourceType: 'sso_provider',
          resourceId: stateData.orgId,
          mfaPending: true,
        },
        user.id,
        tenantContext?.tenantId,
      );

      const response = NextResponse.redirect(`${frontendUrl}/auth/mfa`);
      response.cookies.set(MFA_PARTIAL_COOKIE_NAME, partialToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: mfaCookieMaxAge,
        path: MFA_COOKIE_PATH,
      });
      response.cookies.set('oauth_invite', '', { maxAge: 0, path: '/api/auth' });
      return response;
    }

    // Issue tokens via auth service (includes role in JWT)
    const tokenPair = await createTokenPair(user, tenantContext);

    await logAuditEvent({
      userId: user.id,
      tenantId: tenantContext?.tenantId,
      action: AuditActions.LOGIN,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: { provider: 'oidc' },
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

    await logOidcAudit(
      request,
      AuditActions.SSO_LOGIN,
      {
        organizationId: stateData.orgId,
        resourceType: 'sso_provider',
        resourceId: stateData.orgId,
      },
      user.id,
      tenantContext?.tenantId,
    );

    const response = NextResponse.redirect(buildAuthCodeRedirect(authCode, adminRedirect));
    response.cookies.set('oauth_invite', '', { maxAge: 0, path: '/api/auth' });
    return response;
  } catch (error) {
    await logOidcAudit(request, AuditActions.SSO_LOGIN_FAILED, {
      reason: 'exception',
      organizationId: orgIdForAudit,
    });
    log.error('OIDC callback error', {
      err: error instanceof Error ? error.message : String(error),
    });
    if (adminRedirect) {
      return NextResponse.redirect(buildAuthErrorRedirect('oidc_auth_failed', adminRedirect));
    }

    return NextResponse.json({ error: 'OIDC authentication failed' }, { status: 401 });
  }
}

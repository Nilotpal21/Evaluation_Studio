/**
 * POST /api/sso/saml/callback - Handle SAML assertion response from IdP
 *
 * Uses @node-saml/node-saml for proper SAML validation:
 *   - XML signature verification against the IdP's X.509 certificate
 *   - Assertion timestamp checks (NotBefore / NotOnOrAfter)
 *   - Audience restriction
 *
 * Supports:
 *   - SP-initiated flow (RelayState = orgId)
 *   - IdP-initiated flow (no RelayState — resolves org from SAML issuer)
 *   - Custom attribute mapping for email/name extraction
 *   - Assertion replay protection
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { SAML } from '@node-saml/node-saml';
import { findUserByEmail, createUser, updateUser } from '@/repos/auth-repo';
import { findSSOConfig, findOrgBySAMLIssuer } from '@/repos/org-repo';
import {
  createPartialToken,
  createTokenPair,
  resolveUserContextOrAutoAcceptInvite,
} from '@/services/auth-service';
import { storeAuthCode } from '@/lib/sso-auth-codes';
import { isAssertionConsumed, markAssertionConsumed } from '@/services/sso/sso-state-store';
import { AuditActions, logAuditEvent } from '@/services/audit-service';
import { getConfig, isConfigLoaded } from '@/config';
import { getEmailRegex } from '@/lib/auth-helpers';
import { decryptSSOConfig } from '@/lib/sso-helpers';
import {
  MFA_COOKIE_PATH,
  MFA_PARTIAL_COOKIE_NAME,
  SAML_EMAIL_ATTRIBUTES,
  SAML_FIRST_NAME_ATTRIBUTES,
  SAML_LAST_NAME_ATTRIBUTES,
  SAML_ISSUER_REGEX,
  SAML_DEFAULT_ENTITY_ID,
  SSO_SAML_PROVIDER_PREFIX,
} from '@/lib/auth-constants';
import { isEmailAllowedForAuth, isPlatformAdminUser } from '@/lib/platform-auth-policy';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { getMFAStatus } from '@/services/auth/mfa-service';
import {
  buildAuthCodeRedirect,
  buildAuthErrorRedirect,
  decodeSamlRelayState,
  parseAdminCallbackUrl,
} from '@/lib/admin-auth-handoff';

const log = createLogger('auth-sso');

/**
 * Extract email from SAML profile using configurable attribute list.
 */
function extractEmail(profile: any, emailAttributes?: string[]): string | null {
  // Try nameID and standard email field first
  if (profile?.email && typeof profile.email === 'string') return profile.email;
  if (
    profile?.nameID &&
    typeof profile.nameID === 'string' &&
    getEmailRegex().test(profile.nameID.toLowerCase().trim())
  ) {
    return profile.nameID;
  }

  // Try configurable attribute list
  const attrs = emailAttributes || SAML_EMAIL_ATTRIBUTES;
  for (const attr of attrs) {
    const val = profile?.[attr];
    if (val && typeof val === 'string' && getEmailRegex().test(val.toLowerCase().trim())) {
      return val;
    }
  }

  return null;
}

/**
 * Extract display name from SAML profile attributes.
 */
function extractDisplayName(
  profile: any,
  nameAttributes?: { firstName?: string; lastName?: string },
): string | null {
  const firstNameAttrs = nameAttributes?.firstName
    ? [nameAttributes.firstName, ...SAML_FIRST_NAME_ATTRIBUTES]
    : SAML_FIRST_NAME_ATTRIBUTES;
  const lastNameAttrs = nameAttributes?.lastName
    ? [nameAttributes.lastName, ...SAML_LAST_NAME_ATTRIBUTES]
    : SAML_LAST_NAME_ATTRIBUTES;

  let firstName: string | null = null;
  let lastName: string | null = null;

  for (const attr of firstNameAttrs) {
    const val = profile?.[attr];
    if (val && typeof val === 'string') {
      firstName = val;
      break;
    }
  }

  for (const attr of lastNameAttrs) {
    const val = profile?.[attr];
    if (val && typeof val === 'string') {
      lastName = val;
      break;
    }
  }

  const parts = [firstName, lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

async function logSamlAudit(
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
      provider: 'saml',
      ...metadata,
    },
  });
}

export async function POST(request: NextRequest) {
  let adminRedirect: URL | null = null;
  let orgIdForAudit: string | undefined;
  try {
    const formData = await request.formData();
    const samlResponse = formData.get('SAMLResponse') as string;
    const relayState = formData.get('RelayState') as string | null;
    const relayStateData = decodeSamlRelayState(relayState);
    adminRedirect = parseAdminCallbackUrl(relayStateData?.adminRedirect);
    const authFailure = (error: string, status: number, message: string) => {
      if (adminRedirect) {
        return NextResponse.redirect(buildAuthErrorRedirect(error, adminRedirect));
      }

      return NextResponse.json({ error: message }, { status });
    };

    if (!samlResponse) {
      return authFailure('saml_auth_failed', 400, 'Missing SAML response');
    }

    // ── Resolve organization ID ──────────────────────────────────────────
    // SP-initiated: RelayState carries the orgId
    // IdP-initiated: no RelayState — resolve org from SAML assertion issuer
    let orgId = relayStateData?.orgId || null;

    // For IdP-initiated flows, we need to do a preliminary decode to get the issuer
    // before we can look up the SSO config. We'll validate properly after config lookup.
    if (!orgId) {
      try {
        // Decode the SAML response to extract the issuer (base64 → XML → parse issuer)
        const xml = Buffer.from(samlResponse, 'base64').toString('utf-8');
        const issuerMatch = xml.match(SAML_ISSUER_REGEX);
        const issuer = issuerMatch?.[1]?.trim();

        if (issuer) {
          const org = await findOrgBySAMLIssuer(issuer);
          if (org) orgId = org.id;
        }
      } catch (parseErr) {
        console.warn('[SSO] SAML: Failed to extract issuer for IdP-initiated flow:', parseErr);
      }
    }

    if (!orgId) {
      return authFailure('saml_auth_failed', 400, 'Cannot determine organization for SAML login');
    }
    orgIdForAudit = orgId;

    const ssoConfig = await findSSOConfig(orgId);

    if (!ssoConfig || ssoConfig.protocol !== 'saml' || !ssoConfig.isActive) {
      return authFailure('sso_not_configured', 400, 'No SAML config for organization');
    }

    // Decrypt and parse SAML configuration
    let configData: any;
    try {
      configData = await decryptSSOConfig(ssoConfig.encryptedConfig, ssoConfig.organizationId);
    } catch {
      return authFailure('sso_misconfigured', 400, 'Invalid SAML configuration');
    }

    // Validate the SAML config has a certificate for signature verification
    if (!configData.saml?.certificate) {
      log.error('SAML config missing certificate — cannot verify assertion signature');
      return authFailure(
        'sso_misconfigured',
        501,
        'SAML signature validation requires a certificate. Contact your administrator.',
      );
    }

    // Determine ACS callback URL
    const frontendUrlBase =
      (isConfigLoaded() ? getConfig().server.frontendUrl : null) ||
      process.env.FRONTEND_URL ||
      'http://localhost:5173';
    const callbackUrl = configData.saml.callbackUrl || `${frontendUrlBase}/api/sso/saml/callback`;
    const authRequestRedirect = (errorCode: string, email: string) => {
      if (adminRedirect) {
        return NextResponse.redirect(buildAuthErrorRedirect(errorCode, adminRedirect));
      }

      const url = new URL('/auth/error', frontendUrlBase);
      url.searchParams.set('error', errorCode);
      url.searchParams.set('email', email);
      return NextResponse.redirect(url);
    };

    // Validate SAML response using @node-saml (signature, timestamps, audience)
    const saml = new SAML({
      idpCert: configData.saml.certificate,
      issuer: configData.saml.entityId || SAML_DEFAULT_ENTITY_ID,
      callbackUrl,
      wantAssertionsSigned: true,
    });

    let profile: any;
    try {
      const result = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse });
      profile = result.profile ?? null;
    } catch (samlError) {
      log.error('SAML validation failed', {
        err: samlError instanceof Error ? samlError.message : String(samlError),
      });
      return authFailure(
        'saml_auth_failed',
        401,
        'SAML assertion validation failed — signature, timestamps, or audience mismatch',
      );
    }

    // ── Replay protection ────────────────────────────────────────────────
    const assertionId = profile?.sessionIndex || profile?.inResponseTo;
    if (assertionId) {
      const alreadyUsed = await isAssertionConsumed(assertionId);
      if (alreadyUsed) {
        await logSamlAudit(request, AuditActions.SSO_ASSERTION_REPLAY_DETECTED, {
          organizationId: orgId,
          assertionId,
        });
        return authFailure('saml_auth_failed', 400, 'SAML assertion already used');
      }
      const assertionTtl = isConfigLoaded() ? getConfig().auth.sso.samlAssertionTtlSeconds : 3600;
      await markAssertionConsumed(assertionId, assertionTtl);
    }

    // ── Extract email using custom attribute mapping ─────────────────────
    const emailAttributes = configData.saml.emailAttributes || undefined;
    const rawEmail = extractEmail(profile, emailAttributes);

    if (!rawEmail) {
      await logSamlAudit(request, AuditActions.SSO_LOGIN_FAILED, {
        reason: 'missing_email',
        organizationId: orgId,
      });
      return authFailure(
        'saml_auth_failed',
        400,
        'Could not extract user identity from SAML response',
      );
    }

    // Normalize and validate the extracted email
    const email = rawEmail.toLowerCase().trim();
    if (!getEmailRegex().test(email)) {
      await logSamlAudit(request, AuditActions.SSO_LOGIN_FAILED, {
        reason: 'invalid_email',
        organizationId: orgId,
      });
      return authFailure('saml_auth_failed', 400, 'Invalid email in SAML response');
    }

    // Read invite token BEFORE the allow-list check so invited users on
    // non-allowlisted domains can still sign in via SSO.
    const inviteToken = request.cookies.get('oauth_invite')?.value;

    if (!(await isEmailAllowedForAuth(email, { inviteToken: inviteToken || undefined }))) {
      await logSamlAudit(request, AuditActions.SSO_LOGIN_FAILED, {
        reason: 'domain_not_allowed',
        organizationId: orgId,
      });
      return authRequestRedirect('domain_not_allowed', email);
    }

    // ── Extract display name from SAML attributes ────────────────────────
    const nameAttributes = configData.saml.nameAttributes || undefined;
    const displayName = extractDisplayName(profile, nameAttributes) || email.split('@')[0];

    // Find or create user
    let user = await findUserByEmail(email);
    if (!user) {
      user = await createUser({
        email,
        name: displayName,
        googleId: `${SSO_SAML_PROVIDER_PREFIX}${crypto.randomUUID()}`,
        emailVerified: true,
        authProvider: 'saml',
      });
    } else {
      // Update last login, name (if we got better data), and ensure emailVerified
      user = await updateUser(user.id, {
        lastLoginAt: new Date(),
        emailVerified: true,
        name: displayName !== email.split('@')[0] ? displayName : user.name,
      });
    }

    // Resolve tenant context, auto-accepting single pending invitation
    const { tenantContext, pendingInvitationChoice } = await resolveUserContextOrAutoAcceptInvite(
      user.id,
      user.email,
    );

    const mfaCookieMaxAge = isConfigLoaded() ? getConfig().auth.tokens.mfaCookieMaxAgeSeconds : 300;
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
        metadata: { provider: 'saml', mfaPending: true },
      });
      await logSamlAudit(
        request,
        AuditActions.SSO_LOGIN,
        {
          organizationId: orgId,
          resourceType: 'sso_provider',
          resourceId: orgId,
          mfaPending: true,
        },
        user.id,
        tenantContext?.tenantId,
      );

      const response = NextResponse.redirect(`${frontendUrlBase}/auth/mfa`);
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
      metadata: { provider: 'saml' },
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

    await logSamlAudit(
      request,
      AuditActions.SSO_LOGIN,
      {
        organizationId: orgId,
        resourceType: 'sso_provider',
        resourceId: orgId,
      },
      user.id,
      tenantContext?.tenantId,
    );

    const response = NextResponse.redirect(buildAuthCodeRedirect(authCode, adminRedirect));
    response.cookies.set('oauth_invite', '', { maxAge: 0, path: '/api/auth' });
    return response;
  } catch (error) {
    await logSamlAudit(request, AuditActions.SSO_LOGIN_FAILED, {
      reason: 'exception',
      organizationId: orgIdForAudit,
    });
    log.error('SAML callback error', {
      err: error instanceof Error ? error.message : String(error),
    });
    if (adminRedirect) {
      return NextResponse.redirect(buildAuthErrorRedirect('saml_auth_failed', adminRedirect));
    }
    return NextResponse.json({ error: 'SAML authentication failed' }, { status: 401 });
  }
}

/**
 * GET /api/sso/init - Determine SSO flow based on email domain
 */

import { NextRequest, NextResponse } from 'next/server';
import { findDomainMapping, findSSOConfig } from '@/repos/org-repo';
import { getConfig, isConfigLoaded } from '@/config';
import { storeOIDCState } from '@/lib/sso-state-store';
import { decryptSSOConfig } from '@/lib/sso-helpers';
import {
  buildAuthErrorRedirect,
  encodeSamlRelayState,
  parseAdminCallbackUrl,
} from '@/lib/admin-auth-handoff';
import type { SSOConfigData } from '@/services/sso/sso-types';

export async function GET(request: NextRequest) {
  const email = request.nextUrl.searchParams.get('email');
  const mode = request.nextUrl.searchParams.get('mode');
  const redirectMode = mode === 'redirect';
  const adminRedirectParam = request.nextUrl.searchParams.get('admin_redirect');
  const adminRedirect = parseAdminCallbackUrl(adminRedirectParam);

  if (adminRedirectParam && !adminRedirect) {
    return NextResponse.json({ error: 'Invalid admin redirect URL' }, { status: 400 });
  }

  const redirectError = (error: string, status: number, body: Record<string, unknown>) => {
    if (redirectMode) {
      return NextResponse.redirect(buildAuthErrorRedirect(error, adminRedirect));
    }

    return NextResponse.json(body, { status });
  };

  if (!email || !email.includes('@')) {
    return redirectError('invalid_email', 400, { error: 'Valid email required' });
  }

  try {
    const domain = email.split('@')[1].toLowerCase();

    // Look up domain → org mapping
    const domainMapping = await findDomainMapping(domain);

    if (!domainMapping || !domainMapping.verified) {
      return redirectError('sso_not_configured', 200, {
        ssoEnabled: false,
        message: 'No SSO configured for this domain.',
      });
    }

    // Find active SSO config for the organization
    const ssoConfig = await findSSOConfig(domainMapping.organizationId);

    if (!ssoConfig || !ssoConfig.isActive) {
      return redirectError('sso_not_configured', 200, {
        ssoEnabled: false,
        message: 'No SSO configured for this domain.',
      });
    }

    const orgId = ssoConfig.organizationId;
    const cfg = isConfigLoaded() ? getConfig() : null;
    const baseUrl =
      cfg?.server.apiUrl ||
      process.env.API_URL ||
      cfg?.server.frontendUrl ||
      process.env.FRONTEND_URL ||
      'http://localhost:5173';

    if (ssoConfig.protocol === 'saml') {
      // For SAML, decrypt config and generate AuthnRequest URL
      let configData: SSOConfigData;
      try {
        configData = (await decryptSSOConfig(ssoConfig.encryptedConfig, orgId)) as SSOConfigData;
      } catch {
        return redirectError('sso_misconfigured', 200, {
          ssoEnabled: false,
          message: 'SSO misconfigured.',
        });
      }

      const samlConfig = configData.saml;
      if (!samlConfig?.ssoUrl) {
        return redirectError('sso_misconfigured', 200, {
          ssoEnabled: false,
          message: 'SSO misconfigured.',
        });
      }

      // Build redirect to SAML IdP
      const redirectUrl = new URL(samlConfig.ssoUrl);

      if (redirectMode) {
        if (adminRedirect) {
          redirectUrl.searchParams.set(
            'RelayState',
            encodeSamlRelayState({ orgId, adminRedirect: adminRedirect.toString() }),
          );
        }

        return NextResponse.redirect(redirectUrl);
      }

      return NextResponse.json({ ssoEnabled: true, protocol: 'saml', redirectUrl });
    } else if (ssoConfig.protocol === 'oidc') {
      let configData: SSOConfigData;
      try {
        configData = (await decryptSSOConfig(ssoConfig.encryptedConfig, orgId)) as SSOConfigData;
      } catch {
        return redirectError('sso_misconfigured', 200, {
          ssoEnabled: false,
          message: 'SSO misconfigured.',
        });
      }

      const oidcConfig = configData.oidc;
      if (!oidcConfig?.authorizationUrl || !oidcConfig.clientId) {
        return redirectError('sso_misconfigured', 200, {
          ssoEnabled: false,
          message: 'SSO misconfigured.',
        });
      }

      // Generate and store state parameter for CSRF protection
      const state = crypto.randomUUID();
      try {
        await storeOIDCState(
          state,
          orgId,
          redirectMode && adminRedirect ? adminRedirect.toString() : undefined,
        );
      } catch (stateErr) {
        console.error('[SSO] Failed to store OIDC state:', stateErr);
        return redirectError('sso_unavailable', 503, {
          error: 'SSO service temporarily unavailable',
        });
      }

      const redirectUrl = new URL(oidcConfig.authorizationUrl);
      redirectUrl.searchParams.set('client_id', oidcConfig.clientId);
      redirectUrl.searchParams.set('redirect_uri', `${baseUrl}/api/sso/oidc/callback`);
      redirectUrl.searchParams.set('response_type', 'code');
      redirectUrl.searchParams.set(
        'scope',
        (oidcConfig.scopes || ['openid', 'email', 'profile']).join(' '),
      );
      redirectUrl.searchParams.set('state', state);

      if (redirectMode) {
        return NextResponse.redirect(redirectUrl);
      }

      return NextResponse.json({
        ssoEnabled: true,
        protocol: 'oidc',
        redirectUrl: redirectUrl.toString(),
      });
    }

    return redirectError('sso_misconfigured', 200, {
      ssoEnabled: false,
      message: 'SSO misconfigured.',
    });
  } catch (error) {
    console.error('[SSO] Init error:', error);
    return redirectError('sso_unavailable', 500, { error: 'Internal server error' });
  }
}

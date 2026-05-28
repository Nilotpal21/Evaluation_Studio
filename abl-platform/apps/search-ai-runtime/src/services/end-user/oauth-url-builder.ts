/**
 * OAuth URL Builder
 *
 * Derives authorization and token URLs from auth profile config.
 * Supports azure_ad (Microsoft Entra ID) and oauth2_app (generic OIDC).
 *
 * Also handles token exchange (authorization code → tokens).
 */

import { createLogger } from '@abl/compiler/platform';
import type { IAuthProfile } from '@agent-platform/database/models';

const logger = createLogger('oauth-url-builder');

// ─── Types ──────────────────────────────────────────────────────────────

export interface OAuthUrls {
  authorizationUrl: string;
  tokenUrl: string;
}

export interface TokenExchangeResult {
  id_token: string;
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

// ─── URL Derivation ─────────────────────────────────────────────────────

/**
 * Derive authorization and token URLs from auth profile config.
 *
 * azure_ad:
 *   authorizationUrl: https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/authorize
 *   tokenUrl:         https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token
 *
 * oauth2_app:
 *   authorizationUrl: config.authorizationUrl (stored on profile)
 *   tokenUrl:         config.tokenUrl (stored on profile)
 */
export function buildOAuthUrls(profile: IAuthProfile): OAuthUrls {
  const config = profile.config as Record<string, unknown>;

  switch (profile.authType) {
    case 'azure_ad': {
      const azureTenantId = config.tenantId as string;
      if (!azureTenantId) {
        throw new Error('Azure AD profile missing tenantId in config');
      }
      const endpoint = ((config.endpoint as string) || 'https://login.microsoftonline.com').replace(
        /\/$/,
        '',
      );
      return {
        authorizationUrl: `${endpoint}/${azureTenantId}/oauth2/v2.0/authorize`,
        tokenUrl: `${endpoint}/${azureTenantId}/oauth2/v2.0/token`,
      };
    }

    case 'oauth2_app': {
      const authorizationUrl = config.authorizationUrl as string;
      const tokenUrl = config.tokenUrl as string;
      if (!authorizationUrl || !tokenUrl) {
        throw new Error('OAuth2 App profile missing authorizationUrl or tokenUrl');
      }
      return { authorizationUrl, tokenUrl };
    }

    default:
      throw new Error(`Auth type "${profile.authType}" does not support Path B (OAuth redirect)`);
  }
}

// ─── Token Exchange ─────────────────────────────────────────────────────

/**
 * Exchange authorization code for tokens at the IdP token endpoint.
 *
 * Sends a POST with form-encoded body per OAuth 2.0 spec.
 * Uses PKCE (code_verifier) for public client security.
 */
export async function exchangeCodeForTokens(params: {
  tokenUrl: string;
  code: string;
  clientId: string;
  clientSecret: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TokenExchangeResult> {
  const { tokenUrl, code, clientId, clientSecret, codeVerifier, redirectUri } = params;

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  });

  logger.debug('Exchanging authorization code for tokens', {
    tokenUrl,
    redirectUri,
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    logger.error('Token exchange failed', {
      tokenUrl,
      status: response.status,
      body: errorBody.slice(0, 500), // Truncate for logging
    });
    throw new Error(`Token exchange failed: ${response.status} ${response.statusText}`);
  }

  const tokenResponse = (await response.json()) as Record<string, unknown>;

  const idToken = tokenResponse.id_token as string | undefined;
  if (!idToken) {
    throw new Error('Token exchange response missing id_token');
  }

  return {
    id_token: idToken,
    access_token: tokenResponse.access_token as string | undefined,
    token_type: tokenResponse.token_type as string | undefined,
    expires_in: tokenResponse.expires_in as number | undefined,
  };
}

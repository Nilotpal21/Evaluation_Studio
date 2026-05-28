/**
 * OIDC Service
 *
 * Discovery doc caching, authorization code + PKCE flow,
 * ID token validation, UserInfo endpoint.
 */

import crypto from 'crypto';
import type { OIDCConfig, SSOUser } from './sso-types';
import { AppError, ErrorCodes } from '@agent-platform/shared/errors';

// Discovery document cache (per issuer)
const discoveryCache = new Map<string, { data: any; expiresAt: number }>();

/**
 * Generate PKCE code verifier and challenge (S256).
 */
export function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto
    .randomBytes(32)
    .toString('base64url')
    .replace(/[^a-zA-Z0-9\-._~]/g, '')
    .slice(0, 128);

  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

  return { codeVerifier, codeChallenge };
}

/**
 * Generate a random nonce for OIDC.
 */
export function generateNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Generate the OIDC authorization URL for redirect.
 */
export function generateAuthorizationUrl(
  config: OIDCConfig,
  redirectUri: string,
  state: string,
  nonce: string,
  codeChallenge: string,
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: config.scopes.join(' '),
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return `${config.authorizationUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens.
 */
export async function exchangeCodeForTokens(
  config: OIDCConfig,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<{ idToken: string; accessToken: string }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code_verifier: codeVerifier,
  });

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new AppError(`Token exchange failed: ${error}`, { ...ErrorCodes.SERVICE_UNAVAILABLE });
  }

  const data = (await response.json()) as any;
  return {
    idToken: data.id_token,
    accessToken: data.access_token,
  };
}

/**
 * Validate an OIDC ID token (basic validation).
 *
 * In production, use openid-client for full validation:
 * - JWK signature verification via JWKS endpoint
 * - Issuer, audience, expiration checks
 * - Nonce validation
 */
export function validateIdToken(
  idToken: string,
  config: OIDCConfig,
  expectedNonce: string,
): SSOUser {
  // Decode JWT payload (no signature verification — use openid-client in production)
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new AppError('Invalid ID token format', { ...ErrorCodes.BAD_REQUEST });
  }

  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));

  // Basic validations
  if (payload.iss !== config.issuer) {
    throw new AppError(`Invalid issuer: expected ${config.issuer}, got ${payload.iss}`, {
      ...ErrorCodes.FORBIDDEN,
    });
  }

  if (payload.aud !== config.clientId && !payload.aud?.includes?.(config.clientId)) {
    throw new AppError('Invalid audience', { ...ErrorCodes.FORBIDDEN });
  }

  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new AppError('ID token expired', { ...ErrorCodes.FORBIDDEN });
  }

  if (expectedNonce && payload.nonce !== expectedNonce) {
    throw new AppError('Invalid nonce', { ...ErrorCodes.FORBIDDEN });
  }

  if (!payload.email) {
    throw new AppError('No email claim in ID token', { ...ErrorCodes.BAD_REQUEST });
  }

  return {
    email: payload.email,
    name: payload.name,
    externalId: payload.sub,
    provider: 'oidc',
  };
}

/**
 * Fetch user info from the UserInfo endpoint.
 */
export async function fetchUserInfo(config: OIDCConfig, accessToken: string): Promise<SSOUser> {
  const response = await fetch(config.userInfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new AppError(`UserInfo fetch failed: ${response.status}`, {
      ...ErrorCodes.SERVICE_UNAVAILABLE,
    });
  }

  const data = (await response.json()) as any;

  return {
    email: data.email,
    name: data.name,
    externalId: data.sub,
    provider: 'oidc',
  };
}

/**
 * Fetch and cache OIDC discovery document.
 */
export async function getDiscoveryDocument(issuer: string): Promise<any> {
  const cached = discoveryCache.get(issuer);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new AppError(`Discovery document fetch failed: ${response.status}`, {
      ...ErrorCodes.SERVICE_UNAVAILABLE,
    });
  }

  const data = await response.json();
  discoveryCache.set(issuer, {
    data,
    expiresAt: Date.now() + 3600_000, // Cache for 1 hour
  });

  return data;
}

/**
 * Configurable OAuth 2.0 Provider Adapter
 *
 * Generic implementation of OAuthProviderAdapter that works with any standard
 * OAuth 2.0 provider. Configuration is passed via constructor — authorization
 * endpoint, token endpoint, userinfo endpoint, client credentials, and redirect URI.
 *
 * Implements:
 *   createAuthorizationURL  — builds standard OAuth 2.0 authorization URL with PKCE
 *   validateAuthorizationCode — exchanges code for tokens at the token endpoint
 *   fetchUserEmail — retrieves the user's email from the userinfo endpoint
 */

import { createHash } from 'node:crypto';
import type { OAuthProviderAdapter } from './oauth-verifier.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

export interface OAuthProviderConfig {
  /** OAuth 2.0 authorization endpoint URL */
  readonly authorizationEndpoint: string;
  /** OAuth 2.0 token endpoint URL */
  readonly tokenEndpoint: string;
  /** OpenID Connect / OAuth userinfo endpoint URL */
  readonly userinfoEndpoint: string;
  /** OAuth client ID */
  readonly clientId: string;
  /** OAuth client secret */
  readonly clientSecret: string;
  /** Redirect URI registered with the provider */
  readonly redirectUri: string;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class ConfigurableOAuthProviderAdapter implements OAuthProviderAdapter {
  constructor(private readonly config: OAuthProviderConfig) {}

  /**
   * Build the OAuth 2.0 authorization URL with PKCE (S256 code challenge).
   */
  createAuthorizationURL(state: string, codeVerifier: string): URL {
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    const url = new URL(this.config.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('scope', 'openid email');

    return url;
  }

  /**
   * Exchange the authorization code for tokens using the token endpoint.
   */
  async validateAuthorizationCode(
    code: string,
    codeVerifier: string,
  ): Promise<{ accessToken: string }> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code_verifier: codeVerifier,
    });

    const response = await fetch(this.config.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new Error(`Token exchange failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { access_token?: string };
    if (!data.access_token) {
      throw new Error('Token response missing access_token');
    }

    return { accessToken: data.access_token };
  }

  /**
   * Fetch the user's verified email from the userinfo endpoint.
   */
  async fetchUserEmail(accessToken: string): Promise<string> {
    const response = await fetch(this.config.userinfoEndpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error(`Userinfo request failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { email?: string };
    if (!data.email) {
      throw new Error('Userinfo response missing email field');
    }

    return data.email;
  }
}

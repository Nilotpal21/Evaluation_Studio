/**
 * OAuth Provider Adapters (Arctic v3)
 *
 * Concrete implementations of OAuthProviderAdapter for Google, Microsoft, and GitHub.
 * Each wraps an Arctic v3 provider class and normalises its API to the port interface.
 *
 * Provider quirks handled:
 *   - Google & Microsoft support PKCE (code verifier in createAuthorizationURL + validateAuthorizationCode)
 *   - GitHub does NOT support PKCE — codeVerifier is ignored in both methods
 *   - Microsoft requires a `tenant` parameter (defaults to "common" for multi-tenant apps)
 *   - GitHub /user/emails returns an array — we filter to the primary, verified email
 *   - OAuth2Tokens.accessToken() is a method in Arctic v3, not a property
 */

import { Google, MicrosoftEntraId, GitHub } from 'arctic';
import { createLogger } from '@abl/compiler/platform';
import type { OAuthProviderAdapter } from './oauth-verifier.js';

const log = createLogger('oauth-adapters');

// =============================================================================
// ARCTIC PROVIDER INTERFACE — enables DI for testing without vi.mock()
// =============================================================================

/** Minimal interface matching Arctic v3 provider methods used by our adapters. */
export interface ArcticLikeProvider {
  createAuthorizationURL(...args: unknown[]): URL;
  validateAuthorizationCode(...args: unknown[]): Promise<{ accessToken(): string }>;
}

// =============================================================================
// GOOGLE
// =============================================================================

const GOOGLE_SCOPES = ['openid', 'email', 'profile'];
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

export class GoogleOAuthAdapter implements OAuthProviderAdapter {
  private readonly arctic: ArcticLikeProvider;

  constructor(clientId: string, clientSecret: string, redirectUri: string);
  constructor(provider: ArcticLikeProvider);
  constructor(
    clientIdOrProvider: string | ArcticLikeProvider,
    clientSecret?: string,
    redirectUri?: string,
  ) {
    if (typeof clientIdOrProvider === 'string') {
      this.arctic = new Google(clientIdOrProvider, clientSecret!, redirectUri!);
    } else {
      this.arctic = clientIdOrProvider;
    }
  }

  createAuthorizationURL(state: string, codeVerifier: string): URL {
    return this.arctic.createAuthorizationURL(state, codeVerifier, GOOGLE_SCOPES);
  }

  async validateAuthorizationCode(
    code: string,
    codeVerifier: string,
  ): Promise<{ accessToken: string }> {
    const tokens = await this.arctic.validateAuthorizationCode(code, codeVerifier);
    return { accessToken: tokens.accessToken() };
  }

  async fetchUserEmail(accessToken: string): Promise<string> {
    const start = Date.now();
    log.info('Fetching Google userinfo', { endpoint: GOOGLE_USERINFO_URL });
    try {
      const res = await fetch(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        throw new Error(`Google userinfo returned ${res.status}`);
      }
      const data = (await res.json()) as { email?: string };
      if (!data.email) {
        throw new Error('Google userinfo response missing email field');
      }
      log.info('Google userinfo fetched', { latencyMs: Date.now() - start });
      return data.email;
    } catch (err) {
      log.error('Google userinfo fetch failed', {
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

// =============================================================================
// MICROSOFT
// =============================================================================

const MICROSOFT_SCOPES = ['openid', 'email', 'profile'];
const MICROSOFT_GRAPH_ME_URL = 'https://graph.microsoft.com/v1.0/me';

export class MicrosoftOAuthAdapter implements OAuthProviderAdapter {
  private readonly arctic: ArcticLikeProvider;

  constructor(tenant: string, clientId: string, clientSecret: string, redirectUri: string);
  constructor(provider: ArcticLikeProvider);
  constructor(
    tenantOrProvider: string | ArcticLikeProvider,
    clientId?: string,
    clientSecret?: string,
    redirectUri?: string,
  ) {
    if (typeof tenantOrProvider === 'string') {
      this.arctic = new MicrosoftEntraId(tenantOrProvider, clientId!, clientSecret!, redirectUri!);
    } else {
      this.arctic = tenantOrProvider;
    }
  }

  createAuthorizationURL(state: string, codeVerifier: string): URL {
    return this.arctic.createAuthorizationURL(state, codeVerifier, MICROSOFT_SCOPES);
  }

  async validateAuthorizationCode(
    code: string,
    codeVerifier: string,
  ): Promise<{ accessToken: string }> {
    const tokens = await this.arctic.validateAuthorizationCode(code, codeVerifier);
    return { accessToken: tokens.accessToken() };
  }

  async fetchUserEmail(accessToken: string): Promise<string> {
    const start = Date.now();
    log.info('Fetching Microsoft Graph /me', { endpoint: MICROSOFT_GRAPH_ME_URL });
    try {
      const res = await fetch(MICROSOFT_GRAPH_ME_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        throw new Error(`Microsoft Graph /me returned ${res.status}`);
      }
      const data = (await res.json()) as { mail?: string; userPrincipalName?: string };
      const email = data.mail ?? data.userPrincipalName;
      if (!email) {
        throw new Error('Microsoft Graph /me response missing mail and userPrincipalName');
      }
      log.info('Microsoft userinfo fetched', { latencyMs: Date.now() - start });
      return email;
    } catch (err) {
      log.error('Microsoft userinfo fetch failed', {
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

// =============================================================================
// GITHUB
// =============================================================================

const GITHUB_SCOPES = ['user:email'];
const GITHUB_USER_EMAILS_URL = 'https://api.github.com/user/emails';

/**
 * Shape of a single entry in the GitHub /user/emails response.
 * We filter to the primary, verified email.
 */
interface GitHubEmailEntry {
  email: string;
  primary: boolean;
  verified: boolean;
}

export class GitHubOAuthAdapter implements OAuthProviderAdapter {
  private readonly arctic: ArcticLikeProvider;

  constructor(clientId: string, clientSecret: string, redirectUri: string);
  constructor(provider: ArcticLikeProvider);
  constructor(
    clientIdOrProvider: string | ArcticLikeProvider,
    clientSecret?: string,
    redirectUri?: string,
  ) {
    if (typeof clientIdOrProvider === 'string') {
      this.arctic = new GitHub(clientIdOrProvider, clientSecret!, redirectUri!);
    } else {
      this.arctic = clientIdOrProvider;
    }
  }

  /**
   * GitHub does not support PKCE — the codeVerifier parameter is accepted
   * by the OAuthProviderAdapter interface but ignored here.
   */
  createAuthorizationURL(state: string, _codeVerifier: string): URL {
    return this.arctic.createAuthorizationURL(state, GITHUB_SCOPES);
  }

  /**
   * GitHub does not use PKCE — the codeVerifier parameter is accepted
   * by the OAuthProviderAdapter interface but ignored here.
   */
  async validateAuthorizationCode(
    code: string,
    _codeVerifier: string,
  ): Promise<{ accessToken: string }> {
    const tokens = await this.arctic.validateAuthorizationCode(code);
    return { accessToken: tokens.accessToken() };
  }

  async fetchUserEmail(accessToken: string): Promise<string> {
    const start = Date.now();
    log.info('Fetching GitHub user emails', { endpoint: GITHUB_USER_EMAILS_URL });
    try {
      const res = await fetch(GITHUB_USER_EMAILS_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'abl-platform-runtime',
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        throw new Error(`GitHub /user/emails returned ${res.status}`);
      }
      const emails = (await res.json()) as GitHubEmailEntry[];
      const primary = emails.find((e) => e.primary && e.verified);
      if (!primary) {
        throw new Error('No primary verified email found in GitHub account');
      }
      log.info('GitHub userinfo fetched', { latencyMs: Date.now() - start });
      return primary.email;
    } catch (err) {
      log.error('GitHub userinfo fetch failed', {
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

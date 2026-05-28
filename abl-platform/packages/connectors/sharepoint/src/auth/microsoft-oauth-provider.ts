/**
 * Microsoft OAuth Provider
 *
 * Implements OAuth 2.0 Device Code Flow for Microsoft Azure AD / Entra ID.
 * Used by SharePoint connector for authentication.
 */

import type {
  IOAuthProvider,
  DeviceCodeResponse,
  AuthorizationCodeRequest,
  AuthorizationCodeExchange,
  OAuthTokens,
  TokenRefreshResult,
} from '@agent-platform/connectors-base';

// ─── Configuration ───────────────────────────────────────────────────────

export interface MicrosoftOAuthConfig {
  /** Azure AD client ID */
  clientId: string;
  /** Azure AD tenant ID (or 'common' for multi-tenant) */
  tenantId?: string;
  /** Authority URL (optional, defaults to login.microsoftonline.com) */
  authority?: string;
}

// ─── Microsoft OAuth Provider ────────────────────────────────────────────

export class MicrosoftOAuthProvider implements IOAuthProvider {
  readonly providerName = 'microsoft_sharepoint';
  readonly clientId: string;
  private readonly tenantId: string;
  private readonly authority: string;

  constructor(config: MicrosoftOAuthConfig) {
    this.clientId = config.clientId;
    this.tenantId = config.tenantId || 'common';
    this.authority = config.authority || 'https://login.microsoftonline.com';
  }

  /**
   * Request device code from Microsoft.
   */
  async requestDeviceCode(scopes: string[]): Promise<DeviceCodeResponse> {
    const url = `${this.authority}/${this.tenantId}/oauth2/v2.0/devicecode`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: this.clientId,
        scope: scopes.join(' '),
      }),
    });

    if (!response.ok) {
      const error: any = await response.json();
      throw new Error(`Failed to request device code: ${error.error_description || error.error}`);
    }

    const data: any = await response.json();

    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      verificationUriComplete: data.verification_uri_complete,
      interval: data.interval || 5,
      expiresIn: data.expires_in,
    };
  }

  /**
   * Exchange device code for access token.
   */
  async exchangeDeviceCode(deviceCode: string): Promise<OAuthTokens> {
    const url = `${this.authority}/${this.tenantId}/oauth2/v2.0/token`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: this.clientId,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
      }),
    });

    const data: any = await response.json();

    // Handle polling errors
    if (data.error) {
      const error: any = new Error(data.error_description || data.error);
      error.code = data.error;
      throw error;
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null,
      tokenType: data.token_type,
      expiresIn: data.expires_in,
      scope: data.scope,
      providerUserId: data.id_token ? this.extractUserIdFromIdToken(data.id_token) : undefined,
    };
  }

  // ─── Authorization Code Flow ──────────────────────────────────────────

  /**
   * Build the Microsoft authorization URL for the Authorization Code flow.
   */
  getAuthorizationUrl(request: AuthorizationCodeRequest): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: request.redirectUri,
      scope: request.scopes.join(' '),
      state: request.state,
      response_mode: 'query',
    });
    return `${this.authority}/${this.tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
  }

  /**
   * Exchange an authorization code for tokens (confidential client flow).
   */
  async exchangeAuthorizationCode(exchange: AuthorizationCodeExchange): Promise<OAuthTokens> {
    const url = `${this.authority}/${this.tenantId}/oauth2/v2.0/token`;

    const params: Record<string, string> = {
      client_id: this.clientId,
      grant_type: 'authorization_code',
      code: exchange.code,
      redirect_uri: exchange.redirectUri,
    };
    // Only include client_secret for confidential clients (not required for public clients)
    if (exchange.clientSecret) {
      params.client_secret = exchange.clientSecret;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });

    if (!response.ok) {
      const error: any = await response.json();
      throw new Error(
        `Failed to exchange authorization code: ${error.error_description || error.error}`,
      );
    }

    const data: any = await response.json();

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null,
      tokenType: data.token_type,
      expiresIn: data.expires_in,
      scope: data.scope,
      providerUserId: data.id_token ? this.extractUserIdFromIdToken(data.id_token) : undefined,
    };
  }

  // ─── Client Credentials Flow ────────────────────────────────────────────

  /**
   * Acquire an app-only token using client credentials.
   * For Microsoft, scopes must use the /.default suffix (e.g., https://graph.microsoft.com/.default).
   */
  async acquireClientCredentialsToken(
    scopes: string[],
    clientSecret: string,
  ): Promise<OAuthTokens> {
    const url = `${this.authority}/${this.tenantId}/oauth2/v2.0/token`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
        scope: scopes.join(' '),
      }),
    });

    if (!response.ok) {
      const error: any = await response.json();
      throw new Error(
        `Failed to acquire client credentials token: ${error.error_description || error.error}`,
      );
    }

    const data: any = await response.json();

    return {
      accessToken: data.access_token,
      refreshToken: null, // Client credentials flow does not issue refresh tokens
      tokenType: data.token_type,
      expiresIn: data.expires_in,
      scope: data.scope || scopes.join(' '),
    };
  }

  // ─── Token Refresh ──────────────────────────────────────────────────────

  /**
   * Refresh access token.
   */
  async refreshToken(refreshToken: string): Promise<TokenRefreshResult> {
    const url = `${this.authority}/${this.tenantId}/oauth2/v2.0/token`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: this.clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      const error: any = await response.json();
      throw new Error(`Failed to refresh token: ${error.error_description || error.error}`);
    }

    const data: any = await response.json();

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null, // Microsoft may rotate refresh tokens
      expiresIn: data.expires_in,
    };
  }

  /**
   * Revoke token.
   */
  async revokeToken(token: string): Promise<void> {
    // Microsoft doesn't have a standard revocation endpoint for v2.0
    // Tokens will expire naturally based on their expiration time
    // For immediate revocation, use Microsoft Graph API to revoke sessions
    console.warn('Microsoft OAuth v2.0 does not support token revocation endpoint');
  }

  /**
   * Validate access token.
   */
  async validateToken(
    accessToken: string,
  ): Promise<{ valid: boolean; expiresAt: Date | null; scopes: string[] }> {
    try {
      // Make a test call to Microsoft Graph /me endpoint
      const response = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (response.ok) {
        // Token is valid
        // Note: We can't determine exact expiration from the response
        // This would require decoding the JWT
        return {
          valid: true,
          expiresAt: null,
          scopes: [],
        };
      } else {
        return {
          valid: false,
          expiresAt: null,
          scopes: [],
        };
      }
    } catch (error) {
      return {
        valid: false,
        expiresAt: null,
        scopes: [],
      };
    }
  }

  /**
   * Check if token needs refresh.
   */
  needsRefresh(expiresAt: Date, bufferMinutes: number = 5): boolean {
    const now = new Date();
    const bufferMs = bufferMinutes * 60 * 1000;
    const expiryWithBuffer = new Date(expiresAt.getTime() - bufferMs);
    return now >= expiryWithBuffer;
  }

  /**
   * Extract user ID from ID token (JWT).
   * This is a simple implementation - in production, use a JWT library.
   */
  private extractUserIdFromIdToken(idToken: string): string {
    try {
      const parts = idToken.split('.');
      if (parts.length !== 3) return 'unknown';

      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
      return payload.oid || payload.sub || 'unknown'; // Azure AD object ID
    } catch (error) {
      return 'unknown';
    }
  }
}

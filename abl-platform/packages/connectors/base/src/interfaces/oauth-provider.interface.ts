/**
 * OAuth Provider Interface
 *
 * Abstraction over provider-specific OAuth implementations (Microsoft, Atlassian, etc.).
 * Supports multiple OAuth 2.0 flows:
 * - Device Code Flow (RFC 8628) — for public clients / CLI
 * - Authorization Code Flow (RFC 6749 §4.1) — for confidential web clients
 * - Client Credentials Flow (RFC 6749 §4.4) — for app-only (no user sign-in)
 */

// ─── Auth Method ─────────────────────────────────────────────────────────

export type OAuthMethod = 'device_code' | 'authorization_code' | 'client_credentials';

// ─── Types ───────────────────────────────────────────────────────────────

export interface DeviceCodeResponse {
  /** Device code for polling */
  deviceCode: string;
  /** User code to enter */
  userCode: string;
  /** Verification URI to visit */
  verificationUri: string;
  /** Complete URI with user code (optional) */
  verificationUriComplete?: string;
  /** Polling interval in seconds */
  interval: number;
  /** Expiration time in seconds */
  expiresIn: number;
}

export interface AuthorizationCodeRequest {
  /** OAuth scopes to request */
  scopes: string[];
  /** Redirect URI registered in the app */
  redirectUri: string;
  /** CSRF state parameter */
  state: string;
}

export interface AuthorizationCodeExchange {
  /** Authorization code from redirect */
  code: string;
  /** Redirect URI (must match the one used in the authorize request) */
  redirectUri: string;
  /** Client secret for confidential clients */
  clientSecret: string;
}

export interface OAuthTokens {
  /** Access token */
  accessToken: string;
  /** Refresh token (optional) */
  refreshToken: string | null;
  /** Token type (usually 'Bearer') */
  tokenType: string;
  /** Expiration time in seconds */
  expiresIn: number;
  /** Granted scopes */
  scope: string;
  /** Provider user ID (if available) */
  providerUserId?: string;
}

export interface TokenRefreshResult {
  /** New access token */
  accessToken: string;
  /** New refresh token (if rotated) */
  refreshToken: string | null;
  /** Expiration time in seconds */
  expiresIn: number;
}

// ─── Interface ───────────────────────────────────────────────────────────

export interface IOAuthProvider {
  /** Provider name (e.g., 'microsoft', 'atlassian') */
  readonly providerName: string;

  /** OAuth client ID */
  readonly clientId: string;

  // ─── Device Code Flow (RFC 8628) ───────────────────────────────────────

  /**
   * Request a device code for CLI authentication.
   *
   * @param scopes - OAuth scopes to request
   * @returns Device code response
   */
  requestDeviceCode(scopes: string[]): Promise<DeviceCodeResponse>;

  /**
   * Exchange device code for access token.
   * Polls the token endpoint until user completes authorization.
   *
   * @param deviceCode - Device code from requestDeviceCode()
   * @returns OAuth tokens
   */
  exchangeDeviceCode(deviceCode: string): Promise<OAuthTokens>;

  // ─── Authorization Code Flow (RFC 6749 §4.1) ──────────────────────────

  /**
   * Build the authorization URL the user must visit to grant consent.
   *
   * @param request - Scopes, redirectUri, and CSRF state
   * @returns Full authorization URL
   */
  getAuthorizationUrl(request: AuthorizationCodeRequest): string;

  /**
   * Exchange an authorization code for tokens.
   *
   * @param exchange - Code, redirectUri, and clientSecret
   * @returns OAuth tokens
   */
  exchangeAuthorizationCode(exchange: AuthorizationCodeExchange): Promise<OAuthTokens>;

  // ─── Client Credentials Flow (RFC 6749 §4.4) ──────────────────────────

  /**
   * Acquire an app-only token using client credentials.
   * No user sign-in — the app acts as itself.
   *
   * @param scopes - OAuth scopes (must be /.default for Microsoft)
   * @param clientSecret - Client secret
   * @returns OAuth tokens (no refresh token)
   */
  acquireClientCredentialsToken(scopes: string[], clientSecret: string): Promise<OAuthTokens>;

  // ─── Common ────────────────────────────────────────────────────────────

  /**
   * Refresh an access token.
   *
   * @param refreshToken - Refresh token
   * @returns New tokens
   */
  refreshToken(refreshToken: string): Promise<TokenRefreshResult>;

  /**
   * Revoke tokens.
   *
   * @param token - Access or refresh token to revoke
   */
  revokeToken(token: string): Promise<void>;

  // ─── Token Validation ──────────────────────────────────────────────────

  /**
   * Validate an access token.
   * Checks expiration and optionally makes a test API call.
   *
   * @param accessToken - Token to validate
   * @returns Validation result
   */
  validateToken(accessToken: string): Promise<{
    valid: boolean;
    expiresAt: Date | null;
    scopes: string[];
  }>;

  /**
   * Check if token needs refresh.
   * Returns true if token expires within the buffer period (default 5 minutes).
   *
   * @param expiresAt - Token expiration timestamp
   * @param bufferMinutes - Buffer period in minutes
   */
  needsRefresh(expiresAt: Date, bufferMinutes?: number): boolean;
}

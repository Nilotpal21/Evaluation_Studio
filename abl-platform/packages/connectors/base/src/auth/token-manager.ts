/**
 * Token Manager
 *
 * Manages OAuth token lifecycle: refresh, validation, storage.
 * Integrates with EndUserOAuthToken model for encrypted storage.
 */

import type { HydratedDocument, Model } from 'mongoose';
import type { IEndUserOAuthToken } from '@agent-platform/database';
import type { IOAuthProvider } from '../interfaces/oauth-provider.interface.js';

// ─── Error Types ─────────────────────────────────────────────────────────

export class TokenManagerError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: any,
  ) {
    super(message);
    this.name = 'TokenManagerError';
  }
}

// ─── Token Manager ───────────────────────────────────────────────────────

/**
 * Optional Auth Profile resolver for dual-read credential migration.
 * When provided and authProfileId is set, TokenManager resolves tokens
 * via auth profile before falling back to EndUserOAuthToken.
 */
export interface TokenManagerAuthProfileResolver {
  resolveToken(params: {
    authProfileId: string;
    tenantId: string;
    userId: string;
  }): Promise<{ accessToken: string; expiresAt: Date | null } | null>;
}

export class TokenManager {
  private readonly provider: IOAuthProvider;
  private readonly tenantId: string;
  private readonly userId: string;
  private readonly tokenModel: Model<IEndUserOAuthToken>;
  private readonly authProfileId?: string;
  private readonly authProfileResolver?: TokenManagerAuthProfileResolver;

  /**
   * Buffer period before token expiry to trigger refresh (default: 5 minutes)
   */
  private readonly refreshBufferMinutes: number = 5;

  constructor(
    provider: IOAuthProvider,
    tenantId: string,
    userId: string,
    tokenModel: Model<IEndUserOAuthToken>,
    options?: {
      authProfileId?: string;
      authProfileResolver?: TokenManagerAuthProfileResolver;
    },
  ) {
    this.provider = provider;
    this.tenantId = tenantId;
    this.userId = userId;
    this.tokenModel = tokenModel;
    this.authProfileId = options?.authProfileId;
    this.authProfileResolver = options?.authProfileResolver;
  }

  /**
   * Store OAuth tokens in database.
   *
   * @param tokens - OAuth tokens to store
   * @param providerUserId - User ID from provider
   * @returns Stored token record
   */
  async storeTokens(
    tokens: { accessToken: string; refreshToken: string | null; scope: string; expiresIn: number },
    providerUserId: string,
  ): Promise<HydratedDocument<IEndUserOAuthToken>> {
    const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000);

    // Check if token already exists
    const existing = await this.tokenModel.findOne({
      tenantId: this.tenantId,
      userId: this.userId,
      provider: this.provider.providerName,
    });

    if (existing) {
      // Update existing token
      existing.encryptedAccessToken = tokens.accessToken;
      existing.encryptedRefreshToken = tokens.refreshToken;
      existing.scope = tokens.scope;
      existing.expiresAt = expiresAt;
      existing.refreshedAt = new Date();
      existing.revokedAt = null; // Un-revoke if previously revoked
      await existing.save();
      return existing;
    } else {
      // Create new token
      return await this.tokenModel.create({
        tenantId: this.tenantId,
        userId: this.userId,
        provider: this.provider.providerName,
        providerUserId,
        encryptedAccessToken: tokens.accessToken,
        encryptedRefreshToken: tokens.refreshToken,
        scope: tokens.scope,
        expiresAt,
        consentedAt: new Date(),
      });
    }
  }

  /**
   * Get access token, refreshing if needed.
   *
   * @returns Valid access token
   */
  async getAccessToken(): Promise<string> {
    // Auth Profile dual-read: resolve via auth profile if available
    if (this.authProfileId && this.authProfileResolver) {
      try {
        const profileToken = await this.authProfileResolver.resolveToken({
          authProfileId: this.authProfileId,
          tenantId: this.tenantId,
          userId: this.userId,
        });
        if (profileToken?.accessToken) {
          return profileToken.accessToken;
        }
      } catch (error) {
        // Fall through to legacy token path — log at debug to aid debugging
        // without flooding production logs
        void error; // Auth profile resolution failed, using legacy EndUserOAuthToken
      }
    }

    const token = await this.loadToken();

    // Check if token needs refresh
    if (token.expiresAt && this.provider.needsRefresh(token.expiresAt, this.refreshBufferMinutes)) {
      // Refresh token
      return await this.refreshToken(token);
    }

    // Capture the decrypted access token BEFORE save(). The Mongoose
    // encryption plugin's pre-save hook re-encrypts fields when
    // ire is absent (DEK facade path), replacing the in-memory
    // plaintext with ciphertext. Saving the value first avoids
    // returning ciphertext to the caller.
    const accessToken = token.encryptedAccessToken;

    // Update last used timestamp via updateOne to avoid triggering
    // the pre-save encryption hook entirely.
    await this.tokenModel.updateOne({ _id: token._id }, { $set: { lastUsedAt: new Date() } });

    return accessToken;
  }

  /**
   * Load token from database.
   */
  private async loadToken(): Promise<HydratedDocument<IEndUserOAuthToken>> {
    const token = await this.tokenModel.findOne({
      tenantId: this.tenantId,
      userId: this.userId,
      provider: this.provider.providerName,
      revokedAt: null, // Exclude revoked tokens
    });

    if (!token) {
      throw new TokenManagerError(
        'No OAuth token found. Please authenticate first.',
        'TOKEN_NOT_FOUND',
      );
    }

    return token;
  }

  /**
   * Refresh access token using refresh token.
   */
  private async refreshToken(token: HydratedDocument<IEndUserOAuthToken>): Promise<string> {
    if (!token.encryptedRefreshToken) {
      throw new TokenManagerError(
        'No refresh token available. Please re-authenticate.',
        'NO_REFRESH_TOKEN',
      );
    }

    try {
      const result = await this.provider.refreshToken(token.encryptedRefreshToken);

      // Update stored token
      token.encryptedAccessToken = result.accessToken;
      if (result.refreshToken) {
        // Some providers rotate refresh tokens
        token.encryptedRefreshToken = result.refreshToken;
      }
      token.expiresAt = new Date(Date.now() + result.expiresIn * 1000);
      token.refreshedAt = new Date();
      await token.save();

      return result.accessToken;
    } catch (error: any) {
      // If refresh fails due to missing client_secret (Azure AD public client issue),
      // provide a clear error message to re-authenticate
      const errorMsg = error.message || String(error);
      if (errorMsg.includes('client_secret') || errorMsg.includes('client_assertion')) {
        throw new TokenManagerError(
          'Token expired and automatic refresh is not available. Please re-authenticate through the connector settings.',
          'TOKEN_EXPIRED_REAUTH_REQUIRED',
          { originalError: error },
        );
      }

      throw new TokenManagerError(`Token refresh failed: ${errorMsg}`, 'TOKEN_REFRESH_FAILED', {
        originalError: error,
      });
    }
  }

  /**
   * Revoke token.
   */
  async revokeToken(): Promise<void> {
    const token = await this.loadToken();

    try {
      // Revoke at provider
      await this.provider.revokeToken(token.encryptedAccessToken);

      // Mark as revoked in database
      token.revokedAt = new Date();
      await token.save();
    } catch (error: any) {
      throw new TokenManagerError(
        `Token revocation failed: ${error.message}`,
        'TOKEN_REVOCATION_FAILED',
        { originalError: error },
      );
    }
  }

  /**
   * Validate current token.
   */
  async validateToken(): Promise<boolean> {
    try {
      const token = await this.loadToken();
      const result = await this.provider.validateToken(token.encryptedAccessToken);
      return result.valid;
    } catch (error) {
      return false;
    }
  }
}

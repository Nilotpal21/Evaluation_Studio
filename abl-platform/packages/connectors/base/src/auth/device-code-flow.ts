/**
 * OAuth 2.0 Device Code Flow Authenticator (RFC 8628)
 *
 * Shared authentication flow for all connectors.
 * Displays user code + verification URL, polls for token completion.
 */

import type {
  IOAuthProvider,
  DeviceCodeResponse,
  OAuthTokens,
} from '../interfaces/oauth-provider.interface.js';

// ─── Error Types ─────────────────────────────────────────────────────────

export class DeviceCodeFlowError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: any,
  ) {
    super(message);
    this.name = 'DeviceCodeFlowError';
  }
}

// ─── Authenticator ───────────────────────────────────────────────────────

export class DeviceCodeFlowAuthenticator {
  private readonly provider: IOAuthProvider;

  constructor(provider: IOAuthProvider) {
    this.provider = provider;
  }

  /**
   * Authenticate using OAuth Device Code Flow.
   *
   * @param scopes - OAuth scopes to request
   * @param onDeviceCode - Callback to display device code to user
   * @returns OAuth tokens
   */
  async authenticate(
    scopes: string[],
    onDeviceCode: (deviceCode: DeviceCodeResponse) => void,
  ): Promise<OAuthTokens> {
    // Step 1: Request device code
    const deviceCode = await this.requestDeviceCode(scopes);

    // Step 2: Display to user
    onDeviceCode(deviceCode);

    // Step 3: Poll for token
    const tokens = await this.pollForToken(deviceCode);

    return tokens;
  }

  /**
   * Request device code from provider.
   */
  private async requestDeviceCode(scopes: string[]): Promise<DeviceCodeResponse> {
    try {
      return await this.provider.requestDeviceCode(scopes);
    } catch (error: any) {
      throw new DeviceCodeFlowError(
        `Failed to request device code: ${error.message}`,
        'DEVICE_CODE_REQUEST_FAILED',
        { originalError: error },
      );
    }
  }

  /**
   * Poll for token until user completes authorization.
   * Implements exponential backoff on slow_down errors.
   */
  private async pollForToken(deviceCode: DeviceCodeResponse): Promise<OAuthTokens> {
    const interval = deviceCode.interval || 5; // Default 5 seconds
    const expiresAt = Date.now() + deviceCode.expiresIn * 1000;
    let currentInterval = interval;

    while (Date.now() < expiresAt) {
      // Wait for polling interval
      await this.sleep(currentInterval * 1000);

      try {
        // Attempt to exchange device code for token
        const tokens = await this.provider.exchangeDeviceCode(deviceCode.deviceCode);
        return tokens;
      } catch (error: any) {
        // Handle polling-specific errors
        if (error.code === 'authorization_pending') {
          // User hasn't completed authorization yet - continue polling
          continue;
        } else if (error.code === 'slow_down') {
          // Provider requests slower polling - increase interval by 5 seconds
          currentInterval += 5;
          continue;
        } else if (error.code === 'access_denied') {
          // User denied authorization
          throw new DeviceCodeFlowError('User denied authorization', 'ACCESS_DENIED', {
            originalError: error,
          });
        } else if (error.code === 'expired_token') {
          // Device code expired
          throw new DeviceCodeFlowError(
            'Device code expired. Please try again.',
            'DEVICE_CODE_EXPIRED',
            { originalError: error },
          );
        } else {
          // Unexpected error
          throw new DeviceCodeFlowError(
            `Token exchange failed: ${error.message}`,
            'TOKEN_EXCHANGE_FAILED',
            { originalError: error },
          );
        }
      }
    }

    // Device code expired (timeout)
    throw new DeviceCodeFlowError(
      'Device code expired. User did not complete authorization in time.',
      'DEVICE_CODE_TIMEOUT',
    );
  }

  /**
   * Sleep for specified milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * OAuth Error Mapping (FR-32)
 *
 * Maps known OAuth provider error codes to actionable admin-visible messages.
 * Pure function, deterministic, no external dependencies.
 *
 * Added per 2026-05-09 meeting delta (FR-32 NEW).
 */

// ─── Types ────────────────────────────────────────────────────────────

export interface OAuthProviderError {
  code: string;
  description?: string;
  redirectUri?: string;
}

export interface MappedOAuthError {
  adminMessage: string;
  code: string;
}

// ─── Known Error Code Map ─────────────────────────────────────────────

const KNOWN_ERROR_MAP: Record<string, (input: OAuthProviderError) => MappedOAuthError> = {
  redirect_uri_mismatch: (input) => ({
    adminMessage: `Authorization failed: the redirect URI in the OAuth app does not match the platform's callback URL.${input.redirectUri ? ` Update the OAuth app to use ${input.redirectUri}.` : ''}`,
    code: 'oauth_redirect_uri_mismatch',
  }),

  invalid_client: () => ({
    adminMessage:
      'Authorization failed: the OAuth client credentials (client ID or client secret) are invalid. Verify them in the auth profile configuration.',
    code: 'oauth_invalid_client',
  }),

  invalid_grant: () => ({
    adminMessage:
      'Authorization failed: the authorization code has expired or has already been used. Please try authorizing again.',
    code: 'oauth_invalid_grant',
  }),

  access_denied: () => ({
    adminMessage:
      'Authorization failed: the user denied access or the resource owner denied the request.',
    code: 'oauth_access_denied',
  }),

  unauthorized_client: () => ({
    adminMessage:
      'Authorization failed: the OAuth app is not authorized to use this grant type. Check the OAuth app settings in the provider dashboard.',
    code: 'oauth_unauthorized_client',
  }),

  unsupported_response_type: () => ({
    adminMessage:
      'Authorization failed: the OAuth provider does not support this response type. Verify the auth profile OAuth configuration.',
    code: 'oauth_unsupported_response_type',
  }),

  invalid_scope: () => ({
    adminMessage:
      'Authorization failed: one or more requested scopes are invalid. Review the scopes configured in the auth profile.',
    code: 'oauth_invalid_scope',
  }),

  server_error: () => ({
    adminMessage:
      'Authorization failed: the OAuth provider encountered an internal error. Try again later.',
    code: 'oauth_server_error',
  }),

  temporarily_unavailable: () => ({
    adminMessage:
      'Authorization failed: the OAuth provider is temporarily unavailable. Try again in a few minutes.',
    code: 'oauth_temporarily_unavailable',
  }),
};

// ─── Mapper ───────────────────────────────────────────────────────────

/**
 * Map an OAuth provider error to an actionable admin-visible message.
 *
 * @param providerError The error returned by the OAuth provider
 * @returns A mapped error with an admin-visible message and error code
 */
export function mapOAuthError(providerError: OAuthProviderError): MappedOAuthError {
  const handler = KNOWN_ERROR_MAP[providerError.code];
  if (handler) {
    return handler(providerError);
  }

  // Unknown error code — use description if available, otherwise code
  return {
    adminMessage: `Authorization failed: ${providerError.description ?? providerError.code}`,
    code: 'oauth_unknown_error',
  };
}

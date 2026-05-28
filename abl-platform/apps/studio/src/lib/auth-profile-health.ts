/**
 * Auth Profile Health Status
 *
 * Computes a normalized "operational health" struct for an auth profile so
 * that Studio surfaces (slide-over header, list cards, dialogs) can render
 * a single, consistent status pill without re-doing the per-auth-type
 * branching that the validate route already performs.
 *
 * Health is derived from:
 *  - the profile's lifecycle status (active / expired / revoked / invalid)
 *  - structural config validation results
 *  - for oauth2_app: whether a non-revoked grant exists, its expiry, and
 *    whether a refresh token is stored
 *  - for oauth2_client_credentials and oauth2_token: live or stored-token
 *    validity
 *  - usageMode (preconfigured vs jit/preflight) — JIT/preflight modes are
 *    user-authorized at runtime, so a profile with a usable config is
 *    "ready" even though no grant exists yet.
 */

export type AuthProfileHealthState =
  /** OAuth: has active grant AND refresh token — silently auto-renews on expiry */
  | 'connected'
  /** OAuth: has active grant but no refresh token — will need manual re-auth on expiry */
  | 'connected_no_auto_renew'
  /** OAuth: grant exists but access token expired AND no refresh token to renew with */
  | 'reauth_required'
  /** OAuth: no grant row in end_user_oauth_tokens for this profile */
  | 'not_authorized'
  /** OAuth (jit/preflight): config is valid; users authorize at tool-call time */
  | 'requires_user_authorization'
  /** CC / static auth: live verification passed (last test succeeded) */
  | 'verified'
  /** CC / static auth: never tested — config is structurally valid but unverified */
  | 'untested'
  /** Structural config validation failed */
  | 'configuration_error'
  /** Profile is revoked / expired / invalid at the lifecycle level */
  | 'lifecycle_blocked';

export interface AuthProfileHealth {
  state: AuthProfileHealthState;
  /** Human-readable explanation of the state. Always populated. */
  reason: string;
  /** ISO timestamp of last successful verification, if available. */
  lastVerifiedAt?: string;
  /**
   * For oauth2_app profiles: true when an OAuth grant exists with a stored
   * refresh token. Used by the UI to decide whether to show the "Re-authorize
   * to enable auto-refresh" hint even when the profile is currently connected.
   */
  refreshTokenStored?: boolean;
}

export interface ComputeAuthProfileHealthInput {
  authType: string;
  /** Lifecycle status from the profile document (active|expired|revoked|invalid) */
  lifecycleStatus: string;
  /** Result of the live or structural validation already performed by the route */
  valid: boolean;
  /** Type of validation that ran (configuration | oauth_grant | token_exchange | undefined) */
  validationType?: 'configuration' | 'oauth_grant' | 'token_exchange';
  /** Number of structural validation errors */
  configurationErrorCount: number;
  /** True when the profile uses jit / preflight usage modes */
  isUserAuthorizedAtRuntime: boolean;
  /** OAuth grant lookup result (oauth2_app only). Undefined for other auth types. */
  oauthGrant?: {
    found: boolean;
    expired: boolean;
    refreshTokenStored: boolean;
  };
  /** ISO timestamp of last successful validation (from auth_profiles.lastValidatedAt) */
  lastValidatedAt?: string | null;
}

/**
 * Reasons embedded as constants so tests and UI can match against them
 * without depending on prose. Stable identifiers; the `reason` text in the
 * returned struct is the human-readable variant.
 */
export const HEALTH_REASONS = {
  oauth_active_with_refresh: 'oauth_active_with_refresh',
  oauth_active_no_refresh: 'oauth_active_no_refresh',
  oauth_expired_no_refresh: 'oauth_expired_no_refresh',
  oauth_no_grant: 'oauth_no_grant',
  oauth_user_authorized_at_runtime: 'oauth_user_authorized_at_runtime',
  configuration_valid_unverified: 'configuration_valid_unverified',
  configuration_valid_verified: 'configuration_valid_verified',
  configuration_invalid: 'configuration_invalid',
  lifecycle_revoked: 'lifecycle_revoked',
  lifecycle_expired: 'lifecycle_expired',
  lifecycle_invalid: 'lifecycle_invalid',
} as const;

export type HealthReason = (typeof HEALTH_REASONS)[keyof typeof HEALTH_REASONS];

/**
 * Compute the health struct from the same signals the validate route already
 * computes. Pure function — no I/O, no DB access. The route is responsible
 * for performing the validation and looking up grants, then passing the
 * results in.
 */
export function computeAuthProfileHealth(input: ComputeAuthProfileHealthInput): AuthProfileHealth {
  // Lifecycle blocks everything else — a revoked profile cannot have a useful
  // operational state regardless of grants or config.
  if (input.lifecycleStatus === 'revoked') {
    return {
      state: 'lifecycle_blocked',
      reason: 'Profile has been revoked.',
      ...(input.lastValidatedAt ? { lastVerifiedAt: input.lastValidatedAt } : {}),
    };
  }
  if (input.lifecycleStatus === 'expired') {
    return {
      state: 'lifecycle_blocked',
      reason: 'Profile has expired.',
      ...(input.lastValidatedAt ? { lastVerifiedAt: input.lastValidatedAt } : {}),
    };
  }
  if (input.lifecycleStatus === 'invalid') {
    return {
      state: 'lifecycle_blocked',
      reason: 'Profile is in an invalid state.',
      ...(input.lastValidatedAt ? { lastVerifiedAt: input.lastValidatedAt } : {}),
    };
  }

  if (input.configurationErrorCount > 0) {
    return {
      state: 'configuration_error',
      reason: 'Profile configuration has validation errors.',
    };
  }

  // OAuth 2.0 App: drive state from grant lookup
  if (input.authType === 'oauth2_app') {
    if (input.isUserAuthorizedAtRuntime) {
      return {
        state: 'requires_user_authorization',
        reason: 'Configuration is valid. Each user authorizes at tool-call time.',
        ...(input.lastValidatedAt ? { lastVerifiedAt: input.lastValidatedAt } : {}),
      };
    }

    if (!input.oauthGrant || !input.oauthGrant.found) {
      return {
        state: 'not_authorized',
        reason: 'OAuth authorization has not been completed for this profile yet.',
        refreshTokenStored: false,
      };
    }

    if (input.oauthGrant.expired) {
      if (input.oauthGrant.refreshTokenStored) {
        // Expired but refreshable — runtime will try to refresh on next use.
        // From the user's POV the profile is still "connected" because token
        // refresh is automatic.
        return {
          state: 'connected',
          reason: 'OAuth token expired; will be refreshed automatically on next use.',
          refreshTokenStored: true,
          ...(input.lastValidatedAt ? { lastVerifiedAt: input.lastValidatedAt } : {}),
        };
      }
      return {
        state: 'reauth_required',
        reason:
          'OAuth token expired and no refresh token is stored. Re-authorize to restore access.',
        refreshTokenStored: false,
        ...(input.lastValidatedAt ? { lastVerifiedAt: input.lastValidatedAt } : {}),
      };
    }

    // Active grant
    if (input.oauthGrant.refreshTokenStored) {
      return {
        state: 'connected',
        reason: 'OAuth profile is authorized and will auto-renew on token expiry.',
        refreshTokenStored: true,
        ...(input.lastValidatedAt ? { lastVerifiedAt: input.lastValidatedAt } : {}),
      };
    }
    return {
      state: 'connected_no_auto_renew',
      reason:
        'OAuth profile is authorized but no refresh token is stored. Re-authorize with offline-access enabled to allow silent renewal when the token expires.',
      refreshTokenStored: false,
      ...(input.lastValidatedAt ? { lastVerifiedAt: input.lastValidatedAt } : {}),
    };
  }

  // Non-OAuth-app types: state depends on whether validation actually ran
  // a live check (token_exchange) or just structural validation.
  if (input.valid) {
    if (input.validationType === 'token_exchange') {
      return {
        state: 'verified',
        reason: 'Live verification succeeded — credentials are usable.',
        ...(input.lastValidatedAt ? { lastVerifiedAt: input.lastValidatedAt } : {}),
      };
    }
    if (input.lastValidatedAt) {
      return {
        state: 'verified',
        reason: 'Configuration is valid; last verification succeeded.',
        lastVerifiedAt: input.lastValidatedAt,
      };
    }
    return {
      state: 'untested',
      reason: 'Configuration is valid but has not been verified against the provider yet.',
    };
  }

  // valid === false — tests ran but failed
  return {
    state: 'configuration_error',
    reason: 'Verification failed. See the validation message for details.',
    ...(input.lastValidatedAt ? { lastVerifiedAt: input.lastValidatedAt } : {}),
  };
}

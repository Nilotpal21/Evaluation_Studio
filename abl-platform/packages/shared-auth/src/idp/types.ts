/**
 * IdP Token Validation Types
 *
 * Types for external Identity Provider (IdP) token validation.
 * Used by SearchAI Runtime, Studio, and Runtime for end-user authentication
 * via Azure AD, Okta, Google, or any OIDC-compliant provider.
 */

/**
 * Supported IdP providers.
 * 'custom' is for OIDC providers that don't match known patterns.
 */
export type IdPProvider = 'azuread' | 'okta' | 'google' | 'custom';

/**
 * Validated user identity extracted from an IdP token.
 */
export interface UserIdentity {
  email: string;
  name?: string;
  idpUserId: string;
  idpProvider: IdPProvider;
  domain: string;
  /**
   * Group memberships from JWT claim (Tier 1 of 3-tier resolution).
   *
   * Azure AD: `groups` claim (max 200 — if exceeded, `hasgroups: true` and this is undefined)
   * Okta: `groups` claim (max 100 by default, configurable)
   * Google: Not supported (always undefined)
   *
   * When populated, the permission filter service skips Redis/MongoDB lookups entirely.
   */
  groups?: string[];
}

/**
 * Configuration for IdP token validation.
 * Passed from auth profile settings to the validator.
 */
export interface IdPValidationConfig {
  /** Expected issuer URI (from auth profile config). If provided, `iss` must match. */
  expectedIssuer?: string;
  /** Expected audience / clientId (from auth profile config). If provided, `aud` must match. */
  expectedAudience?: string;
  /** Allowed email domains — empty array or undefined = allow all domains. */
  allowedDomains?: string[];
}

/**
 * Minimal Redis interface for JWKS caching.
 * Decouples the validator from any specific Redis client implementation.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttl: number): Promise<void>;
  del(key: string): Promise<void>;
  scanByPattern(pattern: string): Promise<string[]>;
}

// ─── Search Session Token Types ──────────────────────────────────────────

/**
 * Search session token payload — discriminated JWT.
 *
 * Discriminators prevent token confusion attacks:
 * - `type: 'search_session'` distinguishes from 'sdk_session', 'access'
 * - `iss: 'abl:search-runtime'` rejects tokens from other services
 * - `aud: 'abl:search-query'` rejects tokens meant for other purposes
 */
export interface SearchSessionTokenPayload {
  type: 'search_session';
  iss: 'abl:search-runtime';
  aud: 'abl:search-query';
  /** User email (lowercase) */
  sub: string;
  tenantId: string;
  projectId: string;
  domain: string;
  groups?: string[];
  contactId?: string;
  idpProvider: string;
  iat: number;
  exp: number;
}

/**
 * Options for issuing a search session token.
 */
export interface SearchSessionTokenOptions {
  email: string;
  tenantId: string;
  projectId: string;
  domain: string;
  groups?: string[];
  contactId?: string;
  idpProvider: string;
  /** Token TTL in seconds (default: 900 = 15 min) */
  ttlSeconds: number;
}

/**
 * Auth Constants
 *
 * Centralized constants for auth, SSO, MFA, and OAuth modules.
 * Keeps route handlers and services free of hardcoded values.
 */

// ---------------------------------------------------------------------------
// SAML Attribute Mappings (matches koreserver patterns)
// ---------------------------------------------------------------------------

export const SAML_EMAIL_ATTRIBUTES = [
  'email',
  'mail',
  'emailAddress',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'http://schemas.xmlsoap.org/claims/EmailAddress',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
] as const;

export const SAML_FIRST_NAME_ATTRIBUTES = [
  'firstName',
  'givenName',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
] as const;

export const SAML_LAST_NAME_ATTRIBUTES = [
  'lastName',
  'surname',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
] as const;

/** Regex to extract Issuer element from a SAML XML response */
export const SAML_ISSUER_REGEX = /<(?:saml2?:)?Issuer[^>]*>([^<]+)<\/(?:saml2?:)?Issuer>/;

/** Default SAML Service Provider entity ID */
export const SAML_DEFAULT_ENTITY_ID = 'agent-platform-sp';

// ---------------------------------------------------------------------------
// SSO Auth Provider Prefixes (used as googleId placeholder for SSO users)
// ---------------------------------------------------------------------------

export const SSO_SAML_PROVIDER_PREFIX = 'sso-saml-';
export const SSO_OIDC_PROVIDER_PREFIX = 'sso-oidc-';

// ---------------------------------------------------------------------------
// Redis Key Prefixes for SSO State Store
// ---------------------------------------------------------------------------

export const REDIS_PREFIX_SAML_ASSERTION = 'sso:saml:assertion:';
export const REDIS_PREFIX_OIDC_STATE = 'sso:oidc:state:';
export const REDIS_PREFIX_AUTH_CODE = 'sso:authcode:';

/** Interval (ms) to sweep expired in-memory SSO state entries */
export const SSO_STATE_CLEANUP_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// MFA Character Sets
// ---------------------------------------------------------------------------

/** Ambiguous characters removed: O/0/I/1 */
export const MFA_RECOVERY_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** RFC 4648 Base32 alphabet (used for TOTP secrets) */
export const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Prefix for unencrypted TOTP secrets (development only) */
export const MFA_UNENCRYPTED_SECRET_PREFIX = 'plain:';

// ---------------------------------------------------------------------------
// OAuth HTTP
// ---------------------------------------------------------------------------

/** Timeout (ms) for outbound HTTPS requests (token exchange, profile fetch) */
export const OAUTH_HTTP_TIMEOUT_MS = 15_000;

/** Force IPv4 to avoid ETIMEDOUT on dual-stack hosts (LinkedIn, MS Graph) */
export const OAUTH_HTTP_IP_FAMILY = 4;

// ---------------------------------------------------------------------------
// OAuth Cookie Names & Paths
// ---------------------------------------------------------------------------

export const OAUTH_STATE_COOKIE_LINKEDIN = 'oauth_state_li';
export const OAUTH_STATE_COOKIE_MICROSOFT = 'oauth_state_ms';
export const OAUTH_COOKIE_PATH_LINKEDIN = '/api/auth/linkedin';
export const OAUTH_COOKIE_PATH_MICROSOFT = '/api/auth/microsoft';
export const MFA_PARTIAL_COOKIE_NAME = 'mfa_partial';
export const MFA_COOKIE_PATH = '/api/mfa';

// ---------------------------------------------------------------------------
// Auth Config Defaults (mirrors packages/config auth.schema.ts defaults)
// Used as fallback when config is not yet loaded (early bootstrap / tests).
// ---------------------------------------------------------------------------

export const AUTH_CONFIG_DEFAULTS = {
  rateLimits: {
    login: { maxAttempts: 10, windowMs: 15 * 60 * 1000 },
    signup: { maxAttempts: 5, windowMs: 15 * 60 * 1000 },
    forgotPassword: { maxAttempts: 3, windowMs: 15 * 60 * 1000 },
    resetPassword: { maxAttempts: 5, windowMs: 15 * 60 * 1000 },
    createWorkspace: { maxAttempts: 5, windowMs: 60 * 60 * 1000 },
    deviceToken: { maxAttempts: 12, windowMs: 60 * 1000 },
    verifyEmail: { maxAttempts: 10, windowMs: 15 * 60 * 1000 },
    refresh: { maxAttempts: 30, windowMs: 60 * 1000 },
    mfaRecovery: { maxAttempts: 5, windowMs: 15 * 60 * 1000 },
    resendVerification: { maxAttempts: 3, windowMs: 15 * 60 * 1000 },
    ssoDomains: { maxAttempts: 10, windowMs: 60 * 60 * 1000 },
  },
  tokens: {
    refreshCookieMaxAgeSeconds: 7 * 24 * 60 * 60,
    mfaCookieMaxAgeSeconds: 300,
  },
  validation: {
    maxEmailLength: 254,
    maxPasswordLength: 128,
    maxNameLength: 200,
    emailRegex: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
  },
  password: {
    minLength: 8,
    historyCount: 5,
    resetTokenTtlMs: 60 * 60 * 1000,
    verificationTokenTtlMs: 24 * 60 * 60 * 1000,
  },
  lockout: {
    maxFailedAttempts: 5,
    lockDurationMs: 15 * 60 * 1000,
  },
  timingProtection: {
    minResponseMs: 200,
  },
  workspace: {
    maxPerUser: 10,
  },
} as const;

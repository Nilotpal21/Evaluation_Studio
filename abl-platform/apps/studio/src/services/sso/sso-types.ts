/**
 * SSO Type Definitions
 *
 * Shared types for SAML 2.0 and OIDC SSO flows.
 */

// ---------------------------------------------------------------------------
// Configuration Types
// ---------------------------------------------------------------------------

export interface SAMLConfig {
  entityId: string; // IdP Entity ID
  ssoUrl: string; // IdP SSO URL
  certificate: string; // IdP X.509 certificate (PEM)
  signRequests: boolean;
  nameIdFormat: 'email' | 'persistent' | 'transient';
}

export interface OIDCConfig {
  issuer: string; // IdP issuer URL
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  jwksUri: string;
  scopes: string[]; // e.g., ['openid', 'email', 'profile']
}

export interface SSOConfigData {
  protocol: 'saml' | 'oidc';
  saml?: SAMLConfig;
  oidc?: OIDCConfig;
}

// ---------------------------------------------------------------------------
// Normalized SSO User (output from both SAML and OIDC)
// ---------------------------------------------------------------------------

export interface SSOUser {
  email: string;
  name?: string;
  externalId: string; // NameID (SAML) or sub (OIDC)
  provider: 'saml' | 'oidc';
  attributes?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Domain Mapping
// ---------------------------------------------------------------------------

export interface DomainVerification {
  domain: string;
  token: string; // DNS TXT record value
  verified: boolean;
}

// ---------------------------------------------------------------------------
// SSO Init/Callback
// ---------------------------------------------------------------------------

export interface SSOInitRequest {
  email: string; // User's email to determine org
}

export interface SSOCallbackResult {
  user: SSOUser;
  organizationId: string;
}

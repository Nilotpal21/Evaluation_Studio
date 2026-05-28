/**
 * Enterprise Auth Types — Barrel Export
 *
 * Phase 3 enterprise authentication implementations:
 * digest, kerberos, saml, hawk, ws-security.
 */

export { applyDigestAuth } from './digest-auth.js';
export type { DigestAuthConfig, DigestAuthSecrets, DigestAuthOptions } from './digest-auth.js';

export { applyKerberosAuth } from './kerberos-auth.js';
export type {
  KerberosAuthConfig,
  KerberosAuthSecrets,
  KerberosAuthResult,
} from './kerberos-auth.js';

export { applySamlAuth } from './saml-auth.js';
export type { SamlAuthConfig, SamlAuthSecrets, SamlAuthResult } from './saml-auth.js';

export { applyHawkAuth } from './hawk-auth.js';
export type { HawkAuthConfig, HawkAuthSecrets, HawkAuthOptions } from './hawk-auth.js';

export { applyWsSecurity } from './ws-security-auth.js';
export type { WsSecurityConfig, WsSecuritySecrets, WsSecurityResult } from './ws-security-auth.js';

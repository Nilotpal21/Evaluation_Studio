/**
 * Search Session Token — Issuer & Verifier
 *
 * Issues and verifies project-scoped search session tokens for end-user auth.
 * These tokens are discriminated JWTs that prevent token confusion attacks:
 *
 * - type: 'search_session' — distinct from 'sdk_session', 'access'
 * - iss: 'abl:search-runtime' — rejects tokens from other services
 * - aud: 'abl:search-query' — rejects tokens meant for other purposes
 */

import jwt from 'jsonwebtoken';
import type { SearchSessionTokenPayload, SearchSessionTokenOptions } from './types.js';

const TOKEN_TYPE = 'search_session' as const;
const TOKEN_ISSUER = 'abl:search-runtime' as const;
const TOKEN_AUDIENCE = 'abl:search-query' as const;

/**
 * Issue a search session token.
 *
 * @param options - Token options (email, tenantId, projectId, etc.)
 * @param jwtSecret - Secret for signing the token
 * @returns Signed JWT string
 */
export function issueSearchSessionToken(
  options: SearchSessionTokenOptions,
  jwtSecret: string,
): string {
  const payload: Omit<SearchSessionTokenPayload, 'iat' | 'exp'> = {
    type: TOKEN_TYPE,
    iss: TOKEN_ISSUER,
    aud: TOKEN_AUDIENCE,
    sub: options.email.toLowerCase(),
    tenantId: options.tenantId,
    projectId: options.projectId,
    domain: options.domain.toLowerCase(),
    // Groups intentionally NOT stored in session token (O1 fix).
    // Enterprise users can have 200+ groups which would bloat the JWT past 8KB
    // (browser header limits, proxy cutoffs). Groups are resolved per-query via
    // the 3-tier resolver: JWT claim → Redis cache → MongoDB contact card.
    ...(options.contactId ? { contactId: options.contactId } : {}),
    idpProvider: options.idpProvider,
  };

  return jwt.sign(payload, jwtSecret, {
    expiresIn: options.ttlSeconds,
  });
}

/**
 * Verify and decode a search session token.
 *
 * @param token - JWT string to verify
 * @param jwtSecret - Secret for verifying the token signature
 * @returns Decoded and validated payload
 * @throws Error if token is invalid, expired, or has wrong discriminators
 */
export function verifySearchSessionToken(
  token: string,
  jwtSecret: string,
): SearchSessionTokenPayload {
  // Verify signature and expiration
  const decoded = jwt.verify(token, jwtSecret, {
    issuer: TOKEN_ISSUER,
    audience: TOKEN_AUDIENCE,
  }) as Record<string, unknown>;

  // Validate type discriminator
  if (decoded.type !== TOKEN_TYPE) {
    throw new Error(`Invalid token type: expected "${TOKEN_TYPE}", got "${String(decoded.type)}"`);
  }

  // Validate required fields
  if (!decoded.sub || typeof decoded.sub !== 'string') {
    throw new Error('Token missing sub claim');
  }
  if (!decoded.tenantId || typeof decoded.tenantId !== 'string') {
    throw new Error('Token missing tenantId claim');
  }
  if (!decoded.projectId || typeof decoded.projectId !== 'string') {
    throw new Error('Token missing projectId claim');
  }
  if (!decoded.domain || typeof decoded.domain !== 'string') {
    throw new Error('Token missing domain claim');
  }
  if (!decoded.idpProvider || typeof decoded.idpProvider !== 'string') {
    throw new Error('Token missing idpProvider claim');
  }

  return decoded as unknown as SearchSessionTokenPayload;
}

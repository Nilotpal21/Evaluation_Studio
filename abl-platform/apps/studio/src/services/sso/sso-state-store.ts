/**
 * SSO State Store (Hybrid: Redis → In-Memory Fallback)
 *
 * Manages three types of ephemeral SSO state:
 * - SAML consumed assertions (replay protection)
 * - OIDC PKCE state (nonce, code verifier, org ID)
 * - SSO auth codes (short-lived token exchange codes)
 *
 * Uses Redis when available for distributed state.
 * Falls back to in-memory Maps/Sets when Redis is unavailable.
 */

import crypto from 'crypto';
import { isRedisAvailable, getRedisClient } from '@/lib/redis-client';
import {
  REDIS_PREFIX_SAML_ASSERTION,
  REDIS_PREFIX_OIDC_STATE,
  REDIS_PREFIX_AUTH_CODE,
  SSO_STATE_CLEANUP_INTERVAL_MS,
} from '@/lib/auth-constants';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OIDCStateData {
  nonce: string;
  codeVerifier: string;
  orgId: string;
  adminRedirect?: string;
}

export interface AuthCodeData {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  needsOnboarding?: boolean;
  pendingInvitations?: number;
  pendingInvitationChoice?: boolean;
  inviteToken?: string;
}

// ---------------------------------------------------------------------------
// In-Memory Fallback Stores
// ---------------------------------------------------------------------------

const memConsumedAssertions = new Map<string, number>(); // id → expiresAt
const memOIDCState = new Map<string, OIDCStateData & { expiresAt: number }>();
const memAuthCodes = new Map<string, AuthCodeData & { expiresAt: number }>();

// Cleanup expired in-memory entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of memConsumedAssertions) {
    if (exp < now) memConsumedAssertions.delete(k);
  }
  for (const [k, v] of memOIDCState) {
    if (v.expiresAt < now) memOIDCState.delete(k);
  }
  for (const [k, v] of memAuthCodes) {
    if (v.expiresAt < now) memAuthCodes.delete(k);
  }
}, SSO_STATE_CLEANUP_INTERVAL_MS);

// ---------------------------------------------------------------------------
// SAML Assertion Replay Protection
// ---------------------------------------------------------------------------

export async function isAssertionConsumed(assertionId: string): Promise<boolean> {
  if (isRedisAvailable()) {
    const redis = getRedisClient();
    const exists = await redis.exists(`${REDIS_PREFIX_SAML_ASSERTION}${assertionId}`);
    return exists === 1;
  }
  const entry = memConsumedAssertions.get(assertionId);
  if (!entry) return false;
  if (entry < Date.now()) {
    memConsumedAssertions.delete(assertionId);
    return false;
  }
  return true;
}

export async function markAssertionConsumed(assertionId: string, ttlSeconds = 3600): Promise<void> {
  if (isRedisAvailable()) {
    const redis = getRedisClient();
    await redis.set(`${REDIS_PREFIX_SAML_ASSERTION}${assertionId}`, '1', 'EX', ttlSeconds);
    return;
  }
  memConsumedAssertions.set(assertionId, Date.now() + ttlSeconds * 1000);
}

// ---------------------------------------------------------------------------
// OIDC PKCE State
// ---------------------------------------------------------------------------

export async function setOIDCState(
  state: string,
  data: OIDCStateData,
  ttlSeconds = 600,
): Promise<void> {
  if (isRedisAvailable()) {
    const redis = getRedisClient();
    await redis.set(`${REDIS_PREFIX_OIDC_STATE}${state}`, JSON.stringify(data), 'EX', ttlSeconds);
    return;
  }
  memOIDCState.set(state, { ...data, expiresAt: Date.now() + ttlSeconds * 1000 });
}

export async function getOIDCState(state: string): Promise<OIDCStateData | null> {
  if (isRedisAvailable()) {
    const redis = getRedisClient();
    const raw = await redis.get(`${REDIS_PREFIX_OIDC_STATE}${state}`);
    return raw ? JSON.parse(raw) : null;
  }
  const entry = memOIDCState.get(state);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    memOIDCState.delete(state);
    return null;
  }
  return {
    nonce: entry.nonce,
    codeVerifier: entry.codeVerifier,
    orgId: entry.orgId,
    ...(entry.adminRedirect ? { adminRedirect: entry.adminRedirect } : {}),
  };
}

/**
 * Atomically consume (get + delete) an OIDC state entry.
 * Uses GETDEL for Redis atomicity — prevents race conditions where two
 * concurrent requests both read the same state before either deletes it.
 */
export async function consumeOIDCState(state: string): Promise<OIDCStateData | null> {
  if (isRedisAvailable()) {
    const redis = getRedisClient();
    const raw = await redis.getdel(`${REDIS_PREFIX_OIDC_STATE}${state}`);
    return raw ? JSON.parse(raw) : null;
  }
  const entry = memOIDCState.get(state);
  memOIDCState.delete(state); // Always delete (single-use)
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) return null;
  return {
    nonce: entry.nonce,
    codeVerifier: entry.codeVerifier,
    orgId: entry.orgId,
    ...(entry.adminRedirect ? { adminRedirect: entry.adminRedirect } : {}),
  };
}

export async function deleteOIDCState(state: string): Promise<void> {
  if (isRedisAvailable()) {
    const redis = getRedisClient();
    await redis.del(`${REDIS_PREFIX_OIDC_STATE}${state}`);
    return;
  }
  memOIDCState.delete(state);
}

// ---------------------------------------------------------------------------
// SSO Auth Codes (short-lived token exchange)
// ---------------------------------------------------------------------------

export function generateAuthCode(): string {
  return crypto.randomBytes(32).toString('hex');
}

export async function setAuthCode(
  code: string,
  data: AuthCodeData,
  ttlSeconds = 60,
): Promise<void> {
  if (isRedisAvailable()) {
    const redis = getRedisClient();
    await redis.set(`${REDIS_PREFIX_AUTH_CODE}${code}`, JSON.stringify(data), 'EX', ttlSeconds);
    return;
  }
  memAuthCodes.set(code, { ...data, expiresAt: Date.now() + ttlSeconds * 1000 });
}

/**
 * Atomically get and delete an auth code (single-use).
 * Uses GETDEL for Redis atomicity — prevents replay attacks where two
 * concurrent requests both read the same code before either deletes it.
 * Returns null if code doesn't exist or is expired.
 */
export async function consumeAuthCode(code: string): Promise<AuthCodeData | null> {
  if (isRedisAvailable()) {
    const redis = getRedisClient();
    const raw = await redis.getdel(`${REDIS_PREFIX_AUTH_CODE}${code}`);
    return raw ? JSON.parse(raw) : null;
  }

  const entry = memAuthCodes.get(code);
  memAuthCodes.delete(code); // Always delete (single-use)
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) return null;
  return {
    accessToken: entry.accessToken,
    refreshToken: entry.refreshToken,
    expiresIn: entry.expiresIn,
    needsOnboarding: entry.needsOnboarding,
    pendingInvitations: entry.pendingInvitations,
    pendingInvitationChoice: entry.pendingInvitationChoice,
    inviteToken: entry.inviteToken,
  };
}

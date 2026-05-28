/**
 * OAuth State Service
 *
 * Manages PKCE state for Path B (OAuth redirect/PKCE flow).
 * State is stored in Redis with TTL and consumed atomically via GETDEL.
 *
 * Security:
 * - GETDEL ensures one-time use (prevents replay attacks)
 * - 600s TTL ensures stale state is cleaned up
 * - Random state ID prevents enumeration
 * - Nonce prevents token substitution
 */

import crypto from 'node:crypto';
import { createLogger } from '@abl/compiler/platform';
import { getGlobalRedisClient } from '../cache/redis-client.js';

const logger = createLogger('oauth-state-service');

const OAUTH_STATE_PREFIX = 'searchai:oauth:state:';
const DEFAULT_TTL_SECONDS = 600; // 10 minutes max for login flow

// ─── Types ──────────────────────────────────────────────────────────────

export interface OAuthState {
  codeVerifier: string;
  nonce: string;
  indexId: string;
  profileId: string;
  redirectUri: string;
  clientState?: string;
  createdAt: number;
}

export interface PKCEChallenge {
  codeVerifier: string;
  codeChallenge: string;
}

// ─── PKCE Helpers ───────────────────────────────────────────────────────

/**
 * Generate PKCE code verifier and challenge (S256).
 */
export function generatePKCE(): PKCEChallenge {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

/**
 * Generate a cryptographic nonce for OIDC id_token binding.
 */
export function generateNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

// ─── State Management ───────────────────────────────────────────────────

/**
 * Store PKCE state in Redis with TTL.
 * Returns the state ID (random UUID, used as platform_state_id in OAuth flow).
 *
 * @throws Error if Redis is unavailable (fail closed — 503 at caller)
 */
export async function storeOAuthState(
  state: OAuthState,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<string> {
  const redisClient = getGlobalRedisClient();

  if (!redisClient.isAvailable()) {
    throw new Error('Redis unavailable — cannot store OAuth state');
  }

  const stateId = crypto.randomUUID();
  const key = `${OAUTH_STATE_PREFIX}${stateId}`;

  await redisClient.set(key, JSON.stringify(state), ttlSeconds);

  logger.debug('OAuth state stored', {
    stateId,
    profileId: state.profileId,
    indexId: state.indexId,
    ttlSeconds,
  });

  return stateId;
}

/**
 * Retrieve and atomically delete PKCE state (one-time use).
 * Returns null if expired or already consumed.
 *
 * Uses Redis GETDEL for atomic read + delete — prevents replay attacks.
 */
export async function consumeOAuthState(stateId: string): Promise<OAuthState | null> {
  const redisClient = getGlobalRedisClient();
  const key = `${OAUTH_STATE_PREFIX}${stateId}`;

  const raw = await redisClient.getdel(key);
  if (!raw) {
    logger.warn('OAuth state not found or already consumed', { stateId });
    return null;
  }

  try {
    const state = JSON.parse(raw) as OAuthState;
    logger.debug('OAuth state consumed', {
      stateId,
      profileId: state.profileId,
      ageMs: Date.now() - state.createdAt,
    });
    return state;
  } catch (parseErr) {
    logger.error('Corrupted OAuth state', {
      stateId,
      error: parseErr instanceof Error ? parseErr.message : String(parseErr),
    });
    return null;
  }
}

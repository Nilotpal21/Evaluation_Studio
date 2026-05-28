/**
 * Participant Registry — Redis-Backed
 *
 * Manages live session state entirely in Redis (no in-memory Maps):
 * - Active live-session lookup: omnichannel:live:{tenantId}:{projectId}:{contactId} → sessionId
 * - Participant set: omnichannel:participants:{sessionId} → Set of participant JSON
 * - Join tokens: omnichannel:join:{token} → JSON payload (one-time use)
 * - Sequence allocator: omnichannel:seq:{sessionId} → counter via INCR
 *
 * All keys have configurable TTLs from @agent-platform/config/constants.
 */

import crypto from 'node:crypto';
import { createLogger } from '@abl/compiler/platform';
import { runLuaScript, type LuaScript } from '@agent-platform/redis';
import { getRedisClient } from '../redis/redis-client.js';
import {
  OMNICHANNEL_LIVE_SESSION_TTL_SECONDS,
  OMNICHANNEL_PARTICIPANT_TTL_SECONDS,
  OMNICHANNEL_JOIN_LINK_TTL_SECONDS,
  OMNICHANNEL_SEQUENCE_TTL_SECONDS,
  OMNICHANNEL_MAX_CONNECTIONS_PER_SESSION,
} from '@agent-platform/config/constants';
import type { Participant, JoinTokenPayload } from './types.js';
import { normalizeParticipant } from './types.js';

const log = createLogger('omnichannel-participant-registry');

const ADD_PARTICIPANT_LUA: LuaScript = {
  name: 'omnichannel-add-participant',
  body: `
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
  return 2
end
local currentCount = redis.call('SCARD', KEYS[1])
if currentCount >= tonumber(ARGV[2]) then
  return -1
end
local added = redis.call('SADD', KEYS[1], ARGV[1])
if added == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
  return 1
end
return 0
`,
  numberOfKeys: 1,
};

// =============================================================================
// KEY BUILDERS
// =============================================================================

function liveSessionKey(tenantId: string, projectId: string, contactId: string): string {
  return `omnichannel:live:${tenantId}:${projectId}:${contactId}`;
}

// sessionId is globally unique (UUIDv7) — tenant/project prefix not needed for isolation
function participantSetKey(sessionId: string): string {
  return `omnichannel:participants:${sessionId}`;
}

function joinTokenKey(token: string): string {
  return `omnichannel:join:${token}`;
}

function sequenceKey(sessionId: string): string {
  return `omnichannel:seq:${sessionId}`;
}

// =============================================================================
// LIVE SESSION LOOKUP
// =============================================================================

/**
 * Register a session as the active live session for a contact.
 * Sets a Redis key with TTL that maps (tenantId, projectId, contactId) → sessionId.
 */
export async function registerLiveSession(
  tenantId: string,
  projectId: string,
  contactId: string,
  sessionId: string,
): Promise<void> {
  const redis = getRedisClient();
  if (!redis) {
    log.warn('Redis unavailable — cannot register live session', { sessionId });
    return;
  }

  const key = liveSessionKey(tenantId, projectId, contactId);
  await redis.set(key, sessionId, 'EX', OMNICHANNEL_LIVE_SESSION_TTL_SECONDS);
  log.info('Live session registered', { tenantId, projectId, contactId, sessionId });
}

/**
 * Look up the active live session for a contact.
 * Returns the sessionId or null if no active session exists.
 */
export async function getLiveSession(
  tenantId: string,
  projectId: string,
  contactId: string,
): Promise<string | null> {
  const redis = getRedisClient();
  if (!redis) return null;

  const key = liveSessionKey(tenantId, projectId, contactId);
  return redis.get(key);
}

/**
 * Remove the active live session for a contact.
 */
export async function removeLiveSession(
  tenantId: string,
  projectId: string,
  contactId: string,
): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  const key = liveSessionKey(tenantId, projectId, contactId);
  await redis.del(key);
  log.info('Live session removed', { tenantId, projectId, contactId });
}

// =============================================================================
// PARTICIPANT SET
// =============================================================================

/**
 * Add a participant to a live session.
 * Enforces max connections per session. Stores participant as JSON in a Redis Set.
 */
export async function addParticipant(sessionId: string, participant: Participant): Promise<void> {
  const redis = getRedisClient();
  if (!redis) {
    throw new Error('Redis unavailable — cannot add participant');
  }

  const key = participantSetKey(sessionId);

  const normalized = normalizeParticipant(participant);
  if (!normalized) {
    throw new Error('Invalid participant payload');
  }

  const serialized = JSON.stringify(normalized);
  const addResult = Number(
    await runLuaScript(
      redis,
      ADD_PARTICIPANT_LUA,
      [key],
      [serialized, OMNICHANNEL_MAX_CONNECTIONS_PER_SESSION, OMNICHANNEL_PARTICIPANT_TTL_SECONDS],
    ),
  );

  if (addResult === -1) {
    throw new Error(
      `Maximum connections per session (${OMNICHANNEL_MAX_CONNECTIONS_PER_SESSION}) exceeded`,
    );
  }

  if (addResult !== 1 && addResult !== 2) {
    throw new Error('Failed to add participant');
  }

  log.info('Participant added', {
    sessionId,
    participantId: normalized.participantId,
    surface: normalized.surface,
  });
}

/**
 * Remove a participant from a live session.
 * Scans the set for matching participant ID and removes the entry.
 */
export async function removeParticipant(sessionId: string, participantId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  const key = participantSetKey(sessionId);
  const members = await redis.smembers(key);

  for (const member of members) {
    try {
      const parsed = normalizeParticipant(JSON.parse(member) as Participant);
      if (parsed?.participantId === participantId) {
        await redis.srem(key, member);
        log.info('Participant removed', { sessionId, participantId });
        return;
      }
    } catch {
      // Skip malformed entries
      log.warn('Malformed participant entry in Redis set', { sessionId });
    }
  }
}

/**
 * Get all participants for a session.
 */
export async function getParticipants(sessionId: string): Promise<Participant[]> {
  const redis = getRedisClient();
  if (!redis) return [];

  const key = participantSetKey(sessionId);
  const members = await redis.smembers(key);

  const participants: Participant[] = [];
  for (const member of members) {
    try {
      const parsed = normalizeParticipant(JSON.parse(member) as Participant);
      if (parsed) {
        participants.push(parsed);
      }
    } catch {
      log.warn('Skipping malformed participant entry', { sessionId });
    }
  }
  return participants;
}

// =============================================================================
// JOIN TOKENS
// =============================================================================

/**
 * Create a one-time join token.
 * Returns the generated token string. The token maps to the payload in Redis
 * and expires after OMNICHANNEL_JOIN_LINK_TTL_SECONDS.
 */
export async function createJoinToken(payload: JoinTokenPayload): Promise<string> {
  const redis = getRedisClient();
  if (!redis) {
    throw new Error('Redis unavailable — cannot create join token');
  }

  const token = crypto.randomUUID();
  const key = joinTokenKey(token);
  await redis.set(key, JSON.stringify(payload), 'EX', OMNICHANNEL_JOIN_LINK_TTL_SECONDS);

  log.info('Join token created', {
    sessionId: payload.sessionId,
    contactId: payload.contactId,
  });

  return token;
}

/**
 * Redeem a one-time join token.
 * Returns the payload and deletes the token (one-time use via GET + DEL).
 * Returns null if the token does not exist or has expired.
 */
export async function redeemJoinToken(token: string): Promise<JoinTokenPayload | null> {
  const redis = getRedisClient();
  if (!redis) return null;

  const key = joinTokenKey(token);

  // Atomic GET + DEL via Lua script to prevent double-redemption race
  const redeemTokenScript: LuaScript = {
    name: 'omnichannel-redeem-join-token',
    body: `local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]); end; return v;`,
    numberOfKeys: 1,
  };
  const value = await runLuaScript<string | null>(redis, redeemTokenScript, [key], []);
  if (!value) return null;

  try {
    return JSON.parse(value) as JoinTokenPayload;
  } catch {
    log.warn('Malformed join token payload', { token });
    return null;
  }
}

// =============================================================================
// SEQUENCE ALLOCATION
// =============================================================================

/**
 * Allocate the next monotonic sequence number for a session.
 * Uses Redis INCR for atomicity. Sets TTL on first use.
 */
export async function nextSequence(sessionId: string): Promise<number> {
  const redis = getRedisClient();
  if (!redis) {
    throw new Error('Redis unavailable — cannot allocate sequence');
  }

  const key = sequenceKey(sessionId);
  const seq = await redis.incr(key);

  // Set TTL only on first sequence (seq === 1)
  if (seq === 1) {
    await redis.expire(key, OMNICHANNEL_SEQUENCE_TTL_SECONDS);
  }

  return seq;
}

// =============================================================================
// CLEANUP
// =============================================================================

/**
 * Remove all Redis keys for a session (participants, sequence).
 * Live session keys are managed separately via removeLiveSession since
 * they are keyed by contact, not session.
 */
export async function cleanup(sessionId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  const keys = [participantSetKey(sessionId), sequenceKey(sessionId)];

  // Delete keys individually (cluster-safe — keys may hash to different slots)
  await Promise.all(keys.map((k) => redis.del(k)));
  log.info('Session keys cleaned up', { sessionId });
}

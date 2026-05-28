/**
 * Transfer Session Lua Scripts
 *
 * Atomic Lua scripts for Redis operations on transfer sessions.
 *
 * **Cluster-safety contract**: every script operates on exactly ONE key —
 * the session hash (KEYS[1]). The provider lookup index, the active-sessions
 * SET, and the per-pod SET each live on their own slot in cluster mode and
 * are written by the TypeScript caller via `pipeline()` after the Lua
 * returns. This trades atomicity at the cross-slot boundary for cluster
 * compatibility; partial failures are tolerated because TTLs self-clean
 * orphan index/set entries within the session lifetime (see
 * docs/guides/redis-cluster-mode.md for the recovery runbook).
 *
 * In standalone mode, the keys still happen to share a slot (single node),
 * so the change is observationally equivalent.
 */

/**
 * Atomic session creation (session hash only).
 *
 * KEYS[1] = session hash key (agent_transfer:{tenantId}:{contactId}:{channel})
 *
 * ARGV[1] = TTL in seconds (0 = no expiry)
 * ARGV[2..N] = alternating field, value pairs for HSET
 *
 * Returns:
 *   1 = created successfully
 *   0 = session already exists (duplicate)
 *
 * The caller is responsible for the cross-slot index writes (provider index,
 * active-sessions SET, per-pod SET) via a follow-up pipeline().
 */
export const LUA_CREATE_SESSION = `
local sessionKey = KEYS[1]
local ttl = tonumber(ARGV[1])

-- Check if session already exists (duplicate guard)
if redis.call('EXISTS', sessionKey) == 1 then
  return 0
end

-- Set all hash fields
for i = 2, #ARGV, 2 do
  redis.call('HSET', sessionKey, ARGV[i], ARGV[i+1])
end

-- Set TTL on session hash (0 = no expiry for voice)
if ttl > 0 then
  redis.call('EXPIRE', sessionKey, ttl)
end

return 1
`;

/**
 * Atomic session end — read-then-delete on the session hash.
 *
 * Reads provider, providerSessionId, and ownerPod from the session hash
 * INSIDE the script before deleting, eliminating the TOCTOU race where the
 * session could expire between a preceding get() and the delete. The fields
 * are returned so the caller can clean up the cross-slot indexes (provider
 * index, active-sessions SET, per-pod SET) via a pipeline() that tolerates
 * partial failure (TTL self-cleans).
 *
 * KEYS[1] = session hash key
 *
 * Returns array:
 *   {provider, providerSessionId, ownerPod} on success — empty strings for
 *   missing fields. Each is '' when the field was absent.
 *   {} (empty array) when the session did not exist.
 */
export const LUA_END_SESSION = `
local sessionKey = KEYS[1]

if redis.call('EXISTS', sessionKey) == 0 then
  return {}
end

local provider = redis.call('HGET', sessionKey, 'provider') or ''
local providerSessionId = redis.call('HGET', sessionKey, 'providerSessionId') or ''
local ownerPod = redis.call('HGET', sessionKey, 'ownerPod') or ''

redis.call('DEL', sessionKey)

return {provider, providerSessionId, ownerPod}
`;

/**
 * Atomic session claim (CAS on ownerPod) — single-key on the session hash.
 *
 * Used during pod-crash recovery to prevent two pods from claiming the same
 * orphaned session. Pod-set membership updates are pipelined by the caller
 * AFTER a successful CAS.
 *
 * KEYS[1] = session hash key
 *
 * ARGV[1] = expected current ownerPod (the dead pod)
 * ARGV[2] = new ownerPod (the claiming pod)
 * ARGV[3] = current timestamp
 *
 * Returns:
 *   1 = claimed successfully
 *   0 = ownerPod changed (lost race) or session missing
 */
export const LUA_CLAIM_SESSION = `
local sessionKey = KEYS[1]
local oldPod = ARGV[1]
local newPod = ARGV[2]
local timestamp = ARGV[3]

local current = redis.call('HGET', sessionKey, 'ownerPod')
if current ~= oldPod then
  return 0
end

redis.call('HSET', sessionKey, 'ownerPod', newPod)
redis.call('HSET', sessionKey, 'lastHeartbeat', timestamp)
redis.call('HSET', sessionKey, 'updatedAt', timestamp)

return 1
`;

/**
 * Atomic TTL extension on the session hash.
 *
 * Checks the session exists before extending TTL. If the session has
 * already expired, returns 0 instead of creating ghost records. The
 * caller is responsible for separately extending the provider index TTL
 * via redis.expire() (best-effort, outside Lua, cross-slot).
 *
 * KEYS[1] = session hash key
 *
 * ARGV[1] = TTL in seconds
 * ARGV[2] = updatedAt timestamp
 * ARGV[3] = lastHeartbeat timestamp
 *
 * Returns:
 *   1 = extended successfully
 *   0 = session not found / expired
 */
export const LUA_EXTEND_TTL = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('EXPIRE', KEYS[1], ARGV[1])
redis.call('HMSET', KEYS[1], 'updatedAt', ARGV[2], 'lastHeartbeat', ARGV[3])
return 1
`;

/**
 * Atomic session update — single-key.
 *
 * Checks the session exists before updating, preventing TOCTOU race where
 * a session could be deleted between existence check and update.
 *
 * KEYS[1] = session hash key
 *
 * ARGV[1..N] = alternating field, value pairs for HSET
 *
 * Returns:
 *   1 = updated successfully
 *   0 = session not found (deleted between caller's intent and execution)
 */
export const LUA_UPDATE_SESSION = `
local sessionKey = KEYS[1]

if redis.call('EXISTS', sessionKey) == 0 then
  return 0
end

for i = 1, #ARGV, 2 do
  redis.call('HSET', sessionKey, ARGV[i], ARGV[i+1])
end

return 1
`;

/**
 * Atomic ACW completion marker.
 *
 * KEYS[1] = session hash key
 * ARGV[1..N] = alternating field, value pairs for HSET
 *
 * Returns:
 *   1 = marked completed and fields written
 *   0 = session missing or ACW was already marked completed
 */
export const LUA_COMPLETE_ACW_IF_PENDING = `
local sessionKey = KEYS[1]

if redis.call('EXISTS', sessionKey) == 0 then
  return 0
end

if redis.call('HGET', sessionKey, 'acwCompletedEmitted') == 'true' then
  return 0
end

for i = 1, #ARGV, 2 do
  redis.call('HSET', sessionKey, ARGV[i], ARGV[i+1])
end

return 1
`;

// ---------------------------------------------------------------------------
// LuaScript wrappers — used by production callers via `runLuaScript()` so that
// CROSSSLOT errors are classified and counted via `redis.crossslot.errors`.
// The raw string exports above remain for tests that assert on script body
// contents.
// ---------------------------------------------------------------------------

import type { LuaScript } from '@agent-platform/redis';

export const SCRIPT_CREATE_SESSION: LuaScript = {
  name: 'agent_transfer.create_session',
  body: LUA_CREATE_SESSION,
  numberOfKeys: 1,
};

export const SCRIPT_END_SESSION: LuaScript = {
  name: 'agent_transfer.end_session',
  body: LUA_END_SESSION,
  numberOfKeys: 1,
};

export const SCRIPT_CLAIM_SESSION: LuaScript = {
  name: 'agent_transfer.claim_session',
  body: LUA_CLAIM_SESSION,
  numberOfKeys: 1,
};

export const SCRIPT_EXTEND_TTL: LuaScript = {
  name: 'agent_transfer.extend_ttl',
  body: LUA_EXTEND_TTL,
  numberOfKeys: 1,
};

export const SCRIPT_UPDATE_SESSION: LuaScript = {
  name: 'agent_transfer.update_session',
  body: LUA_UPDATE_SESSION,
  numberOfKeys: 1,
};

export const SCRIPT_COMPLETE_ACW_IF_PENDING: LuaScript = {
  name: 'agent_transfer.complete_acw_if_pending',
  body: LUA_COMPLETE_ACW_IF_PENDING,
  numberOfKeys: 1,
};

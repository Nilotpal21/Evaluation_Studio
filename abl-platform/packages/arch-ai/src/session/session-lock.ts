/**
 * Redis-backed turn lock with fencing tokens.
 *
 * Source of truth: docs/superpowers/specs/2026-04-17-arch-ai-orchestration-redesign-design.md §6.4, §6.4.1
 * Plan: docs/plans/2026-04-17-arch-ai-orchestration-redesign-impl-plan.md Phase 2
 *
 * Lifecycle:
 *   1. acquireTurnLock — workerId wins NX; fencing token INCR'd monotonically
 *   2. renewTurnLock — extends PEXPIRE only if workerId still owns (Lua)
 *   3. releaseTurnLock — deletes only if workerId still owns (Lua, compare-and-delete)
 *
 * Every DB write in TurnBuffer.commit() applies `fencingToken: { $lte: this.fencingToken }`
 * so a zombie worker whose lock expired and was taken over cannot corrupt state.
 *
 * Per decision D-17: Lua scripts are INLINE string constants here, NOT loaded from
 * `.lua` files via readFileSync (CLAUDE.md bans sync I/O in async paths). Pattern
 * matches packages/execution/src/redis-fan-out-barrier.ts. Scripts are registered
 * via ioredis `defineCommand` on first use to avoid re-parsing Lua on every call.
 */

import type { RedisClient } from '@agent-platform/redis';

import { ARCH_AI_LOCK } from '../engine/hard-limits.js';

// ─── Key helpers ─────────────────────────────────────────────────────────

function lockKey(sessionId: string): string {
  return `arch:session:${sessionId}:turn_lock`;
}

function fencingTokenKey(sessionId: string): string {
  return `arch:session:${sessionId}:fencing_token`;
}

function abortIntentKey(sessionId: string, turnId: string): string {
  return `arch:session:${sessionId}:abort:${turnId}`;
}

// ─── Lua scripts (inline, per D-17) ──────────────────────────────────────

/**
 * Renewal — extends PEXPIRE only if the lock value still belongs to the caller.
 * KEYS[1]: lock key
 * ARGV[1]: workerId (must match the worker field inside the JSON-encoded value)
 * ARGV[2]: new PEXPIRE (ms)
 *
 * Returns 1 on successful renewal, 0 if another worker now owns the lock.
 */
const LUA_RENEW_LOCK = `
  local v = redis.call('GET', KEYS[1])
  if not v then
    return 0
  end
  local ok, decoded = pcall(cjson.decode, v)
  if not ok or type(decoded) ~= 'table' then
    return 0
  end
  if decoded.workerId ~= ARGV[1] then
    return 0
  end
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
  return 1
`;

/**
 * Release — compare-and-delete only if the lock still belongs to the caller.
 * KEYS[1]: lock key
 * ARGV[1]: workerId
 *
 * Returns 1 if deleted, 0 if another worker now owns or the lock is absent.
 */
const LUA_RELEASE_LOCK = `
  local v = redis.call('GET', KEYS[1])
  if not v then
    return 0
  end
  local ok, decoded = pcall(cjson.decode, v)
  if not ok or type(decoded) ~= 'table' then
    return 0
  end
  if decoded.workerId ~= ARGV[1] then
    return 0
  end
  return redis.call('DEL', KEYS[1])
`;

// ioredis defineCommand adds a typed method on the client instance.
// We widen the type locally to narrow at call sites.
interface ArchLockCommands {
  archRenewLock: (key: string, workerId: string, ttlMs: string) => Promise<number>;
  archReleaseLock: (key: string, workerId: string) => Promise<number>;
}

type ArchLockRedis = RedisClient & ArchLockCommands;

const registered = new WeakSet<object>();

/**
 * Idempotently register the named Lua commands on the client. Safe to call
 * every invocation — WeakSet ensures per-client one-time registration.
 */
function ensureCommands(client: RedisClient): ArchLockRedis {
  if (!registered.has(client as unknown as object)) {
    const c = client as unknown as {
      defineCommand: (name: string, opts: { numberOfKeys: number; lua: string }) => void;
    };
    c.defineCommand('archRenewLock', { numberOfKeys: 1, lua: LUA_RENEW_LOCK });
    c.defineCommand('archReleaseLock', { numberOfKeys: 1, lua: LUA_RELEASE_LOCK });
    registered.add(client as unknown as object);
  }
  return client as ArchLockRedis;
}

// ─── Public API ──────────────────────────────────────────────────────────

export interface AcquireResult {
  acquired: boolean;
  fencingToken: number;
}

export interface LockValue {
  workerId: string;
  fencingToken: number;
}

/**
 * Attempt to acquire the turn lock for `sessionId`. On success, returns the
 * newly-issued `fencingToken` (monotonic). On contention, returns acquired:false.
 *
 * The fencing counter is incremented on EVERY attempt — even failed ones — so
 * the token strictly monotonic property holds for any successful acquisition.
 * This is deliberate and matches Martin Kleppmann's fencing-token pattern.
 */
export async function acquireTurnLock(
  redis: RedisClient,
  sessionId: string,
  workerId: string,
  ttlMs: number = ARCH_AI_LOCK.TURN_MAX_MS,
): Promise<AcquireResult> {
  const fencingToken = await redis.incr(fencingTokenKey(sessionId));
  const value: LockValue = { workerId, fencingToken };
  const result = await redis.set(lockKey(sessionId), JSON.stringify(value), 'PX', ttlMs, 'NX');
  return {
    acquired: result === 'OK',
    fencingToken,
  };
}

/**
 * Extend the lock TTL if we still own it. Call at LOCK_RENEW_INTERVAL_MS cadence
 * from the turn worker. Returns false if the lock has been taken over — caller
 * must immediately abort the turn (spec §6.4.1: "zombie writes after lock
 * takeover" prevention).
 */
export async function renewTurnLock(
  redis: RedisClient,
  sessionId: string,
  workerId: string,
  ttlMs: number = ARCH_AI_LOCK.TURN_MAX_MS,
): Promise<boolean> {
  const client = ensureCommands(redis);
  const result = await client.archRenewLock(lockKey(sessionId), workerId, ttlMs.toString());
  return result === 1;
}

/**
 * Release the lock if we still own it (compare-and-delete).
 * Returns true if the key was actually deleted, false if it had already been
 * taken over or expired.
 */
export async function releaseTurnLock(
  redis: RedisClient,
  sessionId: string,
  workerId: string,
): Promise<boolean> {
  const client = ensureCommands(redis);
  const result = await client.archReleaseLock(lockKey(sessionId), workerId);
  return result === 1;
}

/**
 * Start a self-renewing loop. Returns a `stop()` handle.
 *
 * On renewal failure, calls `onRenewalFailed` so the caller can abort the
 * in-flight turn (the worker no longer owns the lock — any further writes
 * would be rejected by the fencing-token filter on TurnBuffer.commit anyway,
 * but graceful abort emits turn_ended.reason: 'worker_lost').
 */
export function startRenewalLoop(
  redis: RedisClient,
  sessionId: string,
  workerId: string,
  onRenewalFailed: () => void,
  intervalMs: number = ARCH_AI_LOCK.LOCK_RENEW_INTERVAL_MS,
  ttlMs: number = ARCH_AI_LOCK.TURN_MAX_MS,
): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    renewTurnLock(redis, sessionId, workerId, ttlMs).then(
      (ok) => {
        if (!ok && !stopped) {
          stopped = true;
          clearInterval(timer);
          onRenewalFailed();
        }
      },
      () => {
        // Redis unavailable — treat the same as lock loss.
        if (!stopped) {
          stopped = true;
          clearInterval(timer);
          onRenewalFailed();
        }
      },
    );
  }, intervalMs);
  // Node's setInterval handle keeps the event loop alive — unref so it
  // doesn't block process shutdown.
  if (typeof timer.unref === 'function') timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

// ─── Abort intent (Redis pub/sub companion) ──────────────────────────────

/**
 * Write abort intent alongside the pub/sub publish. Pub/sub is fire-and-forget,
 * so the worker ALSO polls this key each turn-loop iteration to catch the abort
 * signal if the subscription dropped. Spec §5.6.
 */
export async function writeAbortIntent(
  redis: RedisClient,
  sessionId: string,
  turnId: string,
  requesterId: string,
  ttlMs: number = 60_000,
): Promise<void> {
  await redis.set(abortIntentKey(sessionId, turnId), requesterId, 'PX', ttlMs);
}

/**
 * Poll the abort intent key — returns the requester ID if an abort has been
 * requested, null otherwise. Worker should call this on every loop iteration
 * as a fallback for missed pub/sub messages.
 */
export async function readAbortIntent(
  redis: RedisClient,
  sessionId: string,
  turnId: string,
): Promise<string | null> {
  return redis.get(abortIntentKey(sessionId, turnId));
}

/**
 * Clear the abort intent after the worker has acted on it.
 */
export async function clearAbortIntent(
  redis: RedisClient,
  sessionId: string,
  turnId: string,
): Promise<void> {
  await redis.del(abortIntentKey(sessionId, turnId));
}

// ─── Test helpers (exported for unit tests only) ─────────────────────────

export const __test__ = {
  lockKey,
  fencingTokenKey,
  abortIntentKey,
  LUA_RENEW_LOCK,
  LUA_RELEASE_LOCK,
};

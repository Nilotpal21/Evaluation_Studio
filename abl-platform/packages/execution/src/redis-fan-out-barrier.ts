/**
 * RedisFanOutBarrierStore — Redis-backed distributed fan-out barrier.
 *
 * Key structure (cluster-safe — all keys for a given barrier share a slot
 * via the `{barrierId}` hash tag):
 *   barrier:{barrierId}                       HASH    metadata + counters
 *   barrier:{barrierId}:result-keys           SET     branch keys in this barrier
 *   barrier:{barrierId}:result:{branchKey}    STRING  JSON(BranchResult)
 *
 * The hardened completeBranch() Lua script is idempotent per branch key:
 * - closed/expired barriers ignore late arrivals
 * - duplicate branch completions are ignored
 * - terminal counters advance exactly once per branch
 * - parentResumeReady flips exactly once when all branches are terminal
 *
 * Result enumeration uses a registry SET (`:result-keys`) instead of
 * `redis.call('KEYS', ...)` — `KEYS` returns partial results in cluster mode
 * and is not allowed inside Lua. Every branch result write atomically also
 * SADDs its branch key to the registry so getResults / delete can iterate.
 */

import crypto from 'crypto';
import { runLuaScript, hashTag, type LuaScript } from '@agent-platform/redis';
import {
  getBranchResultKey,
  type FanOutBarrier,
  type FanOutBarrierStore,
  type BranchResult,
} from './fan-out-barrier.js';
import type { RedisClient } from './redis-callback-registry.js';

// TTL is passed as the LAST ARGV (not as a key). The previous form passed it
// as KEYS[2] = "300" — a literal string — which Redis Cluster hashes onto a
// completely different slot from the barrier hash → CROSSSLOT on every create.
const SCRIPT_CREATE_BARRIER: LuaScript = {
  name: 'fan_out.create_barrier',
  numberOfKeys: 1,
  body: `
  local ttl = tonumber(ARGV[#ARGV])
  for i = 1, #ARGV - 1, 2 do
    redis.call('HSET', KEYS[1], ARGV[i], ARGV[i+1])
  end
  redis.call('EXPIRE', KEYS[1], ttl)
  return 1
`,
};

const LUA_COMPLETE_BRANCH = `
  if redis.call('EXISTS', KEYS[1]) == 0 then
    return {'barrier_missing', 0, 0, 0}
  end

  local status = redis.call('HGET', KEYS[1], 'status')
  if not status or status == '' then
    status = 'open'
  end

  local expiresAt = tonumber(redis.call('HGET', KEYS[1], 'expiresAt') or '0')

  if status ~= 'open' then
    redis.call('HINCRBY', KEYS[1], 'ignoredLateArrivals', 1)
    return {
      'ignored_late',
      tonumber(redis.call('HGET', KEYS[1], 'completedBranches') or '0'),
      tonumber(redis.call('HGET', KEYS[1], 'totalBranches') or '0'),
      tonumber(redis.call('HGET', KEYS[1], 'parentResumeReady') or '0')
    }
  end

  if expiresAt > 0 and expiresAt <= tonumber(ARGV[3]) then
    redis.call('HSET', KEYS[1], 'status', 'expired')
    redis.call('HSET', KEYS[1], 'closedAt', ARGV[3])
    redis.call('HINCRBY', KEYS[1], 'ignoredLateArrivals', 1)
    return {
      'ignored_late',
      tonumber(redis.call('HGET', KEYS[1], 'completedBranches') or '0'),
      tonumber(redis.call('HGET', KEYS[1], 'totalBranches') or '0'),
      tonumber(redis.call('HGET', KEYS[1], 'parentResumeReady') or '0')
    }
  end

  if redis.call('EXISTS', KEYS[2]) == 1 then
    return {
      'duplicate',
      tonumber(redis.call('HGET', KEYS[1], 'completedBranches') or '0'),
      tonumber(redis.call('HGET', KEYS[1], 'totalBranches') or '0'),
      tonumber(redis.call('HGET', KEYS[1], 'parentResumeReady') or '0')
    }
  end

  redis.call('SET', KEYS[2], ARGV[1])
  redis.call('EXPIRE', KEYS[2], tonumber(ARGV[2]))

  -- Register the branch key in the per-barrier result-keys SET so getResults /
  -- delete can iterate without a top-level KEYS scan. KEYS[3] shares the
  -- {barrierId} hash tag with KEYS[1] / KEYS[2] → same slot, atomic.
  redis.call('SADD', KEYS[3], ARGV[4])
  redis.call('EXPIRE', KEYS[3], tonumber(ARGV[2]))

  local completed = redis.call('HINCRBY', KEYS[1], 'completedBranches', 1)
  redis.call('HSET', KEYS[1], 'terminalBranches', completed)

  local total = tonumber(redis.call('HGET', KEYS[1], 'totalBranches') or '0')
  local parentReady = tonumber(redis.call('HGET', KEYS[1], 'parentResumeReady') or '0')

  if completed >= total and parentReady == 0 then
    redis.call('HSET', KEYS[1], 'parentResumeReady', '1')
    redis.call('HSET', KEYS[1], 'status', 'completed')
    redis.call('HSET', KEYS[1], 'closedAt', ARGV[3])
    parentReady = 1
  end

  return {'recorded', completed, total, parentReady}
`;

const SCRIPT_COMPLETE_BRANCH: LuaScript = {
  name: 'fan_out.complete_branch',
  numberOfKeys: 3,
  body: LUA_COMPLETE_BRANCH,
};

const SCRIPT_GET_HASH_FIELD: LuaScript = {
  name: 'fan_out.get_hash_field',
  numberOfKeys: 1,
  body: `return redis.call('HGET', KEYS[1], ARGV[1])`,
};

const SCRIPT_GET_ALL_HASH_FIELDS: LuaScript = {
  name: 'fan_out.get_all_hash_fields',
  numberOfKeys: 1,
  body: `return redis.call('HGETALL', KEYS[1])`,
};

// Iterate the registry SET (KEYS[2]) to discover branch keys, then GET each
// per-branch result. All keys share the {barrierId} hash tag → same slot.
const SCRIPT_SCAN_RESULT_KEYS: LuaScript = {
  name: 'fan_out.scan_result_keys',
  numberOfKeys: 2,
  body: `
  local keys = redis.call('SMEMBERS', KEYS[2])
  local results = {}
  for _, branchKey in ipairs(keys) do
    local fullKey = KEYS[1] .. ':result:' .. branchKey
    local value = redis.call('GET', fullKey)
    if value then
      table.insert(results, fullKey)
      table.insert(results, value)
    end
  end
  return results
`,
};

const SCRIPT_DELETE_BARRIER: LuaScript = {
  name: 'fan_out.delete_barrier',
  numberOfKeys: 2,
  body: `
  local keys = redis.call('SMEMBERS', KEYS[2])
  for _, branchKey in ipairs(keys) do
    local fullKey = KEYS[1] .. ':result:' .. branchKey
    redis.call('DEL', fullKey)
  end
  redis.call('DEL', KEYS[2])
  redis.call('DEL', KEYS[1])
  return 1
`,
};

const SCRIPT_SET_HASH_FIELD: LuaScript = {
  name: 'fan_out.set_hash_field',
  numberOfKeys: 1,
  body: `return redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])`,
};

const SCRIPT_CANCEL_BARRIER: LuaScript = {
  name: 'fan_out.cancel_barrier',
  numberOfKeys: 1,
  body: `
  redis.call('HSET', KEYS[1], 'status', 'cancelled')
  redis.call('HSET', KEYS[1], 'cancelReason', ARGV[1])
  redis.call('HSET', KEYS[1], 'closedAt', ARGV[2])
  return 1
`,
};

export class RedisFanOutBarrierStore implements FanOutBarrierStore {
  private readonly prefix = 'barrier';

  constructor(private readonly redis: RedisClient) {}

  async create(params: {
    parentSessionId: string;
    parentExecutionId: string;
    tenantId: string;
    totalBranches: number;
    timeoutMs: number;
  }): Promise<string> {
    const barrierId = crypto.randomUUID();
    const key = this.getBarrierKey(barrierId);
    const now = Date.now();
    const expiresAt = now + params.timeoutMs;
    const ttlSeconds = Math.ceil(params.timeoutMs / 1000);

    const fields = [
      'parentSessionId',
      params.parentSessionId,
      'parentExecutionId',
      params.parentExecutionId,
      'tenantId',
      params.tenantId,
      'totalBranches',
      String(params.totalBranches),
      'completedBranches',
      '0',
      'createdAt',
      String(now),
      'expiresAt',
      String(expiresAt),
      'status',
      'open',
      'parentResumeReady',
      '0',
      'terminalBranches',
      '0',
      'ignoredLateArrivals',
      '0',
    ];

    // Pass TTL as the LAST ARGV; the Lua script reads it via ARGV[#ARGV].
    // numberOfKeys=1 — the only key is the barrier hash (slot determined by
    // the {barrierId} hash tag).
    await runLuaScript(this.redis, SCRIPT_CREATE_BARRIER, [key], [...fields, String(ttlSeconds)]);
    return barrierId;
  }

  async completeBranch(
    barrierId: string,
    result: BranchResult,
  ): Promise<{
    allComplete: boolean;
    completedCount: number;
    totalCount: number;
    disposition?: 'recorded' | 'duplicate' | 'ignored_late' | 'barrier_missing';
    branchKey?: string;
    parentResumeReady?: boolean;
  }> {
    const barrierKey = this.getBarrierKey(barrierId);
    const branchKey = getBranchResultKey(result);
    const resultKey = this.getResultKey(barrierId, branchKey);
    const registryKey = this.getRegistryKey(barrierId);
    const expiresAtStr = await runLuaScript<string | null>(
      this.redis,
      SCRIPT_GET_HASH_FIELD,
      [barrierKey],
      ['expiresAt'],
    );
    const expiresAt = expiresAtStr ? Number(expiresAtStr) : Date.now() + 60_000;
    const ttlSeconds = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));

    const rawOutcome = await runLuaScript<Array<string | number>>(
      this.redis,
      SCRIPT_COMPLETE_BRANCH,
      [barrierKey, resultKey, registryKey],
      [JSON.stringify(result), String(ttlSeconds), String(Date.now()), branchKey],
    );

    const disposition = String(rawOutcome[0]) as
      | 'recorded'
      | 'duplicate'
      | 'ignored_late'
      | 'barrier_missing';
    const completedCount = Number(rawOutcome[1] ?? 0);
    const totalCount = Number(rawOutcome[2] ?? 0);
    const parentResumeReady = Number(rawOutcome[3] ?? 0) === 1;

    return {
      allComplete: completedCount >= totalCount && totalCount > 0,
      completedCount,
      totalCount,
      disposition,
      branchKey,
      parentResumeReady,
    };
  }

  async get(barrierId: string): Promise<FanOutBarrier | null> {
    const key = this.getBarrierKey(barrierId);
    const result = await runLuaScript<string[] | null>(
      this.redis,
      SCRIPT_GET_ALL_HASH_FIELDS,
      [key],
      [],
    );

    if (!result || result.length === 0) {
      return null;
    }

    const map = new Map<string, string>();
    for (let index = 0; index < result.length; index += 2) {
      map.set(result[index], result[index + 1]);
    }

    return {
      barrierId,
      parentSessionId: map.get('parentSessionId') || '',
      parentExecutionId: map.get('parentExecutionId') || '',
      tenantId: map.get('tenantId') || '',
      totalBranches: Number(map.get('totalBranches') || 0),
      completedBranches: Number(map.get('completedBranches') || 0),
      createdAt: Number(map.get('createdAt') || 0),
      expiresAt: Number(map.get('expiresAt') || 0),
      status: (map.get('status') as FanOutBarrier['status']) || 'open',
      parentResumeReady: map.get('parentResumeReady') === '1',
      closedAt: map.get('closedAt') ? Number(map.get('closedAt')) : undefined,
      terminalBranches: map.get('terminalBranches')
        ? Number(map.get('terminalBranches'))
        : undefined,
      ignoredLateArrivals: map.get('ignoredLateArrivals')
        ? Number(map.get('ignoredLateArrivals'))
        : undefined,
      parentSuspensionId: map.get('parentSuspensionId') || undefined,
    };
  }

  async getResults(barrierId: string): Promise<Record<string, BranchResult>> {
    const result = await runLuaScript<string[] | null>(
      this.redis,
      SCRIPT_SCAN_RESULT_KEYS,
      [this.getBarrierKey(barrierId), this.getRegistryKey(barrierId)],
      [],
    );

    const results: Record<string, BranchResult> = {};
    if (!result) {
      return results;
    }

    for (let index = 0; index < result.length; index += 2) {
      const parsed = JSON.parse(result[index + 1]) as BranchResult;
      results[getBranchResultKey(parsed)] = parsed;
    }

    return results;
  }

  async setParentSuspension(barrierId: string, suspensionId: string): Promise<void> {
    await runLuaScript(
      this.redis,
      SCRIPT_SET_HASH_FIELD,
      [this.getBarrierKey(barrierId)],
      ['parentSuspensionId', suspensionId],
    );
  }

  async getParentSuspension(barrierId: string): Promise<string | null> {
    const result = await runLuaScript<string | null>(
      this.redis,
      SCRIPT_GET_HASH_FIELD,
      [this.getBarrierKey(barrierId)],
      ['parentSuspensionId'],
    );
    return result || null;
  }

  async cancel(barrierId: string, reason: string): Promise<void> {
    await runLuaScript(
      this.redis,
      SCRIPT_CANCEL_BARRIER,
      [this.getBarrierKey(barrierId)],
      [reason, String(Date.now())],
    );
  }

  async delete(barrierId: string): Promise<void> {
    await runLuaScript(
      this.redis,
      SCRIPT_DELETE_BARRIER,
      [this.getBarrierKey(barrierId), this.getRegistryKey(barrierId)],
      [],
    );
  }

  // Hash-tagged via `hashTag(barrierId)` so all per-barrier keys land on the
  // same cluster slot. Standalone mode is unaffected — braces are inert.
  private getBarrierKey(barrierId: string): string {
    return `${this.prefix}:${hashTag(barrierId)}`;
  }

  private getResultKey(barrierId: string, branchKey: string): string {
    return `${this.prefix}:${hashTag(barrierId)}:result:${branchKey}`;
  }

  private getRegistryKey(barrierId: string): string {
    return `${this.prefix}:${hashTag(barrierId)}:result-keys`;
  }
}

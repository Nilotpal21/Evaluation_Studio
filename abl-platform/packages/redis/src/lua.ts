/**
 * Cluster-safe Lua script execution wrapper.
 *
 * `runLuaScript` calls `client.eval(...)` — ioredis manages `EVALSHA` + `NOSCRIPT`
 * fallback transparently for both `Redis` and `Cluster`. We do NOT cache SHA1
 * digests ourselves; that duplicates ioredis's internal logic and introduces
 * "script not found on this node" bugs.
 *
 * In cluster mode, all `keys` MUST share a hash tag (use `hashTag(...)`) or
 * Redis returns `CROSSSLOT` — which we surface as `RedisCrossSlotError` and
 * count via `redis.crossslot.errors`. CROSSSLOT is a programming error, not
 * a transient cluster event; callers must NOT retry.
 */

import type { RedisClient } from './types.js';
import { RedisCrossSlotError, RedisOperationError } from './errors.js';
import { crossslotErrors } from './observability.js';

export interface LuaScript {
  /** Human-readable name for error messages and metrics. */
  name: string;
  /** Lua script body. */
  body: string;
  /** Number of leading args that are KEYS (rest become ARGV). */
  numberOfKeys: number;
}

/**
 * Run a Lua script against Redis (standalone or cluster).
 *
 * **Cluster requirement**: all `keys` must hash to the same slot. Use
 * `hashTag(...)` to enforce this. Cross-slot keys throw `RedisCrossSlotError`.
 *
 * **ARGV normalization**: all `args` are coerced to strings via `String()`
 * before EVAL. Redis ARGV is always a string at the protocol level; this
 * removes ambiguity for callers passing numbers.
 *
 * **No retries**: this wrapper does not retry on CROSSSLOT (programming error).
 * `NOSCRIPT` is handled transparently by ioredis. Other `ReplyError`s (e.g.,
 * `BUSY`) propagate as-is wrapped in `RedisOperationError`.
 *
 * @typeParam T - Expected return type from the Lua script
 */
export async function runLuaScript<T = unknown>(
  client: RedisClient,
  script: LuaScript,
  keys: string[],
  args: ReadonlyArray<string | number>,
): Promise<T> {
  if (keys.length !== script.numberOfKeys) {
    throw new RedisOperationError(
      `Lua script "${script.name}" expects ${script.numberOfKeys} keys, got ${keys.length}`,
    );
  }

  const stringArgs = args.map(String);
  try {
    // ioredis's eval signature: eval(script, numkeys, ...keys, ...args)
    const result = await (client as { eval: (...args: unknown[]) => Promise<unknown> }).eval(
      script.body,
      script.numberOfKeys,
      ...keys,
      ...stringArgs,
    );
    return result as T;
  } catch (err) {
    if (isCrossSlot(err)) {
      crossslotErrors.add(1, { script: script.name });
      throw new RedisCrossSlotError(script.name, keys, err);
    }
    if (err instanceof Error) {
      throw new RedisOperationError(`Lua script "${script.name}" failed: ${err.message}`, err);
    }
    throw new RedisOperationError(`Lua script "${script.name}" failed`, err);
  }
}

function isCrossSlot(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && message.startsWith('CROSSSLOT');
}

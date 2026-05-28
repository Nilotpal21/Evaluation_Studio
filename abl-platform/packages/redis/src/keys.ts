/**
 * Cluster-safe key utilities.
 *
 * - `hashTag(...parts)` — wraps parts in `{...}` so all keys derived from the
 *   same parts hash to the same cluster slot. Required for any multi-key Lua
 *   script or `MULTI` block in cluster mode.
 *
 * - `scanKeys(client, pattern)` — async iterable replacement for `KEYS`.
 *   In cluster mode, iterates every master with per-node `SCAN` and dedupes
 *   keys observed during slot migration. Top-level `KEYS` returns partial
 *   results in cluster mode and is forbidden by lint.
 */

import { Redis } from 'ioredis';
import type { RedisClient } from './types.js';
import { scanKeysNodeError } from './observability.js';
import { RedisOperationError } from './errors.js';

/**
 * Wrap parts in a Redis cluster hash tag.
 *
 * `hashTag('tenant42', 'session99')` → `'{tenant42:session99}'`
 *
 * Keys built around the same hash tag are guaranteed to land on the same slot,
 * which is the cluster requirement for `MULTI`, multi-key Lua scripts, and
 * `MGET`/`MSET`.
 */
export function hashTag(...parts: string[]): string {
  return '{' + parts.join(':') + '}';
}

/** Default cap on the cluster-mode dedupe set. Throws when exceeded. */
export const DEFAULT_SCAN_KEYS_MAX = 100_000;

/**
 * Async iterable over keys matching `pattern`, safe in both standalone and cluster modes.
 *
 * **Cluster mode** iterates every master node with per-node `SCAN`; an in-memory
 * `Set` dedupes keys that may appear on both source and target masters during
 * slot migration. The set is bounded by `maxKeys` (default 100k) — when the
 * cap is exceeded the function throws `RedisOperationError` rather than
 * silently growing memory; callers with truly unbounded patterns should use
 * the underlying ioredis cursor API directly and tolerate duplicates.
 *
 * **Standalone mode** is a single cursor loop; no dedupe needed and `maxKeys`
 * is not applied (the cursor iterates the whole keyspace once).
 *
 * On per-node failure in cluster mode, the function increments
 * `redis.scan_keys.node_error`, refreshes the master list once, and skips the
 * failed node on second failure — partial results are tolerated rather than
 * aborting the whole scan.
 *
 * @param client  ioredis Redis or Cluster
 * @param pattern Glob pattern (e.g., 'cache:def:*')
 * @param count   SCAN COUNT hint per round (default 1000)
 * @param maxKeys Cluster-mode safety cap on the dedupe set (default 100,000).
 *                Throws `RedisOperationError` if exceeded.
 */
export async function* scanKeys(
  client: RedisClient,
  pattern: string,
  count = 1000,
  maxKeys = DEFAULT_SCAN_KEYS_MAX,
): AsyncIterable<string> {
  // Standalone path: real Redis instance OR any client that lacks the cluster
  // `nodes()` method (e.g. plain test mocks).  Duck-typing here avoids an
  // `instanceof` check that breaks when the client was created in a different
  // module scope or is a test double.
  if (client instanceof Redis || typeof (client as any).nodes !== 'function') {
    yield* scanSingleNode(client as Redis, pattern, count);
    return;
  }

  // Cluster path
  const seen = new Set<string>();
  let masters = (client as any).nodes('master') as Redis[];

  for (const master of masters) {
    try {
      yield* scanWithDedupe(master, pattern, count, seen, maxKeys);
    } catch (err) {
      if (err instanceof RedisOperationError) throw err; // re-throw maxKeys cap
      scanKeysNodeError.add(1);
      // Refresh masters once and retry the failed node — slot map may have changed.
      try {
        masters = (client as any).nodes('master') as Redis[];
        const refreshed = masters.find(
          (m) =>
            m.options?.host === master.options?.host && m.options?.port === master.options?.port,
        );
        if (refreshed) {
          yield* scanWithDedupe(refreshed, pattern, count, seen, maxKeys);
        }
      } catch (retryErr) {
        if (retryErr instanceof RedisOperationError) throw retryErr;
        // Skip this node on second failure — partial results are tolerable.
      }
    }
  }
}

async function* scanSingleNode(node: Redis, pattern: string, count: number): AsyncIterable<string> {
  let cursor = '0';
  do {
    const [next, batch] = await node.scan(cursor, 'MATCH', pattern, 'COUNT', count);
    cursor = next;
    for (const key of batch) yield key;
  } while (cursor !== '0');
}

async function* scanWithDedupe(
  node: Redis,
  pattern: string,
  count: number,
  seen: Set<string>,
  maxKeys: number,
): AsyncIterable<string> {
  let cursor = '0';
  do {
    const [next, batch] = await node.scan(cursor, 'MATCH', pattern, 'COUNT', count);
    cursor = next;
    for (const key of batch) {
      if (!seen.has(key)) {
        if (seen.size >= maxKeys) {
          throw new RedisOperationError(
            `scanKeys: dedupe set exceeded maxKeys=${maxKeys} for pattern "${pattern}". ` +
              'Caller should use a more specific pattern or consume the ioredis cursor directly.',
          );
        }
        seen.add(key);
        yield key;
      }
    }
  } while (cursor !== '0');
}

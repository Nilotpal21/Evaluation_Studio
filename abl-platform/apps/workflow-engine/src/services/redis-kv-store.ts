/**
 * Redis-backed `KeyValueStore` for connector actions.
 *
 * LLD §3 Phase 3 Task 3.1: provides a TTL-bearing key/value store so connector
 * actions running inside a workflow step can stash state across Restate replays
 * (e.g. Azure DI stashes its `operation-location` so a re-executed `run(ctx)`
 * skips the POST and resumes polling — without this, every replay would re-POST
 * `:analyze` and re-charge the tenant). Restate's own `WorkflowContext` exposes
 * `sleep` / `run` / `promise` only — no TTL-bearing KV — so Redis is the right
 * backing.
 *
 * Key shape: actions choose the key (e.g. `azuredi:${executionId}:${stepId}`).
 * This helper prefixes every key with `connector-kv:` so the namespace is
 * visible in Redis tooling and can't collide with BullMQ / rate-limit keys.
 *
 * Implements `KeyValueStore` from `@agent-platform/connectors`. The interface
 * stores arbitrary JSON-serialisable values; this store JSON-encodes on write
 * and parses on read.
 */

import type { KeyValueStore } from '@agent-platform/connectors';
import type { RedisClient } from '@agent-platform/redis';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('redis-kv-store');

export class RedisKvStore implements KeyValueStore {
  private readonly redis: RedisClient;
  private readonly keyPrefix: string;

  constructor(redis: RedisClient, keyPrefix = 'connector-kv:') {
    this.redis = redis;
    this.keyPrefix = keyPrefix;
  }

  private prefixed(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const raw = await this.redis.get(this.prefixed(key));
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      log.warn('Failed to parse JSON for RedisKvStore key — treating as miss', {
        key: this.prefixed(key),
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    const payload = JSON.stringify(value);
    const prefixed = this.prefixed(key);
    if (typeof ttlMs === 'number' && ttlMs > 0) {
      // PX = millisecond expiry. Supported on both ioredis Redis and Cluster.
      await this.redis.set(prefixed, payload, 'PX', ttlMs);
    } else {
      await this.redis.set(prefixed, payload);
    }
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(this.prefixed(key));
  }
}

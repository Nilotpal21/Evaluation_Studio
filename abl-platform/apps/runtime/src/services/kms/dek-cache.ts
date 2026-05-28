/**
 * Multi-Layer DEK Cache
 *
 * Follows the SessionService L1/L2 pattern:
 *   L1: In-process LRU (5min TTL) — pod-local, zero latency
 *   L2: Redis HASH (30min TTL) — shared across pods
 *   L3: MongoDB DEKEntry — persistent, authoritative
 *   L4: KMS unwrap — cold path, ~50ms per call
 *
 * Unwrapped key material is zero-filled on eviction from L1.
 * L2 stores wrapped DEKs only (never plaintext in Redis).
 */

import { createLogger } from '@abl/compiler/platform';
import type { DEKScope } from '@agent-platform/database/kms';

const log = createLogger('dek-cache');

// =============================================================================
// L1: IN-PROCESS LRU CACHE
// =============================================================================

interface L1Entry {
  plaintext: Buffer;
  cachedAt: number;
}

export class DEKCacheL1 {
  private cache = new Map<string, L1Entry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(maxEntries = 100, ttlMs = 5 * 60 * 1000) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  private key(scope: DEKScope, dekId: string): string {
    return `${scope.tenantId}:${dekId}`;
  }

  get(scope: DEKScope, dekId: string): Buffer | null {
    const k = this.key(scope, dekId);
    const entry = this.cache.get(k);
    if (!entry) return null;

    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.evict(k);
      return null;
    }

    // LRU: move to end
    this.cache.delete(k);
    this.cache.set(k, entry);
    return entry.plaintext;
  }

  set(scope: DEKScope, dekId: string, plaintext: Buffer): void {
    const k = this.key(scope, dekId);

    if (this.cache.size >= this.maxEntries && !this.cache.has(k)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.evict(oldest);
    }

    this.cache.set(k, { plaintext: Buffer.from(plaintext), cachedAt: Date.now() });
  }

  private evict(key: string): void {
    const entry = this.cache.get(key);
    if (entry) {
      entry.plaintext.fill(0); // Security: zero-fill
      this.cache.delete(key);
    }
  }

  evictTenant(tenantId: string): number {
    let count = 0;
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${tenantId}:`)) {
        this.evict(key);
        count++;
      }
    }
    return count;
  }

  clear(): void {
    for (const entry of this.cache.values()) {
      entry.plaintext.fill(0);
    }
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

// =============================================================================
// L2: REDIS HASH CACHE (wrapped DEKs only — never plaintext)
// =============================================================================

export class DEKCacheL2 {
  private readonly ttlSeconds: number;
  private readonly keyPrefix = 'dek:wrapped:';

  constructor(ttlSeconds = 30 * 60) {
    this.ttlSeconds = ttlSeconds;
  }

  private redisKey(scope: DEKScope, dekId: string): string {
    return `${this.keyPrefix}${scope.tenantId}:${dekId}`;
  }

  async getWrapped(
    scope: DEKScope,
    dekId: string,
  ): Promise<{ wrappedDek: string; kekKeyId: string; kekKeyVersion: number } | null> {
    try {
      const { getRedisClient, isRedisAvailable } = await import('../redis/redis-client.js');
      if (!isRedisAvailable()) return null;

      const redis = getRedisClient();
      if (!redis) return null;

      const key = this.redisKey(scope, dekId);
      const data = await redis.hgetall(key);

      if (!data.wrappedDek) return null;

      return {
        wrappedDek: data.wrappedDek,
        kekKeyId: data.kekKeyId,
        kekKeyVersion: parseInt(data.kekKeyVersion || '1', 10),
      };
    } catch (err) {
      log.debug('L2 DEK cache read failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async setWrapped(
    scope: DEKScope,
    dekId: string,
    wrappedDek: string,
    kekKeyId: string,
    kekKeyVersion: number,
  ): Promise<void> {
    try {
      const { getRedisClient, isRedisAvailable } = await import('../redis/redis-client.js');
      if (!isRedisAvailable()) return;

      const redis = getRedisClient();
      if (!redis) return;

      const key = this.redisKey(scope, dekId);
      await redis.hset(key, {
        wrappedDek,
        kekKeyId,
        kekKeyVersion: kekKeyVersion.toString(),
      });
      await redis.expire(key, this.ttlSeconds);
    } catch (err) {
      log.debug('L2 DEK cache write failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// =============================================================================
// MULTI-LAYER DEK CACHE
// =============================================================================

export class MultiLayerDEKCache {
  private l1: DEKCacheL1;
  private l2: DEKCacheL2;

  constructor(l1Options?: { maxEntries?: number; ttlMs?: number }, l2TtlSeconds?: number) {
    this.l1 = new DEKCacheL1(l1Options?.maxEntries, l1Options?.ttlMs);
    this.l2 = new DEKCacheL2(l2TtlSeconds);
  }

  /** Get plaintext DEK from L1 cache */
  getPlaintext(scope: DEKScope, dekId: string): Buffer | null {
    return this.l1.get(scope, dekId);
  }

  /** Set plaintext DEK in L1 cache */
  setPlaintext(scope: DEKScope, dekId: string, plaintext: Buffer): void {
    this.l1.set(scope, dekId, plaintext);
  }

  /** Get wrapped DEK from L2 (Redis) cache */
  async getWrapped(scope: DEKScope, dekId: string) {
    return this.l2.getWrapped(scope, dekId);
  }

  /** Set wrapped DEK in L2 (Redis) cache */
  async setWrapped(
    scope: DEKScope,
    dekId: string,
    wrappedDek: string,
    kekKeyId: string,
    kekKeyVersion: number,
  ) {
    await this.l2.setWrapped(scope, dekId, wrappedDek, kekKeyId, kekKeyVersion);
  }

  /** Evict all cached DEKs for a tenant (L1 only — L2 uses TTL) */
  evictTenant(tenantId: string): number {
    return this.l1.evictTenant(tenantId);
  }

  /** Clear all caches */
  clear(): void {
    this.l1.clear();
  }

  get l1Size(): number {
    return this.l1.size;
  }
}

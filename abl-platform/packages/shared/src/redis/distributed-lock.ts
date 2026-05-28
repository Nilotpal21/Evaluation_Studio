/**
 * Distributed Lock Utility
 *
 * Provides Redis-based distributed locking for coordinating work across multiple pods.
 * Uses Redis SET NX PX pattern (set if not exists with expiry).
 *
 * Use cases:
 * - Prevent concurrent connector syncs across multiple worker pods
 * - Ensure only one pod processes a specific resource at a time
 * - Coordinate singleton operations in distributed deployments
 */

import { runLuaScript } from '@agent-platform/redis';
import type { LuaScript, RedisClient } from '@agent-platform/redis';

const RELEASE_SCRIPT: LuaScript = {
  name: 'distributed-lock:release',
  body: `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    else
      return 0
    end
  `,
  numberOfKeys: 1,
};

const EXTEND_SCRIPT: LuaScript = {
  name: 'distributed-lock:extend',
  body: `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("PEXPIRE", KEYS[1], ARGV[2])
    else
      return 0
    end
  `,
  numberOfKeys: 1,
};

export interface LockOptions {
  /** Lock key prefix (e.g., 'sync-lock', 'webhook-lock') */
  keyPrefix: string;
  /** Lock TTL in milliseconds (default: 3600000 = 1 hour) */
  ttlMs?: number;
  /** Retry attempts if lock acquisition fails (default: 0 = no retry) */
  retryAttempts?: number;
  /** Retry delay in milliseconds (default: 1000 = 1 second) */
  retryDelayMs?: number;
}

export interface Lock {
  /** Lock key */
  key: string;
  /** Lock value (unique identifier for this lock holder) */
  value: string;
  /** Lock expiry timestamp */
  expiresAt: Date;
}

/**
 * Distributed lock manager using Redis.
 */
export class DistributedLockManager {
  private redis: RedisClient;

  /**
   * @param redis - A Redis or Cluster client. All lock operations are
   *   single-key SET NX PX (cluster-safe — every operation hits exactly
   *   one slot), so the wider `RedisClient` (= `Redis | Cluster`) type is
   *   accepted to allow cluster-mode runtime deployments without an
   *   `as Redis` cast at the call site.
   */
  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  /**
   * Acquire a distributed lock.
   *
   * @param resourceId - Resource to lock (e.g., connectorId, jobId)
   * @param options - Lock configuration
   * @returns Lock object if acquired, null if already locked
   *
   * @example
   * ```typescript
   * const lock = await lockManager.acquire(connectorId, {
   *   keyPrefix: 'sync-lock',
   *   ttlMs: 3600000, // 1 hour
   *   retryAttempts: 3,
   *   retryDelayMs: 1000
   * });
   *
   * if (!lock) {
   *   throw new Error('Resource is already locked');
   * }
   *
   * try {
   *   // Perform work...
   * } finally {
   *   await lockManager.release(lock);
   * }
   * ```
   */
  async acquire(resourceId: string, options: LockOptions): Promise<Lock | null> {
    const {
      keyPrefix,
      ttlMs = 3600000, // 1 hour default
      retryAttempts = 0,
      retryDelayMs = 1000,
    } = options;

    const key = `${keyPrefix}:${resourceId}`;
    const value = this.generateLockValue();
    const expiresAt = new Date(Date.now() + ttlMs);

    // Try to acquire lock with retries
    for (let attempt = 0; attempt <= retryAttempts; attempt++) {
      // SET NX PX: Set if not exists with expiry
      const result = await this.redis.set(key, value, 'PX', ttlMs, 'NX');

      if (result === 'OK') {
        return { key, value, expiresAt };
      }

      // Lock already held by another process
      if (attempt < retryAttempts) {
        // Wait before retrying
        await this.sleep(retryDelayMs);
      }
    }

    // Failed to acquire lock after all retries
    return null;
  }

  /**
   * Release a distributed lock.
   *
   * @param lock - Lock to release
   * @returns true if released, false if lock was already released or expired
   *
   * Uses Lua script to ensure atomic check-and-delete:
   * - Only the lock holder (matching value) can release the lock
   * - Prevents accidental release of locks acquired by other processes
   */
  async release(lock: Lock): Promise<boolean> {
    const result = await runLuaScript<number>(this.redis, RELEASE_SCRIPT, [lock.key], [lock.value]);
    return result === 1;
  }

  /**
   * Check if a resource is currently locked.
   *
   * @param resourceId - Resource to check
   * @param keyPrefix - Lock key prefix
   * @returns Lock info if locked, null if available
   */
  async isLocked(resourceId: string, keyPrefix: string): Promise<Lock | null> {
    const key = `${keyPrefix}:${resourceId}`;
    const value = await this.redis.get(key);

    if (!value) {
      return null; // Not locked
    }

    // Get TTL to calculate expiry
    const ttl = await this.redis.pttl(key);
    const expiresAt = ttl > 0 ? new Date(Date.now() + ttl) : new Date();

    return { key, value, expiresAt };
  }

  /**
   * Extend lock expiry (refresh TTL).
   *
   * @param lock - Lock to extend
   * @param ttlMs - New TTL in milliseconds
   * @returns true if extended, false if lock no longer held
   */
  async extend(lock: Lock, ttlMs: number): Promise<boolean> {
    const result = await runLuaScript<number>(
      this.redis,
      EXTEND_SCRIPT,
      [lock.key],
      [lock.value, String(ttlMs)],
    );
    if (result === 1) {
      lock.expiresAt = new Date(Date.now() + ttlMs);
      return true;
    }
    return false;
  }

  /**
   * Generate unique lock value (pod ID + timestamp + random).
   */
  private generateLockValue(): string {
    const podId = process.env.HOSTNAME || process.env.POD_NAME || 'local';
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    return `${podId}:${timestamp}:${random}`;
  }

  /**
   * Sleep for specified milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Hybrid Rate Limiter
 *
 * Redis primary + in-memory fallback. Auto-recovery timer (30s ping).
 * Follows the HybridCircuitBreakerRegistry pattern.
 */

import { InMemoryRateLimiter, type RateLimitOperation } from '../../middleware/rate-limiter.js';
import { RedisRateLimiter } from './redis-rate-limiter.js';
import { getRedisClient, isRedisAvailable } from '../redis/redis-client.js';
import { createLogger } from '@abl/compiler/platform';
import { recordRateLimiterFallback } from '../../observability/metrics.js';

const log = createLogger('hybrid-rate-limiter');

/** Parse an integer from an env var, returning the fallback on missing/NaN */
function safeParseInt(val: string | undefined, fallback: number): number {
  if (!val) return fallback;
  const parsed = parseInt(val, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Redis recovery check interval in ms (default: 30 seconds) */
const REDIS_RECOVERY_INTERVAL_MS = safeParseInt(process.env.REDIS_RECOVERY_INTERVAL_MS, 30_000);

let instance: HybridRateLimiter | null = null;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

export class HybridRateLimiter {
  private redisLimiter: RedisRateLimiter | null = null;
  private memoryLimiter: InMemoryRateLimiter;
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;
  private usingRedis = false;

  constructor() {
    this.memoryLimiter = new InMemoryRateLimiter();

    // Try Redis first
    const redis = getRedisClient();
    if (redis && isRedisAvailable()) {
      this.redisLimiter = new RedisRateLimiter(redis);
      this.usingRedis = true;
      log.info('Using Redis-backed distributed rate limiter');
    } else {
      log.info('Using in-memory rate limiter (Redis unavailable)');
      this.startRecoveryTimer();
    }
  }

  /**
   * Check and increment a rate limit counter.
   * Tries Redis first, falls back to in-memory on error.
   */
  async check(
    tenantId: string,
    operation: RateLimitOperation,
    limit: number,
    windowMs = 60000,
    increment = 1,
  ): Promise<RateLimitResult> {
    if (this.usingRedis && this.redisLimiter) {
      try {
        return await this.redisLimiter.check(tenantId, operation, limit, windowMs, increment);
      } catch (err) {
        log.warn('Redis error, falling back to in-memory', {
          error: err instanceof Error ? err.message : String(err),
        });
        this.usingRedis = false;
        recordRateLimiterFallback('redis_to_memory');
        this.startRecoveryTimer();
      }
    }

    return this.memoryLimiter.check(tenantId, operation, limit, windowMs, increment);
  }

  /**
   * Get current count without incrementing.
   */
  async peek(tenantId: string, operation: RateLimitOperation, windowMs = 60000): Promise<number> {
    if (this.usingRedis && this.redisLimiter) {
      try {
        return await this.redisLimiter.peek(tenantId, operation, windowMs);
      } catch {
        // Fall through to memory
      }
    }

    return this.memoryLimiter.peek(tenantId, operation, windowMs);
  }

  /** Check if using Redis or in-memory */
  isUsingRedis(): boolean {
    return this.usingRedis;
  }

  /**
   * Auto-recovery: periodically check if Redis becomes available.
   */
  private startRecoveryTimer(): void {
    if (this.recoveryTimer) return; // Already running

    this.recoveryTimer = setInterval(() => {
      const redis = getRedisClient();
      if (redis && isRedisAvailable()) {
        log.info('Redis recovered — switching to Redis limiter');
        this.redisLimiter = new RedisRateLimiter(redis);
        this.usingRedis = true;
        recordRateLimiterFallback('memory_to_redis');
        this.stopRecoveryTimer();
      }
    }, REDIS_RECOVERY_INTERVAL_MS);
    this.recoveryTimer.unref();
  }

  private stopRecoveryTimer(): void {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  /** Shutdown: stop recovery timer, destroy memory limiter */
  shutdown(): void {
    this.stopRecoveryTimer();
    this.memoryLimiter.destroy();
  }
}

/**
 * Get the singleton hybrid rate limiter.
 */
export function getHybridRateLimiter(): HybridRateLimiter {
  if (!instance) {
    instance = new HybridRateLimiter();
  }
  return instance;
}

/**
 * Reset singleton (for testing).
 */
export function resetHybridRateLimiter(): void {
  if (instance) {
    instance.shutdown();
    instance = null;
  }
}

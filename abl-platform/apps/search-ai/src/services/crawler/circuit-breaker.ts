/**
 * Circuit Breaker for Problematic Sites
 *
 * Tracks failures for domains and temporarily blocks them after repeated failures.
 * Uses Redis for distributed state across multiple pods.
 *
 * Architecture:
 * - Tenant-scoped: Domain blocking is per-tenant (prevents cross-tenant blocking)
 * - Redis-backed: Works across distributed pods
 * - Time-limited: Automatic recovery after block duration
 * - Manual override: UI can force retry on blocked domains
 */

import type { RedisClient } from '@agent-platform/redis';
import { scanKeys } from '@agent-platform/redis';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('circuit-breaker');

export interface CircuitBreakerConfig {
  failureThreshold: number; // Number of failures before opening circuit
  blockDurationMs: number; // How long to block the domain (milliseconds)
  failureWindowMs: number; // Sliding window for failure tracking
  redisKeyPrefix: string; // Prefix for Redis keys
}

export interface CircuitState {
  blocked: boolean;
  failureCount?: number;
  resetAt?: Date;
}

export class CircuitBreaker {
  private redis: RedisClient;
  private config: CircuitBreakerConfig;

  constructor(redis: RedisClient, config?: Partial<CircuitBreakerConfig>) {
    this.redis = redis;
    this.config = {
      failureThreshold: config?.failureThreshold ?? 5, // 5 failures
      blockDurationMs: config?.blockDurationMs ?? 300_000, // 5 minutes
      failureWindowMs: config?.failureWindowMs ?? 3_600_000, // 1 hour
      redisKeyPrefix: config?.redisKeyPrefix ?? 'crawler:cb',
    };

    logger.info('Circuit breaker initialized', {
      threshold: this.config.failureThreshold,
      blockDuration: `${this.config.blockDurationMs / 1000}s`,
      failureWindow: `${this.config.failureWindowMs / 1000}s`,
    });
  }

  /**
   * Execute a Redis operation with timeout to prevent hanging connections
   */
  private async withTimeout<T>(operation: Promise<T>, timeoutMs = 3000): Promise<T> {
    return Promise.race([
      operation,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error('Circuit breaker Redis operation timed out')), timeoutMs),
      ),
    ]);
  }

  /**
   * Extract domain from URL
   */
  private extractDomain(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.hostname;
    } catch {
      // If URL parsing fails, use the string as-is
      return url;
    }
  }

  /**
   * Generate Redis key for failure counter
   */
  private getFailureKey(domain: string, tenantId: string): string {
    return `${this.config.redisKeyPrefix}:${tenantId}:${domain}:failures`;
  }

  /**
   * Generate Redis key for blocked state
   */
  private getBlockedKey(domain: string, tenantId: string): string {
    return `${this.config.redisKeyPrefix}:${tenantId}:${domain}:blocked`;
  }

  /**
   * Record a failure for a domain
   * Opens circuit if threshold is reached
   */
  async recordFailure(url: string, tenantId: string, error?: string): Promise<void> {
    const domain = this.extractDomain(url);
    const failureKey = this.getFailureKey(domain, tenantId);
    const blockedKey = this.getBlockedKey(domain, tenantId);

    try {
      // Increment failure counter with sliding window TTL
      const failures = await this.withTimeout(this.redis.incr(failureKey));

      // Set expiry on first failure (sliding window)
      if (failures === 1) {
        await this.withTimeout(this.redis.pexpire(failureKey, this.config.failureWindowMs));
      }

      logger.warn('Failure recorded for domain', {
        domain,
        tenantId,
        failures,
        threshold: this.config.failureThreshold,
        error: error || 'unknown',
      });

      // Check if threshold reached
      if (failures >= this.config.failureThreshold) {
        // Open circuit - set blocked key with TTL
        const resetAt = Date.now() + this.config.blockDurationMs;
        await this.withTimeout(
          this.redis.set(
            blockedKey,
            JSON.stringify({ resetAt, failureCount: failures }),
            'PX',
            this.config.blockDurationMs,
          ),
        );

        logger.error('Circuit opened for domain', {
          domain,
          tenantId,
          failureCount: failures,
          blockDuration: `${this.config.blockDurationMs / 1000}s`,
          resetAt: new Date(resetAt).toISOString(),
        });
      }
    } catch (error) {
      logger.error('Failed to record failure', {
        domain,
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw - circuit breaker failures shouldn't break the app
    }
  }

  /**
   * Record a success for a domain
   * Resets failure counter and closes circuit if open
   */
  async recordSuccess(url: string, tenantId: string): Promise<void> {
    const domain = this.extractDomain(url);
    const failureKey = this.getFailureKey(domain, tenantId);
    const blockedKey = this.getBlockedKey(domain, tenantId);

    try {
      // Delete failure counter and blocked state
      await this.withTimeout(Promise.all([this.redis.del(failureKey), this.redis.del(blockedKey)]));

      logger.info('Success recorded for domain', {
        domain,
        tenantId,
      });
    } catch (error) {
      logger.error('Failed to record success', {
        domain,
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw
    }
  }

  /**
   * Check if circuit is open for a domain
   */
  async isOpen(url: string, tenantId: string): Promise<CircuitState> {
    const domain = this.extractDomain(url);
    const failureKey = this.getFailureKey(domain, tenantId);
    const blockedKey = this.getBlockedKey(domain, tenantId);

    try {
      // Check if domain is blocked
      const blockedData = await this.withTimeout(this.redis.get(blockedKey));

      if (blockedData) {
        const { resetAt, failureCount } = JSON.parse(blockedData);

        logger.warn('Circuit is open for domain', {
          domain,
          tenantId,
          resetAt: new Date(resetAt).toISOString(),
          failureCount,
        });

        return {
          blocked: true,
          failureCount,
          resetAt: new Date(resetAt),
        };
      }

      // Not blocked - return failure count for informational purposes
      const failureCount = await this.withTimeout(this.redis.get(failureKey));
      return {
        blocked: false,
        failureCount: failureCount ? parseInt(failureCount, 10) : 0,
      };
    } catch (error) {
      logger.error('Failed to check circuit state', {
        domain,
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });

      // On Redis failure, allow the operation (fail open)
      return { blocked: false };
    }
  }

  /**
   * Manually reset circuit for a domain (force unblock)
   */
  async reset(url: string, tenantId: string): Promise<void> {
    const domain = this.extractDomain(url);
    const failureKey = this.getFailureKey(domain, tenantId);
    const blockedKey = this.getBlockedKey(domain, tenantId);

    try {
      await this.withTimeout(Promise.all([this.redis.del(failureKey), this.redis.del(blockedKey)]));

      logger.info('Circuit manually reset for domain', {
        domain,
        tenantId,
      });
    } catch (error) {
      logger.error('Failed to reset circuit', {
        domain,
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error; // Throw on manual reset failures (user-initiated)
    }
  }

  /**
   * Get circuit statistics for monitoring
   */
  async getStats(tenantId: string): Promise<{
    blockedDomains: Array<{ domain: string; resetAt: Date; failureCount: number }>;
  }> {
    try {
      // Scan for all blocked keys for this tenant
      const pattern = `${this.config.redisKeyPrefix}:${tenantId}:*:blocked`;
      const keys: string[] = [];
      for await (const key of scanKeys(this.redis, pattern, 100)) {
        keys.push(key);
      }

      // Get data for each blocked domain
      const blockedDomains = await this.withTimeout(
        Promise.all(
          keys.map(async (key) => {
            const data = await this.redis.get(key);
            if (!data) return null;

            const { resetAt, failureCount } = JSON.parse(data);
            const domain = key.split(':')[3]; // Extract domain from key

            return { domain, resetAt: new Date(resetAt), failureCount };
          }),
        ),
      );

      return {
        blockedDomains: blockedDomains.filter((d) => d !== null) as Array<{
          domain: string;
          resetAt: Date;
          failureCount: number;
        }>,
      };
    } catch (error) {
      logger.error('Failed to get circuit breaker stats', {
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { blockedDomains: [] };
    }
  }
}

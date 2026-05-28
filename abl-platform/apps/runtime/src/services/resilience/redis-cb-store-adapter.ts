/**
 * Redis Circuit Breaker Store Adapter
 *
 * Implements CircuitBreakerStore using Redis hash keys with TTL.
 * Keys: cb:platform:{name} → hash with state, failures, successes, timestamps
 * TTL: 24 hours (auto-cleanup of stale breaker state)
 */

import type { CircuitBreakerStore, CircuitBreakerState } from './circuit-breaker.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('redis-cb-store');

const KEY_PREFIX = 'cb:platform:';
const TTL_SECONDS = 86400; // 24 hours

export class RedisCircuitBreakerStoreAdapter implements CircuitBreakerStore {
  private redis: any;

  constructor(redisClient: any) {
    this.redis = redisClient;
  }

  async getState(key: string): Promise<CircuitBreakerState | null> {
    try {
      const data = await this.redis.hgetall(`${KEY_PREFIX}${key}`);
      if (!data || Object.keys(data).length === 0) {
        return null;
      }
      return {
        state: data.state as CircuitBreakerState['state'],
        failures: parseInt(data.failures || '0', 10),
        successes: parseInt(data.successes || '0', 10),
        lastFailureTime: parseInt(data.lastFailureTime || '0', 10),
        lastStateChange: parseInt(data.lastStateChange || '0', 10),
        consecutiveSuccesses: parseInt(data.consecutiveSuccesses || '0', 10),
      };
    } catch (error) {
      log.error('Failed to get circuit breaker state', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async setState(key: string, state: CircuitBreakerState): Promise<void> {
    try {
      const redisKey = `${KEY_PREFIX}${key}`;
      await this.redis.hmset(redisKey, {
        state: state.state,
        failures: state.failures.toString(),
        successes: state.successes.toString(),
        lastFailureTime: state.lastFailureTime.toString(),
        lastStateChange: state.lastStateChange.toString(),
        consecutiveSuccesses: state.consecutiveSuccesses.toString(),
      });
      await this.redis.expire(redisKey, TTL_SECONDS);
    } catch (error) {
      log.error('Failed to set circuit breaker state', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

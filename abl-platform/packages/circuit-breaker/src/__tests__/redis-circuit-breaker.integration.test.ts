import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { RedisCircuitBreaker } from '../redis-circuit-breaker.js';
import { CircuitOpenError, type CircuitBreakerConfig } from '../types.js';
import {
  isRedisServerHarnessAvailable,
  startRedisServerHarness,
  type RedisServerHarness,
} from './helpers/redis-server-harness.js';

const describeWithRedis = isRedisServerHarnessAvailable() ? describe.sequential : describe.skip;

const TEST_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  successThreshold: 2,
  resetTimeout: 1_000,
  monitorWindow: 5_000,
  halfOpenMaxConcurrent: 1,
  failureRateThreshold: 50,
  minimumRequestCount: 4,
};

describeWithRedis('RedisCircuitBreaker integration', () => {
  let redisHarness: RedisServerHarness;
  let redis: Redis;
  let breaker: RedisCircuitBreaker;

  beforeAll(async () => {
    redisHarness = await startRedisServerHarness();
    redis = new Redis(redisHarness.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: null,
    });
    await redis.connect();
  });

  beforeEach(async () => {
    await redisHarness.clear();
    breaker = new RedisCircuitBreaker(redis, 'tenant', TEST_CONFIG);
  });

  afterAll(async () => {
    await redis.quit().catch(async () => {
      await redis.disconnect();
    });
    await redisHarness.close();
  });

  it('immediately reopens and clears probe state after a failed fresh HALF_OPEN probe', async () => {
    await breaker.forceReset('tenant-half-open', 'HALF_OPEN');

    await expect(
      breaker.execute('tenant-half-open', async () => {
        throw new Error('probe failed');
      }),
    ).rejects.toThrow('probe failed');

    const metrics = await breaker.getMetrics('tenant-half-open');
    expect(metrics.state).toBe('OPEN');
    expect(metrics.failureCount).toBe(1);
    expect(metrics.successCount).toBe(0);
    expect(metrics.totalCount).toBe(1);
    expect(metrics.halfOpenCount).toBe(0);

    await expect(
      breaker.execute('tenant-half-open', async () => 'should not run while open'),
    ).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('clears stale monitoring window data when forcing HALF_OPEN against real Redis', async () => {
    await breaker.execute('tenant-reset', async () => 'ok');
    await expect(
      breaker.execute('tenant-reset', async () => {
        throw new Error('fail');
      }),
    ).rejects.toThrow('fail');

    const beforeReset = await breaker.getMetrics('tenant-reset');
    expect(beforeReset.failureCount).toBe(1);
    expect(beforeReset.successCount).toBe(1);

    await breaker.forceReset('tenant-reset', 'HALF_OPEN');

    const afterReset = await breaker.getMetrics('tenant-reset');
    expect(afterReset.state).toBe('HALF_OPEN');
    expect(afterReset.failureCount).toBe(0);
    expect(afterReset.successCount).toBe(0);
    expect(afterReset.totalCount).toBe(0);
    expect(afterReset.halfOpenCount).toBe(0);
  });
});

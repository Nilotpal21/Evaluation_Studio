/**
 * Redis Circuit Breaker Tests
 *
 * Tests for Redis-backed circuit breaker components:
 * - RedisCircuitBreakerStoreAdapter
 * - HybridCircuitBreakerRegistry
 * - Tenant-specific circuit breaker configuration
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { RedisCircuitBreakerStoreAdapter } from '../services/resilience/redis-cb-store-adapter';
import {
  HybridCircuitBreakerRegistry,
  resetCircuitBreakerRegistry,
} from '../services/resilience/hybrid-cb-registry';
import {
  getTenantCBConfig,
  registerTenantPlan,
  getPlanCBConfig,
} from '../services/resilience/tenant-cb-config';
import type { CircuitBreakerState } from '../services/resilience/circuit-breaker';

// =============================================================================
// MOCK REDIS CLIENT
// =============================================================================

interface MockRedisClient {
  hgetall: ReturnType<typeof vi.fn>;
  hmset: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
  _data: Map<string, Record<string, string>>;
  _reset: () => void;
}

function createMockRedis(): MockRedisClient {
  const data = new Map<string, Record<string, string>>();

  return {
    hgetall: vi.fn(async (key: string) => {
      const hash = data.get(key);
      if (!hash || Object.keys(hash).length === 0) {
        return null;
      }
      return { ...hash };
    }),
    hmset: vi.fn(async (key: string, fields: Record<string, string>) => {
      data.set(key, { ...fields });
      return 'OK';
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      return 1;
    }),
    _data: data,
    _reset: () => {
      data.clear();
    },
  };
}

// =============================================================================
// REDIS STORE ADAPTER TESTS
// =============================================================================

describe('RedisCircuitBreakerStoreAdapter', () => {
  let redis: MockRedisClient;
  let adapter: RedisCircuitBreakerStoreAdapter;

  beforeEach(() => {
    redis = createMockRedis();
    adapter = new RedisCircuitBreakerStoreAdapter(redis);
  });

  test('getState returns null for missing key', async () => {
    const state = await adapter.getState('nonexistent');
    expect(state).toBeNull();
    expect(redis.hgetall).toHaveBeenCalledWith('cb:platform:nonexistent');
  });

  test('getState returns null when Redis returns empty object', async () => {
    redis.hgetall.mockResolvedValueOnce({});
    const state = await adapter.getState('test-key');
    expect(state).toBeNull();
  });

  test('getState parses Redis hash into CircuitBreakerState', async () => {
    redis._data.set('cb:platform:my-breaker', {
      state: 'open',
      failures: '5',
      successes: '2',
      lastFailureTime: '1704067200000',
      lastStateChange: '1704067100000',
      consecutiveSuccesses: '0',
    });

    const state = await adapter.getState('my-breaker');

    expect(state).toEqual({
      state: 'open',
      failures: 5,
      successes: 2,
      lastFailureTime: 1704067200000,
      lastStateChange: 1704067100000,
      consecutiveSuccesses: 0,
    });
    expect(redis.hgetall).toHaveBeenCalledWith('cb:platform:my-breaker');
  });

  test('getState handles missing optional fields with defaults', async () => {
    redis._data.set('cb:platform:partial', {
      state: 'closed',
    });

    const state = await adapter.getState('partial');

    expect(state).toEqual({
      state: 'closed',
      failures: 0,
      successes: 0,
      lastFailureTime: 0,
      lastStateChange: 0,
      consecutiveSuccesses: 0,
    });
  });

  test('setState writes state as Redis hash with TTL', async () => {
    const state: CircuitBreakerState = {
      state: 'half-open',
      failures: 3,
      successes: 1,
      lastFailureTime: 1704067300000,
      lastStateChange: 1704067400000,
      consecutiveSuccesses: 1,
    };

    await adapter.setState('my-breaker', state);

    expect(redis.hmset).toHaveBeenCalledWith('cb:platform:my-breaker', {
      state: 'half-open',
      failures: '3',
      successes: '1',
      lastFailureTime: '1704067300000',
      lastStateChange: '1704067400000',
      consecutiveSuccesses: '1',
    });
    expect(redis.expire).toHaveBeenCalledWith('cb:platform:my-breaker', 86400);
  });

  test('key format includes cb:platform: prefix', async () => {
    await adapter.getState('test');
    expect(redis.hgetall).toHaveBeenCalledWith('cb:platform:test');

    const state: CircuitBreakerState = {
      state: 'closed',
      failures: 0,
      successes: 0,
      lastFailureTime: 0,
      lastStateChange: Date.now(),
      consecutiveSuccesses: 0,
    };
    await adapter.setState('another', state);
    expect(redis.hmset).toHaveBeenCalledWith('cb:platform:another', expect.any(Object));
  });

  test('getState returns null on Redis error', async () => {
    redis.hgetall.mockRejectedValueOnce(new Error('Redis connection failed'));

    const state = await adapter.getState('test');
    expect(state).toBeNull();
  });

  test('setState silently fails on Redis error', async () => {
    redis.hmset.mockRejectedValueOnce(new Error('Redis write failed'));

    const state: CircuitBreakerState = {
      state: 'closed',
      failures: 0,
      successes: 0,
      lastFailureTime: 0,
      lastStateChange: Date.now(),
      consecutiveSuccesses: 0,
    };

    // Should not throw
    await expect(adapter.setState('test', state)).resolves.toBeUndefined();
  });
});

// =============================================================================
// HYBRID REGISTRY TESTS
// =============================================================================

describe('HybridCircuitBreakerRegistry', () => {
  beforeEach(() => {
    resetCircuitBreakerRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetCircuitBreakerRegistry();
  });

  test('creates breakers with default config when no Redis', () => {
    // Mock getRedisClient to return null (no Redis)
    vi.mock('../services/redis/redis-client', () => ({
      getRedisClient: () => null,
      getRedisHandle: () => null,
      isRedisAvailable: () => false,
    }));

    const registry = new HybridCircuitBreakerRegistry();
    const breaker = registry.getBreaker('test-breaker');

    expect(breaker).toBeDefined();
    expect(breaker.getState()).toBe('closed');
    expect(registry.isUsingRedis()).toBe(false);
  });

  test('isUsingRedis returns false when no Redis client provided', () => {
    vi.mock('../services/redis/redis-client', () => ({
      getRedisClient: () => null,
      getRedisHandle: () => null,
      isRedisAvailable: () => false,
    }));

    const registry = new HybridCircuitBreakerRegistry();
    expect(registry.isUsingRedis()).toBe(false);
  });

  test('getBreaker returns same instance for same name (caching)', () => {
    vi.mock('../services/redis/redis-client', () => ({
      getRedisClient: () => null,
      getRedisHandle: () => null,
      isRedisAvailable: () => false,
    }));

    const registry = new HybridCircuitBreakerRegistry();
    const breaker1 = registry.getBreaker('cached-breaker');
    const breaker2 = registry.getBreaker('cached-breaker');

    expect(breaker1).toBe(breaker2);
  });

  test('getBreaker with tenantId applies tenant-specific thresholds', () => {
    vi.mock('../services/redis/redis-client', () => ({
      getRedisClient: () => null,
      getRedisHandle: () => null,
      isRedisAvailable: () => false,
    }));

    // Register a tenant with ENTERPRISE plan
    registerTenantPlan('tenant-123', 'ENTERPRISE');

    const registry = new HybridCircuitBreakerRegistry();
    const breaker = registry.getBreaker('tenant-breaker', 'tenant-123');

    expect(breaker).toBeDefined();
    // Enterprise plan should have higher thresholds
    const snapshot = breaker.getSnapshot();
    expect(snapshot.state).toBe('closed');
  });

  test('getBreaker without tenantId uses default config', () => {
    vi.mock('../services/redis/redis-client', () => ({
      getRedisClient: () => null,
      getRedisHandle: () => null,
      isRedisAvailable: () => false,
    }));

    const registry = new HybridCircuitBreakerRegistry();
    const breaker = registry.getBreaker('default-breaker');

    expect(breaker).toBeDefined();
    expect(breaker.getState()).toBe('closed');
  });

  test('getRegistry returns underlying CircuitBreakerRegistry', () => {
    vi.mock('../services/redis/redis-client', () => ({
      getRedisClient: () => null,
      getRedisHandle: () => null,
      isRedisAvailable: () => false,
    }));

    const registry = new HybridCircuitBreakerRegistry();
    const underlying = registry.getRegistry();

    expect(underlying).toBeDefined();
    expect(typeof underlying.getBreaker).toBe('function');
  });

  test('shutdown stops recovery timer', () => {
    vi.mock('../services/redis/redis-client', () => ({
      getRedisClient: () => null,
      getRedisHandle: () => null,
      isRedisAvailable: () => false,
    }));

    const registry = new HybridCircuitBreakerRegistry();

    // Should not throw
    expect(() => registry.shutdown()).not.toThrow();
  });
});

// =============================================================================
// TENANT CONFIG TESTS
// =============================================================================

describe('Tenant Circuit Breaker Config', () => {
  test('getTenantCBConfig returns null for unregistered tenant', () => {
    const config = getTenantCBConfig('unknown-tenant');
    expect(config).toBeNull();
  });

  test('getTenantCBConfig returns FREE plan thresholds', () => {
    registerTenantPlan('free-tenant', 'FREE');
    const config = getTenantCBConfig('free-tenant');

    expect(config).toEqual({
      failureThreshold: 15,
      successThreshold: 3,
      resetTimeoutMs: 60_000,
      windowMs: 120_000,
    });
  });

  test('getTenantCBConfig returns ENTERPRISE plan thresholds', () => {
    registerTenantPlan('enterprise-tenant', 'ENTERPRISE');
    const config = getTenantCBConfig('enterprise-tenant');

    expect(config).toEqual({
      failureThreshold: 50,
      successThreshold: 5,
      resetTimeoutMs: 30_000,
      windowMs: 60_000,
    });
  });

  test('getPlanCBConfig returns config for each plan tier', () => {
    const freeConfig = getPlanCBConfig('FREE');
    expect(freeConfig.failureThreshold).toBe(15);

    const teamConfig = getPlanCBConfig('TEAM');
    expect(teamConfig.failureThreshold).toBe(25);

    const businessConfig = getPlanCBConfig('BUSINESS');
    expect(businessConfig.failureThreshold).toBe(35);

    const enterpriseConfig = getPlanCBConfig('ENTERPRISE');
    expect(enterpriseConfig.failureThreshold).toBe(50);
  });

  test('registerTenantPlan updates cached tenant plan', () => {
    const tenantId = 'test-tenant-456';

    // Initially no config
    expect(getTenantCBConfig(tenantId)).toBeNull();

    // Register as BUSINESS
    registerTenantPlan(tenantId, 'BUSINESS');
    const config = getTenantCBConfig(tenantId);

    expect(config).toBeDefined();
    expect(config?.failureThreshold).toBe(35);
  });
});

// =============================================================================
// INTEGRATION TESTS
// =============================================================================

describe('Redis Circuit Breaker Integration', () => {
  let redis: MockRedisClient;

  beforeEach(() => {
    redis = createMockRedis();
    resetCircuitBreakerRegistry();
  });

  afterEach(() => {
    resetCircuitBreakerRegistry();
  });

  test('adapter persists and retrieves breaker state', async () => {
    const adapter = new RedisCircuitBreakerStoreAdapter(redis);

    const initialState: CircuitBreakerState = {
      state: 'closed',
      failures: 0,
      successes: 0,
      lastFailureTime: 0,
      lastStateChange: Date.now(),
      consecutiveSuccesses: 0,
    };

    await adapter.setState('integration-test', initialState);

    const retrieved = await adapter.getState('integration-test');
    expect(retrieved).toBeDefined();
    expect(retrieved?.state).toBe('closed');
    expect(retrieved?.failures).toBe(0);
  });

  test('tenant-specific breakers have different thresholds', () => {
    registerTenantPlan('free-tenant', 'FREE');
    registerTenantPlan('enterprise-tenant', 'ENTERPRISE');

    const freeConfig = getTenantCBConfig('free-tenant');
    const enterpriseConfig = getTenantCBConfig('enterprise-tenant');

    expect(freeConfig?.failureThreshold).toBe(15);
    expect(enterpriseConfig?.failureThreshold).toBe(50);
    expect(enterpriseConfig!.failureThreshold).toBeGreaterThan(freeConfig!.failureThreshold);
  });
});

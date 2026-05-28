/**
 * Redis Fallback OTEL Metrics Tests
 *
 * Verifies that the OTEL counter `rate_limiter.fallback` is incremented
 * when the HybridRateLimiter switches backends:
 *
 * 1. Redis error during check -> direction='redis_to_memory'
 * 2. Redis recovery timer fires -> direction='memory_to_redis'
 * 3. Normal operation (no error) -> no metric emitted
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — guaranteed to exist before vi.mock factories run
// ---------------------------------------------------------------------------

const {
  mockRedisClient,
  mockIsRedisAvailable,
  mockGetRedisClient,
  mockRedisCheck,
  mockRedisPeek,
  mockRecordRateLimiterFallback,
} = vi.hoisted(() => {
  const mockRedisClient = { duplicate: vi.fn() };
  return {
    mockRedisClient,
    mockIsRedisAvailable: vi.fn<[], boolean>(),
    mockGetRedisClient: vi.fn<[], any>(),
    mockRedisCheck: vi.fn<any[], Promise<any>>(),
    mockRedisPeek: vi.fn<any[], Promise<number>>(),
    mockRecordRateLimiterFallback: vi.fn(),
  };
});

// Mock redis-client module
vi.mock('../services/redis/redis-client.js', () => ({
  getRedisClient: mockGetRedisClient,
  isRedisAvailable: mockIsRedisAvailable,
  getRedisHandle: () => null,
}));

// Mock the metrics module to spy on recordRateLimiterFallback
vi.mock('../observability/metrics.js', () => ({
  recordRateLimiterFallback: mockRecordRateLimiterFallback,
  // Provide stubs for other metrics that might be imported transitively
  recordRateLimitRejection: vi.fn(),
  recordWsRateLimitRejection: vi.fn(),
  recordBackpressure: vi.fn(),
  recordHttpRequest: vi.fn(),
  incrementActiveRequests: vi.fn(),
  decrementActiveRequests: vi.fn(),
  recordLlmCall: vi.fn(),
  recordToolCall: vi.fn(),
  incrementActiveSessions: vi.fn(),
  decrementActiveSessions: vi.fn(),
  setCircuitBreakerState: vi.fn(),
}));

// Mock RedisRateLimiter to control check/peek behavior
vi.mock('../services/resilience/redis-rate-limiter.js', () => ({
  RedisRateLimiter: class MockRedisRateLimiter {
    check = mockRedisCheck;
    peek = mockRedisPeek;
  },
}));

// Mock the logger to suppress output
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import {
  HybridRateLimiter,
  resetHybridRateLimiter,
} from '../services/resilience/hybrid-rate-limiter.js';

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  resetHybridRateLimiter();
});

afterEach(() => {
  resetHybridRateLimiter();
  vi.useRealTimers();
});

// =============================================================================
// 1. FALLBACK: Redis -> Memory (direction='redis_to_memory')
// =============================================================================

describe('Redis to memory fallback metric', () => {
  test('emits redis_to_memory when Redis check() throws', async () => {
    // Start with Redis available
    mockGetRedisClient.mockReturnValue(mockRedisClient);
    mockIsRedisAvailable.mockReturnValue(true);

    const limiter = new HybridRateLimiter();
    expect(limiter.isUsingRedis()).toBe(true);

    // Redis check throws on next call
    mockRedisCheck.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await limiter.check('tenant-1', 'request', 100);

    expect(mockRecordRateLimiterFallback).toHaveBeenCalledOnce();
    expect(mockRecordRateLimiterFallback).toHaveBeenCalledWith('redis_to_memory');
    expect(limiter.isUsingRedis()).toBe(false);

    limiter.shutdown();
  });

  test('emits redis_to_memory only once for multiple consecutive Redis errors', async () => {
    mockGetRedisClient.mockReturnValue(mockRedisClient);
    mockIsRedisAvailable.mockReturnValue(true);

    const limiter = new HybridRateLimiter();

    // First call fails — triggers fallback metric
    mockRedisCheck.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await limiter.check('tenant-1', 'request', 100);

    expect(mockRecordRateLimiterFallback).toHaveBeenCalledOnce();
    expect(mockRecordRateLimiterFallback).toHaveBeenCalledWith('redis_to_memory');

    // Subsequent calls use in-memory — no additional metric
    await limiter.check('tenant-1', 'request', 100);
    await limiter.check('tenant-1', 'request', 100);

    // Still only one call — once we switch to memory, we stay there
    expect(mockRecordRateLimiterFallback).toHaveBeenCalledOnce();

    limiter.shutdown();
  });

  test('falls back gracefully and returns in-memory result after Redis error', async () => {
    mockGetRedisClient.mockReturnValue(mockRedisClient);
    mockIsRedisAvailable.mockReturnValue(true);

    const limiter = new HybridRateLimiter();

    mockRedisCheck.mockRejectedValueOnce(new Error('Redis timeout'));

    const result = await limiter.check('tenant-1', 'request', 100);

    // In-memory limiter returns a valid result
    expect(result).toHaveProperty('allowed');
    expect(result).toHaveProperty('remaining');
    expect(result).toHaveProperty('resetMs');
    expect(result.allowed).toBe(true);

    limiter.shutdown();
  });
});

// =============================================================================
// 2. RECOVERY: Memory -> Redis (direction='memory_to_redis')
// =============================================================================

describe('Memory to Redis recovery metric', () => {
  test('emits memory_to_redis when recovery timer finds Redis available', async () => {
    // Start WITHOUT Redis
    mockGetRedisClient.mockReturnValue(null);
    mockIsRedisAvailable.mockReturnValue(false);

    const limiter = new HybridRateLimiter();
    expect(limiter.isUsingRedis()).toBe(false);
    expect(mockRecordRateLimiterFallback).not.toHaveBeenCalled();

    // Now Redis becomes available
    mockGetRedisClient.mockReturnValue(mockRedisClient);
    mockIsRedisAvailable.mockReturnValue(true);

    // Advance timer past the recovery interval (default 30s)
    vi.advanceTimersByTime(30_000);

    expect(mockRecordRateLimiterFallback).toHaveBeenCalledOnce();
    expect(mockRecordRateLimiterFallback).toHaveBeenCalledWith('memory_to_redis');
    expect(limiter.isUsingRedis()).toBe(true);

    limiter.shutdown();
  });

  test('emits memory_to_redis after Redis error and subsequent recovery', async () => {
    // Start with Redis available
    mockGetRedisClient.mockReturnValue(mockRedisClient);
    mockIsRedisAvailable.mockReturnValue(true);

    const limiter = new HybridRateLimiter();
    expect(limiter.isUsingRedis()).toBe(true);

    // Redis fails on check — fallback to memory
    mockRedisCheck.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await limiter.check('tenant-1', 'request', 100);

    expect(mockRecordRateLimiterFallback).toHaveBeenCalledTimes(1);
    expect(mockRecordRateLimiterFallback).toHaveBeenCalledWith('redis_to_memory');
    expect(limiter.isUsingRedis()).toBe(false);

    // Redis recovers
    mockGetRedisClient.mockReturnValue(mockRedisClient);
    mockIsRedisAvailable.mockReturnValue(true);

    // Advance past recovery interval
    vi.advanceTimersByTime(30_000);

    expect(mockRecordRateLimiterFallback).toHaveBeenCalledTimes(2);
    expect(mockRecordRateLimiterFallback).toHaveBeenLastCalledWith('memory_to_redis');
    expect(limiter.isUsingRedis()).toBe(true);

    limiter.shutdown();
  });

  test('does NOT emit memory_to_redis if Redis is still unavailable at recovery check', async () => {
    // Start WITHOUT Redis
    mockGetRedisClient.mockReturnValue(null);
    mockIsRedisAvailable.mockReturnValue(false);

    const limiter = new HybridRateLimiter();

    // Advance past recovery interval — Redis still down
    vi.advanceTimersByTime(30_000);

    expect(mockRecordRateLimiterFallback).not.toHaveBeenCalled();
    expect(limiter.isUsingRedis()).toBe(false);

    // Advance again — still down
    vi.advanceTimersByTime(30_000);

    expect(mockRecordRateLimiterFallback).not.toHaveBeenCalled();

    limiter.shutdown();
  });
});

// =============================================================================
// 3. NO METRIC ON NORMAL OPERATION
// =============================================================================

describe('No fallback metric on normal operation', () => {
  test('successful Redis check does not emit fallback metric', async () => {
    mockGetRedisClient.mockReturnValue(mockRedisClient);
    mockIsRedisAvailable.mockReturnValue(true);
    mockRedisCheck.mockResolvedValue({ allowed: true, remaining: 99, resetMs: 60000 });

    const limiter = new HybridRateLimiter();

    await limiter.check('tenant-1', 'request', 100);
    await limiter.check('tenant-1', 'request', 100);

    expect(mockRecordRateLimiterFallback).not.toHaveBeenCalled();
    expect(limiter.isUsingRedis()).toBe(true);

    limiter.shutdown();
  });

  test('in-memory-only mode (no Redis at startup) does not emit fallback metric on check', async () => {
    mockGetRedisClient.mockReturnValue(null);
    mockIsRedisAvailable.mockReturnValue(false);

    const limiter = new HybridRateLimiter();
    expect(limiter.isUsingRedis()).toBe(false);

    // Check goes directly to in-memory — no transition, no metric
    await limiter.check('tenant-1', 'request', 100);

    expect(mockRecordRateLimiterFallback).not.toHaveBeenCalled();

    limiter.shutdown();
  });
});

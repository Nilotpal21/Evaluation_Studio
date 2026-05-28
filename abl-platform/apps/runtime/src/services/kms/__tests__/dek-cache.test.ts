/**
 * Multi-Layer DEK Cache Tests
 *
 * Validates: L1 in-process LRU cache (TTL, eviction, zero-fill),
 * L2 Redis wrapped cache (graceful degradation), and MultiLayerDEKCache delegation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEKCacheL1, DEKCacheL2, MultiLayerDEKCache } from '../dek-cache.js';

// =============================================================================
// MOCKS
// =============================================================================

const mockHGetAll = vi.fn();
const mockHSet = vi.fn();
const mockExpire = vi.fn();
const mockIsRedisAvailable = vi.fn();
const mockGetRedisClient = vi.fn();

vi.mock('../../redis/redis-client.js', () => ({
  getRedisClient: (...args: any[]) => mockGetRedisClient(...args),
  isRedisAvailable: (...args: any[]) => mockIsRedisAvailable(...args),
  getRedisHandle: () => null,
}));

// =============================================================================
// FIXTURES
// =============================================================================

const scope = { tenantId: 'tenant-1', projectId: '_tenant', environment: '_shared' };
const scope2 = { tenantId: 'tenant-2', projectId: '_tenant', environment: '_shared' };
const dekId = 'active';

function makeKey(plaintext = 'test-key-material'): Buffer {
  return Buffer.from(plaintext);
}

// =============================================================================
// L1: IN-PROCESS LRU CACHE
// =============================================================================

describe('DEKCacheL1', () => {
  let cache: DEKCacheL1;

  beforeEach(() => {
    cache = new DEKCacheL1(3, 5000); // maxEntries=3, ttl=5s
    vi.restoreAllMocks();
  });

  it('get returns null for missing key', () => {
    const result = cache.get(scope, dekId);
    expect(result).toBeNull();
  });

  it('set and get round-trip', () => {
    const key = makeKey();
    cache.set(scope, dekId, key);

    const result = cache.get(scope, dekId);
    expect(result).not.toBeNull();
    expect(result!.equals(key)).toBe(true);
  });

  it('LRU eviction when maxEntries exceeded', () => {
    const key1 = makeKey('key-1');
    const key2 = makeKey('key-2');
    const key3 = makeKey('key-3');
    const key4 = makeKey('key-4');

    cache.set(scope, 'dek-1', key1);
    cache.set(scope, 'dek-2', key2);
    cache.set(scope, 'dek-3', key3);

    expect(cache.size).toBe(3);

    // Adding a 4th entry should evict the oldest (key1)
    cache.set(scope, 'dek-4', key4);
    expect(cache.size).toBe(3);

    // key1 was evicted
    expect(cache.get(scope, 'dek-1')).toBeNull();

    // Caller's original buffer is NOT zeroed (set copies the buffer)
    expect(key1.every((byte) => byte === 0)).toBe(false);

    // key2, key3, key4 still accessible
    expect(cache.get(scope, 'dek-2')).not.toBeNull();
    expect(cache.get(scope, 'dek-3')).not.toBeNull();
    expect(cache.get(scope, 'dek-4')).not.toBeNull();
  });

  it('TTL expiration (evicts expired entry)', () => {
    const key = makeKey('expiring-key');
    cache.set(scope, dekId, key);
    expect(cache.get(scope, dekId)).not.toBeNull();

    // Advance time past TTL
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 6000); // 6s > 5s TTL

    const result = cache.get(scope, dekId);
    expect(result).toBeNull();

    // Caller's original buffer is NOT zeroed (set copies the buffer)
    expect(key.every((byte) => byte === 0)).toBe(false);

    vi.useRealTimers();
  });

  it('set copies the buffer (caller mutation does not corrupt cache)', () => {
    const key = makeKey('copy-test');
    cache.set(scope, dekId, key);

    // Mutate the caller's buffer
    key.fill(0);

    // Cache still returns the original value
    const cached = cache.get(scope, dekId);
    expect(cached).not.toBeNull();
    expect(cached!.every((byte) => byte === 0)).toBe(false);
  });

  it('evictTenant removes all keys for a tenant', () => {
    const key1 = makeKey('tenant1-key1');
    const key2 = makeKey('tenant1-key2');
    const key3 = makeKey('tenant2-key1');

    cache.set(scope, 'dek-1', key1);
    cache.set(scope, 'dek-2', key2);
    cache.set(scope2, 'dek-1', key3);

    expect(cache.size).toBe(3);

    const evicted = cache.evictTenant('tenant-1');
    expect(evicted).toBe(2);
    expect(cache.size).toBe(1);

    // Evicted entries are gone
    expect(cache.get(scope, 'dek-1')).toBeNull();
    expect(cache.get(scope, 'dek-2')).toBeNull();

    // Other tenant's keys remain untouched
    expect(cache.get(scope2, 'dek-1')).not.toBeNull();
  });

  it('clear removes all entries', () => {
    const key1 = makeKey('clear-key1');
    const key2 = makeKey('clear-key2');

    cache.set(scope, 'dek-1', key1);
    cache.set(scope2, 'dek-1', key2);

    expect(cache.size).toBe(2);

    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.get(scope, 'dek-1')).toBeNull();
    expect(cache.get(scope2, 'dek-1')).toBeNull();
  });

  it('size property reflects cache state', () => {
    expect(cache.size).toBe(0);

    cache.set(scope, 'dek-1', makeKey());
    expect(cache.size).toBe(1);

    cache.set(scope, 'dek-2', makeKey());
    expect(cache.size).toBe(2);

    cache.clear();
    expect(cache.size).toBe(0);
  });
});

// =============================================================================
// L2: REDIS HASH CACHE
// =============================================================================

describe('DEKCacheL2', () => {
  let cache: DEKCacheL2;

  beforeEach(() => {
    cache = new DEKCacheL2(1800); // 30min TTL
    vi.restoreAllMocks();
    mockHGetAll.mockReset();
    mockHSet.mockReset();
    mockExpire.mockReset();
    mockIsRedisAvailable.mockReset();
    mockGetRedisClient.mockReset();
  });

  it('getWrapped returns null when Redis unavailable', async () => {
    mockIsRedisAvailable.mockReturnValue(false);

    const result = await cache.getWrapped(scope, dekId);
    expect(result).toBeNull();
  });

  it('setWrapped is no-op when Redis unavailable', async () => {
    mockIsRedisAvailable.mockReturnValue(false);

    // Should not throw
    await cache.setWrapped(scope, dekId, 'wrapped-dek', 'kek-id', 1);
    expect(mockGetRedisClient).not.toHaveBeenCalled();
  });

  it('getWrapped/setWrapped round-trip with mock Redis', async () => {
    const wrappedData = {
      wrappedDek: 'enc-dek-base64',
      kekKeyId: 'kek-key-1',
      kekKeyVersion: '3',
    };

    mockIsRedisAvailable.mockReturnValue(true);
    mockGetRedisClient.mockReturnValue({
      hgetall: mockHGetAll,
      hset: mockHSet,
      expire: mockExpire,
    });
    mockHSet.mockResolvedValue(undefined);
    mockExpire.mockResolvedValue(undefined);
    mockHGetAll.mockResolvedValue(wrappedData);

    // Set
    await cache.setWrapped(scope, dekId, 'enc-dek-base64', 'kek-key-1', 3);
    expect(mockHSet).toHaveBeenCalledOnce();
    expect(mockExpire).toHaveBeenCalledWith(expect.stringContaining('dek:wrapped:'), 1800);

    // Get
    const result = await cache.getWrapped(scope, dekId);
    expect(result).toEqual({
      wrappedDek: 'enc-dek-base64',
      kekKeyId: 'kek-key-1',
      kekKeyVersion: 3,
    });
  });

  it('getWrapped returns null when key does not exist in Redis', async () => {
    mockIsRedisAvailable.mockReturnValue(true);
    mockGetRedisClient.mockReturnValue({
      hgetall: mockHGetAll,
    });
    // hGetAll returns an empty object when the key doesn't exist
    mockHGetAll.mockResolvedValue({});

    const result = await cache.getWrapped(scope, dekId);
    expect(result).toBeNull();
  });

  it('graceful failure on Redis error', async () => {
    mockIsRedisAvailable.mockReturnValue(true);
    mockGetRedisClient.mockReturnValue({
      hgetall: mockHGetAll,
      hset: mockHSet,
      expire: mockExpire,
    });
    mockHGetAll.mockRejectedValue(new Error('Redis connection lost'));
    mockHSet.mockRejectedValue(new Error('Redis connection lost'));

    // getWrapped returns null instead of throwing
    const getResult = await cache.getWrapped(scope, dekId);
    expect(getResult).toBeNull();

    // setWrapped does not throw
    await expect(
      cache.setWrapped(scope, dekId, 'wrapped-dek', 'kek-id', 1),
    ).resolves.toBeUndefined();
  });
});

// =============================================================================
// MULTI-LAYER DEK CACHE
// =============================================================================

describe('MultiLayerDEKCache', () => {
  let cache: MultiLayerDEKCache;

  beforeEach(() => {
    cache = new MultiLayerDEKCache({ maxEntries: 10, ttlMs: 5000 }, 1800);
    vi.restoreAllMocks();
    mockIsRedisAvailable.mockReset();
    mockGetRedisClient.mockReset();
    mockHGetAll.mockReset();
    mockHSet.mockReset();
    mockExpire.mockReset();
  });

  it('getPlaintext delegates to L1', () => {
    // Initially empty
    expect(cache.getPlaintext(scope, dekId)).toBeNull();

    // After setting, should retrieve
    const key = makeKey('multi-layer-key');
    cache.setPlaintext(scope, dekId, key);
    const result = cache.getPlaintext(scope, dekId);
    expect(result).not.toBeNull();
    expect(result!.equals(key)).toBe(true);
  });

  it('setPlaintext delegates to L1', () => {
    const key = makeKey('set-plaintext');
    cache.setPlaintext(scope, dekId, key);

    expect(cache.l1Size).toBe(1);
    expect(cache.getPlaintext(scope, dekId)!.equals(key)).toBe(true);
  });

  it('getWrapped delegates to L2', async () => {
    mockIsRedisAvailable.mockReturnValue(true);
    mockGetRedisClient.mockReturnValue({
      hgetall: mockHGetAll,
    });
    mockHGetAll.mockResolvedValue({
      wrappedDek: 'enc-data',
      kekKeyId: 'kek-1',
      kekKeyVersion: '2',
    });

    const result = await cache.getWrapped(scope, dekId);
    expect(result).toEqual({
      wrappedDek: 'enc-data',
      kekKeyId: 'kek-1',
      kekKeyVersion: 2,
    });
  });

  it('setWrapped delegates to L2', async () => {
    mockIsRedisAvailable.mockReturnValue(true);
    mockGetRedisClient.mockReturnValue({
      hgetall: mockHGetAll,
      hset: mockHSet,
      expire: mockExpire,
    });
    mockHSet.mockResolvedValue(undefined);
    mockExpire.mockResolvedValue(undefined);

    await cache.setWrapped(scope, dekId, 'wrapped', 'kek-1', 2);
    expect(mockHSet).toHaveBeenCalledOnce();
    expect(mockExpire).toHaveBeenCalledOnce();
  });

  it('evictTenant delegates to L1', () => {
    cache.setPlaintext(scope, 'dek-1', makeKey('k1'));
    cache.setPlaintext(scope, 'dek-2', makeKey('k2'));
    cache.setPlaintext(scope2, 'dek-1', makeKey('k3'));

    const evicted = cache.evictTenant('tenant-1');
    expect(evicted).toBe(2);
    expect(cache.l1Size).toBe(1);
  });

  it('clear delegates to L1', () => {
    cache.setPlaintext(scope, 'dek-1', makeKey('k1'));
    cache.setPlaintext(scope2, 'dek-1', makeKey('k2'));
    expect(cache.l1Size).toBe(2);

    cache.clear();
    expect(cache.l1Size).toBe(0);
  });

  it('l1Size property', () => {
    expect(cache.l1Size).toBe(0);

    cache.setPlaintext(scope, dekId, makeKey());
    expect(cache.l1Size).toBe(1);

    cache.setPlaintext(scope2, dekId, makeKey());
    expect(cache.l1Size).toBe(2);
  });
});

/**
 * Resolution Key Store (Redis) Tests
 *
 * Tests the Redis-backed implementation of SessionResolutionStore.
 * Uses an in-memory Map-based mock for Redis to validate key format,
 * TTL handling, tenant isolation, and CRUD operations.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RedisResolutionKeyStore } from '../../../../contexts/identity/infrastructure/resolution-key-store.js';
import { buildResolutionKeyId } from '../../../../contexts/identity/domain/session-resolution-key.js';
import type { SessionResolutionKey } from '../../../../contexts/identity/domain/session-resolution-key.js';
import { normalizeSessionResolutionRecord } from '../../../../contexts/identity/domain/session-resolution-record.js';

// =============================================================================
// MOCK REDIS CLIENT
// =============================================================================

interface MockRedisClient {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
}

function createMockRedis(): MockRedisClient {
  const store = new Map<string, string>();

  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, _mode?: string, _ttl?: number) => {
      store.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      const existed = store.has(key);
      store.delete(key);
      return existed ? 1 : 0;
    }),
  };
}

// =============================================================================
// HELPERS
// =============================================================================

function makeKey(overrides: Partial<SessionResolutionKey> = {}): SessionResolutionKey {
  return {
    tenantId: 'tenant-001',
    channelId: 'ch-web',
    artifactHash: 'abc123',
    sessionId: 'sess-001',
    expiresAt: new Date(Date.now() + 3600_000), // 1 hour from now
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('RedisResolutionKeyStore', () => {
  let mockRedis: MockRedisClient;
  let store: RedisResolutionKeyStore;

  beforeEach(() => {
    mockRedis = createMockRedis();
    store = new RedisResolutionKeyStore(() => mockRedis);
  });

  // ---------------------------------------------------------------------------
  // save()
  // ---------------------------------------------------------------------------

  describe('save()', () => {
    it('stores the normalized resolution record under the correct tenant-scoped key', async () => {
      const key = makeKey();

      await store.save(key);

      const expectedRedisKey = buildResolutionKeyId('tenant-001', 'ch-web', 'abc123');
      const storedValue = JSON.parse(mockRedis.set.mock.calls[0][1] as string) as {
        sessionLocator: { sessionId: string };
        sessionPrincipalId: string;
      };
      expect(mockRedis.set).toHaveBeenCalledWith(
        expectedRedisKey,
        expect.any(String),
        'EX',
        expect.any(Number),
      );
      expect(storedValue.sessionLocator.sessionId).toBe('sess-001');
      expect(storedValue.sessionPrincipalId).toBe('sess-001');
    });

    it('sets TTL from key.expiresAt', async () => {
      const futureDate = new Date(Date.now() + 7200_000); // 2 hours
      const key = makeKey({ expiresAt: futureDate });

      await store.save(key);

      const ttlArg = mockRedis.set.mock.calls[0][3] as number;
      // TTL should be approximately 7200 seconds (2 hours), with some tolerance
      expect(ttlArg).toBeGreaterThan(7100);
      expect(ttlArg).toBeLessThanOrEqual(7200);
    });

    it('uses a minimum TTL of 1 second for nearly-expired keys', async () => {
      const almostExpired = new Date(Date.now() - 1000); // already past
      const key = makeKey({ expiresAt: almostExpired });

      await store.save(key);

      const ttlArg = mockRedis.set.mock.calls[0][3] as number;
      expect(ttlArg).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // findByKey()
  // ---------------------------------------------------------------------------

  describe('findByKey()', () => {
    it('returns the normalized resolution record when key exists in Redis', async () => {
      const key = makeKey();
      await store.save(key);

      const result = await store.findByKey('tenant-001', 'ch-web', 'abc123');
      const expected = normalizeSessionResolutionRecord({
        tenantId: 'tenant-001',
        channelId: 'ch-web',
        artifactHash: 'abc123',
        sessionId: 'sess-001',
        expiresAt: key.expiresAt,
      });

      expect(result).toMatchObject({
        ...expected,
        traceId: expect.any(String),
      });
    });

    it('returns null when key does not exist', async () => {
      const result = await store.findByKey('tenant-001', 'ch-web', 'nonexistent');

      expect(result).toBeNull();
    });

    it('compatibility-reads legacy sessionId-only values', async () => {
      mockRedis.get.mockResolvedValueOnce('legacy-session-1');

      const result = await store.findByKey('tenant-001', 'ch-web', 'legacy-hash');

      expect(result).toMatchObject({
        tenantId: 'tenant-001',
        channelId: 'ch-web',
        artifactHash: 'legacy-hash',
        sessionLocator: {
          tenantId: 'tenant-001',
          projectId: '',
          sessionId: 'legacy-session-1',
        },
        sessionPrincipalId: 'legacy-session-1',
        policySource: 'legacy_resolution_key',
      });
    });

    it('queries Redis with the correct tenant-scoped key', async () => {
      await store.findByKey('tenant-X', 'ch-voice', 'hashXYZ');

      const expectedRedisKey = buildResolutionKeyId('tenant-X', 'ch-voice', 'hashXYZ');
      expect(mockRedis.get).toHaveBeenCalledWith(expectedRedisKey);
    });
  });

  // ---------------------------------------------------------------------------
  // remove()
  // ---------------------------------------------------------------------------

  describe('remove()', () => {
    it('deletes the key from Redis', async () => {
      const key = makeKey();
      await store.save(key);

      await store.remove('tenant-001', 'ch-web', 'abc123');

      expect(mockRedis.del).toHaveBeenCalledWith(
        buildResolutionKeyId('tenant-001', 'ch-web', 'abc123'),
      );
    });

    it('does not throw when key does not exist', async () => {
      await expect(store.remove('tenant-001', 'ch-web', 'nonexistent')).resolves.not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Tenant isolation
  // ---------------------------------------------------------------------------

  describe('tenant isolation', () => {
    it('different tenants with same channel+artifact do not share keys', async () => {
      const keyA = makeKey({ tenantId: 'tenant-A', sessionId: 'sess-A' });
      const keyB = makeKey({ tenantId: 'tenant-B', sessionId: 'sess-B' });

      await store.save(keyA);
      await store.save(keyB);

      const resultA = await store.findByKey('tenant-A', 'ch-web', 'abc123');
      const resultB = await store.findByKey('tenant-B', 'ch-web', 'abc123');

      expect(resultA?.sessionLocator.sessionId).toBe('sess-A');
      expect(resultB?.sessionLocator.sessionId).toBe('sess-B');
    });

    it('key format includes tenantId as a namespace', async () => {
      await store.findByKey('tenant-001', 'ch-web', 'abc123');

      const redisKey = mockRedis.get.mock.calls[0][0] as string;
      expect(redisKey).toContain('tenant-001');
      expect(redisKey).toBe('session_resolution:tenant-001:ch-web:abc123');
    });
  });
});

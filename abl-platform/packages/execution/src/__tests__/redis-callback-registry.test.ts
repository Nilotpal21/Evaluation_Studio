import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisCallbackRegistry } from '../redis-callback-registry.js';
import type { RedisClient } from '../redis-callback-registry.js';
import type { CallbackRegistryEntry } from '../callback-registry.js';

function makeEntry(overrides?: Partial<CallbackRegistryEntry>): CallbackRegistryEntry {
  return {
    callbackId: 'cb-1',
    suspensionId: 'susp-1',
    sessionId: 'sess-1',
    tenantId: 'tenant-1',
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

describe('RedisCallbackRegistry', () => {
  let redis: RedisClient;
  let registry: RedisCallbackRegistry;
  let store: Map<string, { value: string; expireAt?: number }>;

  beforeEach(() => {
    store = new Map();

    redis = {
      set: vi.fn(async (key: string, value: string, ...args: (string | number)[]) => {
        const hasNX = args.includes('NX');
        if (hasNX && store.has(key)) return null;
        const pxIdx = args.indexOf('PX');
        const ttl = pxIdx >= 0 ? Number(args[pxIdx + 1]) : undefined;
        store.set(key, { value, expireAt: ttl ? Date.now() + ttl : undefined });
        return 'OK';
      }),
      get: vi.fn(async (key: string) => {
        const entry = store.get(key);
        if (!entry) return null;
        if (entry.expireAt && Date.now() > entry.expireAt) {
          store.delete(key);
          return null;
        }
        return entry.value;
      }),
      del: vi.fn(async (key: string | string[]) => {
        const keys = Array.isArray(key) ? key : [key];
        let count = 0;
        for (const k of keys) {
          if (store.delete(k)) count++;
        }
        return count;
      }),
      eval: vi.fn(async (_script: string, _numkeys: number, key: string) => {
        const entry = store.get(key as string);
        if (entry) {
          store.delete(key as string);
          return entry.value;
        }
        return null;
      }),
    };

    registry = new RedisCallbackRegistry(redis);
  });

  describe('register', () => {
    it('stores entry in Redis with correct TTL', async () => {
      const entry = makeEntry();
      await registry.register(entry);

      expect(redis.set).toHaveBeenCalledWith(
        `callback:${entry.callbackId}`,
        JSON.stringify(entry),
        'PX',
        expect.any(Number),
        'NX',
      );
      expect(store.has(`callback:${entry.callbackId}`)).toBe(true);
    });

    it('is idempotent — re-registering same callbackId is a no-op', async () => {
      const entry = makeEntry();
      await registry.register(entry);
      await registry.register(entry);

      expect(redis.set).toHaveBeenCalledTimes(2);
      // NX flag ensures second call is no-op
    });

    it('skips registration if expiresAt is in the past', async () => {
      const entry = makeEntry({ expiresAt: Date.now() - 1000 });
      await registry.register(entry);

      expect(redis.set).not.toHaveBeenCalled();
    });
  });

  describe('claim', () => {
    it('returns entry and deletes from Redis atomically', async () => {
      const entry = makeEntry();
      await registry.register(entry);

      const claimed = await registry.claim(entry.callbackId);
      expect(claimed).toEqual(entry);
      expect(store.has(`callback:${entry.callbackId}`)).toBe(false);
    });

    it('returns null for non-existent callbackId', async () => {
      const claimed = await registry.claim('non-existent');
      expect(claimed).toBeNull();
    });

    it('returns null on second call — exactly-once guarantee', async () => {
      const entry = makeEntry();
      await registry.register(entry);

      const first = await registry.claim(entry.callbackId);
      const second = await registry.claim(entry.callbackId);

      expect(first).toEqual(entry);
      expect(second).toBeNull();
    });
  });

  describe('lookup', () => {
    it('returns entry without deleting it', async () => {
      const entry = makeEntry();
      await registry.register(entry);

      const result = await registry.lookup(entry.callbackId);
      expect(result).toEqual(entry);
      // Should still be in store
      expect(store.has(`callback:${entry.callbackId}`)).toBe(true);
    });

    it('returns null for non-existent key', async () => {
      const result = await registry.lookup('non-existent');
      expect(result).toBeNull();
    });
  });

  describe('remove', () => {
    it('deletes the key', async () => {
      const entry = makeEntry();
      await registry.register(entry);

      await registry.remove(entry.callbackId);
      expect(store.has(`callback:${entry.callbackId}`)).toBe(false);
    });

    it('is safe to call on non-existent key', async () => {
      await expect(registry.remove('non-existent')).resolves.not.toThrow();
    });
  });
});

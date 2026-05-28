/**
 * Integration test for `RedisKvStore` (LLD §3 Phase 3 Task 3.1).
 *
 * Covers put / get / delete + TTL expiration via real `PTTL` semantics. Boots
 * a single test Redis client and tests against a per-suite key prefix so
 * parallel suites don't collide. Skips with a warning when Redis isn't
 * reachable (CI sets `REDIS_URL`; local dev uses docker-compose default).
 *
 * The probe runs at module top-level (top-level `await`) so the
 * `describe.skipIf` decision reflects live Redis state — `beforeAll`-based
 * probes are too late, vitest evaluates `describe` callbacks at module load.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { RedisKvStore } from '../services/redis-kv-store.js';

const DEFAULT_REDIS_URL = 'redis://localhost:6379';
const KEY_PREFIX = `test:redis-kv-store:${process.pid}:`;

async function probeRedis(): Promise<Redis | null> {
  const url = process.env.REDIS_URL || DEFAULT_REDIS_URL;
  const client = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await client.connect();
    await client.ping();
    return client;
  } catch (err) {
    process.stderr.write(
      `[redis-kv-store.test] Redis unavailable at ${url} — tests will skip: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    try {
      client.disconnect();
    } catch {
      /* nothing to clean */
    }
    return null;
  }
}

const client = await probeRedis();
const redisAvailable = client !== null;

afterAll(async () => {
  if (redisAvailable && client) {
    const keys = await client.keys(`${KEY_PREFIX}*`);
    if (keys.length > 0) {
      await client.del(...keys);
    }
    await client.quit();
  }
});

beforeEach(async () => {
  if (!redisAvailable || !client) return;
  const keys = await client.keys(`${KEY_PREFIX}*`);
  if (keys.length > 0) {
    await client.del(...keys);
  }
});

describe.skipIf(!redisAvailable)('RedisKvStore', () => {
  it('round-trips JSON-serialisable values via set/get', async () => {
    const store = new RedisKvStore(client!, KEY_PREFIX);
    await store.set('roundtrip:string', 'hello-world');
    await store.set('roundtrip:object', { foo: 'bar', n: 42, nested: { a: [1, 2, 3] } });

    expect(await store.get<string>('roundtrip:string')).toBe('hello-world');
    expect(await store.get('roundtrip:object')).toEqual({
      foo: 'bar',
      n: 42,
      nested: { a: [1, 2, 3] },
    });
  });

  it('returns undefined for missing keys', async () => {
    const store = new RedisKvStore(client!, KEY_PREFIX);
    expect(await store.get('does-not-exist')).toBeUndefined();
  });

  it('delete removes the key', async () => {
    const store = new RedisKvStore(client!, KEY_PREFIX);
    await store.set('to-delete', { v: 1 });
    expect(await store.get('to-delete')).toEqual({ v: 1 });
    await store.delete('to-delete');
    expect(await store.get('to-delete')).toBeUndefined();
  });

  it('applies PX expiry when ttlMs is provided and the key expires after the TTL', async () => {
    const store = new RedisKvStore(client!, KEY_PREFIX);
    await store.set('ttl-key', { hello: 'ttl' }, 2_000);

    const pttl = await client!.pttl(`${KEY_PREFIX}ttl-key`);
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(2_000);

    await new Promise((resolve) => setTimeout(resolve, 2_300));
    expect(await store.get('ttl-key')).toBeUndefined();
  }, 10_000);

  it('omitting ttlMs writes a key with no expiry (PTTL = -1)', async () => {
    const store = new RedisKvStore(client!, KEY_PREFIX);
    await store.set('no-ttl', 'persistent');
    const pttl = await client!.pttl(`${KEY_PREFIX}no-ttl`);
    // ioredis returns -1 for "no expire", -2 for "missing key".
    expect(pttl).toBe(-1);
  });

  it('namespaces keys with the configured prefix', async () => {
    const store = new RedisKvStore(client!, KEY_PREFIX);
    await store.set('scoped', 'value');
    expect(await client!.get('scoped')).toBeNull();
    expect(await client!.get(`${KEY_PREFIX}scoped`)).toBe('"value"');
  });

  it('tolerates malformed JSON (treats as miss, does not throw)', async () => {
    await client!.set(`${KEY_PREFIX}bad-json`, 'not-json{', 'PX', 5_000);
    const store = new RedisKvStore(client!, KEY_PREFIX);
    expect(await store.get('bad-json')).toBeUndefined();
  });
});

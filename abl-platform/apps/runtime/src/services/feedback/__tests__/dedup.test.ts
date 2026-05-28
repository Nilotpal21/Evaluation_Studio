/**
 * Feedback dedup — Redis SETNX with soft-allow.
 *
 * No platform mocks: a hand-rolled fake Redis fits the interface
 * (`set` with the SETNX/EX signature). Verifies:
 *  - Key shape uses tenant/session/message/user composite.
 *  - First write acquires; second write (within TTL) is rejected.
 *  - Soft-allow on null Redis client.
 *  - Soft-allow on Redis throw.
 *  - releaseDedupSlot drops the key so a retry can re-acquire.
 */

import { describe, it, expect } from 'vitest';
import { acquireDedupSlot, releaseDedupSlot, buildDedupKey } from '../dedup.js';

interface SetCall {
  key: string;
  value: string;
  exTtl: number;
  nx: boolean;
}

function makeFakeRedis(opts: { throwOnSet?: boolean } = {}) {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const setCalls: SetCall[] = [];
  return {
    setCalls,
    store,
    redis: {
      async set(
        key: string,
        value: string,
        _ex: 'EX',
        ttl: number,
        _nx: 'NX',
      ): Promise<'OK' | null> {
        if (opts.throwOnSet) throw new Error('redis down');
        setCalls.push({ key, value, exTtl: ttl, nx: true });
        const existing = store.get(key);
        if (existing && existing.expiresAt > Date.now()) return null;
        store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
        return 'OK';
      },
      async del(key: string): Promise<number> {
        return store.delete(key) ? 1 : 0;
      },
    },
  };
}

const ctx = {
  tenantId: 't-1',
  sessionId: 'sess-1',
  messageId: 'm-1',
  userId: 'u-1',
};

describe('feedback dedup', () => {
  it('builds a composite key from tenant/session/message/user', () => {
    expect(buildDedupKey(ctx)).toBe('feedback:t-1:sess-1:m-1:u-1');
  });

  it('first SETNX acquires the slot', async () => {
    const { redis, setCalls } = makeFakeRedis();
    const result = await acquireDedupSlot(redis, ctx);
    expect(result.acquired).toBe(true);
    expect(result.softAllowed).toBe(false);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]?.key).toBe('feedback:t-1:sess-1:m-1:u-1');
  });

  it('second SETNX (within TTL) is rejected', async () => {
    const { redis } = makeFakeRedis();
    const first = await acquireDedupSlot(redis, ctx);
    const second = await acquireDedupSlot(redis, ctx);
    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);
  });

  it('different scope keys do not collide', async () => {
    const { redis } = makeFakeRedis();
    const a = await acquireDedupSlot(redis, ctx);
    const b = await acquireDedupSlot(redis, { ...ctx, userId: 'u-other' });
    const c = await acquireDedupSlot(redis, { ...ctx, messageId: 'm-other' });
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
    expect(c.acquired).toBe(true);
  });

  it('soft-allows when redis is null', async () => {
    const result = await acquireDedupSlot(null, ctx);
    expect(result.acquired).toBe(true);
    expect(result.softAllowed).toBe(true);
  });

  it('soft-allows when redis throws', async () => {
    const { redis } = makeFakeRedis({ throwOnSet: true });
    const result = await acquireDedupSlot(redis, ctx);
    expect(result.acquired).toBe(true);
    expect(result.softAllowed).toBe(true);
  });

  it('release lets the slot be re-acquired', async () => {
    const { redis, store } = makeFakeRedis();
    const first = await acquireDedupSlot(redis, ctx);
    expect(first.acquired).toBe(true);
    await releaseDedupSlot(redis, ctx);
    expect(store.has(buildDedupKey(ctx))).toBe(false);
    const second = await acquireDedupSlot(redis, ctx);
    expect(second.acquired).toBe(true);
  });

  it('release on null redis is a no-op', async () => {
    await expect(releaseDedupSlot(null, ctx)).resolves.toBeUndefined();
  });
});

/**
 * Tests for B3: extendTTL channel hint optimization.
 */
import { describe, it, expect, vi } from 'vitest';
import { TransferSessionStore } from '../../session/transfer-session-store.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function createMockRedis() {
  // Note: redis.eval() here is the ioredis API for executing Lua scripts
  // on the Redis server, not JavaScript eval().
  const redisEvalFn = vi.fn().mockResolvedValue(1);

  return {
    hgetall: vi.fn().mockResolvedValue({
      tenantId: 'tenant-1',
      contactId: 'contact-1',
      channel: 'chat',
      provider: 'kore',
      providerSessionId: 'prov-1',
      state: 'active',
      ownerPod: 'pod-1',
      lastHeartbeat: String(Date.now()),
      createdAt: String(Date.now()),
      updatedAt: String(Date.now()),
      ttl: '1800',
    }),
    hmget: vi.fn().mockResolvedValue(['kore', 'tenant-1', 'prov-1']),
    eval: redisEvalFn,
  };
}

describe('TransferSessionStore.extendTTL', () => {
  it('without channel hint: calls hgetall (full session load)', async () => {
    const redis = createMockRedis();
    const store = new TransferSessionStore(redis as any);

    await store.extendTTL('agent_transfer:tenant-1:contact-1:chat');

    expect(redis.hgetall).toHaveBeenCalledWith('agent_transfer:tenant-1:contact-1:chat');
    expect(redis.hmget).not.toHaveBeenCalled();
  });

  it('with channel hint: uses hmget instead of hgetall', async () => {
    const redis = createMockRedis();
    const store = new TransferSessionStore(redis as any);

    await store.extendTTL('agent_transfer:tenant-1:contact-1:chat', undefined, 'chat');

    expect(redis.hmget).toHaveBeenCalledWith(
      'agent_transfer:tenant-1:contact-1:chat',
      'provider',
      'tenantId',
      'providerSessionId',
    );
    // Should NOT call hgetall when channel hint is provided
    expect(redis.hgetall).not.toHaveBeenCalled();
  });

  it('with channel hint: returns false if session does not exist', async () => {
    const redis = createMockRedis();
    redis.hmget.mockResolvedValue([null, null, null]);
    const store = new TransferSessionStore(redis as any);

    const result = await store.extendTTL(
      'agent_transfer:tenant-1:contact-1:chat',
      undefined,
      'chat',
    );

    expect(result).toBe(false);
  });

  it('with channel hint for voice: returns true without pipeline (TTL=0)', async () => {
    const redis = createMockRedis();
    const store = new TransferSessionStore(redis as any);

    const result = await store.extendTTL(
      'agent_transfer:tenant-1:contact-1:voice',
      undefined,
      'voice',
    );

    expect(result).toBe(true);
    // Lua eval should not be called for voice (TTL=0)
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('with explicit ttl: uses provided ttl regardless of channel', async () => {
    const redis = createMockRedis();
    const store = new TransferSessionStore(redis as any);

    await store.extendTTL('agent_transfer:tenant-1:contact-1:chat', 3600, 'chat');

    // extendTTL now uses atomic Lua script (redis.eval) instead of pipeline
    expect(redis.eval).toHaveBeenCalled();
    // redis.eval args: (script, numkeys, ...keys, effectiveTtl, now, now)
    const args = redis.eval.mock.calls[0];
    const numkeys = args[1] as number;
    const ttlArgIndex = 2 + numkeys; // skip script + numkeys + key slots
    // runLuaScript stringifies all ARGV (Redis ARGV is always string-typed).
    expect(args[ttlArgIndex]).toBe('3600');
  });
});

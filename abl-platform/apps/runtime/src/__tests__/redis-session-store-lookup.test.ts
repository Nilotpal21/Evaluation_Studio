import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisSessionStore } from '../services/session/redis-session-store.js';

function createMockRedis() {
  const pipeline = {
    del: vi.fn().mockReturnThis(),
    hmset: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    rpush: vi.fn().mockReturnThis(),
    hgetall: vi.fn().mockReturnThis(),
    lrange: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };

  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    hmget: vi.fn().mockResolvedValue([null, null, null]),
    hmset: vi.fn().mockResolvedValue('OK'),
    expire: vi.fn().mockResolvedValue(1),
    hget: vi.fn().mockResolvedValue(null),
    hgetall: vi.fn().mockResolvedValue({}),
    lrange: vi.fn().mockResolvedValue([]),
    eval: vi.fn().mockResolvedValue(0),
    getBuffer: vi.fn().mockResolvedValue(null),
    pipeline: vi.fn(() => pipeline),
    _pipeline: pipeline,
  };
}

describe('RedisSessionStore reverse lookup fail-closed behavior', () => {
  let redis: ReturnType<typeof createMockRedis>;
  let store: RedisSessionStore;

  beforeEach(() => {
    redis = createMockRedis();
    store = new RedisSessionStore(redis as any, { sessionTtlMinutes: 30 });
  });

  it('returns null for session reads when the reverse lookup key is missing', async () => {
    await expect(store.load('sess-missing')).resolves.toBeNull();
    await expect(store.getVersion('sess-missing')).resolves.toBeNull();

    expect(redis.pipeline).not.toHaveBeenCalled();
    expect(redis.hget).not.toHaveBeenCalled();
  });

  it('returns empty history and skips conversation mutations when the reverse lookup key is missing', async () => {
    await expect(store.getConversationHistory('sess-missing')).resolves.toEqual([]);

    await store.appendMessages('sess-missing', [{ role: 'user', content: 'hello' }]);
    await store.replaceConversation('sess-missing', [{ role: 'assistant', content: 'hi' }]);
    await store.trimConversation('sess-missing', 20);

    expect(redis.lrange).not.toHaveBeenCalled();
    expect(redis.hmget).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
    expect(redis.pipeline).not.toHaveBeenCalled();
  });

  it('skips registry and ttl mutations when the reverse lookup key is missing', async () => {
    await store.setAgentRegistry('sess-missing', { supervisor: 'hash-1' });
    await expect(store.getAgentRegistry('sess-missing')).resolves.toBeNull();
    await store.touch('sess-missing');
    await store.delete('sess-missing');

    expect(redis.hmset).not.toHaveBeenCalled();
    expect(redis.hgetall).not.toHaveBeenCalled();
    expect(redis.hmget).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
    expect(redis.pipeline).not.toHaveBeenCalled();
  });

  it('refuses lock operations when the reverse lookup key is missing', async () => {
    await expect(store.acquireLock('sess-missing', 5000)).resolves.toBe(false);
    await store.releaseLock('sess-missing');

    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('preserves explicit empty-tenant compatibility when the reverse lookup exists', async () => {
    redis.get.mockResolvedValue('');
    redis.hmget.mockResolvedValue([String(Date.now()), null, null]);

    await store.appendMessages('sess-legacy', [{ role: 'user', content: 'hello' }]);

    expect(redis.pipeline).toHaveBeenCalledTimes(1);
    expect(redis._pipeline.rpush).toHaveBeenCalled();
    expect(redis._pipeline.expire).toHaveBeenCalled();
  });
});

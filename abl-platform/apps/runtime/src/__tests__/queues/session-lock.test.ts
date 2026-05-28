import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RedisSetResult = 'OK' | null;

interface RedisLike {
  set: (
    key: string,
    value: string,
    ttlMode: 'EX',
    ttlSeconds: number,
    existenceMode: 'NX',
  ) => Promise<RedisSetResult>;
  eval: (script: string, numKeys: number, key: string, owner: string) => Promise<number>;
}

interface LockEntry {
  owner: string;
  expiresAtMs: number;
}

const mocks = vi.hoisted(() => ({
  redis: null as RedisLike | null,
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => mocks.logger),
}));

vi.mock('../../services/redis/redis-client.js', () => ({
  getRedisClient: vi.fn(() => mocks.redis),
  getRedisHandle: () => null,
}));

function createLockRedis(): RedisLike {
  const locks = new Map<string, LockEntry>();

  const pruneExpiredLock = (key: string): void => {
    const existing = locks.get(key);
    if (existing && existing.expiresAtMs <= Date.now()) {
      locks.delete(key);
    }
  };

  return {
    set: vi.fn(async (key, value, _ttlMode, ttlSeconds, _existenceMode) => {
      pruneExpiredLock(key);
      if (locks.has(key)) {
        return null;
      }

      locks.set(key, {
        owner: value,
        expiresAtMs: Date.now() + ttlSeconds * 1000,
      });
      return 'OK';
    }),
    eval: vi.fn(async (_script, _numKeys, key, owner) => {
      pruneExpiredLock(key);
      const existing = locks.get(key);
      if (!existing || existing.owner !== owner) {
        return 0;
      }

      locks.delete(key);
      return 1;
    }),
  };
}

async function loadSessionLockModule(): Promise<
  typeof import('../../services/queues/session-lock.js')
> {
  return import('../../services/queues/session-lock.js');
}

describe('session-lock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mocks.redis = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('acquires and releases a session lock for the owning worker', async () => {
    mocks.redis = createLockRedis();
    const { acquireSessionLock, releaseSessionLock } = await loadSessionLockModule();

    await expect(acquireSessionLock('channel:lock:session-1', 'owner-1')).resolves.toBe(true);

    await releaseSessionLock('channel:lock:session-1', 'owner-1');

    await expect(acquireSessionLock('channel:lock:session-1', 'owner-2')).resolves.toBe(true);
  });

  it('fails closed and emits degraded-mode logging when Redis is unavailable', async () => {
    const { acquireSessionLock } = await loadSessionLockModule();

    await expect(acquireSessionLock('channel:lock:session-outage', 'owner-outage')).resolves.toBe(
      false,
    );
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('session lock denied'),
      expect.objectContaining({
        lockKey: 'channel:lock:session-outage',
        lockOwner: 'owner-outage',
      }),
    );
  });

  it('fails closed and emits degraded-mode logging when Redis throws during acquisition', async () => {
    mocks.redis = {
      set: vi.fn(async () => {
        throw new Error('redis set failed');
      }),
      eval: vi.fn(async () => 0),
    };
    const { acquireSessionLock } = await loadSessionLockModule();

    await expect(
      acquireSessionLock('channel:lock:session-exception', 'owner-exception'),
    ).resolves.toBe(false);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('session lock denied'),
      expect.objectContaining({
        lockKey: 'channel:lock:session-exception',
        lockOwner: 'owner-exception',
        error: 'redis set failed',
      }),
    );
  });

  it('allows a new owner to acquire after the TTL expires', async () => {
    vi.useFakeTimers();
    mocks.redis = createLockRedis();
    const { acquireSessionLock } = await loadSessionLockModule();

    await expect(acquireSessionLock('channel:lock:session-ttl', 'owner-1')).resolves.toBe(true);

    await vi.advanceTimersByTimeAsync(120_000);

    await expect(acquireSessionLock('channel:lock:session-ttl', 'owner-2')).resolves.toBe(true);
  });

  it('waits for a contended lock to be released before succeeding', async () => {
    vi.useFakeTimers();
    mocks.redis = createLockRedis();
    const { acquireSessionLock, releaseSessionLock } = await loadSessionLockModule();

    await expect(acquireSessionLock('channel:lock:session-contention', 'owner-1')).resolves.toBe(
      true,
    );

    let contenderResolved = false;
    const contenderPromise = acquireSessionLock('channel:lock:session-contention', 'owner-2').then(
      (result) => {
        contenderResolved = true;
        return result;
      },
    );

    await Promise.resolve();
    expect(contenderResolved).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    expect(contenderResolved).toBe(false);

    await releaseSessionLock('channel:lock:session-contention', 'owner-1');
    await vi.advanceTimersByTimeAsync(500);

    await expect(contenderPromise).resolves.toBe(true);
  });
});

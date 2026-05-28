import { describe, it, expect, vi } from 'vitest';

// Mock ioredis
vi.mock('ioredis', () => {
  class MockRedis {
    options: Record<string, unknown>;
    status: string = 'ready';
    disconnected = false;

    constructor(port?: number | string, host?: string, opts?: Record<string, unknown>) {
      this.options = { port, host, ...opts };
    }

    duplicate(overrides?: Record<string, unknown>) {
      return new MockRedis(this.options.port as number, this.options.host as string, {
        ...this.options,
        ...overrides,
      });
    }

    disconnect() {
      this.disconnected = true;
    }

    on() {
      return this;
    }
  }

  // Stub Cluster — sufficient for `instanceof` discrimination in production code.
  class MockCluster {
    nodes: unknown[];
    options: Record<string, unknown>;
    status: string = 'ready';
    disconnected = false;
    constructor(nodes: unknown[], options: Record<string, unknown>) {
      this.nodes = nodes;
      this.options = options;
    }
    on() {
      return this;
    }
    disconnect() {
      this.disconnected = true;
    }
    async quit() {
      this.status = 'end';
    }
  }

  (MockRedis as unknown as { Cluster: typeof MockCluster }).Cluster = MockCluster;
  return { Redis: MockRedis, Cluster: MockCluster, default: MockRedis };
});

import {
  createBullMQConnectionOptions,
  createBullMQConnectionPair,
  createBullMQPair,
  resolveBullMQConnectionFromEnv,
  defaultWorkerOptions,
  getBullMQPrefix,
  BULLMQ_CLUSTER_SAFE_PREFIX,
  BULLMQ_LEGACY_PREFIX,
} from '../bullmq.js';
import { createRedisConnection } from '../connection.js';

function redisClusterSlot(key: string): number {
  const open = key.indexOf('{');
  if (open !== -1) {
    const close = key.indexOf('}', open + 1);
    if (close > open + 1) {
      key = key.slice(open + 1, close);
    }
  }

  let crc = 0;
  for (const byte of Buffer.from(key)) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc % 16_384;
}

describe('createBullMQConnectionOptions', () => {
  it('sets maxRetriesPerRequest to null', () => {
    const opts = createBullMQConnectionOptions();
    expect(opts.maxRetriesPerRequest).toBeNull();
  });

  it('parses URL into host/port/password', () => {
    const opts = createBullMQConnectionOptions({
      url: 'redis://user:pass@myhost:6380/2',
    });
    expect(opts.host).toBe('myhost');
    expect(opts.port).toBe(6380);
    expect(opts.password).toBe('pass');
    expect(opts.username).toBe('user');
    expect(opts.db).toBe(2);
    expect(opts.maxRetriesPerRequest).toBeNull();
  });

  it('lets explicit password override URL credentials', () => {
    const opts = createBullMQConnectionOptions({
      url: 'redis://user:url-pass@myhost:6380/2',
      password: 'env-pass',
    });
    expect(opts.password).toBe('env-pass');
  });

  it('uses host/port when no URL', () => {
    const opts = createBullMQConnectionOptions({
      host: 'redis.local',
      port: 6379,
      password: 'secret',
    });
    expect(opts.host).toBe('redis.local');
    expect(opts.port).toBe(6379);
    expect(opts.password).toBe('secret');
    expect(opts.maxRetriesPerRequest).toBeNull();
  });

  it('defaults to localhost:6380 (DEFAULT_REDIS_PORT)', () => {
    const opts = createBullMQConnectionOptions({});
    expect(opts.host).toBe('localhost');
    expect(opts.port).toBe(6380);
  });

  it('sets TLS for rediss:// URL', () => {
    const opts = createBullMQConnectionOptions({
      url: 'rediss://myhost:6380',
    });
    expect(opts.tls).toEqual({});
  });

  it('sets TLS from explicit config', () => {
    const opts = createBullMQConnectionOptions({
      host: 'myhost',
      tls: { enabled: true },
    });
    expect(opts.tls).toEqual({});
  });
});

describe('createBullMQConnectionPair', () => {
  it('creates separate queue and worker connections', () => {
    const { Redis } = require('ioredis');
    const base = new Redis(6380, 'localhost', { maxRetriesPerRequest: 3 });

    const pair = createBullMQConnectionPair(base);

    expect(pair.queueConnection).toBeDefined();
    expect(pair.workerConnection).toBeDefined();
    expect(pair.queueConnection).not.toBe(pair.workerConnection);
  });

  it('sets maxRetriesPerRequest: null on both connections', () => {
    const { Redis } = require('ioredis');
    const base = new Redis(6380, 'localhost', { maxRetriesPerRequest: 3 });

    const pair = createBullMQConnectionPair(base);

    expect((pair.queueConnection as any).options.maxRetriesPerRequest).toBeNull();
    expect((pair.workerConnection as any).options.maxRetriesPerRequest).toBeNull();
  });

  it('disconnect() calls disconnect on both connections', () => {
    const { Redis } = require('ioredis');
    const base = new Redis(6380, 'localhost');

    const pair = createBullMQConnectionPair(base);
    const qSpy = vi.spyOn(pair.queueConnection as any, 'disconnect');
    const wSpy = vi.spyOn(pair.workerConnection as any, 'disconnect');

    pair.disconnect();

    expect(qSpy).toHaveBeenCalled();
    expect(wSpy).toHaveBeenCalled();
  });
});

describe('createBullMQPair watchdog (GAP-008)', () => {
  // Build handles via the real factory so the `Redis` / `Cluster` identity
  // is the same one bullmq.ts sees. (Direct `new Redis()` in the test can
  // cross a module-identity boundary under vitest, defeating `instanceof`.)
  function makeStandaloneHandle() {
    return createRedisConnection({
      host: 'localhost',
      port: 6380,
      lazyConnect: true,
    });
  }

  function makeClusterHandle() {
    return createRedisConnection({
      cluster: true,
      url: 'redis://redis-0:6379,redis://redis-1:6379,redis://redis-2:6379',
      password: 'x',
      lazyConnect: true,
    });
  }

  it('does NOT arm watchdog by default for standalone', () => {
    vi.useFakeTimers();
    try {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const handle = makeStandaloneHandle();
      const pair = createBullMQPair(handle);

      // No interval scheduled when isCluster=false and watchdog flag is unset.
      expect(setIntervalSpy).not.toHaveBeenCalled();

      pair.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('arms watchdog by default when handle is a cluster', () => {
    vi.useFakeTimers();
    try {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const handle = makeClusterHandle();
      const pair = createBullMQPair(handle);

      // Cluster default = watchdog ON. Exactly one interval is registered
      // for the worker connection.
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      pair.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('explicit watchdog: true arms in standalone mode too', () => {
    vi.useFakeTimers();
    try {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const handle = makeStandaloneHandle();
      const pair = createBullMQPair(handle, { watchdog: true });

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      pair.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('explicit watchdog: false suppresses arming in cluster mode', () => {
    vi.useFakeTimers();
    try {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const handle = makeClusterHandle();
      const pair = createBullMQPair(handle, { watchdog: false });

      expect(setIntervalSpy).not.toHaveBeenCalled();
      pair.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('disconnect() clears the watchdog timer', () => {
    vi.useFakeTimers();
    try {
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
      const handle = makeClusterHandle();
      const pair = createBullMQPair(handle);

      pair.disconnect();

      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forces a reconnect after sustained stuck-status', () => {
    vi.useFakeTimers();
    try {
      const handle = makeClusterHandle();
      const pair = createBullMQPair(handle);

      // Worker connection is the second instance produced by buildClusterForBullMQ.
      const worker = pair.workerConnection as { status: string; disconnect: () => void };
      const disconnectSpy = vi.spyOn(worker, 'disconnect');

      // Drive the connection into a stuck state — anything that's not
      // 'ready' / 'connecting' / 'reconnecting' counts.
      worker.status = 'wait';

      // First tick records stuckSince.
      vi.advanceTimersByTime(5_000);
      expect(disconnectSpy).not.toHaveBeenCalled();

      // After the 30s threshold elapses, watchdog forces a reconnect.
      vi.advanceTimersByTime(35_000);
      expect(disconnectSpy).toHaveBeenCalledTimes(1);

      pair.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('getBullMQPrefix', () => {
  it('keeps legacy bull prefix for standalone clients and handles', () => {
    const handle = createRedisConnection({
      host: 'localhost',
      port: 6380,
      lazyConnect: true,
    });

    expect(getBullMQPrefix(handle)).toBe(BULLMQ_LEGACY_PREFIX);
    expect(getBullMQPrefix(handle.client)).toBe(BULLMQ_LEGACY_PREFIX);
  });

  it('allows callers to preserve an existing standalone prefix', () => {
    const handle = createRedisConnection({
      host: 'localhost',
      port: 6380,
      lazyConnect: true,
    });

    expect(getBullMQPrefix(handle, { standalonePrefix: BULLMQ_CLUSTER_SAFE_PREFIX })).toBe(
      BULLMQ_CLUSTER_SAFE_PREFIX,
    );
  });

  it('uses hash-tagged prefix for cluster clients and handles', () => {
    const handle = createRedisConnection({
      cluster: true,
      url: 'redis://redis-0:6379,redis://redis-1:6379,redis://redis-2:6379',
      lazyConnect: true,
    });

    expect(getBullMQPrefix(handle)).toBe(BULLMQ_CLUSTER_SAFE_PREFIX);
    expect(getBullMQPrefix(handle.client)).toBe(BULLMQ_CLUSTER_SAFE_PREFIX);
  });

  it('puts BullMQ wait and active keys in one Redis Cluster slot for cluster prefix', () => {
    const waitSlot = redisClusterSlot(`${BULLMQ_CLUSTER_SAFE_PREFIX}:execution-resume:wait`);
    const activeSlot = redisClusterSlot(`${BULLMQ_CLUSTER_SAFE_PREFIX}:execution-resume:active`);

    expect(waitSlot).toBe(activeSlot);
  });

  it('documents why the legacy BullMQ prefix is unsafe in Redis Cluster', () => {
    const waitSlot = redisClusterSlot(`${BULLMQ_LEGACY_PREFIX}:execution-resume:wait`);
    const activeSlot = redisClusterSlot(`${BULLMQ_LEGACY_PREFIX}:execution-resume:active`);

    expect(waitSlot).not.toBe(activeSlot);
  });
});

describe('resolveBullMQConnectionFromEnv', () => {
  it('returns null when REDIS_ENABLED=false', () => {
    const result = resolveBullMQConnectionFromEnv({ REDIS_ENABLED: 'false' });
    expect(result).toBeNull();
  });

  it('parses REDIS_URL', () => {
    const result = resolveBullMQConnectionFromEnv({
      REDIS_URL: 'redis://myhost:6380',
    });
    expect(result).toBeDefined();
    expect(result!.host).toBe('myhost');
    expect(result!.port).toBe(6380);
    expect(result!.maxRetriesPerRequest).toBeNull();
  });

  it('uses REDIS_HOST and REDIS_PORT', () => {
    const result = resolveBullMQConnectionFromEnv({
      REDIS_HOST: 'redis.local',
      REDIS_PORT: '6379',
    });
    expect(result!.host).toBe('redis.local');
    expect(result!.port).toBe(6379);
    expect(result!.maxRetriesPerRequest).toBeNull();
  });

  it('returns defaults when no env vars set', () => {
    const result = resolveBullMQConnectionFromEnv({});
    expect(result!.host).toBe('localhost');
    expect(result!.port).toBe(6380);
    expect(result!.maxRetriesPerRequest).toBeNull();
  });
});

describe('defaultWorkerOptions', () => {
  it('returns correct defaults', () => {
    const opts = defaultWorkerOptions();
    expect(opts.concurrency).toBe(5);
    expect(opts.prefix).toBe(BULLMQ_CLUSTER_SAFE_PREFIX);
    expect(opts.removeOnComplete.age).toBe(86_400);
    expect(opts.removeOnFail.age).toBe(604_800);
  });

  it('accepts custom concurrency', () => {
    const opts = defaultWorkerOptions(10);
    expect(opts.concurrency).toBe(10);
  });
});

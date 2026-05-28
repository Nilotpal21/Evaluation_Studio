import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock ioredis before importing connection module
vi.mock('ioredis', () => {
  class MockRedis {
    options: Record<string, unknown>;
    status: string = 'wait';

    constructor(port?: number, host?: string, opts?: Record<string, unknown>) {
      this.options = { port, host, ...opts };
    }

    on(_event: string, _fn: (...args: unknown[]) => void) {
      return this;
    }
    async connect() {
      this.status = 'ready';
    }
    async quit() {
      this.status = 'end';
    }
    duplicate(overrides?: Record<string, unknown>) {
      const dup = new MockRedis(this.options.port as number, this.options.host as string, {
        ...this.options,
        ...overrides,
      });
      return dup;
    }
  }

  // Simulate Cluster constructor
  (MockRedis as any).Cluster = class MockCluster {
    nodes: unknown[];
    options: Record<string, unknown>;
    status: string = 'wait';
    constructor(nodes: unknown[], options: Record<string, unknown>) {
      this.nodes = nodes;
      this.options = options;
    }
    on() {
      return this;
    }
    async quit() {}
  };

  return { Redis: MockRedis, default: MockRedis };
});

import {
  createRedisConnection,
  resolveRedisOptionsFromEnv,
  resolveRedisOptionsFromConfig,
} from '../connection.js';

describe('createRedisConnection', () => {
  it('creates a connection with defaults', () => {
    const handle = createRedisConnection();
    expect(handle.client).toBeDefined();
    expect(handle.isReady).toBeDefined();
    expect(handle.duplicate).toBeDefined();
    expect(handle.disconnect).toBeDefined();
  });

  it('creates a connection from URL', () => {
    const handle = createRedisConnection({
      url: 'redis://user:pass@myhost:6380/2',
    });
    const opts = (handle.client as any).options;
    expect(opts.host).toBe('myhost');
    expect(opts.port).toBe(6380);
    expect(opts.password).toBe('pass');
    expect(opts.username).toBe('user');
    expect(opts.db).toBe(2);
  });

  it('lets explicit password override URL credentials', () => {
    const handle = createRedisConnection({
      url: 'redis://user:url-pass@myhost:6380/2',
      password: 'env-pass',
    });
    const opts = (handle.client as any).options;
    expect(opts.password).toBe('env-pass');
  });

  it('parses cluster seeds with credentials and rediss TLS', () => {
    const handle = createRedisConnection({
      url: 'rediss://:seed-pass@redis-a:6380,redis://redis-b:6381',
      cluster: true,
    });
    const cluster = handle.client as any;
    expect(cluster.nodes).toEqual([
      { host: 'redis-a', port: 6380 },
      { host: 'redis-b', port: 6381 },
    ]);
    expect(cluster.options.redisOptions.password).toBe('seed-pass');
    expect(cluster.options.redisOptions.tls).toBeDefined();
  });

  it('uses explicit password for cluster seeds when provided', () => {
    const handle = createRedisConnection({
      url: 'redis://:seed-pass@redis-a:6380,redis://redis-b:6381',
      password: 'env-pass',
      cluster: true,
    });
    const cluster = handle.client as any;
    expect(cluster.options.redisOptions.password).toBe('env-pass');
  });

  it('creates a connection from host/port', () => {
    const handle = createRedisConnection({
      host: 'redis.local',
      port: 6379,
    });
    const opts = (handle.client as any).options;
    expect(opts.host).toBe('redis.local');
    expect(opts.port).toBe(6379);
  });

  it('sets maxRetriesPerRequest from options', () => {
    const handle = createRedisConnection({ maxRetriesPerRequest: null });
    const opts = (handle.client as any).options;
    expect(opts.maxRetriesPerRequest).toBeNull();
  });

  it('defaults maxRetriesPerRequest to 3', () => {
    const handle = createRedisConnection();
    const opts = (handle.client as any).options;
    expect(opts.maxRetriesPerRequest).toBe(3);
  });

  it('enables TLS for rediss:// URL', () => {
    const handle = createRedisConnection({
      url: 'rediss://myhost:6380',
    });
    const opts = (handle.client as any).options;
    expect(opts.tls).toBeDefined();
  });

  it('enables TLS from explicit config', () => {
    const handle = createRedisConnection({
      host: 'myhost',
      tls: { enabled: true, rejectUnauthorized: false },
    });
    const opts = (handle.client as any).options;
    expect(opts.tls).toBeDefined();
    expect(opts.tls.rejectUnauthorized).toBe(false);
  });

  it('defaults lazyConnect to true', () => {
    const handle = createRedisConnection();
    const opts = (handle.client as any).options;
    expect(opts.lazyConnect).toBe(true);
  });

  it('defaults enableOfflineQueue to true', () => {
    const handle = createRedisConnection();
    const opts = (handle.client as any).options;
    expect(opts.enableOfflineQueue).toBe(true);
  });

  it('duplicate() passes overrides', () => {
    const handle = createRedisConnection();
    const dup = handle.duplicate({ maxRetriesPerRequest: null });
    expect((dup as any).options.maxRetriesPerRequest).toBeNull();
  });

  it('disconnect() calls quit', async () => {
    const handle = createRedisConnection();
    const quitSpy = vi.spyOn(handle.client as any, 'quit');
    await handle.disconnect();
    expect(quitSpy).toHaveBeenCalled();
  });
});

describe('resolveRedisOptionsFromEnv', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns null when REDIS_ENABLED=false', () => {
    const result = resolveRedisOptionsFromEnv({ REDIS_ENABLED: 'false' });
    expect(result).toBeNull();
  });

  it('returns options with URL from REDIS_URL', () => {
    const result = resolveRedisOptionsFromEnv({ REDIS_URL: 'redis://host:6380' });
    expect(result).toEqual({ url: 'redis://host:6380' });
  });

  it('keeps REDIS_PASSWORD when REDIS_URL is set', () => {
    const result = resolveRedisOptionsFromEnv({
      REDIS_URL: 'redis://host:6380',
      REDIS_PASSWORD: 'secret',
    });
    expect(result).toEqual({ url: 'redis://host:6380', password: 'secret' });
  });

  it('maps REDIS_TLS_ENABLED into TLS options', () => {
    const result = resolveRedisOptionsFromEnv({
      REDIS_URL: 'redis://host:6380',
      REDIS_TLS_ENABLED: 'true',
    });
    expect(result).toEqual({ url: 'redis://host:6380', tls: { enabled: true } });
  });

  it('returns options with host/port from env', () => {
    const result = resolveRedisOptionsFromEnv({
      REDIS_HOST: 'redis.local',
      REDIS_PORT: '6379',
    });
    expect(result).toEqual({ host: 'redis.local', port: 6379 });
  });

  it('returns empty options when nothing is set (defaults apply later)', () => {
    const result = resolveRedisOptionsFromEnv({});
    expect(result).toEqual({});
  });
});

describe('resolveRedisOptionsFromConfig', () => {
  it('returns null when enabled=false', () => {
    const result = resolveRedisOptionsFromConfig({ enabled: false });
    expect(result).toBeNull();
  });

  it('returns null when no URL and not explicitly enabled', () => {
    const result = resolveRedisOptionsFromConfig({});
    expect(result).toBeNull();
  });

  it('returns options with URL', () => {
    const result = resolveRedisOptionsFromConfig({
      url: 'redis://host:6380',
      enabled: true,
    });
    expect(result).toEqual({ url: 'redis://host:6380' });
  });

  it('sets cluster flag', () => {
    const result = resolveRedisOptionsFromConfig({
      url: 'host1:6379,host2:6379',
      enabled: true,
      cluster: true,
    });
    expect(result?.cluster).toBe(true);
  });

  it('passes through configured password', () => {
    const result = resolveRedisOptionsFromConfig({
      url: 'redis://host:6380',
      enabled: true,
      password: 'secret',
    });
    expect(result?.password).toBe('secret');
  });

  it('normalizes boolean TLS config', () => {
    const result = resolveRedisOptionsFromConfig({
      url: 'redis://host:6380',
      enabled: true,
      tls: true,
    });
    expect(result?.tls).toEqual({ enabled: true });
  });

  it('passes through TLS object config', () => {
    const result = resolveRedisOptionsFromConfig({
      url: 'redis://host:6380',
      enabled: true,
      tls: { enabled: true, caFile: '/path/to/ca.pem', rejectUnauthorized: false },
    });
    expect(result?.tls?.caFile).toBe('/path/to/ca.pem');
    expect(result?.tls?.rejectUnauthorized).toBe(false);
  });
});

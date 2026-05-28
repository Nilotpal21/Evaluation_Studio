import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock ioredis with both Redis and Cluster constructors so `instanceof` works
// across the helpers.
vi.mock('ioredis', () => {
  type Handler = (...args: unknown[]) => void;

  class MockRedis {
    options: Record<string, unknown>;
    status: string = 'ready';
    disconnected = false;
    private handlers = new Map<string, Handler[]>();

    constructor(port?: number | string, host?: string, opts?: Record<string, unknown>) {
      this.options = { port, host, ...opts };
    }
    on(event: string, fn: Handler) {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
      return this;
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
    async quit() {
      this.status = 'end';
    }
    async eval(_body: string, _numKeys: number, ..._rest: unknown[]) {
      return 'OK';
    }
    async scan(cursor: string, ..._rest: unknown[]): Promise<[string, string[]]> {
      // Single round: return a fixed batch then cursor=0.
      if (cursor === '0') return ['1', ['key:a', 'key:b']];
      return ['0', ['key:c']];
    }
  }

  class MockCluster {
    seedNodes: unknown[];
    options: Record<string, unknown>;
    status: string = 'ready';
    disconnected = false;
    private masters: MockRedis[] = [];

    constructor(nodes: unknown[], options: Record<string, unknown>) {
      this.seedNodes = nodes;
      this.options = options;
    }
    on() {
      return this;
    }
    setMasters(m: MockRedis[]) {
      this.masters = m;
    }
    // Match ioredis API name.
    nodes(role: string): MockRedis[] {
      void role;
      return this.masters;
    }
    async quit() {
      this.status = 'end';
    }
    disconnect() {
      this.disconnected = true;
    }
    async eval(_body: string, _numKeys: number, ..._rest: unknown[]) {
      return 'CLUSTER_OK';
    }
  }

  (MockRedis as unknown as { Cluster: typeof MockCluster }).Cluster = MockCluster;
  return { Redis: MockRedis, Cluster: MockCluster, default: MockRedis };
});

import { hashTag, scanKeys } from '../keys.js';
import { runLuaScript, type LuaScript } from '../lua.js';
import { RedisCrossSlotError, RedisOperationError } from '../errors.js';

describe('hashTag', () => {
  it('wraps a single part in braces', () => {
    expect(hashTag('foo')).toBe('{foo}');
  });

  it('joins multiple parts with colons', () => {
    expect(hashTag('tenant42', 'session99')).toBe('{tenant42:session99}');
  });

  it('handles empty input', () => {
    expect(hashTag()).toBe('{}');
  });
});

describe('runLuaScript', () => {
  let client: { eval: ReturnType<typeof vi.fn> };
  const script: LuaScript = {
    name: 'test_script',
    body: "return 'OK'",
    numberOfKeys: 1,
  };

  beforeEach(() => {
    client = { eval: vi.fn(async () => 'OK') };
  });

  it('passes keys then string-coerced args to client.eval', async () => {
    await runLuaScript(
      client as unknown as Parameters<typeof runLuaScript>[0],
      script,
      ['k1'],
      ['a', 42],
    );
    expect(client.eval).toHaveBeenCalledWith(script.body, 1, 'k1', 'a', '42');
  });

  it('throws RedisOperationError when numberOfKeys mismatches', async () => {
    await expect(
      runLuaScript(
        client as unknown as Parameters<typeof runLuaScript>[0],
        script,
        ['k1', 'k2'],
        [],
      ),
    ).rejects.toBeInstanceOf(RedisOperationError);
  });

  it('translates CROSSSLOT replies to RedisCrossSlotError', async () => {
    client.eval = vi.fn(async () => {
      throw new Error("CROSSSLOT Keys in request don't hash to the same slot");
    });
    await expect(
      runLuaScript(client as unknown as Parameters<typeof runLuaScript>[0], script, ['k1'], []),
    ).rejects.toBeInstanceOf(RedisCrossSlotError);
  });

  it('wraps non-CROSSSLOT errors in RedisOperationError', async () => {
    client.eval = vi.fn(async () => {
      throw new Error('NOSCRIPT No matching script');
    });
    await expect(
      runLuaScript(client as unknown as Parameters<typeof runLuaScript>[0], script, ['k1'], []),
    ).rejects.toBeInstanceOf(RedisOperationError);
  });
});

describe('scanKeys (standalone)', () => {
  it('iterates the cursor loop and yields each key once', async () => {
    // Use the real mocked Redis class from the vi.mock above.
    const { Redis } = await import('ioredis');
    const client = new Redis();
    const keys: string[] = [];
    for await (const k of scanKeys(client, '*')) keys.push(k);
    expect(keys).toEqual(['key:a', 'key:b', 'key:c']);
  });
});

describe('scanKeys (cluster fan-out)', () => {
  // Build a stand-in master with a cursor-driven scan we can pre-program
  // per node. Mirrors what `client.nodes('master')` returns from ioredis.
  function makeMaster(host: string, batches: string[][]) {
    let i = 0;
    return {
      options: { host, port: 6379 },
      async scan(_cursor: string, ..._rest: unknown[]): Promise<[string, string[]]> {
        const batch = batches[i] ?? [];
        i += 1;
        const next = i >= batches.length ? '0' : String(i);
        return [next, batch];
      },
    };
  }

  it('fans out across every master and yields the union of keys', async () => {
    const { Cluster } = await import('ioredis');
    const cluster = new Cluster([], {}) as unknown as {
      setMasters: (m: unknown[]) => void;
    };
    const m1 = makeMaster('redis-0', [['a', 'b']]);
    const m2 = makeMaster('redis-1', [['c']]);
    const m3 = makeMaster('redis-2', [['d', 'e']]);
    cluster.setMasters([m1, m2, m3]);

    const keys: string[] = [];
    for await (const k of scanKeys(cluster as unknown as Parameters<typeof scanKeys>[0], '*')) {
      keys.push(k);
    }
    expect(keys.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('dedupes keys observed on multiple masters during slot migration', async () => {
    const { Cluster } = await import('ioredis');
    const cluster = new Cluster([], {}) as unknown as {
      setMasters: (m: unknown[]) => void;
    };
    // `slot:moving` appears on both source and target masters mid-migration.
    const m1 = makeMaster('redis-0', [['slot:moving', 'a']]);
    const m2 = makeMaster('redis-1', [['slot:moving', 'b']]);
    cluster.setMasters([m1, m2]);

    const keys: string[] = [];
    for await (const k of scanKeys(cluster as unknown as Parameters<typeof scanKeys>[0], '*')) {
      keys.push(k);
    }
    expect(keys.filter((k) => k === 'slot:moving')).toHaveLength(1);
    expect(keys.sort()).toEqual(['a', 'b', 'slot:moving']);
  });

  it('throws RedisOperationError when the dedupe set exceeds maxKeys', async () => {
    const { Cluster } = await import('ioredis');
    const cluster = new Cluster([], {}) as unknown as {
      setMasters: (m: unknown[]) => void;
    };
    // Single master returns more keys than the cap allows.
    const big = Array.from({ length: 10 }, (_, i) => `k${i}`);
    cluster.setMasters([makeMaster('redis-0', [big])]);

    const consume = async () => {
      const out: string[] = [];
      for await (const k of scanKeys(
        cluster as unknown as Parameters<typeof scanKeys>[0],
        '*',
        100,
        3, // maxKeys = 3, will trip after the 3rd unique key
      )) {
        out.push(k);
      }
      return out;
    };
    await expect(consume()).rejects.toBeInstanceOf(RedisOperationError);
  });

  it('skips a failed node and continues with the rest after one retry', async () => {
    const { Cluster } = await import('ioredis');
    const cluster = new Cluster([], {}) as unknown as {
      setMasters: (m: unknown[]) => void;
    };
    const flaky = {
      options: { host: 'redis-fail', port: 6379 },
      // First call throws, second call (the retry inside scanKeys) throws too,
      // so the node is skipped silently.
      scan: vi.fn(async () => {
        throw new Error('connection lost');
      }),
    };
    const healthy = makeMaster('redis-ok', [['ok-1', 'ok-2']]);
    cluster.setMasters([flaky, healthy]);

    const keys: string[] = [];
    for await (const k of scanKeys(cluster as unknown as Parameters<typeof scanKeys>[0], '*')) {
      keys.push(k);
    }
    expect(keys.sort()).toEqual(['ok-1', 'ok-2']);
  });
});

describe('RedisCrossSlotError', () => {
  it('exposes scriptName, keys, and the platform error code', () => {
    const err = new RedisCrossSlotError('my_script', ['{a}:1', '{b}:2']);
    expect(err.scriptName).toBe('my_script');
    expect(err.keys).toEqual(['{a}:1', '{b}:2']);
    expect(err.code).toBe('REDIS_CROSSSLOT_ERROR');
    expect(err).toBeInstanceOf(RedisOperationError);
  });
});

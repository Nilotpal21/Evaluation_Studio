/**
 * Redis Session Store — Compression Tests
 *
 * Tests the gzip compression logic added to RedisSessionStore.
 *
 * Key behavior under test:
 *   - JSON fields `threads` and `dataValues` are compressed when > 1 KB after JSON.stringify
 *   - Compressed fields receive a `gz:` prefix (outermost)
 *   - Without encryption the layering is: `gz:<base64-of-gzip-data>`
 *   - With encryption the layering is:    `gz:enc:<base64-ciphertext>`
 *   - Round-trip (create → load) produces identical data
 *   - Legacy uncompressed values (no `gz:` prefix) are still read correctly
 *   - Mixed sessions: large dataValues compressed, small threads not
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RedisSessionStore } from '../services/session/redis-session-store.js';

// =============================================================================
// CONSTANTS (mirrored from source for readability — not imported to stay decoupled)
// =============================================================================

const COMPRESSED_PREFIX = 'gz:';
const COMPRESSION_THRESHOLD = 1024; // bytes
const ENCRYPTED_PREFIX = 'enc:';

// =============================================================================
// MOCK REDIS CLIENT
// =============================================================================

/**
 * Creates a mock Redis client that stores data in memory and captures every
 * operation issued through pipeline().hmset() so tests can inspect what was
 * actually written to "Redis".
 */
function createMockRedis() {
  const stored: Record<string, any> = {};

  const makePipeline = () => {
    const ops: Array<[string, ...any[]]> = [];
    const pipeline = {
      hmset: (key: string, data: Record<string, string>) => {
        stored[key] = data;
        ops.push(['hmset', key, data]);
        return pipeline;
      },
      expire: (...args: any[]) => {
        ops.push(['expire', ...args]);
        return pipeline;
      },
      set: (...args: any[]) => {
        ops.push(['set', ...args]);
        return pipeline;
      },
      rpush: (...args: any[]) => {
        ops.push(['rpush', ...args]);
        return pipeline;
      },
      del: (...args: any[]) => {
        ops.push(['del', ...args]);
        return pipeline;
      },
      hgetall: (key: string) => {
        ops.push(['hgetall', key]);
        return pipeline;
      },
      lrange: (...args: any[]) => {
        ops.push(['lrange', ...args]);
        return pipeline;
      },
      exec: async () => {
        // Return realistic results for each op so load() can reconstruct the session
        return ops.map((op) => {
          if (op[0] === 'hgetall') return [null, stored[op[1]] || {}];
          if (op[0] === 'lrange') return [null, []];
          return [null, 'OK'];
        });
      },
    };
    return pipeline;
  };

  // Capture direct (non-pipeline) calls to the same `ops` style array so the
  // existing `expectOps` helpers continue to work after the cluster-safe
  // refactor moved create()/load()/extendTtl() off of pipeline() and into
  // individual commands.
  const directOps: Array<[string, ...any[]]> = [];

  return {
    // Reverse-lookup: sessionId → tenantId
    get: async (key: string) => stored[key] ?? null,
    set: async (key: string, val: any, ...rest: any[]) => {
      stored[key] = val;
      directOps.push(['set', key, val, ...rest]);
      return 'OK';
    },
    hmset: async (key: string, data: Record<string, string>) => {
      stored[key] = data;
      directOps.push(['hmset', key, data]);
      return 'OK';
    },
    hmget: async () => [null, null, null],
    hgetall: async (key: string) => stored[key] || {},
    hget: async () => null,
    rpush: async (key: string, ...vals: string[]) => {
      directOps.push(['rpush', key, ...vals]);
      return vals.length;
    },
    lrange: async () => [],
    expire: async (key: string, seconds: number) => {
      directOps.push(['expire', key, seconds]);
      return 1;
    },
    eval: async () => 1,
    del: async () => 1,
    getBuffer: async () => null,
    pipeline: () => makePipeline(),
    // Test-internal store reference (read-only) and direct-op capture.
    _stored: stored,
    _directOps: directOps,
  };
}

// =============================================================================
// HELPERS
// =============================================================================

/** Builds a minimal valid SessionData with the given field overrides. */
function makeSession(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'sess-1',
    agentName: 'test-agent',
    irSourceHash: 'hash1',
    compilationHash: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
    version: 1,
    isComplete: false,
    isEscalated: false,
    initialized: true,
    handoffStack: [],
    delegateStack: [],
    dataValues: {},
    dataGatheredKeys: [],
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    tenantId: 'tenant-1',
    ...overrides,
  };
}

/** Produces an object whose JSON.stringify() is guaranteed to exceed 1 KB. */
function makeLargeObject(label = 'value'): Record<string, string> {
  const obj: Record<string, string> = {};
  // Each entry adds ~30 bytes. 40 entries ≈ 1200 bytes, well over the 1024 threshold.
  for (let i = 0; i < 40; i++) {
    obj[`key_${i}_padding_xxxxxxxxxxxxxxxxxx`] = `${label}_${i}_${'y'.repeat(20)}`;
  }
  return obj;
}

/** Produces an array large enough to exceed 1 KB when stringified. */
function makeLargeThreads(): any[] {
  return Array.from({ length: 30 }, (_, i) => ({
    threadId: `thread-${i}-${'z'.repeat(20)}`,
    agentName: `agent-${i}`,
    status: 'active',
    messages: [`msg-${'a'.repeat(15)}`],
  }));
}

/** Extracts the stored hash for a session from the mock Redis store. */
function getStoredHash(
  redis: ReturnType<typeof createMockRedis>,
  tenantId: string,
  sessionId: string,
): Record<string, string> | undefined {
  return redis._stored[`sess:${tenantId}:${sessionId}`];
}

// =============================================================================
// TESTS: dataValues compression
// =============================================================================

describe('RedisSessionStore compression — dataValues', () => {
  let redis: ReturnType<typeof createMockRedis>;
  let store: RedisSessionStore;

  beforeEach(() => {
    redis = createMockRedis();
    store = new RedisSessionStore(redis, { sessionTtlMinutes: 30 });
  });

  it('stores small dataValues (< 1 KB) without gz: prefix', async () => {
    const smallDataValues = { name: 'Alice', age: '30' };
    // Verify it is actually small
    expect(Buffer.byteLength(JSON.stringify(smallDataValues))).toBeLessThan(COMPRESSION_THRESHOLD);

    const session = makeSession({ id: 'sess-small-dv', dataValues: smallDataValues });
    await store.create(session);

    const hash = getStoredHash(redis, 'tenant-1', 'sess-small-dv');
    expect(hash).toBeDefined();
    const storedDataValues = hash!['dataValues'];
    expect(storedDataValues).not.toMatch(new RegExp(`^${COMPRESSED_PREFIX}`));
    // Should be parseable JSON directly
    expect(() => JSON.parse(storedDataValues)).not.toThrow();
    expect(JSON.parse(storedDataValues)).toEqual(smallDataValues);
  });

  it('stores large dataValues (> 1 KB) with gz: prefix', async () => {
    const largeDataValues = makeLargeObject('data');
    // Confirm it actually exceeds the threshold
    expect(Buffer.byteLength(JSON.stringify(largeDataValues))).toBeGreaterThan(
      COMPRESSION_THRESHOLD,
    );

    const session = makeSession({ id: 'sess-large-dv', dataValues: largeDataValues });
    await store.create(session);

    const hash = getStoredHash(redis, 'tenant-1', 'sess-large-dv');
    expect(hash).toBeDefined();
    const storedDataValues = hash!['dataValues'];
    expect(storedDataValues).toMatch(new RegExp(`^${COMPRESSED_PREFIX}`));
  });
});

// =============================================================================
// TESTS: threads compression
// =============================================================================

describe('RedisSessionStore compression — threads', () => {
  let redis: ReturnType<typeof createMockRedis>;
  let store: RedisSessionStore;

  beforeEach(() => {
    redis = createMockRedis();
    store = new RedisSessionStore(redis, { sessionTtlMinutes: 30 });
  });

  it('stores small threads (< 1 KB) without gz: prefix', async () => {
    const smallThreads: any[] = [];
    expect(Buffer.byteLength(JSON.stringify(smallThreads))).toBeLessThan(COMPRESSION_THRESHOLD);

    const session = makeSession({ id: 'sess-small-th', threads: smallThreads });
    await store.create(session);

    const hash = getStoredHash(redis, 'tenant-1', 'sess-small-th');
    expect(hash).toBeDefined();
    const storedThreads = hash!['threads'];
    expect(storedThreads).not.toMatch(new RegExp(`^${COMPRESSED_PREFIX}`));
  });

  it('stores large threads (> 1 KB) with gz: prefix', async () => {
    const largeThreads = makeLargeThreads();
    expect(Buffer.byteLength(JSON.stringify(largeThreads))).toBeGreaterThan(COMPRESSION_THRESHOLD);

    const session = makeSession({ id: 'sess-large-th', threads: largeThreads });
    await store.create(session);

    const hash = getStoredHash(redis, 'tenant-1', 'sess-large-th');
    expect(hash).toBeDefined();
    const storedThreads = hash!['threads'];
    expect(storedThreads).toMatch(new RegExp(`^${COMPRESSED_PREFIX}`));
  });
});

// =============================================================================
// TESTS: round-trip without encryption
// =============================================================================

describe('RedisSessionStore compression — round-trip without encryption', () => {
  let redis: ReturnType<typeof createMockRedis>;
  let store: RedisSessionStore;

  beforeEach(() => {
    redis = createMockRedis();
    store = new RedisSessionStore(redis, { sessionTtlMinutes: 30 });
  });

  it('round-trips large dataValues: create → load → identical data', async () => {
    const largeDataValues = makeLargeObject('roundtrip');
    const original = makeSession({ id: 'sess-rt-dv', dataValues: largeDataValues });

    await store.create(original);

    // Verify it was compressed
    const hash = getStoredHash(redis, 'tenant-1', 'sess-rt-dv');
    expect(hash!['dataValues']).toMatch(new RegExp(`^${COMPRESSED_PREFIX}`));

    // Simulate the reverse lookup so load() can find the session
    redis._stored['sess-tid:sess-rt-dv'] = 'tenant-1';

    const loaded = await store.load('sess-rt-dv');
    expect(loaded).not.toBeNull();
    expect(loaded!.dataValues).toEqual(largeDataValues);
  });

  it('round-trips large threads: create → load → identical data', async () => {
    const largeThreads = makeLargeThreads();
    const original = makeSession({ id: 'sess-rt-th', threads: largeThreads });

    await store.create(original);

    // Verify compression happened
    const hash = getStoredHash(redis, 'tenant-1', 'sess-rt-th');
    expect(hash!['threads']).toMatch(new RegExp(`^${COMPRESSED_PREFIX}`));

    redis._stored['sess-tid:sess-rt-th'] = 'tenant-1';

    const loaded = await store.load('sess-rt-th');
    expect(loaded).not.toBeNull();
    expect(loaded!.threads).toEqual(largeThreads);
  });

  it('round-trips small dataValues (no compression) transparently', async () => {
    const smallDataValues = { step: 'greet', lang: 'en' };
    const original = makeSession({ id: 'sess-rt-small', dataValues: smallDataValues });

    await store.create(original);

    redis._stored['sess-tid:sess-rt-small'] = 'tenant-1';

    const loaded = await store.load('sess-rt-small');
    expect(loaded).not.toBeNull();
    expect(loaded!.dataValues).toEqual(smallDataValues);
  });
});

// =============================================================================
// TESTS: backward compatibility (no gz: prefix)
// =============================================================================

describe('RedisSessionStore compression — backward compatibility', () => {
  it('loads uncompressed dataValues stored without gz: prefix', async () => {
    const redis = createMockRedis();
    const store = new RedisSessionStore(redis, { sessionTtlMinutes: 30 });

    const legacyDataValues = { legacy: 'value', count: 42 };

    // Simulate a session stored by an older version (no gz: prefix, plain JSON)
    redis._stored['sess:tenant-1:sess-legacy'] = {
      id: 'sess-legacy',
      agentName: 'legacy-agent',
      irSourceHash: 'hash-old',
      compilationHash: '',
      version: '1',
      isComplete: 'false',
      isEscalated: 'false',
      initialized: 'true',
      createdAt: String(Date.now()),
      lastActivityAt: String(Date.now()),
      tenantId: 'tenant-1',
      // Plain JSON — no gz: prefix (pre-compression format)
      dataValues: JSON.stringify(legacyDataValues),
      threads: JSON.stringify([]),
      state: JSON.stringify({ gatherProgress: {}, conversationPhase: 'start', context: {} }),
      handoffStack: JSON.stringify([]),
      delegateStack: JSON.stringify([]),
      dataGatheredKeys: JSON.stringify([]),
      threadStack: JSON.stringify([]),
      activeThreadIndex: '0',
    };
    redis._stored['sess-tid:sess-legacy'] = 'tenant-1';

    const loaded = await store.load('sess-legacy');
    expect(loaded).not.toBeNull();
    expect(loaded!.dataValues).toEqual(legacyDataValues);
  });
});

// =============================================================================
// TESTS: mixed session (large dataValues + small threads)
// =============================================================================

describe('RedisSessionStore compression — mixed field sizes', () => {
  it('compresses large dataValues but not small threads in the same session', async () => {
    const redis = createMockRedis();
    const store = new RedisSessionStore(redis, { sessionTtlMinutes: 30 });

    const largeDataValues = makeLargeObject('mixed');
    const smallThreads: any[] = [{ threadId: 'th-1', agentName: 'bot' }];

    expect(Buffer.byteLength(JSON.stringify(largeDataValues))).toBeGreaterThan(
      COMPRESSION_THRESHOLD,
    );
    expect(Buffer.byteLength(JSON.stringify(smallThreads))).toBeLessThan(COMPRESSION_THRESHOLD);

    const session = makeSession({
      id: 'sess-mixed',
      dataValues: largeDataValues,
      threads: smallThreads,
    });

    await store.create(session);

    const hash = getStoredHash(redis, 'tenant-1', 'sess-mixed');
    expect(hash).toBeDefined();

    // dataValues should be compressed
    expect(hash!['dataValues']).toMatch(new RegExp(`^${COMPRESSED_PREFIX}`));
    // threads should NOT be compressed
    expect(hash!['threads']).not.toMatch(new RegExp(`^${COMPRESSED_PREFIX}`));

    // Verify round-trip fidelity for both fields
    redis._stored['sess-tid:sess-mixed'] = 'tenant-1';
    const loaded = await store.load('sess-mixed');
    expect(loaded).not.toBeNull();
    expect(loaded!.dataValues).toEqual(largeDataValues);
    expect(loaded!.threads).toEqual(smallThreads);
  });

  it('neither field compressed when both are small', async () => {
    const redis = createMockRedis();
    const store = new RedisSessionStore(redis, { sessionTtlMinutes: 30 });

    const smallDataValues = { a: '1', b: '2' };
    const smallThreads: any[] = [];

    const session = makeSession({
      id: 'sess-both-small',
      dataValues: smallDataValues,
      threads: smallThreads,
    });

    await store.create(session);

    const hash = getStoredHash(redis, 'tenant-1', 'sess-both-small');
    expect(hash).toBeDefined();
    expect(hash!['dataValues']).not.toMatch(new RegExp(`^${COMPRESSED_PREFIX}`));
    expect(hash!['threads']).not.toMatch(new RegExp(`^${COMPRESSED_PREFIX}`));
  });
});

// =============================================================================
// TESTS: compression with encryption (prefix layering)
// =============================================================================

describe('RedisSessionStore compression — with encryption (gz:enc: layering)', () => {
  function createMockEncryptionService() {
    return {
      encryptForTenant: vi.fn(async (plaintext: string, _tenantId: string) => {
        // Simulate encryption by base64-encoding the input
        return Buffer.from(plaintext).toString('base64');
      }),
      decryptForTenant: vi.fn(async (ciphertext: string, _tenantId: string) => {
        return Buffer.from(ciphertext, 'base64').toString('utf-8');
      }),
    };
  }

  it('stores large dataValues with gz:enc: layering when encryption is enabled', async () => {
    const redis = createMockRedis();
    const encService = createMockEncryptionService();
    const store = new RedisSessionStore(redis, {
      sessionTtlMinutes: 30,
      encryptionService: encService as any,
    });

    const largeDataValues = makeLargeObject('encrypted');
    const session = makeSession({ id: 'sess-enc-large', dataValues: largeDataValues });

    await store.create(session);

    const hash = getStoredHash(redis, 'tenant-1', 'sess-enc-large');
    expect(hash).toBeDefined();
    const storedDataValues = hash!['dataValues'];

    // Must start with gz: (compression outermost)
    expect(storedDataValues).toMatch(new RegExp(`^${COMPRESSED_PREFIX}`));
    // After gz: prefix, must start with enc: (encryption inner)
    const afterGz = storedDataValues.slice(COMPRESSED_PREFIX.length);
    expect(afterGz).toMatch(new RegExp(`^${ENCRYPTED_PREFIX}`));
  });

  it('round-trips large dataValues with encryption enabled', async () => {
    const redis = createMockRedis();
    const encService = createMockEncryptionService();
    const store = new RedisSessionStore(redis, {
      sessionTtlMinutes: 30,
      encryptionService: encService as any,
    });

    const largeDataValues = makeLargeObject('enc-rt');
    const original = makeSession({ id: 'sess-enc-rt', dataValues: largeDataValues });

    await store.create(original);
    redis._stored['sess-tid:sess-enc-rt'] = 'tenant-1';

    const loaded = await store.load('sess-enc-rt');
    expect(loaded).not.toBeNull();
    expect(loaded!.dataValues).toEqual(largeDataValues);
  });

  it('does not apply gz: prefix to small dataValues even when encryption is enabled', async () => {
    const redis = createMockRedis();
    const encService = createMockEncryptionService();
    const store = new RedisSessionStore(redis, {
      sessionTtlMinutes: 30,
      encryptionService: encService as any,
    });

    const smallDataValues = { x: 'tiny' };
    const session = makeSession({ id: 'sess-enc-small', dataValues: smallDataValues });

    await store.create(session);

    const hash = getStoredHash(redis, 'tenant-1', 'sess-enc-small');
    expect(hash).toBeDefined();
    const storedDataValues = hash!['dataValues'];

    // Should NOT be compressed
    expect(storedDataValues).not.toMatch(new RegExp(`^${COMPRESSED_PREFIX}`));
    // But should be encrypted
    expect(storedDataValues).toMatch(new RegExp(`^${ENCRYPTED_PREFIX}`));
  });
});

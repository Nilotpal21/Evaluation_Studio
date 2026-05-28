/**
 * Redis Session Store — Conversation Operations Tests
 *
 * Tests for conversation-related methods in RedisSessionStore:
 * - getConversationHistory (windowing logic)
 * - trimConversation (dynamic TTL via computeEffectiveTtl)
 * - appendMessages (expired-session guard)
 * - computeEffectiveTtl (indirectly, via public methods)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisSessionStore } from '../services/session/redis-session-store.js';

// =============================================================================
// MOCK REDIS CLIENT
// =============================================================================

function createMockRedis() {
  const data: Record<string, any> = {};
  const listData: Record<string, string[]> = {};
  const evalCalls: any[][] = [];
  const pipelineCmds: any[][] = [];

  const pipeline = {
    rpush: vi.fn((...args: any[]) => {
      pipelineCmds.push(['rpush', ...args]);
      return pipeline;
    }),
    expire: vi.fn((...args: any[]) => {
      pipelineCmds.push(['expire', ...args]);
      return pipeline;
    }),
    hmset: vi.fn((...args: any[]) => {
      pipelineCmds.push(['hmset', ...args]);
      return pipeline;
    }),
    hgetall: vi.fn((...args: any[]) => {
      pipelineCmds.push(['hgetall', ...args]);
      return pipeline;
    }),
    lrange: vi.fn((...args: any[]) => {
      pipelineCmds.push(['lrange', ...args]);
      return pipeline;
    }),
    set: vi.fn((...args: any[]) => {
      pipelineCmds.push(['set', ...args]);
      return pipeline;
    }),
    exec: vi.fn().mockResolvedValue(pipelineCmds.map(() => [null, 'OK'])),
  };

  // Direct (non-pipeline) command capture. After the cluster-safe refactor,
  // create()/load()/touch() issue individual ioredis calls instead of building
  // a pipeline — these mocks need their own implementations now.
  const directCmds: Array<[string, ...any[]]> = [];

  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn(async (...args: any[]) => {
      directCmds.push(['set', ...args]);
      return 'OK';
    }),
    del: vi.fn().mockResolvedValue(1),
    hmset: vi.fn(async (...args: any[]) => {
      directCmds.push(['hmset', ...args]);
      return 'OK';
    }),
    hmget: vi.fn().mockResolvedValue([null, null]),
    hget: vi.fn().mockResolvedValue(null),
    hgetall: vi.fn().mockResolvedValue({}),
    lrange: vi.fn().mockResolvedValue([]),
    rpush: vi.fn(async (...args: any[]) => {
      directCmds.push(['rpush', ...args]);
      return args.length - 1;
    }),
    expire: vi.fn(async (...args: any[]) => {
      directCmds.push(['expire', ...args]);
      return 1;
    }),
    eval: vi.fn().mockResolvedValue(0),
    getBuffer: vi.fn().mockResolvedValue(null),
    pipeline: vi.fn(() => pipeline),
    _pipeline: pipeline,
    _pipelineCmds: pipelineCmds,
    _directCmds: directCmds,
    _evalCalls: evalCalls,
  };
}

// =============================================================================
// HELPERS
// =============================================================================

function makeMessage(role: string, content: string) {
  return { role, content };
}

function makeSession(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'sess-1',
    agentName: 'test-agent',
    irSourceHash: 'hash-123',
    compilationHash: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
    version: 0,
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    delegateStack: [],
    dataValues: {},
    dataGatheredKeys: [],
    initialized: true,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    ...overrides,
  };
}

function nowMs(): number {
  return Date.now();
}

// =============================================================================
// getConversationHistory windowing
// =============================================================================

describe('RedisSessionStore.getConversationHistory windowing', () => {
  let redis: ReturnType<typeof createMockRedis>;
  let store: RedisSessionStore;

  beforeEach(() => {
    redis = createMockRedis();
    store = new RedisSessionStore(redis, { sessionTtlMinutes: 30 });
    redis.get.mockResolvedValue('test-tenant');
  });

  it('should return first message only when limit=1', async () => {
    const messages = [
      makeMessage('system', 'You are a helpful agent'),
      makeMessage('user', 'Hello'),
      makeMessage('assistant', 'Hi there'),
      makeMessage('user', 'How are you?'),
      makeMessage('assistant', 'I am fine'),
    ];
    redis.lrange.mockResolvedValue(messages.map((m) => JSON.stringify(m)));

    const result = await store.getConversationHistory('sess-1', 1);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(messages[0]);
  });

  it('should return first + last when limit=2', async () => {
    const messages = [
      makeMessage('system', 'You are a helpful agent'),
      makeMessage('user', 'Hello'),
      makeMessage('assistant', 'Hi there'),
      makeMessage('user', 'How are you?'),
      makeMessage('assistant', 'I am fine'),
    ];
    redis.lrange.mockResolvedValue(messages.map((m) => JSON.stringify(m)));

    const result = await store.getConversationHistory('sess-1', 2);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(messages[0]);
    expect(result[1]).toEqual(messages[4]);
  });

  it('should return all messages when count < limit', async () => {
    const messages = [
      makeMessage('system', 'System prompt'),
      makeMessage('user', 'Question'),
      makeMessage('assistant', 'Answer'),
    ];
    redis.lrange.mockResolvedValue(messages.map((m) => JSON.stringify(m)));

    const result = await store.getConversationHistory('sess-1', 10);

    expect(result).toHaveLength(3);
    expect(result).toEqual(messages);
  });

  it('should return all messages when no limit specified', async () => {
    const messages = [
      makeMessage('system', 'System prompt'),
      makeMessage('user', 'Q1'),
      makeMessage('assistant', 'A1'),
      makeMessage('user', 'Q2'),
      makeMessage('assistant', 'A2'),
    ];
    redis.lrange.mockResolvedValue(messages.map((m) => JSON.stringify(m)));

    const result = await store.getConversationHistory('sess-1');

    expect(result).toHaveLength(5);
    expect(result).toEqual(messages);
  });
});

// =============================================================================
// trimConversation dynamic TTL
// =============================================================================

describe('RedisSessionStore.trimConversation dynamic TTL', () => {
  let redis: ReturnType<typeof createMockRedis>;
  let store: RedisSessionStore;
  const SESSION_TTL_MINUTES = 30;
  const SESSION_TTL_SECONDS = SESSION_TTL_MINUTES * 60; // 1800

  beforeEach(() => {
    redis = createMockRedis();
    store = new RedisSessionStore(redis, { sessionTtlMinutes: SESSION_TTL_MINUTES });
    redis.get.mockResolvedValue('test-tenant');
  });

  it('should use computeEffectiveTtl instead of fixed sessionTtlSeconds', async () => {
    const createdAt = nowMs(); // just created
    const maxAgeSeconds = 600; // 10 minutes

    // Legacy empty-tenant sessions still resolve through an explicit '' lookup value
    // hmget returns createdAt and maxAgeSeconds for the session
    redis.hmget.mockResolvedValue([String(createdAt), String(maxAgeSeconds)]);

    await store.trimConversation('sess-1', 50);

    // redis.eval should have been called with the effective TTL (capped to maxAgeSeconds)
    expect(redis.eval).toHaveBeenCalledTimes(1);
    const evalArgs = redis.eval.mock.calls[0];
    // evalArgs: [luaScript, 1, convKey, effectiveTtl, maxMessages]
    const passedTtl = evalArgs[3];

    // Since session was just created, remaining lifetime ~ maxAgeSeconds (600)
    // It should be <= 600 and NOT the default 1800
    // runLuaScript converts all args to strings via args.map(String)
    expect(Number(passedTtl)).toBeLessThanOrEqual(maxAgeSeconds);
    expect(Number(passedTtl)).toBeGreaterThan(0);
    // Specifically, it should NOT be the default sessionTtlSeconds
    expect(Number(passedTtl)).not.toBe(SESSION_TTL_SECONDS);
  });

  it('should skip trim when session exceeds max age', async () => {
    // Session created 2 hours ago, maxAge = 1 hour
    const twoHoursAgoMs = nowMs() - 2 * 60 * 60 * 1000;
    const maxAgeSeconds = 3600; // 1 hour

    redis.hmget.mockResolvedValue([String(twoHoursAgoMs), String(maxAgeSeconds)]);

    await store.trimConversation('sess-1', 50);

    // redis.eval should NOT be called because effectiveTtl <= 0
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('should use sessionTtlSeconds when no maxAgeSeconds', async () => {
    const createdAt = nowMs();

    // hmget returns createdAt but null for maxAgeSeconds
    redis.hmget.mockResolvedValue([String(createdAt), null]);

    await store.trimConversation('sess-1', 50);

    expect(redis.eval).toHaveBeenCalledTimes(1);
    const evalArgs = redis.eval.mock.calls[0];
    const passedTtl = evalArgs[3];

    // Without maxAgeSeconds, computeEffectiveTtl returns sessionTtlSeconds (1800)
    expect(Number(passedTtl)).toBe(SESSION_TTL_SECONDS);
  });
});

// =============================================================================
// appendMessages with expired session
// =============================================================================

describe('RedisSessionStore.appendMessages with expired session', () => {
  let redis: ReturnType<typeof createMockRedis>;
  let store: RedisSessionStore;

  beforeEach(() => {
    redis = createMockRedis();
    store = new RedisSessionStore(redis, { sessionTtlMinutes: 30 });
    redis.get.mockResolvedValue('test-tenant');
  });

  it('should not append when session exceeds max age', async () => {
    // Session created 2 hours ago, maxAge = 1 hour -> expired
    const twoHoursAgoMs = nowMs() - 2 * 60 * 60 * 1000;
    const maxAgeSeconds = 3600;

    redis.hmget.mockResolvedValue([String(twoHoursAgoMs), String(maxAgeSeconds)]);

    const messages = [makeMessage('user', 'Hello')];
    await store.appendMessages('sess-1', messages);

    // pipeline.exec should NOT have been called (early return due to expired session)
    expect(redis._pipeline.exec).not.toHaveBeenCalled();
  });

  it('should append normally when session has remaining TTL', async () => {
    // Session created 5 minutes ago, maxAge = 1 hour -> plenty of time remaining
    const fiveMinutesAgoMs = nowMs() - 5 * 60 * 1000;
    const maxAgeSeconds = 3600;

    redis.hmget.mockResolvedValue([String(fiveMinutesAgoMs), String(maxAgeSeconds)]);

    const messages = [makeMessage('user', 'Hello'), makeMessage('assistant', 'Hi')];
    await store.appendMessages('sess-1', messages);

    // pipeline.exec SHOULD have been called
    expect(redis._pipeline.exec).toHaveBeenCalledTimes(1);

    // Verify rpush was called for each message
    expect(redis._pipeline.rpush).toHaveBeenCalledTimes(2);

    // Verify expire was called with the effective TTL (capped by remaining lifetime)
    expect(redis._pipeline.expire).toHaveBeenCalledTimes(1);
    const expireArgs = redis._pipeline.expire.mock.calls[0];
    const passedTtl = expireArgs[1];
    // remaining = 3600 - 300 = 3300s, which is > 0 and < sessionTtlSeconds (1800)
    // min(1800, 3300) = 1800
    expect(passedTtl).toBe(1800);
  });
});

// =============================================================================
// computeEffectiveTtl (tested indirectly via public methods)
// =============================================================================

describe('RedisSessionStore.computeEffectiveTtl', () => {
  let redis: ReturnType<typeof createMockRedis>;
  let store: RedisSessionStore;
  const SESSION_TTL_SECONDS = 1800; // 30 minutes

  beforeEach(() => {
    redis = createMockRedis();
    store = new RedisSessionStore(redis, { sessionTtlMinutes: 30 });
    redis.get.mockResolvedValue('test-tenant');
  });

  it('should return sessionTtlSeconds when no maxAgeSeconds', async () => {
    const createdAt = nowMs();
    redis.hmget.mockResolvedValue([String(createdAt), null]);

    await store.trimConversation('sess-1', 50);

    expect(redis.eval).toHaveBeenCalledTimes(1);
    const passedTtl = redis.eval.mock.calls[0][3];
    expect(Number(passedTtl)).toBe(SESSION_TTL_SECONDS);
  });

  it('should cap to remaining lifetime', async () => {
    // createdAt 10 minutes ago, maxAgeSeconds = 900 (15 min)
    // remaining = 900 - 600 = 300 seconds (5 min)
    const tenMinutesAgoMs = nowMs() - 10 * 60 * 1000;
    const maxAgeSeconds = 900;

    redis.hmget.mockResolvedValue([String(tenMinutesAgoMs), String(maxAgeSeconds)]);

    await store.trimConversation('sess-1', 50);

    expect(redis.eval).toHaveBeenCalledTimes(1);
    const passedTtl = redis.eval.mock.calls[0][3];

    // Remaining lifetime is ~300s, sessionTtlSeconds is 1800s
    // computeEffectiveTtl returns min(1800, ceil(300)) = ~300
    // Allow a small tolerance for timing (test execution takes a few ms)
    expect(Number(passedTtl)).toBeGreaterThan(0);
    expect(Number(passedTtl)).toBeLessThanOrEqual(300);
    expect(Number(passedTtl)).toBeGreaterThanOrEqual(295);
  });

  it('should return 0 when session expired', async () => {
    // createdAt 2 hours ago, maxAgeSeconds = 3600 (1 hour)
    // remaining = 3600 - 7200 = -3600 -> clamped to 0
    const twoHoursAgoMs = nowMs() - 2 * 60 * 60 * 1000;
    const maxAgeSeconds = 3600;

    redis.hmget.mockResolvedValue([String(twoHoursAgoMs), String(maxAgeSeconds)]);

    await store.trimConversation('sess-1', 50);

    // With effectiveTtl <= 0, trimConversation returns early without calling eval
    expect(redis.eval).not.toHaveBeenCalled();
  });
});

// =============================================================================
// idleSeconds support in computeEffectiveTtl
// =============================================================================

describe('RedisSessionStore.computeEffectiveTtl with idleSeconds', () => {
  let redis: ReturnType<typeof createMockRedis>;
  let store: RedisSessionStore;
  const SESSION_TTL_SECONDS = 1800; // 30 minutes

  beforeEach(() => {
    redis = createMockRedis();
    store = new RedisSessionStore(redis, { sessionTtlMinutes: 30 });
    redis.get.mockResolvedValue('test-tenant');
  });

  it('idleSeconds < remainingMaxAge returns idleSeconds', async () => {
    const createdAt = nowMs(); // just created
    const maxAgeSeconds = 3600; // 1 hour remaining
    const idleSeconds = 600; // 10 minutes

    // hmget now returns 3 values: createdAt, maxAgeSeconds, idleSeconds
    redis.hmget.mockResolvedValue([String(createdAt), String(maxAgeSeconds), String(idleSeconds)]);

    await store.trimConversation('sess-1', 50);

    expect(redis.eval).toHaveBeenCalledTimes(1);
    const passedTtl = redis.eval.mock.calls[0][3];
    // min(sessionTtl=1800, remaining=~3600, idle=600) = 600
    expect(Number(passedTtl)).toBe(idleSeconds);
  });

  it('idleSeconds > remainingMaxAge returns remainingMaxAge', async () => {
    // Created 14 minutes ago, maxAge=15min (remaining ~60s), idle=600s
    const fourteenMinAgoMs = nowMs() - 14 * 60 * 1000;
    const maxAgeSeconds = 900; // 15 minutes
    const idleSeconds = 600; // 10 minutes

    redis.hmget.mockResolvedValue([
      String(fourteenMinAgoMs),
      String(maxAgeSeconds),
      String(idleSeconds),
    ]);

    await store.trimConversation('sess-1', 50);

    expect(redis.eval).toHaveBeenCalledTimes(1);
    const passedTtl = redis.eval.mock.calls[0][3];
    // remaining = 900 - 840 = ~60s, idle=600. min(1800, ~60, 600) = ~60
    expect(Number(passedTtl)).toBeGreaterThan(0);
    expect(Number(passedTtl)).toBeLessThanOrEqual(65);
  });

  it('idleSeconds=undefined falls back to existing behavior', async () => {
    const createdAt = nowMs();
    // hmget returns createdAt, null maxAge, null idleSeconds
    redis.hmget.mockResolvedValue([String(createdAt), null, null]);

    await store.trimConversation('sess-1', 50);

    expect(redis.eval).toHaveBeenCalledTimes(1);
    const passedTtl = redis.eval.mock.calls[0][3];
    expect(Number(passedTtl)).toBe(SESSION_TTL_SECONDS);
  });

  it('idleSeconds=0 is treated as disabled (falls back to sessionTtl)', async () => {
    const createdAt = nowMs();
    // idleSeconds=0 should be ignored (not cap TTL to 0)
    redis.hmget.mockResolvedValue([String(createdAt), null, '0']);

    await store.trimConversation('sess-1', 50);

    expect(redis.eval).toHaveBeenCalledTimes(1);
    const passedTtl = redis.eval.mock.calls[0][3];
    // Should use sessionTtlSeconds, not 0
    expect(Number(passedTtl)).toBe(SESSION_TTL_SECONDS);
  });

  it('maxAgeSeconds=0 is treated as disabled (falls back to sessionTtl)', async () => {
    const createdAt = nowMs();
    redis.hmget.mockResolvedValue([String(createdAt), '0', null]);

    await store.trimConversation('sess-1', 50);

    expect(redis.eval).toHaveBeenCalledTimes(1);
    const passedTtl = redis.eval.mock.calls[0][3];
    // maxAgeSeconds=0 should not trigger the maxAge path
    expect(Number(passedTtl)).toBe(SESSION_TTL_SECONDS);
  });

  it('touch refreshes TTL to min(idleSeconds, remaining)', async () => {
    const createdAt = nowMs(); // just created
    const maxAgeSeconds = 7200; // 2 hours
    const idleSeconds = 300; // 5 minutes

    redis.hmget.mockResolvedValue([String(createdAt), String(maxAgeSeconds), String(idleSeconds)]);

    await store.touch('sess-1');

    // touch() now issues individual EXPIRE commands instead of a pipeline,
    // because the four keys (sess, conv, registry, lookup) live on different
    // cluster slots — ioredis Cluster pipelines require same-slot keys.
    const expireCalls = redis.expire.mock.calls;
    expect(expireCalls.length).toBe(4); // session, conv, registry, lookup
    for (const [, ttl] of expireCalls) {
      expect(ttl).toBe(idleSeconds);
    }
  });
});

// =============================================================================
// Per-entry encryption on conv LIST
// =============================================================================

describe('RedisSessionStore conv LIST per-entry encryption', () => {
  const TENANT_ID = 'tenant-enc';

  function createMockEncryptionService() {
    return {
      encryptForTenant: vi.fn(async (plaintext: string, _tenantId: string) => {
        // Simple mock: base64 encode to simulate ciphertext
        return Buffer.from(plaintext).toString('base64');
      }),
      decryptForTenant: vi.fn(async (ciphertext: string, _tenantId: string) => {
        return Buffer.from(ciphertext, 'base64').toString('utf-8');
      }),
    };
  }

  it('should prefix stored conv entries with enc: when encryption is available', async () => {
    const redis = createMockRedis();
    const encService = createMockEncryptionService();
    const store = new RedisSessionStore(redis, {
      sessionTtlMinutes: 30,
      encryptionService: encService as any,
    });

    const fiveMinAgo = nowMs() - 5 * 60 * 1000;
    // resolveTenantId: return tenant from lookup key
    redis.get.mockResolvedValue(TENANT_ID);
    // hmget for createdAt, maxAgeSeconds, idleSeconds
    redis.hmget.mockResolvedValue([String(fiveMinAgo), null, null]);

    const messages = [makeMessage('user', 'Hello'), makeMessage('assistant', 'Hi there')];
    await store.appendMessages('sess-enc-1', messages);

    // Pipeline exec should have been called
    expect(redis._pipeline.exec).toHaveBeenCalledTimes(1);
    // rpush should have been called twice (once per message)
    expect(redis._pipeline.rpush).toHaveBeenCalledTimes(2);

    // Verify each rpush call has the enc: prefix
    for (let i = 0; i < 2; i++) {
      const rpushArgs = redis._pipeline.rpush.mock.calls[i];
      const storedValue = rpushArgs[1]; // rpush(key, value)
      expect(storedValue).toMatch(/^enc:/);
      // The ciphertext after enc: should be base64 (our mock)
      const ciphertext = storedValue.slice(4);
      const decrypted = Buffer.from(ciphertext, 'base64').toString('utf-8');
      expect(JSON.parse(decrypted)).toEqual(messages[i]);
    }

    // encryptForTenant should have been called for each message
    expect(encService.encryptForTenant).toHaveBeenCalledTimes(2);
  });

  it('fails closed when create cannot encrypt conversation history', async () => {
    const redis = createMockRedis();
    const encService = {
      encryptForTenant: vi.fn().mockRejectedValue(new Error('encryption unavailable')),
      decryptForTenant: vi.fn(),
    };
    const store = new RedisSessionStore(redis, {
      sessionTtlMinutes: 30,
      encryptionService: encService as any,
    });

    const session = makeSession({
      id: 'sess-create-fail',
      tenantId: TENANT_ID,
      conversationHistory: [makeMessage('user', 'my ssn is 123-45-6789')],
    });

    await expect(store.create(session)).rejects.toThrow('encryption unavailable');
    expect(redis._pipeline.rpush).not.toHaveBeenCalled();
    expect(redis._pipeline.exec).not.toHaveBeenCalled();
  });

  it('fails closed before encrypted conversation history is written without a tenantId', async () => {
    const redis = createMockRedis();
    const encService = createMockEncryptionService();
    const store = new RedisSessionStore(redis, {
      sessionTtlMinutes: 30,
      encryptionService: encService as any,
    });

    const session = makeSession({
      id: 'sess-create-missing-tenant',
      tenantId: '',
      conversationHistory: [makeMessage('user', 'my ssn is 123-45-6789')],
    });

    await expect(store.create(session)).rejects.toThrow('create() requires tenantId');
    expect(encService.encryptForTenant).not.toHaveBeenCalled();
    expect(redis._pipeline.rpush).not.toHaveBeenCalled();
    expect(redis._pipeline.exec).not.toHaveBeenCalled();
  });

  it('should read mixed enc:/plaintext conv entries correctly', async () => {
    const redis = createMockRedis();
    const encService = createMockEncryptionService();
    const store = new RedisSessionStore(redis, {
      sessionTtlMinutes: 30,
      encryptionService: encService as any,
    });

    // resolveTenantId returns tenant
    redis.get.mockResolvedValue(TENANT_ID);

    const msg1 = makeMessage('user', 'Old plaintext message');
    const msg2 = makeMessage('assistant', 'Encrypted reply');
    const msg3 = makeMessage('user', 'Another encrypted message');

    // Simulate mixed storage: msg1 is plaintext (legacy), msg2 and msg3 are encrypted
    const encMsg2 = 'enc:' + Buffer.from(JSON.stringify(msg2)).toString('base64');
    const encMsg3 = 'enc:' + Buffer.from(JSON.stringify(msg3)).toString('base64');

    redis.lrange.mockResolvedValue([
      JSON.stringify(msg1), // plaintext (no enc: prefix)
      encMsg2, // encrypted
      encMsg3, // encrypted
    ]);

    const history = await store.getConversationHistory('sess-mixed-1');

    expect(history).toHaveLength(3);
    expect(history[0]).toEqual(msg1);
    expect(history[1]).toEqual(msg2);
    expect(history[2]).toEqual(msg3);

    // decryptForTenant should only be called for the 2 encrypted entries
    expect(encService.decryptForTenant).toHaveBeenCalledTimes(2);
  });
});

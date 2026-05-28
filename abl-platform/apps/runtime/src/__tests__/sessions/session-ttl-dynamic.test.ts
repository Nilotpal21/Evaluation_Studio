/**
 * Dynamic Session TTL Tests
 *
 * Verifies that RedisSessionStore uses per-tenant maxAgeSeconds to compute
 * effective TTL for session keys. Covers:
 * - create(): uses min(defaultTtl, maxAgeSeconds) for initial TTL
 * - save(): computes dynamic TTL from remaining lifetime
 * - save(): returns false when session exceeds max age
 * - touch(): uses default TTL when no maxAgeSeconds is set
 * - touch(): caps TTL to remaining lifetime when maxAgeSeconds is set
 * - touch(): does not extend expired sessions (maxAge exceeded)
 * - hashToSession round-trip preserves maxAgeSeconds
 *
 * Note: mockRedis.eval calls in this test file are testing Redis server-side
 * Lua script execution (LUA_SAVE), not JavaScript eval().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionData, ConversationMessage } from '../../services/session/types.js';
import { TRANSFER_SESSION_MIN_TTL_SECONDS } from '../../services/session/redis-session-store.js';

// =============================================================================
// TEST HELPERS
// =============================================================================

/** Default session TTL in minutes (matches RedisSessionStore default) */
const DEFAULT_TTL_MINUTES = 30;
const DEFAULT_TTL_SECONDS = DEFAULT_TTL_MINUTES * 60; // 1800

function createBaseSessionData(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: 'sess-ttl-test',
    agentName: 'test-agent',
    irSourceHash: 'hash-abc',
    compilationHash: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
    version: 1,
    isComplete: false,
    isEscalated: false,
    handoffStack: ['test-agent'],
    dataValues: {},
    dataGatheredKeys: [],
    initialized: false,
    tenantId: 'tenant-1',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    ...overrides,
  };
}

// =============================================================================
// REDIS MOCK FACTORY
// =============================================================================

function createMockRedis() {
  const pipeline: Record<string, ReturnType<typeof vi.fn>> = {
    hmset: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    rpush: vi.fn().mockReturnThis(),
    hgetall: vi.fn().mockReturnThis(),
    lrange: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };

  const redis: Record<string, ReturnType<typeof vi.fn>> = {
    pipeline: vi.fn(() => pipeline),
    get: vi.fn().mockResolvedValue('tenant-1'),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    // Note: this mocks Redis server-side Lua script execution, not JS eval()
    eval: vi.fn().mockResolvedValue(1),
    hmset: vi.fn().mockResolvedValue('OK'),
    expire: vi.fn().mockResolvedValue(1),
    hget: vi.fn().mockResolvedValue(null),
    hgetall: vi.fn().mockResolvedValue({}),
    hmget: vi.fn().mockResolvedValue([null, null]),
    getBuffer: vi.fn().mockResolvedValue(null),
    lrange: vi.fn().mockResolvedValue([]),
  };

  return { redis, pipeline };
}

// =============================================================================
// TESTS
// =============================================================================

describe('RedisSessionStore — Dynamic TTL', () => {
  let mockRedis: ReturnType<typeof createMockRedis>['redis'];
  let mockPipeline: ReturnType<typeof createMockRedis>['pipeline'];
  let RedisSessionStore: any;

  beforeEach(async () => {
    const mocks = createMockRedis();
    mockRedis = mocks.redis;
    mockPipeline = mocks.pipeline;

    const mod = await import('../../services/session/redis-session-store.js');
    RedisSessionStore = mod.RedisSessionStore;
  });

  // ===========================================================================
  // create() — Initial TTL
  // ===========================================================================

  describe('create() — initial TTL', () => {
    it('uses default TTL when no maxAgeSeconds is set', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES,
      });

      const session = createBaseSessionData();
      await store.create(session);

      // EXPIRE on session hash key uses default TTL
      expect(mockPipeline.expire).toHaveBeenCalledWith(
        expect.stringContaining('sess:tenant-1:sess-ttl-test'),
        DEFAULT_TTL_SECONDS,
      );
    });

    it('uses min(defaultTtl, maxAgeSeconds) when maxAgeSeconds < defaultTtl', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES,
      });

      const maxAge = 600; // 10 minutes — less than 30-minute default
      const session = createBaseSessionData({ maxAgeSeconds: maxAge });
      await store.create(session);

      // All EXPIRE calls should use the capped TTL (600)
      const expireCalls = mockPipeline.expire.mock.calls;
      for (const call of expireCalls) {
        expect(call[1]).toBe(maxAge);
      }
    });

    it('uses defaultTtl when maxAgeSeconds > defaultTtl', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES,
      });

      const maxAge = 86_400; // 24 hours — more than 30-minute default
      const session = createBaseSessionData({ maxAgeSeconds: maxAge });
      await store.create(session);

      const expireCalls = mockPipeline.expire.mock.calls;
      for (const call of expireCalls) {
        expect(call[1]).toBe(DEFAULT_TTL_SECONDS);
      }
    });

    it('uses min(defaultTtl, maxAgeSeconds) for reverse lookup key', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES,
      });

      const maxAge = 900; // 15 minutes
      const session = createBaseSessionData({ maxAgeSeconds: maxAge });
      await store.create(session);

      // The SET call for reverse lookup should use maxAge as the EX value
      const setCalls = mockPipeline.set.mock.calls;
      // Find the reverse lookup call (starts with 'sess-tid:')
      const lookupCall = setCalls.find(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].startsWith('sess-tid:'),
      );
      expect(lookupCall).toBeDefined();
      expect(lookupCall![3]).toBe(maxAge); // EX value
    });
  });

  // ===========================================================================
  // save() — Dynamic TTL from remaining lifetime
  // ===========================================================================

  describe('save() — dynamic TTL', () => {
    it('uses default TTL when no maxAgeSeconds is set', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES,
      });

      const session = createBaseSessionData({ version: 2 });

      const success = await store.save(session);

      expect(success).toBe(true);
      // redis.eval(LUA_SAVE, 1, key, ...argv) — argv = [expectedVersion, ttl, ...fields]
      // So: eval(script, 1, key, expectedVersion, ttl, ...)
      const evalCall = mockRedis.eval.mock.calls[0];
      expect(evalCall[3]).toBe(1); // expectedVersion = version - 1 = 2 - 1
      expect(evalCall[4]).toBe(DEFAULT_TTL_SECONDS); // TTL
    });

    it('computes remaining lifetime TTL when maxAgeSeconds is set', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES,
      });

      // Session created 5 minutes ago with 10-minute max age -> 5 minutes remaining
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
      const maxAge = 600; // 10 minutes
      const session = createBaseSessionData({
        version: 2,
        createdAt: fiveMinutesAgo,
        maxAgeSeconds: maxAge,
      });

      const success = await store.save(session);

      expect(success).toBe(true);
      const evalCall = mockRedis.eval.mock.calls[0];
      const ttlUsed = evalCall[4] as number;
      // Remaining: ~300 seconds (5 minutes). Allow 2-second tolerance for test execution time
      expect(ttlUsed).toBeGreaterThanOrEqual(298);
      expect(ttlUsed).toBeLessThanOrEqual(302);
    });

    it('returns false when session has exceeded max age', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES,
      });

      // Session created 2 hours ago with 1-hour max age -> expired
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      const session = createBaseSessionData({
        version: 2,
        createdAt: twoHoursAgo,
        maxAgeSeconds: 3600, // 1 hour
      });

      const success = await store.save(session);

      // Should not call redis Lua script — session is expired
      expect(success).toBe(false);
      expect(mockRedis.eval).not.toHaveBeenCalled();
    });

    it('caps TTL to defaultTtl when remaining lifetime exceeds it', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES,
      });

      // Session created 1 minute ago with 24-hour max age -> remaining ~86340 > 1800 default
      const oneMinuteAgo = Date.now() - 60 * 1000;
      const session = createBaseSessionData({
        version: 2,
        createdAt: oneMinuteAgo,
        maxAgeSeconds: 86_400,
      });

      await store.save(session);

      const evalCall = mockRedis.eval.mock.calls[0];
      const ttlUsed = evalCall[4] as number;
      expect(ttlUsed).toBe(DEFAULT_TTL_SECONDS);
    });
  });

  // ===========================================================================
  // touch() — TTL refresh
  // ===========================================================================

  describe('touch() — TTL refresh', () => {
    it('uses default TTL when no maxAgeSeconds stored on session', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES,
      });

      // hmget returns [createdAt, maxAgeSeconds] — both null for legacy sessions
      mockRedis.hmget.mockResolvedValue([null, null]);

      await store.touch('sess-ttl-test');

      const expireCalls = mockPipeline.expire.mock.calls;
      expect(expireCalls.length).toBeGreaterThanOrEqual(4); // sess, conv, registry, lookup

      for (const call of expireCalls) {
        expect(call[1]).toBe(DEFAULT_TTL_SECONDS);
      }
    });

    it('caps TTL to remaining lifetime when maxAgeSeconds is set', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES,
      });

      // Session created 5 minutes ago with 10-minute max age -> 5 minutes remaining
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
      mockRedis.hmget.mockResolvedValue([String(fiveMinutesAgo), '600']);

      await store.touch('sess-ttl-test');

      const expireCalls = mockPipeline.expire.mock.calls;
      expect(expireCalls.length).toBeGreaterThanOrEqual(4);

      for (const call of expireCalls) {
        const ttl = call[1] as number;
        // Remaining: ~300s. Allow 2-second tolerance for test execution time
        expect(ttl).toBeGreaterThanOrEqual(298);
        expect(ttl).toBeLessThanOrEqual(302);
      }
    });

    it('does not extend TTL when session exceeds max age', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES,
      });

      // Session created 2 hours ago with 1-hour max age -> expired
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      mockRedis.hmget.mockResolvedValue([String(twoHoursAgo), '3600']);

      await store.touch('sess-ttl-test');

      // Pipeline should NOT be created — touch returns early
      expect(mockPipeline.expire).not.toHaveBeenCalled();
    });

    it('uses defaultTtl when remaining lifetime exceeds defaultTtl', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES,
      });

      // Session created 1 minute ago with 24-hour max age
      const oneMinuteAgo = Date.now() - 60 * 1000;
      mockRedis.hmget.mockResolvedValue([String(oneMinuteAgo), '86400']);

      await store.touch('sess-ttl-test');

      const expireCalls = mockPipeline.expire.mock.calls;
      for (const call of expireCalls) {
        expect(call[1]).toBe(DEFAULT_TTL_SECONDS);
      }
    });
  });

  // ===========================================================================
  // hashToSession — maxAgeSeconds round-trip
  // ===========================================================================

  describe('hashToSession round-trip', () => {
    it('preserves maxAgeSeconds through create and load cycle', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES,
      });

      const session = createBaseSessionData({ maxAgeSeconds: 7200 });
      await store.create(session);

      // Capture what was stored in hmset
      const hmsetCall = mockPipeline.hmset.mock.calls[0];
      const storedHash = hmsetCall[1] as Record<string, string>;

      // Verify maxAgeSeconds was stored
      expect(storedHash.maxAgeSeconds).toBe('7200');

      // Now simulate loading: mock pipeline.exec to return the stored hash
      mockPipeline.exec.mockResolvedValue([
        [null, storedHash],
        [null, []], // empty conversation
      ]);

      const loaded = await store.load('sess-ttl-test');

      expect(loaded).not.toBeNull();
      expect(loaded!.maxAgeSeconds).toBe(7200);
    });

    it('returns undefined maxAgeSeconds for sessions without it', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES,
      });

      // Simulate loading a session that was created before maxAgeSeconds was added
      mockPipeline.exec.mockResolvedValue([
        [
          null,
          {
            id: 'sess-old',
            agentName: 'test-agent',
            irSourceHash: 'hash-old',
            version: '1',
            isComplete: 'false',
            isEscalated: 'false',
            initialized: 'false',
            createdAt: String(Date.now()),
            lastActivityAt: String(Date.now()),
            activeThreadIndex: '0',
            // No maxAgeSeconds field
          },
        ],
        [null, []],
      ]);

      const loaded = await store.load('sess-old');

      expect(loaded).not.toBeNull();
      expect(loaded!.maxAgeSeconds).toBeUndefined();
    });
  });

  // ===========================================================================
  // computeEffectiveTtl — edge cases
  // ===========================================================================

  describe('effective TTL edge cases', () => {
    it('handles maxAgeSeconds === 0 (treat as unset)', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES,
      });

      // maxAgeSeconds = 0 is falsy -> should use default TTL
      const session = createBaseSessionData({ maxAgeSeconds: 0 });
      await store.create(session);

      const expireCalls = mockPipeline.expire.mock.calls;
      for (const call of expireCalls) {
        expect(call[1]).toBe(DEFAULT_TTL_SECONDS);
      }
    });

    it('handles session created in the future (clock skew) gracefully', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES,
      });

      // Session created 10 seconds in the future (clock skew)
      const futureTimestamp = Date.now() + 10_000;
      const maxAge = 600;
      const session = createBaseSessionData({
        version: 2,
        createdAt: futureTimestamp,
        maxAgeSeconds: maxAge,
      });

      const success = await store.save(session);

      // Should succeed — elapsed is negative, remaining > maxAge, capped to min(default, remaining)
      expect(success).toBe(true);
      const evalCall = mockRedis.eval.mock.calls[0];
      const ttlUsed = evalCall[4] as number;
      // remaining = 600 - (negative elapsed) > 600, so min(1800, >600) = 600
      // But actually remaining = maxAge - (now - future) = 600 - (-10) = 610
      // min(1800, 610) = 610, ceil = 610
      expect(ttlUsed).toBeGreaterThanOrEqual(600);
      expect(ttlUsed).toBeLessThanOrEqual(620);
    });

    it('maxAgeSeconds exactly equals elapsed time returns 0 TTL', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES,
      });

      // Session created exactly maxAgeSeconds ago -> remaining = 0
      const maxAge = 300;
      const exactlyAgo = Date.now() - maxAge * 1000;
      const session = createBaseSessionData({
        version: 2,
        createdAt: exactlyAgo,
        maxAgeSeconds: maxAge,
      });

      const success = await store.save(session);

      // TTL = max(0, 0) = 0 -> should return false (expired)
      expect(success).toBe(false);
      expect(mockRedis.eval).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // transferInitiated — minimum TTL floor
  // ===========================================================================

  describe('transferInitiated — 8-hour minimum TTL floor', () => {
    it('create() uses TRANSFER_SESSION_MIN_TTL_SECONDS floor when transferInitiated is true', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES, // 30 min = 1800s
      });

      const session = createBaseSessionData({ transferInitiated: true });
      await store.create(session);

      // All EXPIRE calls should use the transfer floor (8h), not the 30-min default
      const expireCalls = mockPipeline.expire.mock.calls;
      expect(expireCalls.length).toBeGreaterThan(0);
      for (const call of expireCalls) {
        expect(call[1]).toBe(TRANSFER_SESSION_MIN_TTL_SECONDS);
      }
    });

    it('create() does not apply floor when transferInitiated is false', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES,
      });

      const session = createBaseSessionData({ transferInitiated: false });
      await store.create(session);

      const expireCalls = mockPipeline.expire.mock.calls;
      for (const call of expireCalls) {
        expect(call[1]).toBe(DEFAULT_TTL_SECONDS);
      }
    });

    it('save() applies TRANSFER_SESSION_MIN_TTL_SECONDS floor when transferInitiated is true', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES,
      });

      const session = createBaseSessionData({ version: 2, transferInitiated: true });
      const success = await store.save(session);

      expect(success).toBe(true);
      // eval(script, 1, key, expectedVersion, ttl, ...fields)
      const evalCall = mockRedis.eval.mock.calls[0];
      expect(evalCall[4]).toBe(TRANSFER_SESSION_MIN_TTL_SECONDS);
    });

    it('save() does NOT revive a session whose maxAgeSeconds is exhausted even when transferInitiated is true', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES,
      });

      // Session created 2 hours ago with 1-hour max age → fully expired
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      const session = createBaseSessionData({
        version: 2,
        createdAt: twoHoursAgo,
        maxAgeSeconds: 3600,
        transferInitiated: true,
      });

      // The 8h floor must NOT override the maxAgeSeconds hard expiry
      const success = await store.save(session);

      expect(success).toBe(false);
      expect(mockRedis.eval).not.toHaveBeenCalled();
    });

    it('save() floor overrides idleSeconds cap when transferInitiated is true', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES,
      });

      // idleSeconds would normally cap TTL to 300s, but the transfer floor wins
      const session = createBaseSessionData({
        version: 2,
        transferInitiated: true,
        idleSeconds: 300,
      });
      const success = await store.save(session);

      expect(success).toBe(true);
      const evalCall = mockRedis.eval.mock.calls[0];
      expect(evalCall[4]).toBe(TRANSFER_SESSION_MIN_TTL_SECONDS);
    });
  });

  // ===========================================================================
  // touchScoped() — TTL refresh with transferInitiated floor (223d1061)
  // ===========================================================================

  describe('touchScoped() — TTL refresh respects transferInitiated floor', () => {
    it('applies TRANSFER_SESSION_MIN_TTL_SECONDS floor when transferInitiated is true', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES,
      });

      const createdAt = Date.now();
      mockRedis.hmget.mockResolvedValueOnce([String(createdAt), null, null, 'true']);

      await store.touchScoped({ sessionId: 'sess-ttl-test', tenantId: 'tenant-1' });

      const expireCalls = mockPipeline.expire.mock.calls;
      expect(expireCalls.length).toBeGreaterThan(0);
      for (const call of expireCalls) {
        expect(call[1]).toBe(TRANSFER_SESSION_MIN_TTL_SECONDS);
      }
    });

    it('does not apply floor when transferInitiated is false', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES,
      });

      const createdAt = Date.now();
      mockRedis.hmget.mockResolvedValueOnce([String(createdAt), null, null, 'false']);

      await store.touchScoped({ sessionId: 'sess-ttl-test', tenantId: 'tenant-1' });

      const expireCalls = mockPipeline.expire.mock.calls;
      expect(expireCalls.length).toBeGreaterThan(0);
      for (const call of expireCalls) {
        expect(call[1]).toBe(DEFAULT_TTL_SECONDS);
      }
    });

    it('does not extend an expired session even with transferInitiated floor', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES,
      });

      // Session created 2h ago with 1h max age — fully expired
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      mockRedis.hmget.mockResolvedValueOnce([String(twoHoursAgo), '3600', null, 'true']);

      await store.touchScoped({ sessionId: 'sess-ttl-test', tenantId: 'tenant-1' });

      // No expire calls — session already past maxAge
      expect(mockPipeline.expire).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // computeEffectiveTtl — near-zero remainingLifetime boundary (dfda4e45)
  // ===========================================================================

  describe('computeEffectiveTtl — near-zero remainingLifetime boundary', () => {
    it('applies transfer floor when session has seconds remaining before maxAge', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES,
      });

      // 10 seconds remaining before maxAge=3600 expires
      const nearExpiry = Date.now() - (3600 - 10) * 1000;
      mockRedis.hmget.mockResolvedValueOnce([String(nearExpiry), '3600', null, 'true']);

      await store.touchScoped({ sessionId: 'sess-ttl-test', tenantId: 'tenant-1' });

      // Floor wins — session is still live and transferred → extend to 8h
      const expireCalls = mockPipeline.expire.mock.calls;
      expect(expireCalls.length).toBeGreaterThan(0);
      for (const call of expireCalls) {
        expect(call[1]).toBe(TRANSFER_SESSION_MIN_TTL_SECONDS);
      }
    });

    it('does not revive a session at exactly zero remaining lifetime', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES,
      });

      // Session created exactly maxAgeSeconds ago — remaining = 0
      const exactlyExpired = Date.now() - 3600 * 1000;
      mockRedis.hmget.mockResolvedValueOnce([String(exactlyExpired), '3600', null, 'true']);

      await store.touchScoped({ sessionId: 'sess-ttl-test', tenantId: 'tenant-1' });

      expect(mockPipeline.expire).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // create() / save() — tenantId guard (f2dcee31)
  // ===========================================================================

  describe('create() and save() — tenantId required', () => {
    it('create() throws when session has no tenantId', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES,
      });

      const session = createBaseSessionData({ tenantId: '' });
      await expect(store.create(session)).rejects.toThrow('create() requires tenantId');
    });

    it('save() throws when session has no tenantId', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES,
      });

      const session = createBaseSessionData({ version: 2, tenantId: '' });
      await expect(store.save(session)).rejects.toThrow('save() requires tenantId');
    });
  });

  // ===========================================================================
  // appendMessages — tenantId null guard (c1aecdbd / 044f619b)
  // ===========================================================================

  describe('appendMessages() — tenantId unresolvable', () => {
    it('returns early without writing to Redis when tenantId cannot be resolved', async () => {
      const store = new RedisSessionStore(mockRedis, {
        sessionTtlMinutes: DEFAULT_TTL_MINUTES,
      });

      // resolveTenantId uses redis.get on the reverse-lookup key; returning null
      // simulates a session whose tenant mapping was never written or has expired.
      mockRedis.get.mockResolvedValueOnce(null);

      const message: ConversationMessage = {
        role: 'user',
        content: 'hello',
        timestamp: new Date().toISOString(),
      };

      await store.appendMessages('unknown-session', [message]);

      // No pipeline operations should be issued — early return before any Redis write
      expect(mockPipeline.rpush).not.toHaveBeenCalled();
      expect(mockPipeline.expire).not.toHaveBeenCalled();
    });
  });
});

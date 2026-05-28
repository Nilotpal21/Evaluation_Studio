/**
 * Session Store E2E Tests
 *
 * Comprehensive multi-turn session tests covering:
 * 1. MemorySessionStore — CRUD, version conflicts, conversation window trim
 * 2. RedisSessionStore — Same tests against real Redis (v7.2.4)
 * 3. SessionService — Multi-turn session lifecycle with L1/L2 caching
 * 4. TwoTierIRCache — L1 hit, L2 hit, miss paths
 * 5. RedisTraceStore — Stream write, replay, cleanup
 * 6. DB Persistence — MongoDB stores (MongoConversationStore, MongoMessageStore)
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { initDEKFacade } from '@agent-platform/database/kms';
import Redis from 'ioredis';
import { scanKeys } from '@agent-platform/redis';
import { MemorySessionStore } from '../../services/session/memory-session-store.js';
import { RedisSessionStore } from '../../services/session/redis-session-store.js';
import { SessionService, createSessionService } from '../../services/session/session-service.js';
import { TwoTierIRCache } from '../../services/session/ir-cache.js';
import { RedisTraceStore, type TraceEvent } from '../../services/trace/redis-trace-store.js';
import { runWithTenantContext } from '@agent-platform/shared';
import type { SessionData } from '../../services/session/types.js';
import type { AgentIR, CompilationOutput } from '@abl/compiler';

// =============================================================================
// HELPERS
// =============================================================================

let seq = 0;
function uniqueId(prefix = 'sess'): string {
  return `${prefix}-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeAgentIR(name = 'test_agent'): AgentIR {
  return {
    name,
    version: '1.0',
    description: `Test agent ${name}`,
    metadata: { type: 'reasoning' as any, mode: 'reasoning' as any },
    tools: [],
    constraints: { constraints: [], guardrails: [] },
    settings: {},
  } as unknown as AgentIR;
}

function makeCompilationOutput(agentName = 'test_agent'): CompilationOutput {
  const ir = makeAgentIR(agentName);
  return { agents: { [agentName]: ir }, entry_agent: agentName } as unknown as CompilationOutput;
}

function makeSessionData(overrides: Partial<SessionData> = {}): SessionData {
  const now = Date.now();
  return {
    id: uniqueId(),
    agentName: 'test_agent',
    tenantId: 'tenant-test',
    irSourceHash: 'hash_abc123',
    compilationHash: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
    version: 0,
    isComplete: false,
    isEscalated: false,
    handoffStack: ['test_agent'],
    createdAt: now,
    lastActivityAt: now,
    ...overrides,
  };
}

/**
 * Wraps a function in ALS tenant context so MongoConversationStore.withTenant()
 * can read the tenantId. createSession takes tenantId directly and does NOT
 * need this, but getSession/updateSession/endSession etc. do.
 */
function withTestTenant<T>(tenantId: string, fn: () => T): T {
  return runWithTenantContext(
    {
      tenantId,
      userId: 'test-user',
      role: 'ADMIN',
      permissions: ['read', 'write'],
      authType: 'user' as const,
      isSuperAdmin: false,
    },
    fn,
  );
}

// =============================================================================
// REDIS CONNECTION
// =============================================================================

let redis: Redis | null = null;
let redisAvailable = false;

function skipIfNoRedis(): boolean {
  if (!redisAvailable || !redis) return true;
  return false;
}

beforeAll(async () => {
  try {
    redis = new Redis({
      host: '127.0.0.1',
      port: 6379,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    await redis.connect();
    await redis.ping();
    redisAvailable = true;
    console.log('[Test Setup] Redis connected');
  } catch {
    console.warn('[Test Setup] Redis not available — Redis tests will be skipped');
    redis = null;
  }
});

afterAll(async () => {
  if (redis) {
    await redis.quit();
    redis = null;
  }
});

async function cleanRedisKeys(pattern: string) {
  if (!redis) return;
  // Use scanKeys (cluster-safe) instead of KEYS command
  const keys: string[] = [];
  for await (const k of scanKeys(redis, pattern)) keys.push(k);
  // Per-key DEL for cluster compatibility (multi-key DEL requires same slot)
  if (keys.length > 0) await Promise.all(keys.map((k) => redis!.del(k)));
}

// =============================================================================
// 1. MEMORY SESSION STORE
// =============================================================================

describe('MemorySessionStore', () => {
  let store: MemorySessionStore;
  beforeEach(() => {
    store = new MemorySessionStore();
  });

  test('create and load session', async () => {
    const s = makeSessionData();
    await store.create(s);
    const loaded = await store.load(s.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(s.id);
    expect(loaded!.agentName).toBe('test_agent');
    expect(loaded!.version).toBe(0);
  });

  test('load returns null for missing', async () => {
    expect(await store.load('nope')).toBeNull();
  });

  test('delete removes session', async () => {
    const s = makeSessionData();
    await store.create(s);
    await store.delete(s.id);
    expect(await store.load(s.id)).toBeNull();
  });

  test('save with correct version succeeds', async () => {
    const s = makeSessionData();
    await store.create(s);
    expect(await store.save({ ...s, version: 1, agentName: 'updated' })).toBe(true);
    expect((await store.load(s.id))!.agentName).toBe('updated');
  });

  test('save with wrong version fails (optimistic concurrency)', async () => {
    const s = makeSessionData();
    await store.create(s);
    expect(await store.save({ ...s, version: 5 })).toBe(false);
  });

  test('append and retrieve messages', async () => {
    const s = makeSessionData();
    await store.create(s);
    await store.appendMessages(s.id, [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ]);
    const h = await store.getConversationHistory(s.id);
    expect(h).toHaveLength(3);
    expect(h[0].role).toBe('system');
  });

  test('getConversationHistory with limit preserves first', async () => {
    const s = makeSessionData();
    await store.create(s);
    const msgs = [{ role: 'system', content: 'System' }];
    for (let i = 0; i < 5; i++) {
      msgs.push({ role: 'user', content: `U${i}` }, { role: 'assistant', content: `A${i}` });
    }
    await store.appendMessages(s.id, msgs);
    const limited = await store.getConversationHistory(s.id, 5);
    expect(limited).toHaveLength(5);
    expect(limited[0].content).toBe('System');
  });

  test('trimConversation enforces window', async () => {
    const s = makeSessionData();
    await store.create(s);
    const msgs = [{ role: 'system', content: 'System' }];
    for (let i = 0; i < 10; i++) msgs.push({ role: 'user', content: `T${i}` });
    await store.appendMessages(s.id, msgs);
    await store.trimConversation(s.id, 5);
    const trimmed = await store.getConversationHistory(s.id);
    expect(trimmed).toHaveLength(5);
    expect(trimmed[0].content).toBe('System');
  });

  test('IR cache set/get', async () => {
    await store.setAgentIR('h1', makeAgentIR('cached'));
    expect((await store.getAgentIR('h1'))!.name).toBe('cached');
    expect(await store.getAgentIR('missing')).toBeNull();
  });

  test('compilation cache set/get', async () => {
    await store.setCompilationOutput('ch', makeCompilationOutput('comp'));
    expect((await store.getCompilationOutput('ch'))!.entry_agent).toBe('comp');
  });

  test('agent registry', async () => {
    const id = uniqueId();
    await store.setAgentRegistry(id, { a: 'h1', b: 'h2' });
    expect(await store.getAgentRegistry(id)).toEqual({ a: 'h1', b: 'h2' });
    expect(await store.getAgentRegistry('missing')).toBeNull();
  });

  test('execution lock', async () => {
    const id = uniqueId();
    expect(await store.acquireLock(id)).toBe(true);
    expect(await store.acquireLock(id)).toBe(false);
    await store.releaseLock(id);
    expect(await store.acquireLock(id)).toBe(true);
  });
});

// =============================================================================
// 2. REDIS SESSION STORE
// =============================================================================

describe('RedisSessionStore', () => {
  let store: RedisSessionStore;
  let tp: string;

  beforeEach(() => {
    if (skipIfNoRedis()) return;
    tp = uniqueId('rss');
    store = new RedisSessionStore(redis!, {
      sessionTtlMinutes: 5,
      irTtlMinutes: 10,
      lockOwner: `pod_${tp}`,
    });
  });

  afterEach(async () => {
    if (skipIfNoRedis()) return;
    await cleanRedisKeys(`sess:*:${tp}*`);
    await cleanRedisKeys(`sess-tid:${tp}*`);
    await cleanRedisKeys(`ir:*`);
    await cleanRedisKeys(`comp:*`);
    await cleanRedisKeys(`registry:*:${tp}*`);
    await cleanRedisKeys(`lock:exec:*:${tp}*`);
  });

  test('create and load session', async () => {
    if (skipIfNoRedis()) return;
    const s = makeSessionData({ id: `${tp}-s1` });
    await store.create(s);
    const loaded = await store.load(s.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(s.id);
    expect(loaded!.agentName).toBe('test_agent');
    expect(loaded!.version).toBe(0);
    expect(loaded!.isComplete).toBe(false);
    expect(loaded!.handoffStack).toEqual(['test_agent']);
  });

  test('load returns null for missing', async () => {
    if (skipIfNoRedis()) return;
    expect(await store.load(`${tp}-nope`)).toBeNull();
  });

  test('delete removes all keys', async () => {
    if (skipIfNoRedis()) return;
    const id = `${tp}-del`;
    const s = makeSessionData({ id });
    await store.create(s);
    await store.appendMessages(id, [{ role: 'user', content: 'hi' }]);
    await store.setAgentRegistry(id, { a: 'h1' });
    await store.delete(id);
    expect(await store.load(id)).toBeNull();
    expect(await store.getConversationHistory(id)).toEqual([]);
    expect(await store.getAgentRegistry(id)).toBeNull();
  });

  test('save with correct version (Lua atomic)', async () => {
    if (skipIfNoRedis()) return;
    const id = `${tp}-save`;
    const s = makeSessionData({ id });
    await store.create(s); // version=0 in Redis
    // Pass version=1 (pre-incremented, matching SessionService.saveSession contract)
    expect(await store.save({ ...s, version: 1, agentName: 'updated' })).toBe(true);
    const loaded = await store.load(id);
    expect(loaded!.agentName).toBe('updated');
    expect(loaded!.version).toBe(1);
  });

  test('save with wrong version fails (optimistic concurrency)', async () => {
    if (skipIfNoRedis()) return;
    const id = `${tp}-conflict`;
    const s = makeSessionData({ id });
    await store.create(s); // version=0 in Redis
    await store.save({ ...s, version: 1 }); // expected=0 matches, Lua bumps to 1
    // Stale save: expected=0 but current=1 → conflict
    expect(await store.save({ ...s, version: 1, agentName: 'stale' })).toBe(false);
  });

  test('preserves JSON fields through round-trip', async () => {
    if (skipIfNoRedis()) return;
    const id = `${tp}-json`;
    const s = makeSessionData({
      id,
      state: {
        gatherProgress: { name: 'John' },
        conversationPhase: 'gathering',
        context: { intent: 'book' },
      },
      dataValues: { dest: 'Paris' },
      dataGatheredKeys: [],
      waitingForInput: ['budget'],
      handoffStack: ['sup', 'booking'],
      handoffReturnInfo: { booking: true },
    });
    await store.create(s);
    const loaded = await store.load(id);
    expect(loaded!.state.gatherProgress).toEqual({ name: 'John' });
    expect(loaded!.dataValues).toEqual({ dest: 'Paris' });
    expect(loaded!.dataGatheredKeys).toEqual([]);
    expect(loaded!.waitingForInput).toEqual(['budget']);
    expect(loaded!.handoffStack).toEqual(['sup', 'booking']);
    expect(loaded!.handoffReturnInfo).toEqual({ booking: true });
  });

  test('preserves boolean fields through round-trip', async () => {
    if (skipIfNoRedis()) return;
    const id = `${tp}-bool`;
    const s = makeSessionData({
      id,
      isComplete: true,
      isEscalated: true,
      escalationReason: 'human requested',
    });
    await store.create(s);
    const loaded = await store.load(id);
    expect(loaded!.isComplete).toBe(true);
    expect(loaded!.isEscalated).toBe(true);
    expect(loaded!.escalationReason).toBe('human requested');
  });

  test('append and retrieve conversation', async () => {
    if (skipIfNoRedis()) return;
    const id = `${tp}-conv`;
    await store.create(makeSessionData({ id }));
    await store.appendMessages(id, [
      { role: 'system', content: 'Sys' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ]);
    const h = await store.getConversationHistory(id);
    expect(h).toHaveLength(3);
    expect(h[0]).toEqual({ role: 'system', content: 'Sys' });
  });

  test('conversation limit preserves first message', async () => {
    if (skipIfNoRedis()) return;
    const id = `${tp}-climit`;
    await store.create(makeSessionData({ id }));
    const msgs: Array<{ role: string; content: string }> = [{ role: 'system', content: 'Sys' }];
    for (let i = 0; i < 10; i++)
      msgs.push({ role: 'user', content: `U${i}` }, { role: 'assistant', content: `A${i}` });
    await store.appendMessages(id, msgs);
    const limited = await store.getConversationHistory(id, 5);
    expect(limited).toHaveLength(5);
    expect(limited[0].content).toBe('Sys');
  });

  test('multi-turn conversation append', async () => {
    if (skipIfNoRedis()) return;
    const id = `${tp}-mt`;
    await store.create(makeSessionData({ id }));
    await store.appendMessages(id, [
      { role: 'user', content: 'T1' },
      { role: 'assistant', content: 'R1' },
    ]);
    await store.appendMessages(id, [
      { role: 'user', content: 'T2' },
      { role: 'assistant', content: 'R2' },
    ]);
    await store.appendMessages(id, [
      { role: 'user', content: 'T3' },
      { role: 'assistant', content: 'R3' },
    ]);
    const h = await store.getConversationHistory(id);
    expect(h).toHaveLength(6);
    expect(h[0].content).toBe('T1');
    expect(h[5].content).toBe('R3');
  });

  test('AgentIR gzip round-trip', async () => {
    if (skipIfNoRedis()) return;
    const hash = `ir_${tp}`;
    await store.setAgentIR(hash, makeAgentIR('gzip'));
    const loaded = await store.getAgentIR(hash);
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe('gzip');
    expect(await store.getAgentIR('missing')).toBeNull();
  });

  test('gzip achieves compression', async () => {
    if (skipIfNoRedis()) return;
    const bigIR = makeAgentIR('big');
    (bigIR as any).tools = Array.from({ length: 50 }, (_, i) => ({
      name: `tool_${i}`,
      description: `Desc for tool ${i} with details`,
      parameters: { type: 'object' },
    }));
    const hash = `big_${tp}`;
    await store.setAgentIR(hash, bigIR);
    const loaded = await store.getAgentIR(hash);
    expect((loaded as any).tools).toHaveLength(50);
    const rawSize = await redis!.strlen(`ir:${hash}`);
    expect(rawSize).toBeLessThan(JSON.stringify(bigIR).length);
  });

  test('CompilationOutput gzip round-trip', async () => {
    if (skipIfNoRedis()) return;
    const hash = `comp_${tp}`;
    await store.setCompilationOutput(hash, makeCompilationOutput('comp'));
    expect((await store.getCompilationOutput(hash))!.entry_agent).toBe('comp');
  });

  test('agent registry', async () => {
    if (skipIfNoRedis()) return;
    const id = `${tp}-reg`;
    await store.create(makeSessionData({ id, tenantId: tp }));
    await store.setAgentRegistry(id, { booking: 'hb', faq: 'hf' });
    expect(await store.getAgentRegistry(id)).toEqual({ booking: 'hb', faq: 'hf' });
    expect(await store.getAgentRegistry(`${tp}-noreg`)).toBeNull();
  });

  test('execution lock acquire/release', async () => {
    if (skipIfNoRedis()) return;
    const id = `${tp}-lock`;
    await store.create(makeSessionData({ id, tenantId: tp }));
    expect(await store.acquireLock(id, 5000)).toBe(true);
    expect(await store.acquireLock(id, 5000)).toBe(false);
    await store.releaseLock(id);
    expect(await store.acquireLock(id, 5000)).toBe(true);
  });

  test('lock CAS — different owner cannot release', async () => {
    if (skipIfNoRedis()) return;
    const id = `${tp}-lcas`;
    const s1 = new RedisSessionStore(redis!, { lockOwner: 'pod_A' });
    const s2 = new RedisSessionStore(redis!, { lockOwner: 'pod_B' });
    await s1.create(makeSessionData({ id, tenantId: tp }));
    expect(await s1.acquireLock(id, 10000)).toBe(true);
    await s2.releaseLock(id); // should fail (different owner)
    expect(await s2.acquireLock(id, 10000)).toBe(false); // still held by A
    await s1.releaseLock(id);
    expect(await s2.acquireLock(id, 10000)).toBe(true);
    await s2.releaseLock(id);
  });

  test('lock expires after TTL', async () => {
    if (skipIfNoRedis()) return;
    const id = `${tp}-lttl`;
    await store.create(makeSessionData({ id, tenantId: tp }));
    expect(await store.acquireLock(id, 200)).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(await store.acquireLock(id, 5000)).toBe(true);
    await store.releaseLock(id);
  });

  test('touch refreshes TTL', async () => {
    if (skipIfNoRedis()) return;
    const id = `${tp}-touch`;
    const s = makeSessionData({ id });
    await store.create(s);
    // Session keys are tenant-prefixed: sess:{tenantId}:{id}
    const sessKey = `sess:${s.tenantId}:${id}`;
    const ttl1 = await redis!.ttl(sessKey);
    expect(ttl1).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 100));
    await store.touch(id);
    const ttl2 = await redis!.ttl(sessKey);
    expect(ttl2).toBeGreaterThanOrEqual(ttl1 - 1);
  });
});

// =============================================================================
// 3. SESSION SERVICE (Multi-turn lifecycle)
// =============================================================================

describe('SessionService', () => {
  describe('with MemorySessionStore', () => {
    let svc: SessionService;
    let mem: MemorySessionStore;
    beforeEach(() => {
      mem = new MemorySessionStore();
      svc = createSessionService(mem, { conversationWindow: 10 });
    });

    test('create → load → hydrate', async () => {
      const ir = makeAgentIR('hydrate');
      const comp = makeCompilationOutput('hydrate');
      const h = await svc.createSession({
        id: uniqueId(),
        agentName: 'hydrate',
        agentIR: ir,
        compilationOutput: comp,
      });
      expect(h.agentIR).not.toBeNull();
      expect(h.compilationOutput).not.toBeNull();
      const loaded = await svc.loadSession(h.id);
      expect(loaded!.agentIR!.name).toBe('hydrate');
      expect(loaded!.compilationOutput!.entry_agent).toBe('hydrate');
    });

    test('multi-turn with state updates', async () => {
      const s = await svc.createSession({
        id: uniqueId(),
        agentName: 'mt',
        agentIR: makeAgentIR('mt'),
        compilationOutput: null,
      });
      await svc.appendToConversation(s.id, [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ]);
      await svc.appendToConversation(s.id, [
        { role: 'user', content: 'Book Paris' },
        { role: 'assistant', content: 'When?' },
      ]);
      let cur = await svc.loadSession(s.id);
      expect(cur!.conversationHistory).toHaveLength(4);
      const upd = {
        ...cur!,
        state: { ...cur!.state, gatherProgress: { dest: 'Paris' }, conversationPhase: 'gathering' },
        currentFlowStep: 'collect',
      };
      delete (upd as any).agentIR;
      delete (upd as any).compilationOutput;
      expect(await svc.saveSession(upd as SessionData)).toBe(true);
      await svc.appendToConversation(s.id, [
        { role: 'user', content: 'June 15' },
        { role: 'assistant', content: 'Travelers?' },
      ]);
      cur = await svc.loadSession(s.id);
      expect(cur!.conversationHistory).toHaveLength(6);
      expect(cur!.state.gatherProgress).toEqual({ dest: 'Paris' });
      expect(cur!.version).toBe(1);
    });

    test('conversation window trimming', async () => {
      const s = await svc.createSession({
        id: uniqueId(),
        agentName: 'trim',
        agentIR: makeAgentIR('trim'),
        compilationOutput: null,
      });
      await svc.appendToConversation(s.id, [{ role: 'system', content: 'SysPrompt' }]);
      for (let i = 0; i < 20; i++)
        await svc.appendToConversation(s.id, [
          { role: 'user', content: `Q${i}` },
          { role: 'assistant', content: `A${i}` },
        ]);
      const loaded = await svc.loadSession(s.id);
      expect(loaded!.conversationHistory.length).toBeLessThanOrEqual(10);
      expect(loaded!.conversationHistory[0].content).toBe('SysPrompt');
    });

    test('version conflict', async () => {
      const s = await svc.createSession({
        id: uniqueId(),
        agentName: 'conf',
        agentIR: makeAgentIR(),
        compilationOutput: null,
      });
      expect(await svc.saveSession({ ...s, agentName: 'v1' } as SessionData)).toBe(true);
      expect(await svc.saveSession({ ...s, agentName: 'v2' } as SessionData)).toBe(false);
    });

    test('delete session', async () => {
      const s = await svc.createSession({
        id: uniqueId(),
        agentName: 'del',
        agentIR: makeAgentIR(),
        compilationOutput: null,
      });
      await svc.deleteSession(s.id);
      expect(await svc.loadSession(s.id)).toBeNull();
    });

    test('IR deduplication', async () => {
      const ir = makeAgentIR('dedup');
      const s1 = await svc.createSession({
        id: uniqueId(),
        agentName: 'dedup',
        agentIR: ir,
        compilationOutput: null,
      });
      const s2 = await svc.createSession({
        id: uniqueId(),
        agentName: 'dedup',
        agentIR: ir,
        compilationOutput: null,
      });
      expect(s1.irSourceHash).toBe(s2.irSourceHash);
      expect(mem.getIRCacheSize()).toBe(1);
    });

    test('handoff session lifecycle with threads', async () => {
      const session = await svc.createSession({
        id: uniqueId(),
        agentName: 'supervisor',
        agentIR: makeAgentIR('sup'),
        compilationOutput: null,
      });
      expect(session.threads).toEqual([]);
      expect(session.activeThreadIndex).toBe(0);
      expect(session.threadStack).toEqual([]);

      // Simulate adding thread data via save
      const pd = await svc.store.load(session.id);
      const updatedSession = {
        ...pd!,
        threads: [
          {
            agentName: 'supervisor',
            irSourceHash: 'h1',
            conversationHistory: [],
            state: pd!.state,
            dataValues: {},
            dataGatheredKeys: [],
            startedAt: Date.now(),
            returnExpected: false,
            status: 'waiting' as const,
          },
          {
            agentName: 'booking',
            irSourceHash: 'h2',
            conversationHistory: [],
            state: pd!.state,
            dataValues: {},
            dataGatheredKeys: [],
            startedAt: Date.now(),
            returnExpected: true,
            status: 'active' as const,
          },
        ],
        activeThreadIndex: 1,
        threadStack: [0],
      };
      expect(await svc.saveSession(updatedSession)).toBe(true);

      const loaded = await svc.loadSession(session.id);
      expect(loaded!.threads.length).toBe(2);
      expect(loaded!.threads[0].agentName).toBe('supervisor');
      expect(loaded!.threads[1].agentName).toBe('booking');
      expect(loaded!.activeThreadIndex).toBe(1);
      expect(loaded!.threadStack).toEqual([0]);

      await svc.deleteSession(session.id);
      expect(await svc.loadSession(session.id)).toBeNull();
    });

    test('agent registry', async () => {
      const id = uniqueId();
      await svc.createSession({
        id,
        agentName: 'sup',
        agentIR: makeAgentIR('sup'),
        compilationOutput: null,
      });
      await svc.setAgentRegistry(id, { sup: 'h1', booking: 'h2' });
      expect(await svc.getAgentRegistry(id)).toEqual({ sup: 'h1', booking: 'h2' });
    });

    test('execution lock', async () => {
      const id = uniqueId();
      expect(await svc.acquireLock(id)).toBe(true);
      expect(await svc.acquireLock(id)).toBe(false);
      await svc.releaseLock(id);
      expect(await svc.acquireLock(id)).toBe(true);
    });
  });

  describe('with RedisSessionStore', () => {
    let svc: SessionService;
    let tp: string;
    beforeEach(() => {
      if (skipIfNoRedis()) return;
      tp = uniqueId('rsvc');
      svc = createSessionService(
        new RedisSessionStore(redis!, { sessionTtlMinutes: 5, lockOwner: `svc_${tp}` }),
        { conversationWindow: 10 },
      );
    });
    afterEach(async () => {
      if (skipIfNoRedis()) return;
      await cleanRedisKeys(`sess:*:${tp}*`);
      await cleanRedisKeys(`sess-tid:${tp}*`);
      await cleanRedisKeys(`registry:*:${tp}*`);
      await cleanRedisKeys(`lock:exec:*:${tp}*`);
      await cleanRedisKeys('ir:*');
      await cleanRedisKeys('comp:*');
    });

    test('full multi-turn session with Redis', async () => {
      if (skipIfNoRedis()) return;
      const s = await svc.createSession({
        id: `${tp}-mt`,
        agentName: 'hotel',
        tenantId: tp,
        agentIR: makeAgentIR('hotel'),
        compilationOutput: makeCompilationOutput('hotel'),
      });
      expect(s.version).toBe(0);

      // Turn 1
      await svc.appendToConversation(s.id, [
        { role: 'system', content: 'You are a hotel agent.' },
        { role: 'user', content: 'Paris hotel' },
        { role: 'assistant', content: 'Check-in date?' },
      ]);
      const s1 = await svc.loadSession(s.id);
      expect(
        await svc.saveSession({
          ...s1!,
          state: {
            ...s1!.state,
            gatherProgress: { dest: 'Paris' },
            conversationPhase: 'gathering',
          },
        } as SessionData),
      ).toBe(true);

      // Turn 2
      await svc.appendToConversation(s.id, [
        { role: 'user', content: 'June 15' },
        { role: 'assistant', content: 'Nights?' },
      ]);
      const s2 = await svc.loadSession(s.id);
      expect(s2!.version).toBe(1);
      expect(s2!.conversationHistory).toHaveLength(5);

      // Turn 3
      await svc.appendToConversation(s.id, [
        { role: 'user', content: '3' },
        { role: 'assistant', content: 'Booked! #12345' },
      ]);
      expect(
        await svc.saveSession({
          ...s2!,
          state: { ...s2!.state, gatherProgress: { dest: 'Paris', nights: 3 } },
          isComplete: true,
        } as SessionData),
      ).toBe(true);

      const final = await svc.loadSession(s.id);
      expect(final!.version).toBe(2);
      expect(final!.conversationHistory).toHaveLength(7);
      expect(final!.isComplete).toBe(true);
      expect(final!.agentIR!.name).toBe('hotel');
      expect(final!.compilationOutput).not.toBeNull();
    });

    test('IR resolved from L2 (Redis) across pods', async () => {
      if (skipIfNoRedis()) return;
      const svc1 = createSessionService(
        new RedisSessionStore(redis!, { sessionTtlMinutes: 5, lockOwner: 'p1' }),
        { conversationWindow: 10 },
      );
      const s = await svc1.createSession({
        id: `${tp}-l2`,
        agentName: 'l2',
        tenantId: tp,
        agentIR: makeAgentIR('l2'),
        compilationOutput: null,
      });
      const svc2 = createSessionService(
        new RedisSessionStore(redis!, { sessionTtlMinutes: 5, lockOwner: 'p2' }),
        { conversationWindow: 10 },
      );
      const loaded = await svc2.loadSession(s.id);
      expect(loaded!.agentIR!.name).toBe('l2');
    });

    test('conversation window enforced in Redis', async () => {
      if (skipIfNoRedis()) return;
      const s = await svc.createSession({
        id: `${tp}-win`,
        agentName: 'win',
        tenantId: tp,
        agentIR: makeAgentIR('win'),
        compilationOutput: null,
      });
      await svc.appendToConversation(s.id, [{ role: 'system', content: 'SysPrompt' }]);
      for (let i = 0; i < 20; i++)
        await svc.appendToConversation(s.id, [
          { role: 'user', content: `Q${i}` },
          { role: 'assistant', content: `A${i}` },
        ]);
      const loaded = await svc.loadSession(s.id);
      expect(loaded!.conversationHistory.length).toBeLessThanOrEqual(10);
      expect(loaded!.conversationHistory[0].content).toBe('SysPrompt');
    });
  });
});

// =============================================================================
// 4. TWO-TIER IR CACHE
// =============================================================================

describe('TwoTierIRCache', () => {
  test('L1 hit (no store access)', async () => {
    const c = new TwoTierIRCache(new MemorySessionStore(), { maxL1Entries: 5 });
    await c.setIR('h1', makeAgentIR('c'));
    expect((await c.getIR('h1'))!.name).toBe('c');
    expect(c.getStats().l1Hit).toBe(1);
  });

  test('L2 hit (promotes to L1)', async () => {
    const mem = new MemorySessionStore();
    await mem.setAgentIR('h2', makeAgentIR('l2'));
    const c = new TwoTierIRCache(mem, { maxL1Entries: 5 });
    expect((await c.getIR('h2'))!.name).toBe('l2');
    expect(c.getStats().l2Hit).toBe(1);
    await c.getIR('h2');
    expect(c.getStats().l1Hit).toBe(1);
  });

  test('miss', async () => {
    const c = new TwoTierIRCache(new MemorySessionStore(), { maxL1Entries: 5 });
    expect(await c.getIR('nope')).toBeNull();
    expect(c.getStats().miss).toBe(1);
  });

  test('LRU eviction', async () => {
    const mem = new MemorySessionStore();
    const c = new TwoTierIRCache(mem, { maxL1Entries: 3 });
    await c.setIR('a', makeAgentIR('a'));
    await c.setIR('b', makeAgentIR('b'));
    await c.setIR('c', makeAgentIR('c'));
    await c.setIR('d', makeAgentIR('d')); // evicts 'a' from L1
    c.clear();
    expect((await c.getIR('a'))!.name).toBe('a'); // L2 hit
    expect(c.getStats().l2Hit).toBe(1);
  });

  test('compilation caching', async () => {
    const c = new TwoTierIRCache(new MemorySessionStore(), { maxL1Entries: 5 });
    await c.setCompilation('c1', makeCompilationOutput('co'));
    expect((await c.getCompilation('c1'))!.entry_agent).toBe('co');
  });

  test('L2 from Redis with gzip', async () => {
    if (skipIfNoRedis()) return;
    const rs = new RedisSessionStore(redis!, { sessionTtlMinutes: 5 });
    const hash = `tirc_${uniqueId()}`;
    await rs.setAgentIR(hash, makeAgentIR('rl2'));
    const c = new TwoTierIRCache(rs, { maxL1Entries: 5 });
    expect((await c.getIR(hash))!.name).toBe('rl2');
    expect(c.getStats().l2Hit).toBe(1);
    await redis!.del(`ir:${hash}`);
  });
});

// =============================================================================
// 5. REDIS TRACE STORE
// =============================================================================

describe('RedisTraceStore', () => {
  let ts: RedisTraceStore;
  let sid: string;

  beforeEach(() => {
    if (skipIfNoRedis()) return;
    sid = uniqueId('trace');
    ts = new RedisTraceStore(redis!, { maxEventsPerSession: 100, maxAgeMinutes: 5 });
  });

  afterEach(async () => {
    if (skipIfNoRedis()) return;
    if (ts) await ts.stop();
    await cleanRedisKeys(`trace:stream:${sid}*`);
  });

  test('addEvent writes to stream', async () => {
    if (skipIfNoRedis()) return;
    await ts.addEvent(sid, {
      id: 'e1',
      sessionId: sid,
      type: 'llm_call',
      timestamp: new Date(),
      data: { model: 'gpt-4' },
      agentName: 'test',
    });
    const events = await ts.getEvents(sid);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('llm_call');
    expect(events[0].data.model).toBe('gpt-4');
  });

  test('multiple events in order', async () => {
    if (skipIfNoRedis()) return;
    for (let i = 0; i < 5; i++)
      await ts.addEvent(sid, {
        id: `e${i}`,
        sessionId: sid,
        type: 'llm_call',
        timestamp: new Date(),
        data: { idx: i },
      });
    const events = await ts.getEvents(sid);
    expect(events).toHaveLength(5);
    expect(events[0].data.idx).toBe(0);
    expect(events[4].data.idx).toBe(4);
  });

  test('removeSession deletes stream', async () => {
    if (skipIfNoRedis()) return;
    await ts.addEvent(sid, {
      id: 'ed',
      sessionId: sid,
      type: 'decision',
      timestamp: new Date(),
      data: {},
    });
    await ts.removeSession(sid);
    expect(await ts.getEvents(sid)).toHaveLength(0);
  });

  test('stream respects MAXLEN', async () => {
    if (skipIfNoRedis()) return;
    // Use larger numbers — Redis MAXLEN ~ is approximate and trims in chunks
    const small = new RedisTraceStore(redis!, { maxEventsPerSession: 100, maxAgeMinutes: 5 });
    const s = uniqueId('ml');
    for (let i = 0; i < 300; i++)
      await small.addEvent(s, {
        id: `e${i}`,
        sessionId: s,
        type: 'llm_call',
        timestamp: new Date(),
        data: { i },
      });
    const events = await small.getEvents(s);
    expect(events.length).toBeLessThan(300); // trimming occurred
    expect(events.length).toBeGreaterThanOrEqual(100); // at least MAXLEN entries kept
    await redis!.del(`trace:stream:${s}`);
    await small.stop();
  });
});

// =============================================================================
// 6. DB PERSISTENCE (MongoDB Stores)
// =============================================================================

describe('DB Persistence — Sessions and Messages', () => {
  // Lazy-loaded MongoDB models and stores.
  // We do NOT import @agent-platform/database/models at the top level;
  // instead we dynamically import inside beforeAll after the in-memory
  // MongoDB server is connected so Mongoose registers schemas correctly.
  let MongoConversationStore: typeof import('../services/stores/mongo-conversation-store.js').MongoConversationStore;
  let MongoMessageStore: typeof import('../services/stores/mongo-message-store.js').MongoMessageStore;
  let setupTestMongo: typeof import('./helpers/setup-mongo.js').setupTestMongo;
  let teardownTestMongo: typeof import('./helpers/setup-mongo.js').teardownTestMongo;
  let clearCollections: typeof import('./helpers/setup-mongo.js').clearCollections;

  let mongoAvailable = false;

  beforeAll(async () => {
    try {
      const mongoHelpers = await import('../helpers/setup-mongo.js');
      setupTestMongo = mongoHelpers.setupTestMongo;
      teardownTestMongo = mongoHelpers.teardownTestMongo;
      clearCollections = mongoHelpers.clearCollections;

      await setupTestMongo();

      const models = await import('@agent-platform/database/models');
      models.setMasterKey('ab'.repeat(32));
      await initDEKFacade({ masterKeyHex: 'ab'.repeat(32) });

      // Import stores AFTER mongoose is connected so the models register
      const convModule = await import('../../services/stores/mongo-conversation-store.js');
      const msgModule = await import('../../services/stores/mongo-message-store.js');
      MongoConversationStore = convModule.MongoConversationStore;
      MongoMessageStore = msgModule.MongoMessageStore;

      mongoAvailable = true;
      console.log('[Test Setup] MongoDB Memory Server connected');
    } catch (err) {
      console.warn(
        '[Test Setup] MongoDB Memory Server not available — MongoDB tests will be skipped',
        err,
      );
    }
  }, 60_000);

  afterEach(async () => {
    if (mongoAvailable && clearCollections) {
      await clearCollections();
    }
  });

  afterAll(async () => {
    if (mongoAvailable && teardownTestMongo) {
      await teardownTestMongo();
    }
  });

  function skipIfNoMongo(): boolean {
    return !mongoAvailable;
  }

  // ---------------------------------------------------------------------------
  // MongoConversationStore
  // ---------------------------------------------------------------------------

  describe('MongoConversationStore', () => {
    test('createSession persists to DB', { timeout: 15000 }, async () => {
      if (skipIfNoMongo()) return;
      const store = new MongoConversationStore({ type: 'mongodb' });

      const session = await store.createSession({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        channel: 'web_chat',
        environment: 'dev',
        agentName: 'booking_agent',
        agentVersion: '1.0.0',
        customerId: 'cust-abc',
      });

      expect(session).toBeDefined();
      expect(session.id).toBeDefined();
      expect(session.currentAgent).toBe('booking_agent');
      expect(session.status).toBe('active');
      expect(session.channel).toBe('web_chat');
      expect(session.environment).toBe('dev');
      expect(session.startedAt).toBeInstanceOf(Date);
      expect(session.lastActivityAt).toBeInstanceOf(Date);
      expect(session.tenantId).toBe('tenant-1');
      expect(session.projectId).toBe('proj-1');
      expect(session.customerId).toBe('cust-abc');
    });

    test('getSession retrieves by ID', async () => {
      if (skipIfNoMongo()) return;
      const store = new MongoConversationStore({ type: 'mongodb' });

      const created = await store.createSession({
        tenantId: 'tenant-2',
        projectId: 'proj-2',
        channel: 'voice',
        environment: 'dev',
        agentName: 'support_agent',
        agentVersion: '2.0.0',
      });

      await withTestTenant('tenant-2', async () => {
        const loaded = await store.getSession(created.id);
        expect(loaded).not.toBeNull();
        expect(loaded!.id).toBe(created.id);
        expect(loaded!.currentAgent).toBe('support_agent');
        expect(loaded!.status).toBe('active');
        expect(loaded!.channel).toBe('voice');

        // Non-existent session returns null
        const missing = await store.getSession('non-existent-id-999');
        expect(missing).toBeNull();
      });
    });

    test('updateSession tracks channel switches', async () => {
      if (skipIfNoMongo()) return;
      const store = new MongoConversationStore({ type: 'mongodb' });

      const session = await store.createSession({
        tenantId: 'tenant-3',
        projectId: 'proj-3',
        channel: 'web_chat',
        environment: 'dev',
        agentName: 'multi_agent',
        agentVersion: '1.0.0',
      });

      await withTestTenant('tenant-3', async () => {
        // Switch channel from web_chat to voice
        const updated = await store.updateSession(session.id, {
          channel: 'voice' as any,
          currentAgent: 'voice_agent',
        });

        expect(updated.channel).toBe('voice');
        expect(updated.currentAgent).toBe('voice_agent');
        // lastActivityAt should be refreshed
        expect(updated.lastActivityAt.getTime()).toBeGreaterThanOrEqual(
          session.lastActivityAt.getTime(),
        );

        // Verify persistence by re-loading
        const reloaded = await store.getSession(session.id);
        expect(reloaded!.channel).toBe('voice');
        expect(reloaded!.currentAgent).toBe('voice_agent');
      });
    });

    test('endSession sets status+disposition', async () => {
      if (skipIfNoMongo()) return;
      const store = new MongoConversationStore({ type: 'mongodb' });
      const msgStore = new MongoMessageStore({ type: 'mongodb' });

      const session = await store.createSession({
        tenantId: 'tenant-4',
        projectId: 'proj-4',
        channel: 'web_chat',
        environment: 'dev',
        agentName: 'end_agent',
        agentVersion: '1.0.0',
      });

      expect(session.status).toBe('active');
      expect(session.endedAt).toBeFalsy();

      // Add a message so the session isn't treated as a ghost (0-message sessions are deleted on end)
      await msgStore.addMessage({
        sessionId: session.id,
        role: 'user',
        content: 'Hello',
        channel: 'web_chat',
      });
      // Wait for the non-blocking messageCount increment to complete
      await new Promise((resolve) => setTimeout(resolve, 200));

      await withTestTenant('tenant-4', async () => {
        const ended = await store.endSession(session.id, 'completed');
        expect(ended.status).toBe('ended');
        expect(ended.disposition).toBe('completed');
        expect(ended.endedAt).toBeInstanceOf(Date);

        // Verify persistence
        const reloaded = await store.getSession(session.id);
        expect(reloaded!.status).toBe('ended');
        expect(reloaded!.disposition).toBe('completed');
        expect(reloaded!.endedAt).toBeDefined();
      });
    });

    test('multi-turn lifecycle with DB', async () => {
      if (skipIfNoMongo()) return;
      const store = new MongoConversationStore({ type: 'mongodb' });
      const msgStore = new MongoMessageStore({ type: 'mongodb' });

      // Turn 1: Create session
      const session = await store.createSession({
        tenantId: 'tenant-5',
        projectId: 'proj-5',
        channel: 'web_chat',
        environment: 'dev',
        agentName: 'travel_agent',
        agentVersion: '1.0.0',
        customerId: 'cust-travel-1',
      });
      expect(session.status).toBe('active');

      // Add a message so the session isn't treated as a ghost on endSession
      await msgStore.addMessage({
        sessionId: session.id,
        role: 'user',
        content: 'I want to book a trip to Paris',
        channel: 'web_chat',
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      await withTestTenant('tenant-5', async () => {
        // Turn 2: Update context during conversation
        const t2 = await store.updateSession(session.id, {
          context: { destination: 'Paris', intent: 'booking' },
        });
        expect(t2.context).toEqual({ destination: 'Paris', intent: 'booking' });

        // Turn 3: Handoff to another agent
        const t3 = await store.updateSession(session.id, {
          currentAgent: 'payment_agent',
        });
        expect(t3.currentAgent).toBe('payment_agent');

        // Turn 4: Complete the session
        const t4 = await store.endSession(session.id, 'completed');
        expect(t4.status).toBe('ended');
        expect(t4.disposition).toBe('completed');

        // Verify final state
        const final = await store.getSession(session.id);
        expect(final!.status).toBe('ended');
        expect(final!.currentAgent).toBe('payment_agent');
        expect(final!.context).toEqual({ destination: 'Paris', intent: 'booking' });
        expect(final!.customerId).toBe('cust-travel-1');
      });
    });
  });

  // ---------------------------------------------------------------------------
  // MongoMessageStore
  // ---------------------------------------------------------------------------

  describe('MongoMessageStore', () => {
    // Helper: create a session doc in MongoDB (needed because MongoMessageStore
    // looks up tenantId from the session document).
    async function createTestSession(tenantId: string, projectId: string): Promise<string> {
      const convStore = new MongoConversationStore({ type: 'mongodb' });
      const session = await convStore.createSession({
        tenantId,
        projectId,
        channel: 'web_chat',
        environment: 'dev',
        agentName: 'test_agent',
        agentVersion: '1.0.0',
      });
      return session.id;
    }

    test('addMessage persists', async () => {
      if (skipIfNoMongo()) return;
      const store = new MongoMessageStore({ type: 'mongodb' });
      const sessionId = await createTestSession('tenant-m1', 'proj-m1');

      const msg = await store.addMessage({
        sessionId,
        role: 'user',
        content: 'Hello, I need help booking a flight.',
        channel: 'web_chat',
        traceId: 'trace-001',
      });

      expect(msg).toBeDefined();
      expect(msg.id).toBeDefined();
      expect(msg.sessionId).toBe(sessionId);
      expect(msg.role).toBe('user');
      expect(msg.content).toBe('Hello, I need help booking a flight.');
      expect(msg.channel).toBe('web_chat');
      expect(msg.timestamp).toBeInstanceOf(Date);
    });

    test('getMessages retrieves in order', async () => {
      if (skipIfNoMongo()) return;
      const store = new MongoMessageStore({ type: 'mongodb' });
      const sessionId = await createTestSession('tenant-m2', 'proj-m2');

      // Add messages with slight delay to ensure timestamp ordering
      await store.addMessage({
        sessionId,
        role: 'system',
        content: 'You are a travel agent.',
        channel: 'web_chat',
        traceId: 'trace-sys',
      });
      await store.addMessage({
        sessionId,
        role: 'user',
        content: 'Book Paris flight',
        channel: 'web_chat',
        traceId: 'trace-u1',
      });
      await store.addMessage({
        sessionId,
        role: 'assistant',
        content: 'When do you want to travel?',
        channel: 'web_chat',
        traceId: 'trace-a1',
      });
      await store.addMessage({
        sessionId,
        role: 'user',
        content: 'June 15',
        channel: 'web_chat',
        traceId: 'trace-u2',
      });
      await store.addMessage({
        sessionId,
        role: 'assistant',
        content: 'Booked!',
        channel: 'web_chat',
        traceId: 'trace-a2',
      });

      // Default: exclude system messages
      const msgs = await store.getMessages({ sessionId, tenantId: 'tenant-m2' });
      expect(msgs).toHaveLength(4);
      expect(msgs[0].role).toBe('user');
      expect(msgs[0].content).toBe('Book Paris flight');
      expect(msgs[3].content).toBe('Booked!');

      // Verify ordering: timestamps are non-decreasing
      for (let i = 1; i < msgs.length; i++) {
        expect(msgs[i].timestamp.getTime()).toBeGreaterThanOrEqual(msgs[i - 1].timestamp.getTime());
      }
    });

    test('excludes system messages', async () => {
      if (skipIfNoMongo()) return;
      const store = new MongoMessageStore({ type: 'mongodb' });
      const sessionId = await createTestSession('tenant-m3', 'proj-m3');

      await store.addMessage({
        sessionId,
        role: 'system',
        content: 'System prompt',
        channel: 'web_chat',
        traceId: 't1',
      });
      await store.addMessage({
        sessionId,
        role: 'user',
        content: 'Hi',
        channel: 'web_chat',
        traceId: 't2',
      });
      await store.addMessage({
        sessionId,
        role: 'assistant',
        content: 'Hello!',
        channel: 'web_chat',
        traceId: 't3',
      });

      // Without includeSystem
      const noSystem = await store.getMessages({ sessionId, tenantId: 'tenant-m3' });
      expect(noSystem).toHaveLength(2);
      expect(noSystem.every((m) => m.role !== 'system')).toBe(true);

      // With includeSystem
      const withSystem = await store.getMessages({
        sessionId,
        tenantId: 'tenant-m3',
        includeSystem: true,
      });
      expect(withSystem).toHaveLength(3);
      expect(withSystem[0].role).toBe('system');
    });

    test('getMessageCount', async () => {
      if (skipIfNoMongo()) return;
      const store = new MongoMessageStore({ type: 'mongodb' });
      const sessionId = await createTestSession('tenant-m4', 'proj-m4');

      expect(await store.getMessageCount(sessionId)).toBe(0);

      await store.addMessage({
        sessionId,
        role: 'user',
        content: 'One',
        channel: 'web_chat',
        traceId: 't1',
      });
      await store.addMessage({
        sessionId,
        role: 'assistant',
        content: 'Two',
        channel: 'web_chat',
        traceId: 't2',
      });
      await store.addMessage({
        sessionId,
        role: 'user',
        content: 'Three',
        channel: 'web_chat',
        traceId: 't3',
      });

      expect(await store.getMessageCount(sessionId)).toBe(3);
    });

    test('deleteBySession', async () => {
      if (skipIfNoMongo()) return;
      const store = new MongoMessageStore({ type: 'mongodb' });
      const sessionId = await createTestSession('tenant-m5', 'proj-m5');

      await store.addMessage({
        sessionId,
        role: 'user',
        content: 'Msg1',
        channel: 'web_chat',
        traceId: 't1',
      });
      await store.addMessage({
        sessionId,
        role: 'assistant',
        content: 'Msg2',
        channel: 'web_chat',
        traceId: 't2',
      });
      await store.addMessage({
        sessionId,
        role: 'user',
        content: 'Msg3',
        channel: 'web_chat',
        traceId: 't3',
      });

      expect(await store.getMessageCount(sessionId)).toBe(3);

      const deleted = await store.deleteBySession(sessionId);
      expect(deleted).toBe(3);
      expect(await store.getMessageCount(sessionId)).toBe(0);
    });

    test('role filtering', async () => {
      if (skipIfNoMongo()) return;
      const store = new MongoMessageStore({ type: 'mongodb' });
      const sessionId = await createTestSession('tenant-m6', 'proj-m6');

      await store.addMessage({
        sessionId,
        role: 'system',
        content: 'System prompt',
        channel: 'web_chat',
        traceId: 't1',
      });
      await store.addMessage({
        sessionId,
        role: 'user',
        content: 'User msg 1',
        channel: 'web_chat',
        traceId: 't2',
      });
      await store.addMessage({
        sessionId,
        role: 'assistant',
        content: 'Asst msg 1',
        channel: 'web_chat',
        traceId: 't3',
      });
      await store.addMessage({
        sessionId,
        role: 'tool',
        content: '{"result": "ok"}',
        channel: 'web_chat',
        traceId: 't4',
      });
      await store.addMessage({
        sessionId,
        role: 'user',
        content: 'User msg 2',
        channel: 'web_chat',
        traceId: 't5',
      });
      await store.addMessage({
        sessionId,
        role: 'assistant',
        content: 'Asst msg 2',
        channel: 'web_chat',
        traceId: 't6',
      });

      // Filter: user messages only
      const userMsgs = await store.getMessages({
        sessionId,
        tenantId: 'tenant-m6',
        roles: ['user'],
        includeSystem: true,
      });
      expect(userMsgs).toHaveLength(2);
      expect(userMsgs.every((m) => m.role === 'user')).toBe(true);

      // Filter: assistant messages only
      const asstMsgs = await store.getMessages({
        sessionId,
        tenantId: 'tenant-m6',
        roles: ['assistant'],
        includeSystem: true,
      });
      expect(asstMsgs).toHaveLength(2);
      expect(asstMsgs.every((m) => m.role === 'assistant')).toBe(true);

      // Filter: tool messages only
      const toolMsgs = await store.getMessages({
        sessionId,
        tenantId: 'tenant-m6',
        roles: ['tool'],
        includeSystem: true,
      });
      expect(toolMsgs).toHaveLength(1);
      expect(toolMsgs[0].role).toBe('tool');
      expect(toolMsgs[0].content).toBe('{"result": "ok"}');

      // Filter: user + assistant (no system, no tool)
      const userAndAsst = await store.getMessages({
        sessionId,
        tenantId: 'tenant-m6',
        roles: ['user', 'assistant'],
      });
      expect(userAndAsst).toHaveLength(4);
      expect(userAndAsst.every((m) => m.role === 'user' || m.role === 'assistant')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // End-to-end: Session + Messages
  // ---------------------------------------------------------------------------

  describe('End-to-end: Session + Messages', () => {
    test('full conversation lifecycle', async () => {
      if (skipIfNoMongo()) return;
      const convStore = new MongoConversationStore({ type: 'mongodb' });
      const msgStore = new MongoMessageStore({ type: 'mongodb' });

      // 1. Create session
      const session = await convStore.createSession({
        tenantId: 'tenant-e2e-1',
        projectId: 'proj-e2e-1',
        channel: 'web_chat',
        environment: 'dev',
        agentName: 'hotel_agent',
        agentVersion: '1.0.0',
        customerId: 'cust-e2e-1',
      });
      expect(session.status).toBe('active');

      // 2. Multi-turn conversation
      await msgStore.addMessage({
        sessionId: session.id,
        role: 'system',
        content: 'You are a hotel booking agent.',
        channel: 'web_chat',
        traceId: 'trace-e2e-sys',
      });
      await msgStore.addMessage({
        sessionId: session.id,
        role: 'user',
        content: 'I want to book a hotel in Paris',
        channel: 'web_chat',
        traceId: 'trace-e2e-u1',
      });
      await msgStore.addMessage({
        sessionId: session.id,
        role: 'assistant',
        content: 'What are your check-in dates?',
        channel: 'web_chat',
        traceId: 'trace-e2e-a1',
      });
      await msgStore.addMessage({
        sessionId: session.id,
        role: 'user',
        content: 'June 15 to June 18',
        channel: 'web_chat',
        traceId: 'trace-e2e-u2',
      });
      await msgStore.addMessage({
        sessionId: session.id,
        role: 'tool',
        content: '{"available": true, "price": 250}',
        channel: 'web_chat',
        traceId: 'trace-e2e-t1',
      });
      await msgStore.addMessage({
        sessionId: session.id,
        role: 'assistant',
        content: 'I found a room for $250/night. Shall I book it?',
        channel: 'web_chat',
        traceId: 'trace-e2e-a2',
      });
      await msgStore.addMessage({
        sessionId: session.id,
        role: 'user',
        content: 'Yes please!',
        channel: 'web_chat',
        traceId: 'trace-e2e-u3',
      });
      await msgStore.addMessage({
        sessionId: session.id,
        role: 'assistant',
        content: 'Booked! Confirmation #HT-12345.',
        channel: 'web_chat',
        traceId: 'trace-e2e-a3',
      });

      await withTestTenant('tenant-e2e-1', async () => {
        // 3. Update session context
        await convStore.updateSession(session.id, {
          context: { destination: 'Paris', confirmationNumber: 'HT-12345' },
        });

        // 4. End session
        const ended = await convStore.endSession(session.id, 'completed');
        expect(ended.status).toBe('ended');
        expect(ended.disposition).toBe('completed');

        // 5. Verify messages persisted
        const allMsgs = await msgStore.getMessages({
          sessionId: session.id,
          tenantId: 'tenant-e2e-1',
          includeSystem: true,
        });
        expect(allMsgs).toHaveLength(8);

        const userMsgs = await msgStore.getMessages({
          sessionId: session.id,
          tenantId: 'tenant-e2e-1',
          roles: ['user'],
        });
        expect(userMsgs).toHaveLength(3);

        expect(await msgStore.getMessageCount(session.id)).toBe(8);

        // 6. Verify session final state
        const finalSession = await convStore.getSession(session.id);
        expect(finalSession!.status).toBe('ended');
        expect(finalSession!.context).toEqual({
          destination: 'Paris',
          confirmationNumber: 'HT-12345',
        });
      });
    });

    test('escalation persists', async () => {
      if (skipIfNoMongo()) return;
      const convStore = new MongoConversationStore({ type: 'mongodb' });
      const msgStore = new MongoMessageStore({ type: 'mongodb' });

      // 1. Create session
      const session = await convStore.createSession({
        tenantId: 'tenant-esc-1',
        projectId: 'proj-esc-1',
        channel: 'web_chat',
        environment: 'dev',
        agentName: 'support_agent',
        agentVersion: '1.0.0',
        customerId: 'cust-esc-1',
      });

      // 2. Conversation leading to escalation
      await msgStore.addMessage({
        sessionId: session.id,
        role: 'user',
        content: 'I want to speak to a human',
        channel: 'web_chat',
        traceId: 'trace-esc-u1',
      });
      await msgStore.addMessage({
        sessionId: session.id,
        role: 'assistant',
        content: 'Let me transfer you to a human agent.',
        channel: 'web_chat',
        traceId: 'trace-esc-a1',
      });

      await withTestTenant('tenant-esc-1', async () => {
        // 3. End session as transferred (escalation)
        const ended = await convStore.endSession(session.id, 'transferred');
        expect(ended.status).toBe('ended');
        expect(ended.disposition).toBe('transferred');
        expect(ended.endedAt).toBeInstanceOf(Date);

        // 4. Verify persistence
        const reloaded = await convStore.getSession(session.id);
        expect(reloaded!.status).toBe('ended');
        expect(reloaded!.disposition).toBe('transferred');

        const msgs = await msgStore.getMessages({
          sessionId: session.id,
          tenantId: 'tenant-esc-1',
        });
        expect(msgs).toHaveLength(2);
        expect(msgs[0].content).toBe('I want to speak to a human');
        expect(msgs[1].content).toBe('Let me transfer you to a human agent.');
      });
    });

    test('messages retrievable after session ends', async () => {
      if (skipIfNoMongo()) return;
      const convStore = new MongoConversationStore({ type: 'mongodb' });
      const msgStore = new MongoMessageStore({ type: 'mongodb' });

      // 1. Create session and add messages
      const session = await convStore.createSession({
        tenantId: 'tenant-ret-1',
        projectId: 'proj-ret-1',
        channel: 'web_chat',
        environment: 'dev',
        agentName: 'faq_agent',
        agentVersion: '1.0.0',
      });

      await msgStore.addMessage({
        sessionId: session.id,
        role: 'user',
        content: 'What are your hours?',
        channel: 'web_chat',
        traceId: 'trace-ret-u1',
      });
      await msgStore.addMessage({
        sessionId: session.id,
        role: 'assistant',
        content: 'We are open 9am-5pm.',
        channel: 'web_chat',
        traceId: 'trace-ret-a1',
      });
      await msgStore.addMessage({
        sessionId: session.id,
        role: 'user',
        content: 'Thanks!',
        channel: 'web_chat',
        traceId: 'trace-ret-u2',
      });
      await msgStore.addMessage({
        sessionId: session.id,
        role: 'assistant',
        content: 'You are welcome!',
        channel: 'web_chat',
        traceId: 'trace-ret-a2',
      });

      await withTestTenant('tenant-ret-1', async () => {
        // 2. End session
        await convStore.endSession(session.id, 'completed');

        // 3. Verify session is ended
        const ended = await convStore.getSession(session.id);
        expect(ended!.status).toBe('ended');

        // 4. Messages are still fully retrievable after session ends
        const msgs = await msgStore.getMessages({
          sessionId: session.id,
          tenantId: 'tenant-ret-1',
        });
        expect(msgs).toHaveLength(4);
        expect(msgs[0].content).toBe('What are your hours?');
        expect(msgs[1].content).toBe('We are open 9am-5pm.');
        expect(msgs[2].content).toBe('Thanks!');
        expect(msgs[3].content).toBe('You are welcome!');

        // 5. Count is accurate
        expect(await msgStore.getMessageCount(session.id)).toBe(4);

        // 6. Role filtering still works on ended sessions
        const userOnly = await msgStore.getMessages({
          sessionId: session.id,
          tenantId: 'tenant-ret-1',
          roles: ['user'],
        });
        expect(userOnly).toHaveLength(2);
        expect(userOnly.every((m) => m.role === 'user')).toBe(true);
      });
    });
  });
});

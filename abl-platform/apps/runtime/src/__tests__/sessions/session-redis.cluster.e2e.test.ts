/**
 * E2E-1 — Full Session Lifecycle Against Redis Cluster
 *
 * Exercises `RedisSessionStore` end-to-end against a real Redis Cluster
 * (3 masters, 3 replicas). Mirrors the full lifecycle tested by the
 * standalone `session-redis.e2e.test.ts` suite but proves cluster-mode
 * correctness:
 *
 *   - create() distributes keys across cluster slots correctly
 *   - load() resolves tenantId via the reverse-lookup path (GAP-003 covered)
 *   - save() Lua script (single-key) works in cluster mode
 *   - appendMessages() / getConversationHistory() — LIST ops on cluster
 *   - acquireLock() / releaseLock() — NX-based mutex on cluster
 *   - setAgentRegistry() / getAgentRegistry() — HASH ops on cluster
 *   - delete() — cross-slot key deletions via individual DELs (not pipeline)
 *
 * Picked up by `pnpm test:cluster` via `vitest.cluster.config.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ClusterTestHarness } from '../../../../../tools/cluster-test-harness.js';
import { createRedisConnection, type RedisConnectionHandle } from '@agent-platform/redis';
import { RedisSessionStore } from '../../services/session/redis-session-store.js';
import type { SessionData } from '../../services/session/types.js';

const harness = new ClusterTestHarness();
let handle: RedisConnectionHandle;

beforeAll(async () => {
  await harness.boot();
  handle = createRedisConnection({
    cluster: true,
    url: harness.getUrl(),
    lazyConnect: false,
  });
  for (let i = 0; i < 60; i++) {
    if (handle.isReady()) break;
    await new Promise((r) => setTimeout(r, 250));
  }
}, 60_000);

beforeEach(async () => {
  await harness.flushAllMasters();
});

afterAll(async () => {
  await handle.disconnect();
}, 30_000);

let seq = 0;
function uid(prefix = 'sess'): string {
  return `${prefix}-${Date.now()}-${++seq}`;
}

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  const id = uid();
  return {
    id,
    agentName: 'test-agent',
    irSourceHash: 'ir-hash',
    compilationHash: 'comp-hash',
    conversationHistory: [],
    state: {
      gatherProgress: {},
      conversationPhase: 'start',
      context: {},
    } as any,
    version: 0,
    isComplete: false,
    isEscalated: false,
    handoffStack: ['test-agent'],
    delegateStack: [],
    dataValues: {},
    dataGatheredKeys: [],
    tenantId: 'tenant-e2e',
    projectId: 'proj-e2e',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as unknown as SessionData;
}

function makeStore(opts?: { lockOwner?: string; sessionTtlMinutes?: number }): RedisSessionStore {
  return new RedisSessionStore(handle.client, {
    sessionTtlMinutes: opts?.sessionTtlMinutes ?? 5,
    lockOwner: opts?.lockOwner ?? `pod-e2e-${uid()}`,
  });
}

// ---------------------------------------------------------------------------
// Core CRUD
// ---------------------------------------------------------------------------

describe('E2E-1 · RedisSessionStore full lifecycle on cluster', () => {
  describe('create and load', () => {
    it('create() + load() round-trips a session', async () => {
      const store = makeStore();
      const session = makeSession();

      await store.create(session);
      const loaded = await store.load(session.id);

      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(session.id);
      expect(loaded!.tenantId).toBe('tenant-e2e');
      expect(loaded!.agentName).toBe('test-agent');
      expect(loaded!.version).toBe(0);
      expect(loaded!.isComplete).toBe(false);
    }, 30_000);

    it('load() returns null for a session that was never created', async () => {
      const store = makeStore();
      const result = await store.load('nonexistent-session-id');
      expect(result).toBeNull();
    }, 30_000);

    it('preserves complex JSON fields (state, dataValues, handoffStack)', async () => {
      const store = makeStore();
      const session = makeSession({
        state: {
          gatherProgress: { dest: 'Paris', nights: 3 },
          conversationPhase: 'gathering',
          context: { intent: 'hotel' },
        } as any,
        dataValues: { destination: 'Paris', budget: 1000 },
        handoffStack: ['supervisor', 'booking'],
        waitingForInput: ['checkIn', 'checkOut'],
      });

      await store.create(session);
      const loaded = await store.load(session.id);

      expect(loaded!.state.gatherProgress).toEqual({ dest: 'Paris', nights: 3 });
      expect(loaded!.dataValues).toEqual({ destination: 'Paris', budget: 1000 });
      expect(loaded!.handoffStack).toEqual(['supervisor', 'booking']);
      expect(loaded!.waitingForInput).toEqual(['checkIn', 'checkOut']);
    }, 30_000);

    it('preserves boolean fields (isComplete, isEscalated)', async () => {
      const store = makeStore();
      const session = makeSession({
        isComplete: true,
        isEscalated: true,
        escalationReason: 'user requested human',
      });

      await store.create(session);
      const loaded = await store.load(session.id);

      expect(loaded!.isComplete).toBe(true);
      expect(loaded!.isEscalated).toBe(true);
      expect(loaded!.escalationReason).toBe('user requested human');
    }, 30_000);
  });

  // ---------------------------------------------------------------------------
  // Optimistic concurrency (Lua save)
  // ---------------------------------------------------------------------------

  describe('optimistic concurrency (save)', () => {
    it('save() with correct version increments and returns true', async () => {
      const store = makeStore();
      const session = makeSession();
      await store.create(session); // version=0 in Redis

      const updated = { ...session, agentName: 'updated-agent', version: 1 };
      const ok = await store.save(updated);

      expect(ok).toBe(true);
      const loaded = await store.load(session.id);
      expect(loaded!.agentName).toBe('updated-agent');
      expect(loaded!.version).toBe(1);
    }, 30_000);

    it('save() with stale version returns false (no overwrite)', async () => {
      const store = makeStore();
      const session = makeSession();
      await store.create(session);

      // First save succeeds (expected=0, bumped to 1).
      await store.save({ ...session, agentName: 'v1', version: 1 });

      // Stale save: expected=0 but current=1 → conflict.
      const staleOk = await store.save({ ...session, agentName: 'stale', version: 1 });
      expect(staleOk).toBe(false);

      // Original (post-first-save) state preserved.
      const loaded = await store.load(session.id);
      expect(loaded!.agentName).toBe('v1');
    }, 30_000);

    it('concurrent saves from two pods: exactly one wins', async () => {
      const s1 = makeStore({ lockOwner: 'pod-A' });
      const s2 = makeStore({ lockOwner: 'pod-B' });

      const session = makeSession();
      await s1.create(session);

      const [ok1, ok2] = await Promise.all([
        s1.save({ ...session, agentName: 'pod-A-update', version: 1 }),
        s2.save({ ...session, agentName: 'pod-B-update', version: 1 }),
      ]);

      expect(ok1 !== ok2).toBe(true);
    }, 30_000);
  });

  // ---------------------------------------------------------------------------
  // Conversation history
  // ---------------------------------------------------------------------------

  describe('conversation history', () => {
    it('appendMessages() + getConversationHistory() round-trips messages', async () => {
      const store = makeStore();
      const session = makeSession();
      await store.create(session);

      await store.appendMessages(session.id, [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Book a hotel in Paris.' },
        { role: 'assistant', content: 'When do you want to arrive?' },
      ]);

      const history = await store.getConversationHistory(session.id);
      expect(history).toHaveLength(3);
      expect(history[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' });
      expect(history[1].role).toBe('user');
      expect(history[2].role).toBe('assistant');
    }, 30_000);

    it('multi-turn conversation appends accumulate in order', async () => {
      const store = makeStore();
      const session = makeSession();
      await store.create(session);

      await store.appendMessages(session.id, [
        { role: 'user', content: 'Turn 1' },
        { role: 'assistant', content: 'Reply 1' },
      ]);
      await store.appendMessages(session.id, [
        { role: 'user', content: 'Turn 2' },
        { role: 'assistant', content: 'Reply 2' },
      ]);
      await store.appendMessages(session.id, [
        { role: 'user', content: 'Turn 3' },
        { role: 'assistant', content: 'Reply 3' },
      ]);

      const history = await store.getConversationHistory(session.id);
      expect(history).toHaveLength(6);
      expect(history[0].content).toBe('Turn 1');
      expect(history[5].content).toBe('Reply 3');
    }, 30_000);

    it('getConversationHistory(limit) preserves first message', async () => {
      const store = makeStore();
      const session = makeSession();
      await store.create(session);

      const msgs: Array<{ role: string; content: string }> = [
        { role: 'system', content: 'System prompt' },
      ];
      for (let i = 0; i < 10; i++) {
        msgs.push({ role: 'user', content: `Q${i}` }, { role: 'assistant', content: `A${i}` });
      }
      await store.appendMessages(session.id, msgs);

      const limited = await store.getConversationHistory(session.id, 5);
      expect(limited).toHaveLength(5);
      expect(limited[0].content).toBe('System prompt');
    }, 30_000);
  });

  // ---------------------------------------------------------------------------
  // Execution lock
  // ---------------------------------------------------------------------------

  describe('execution lock (NX mutex)', () => {
    it('acquireLock() returns true on first call, false on second', async () => {
      const store = makeStore({ lockOwner: 'pod-lock-test' });
      const session = makeSession();
      await store.create(session);

      expect(await store.acquireLock(session.id, 5_000)).toBe(true);
      expect(await store.acquireLock(session.id, 5_000)).toBe(false);
    }, 30_000);

    it('releaseLock() allows re-acquire by same owner', async () => {
      const store = makeStore({ lockOwner: 'pod-reacquire' });
      const session = makeSession();
      await store.create(session);

      expect(await store.acquireLock(session.id, 5_000)).toBe(true);
      await store.releaseLock(session.id);
      expect(await store.acquireLock(session.id, 5_000)).toBe(true);
      await store.releaseLock(session.id);
    }, 30_000);

    it('CAS: different owner cannot steal a held lock', async () => {
      const storeA = makeStore({ lockOwner: 'pod-A' });
      const storeB = makeStore({ lockOwner: 'pod-B' });
      const session = makeSession();
      await storeA.create(session);

      expect(await storeA.acquireLock(session.id, 10_000)).toBe(true);
      await storeB.releaseLock(session.id); // pod-B tries to release — must be no-op

      // Lock is still held by A.
      expect(await storeB.acquireLock(session.id, 10_000)).toBe(false);

      // A releases; B can now acquire.
      await storeA.releaseLock(session.id);
      expect(await storeB.acquireLock(session.id, 10_000)).toBe(true);
      await storeB.releaseLock(session.id);
    }, 30_000);

    it('lock expires after TTL', async () => {
      const store = makeStore({ lockOwner: 'pod-ttl' });
      const session = makeSession();
      await store.create(session);

      expect(await store.acquireLock(session.id, 200)).toBe(true);
      await new Promise((r) => setTimeout(r, 400));
      expect(await store.acquireLock(session.id, 5_000)).toBe(true);
      await store.releaseLock(session.id);
    }, 30_000);
  });

  // ---------------------------------------------------------------------------
  // Agent registry
  // ---------------------------------------------------------------------------

  describe('agent registry', () => {
    it('setAgentRegistry() + getAgentRegistry() round-trips', async () => {
      const store = makeStore();
      const session = makeSession();
      await store.create(session);

      await store.setAgentRegistry(session.id, { supervisor: 'h1', booking: 'h2', faq: 'h3' });
      const registry = await store.getAgentRegistry(session.id);

      expect(registry).toEqual({ supervisor: 'h1', booking: 'h2', faq: 'h3' });
    }, 30_000);

    it('getAgentRegistry() returns null for session with no registry', async () => {
      const store = makeStore();
      const session = makeSession();
      await store.create(session);

      const registry = await store.getAgentRegistry(session.id);
      expect(registry).toBeNull();
    }, 30_000);
  });

  // ---------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------

  describe('delete', () => {
    it('delete() removes session and all associated keys', async () => {
      const store = makeStore();
      const session = makeSession();
      await store.create(session);
      await store.appendMessages(session.id, [{ role: 'user', content: 'hi' }]);
      await store.setAgentRegistry(session.id, { a: 'h1' });

      await store.delete(session.id);

      expect(await store.load(session.id)).toBeNull();
      expect(await store.getConversationHistory(session.id)).toEqual([]);
      expect(await store.getAgentRegistry(session.id)).toBeNull();
    }, 30_000);
  });

  // ---------------------------------------------------------------------------
  // Multi-tenant isolation
  // ---------------------------------------------------------------------------

  describe('multi-tenant isolation', () => {
    it('sessions across different tenants are independently loadable', async () => {
      const storeA = makeStore({ lockOwner: 'pod-ta' });
      const storeB = makeStore({ lockOwner: 'pod-tb' });

      // Session IDs are globally unique (UUIDs in practice) — different tenants
      // get different IDs. The reverse-lookup key `sess-tid:{id}` is per session ID,
      // not tenant-scoped, so same-ID multi-tenant is not a supported use case.
      const sessionA = makeSession({ tenantId: 'tenant-alpha', agentName: 'alpha-agent' });
      const sessionB = makeSession({ tenantId: 'tenant-beta', agentName: 'beta-agent' });

      await storeA.create(sessionA);
      await storeB.create(sessionB);

      const loadedA = await storeA.load(sessionA.id);
      const loadedB = await storeB.load(sessionB.id);

      expect(loadedA).not.toBeNull();
      expect(loadedB).not.toBeNull();
      expect(loadedA!.tenantId).toBe('tenant-alpha');
      expect(loadedB!.tenantId).toBe('tenant-beta');
      expect(loadedA!.agentName).toBe('alpha-agent');
      expect(loadedB!.agentName).toBe('beta-agent');
    }, 30_000);

    it('50 concurrent sessions across 5 tenants all load with correct tenantId', async () => {
      const store = makeStore({ lockOwner: 'pod-multi' });
      const tenants = ['t-1', 't-2', 't-3', 't-4', 't-5'];

      const sessions = tenants.flatMap((tenantId) =>
        Array.from({ length: 10 }, () => makeSession({ tenantId })),
      );

      await Promise.all(sessions.map((s) => store.create(s)));
      const loaded = await Promise.all(sessions.map((s) => store.load(s.id)));

      const nullCount = loaded.filter((l) => l === null).length;
      const wrongTenant = loaded.filter(
        (l, i) => l !== null && l.tenantId !== sessions[i].tenantId,
      ).length;

      expect(nullCount).toBe(0);
      expect(wrongTenant).toBe(0);
    }, 60_000);
  });
});

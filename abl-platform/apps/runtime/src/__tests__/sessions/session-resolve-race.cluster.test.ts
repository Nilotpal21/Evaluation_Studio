/**
 * INT-11 — Session-Store Pipeline Race: resolveTenantId Tight Loop (GAP-003)
 *
 * Verifies that the GAP-003 retry-on-miss mitigates the race where
 * `sess-tid:{id}` (reverse-lookup STRING) and `sess:{tid}:{id}` (session HASH)
 * land on different cluster slots. Without the 50ms retry, pipelined writes
 * can make the lookup key visible fractionally after the session hash, causing
 * `store.load()` to return null for a session that was just created.
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
function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  const id = `race-${Date.now()}-${++seq}`;
  return {
    id,
    agentName: 'race-agent',
    irSourceHash: 'ir-hash',
    compilationHash: 'comp-hash',
    conversationHistory: [],
    state: { currentAgent: 'race-agent', interrupted: false } as any,
    version: 1,
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    delegateStack: [],
    dataValues: {},
    dataGatheredKeys: [],
    tenantId: 'tenant-race',
    projectId: 'proj-race',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as unknown as SessionData;
}

// ---------------------------------------------------------------------------
// INT-11: GAP-003 — tight-loop create → load
// ---------------------------------------------------------------------------

describe('INT-11 · session-resolve race (GAP-003 regression guard)', () => {
  it('1000 tight-loop iterations: create then immediately load never returns null', async () => {
    const store = new RedisSessionStore(handle.client, {
      sessionTtlMinutes: 5,
      lockOwner: 'pod-race',
    });

    const nulls: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const session = makeSession({ id: `race-tight-${i}` });
      await store.create(session);
      const loaded = await store.load(session.id);
      if (loaded === null) {
        nulls.push(i);
      }
    }

    expect(nulls).toHaveLength(0);
  }, 120_000);

  it('with setTimeout(0) jitter: create → yield → load never returns null', async () => {
    const store = new RedisSessionStore(handle.client, {
      sessionTtlMinutes: 5,
      lockOwner: 'pod-jitter',
    });

    const nulls: number[] = [];
    for (let i = 0; i < 500; i++) {
      const session = makeSession({ id: `race-jitter-${i}` });
      await store.create(session);
      // Micro-jitter widens the race window — the retry-on-miss must cover it.
      await new Promise((r) => setTimeout(r, 0));
      const loaded = await store.load(session.id);
      if (loaded === null) {
        nulls.push(i);
      }
    }

    expect(nulls).toHaveLength(0);
  }, 120_000);

  it('loaded session has correct tenantId after create (resolveTenantId maps correctly)', async () => {
    const store = new RedisSessionStore(handle.client, {
      sessionTtlMinutes: 5,
      lockOwner: 'pod-tid',
    });

    const session = makeSession({ tenantId: 'tenant-specific-123' });
    await store.create(session);
    const loaded = await store.load(session.id);

    expect(loaded).not.toBeNull();
    expect(loaded?.tenantId).toBe('tenant-specific-123');
    expect(loaded?.id).toBe(session.id);
  }, 30_000);

  it('concurrent creates across different tenants all resolve correctly', async () => {
    const store = new RedisSessionStore(handle.client, {
      sessionTtlMinutes: 5,
      lockOwner: 'pod-concurrent',
    });

    const tenants = ['tenant-alpha', 'tenant-beta', 'tenant-gamma'];
    const sessions = tenants.flatMap((tenantId) =>
      Array.from({ length: 50 }, (_, i) =>
        makeSession({ id: `concurrent-${tenantId}-${i}`, tenantId }),
      ),
    );

    // Create all sessions concurrently.
    await Promise.all(sessions.map((s) => store.create(s)));

    // Load all concurrently — each must resolve to the correct tenant.
    const results = await Promise.all(sessions.map((s) => store.load(s.id)));
    const nullCount = results.filter((r) => r === null).length;
    const wrongTenantCount = results.filter(
      (r, i) => r !== null && r.tenantId !== sessions[i].tenantId,
    ).length;

    expect(nullCount).toBe(0);
    expect(wrongTenantCount).toBe(0);
  }, 60_000);
});

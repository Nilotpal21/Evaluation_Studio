/**
 * Runtime cluster-wiring smoke test (E2E concerns 1 + 2).
 *
 * Boots the Runtime's actual Redis stack (RedisSessionStore +
 * createSubscriber + createBullMQPair + scanKeys) against the live cluster
 * harness. Validates that the application's adoption of @agent-platform/redis
 * works end-to-end in cluster mode — not just the redis package's own tests.
 *
 * Why this matters: the redis-package cluster tests prove the abstraction.
 * This test proves the runtime actually uses it correctly. A bug like
 * "RedisSessionStore.create() pipelines cross-slot keys" surfaces here, not
 * in the package tests.
 *
 * Picked up by `pnpm test:cluster` via `vitest.cluster.config.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ClusterTestHarness } from '../../../../tools/cluster-test-harness.js';
import {
  createBullMQPair,
  createRedisConnection,
  createSubscriber,
  scanKeys,
  type RedisConnectionHandle,
} from '@agent-platform/redis';
import { RedisSessionStore } from '../services/session/redis-session-store.js';
import type { SessionData, SessionState } from '../services/session/types.js';

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

function makeSessionState(): SessionState {
  return {
    currentAgent: 'main',
    branchId: 'test-branch',
    fanOutBarriers: {},
    pendingFanOuts: {},
    completedBranches: {},
    pendingApprovals: {},
    interrupted: false,
    parentBranches: {},
  } as unknown as SessionState;
}

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: `sess-${Math.random().toString(36).slice(2, 10)}`,
    agentName: 'test-agent',
    irSourceHash: 'ir-hash',
    compilationHash: 'comp-hash',
    conversationHistory: [],
    state: makeSessionState(),
    version: 1,
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    delegateStack: [],
    dataValues: {},
    dataGatheredKeys: [],
    tenantId: 'tenant-wire-test',
    projectId: 'proj-1',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as unknown as SessionData;
}

// ---------------------------------------------------------------------------
// 1. RedisSessionStore — runtime's primary Redis consumer
// ---------------------------------------------------------------------------

describe('runtime wiring · RedisSessionStore against cluster', () => {
  it('create() + load() round-trips a session through the cluster', async () => {
    const store = new RedisSessionStore(handle.client);
    const session = makeSession();

    await store.create(session);

    const loaded = await store.load(session.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe(session.id);
    expect(loaded?.tenantId).toBe(session.tenantId);
  }, 30_000);

  it('resolveTenantId works after create (GAP-003 retry-on-miss covers cluster race)', async () => {
    const store = new RedisSessionStore(handle.client);
    // Tight loop: create → load 50 times. With the GAP-003 retry-on-miss in
    // place, every load must succeed (the reverse-lookup key may be on a
    // different slot from the session hash).
    for (let i = 0; i < 50; i++) {
      const session = makeSession({ id: `tight-${i}` });
      await store.create(session);
      const loaded = await store.load(session.id);
      expect(loaded?.id).toBe(session.id);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 2. Pub/Sub via createSubscriber — separate connection, must auto-resubscribe
// ---------------------------------------------------------------------------

describe('runtime wiring · createSubscriber against cluster', () => {
  it('subscribes to a channel and receives messages published from another connection', async () => {
    const subscriber = createSubscriber(handle);
    // Cluster subscribers have `enableOfflineQueue: false` (intentional —
    // avoids racing the auto-resubscribe path on reconnect). The newly
    // created Cluster client starts connecting eagerly but isn't `ready`
    // yet (slot map populated). Wait for that before any subscribe call.
    if (subscriber.status !== 'ready') {
      await new Promise<void>((resolve, reject) => {
        const onReady = () => {
          subscriber.off('error', onError);
          resolve();
        };
        const onError = (err: Error) => {
          subscriber.off('ready', onReady);
          reject(err);
        };
        subscriber.once('ready', onReady);
        subscriber.once('error', onError);
      });
    }

    const channel = `wire-test:${Math.random().toString(36).slice(2, 10)}`;
    const received: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Subscriber did not receive message in 5s')),
        5_000,
      );

      subscriber.on('message', (ch: string, msg: string) => {
        if (ch === channel) {
          received.push(msg);
          if (received.length === 3) {
            clearTimeout(timeout);
            resolve();
          }
        }
      });

      subscriber.subscribe(channel, (err) => {
        if (err) {
          clearTimeout(timeout);
          reject(err);
          return;
        }
        // Publish via the main handle (a separate connection).
        Promise.all([
          handle.client.publish(channel, 'msg-1'),
          handle.client.publish(channel, 'msg-2'),
          handle.client.publish(channel, 'msg-3'),
        ]).catch((pubErr) => {
          clearTimeout(timeout);
          reject(pubErr);
        });
      });
    });

    expect(received.sort()).toEqual(['msg-1', 'msg-2', 'msg-3']);
    subscriber.disconnect();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 3. BullMQ pair — Queue + Worker connections, cluster-aware
// ---------------------------------------------------------------------------

describe('runtime wiring · createBullMQPair against cluster', () => {
  it('produces queue + worker connections that can SET / GET (basic liveness)', async () => {
    const pair = createBullMQPair(handle);
    try {
      // Sanity: both connections accept commands. We don't boot a real BullMQ
      // queue here (BullMQ has its own slot quirks); just prove the
      // connections survive the cluster path.
      const tag = `bullmq-wire:{${Math.random().toString(36).slice(2, 8)}}`;
      await pair.queueConnection.set(`${tag}:q`, 'queue-side', 'EX', 60);
      await pair.workerConnection.set(`${tag}:w`, 'worker-side', 'EX', 60);

      const queueValue = await handle.client.get(`${tag}:q`);
      const workerValue = await handle.client.get(`${tag}:w`);
      expect(queueValue).toBe('queue-side');
      expect(workerValue).toBe('worker-side');
    } finally {
      pair.disconnect();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 4. scanKeys — runtime uses this for cache invalidation paths (Phase 1)
// ---------------------------------------------------------------------------

describe('runtime wiring · scanKeys against cluster', () => {
  it('iterates keys distributed across all masters (cache-invalidation path)', async () => {
    // Mirrors the shape used by AnalyticsCache, DefinitionCache, etc.
    await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        handle.client.set(`runtime-wire-cache:${i}`, '1', 'EX', 60),
      ),
    );

    const observed = new Set<string>();
    for await (const k of scanKeys(handle.client, 'runtime-wire-cache:*', 100)) {
      observed.add(k);
    }
    expect(observed.size).toBe(200);
  }, 30_000);
});

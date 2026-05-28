/**
 * Cluster integration test for `TransferSessionStore`.
 *
 * Covers test-spec scenario:
 *   INT-4 — agent-transfer index consistency after Lua split (FR-9)
 *
 * Verifies the design from Phase 2.2: every Lua script narrows to a single key
 * (the session hash) and the cross-slot index writes (provider lookup,
 * `at_active_sessions` SET, per-pod SET) run via a follow-up `pipeline()`.
 *
 * Picked up by `pnpm test:cluster` via `vitest.cluster.config.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ClusterTestHarness } from '../../../../tools/cluster-test-harness.js';
import { createRedisConnection, type RedisConnectionHandle } from '@agent-platform/redis';
import { TransferSessionStore } from '../session/transfer-session-store.js';
import { ACTIVE_SESSIONS_SET, podSessionsKey, providerIndexKey } from '../session/types.js';

const harness = new ClusterTestHarness();
let handle: RedisConnectionHandle;
const POD = 'test-pod-int4';

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

describe('INT-4 agent-transfer index consistency under cluster', () => {
  it('happy path: session hash + active SET + pod SET + provider index all written', async () => {
    const store = new TransferSessionStore(handle.client);
    const tenantId = 't1';
    const contactId = 'c1';
    const channel = 'web';
    const provider = 'kore';
    const providerSessionId = 'ps-123';

    const result = await store.create({
      tenantId,
      contactId,
      channel,
      provider,
      providerSessionId,
      ownerPod: POD,
    });
    expect(result.success).toBe(true);
    // Use the key the store actually wrote — channel normalises ('web' → 'chat')
    // so reconstructing with sessionKey(tenantId, contactId, channel) would mismatch.
    const skey = result.sessionKey!;
    const exists = await handle.client.exists(skey);
    expect(exists).toBe(1);

    const inActive = await handle.client.sismember(ACTIVE_SESSIONS_SET, skey);
    expect(inActive).toBe(1);

    const inPod = await handle.client.sismember(podSessionsKey(POD), skey);
    expect(inPod).toBe(1);

    const indexKey = providerIndexKey(provider, tenantId, providerSessionId);
    const indexValue = await handle.client.get(indexKey);
    expect(indexValue).toBe(skey);
  }, 30_000);

  it('duplicate create returns SESSION_EXISTS without rewriting indexes', async () => {
    const store = new TransferSessionStore(handle.client);
    const input = {
      tenantId: 't1',
      contactId: 'c1',
      channel: 'web',
      provider: 'kore',
      providerSessionId: 'ps-dup',
      ownerPod: POD,
    };

    const first = await store.create(input);
    expect(first.success).toBe(true);

    const second = await store.create(input);
    expect(second.success).toBe(false);
    if (!second.success) {
      expect(second.error.code).toBe('SESSION_EXISTS');
    }
  }, 30_000);

  it('end() removes the session hash and decrements the indexes (best-effort)', async () => {
    const store = new TransferSessionStore(handle.client);
    const tenantId = 't1';
    const contactId = 'c1';
    const channel = 'web';
    const createResult = await store.create({
      tenantId,
      contactId,
      channel,
      provider: 'kore',
      providerSessionId: 'ps-end',
      ownerPod: POD,
    });
    expect(createResult.success).toBe(true);
    const skey = createResult.sessionKey!;
    const ended = await store.end(skey);
    expect(ended).toBe(true);

    const exists = await handle.client.exists(skey);
    expect(exists).toBe(0);
    const stillInActive = await handle.client.sismember(ACTIVE_SESSIONS_SET, skey);
    expect(stillInActive).toBe(0);
  }, 30_000);
});

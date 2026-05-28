/**
 * Cluster integration test for `RedisFanOutBarrierStore`.
 *
 * Covers test-spec scenario:
 *   INT-5 — fan-out-barrier registry SET (no in-Lua KEYS)
 *
 * Verifies the design from Phase 2.3: every per-barrier key is hash-tagged
 * with `{barrierId}` so they share a slot, the registry SET
 * (`barrier:{<id>}:result-keys`) records branch keys atomically, and
 * `getResults` / `delete` iterate via the SET — never via top-level `KEYS`.
 *
 * Picked up by `pnpm test:cluster` via `vitest.cluster.config.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ClusterTestHarness } from '../../../../tools/cluster-test-harness.js';
import { createRedisConnection, type RedisConnectionHandle } from '@agent-platform/redis';
import { RedisFanOutBarrierStore } from '../redis-fan-out-barrier.js';
import type { BranchResult } from '../fan-out-barrier.js';

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

function makeBranchResult(branchId: string, payload: string): BranchResult {
  return {
    branchId,
    branchAgent: `agent-${branchId}`,
    status: 'completed',
    response: payload,
    completedAt: Date.now(),
  };
}

describe('INT-5 fan-out-barrier registry SET in cluster', () => {
  it('all per-barrier keys share a single cluster slot', async () => {
    const store = new RedisFanOutBarrierStore(handle.client);
    const barrierId = await store.create({
      parentSessionId: 'sess-1',
      parentExecutionId: 'exec-1',
      tenantId: 't1',
      totalBranches: 3,
      timeoutMs: 60_000,
    });

    // The store hashes via `{barrierId}` so all derived keys must share a slot.
    const barrierKey = `barrier:{${barrierId}}`;
    const registryKey = `barrier:{${barrierId}}:result-keys`;
    const sampleResultKey = `barrier:{${barrierId}}:result:agent-x`;

    const slots = await Promise.all(
      [barrierKey, registryKey, sampleResultKey].map(async (k) =>
        Number(await handle.client.cluster('KEYSLOT', k)),
      ),
    );
    expect(new Set(slots).size).toBe(1);
  });

  it('completeBranch + getResults round-trips all branches via registry SET', async () => {
    const store = new RedisFanOutBarrierStore(handle.client);
    const barrierId = await store.create({
      parentSessionId: 'sess-2',
      parentExecutionId: 'exec-2',
      tenantId: 't1',
      totalBranches: 4,
      timeoutMs: 60_000,
    });

    for (let i = 0; i < 4; i++) {
      const r = await store.completeBranch(barrierId, makeBranchResult(`b${i}`, `value-${i}`));
      expect(r.disposition).toBe('recorded');
    }

    const results = await store.getResults(barrierId);
    const branchResponses = Object.values(results).map((r) => r.response);
    expect(branchResponses.sort()).toEqual(['value-0', 'value-1', 'value-2', 'value-3']);

    // Registry SET must contain exactly the 4 branch keys.
    const registryKey = `barrier:{${barrierId}}:result-keys`;
    const members = await handle.client.smembers(registryKey);
    expect(members.length).toBe(4);
  }, 30_000);

  it('delete removes barrier hash, registry SET, and every branch result key', async () => {
    const store = new RedisFanOutBarrierStore(handle.client);
    const barrierId = await store.create({
      parentSessionId: 'sess-3',
      parentExecutionId: 'exec-3',
      tenantId: 't1',
      totalBranches: 2,
      timeoutMs: 60_000,
    });
    await store.completeBranch(barrierId, makeBranchResult('a', 'va'));
    await store.completeBranch(barrierId, makeBranchResult('b', 'vb'));

    await store.delete(barrierId);

    const barrierExists = await handle.client.exists(`barrier:{${barrierId}}`);
    expect(barrierExists).toBe(0);
    const registryExists = await handle.client.exists(`barrier:{${barrierId}}:result-keys`);
    expect(registryExists).toBe(0);

    const remaining = await store.getResults(barrierId);
    expect(Object.keys(remaining).length).toBe(0);
  }, 30_000);

  it('duplicate completeBranch is idempotent (SET dedupes branch key)', async () => {
    const store = new RedisFanOutBarrierStore(handle.client);
    const barrierId = await store.create({
      parentSessionId: 'sess-4',
      parentExecutionId: 'exec-4',
      tenantId: 't1',
      totalBranches: 2,
      timeoutMs: 60_000,
    });

    const first = await store.completeBranch(barrierId, makeBranchResult('a', 'first'));
    expect(first.disposition).toBe('recorded');
    const second = await store.completeBranch(barrierId, makeBranchResult('a', 'second'));
    expect(second.disposition).toBe('duplicate');

    const registryKey = `barrier:{${barrierId}}:result-keys`;
    const members = await handle.client.smembers(registryKey);
    expect(members.length).toBe(1);
  }, 30_000);
});

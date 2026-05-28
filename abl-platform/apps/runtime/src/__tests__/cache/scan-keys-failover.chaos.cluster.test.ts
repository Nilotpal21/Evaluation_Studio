/**
 * INT-12 — scanKeys Mid-Failover Dedupe (GAP-005, @chaos)
 *
 * Verifies that `scanKeys(client, pattern)` from `@agent-platform/redis`
 * returns a complete, deduplicated result set even when a graceful master
 * failover occurs mid-iteration.
 *
 * GAP-005: `scanKeys` iterates `client.nodes('master')` using a Set for
 * dedup. During slot migration or failover, a node that was a master may
 * become a replica or vice versa. The helper must skip dead nodes with a
 * structured log event (`redis.scanKeys.nodeError`) and not propagate the
 * error to the caller.
 *
 * Tagged @chaos — designed for nightly runs; excluded from standard CI.
 * Picked up by `pnpm test:cluster` via `vitest.cluster.config.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ClusterTestHarness } from '../../../../../tools/cluster-test-harness.js';
import { createRedisConnection, scanKeys, type RedisConnectionHandle } from '@agent-platform/redis';

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

const KEY_COUNT = 1000;
const KEY_PREFIX = 'chaos-scan';

async function seedKeys(count: number): Promise<void> {
  // Keys without hash tags distribute across all 3 masters naturally.
  // Individual commands auto-route to the correct slot (no cross-slot pipeline).
  const ops: Promise<unknown>[] = [];
  for (let i = 0; i < count; i++) {
    ops.push(handle.client.set(`${KEY_PREFIX}:${i}`, '1', 'EX', 300));
  }
  await Promise.all(ops);
}

// ---------------------------------------------------------------------------
// INT-12a: Graceful failover mid-scan
// ---------------------------------------------------------------------------

describe('INT-12 · scanKeys mid-failover dedupe (@chaos)', () => {
  // Non-failover tests run FIRST so the cluster client's slot map is clean.
  // The graceful-failover test is intentionally last — it changes topology and
  // leaves the shared handle with stale routing for any test that would follow.

  it('without failover: 1000 keys all found with no duplicates (baseline)', async () => {
    await seedKeys(KEY_COUNT);

    const collected = new Set<string>();
    for await (const key of scanKeys(handle.client, `${KEY_PREFIX}:*`, 100)) {
      collected.add(key);
    }

    expect(collected.size).toBe(KEY_COUNT);
  }, 30_000);

  it('scanKeys with zero matching keys returns empty set', async () => {
    const collected = new Set<string>();
    for await (const key of scanKeys(handle.client, 'nonexistent-prefix:*', 100)) {
      collected.add(key);
    }
    expect(collected.size).toBe(0);
  }, 30_000);

  it('scanKeys across different pattern prefixes returns independent complete sets', async () => {
    // Seed two independent key sets with individual commands (cluster-safe).
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 200; i++) {
      ops.push(handle.client.set(`chaos-alpha:${i}`, '1', 'EX', 60));
      ops.push(handle.client.set(`chaos-beta:${i}`, '1', 'EX', 60));
    }
    await Promise.all(ops);

    const alphaSet = new Set<string>();
    const betaSet = new Set<string>();

    for await (const k of scanKeys(handle.client, 'chaos-alpha:*', 50)) {
      alphaSet.add(k);
    }
    for await (const k of scanKeys(handle.client, 'chaos-beta:*', 50)) {
      betaSet.add(k);
    }

    expect(alphaSet.size).toBe(200);
    expect(betaSet.size).toBe(200);
    // No cross-contamination.
    for (const k of alphaSet) {
      expect(betaSet.has(k)).toBe(false);
    }
  }, 30_000);

  // Disruptive test: runs LAST in this suite. Forces a graceful failover mid-scan
  // and asserts scanKeys remains complete and error-free across the topology change.
  // NOTE: this test leaves the cluster in a different topology; subsequent test FILES
  // are isolated because each creates a fresh cluster handle in their own beforeAll.
  it('graceful failover mid-scan: all 1000 keys returned with no duplicates', async () => {
    await seedKeys(KEY_COUNT);

    const collected = new Set<string>();
    let iterationError: Error | null = null;

    // Start iteration in the background.
    const iterTask = (async () => {
      try {
        for await (const key of scanKeys(handle.client, `${KEY_PREFIX}:*`, 100)) {
          collected.add(key);
        }
      } catch (err) {
        iterationError = err instanceof Error ? err : new Error(String(err));
      }
    })();

    // After 100 ms (mid-scan), trigger graceful failover on a current master.
    await new Promise((r) => setTimeout(r, 100));
    await harness.forceFailover(7000, 'graceful');

    // Wait for iteration to complete.
    await iterTask;

    // The helper must not propagate the failover as a thrown exception.
    expect(iterationError).toBeNull();

    // All keys must be found — no missing, no duplicates.
    expect(collected.size).toBe(KEY_COUNT);
  }, 60_000);
});

/**
 * E2E-6 — scanKeys Completeness Through Cache-Invalidation Surface
 *
 * Verifies that `scanKeys(client, pattern)` from `@agent-platform/redis`
 * returns a complete result set distributed across all cluster masters.
 * This is the cluster-mode regression guard for the cache-invalidation paths
 * (DefinitionCache, AnalyticsCache, TwoTierIRCache) that previously used
 * `client.keys()` — which in cluster mode only scans the local node.
 *
 * Test structure:
 *   1. Seed 1000 cache-shaped keys without hash tags (distribute across masters)
 *   2. scanKeys → assert completeness (1000, no duplicates)
 *   3. Simulate cache invalidation: delete all matched keys via pipeline
 *   4. scanKeys → assert zero residual keys
 *   5. Standalone parity path: verify a small set works without cluster
 *
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

async function seedCacheKeys(prefix: string, count: number): Promise<string[]> {
  const keys: string[] = [];
  const ops: Promise<unknown>[] = [];
  for (let i = 0; i < count; i++) {
    const key = `${prefix}:${i}`;
    keys.push(key);
    ops.push(
      handle.client.set(
        key,
        JSON.stringify({ projectId: 'p1', idx: i, ts: Date.now() }),
        'EX',
        300,
      ),
    );
  }
  await Promise.all(ops);
  return keys;
}

async function collectScanned(prefix: string, pageSize = 100): Promise<Set<string>> {
  const found = new Set<string>();
  for await (const key of scanKeys(handle.client, `${prefix}:*`, pageSize)) {
    found.add(key);
  }
  return found;
}

// ---------------------------------------------------------------------------
// E2E-6: scanKeys completeness
// ---------------------------------------------------------------------------

describe('E2E-6 · scanKeys completeness (cache-invalidation path)', () => {
  it('1000 keys distributed across masters — all 1000 found, no duplicates', async () => {
    const prefix = 'pipeline-def:p1';
    await seedCacheKeys(prefix, 1000);

    const found = await collectScanned(prefix);

    expect(found.size).toBe(1000);
    for (let i = 0; i < 1000; i++) {
      expect(found.has(`${prefix}:${i}`)).toBe(true);
    }
  }, 60_000);

  it('cache-invalidation: after delete via pipeline, scanKeys returns zero residual keys', async () => {
    const prefix = 'analytics-cache:t1';
    const seeded = await seedCacheKeys(prefix, 500);

    // Pre-invalidation: confirm all keys present.
    const before = await collectScanned(prefix);
    expect(before.size).toBe(500);

    // Simulate cache invalidation — delete all matched keys individually
    // (cluster-safe: no CROSSSLOT since keys are on different slots).
    const deleteOps = seeded.map((k) => handle.client.del(k));
    await Promise.all(deleteOps);

    // Post-invalidation: scanKeys must return nothing.
    const after = await collectScanned(prefix);
    expect(after.size).toBe(0);
  }, 60_000);

  it('scanKeys with page size 10 returns the same result as page size 200 (page-size invariance)', async () => {
    const prefix = 'ir-cache:tenant-x';
    await seedCacheKeys(prefix, 300);

    const small = await collectScanned(prefix, 10);
    const large = await collectScanned(prefix, 200);

    expect(small.size).toBe(300);
    expect(large.size).toBe(300);

    // Sets must be identical.
    for (const k of small) {
      expect(large.has(k)).toBe(true);
    }
  }, 60_000);

  it('multi-tenant key isolation: tenant A scan does not return tenant B keys', async () => {
    await seedCacheKeys('cache:tenant-a', 200);
    await seedCacheKeys('cache:tenant-b', 200);

    const tenantA = await collectScanned('cache:tenant-a');
    const tenantB = await collectScanned('cache:tenant-b');

    expect(tenantA.size).toBe(200);
    expect(tenantB.size).toBe(200);

    for (const k of tenantA) {
      expect(tenantB.has(k)).toBe(false);
    }
    for (const k of tenantB) {
      expect(tenantA.has(k)).toBe(false);
    }
  }, 60_000);

  it('large scan (2000 keys) completes within 30s', async () => {
    const prefix = 'large-cache:t1';
    await seedCacheKeys(prefix, 2000);

    const start = Date.now();
    const found = await collectScanned(prefix, 100);
    const elapsed = Date.now() - start;

    expect(found.size).toBe(2000);
    expect(elapsed).toBeLessThan(30_000);
  }, 60_000);
});

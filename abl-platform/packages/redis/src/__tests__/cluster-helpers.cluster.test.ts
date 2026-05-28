/**
 * Cluster integration tests for `@agent-platform/redis` helpers.
 *
 * Boots the harness in `docker-compose.cluster.yml` (3 masters + 3 replicas
 * on ports 7000-7005) and exercises the helpers against a real Redis Cluster.
 *
 * Covers test-spec scenarios:
 *   - INT-2  scanKeys completeness + dedupe across masters
 *   - INT-6  resolveRedisOptionsFromEnv reads REDIS_CLUSTER
 *   - INT-7  standalone parity (regression)
 *   - INT-8  CROSSSLOT negative — un-tagged Lua keys are rejected
 *   - INT-9  KEYS partial-result negative — top-level KEYS is unsafe in cluster
 *
 * Picked up by `pnpm test:cluster` via `vitest.cluster.config.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ClusterTestHarness } from '../../../../tools/cluster-test-harness.js';
import {
  createRedisConnection,
  resolveRedisOptionsFromEnv,
  scanKeys,
  hashTag,
  runLuaScript,
  type LuaScript,
  type RedisConnectionHandle,
} from '../index.js';

const harness = new ClusterTestHarness();
let handle: RedisConnectionHandle;

beforeAll(async () => {
  await harness.boot();
  handle = createRedisConnection({
    cluster: true,
    url: harness.getUrl(),
    lazyConnect: false,
  });
  // Wait for the cluster client to be ready before any test runs.
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
  // Leave the cluster up for subsequent suites — `tearDown()` is the script's job.
}, 30_000);

// ---------------------------------------------------------------------------
// INT-2 — scanKeys completeness + dedupe across masters
// ---------------------------------------------------------------------------

describe('INT-2 scanKeys cluster fan-out', () => {
  it('iterates 1000 keys across all masters with no missing or duplicates', async () => {
    const total = 1000;
    // Use unique keys that DON'T share a hash tag so they distribute uniformly.
    // Cluster pipelines require same-slot keys, so issue individual SETs in
    // parallel — ioredis routes each one to the correct master.
    const expected = new Set<string>();
    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < total; i++) {
      const key = `test-scan:${i}`;
      writes.push(handle.client.set(key, '1'));
      expected.add(key);
    }
    await Promise.all(writes);

    const observed = new Set<string>();
    for await (const k of scanKeys(handle.client, 'test-scan:*', 200)) {
      observed.add(k);
    }

    expect(observed.size).toBe(total);
    for (const k of expected) expect(observed.has(k)).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// INT-6 — resolveRedisOptionsFromEnv reads REDIS_CLUSTER
// (env-only test — runs against the real env-var parser; no cluster needed
// for this assertion but the suite is convenient.)
// ---------------------------------------------------------------------------

describe('INT-6 resolveRedisOptionsFromEnv branches on REDIS_CLUSTER', () => {
  it('returns cluster:true when REDIS_CLUSTER=true', () => {
    const opts = resolveRedisOptionsFromEnv({
      REDIS_CLUSTER: 'true',
      REDIS_URL: '127.0.0.1:7000,127.0.0.1:7001',
    });
    expect(opts).not.toBeNull();
    expect(opts!.cluster).toBe(true);
    expect(opts!.url).toContain('127.0.0.1:7000');
  });

  it('returns cluster:false when REDIS_CLUSTER=false', () => {
    const opts = resolveRedisOptionsFromEnv({
      REDIS_CLUSTER: 'false',
      REDIS_HOST: 'localhost',
      REDIS_PORT: '6379',
    });
    expect(opts).not.toBeNull();
    expect(opts!.cluster).toBeFalsy();
  });

  it('defaults to standalone when REDIS_CLUSTER unset', () => {
    const opts = resolveRedisOptionsFromEnv({
      REDIS_HOST: 'localhost',
      REDIS_PORT: '6379',
    });
    expect(opts).not.toBeNull();
    expect(opts!.cluster).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// INT-8 — CROSSSLOT negative test
// ---------------------------------------------------------------------------

describe('INT-8 CROSSSLOT negative test', () => {
  it('rejects un-tagged multi-key Lua with CROSSSLOT', async () => {
    const script: LuaScript = {
      name: 'test_crossslot',
      numberOfKeys: 2,
      body: `redis.call('SET', KEYS[1], '1'); redis.call('SET', KEYS[2], '2'); return 'OK'`,
    };
    // These two keys are deliberately NOT hash-tagged → cluster will hash them
    // to different slots and reject the call.
    await expect(runLuaScript(handle.client, script, ['foo:1', 'bar:2'], [])).rejects.toThrow(
      /CROSSSLOT/i,
    );
  });

  it('accepts hash-tagged multi-key Lua', async () => {
    const script: LuaScript = {
      name: 'test_same_slot',
      numberOfKeys: 2,
      body: `redis.call('SET', KEYS[1], '1'); redis.call('SET', KEYS[2], '2'); return 'OK'`,
    };
    const tag = hashTag('shared');
    await expect(runLuaScript(handle.client, script, [`a:${tag}`, `b:${tag}`], [])).resolves.toBe(
      'OK',
    );
  });
});

// ---------------------------------------------------------------------------
// INT-9 — KEYS partial-result negative test
// ---------------------------------------------------------------------------

describe('INT-9 raw KEYS returns partial results in cluster', () => {
  it("client.keys() against a single master returns only that node's slice", async () => {
    const total = 300;
    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < total; i++) writes.push(handle.client.set(`partial-keys:${i}`, '1'));
    await Promise.all(writes);

    // Hit a single master directly with the raw KEYS command.
    const masters = handle.client.nodes('master');
    expect(masters.length).toBeGreaterThanOrEqual(3);
    const localSlice = await masters[0].keys('partial-keys:*');

    // KEYS only sees keys whose slot is owned by the queried master, so the
    // slice MUST be smaller than the total. (We don't assert a specific
    // fraction because slot ownership varies between cluster runs.)
    expect(localSlice.length).toBeLessThan(total);
    expect(localSlice.length).toBeGreaterThan(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// INT-7 — standalone parity regression
// ---------------------------------------------------------------------------

describe('INT-7 standalone-mode helper parity', () => {
  it('scanKeys against a same-slot key family produces the same result regardless of mode', async () => {
    // Standalone-parity check: when we use a hash-tagged key family that lands
    // on a single slot, scanKeys should still return all of them — the
    // cluster fan-out path collapses to a single master for that slot.
    // (Full standalone-vs-cluster parity is asserted at the unit-test level
    // in helpers.test.ts; here we exercise the cluster path's standalone-like
    // behaviour against a real cluster.)
    const tag = hashTag('parity');
    const keys = [`p:${tag}:1`, `p:${tag}:2`, `p:${tag}:3`];
    await Promise.all(keys.map((k) => handle.client.set(k, '1')));

    const observed = new Set<string>();
    for await (const k of scanKeys(handle.client, `p:${tag}:*`)) {
      observed.add(k);
    }
    expect(observed.size).toBe(3);
    for (const k of keys) expect(observed.has(k)).toBe(true);
  }, 30_000);
});

/**
 * Cluster integration test for `RedisCircuitBreaker`.
 *
 * Covers test-spec scenario:
 *   INT-1 — runLuaScript hash-tag co-location (circuit-breaker)
 *
 * Verifies that all 5 keys for a (level, key) pair share a cluster slot, that
 * Lua execution succeeds without CROSSSLOT, and that breaker state transitions
 * still hit the OPEN threshold under cluster mode.
 *
 * Picked up by `pnpm test:cluster` via `vitest.cluster.config.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ClusterTestHarness } from '../../../../tools/cluster-test-harness.js';
import { createRedisConnection, type RedisConnectionHandle } from '@agent-platform/redis';
import { RedisCircuitBreaker } from '../redis-circuit-breaker.js';
import { breakerKeys } from '../types.js';

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

describe('INT-1 RedisCircuitBreaker hash-tag co-location', () => {
  it('all 5 keys for (level, key) share a single cluster slot', async () => {
    const keys = breakerKeys('tool_service', 'tenant-1');
    // CLUSTER KEYSLOT returns the slot ID (0-16383). All 5 keys must be equal.
    const slots = await Promise.all(
      Object.values(keys).map(async (k) => Number(await handle.client.cluster('KEYSLOT', k))),
    );
    const unique = new Set(slots);
    expect(unique.size).toBe(1);
  });

  it('recordFailure runs the Lua script atomically without CROSSSLOT', async () => {
    // Note: BreakerLevel is one of tenant|app|llm_provider|tool_service —
    // there is no 'auth' level, so we use 'tool_service' (default
    // failureRateThreshold and minimumRequestCount are real numbers, not nil
    // — required because the Lua script does `total_count >= min_requests`).
    const breaker = new RedisCircuitBreaker(handle.client, 'tool_service', {
      failureThreshold: 5,
      monitorWindow: 10_000,
      resetTimeout: 30_000,
    });

    // Drive the breaker past its threshold via execute() with a failing fn.
    // execute() calls recordFailure() internally; if the keys weren't co-located
    // we'd see a CROSSSLOT thrown from the Lua boundary.
    const failures: unknown[] = [];
    for (let i = 0; i < 8; i++) {
      try {
        await breaker.execute('tenant-1', async () => {
          throw new Error(`fail-${i}`);
        });
      } catch (err) {
        failures.push(err);
      }
    }

    // None of the captured errors should be CROSSSLOT — if they were the
    // hash-tag co-location is broken.
    const messages = failures.map((e) => (e instanceof Error ? e.message : String(e)));
    for (const m of messages) expect(m).not.toMatch(/CROSSSLOT/);

    // Diagnostic: pull live metrics so the assertion below has more context
    // if it fails.
    const metrics = await breaker.getMetrics('tenant-1');
    expect(metrics.failureCount).toBeGreaterThanOrEqual(5);

    // After at least failureThreshold (5) failures, the breaker must be OPEN.
    expect(metrics.state).toBe('OPEN');
  }, 30_000);

  it('different (level, key) pairs land on different slots — no tenant-wide hot slot', async () => {
    const a = breakerKeys('tool_service', 'tenant-aaa');
    const b = breakerKeys('tool_service', 'tenant-bbb');
    const slotA = Number(await handle.client.cluster('KEYSLOT', a.state));
    const slotB = Number(await handle.client.cluster('KEYSLOT', b.state));
    // The probability of collision is 1/16384; almost any two random tenants
    // distribute. If this ever flakes for a specific pair, change the inputs.
    expect(slotA).not.toBe(slotB);
  });
});

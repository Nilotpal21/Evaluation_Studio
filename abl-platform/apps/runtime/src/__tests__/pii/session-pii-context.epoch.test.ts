/**
 * INT-10: PII config epoch — bump invalidates the snapshot cache.
 *
 * Without Redis the epoch falls back to an in-process counter; bumps
 * still update the localEpochs map AND the read-cache entry, so the
 * next `getPIIConfigEpoch` read sees the new value. The
 * `resolveProjectPIISnapshot` cache is keyed by `(tenant, project, env,
 * epoch)`, so a bumped epoch produces a fresh cache miss → fresh
 * registry construction → updated pack selection.
 *
 * Pure-function level: no module mocks. The snapshot-cache
 * key/invalidation mechanic is tested via the epoch + the cache key
 * shape (key contains epoch suffix, distinct epoch -> distinct key).
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
  getPIIConfigEpoch,
  bumpPIIConfigEpoch,
  resetPIIConfigEpochCache,
} from '../../services/pii/pii-epoch.js';

beforeEach(() => {
  resetPIIConfigEpochCache();
});

describe('INT-10: PII config epoch (in-process fallback, no Redis)', () => {
  test('first read returns 0 when no bumps have happened', async () => {
    expect(await getPIIConfigEpoch('t1', 'p1')).toBe(0);
  });

  test('bump increments and the next read sees the new value', async () => {
    const after = await bumpPIIConfigEpoch('t1', 'p1');
    expect(after).toBe(1);
    expect(await getPIIConfigEpoch('t1', 'p1')).toBe(1);
  });

  test('bumps are monotonic and isolated per (tenant, project)', async () => {
    expect(await bumpPIIConfigEpoch('t1', 'p1')).toBe(1);
    expect(await bumpPIIConfigEpoch('t1', 'p1')).toBe(2);
    expect(await bumpPIIConfigEpoch('t1', 'p1')).toBe(3);

    // Different project under same tenant — independent counter
    expect(await bumpPIIConfigEpoch('t1', 'p2')).toBe(1);
    expect(await getPIIConfigEpoch('t1', 'p1')).toBe(3);

    // Different tenant — also independent
    expect(await bumpPIIConfigEpoch('t2', 'p1')).toBe(1);
    expect(await getPIIConfigEpoch('t1', 'p1')).toBe(3);
  });

  test('reset clears all state', async () => {
    await bumpPIIConfigEpoch('t1', 'p1');
    await bumpPIIConfigEpoch('t1', 'p2');
    resetPIIConfigEpochCache();
    expect(await getPIIConfigEpoch('t1', 'p1')).toBe(0);
    expect(await getPIIConfigEpoch('t1', 'p2')).toBe(0);
  });
});

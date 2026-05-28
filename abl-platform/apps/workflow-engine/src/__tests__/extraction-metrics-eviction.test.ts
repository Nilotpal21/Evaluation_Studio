/**
 * Extraction metrics — bounded-eviction tests (Phase 4 pr-review Round 1).
 *
 * Each of the three in-memory Maps in `observability/extraction-metrics.ts`
 * is capped at 10,000 entries with oldest-insertion eviction. These tests
 * confirm the eviction triggers at the cap boundary and that the oldest
 * entry is the one dropped.
 *
 * The tests use the `__resetMetricsForTest()` helper and snapshot getters
 * exported by the module; no OTel SDK boot is required because the eviction
 * logic runs in plain JavaScript before the observable-gauge callback fires.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  __getBreakerStateSnapshotForTest,
  __getCapRatioSnapshotForTest,
  __getParkedSnapshotForTest,
  __resetMetricsForTest,
  incrementParked,
  recordAzureDIBreakerState,
  recordAzureDICapUsage,
} from '../observability/extraction-metrics.js';

const CAP = 10_000;

describe('extraction-metrics — bounded eviction', () => {
  beforeEach(() => {
    __resetMetricsForTest();
  });

  it('_parkedByTenant evicts the oldest entry on overflow', () => {
    for (let i = 0; i < CAP; i++) {
      incrementParked(`tenant-${i}`);
    }
    expect(__getParkedSnapshotForTest().size).toBe(CAP);
    expect(__getParkedSnapshotForTest().has('tenant-0')).toBe(true);

    // The 10001st distinct key triggers eviction of the oldest entry.
    incrementParked('tenant-10001');
    expect(__getParkedSnapshotForTest().size).toBe(CAP);
    expect(__getParkedSnapshotForTest().has('tenant-0')).toBe(false);
    expect(__getParkedSnapshotForTest().has('tenant-10001')).toBe(true);
  });

  it('_breakerStateByTenant evicts the oldest entry on overflow', () => {
    for (let i = 0; i < CAP; i++) {
      recordAzureDIBreakerState(`tenant-${i}`, 'CLOSED');
    }
    expect(__getBreakerStateSnapshotForTest().size).toBe(CAP);
    expect(__getBreakerStateSnapshotForTest().has('tenant-0')).toBe(true);

    recordAzureDIBreakerState('tenant-10001', 'OPEN');
    expect(__getBreakerStateSnapshotForTest().size).toBe(CAP);
    expect(__getBreakerStateSnapshotForTest().has('tenant-0')).toBe(false);
    expect(__getBreakerStateSnapshotForTest().get('tenant-10001')).toBe(2);
  });

  it('_capRatioByConn evicts the oldest entry on overflow', () => {
    for (let i = 0; i < CAP; i++) {
      recordAzureDICapUsage({
        connectionId: `conn-${i}`,
        tenant: `tenant-${i}`,
        project: 'p-1',
        usageCount: 1,
        usageSoftCap: null,
        usageHardCap: 10,
      });
    }
    expect(__getCapRatioSnapshotForTest().size).toBe(CAP);
    expect(__getCapRatioSnapshotForTest().has('conn-0')).toBe(true);

    recordAzureDICapUsage({
      connectionId: 'conn-10001',
      tenant: 'tenant-10001',
      project: 'p-1',
      usageCount: 5,
      usageSoftCap: null,
      usageHardCap: 10,
    });
    expect(__getCapRatioSnapshotForTest().size).toBe(CAP);
    expect(__getCapRatioSnapshotForTest().has('conn-0')).toBe(false);
    expect(__getCapRatioSnapshotForTest().has('conn-10001')).toBe(true);
  });

  it('updates to an existing key do NOT trigger eviction', () => {
    // Fill to capacity.
    for (let i = 0; i < CAP; i++) {
      recordAzureDIBreakerState(`tenant-${i}`, 'CLOSED');
    }
    expect(__getBreakerStateSnapshotForTest().size).toBe(CAP);

    // Re-record an existing key — must not evict.
    recordAzureDIBreakerState('tenant-0', 'OPEN');
    expect(__getBreakerStateSnapshotForTest().size).toBe(CAP);
    expect(__getBreakerStateSnapshotForTest().get('tenant-0')).toBe(2);
  });
});

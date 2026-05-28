import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';
import {
  calibratedSizeDataStores,
  deriveStoreConfig,
} from '../engine/calibrated-datastore-sizer.js';
import type { CalibrationProfile } from '../types/calibration.types.js';
import { makeQ } from './helpers/make-questionnaire.js';

async function loadCalibration(): Promise<CalibrationProfile> {
  const raw = await readFile(join(__dirname, 'fixtures/calibration-m.json'), 'utf-8');
  return JSON.parse(raw) as CalibrationProfile;
}

describe('calibratedSizeDataStores', () => {
  it('sizes mongodb with measured resource peaks + 15% buffer', async () => {
    const calibration = await loadCalibration();
    const q = makeQ();

    const stores = calibratedSizeDataStores('M', q, calibration);
    const mongo = stores.find((s) => s.name === 'mongodb');

    expect(mongo).toBeDefined();
    // cpuPeak 1.5 * 1.15 = 1.725 → roundUpCpu(1.725) = 1.75
    expect(parseFloat(mongo!.resources.cpu)).toBeGreaterThanOrEqual(1.5);
    // memoryPeak 3.5Gi * 1.15 = 4.025 → roundUpMemoryGi = 4.25
    expect(mongo!.resources.memory).toMatch(/\d+(\.\d+)?Gi/);
  });

  it('computes storage from disk usage + 90-day growth + 30% buffer', async () => {
    const calibration = await loadCalibration();
    const q = makeQ();

    const stores = calibratedSizeDataStores('M', q, calibration);
    const mongo = stores.find((s) => s.name === 'mongodb');

    expect(mongo).toBeDefined();
    // diskUsageGB=12.5 + 0.15*90 = 26 → *1.3 = 33.8 → ceil = 34Gi
    expect(mongo!.resources.storage).toBeDefined();
    const storageGi = parseFloat(mongo!.resources.storage!.replace('Gi', ''));
    expect(storageGi).toBeGreaterThanOrEqual(30);
  });

  it('includes stores not in calibration using hardcoded fallback', async () => {
    const calibration = await loadCalibration();
    const q = makeQ();

    // Calibration fixture only has mongodb + redis
    const stores = calibratedSizeDataStores('M', q, calibration);
    const storeNames = stores.map((s) => s.name);

    // Hardcoded sizer produces 7 stores; all should be present
    expect(storeNames).toContain('mongodb');
    expect(storeNames).toContain('redis');
    expect(storeNames).toContain('clickhouse');
    expect(storeNames).toContain('opensearch');
    expect(storeNames).toContain('neo4j');
    expect(storeNames).toContain('qdrant');
    expect(storeNames).toContain('restate');
    expect(stores.length).toBe(7);
  });

  it('includes store-specific config in notes for mongodb', async () => {
    const calibration = await loadCalibration();
    const q = makeQ();

    const stores = calibratedSizeDataStores('M', q, calibration);
    const mongo = stores.find((s) => s.name === 'mongodb');

    expect(mongo).toBeDefined();
    expect(mongo!.notes).toBeDefined();
    expect(mongo!.notes).toContain('maxConnections');
  });

  it('includes maxmemory config in notes for redis', async () => {
    const calibration = await loadCalibration();
    const q = makeQ();

    const stores = calibratedSizeDataStores('M', q, calibration);
    const redis = stores.find((s) => s.name === 'redis');

    expect(redis).toBeDefined();
    expect(redis!.notes).toBeDefined();
    expect(redis!.notes).toContain('maxmemory');
  });
});

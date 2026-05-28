import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';
import {
  extractServiceMeasured,
  extractServiceLatency,
  extractRequestRate,
  extractErrorRate,
  extractDataStoreResources,
  extractDataStoreLatency,
  extractDataStoreConnections,
  extractStoreSpecificMetrics,
  classifyDataSource,
} from '../engine/coroot-metric-extractors.js';

async function loadFixture(name: string): Promise<unknown> {
  const raw = await readFile(join(__dirname, `fixtures/${name}`), 'utf-8');
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Service metric extractors
// ---------------------------------------------------------------------------

describe('extractServiceMeasured', () => {
  it('extracts CPU peak/avg and memory peak/avg from app response', async () => {
    const response = await loadFixture('coroot-app-response.json');
    const measured = extractServiceMeasured(response);
    // CPU peak should be around 1.8 cores
    expect(measured.cpuPeak).toMatch(/^\d+(\.\d+)?$/);
    expect(parseFloat(measured.cpuPeak!)).toBeCloseTo(1.8, 0);
    // CPU avg
    expect(measured.cpuAvg).toMatch(/^\d+(\.\d+)?$/);
    // Memory peak ~3.2Gi
    expect(measured.memoryPeak).toMatch(/^\d+(\.\d+)?Gi$/);
    // Memory avg
    expect(measured.memoryAvg).toMatch(/^\d+(\.\d+)?Gi$/);
    // Pod restarts (sum of restarts data = 1)
    expect(typeof measured.podRestarts).toBe('number');
    expect(measured.podRestarts).toBe(1);
    // OOMKills = 2 from check
    expect(typeof measured.oomKills).toBe('number');
    expect(measured.oomKills).toBe(2);
  });

  it('returns null fields when CPU/memory data is missing', () => {
    const measured = extractServiceMeasured({});
    expect(measured.cpuPeak).toBeNull();
    expect(measured.cpuAvg).toBeNull();
    expect(measured.memoryPeak).toBeNull();
    expect(measured.memoryAvg).toBeNull();
    expect(measured.podRestarts).toBe(0);
    expect(measured.oomKills).toBe(0);
  });

  it('handles null input gracefully', () => {
    const measured = extractServiceMeasured(null);
    expect(measured.cpuPeak).toBeNull();
    expect(measured.memoryPeak).toBeNull();
  });
});

describe('extractServiceLatency', () => {
  it('extracts latency percentiles from app response', async () => {
    const response = await loadFixture('coroot-app-response.json');
    const latency = extractServiceLatency(response);
    expect(latency.p50Ms).toBeGreaterThan(0);
    expect(latency.p95Ms).toBeGreaterThanOrEqual(latency.p50Ms);
    expect(latency.p99Ms).toBeGreaterThanOrEqual(latency.p95Ms);
    expect(typeof latency.minMs).toBe('number');
    expect(typeof latency.maxMs).toBe('number');
  });

  it('returns zeros when latency data is missing', () => {
    const latency = extractServiceLatency({});
    expect(latency.p50Ms).toBe(0);
    expect(latency.p95Ms).toBe(0);
    expect(latency.p99Ms).toBe(0);
    expect(latency.minMs).toBe(0);
    expect(latency.maxMs).toBe(0);
  });
});

describe('extractRequestRate', () => {
  it('extracts inbound request rate for cross-validation', async () => {
    const response = await loadFixture('coroot-app-response.json');
    const rps = extractRequestRate(response);
    expect(rps).toBeGreaterThan(0);
    // avg of total series values ~487.5
    expect(rps).toBeGreaterThan(400);
    expect(rps).toBeLessThan(600);
  });

  it('returns 0 for empty response', () => {
    expect(extractRequestRate({})).toBe(0);
  });
});

describe('extractErrorRate', () => {
  it('extracts 5xx error rate as fraction', async () => {
    const response = await loadFixture('coroot-app-response.json');
    const errorRate = extractErrorRate(response);
    expect(typeof errorRate).toBe('number');
    expect(errorRate).toBeGreaterThanOrEqual(0);
    expect(errorRate).toBeLessThanOrEqual(1);
    // errors avg ~2, total avg ~487.5, so about 0.004
    expect(errorRate).toBeLessThan(0.01);
  });

  it('returns 0 for empty response', () => {
    expect(extractErrorRate({})).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Data store metric extractors
// ---------------------------------------------------------------------------

describe('extractDataStoreResources', () => {
  it('extracts CPU/memory/disk from data store app response', async () => {
    const response = await loadFixture('coroot-datastore-response.json');
    const resources = extractDataStoreResources(response);
    expect(resources.cpuPeak).not.toBeNull();
    expect(resources.cpuAvg).not.toBeNull();
    expect(resources.memoryPeak).not.toBeNull();
    expect(resources.memoryAvg).not.toBeNull();
    expect(typeof resources.diskUsageGB).toBe('number');
    expect(resources.diskUsageGB).toBeGreaterThan(0);
    expect(typeof resources.diskGrowthRateGBPerDay).toBe('number');
  });

  it('returns null/zero for missing data', () => {
    const resources = extractDataStoreResources({});
    expect(resources.cpuPeak).toBeNull();
    expect(resources.memoryPeak).toBeNull();
    expect(resources.diskUsageGB).toBe(0);
    expect(resources.diskGrowthRateGBPerDay).toBe(0);
  });
});

describe('extractDataStoreLatency', () => {
  it('extracts query and write latency percentiles', async () => {
    const response = await loadFixture('coroot-datastore-response.json');
    const latency = extractDataStoreLatency(response);
    expect(latency.queryP50Ms).toBeGreaterThan(0);
    expect(latency.queryP95Ms).toBeGreaterThanOrEqual(latency.queryP50Ms);
    expect(latency.writeP50Ms).toBeGreaterThan(0);
    expect(latency.writeP95Ms).toBeGreaterThanOrEqual(latency.writeP50Ms);
  });

  it('returns all zeros for missing data', () => {
    const latency = extractDataStoreLatency({});
    expect(latency.queryP50Ms).toBe(0);
    expect(latency.writeP50Ms).toBe(0);
  });
});

describe('extractDataStoreConnections', () => {
  it('extracts connection used/max/utilization', async () => {
    const response = await loadFixture('coroot-datastore-response.json');
    const conns = extractDataStoreConnections(response);
    expect(conns.used).toBeGreaterThan(0);
    expect(conns.max).toBeGreaterThan(0);
    expect(conns.utilizationPercent).toBeGreaterThanOrEqual(0);
    expect(conns.utilizationPercent).toBeLessThanOrEqual(100);
  });

  it('returns zeros for missing data', () => {
    const conns = extractDataStoreConnections({});
    expect(conns.used).toBe(0);
    expect(conns.max).toBe(0);
    expect(conns.utilizationPercent).toBe(0);
  });
});

describe('extractStoreSpecificMetrics', () => {
  it('extracts store-specific panel data for MongoDB', async () => {
    const response = await loadFixture('coroot-panel-response.json');
    const metrics = extractStoreSpecificMetrics('mongodb', response);
    expect(metrics).toHaveProperty('wiredTigerCacheHitRatio');
    expect(metrics).toHaveProperty('replicationLag');
    expect(metrics).toHaveProperty('slowQueries');
  });

  it('returns empty object for unknown store type', async () => {
    const response = await loadFixture('coroot-panel-response.json');
    const metrics = extractStoreSpecificMetrics('unknown-store', response);
    expect(metrics).toEqual({});
  });

  it('handles malformed panel response gracefully', () => {
    const metrics = extractStoreSpecificMetrics('mongodb', {});
    expect(metrics).toEqual({});
  });
});

describe('classifyDataSource', () => {
  it('returns coroot-native for MongoDB', () => {
    expect(classifyDataSource('mongodb')).toBe('coroot-native');
  });

  it('returns coroot-native for Redis', () => {
    expect(classifyDataSource('redis')).toBe('coroot-native');
  });

  it('returns coroot-tcp for OpenSearch', () => {
    expect(classifyDataSource('opensearch')).toBe('coroot-tcp');
  });

  it('returns coroot-tcp for Qdrant', () => {
    expect(classifyDataSource('qdrant')).toBe('coroot-tcp');
  });

  it('normalizes prefixed names (mongodb-primary -> mongodb)', () => {
    expect(classifyDataSource('mongodb-primary')).toBe('coroot-native');
  });

  it('returns coroot-tcp for unknown stores', () => {
    expect(classifyDataSource('custom-db')).toBe('coroot-tcp');
  });
});

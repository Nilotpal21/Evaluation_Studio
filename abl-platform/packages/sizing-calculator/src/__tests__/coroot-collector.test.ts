import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';
import type { CorootClient, MetricTimeRange } from '../engine/coroot-collector.js';
import {
  checkCorootHealth,
  resolveCorootAppId,
  clearAppIdCache,
  collectServiceMetrics,
  collectDataStoreMetrics,
} from '../engine/coroot-collector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockClient(overrides: Partial<CorootClient> = {}): CorootClient {
  return {
    healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
    getApplication: vi.fn().mockResolvedValue({}),
    getApplicationsOverview: vi.fn().mockResolvedValue({ applications: [] }),
    getPanelData: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

async function loadFixture(name: string): Promise<unknown> {
  const raw = await readFile(join(__dirname, `fixtures/${name}`), 'utf-8');
  return JSON.parse(raw);
}

let corootAppFixture: unknown;
let corootDatastoreFixture: unknown;
let corootPanelFixture: unknown;

beforeEach(async () => {
  clearAppIdCache();
  corootAppFixture = await loadFixture('coroot-app-response.json');
  corootDatastoreFixture = await loadFixture('coroot-datastore-response.json');
  corootPanelFixture = await loadFixture('coroot-panel-response.json');
});

// ---------------------------------------------------------------------------
// checkCorootHealth
// ---------------------------------------------------------------------------

describe('checkCorootHealth', () => {
  it('returns success when Coroot is healthy', async () => {
    const client = mockClient();
    const result = await checkCorootHealth(client, 'project-1');
    expect(result).toEqual({
      success: true,
      data: { healthy: true },
      error: undefined,
    });
  });

  it('returns failure when Coroot is unreachable', async () => {
    const client = mockClient({
      healthCheck: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });
    const result = await checkCorootHealth(client, 'project-1');
    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
    expect(result.error?.code).toBe('COROOT_UNREACHABLE');
  });
});

// ---------------------------------------------------------------------------
// resolveCorootAppId
// ---------------------------------------------------------------------------

describe('resolveCorootAppId', () => {
  it('resolves service name to Coroot app ID from overview', async () => {
    const client = mockClient({
      getApplicationsOverview: vi.fn().mockResolvedValue({
        applications: [
          { id: 'abl/Deployment/runtime', name: 'runtime' },
          { id: 'abl/Deployment/search-ai', name: 'search-ai' },
          { id: 'abl/StatefulSet/mongodb', name: 'mongodb' },
        ],
      }),
    });
    const result = await resolveCorootAppId(client, 'runtime', 'project-1');
    expect(result.success).toBe(true);
    expect(result.data).toBe('abl/Deployment/runtime');
  });

  it('matches partial name in app ID when exact name match fails', async () => {
    const client = mockClient({
      getApplicationsOverview: vi.fn().mockResolvedValue({
        applications: [
          {
            id: 'abl/Deployment/abl-platform-runtime',
            name: 'abl-platform-runtime',
          },
        ],
      }),
    });
    const result = await resolveCorootAppId(client, 'runtime', 'project-1');
    expect(result.success).toBe(true);
    expect(result.data).toBe('abl/Deployment/abl-platform-runtime');
  });

  it('returns error when service not found in Coroot', async () => {
    const client = mockClient({
      getApplicationsOverview: vi.fn().mockResolvedValue({
        applications: [{ id: 'abl/Deployment/other-service', name: 'other-service' }],
      }),
    });
    const result = await resolveCorootAppId(client, 'runtime', 'project-1');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('APP_NOT_FOUND');
  });

  it('returns error when Coroot call fails', async () => {
    const client = mockClient({
      getApplicationsOverview: vi.fn().mockRejectedValue(new Error('timeout')),
    });
    const result = await resolveCorootAppId(client, 'runtime', 'project-1');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('COROOT_UNREACHABLE');
  });

  it('caches resolved app IDs for subsequent calls', async () => {
    const overviewFn = vi.fn().mockResolvedValue({
      applications: [{ id: 'abl/Deployment/runtime', name: 'runtime' }],
    });
    const client = mockClient({ getApplicationsOverview: overviewFn });
    await resolveCorootAppId(client, 'runtime', 'project-1');
    await resolveCorootAppId(client, 'runtime', 'project-1');
    expect(overviewFn).toHaveBeenCalledTimes(1); // cached
  });
});

// ---------------------------------------------------------------------------
// collectServiceMetrics
// ---------------------------------------------------------------------------

describe('collectServiceMetrics', () => {
  const timeRange: MetricTimeRange = {
    from: 1711324800,
    to: 1711328400,
  };

  it('returns measured fields when Coroot returns valid data', async () => {
    const client = mockClient({
      getApplicationsOverview: vi.fn().mockResolvedValue({
        applications: [{ id: 'abl/Deployment/runtime', name: 'runtime' }],
      }),
      getApplication: vi.fn().mockResolvedValue(corootAppFixture),
    });

    const result = await collectServiceMetrics(client, 'runtime', timeRange, 'project-1');
    expect(result.success).toBe(true);
    expect(result.data).not.toBeNull();
    expect(result.data!.cpuPeak).not.toBeNull();
    expect(result.data!.memoryPeak).not.toBeNull();
    expect(typeof result.data!.podRestarts).toBe('number');
    expect(typeof result.data!.oomKills).toBe('number');
    expect(result.data!.latency.p50Ms).toBeGreaterThan(0);
    expect(result.data!.observedRps).toBeGreaterThan(0);
    expect(typeof result.data!.observedErrorRate).toBe('number');
  });

  it('returns error when app not found in Coroot', async () => {
    const client = mockClient({
      getApplicationsOverview: vi.fn().mockResolvedValue({ applications: [] }),
    });

    const result = await collectServiceMetrics(client, 'runtime', timeRange, 'project-1');
    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
    expect(result.error?.code).toBe('APP_NOT_FOUND');
  });

  it('returns error when Coroot is unreachable', async () => {
    const client = mockClient({
      getApplicationsOverview: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });

    const result = await collectServiceMetrics(client, 'runtime', timeRange, 'project-1');
    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
  });

  it('passes time range to get_application call', async () => {
    const getAppFn = vi.fn().mockResolvedValue(corootAppFixture);
    const client = mockClient({
      getApplicationsOverview: vi.fn().mockResolvedValue({
        applications: [{ id: 'abl/Deployment/runtime', name: 'runtime' }],
      }),
      getApplication: getAppFn,
    });

    await collectServiceMetrics(client, 'runtime', timeRange, 'project-1');
    expect(getAppFn).toHaveBeenCalledWith({
      projectId: 'project-1',
      appId: 'abl/Deployment/runtime',
      fromTimestamp: 1711324800,
      toTimestamp: 1711328400,
    });
  });
});

// ---------------------------------------------------------------------------
// collectDataStoreMetrics
// ---------------------------------------------------------------------------

describe('collectDataStoreMetrics', () => {
  const timeRange: MetricTimeRange = {
    from: 1711324800,
    to: 1711328400,
  };

  it('returns full DataStoreCapacity fields for a native-instrumented store (MongoDB)', async () => {
    const client = mockClient({
      getApplicationsOverview: vi.fn().mockResolvedValue({
        applications: [{ id: 'abl/StatefulSet/mongodb', name: 'mongodb' }],
      }),
      getApplication: vi.fn().mockResolvedValue(corootDatastoreFixture),
      getPanelData: vi.fn().mockResolvedValue(corootPanelFixture),
    });

    const result = await collectDataStoreMetrics(client, 'mongodb', timeRange, 'project-1');
    expect(result.success).toBe(true);
    expect(result.data).not.toBeNull();
    expect(result.data!.resources.cpuPeak).not.toBeNull();
    expect(result.data!.connections.used).toBeGreaterThan(0);
    expect(result.data!.dataSource).toBe('coroot-native');
    expect(result.data!.storeSpecific).toHaveProperty('wiredTigerCacheHitRatio');
  });

  it('returns TCP-level metrics only for non-native stores (OpenSearch)', async () => {
    const client = mockClient({
      getApplicationsOverview: vi.fn().mockResolvedValue({
        applications: [{ id: 'abl/StatefulSet/opensearch', name: 'opensearch' }],
      }),
      getApplication: vi.fn().mockResolvedValue(corootDatastoreFixture),
    });

    const result = await collectDataStoreMetrics(client, 'opensearch', timeRange, 'project-1');
    expect(result.success).toBe(true);
    expect(result.data!.dataSource).toBe('coroot-tcp');
  });

  it('returns error when store not found in Coroot', async () => {
    const client = mockClient({
      getApplicationsOverview: vi.fn().mockResolvedValue({ applications: [] }),
    });

    const result = await collectDataStoreMetrics(client, 'mongodb', timeRange, 'project-1');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('APP_NOT_FOUND');
  });

  it('returns partial data when panel data fails but app data succeeds', async () => {
    const client = mockClient({
      getApplicationsOverview: vi.fn().mockResolvedValue({
        applications: [{ id: 'abl/StatefulSet/mongodb', name: 'mongodb' }],
      }),
      getApplication: vi.fn().mockResolvedValue(corootDatastoreFixture),
      getPanelData: vi.fn().mockRejectedValue(new Error('panel not found')),
    });

    const result = await collectDataStoreMetrics(client, 'mongodb', timeRange, 'project-1');
    expect(result.success).toBe(true); // partial success
    expect(result.data!.resources.cpuPeak).not.toBeNull();
    expect(result.data!.storeSpecific).toEqual({}); // degraded
  });

  it('returns error when Coroot is unreachable', async () => {
    const client = mockClient({
      getApplicationsOverview: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });

    const result = await collectDataStoreMetrics(client, 'mongodb', timeRange, 'project-1');
    expect(result.success).toBe(false);
  });
});

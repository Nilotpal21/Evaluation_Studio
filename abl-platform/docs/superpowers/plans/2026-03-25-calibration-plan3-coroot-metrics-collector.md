# Calibration Pipeline — Plan 3: Coroot Metrics Collector

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a TypeScript module that queries Coroot MCP tools after each k6 saturation test to collect CPU, memory, pod restarts, OOMKills, latency, and store-specific metrics — populating the `measured` fields of `ServiceCapacity` and full `DataStoreCapacity` entries in the `CalibrationProfile`.

**Architecture:** The collector is a regular TypeScript module called by the CLI orchestrator (Plan 4) after each k6 test completes. It receives the service name, time range (k6 start/end timestamps), and Coroot project ID. It calls Coroot MCP tools (`get_application`, `get_panel_data`, `health_check`) via the Coroot MCP client, extracts metrics from the response, and returns partial `CalibrationProfile` entries. Graceful degradation: when Coroot is unreachable or returns incomplete data, measured fields are set to `null` and the data source is marked `'unavailable'`.

**Tech Stack:** TypeScript, Vitest, Coroot MCP tools (`mcp__coroot__get_application`, `mcp__coroot__get_panel_data`, `mcp__coroot__health_check`, `mcp__coroot__get_applications_overview`)

**Spec:** `docs/superpowers/specs/2026-03-24-benchmark-sizing-calibration-design.md` — Section 9 (Coroot Metrics Collection)

**Plan series:** This is Plan 3 of 6.

| Plan         | Subsystem                                      | Status |
| ------------ | ---------------------------------------------- | ------ |
| 1            | Data Model + Traffic Model + Sizing Calculator | —      |
| 2            | Saturation k6 Scripts + Shared Lib             | —      |
| **3 (this)** | Coroot Metrics Collector                       | —      |
| 4            | CLI Benchmark Orchestrator                     | —      |
| 5            | Report Generation                              | —      |
| 6            | Shell Script Updates (service groups)          | —      |

**Dependencies:** Plan 1 must be complete — this plan imports `ServiceCapacity`, `DataStoreCapacity`, `LatencyMetrics` from `packages/sizing-calculator/src/types/calibration.types.ts`.

---

## File Structure

### New Files

| File                                                                               | Responsibility                                                                          |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/sizing-calculator/src/engine/coroot-collector.ts`                        | Main collector module — all public functions for querying Coroot and extracting metrics |
| `packages/sizing-calculator/src/engine/coroot-metric-extractors.ts`                | Pure extraction functions — parse Coroot API responses into typed metric objects        |
| `packages/sizing-calculator/src/__tests__/coroot-collector.test.ts`                | Tests for collector orchestration, health checks, app resolution, graceful degradation  |
| `packages/sizing-calculator/src/__tests__/coroot-metric-extractors.test.ts`        | Tests for metric extraction from Coroot response payloads                               |
| `packages/sizing-calculator/src/__tests__/fixtures/coroot-app-response.json`       | Fixture: realistic `get_application` response for an app service                        |
| `packages/sizing-calculator/src/__tests__/fixtures/coroot-datastore-response.json` | Fixture: realistic `get_application` response for a data store (MongoDB)                |
| `packages/sizing-calculator/src/__tests__/fixtures/coroot-panel-response.json`     | Fixture: realistic `get_panel_data` response for store-specific metrics                 |

### Modified Files

| File                                             | Changes                                              |
| ------------------------------------------------ | ---------------------------------------------------- |
| `packages/sizing-calculator/src/engine/index.ts` | Export coroot-collector public functions             |
| `packages/sizing-calculator/src/index.ts`        | Re-export coroot-collector if not already via engine |

---

## Coroot MCP Tool Reference

The collector calls three Coroot MCP tools. In the CLI context, these are invoked through the MCP client. The collector accepts a `CorootClient` interface to abstract the MCP calls, enabling clean test mocking.

### `get_application`

```typescript
// Parameters
{
  project_id: string;
  app_id: string;              // format: "namespace/kind/name" e.g. "abl/Deployment/runtime"
  from_timestamp?: number;     // Unix epoch seconds
  to_timestamp?: number;       // Unix epoch seconds
}
// Returns: application details with CPU, memory, network, health, latency, incidents
```

### `get_panel_data`

```typescript
// Parameters
{
  project_id: string;
  dashboard_id: string;
  panel_id: string;
  from_time?: string;          // ISO format or relative e.g. "-1h"
  to_time?: string;            // ISO format or "now"
}
// Returns: time series data for a specific dashboard panel (store-specific metrics)
```

### `health_check`

```typescript
// Parameters: none
// Returns: health status of the Coroot server
```

### `get_applications_overview`

```typescript
// Parameters
{
  project_id: string;
  query?: string;              // Search/filter query
}
// Returns: list of all applications with IDs — used for resolveCorootAppId discovery
```

---

## Task 1: CorootClient Interface and Health Check

**Files:**

- Create: `packages/sizing-calculator/src/engine/coroot-collector.ts`
- Create: `packages/sizing-calculator/src/__tests__/coroot-collector.test.ts`

This task defines the abstraction layer over Coroot MCP tools and implements the health check function.

- [ ] **Step 1: Define CorootClient interface and types** (~3 min)

  Create `packages/sizing-calculator/src/engine/coroot-collector.ts` with:

  ```typescript
  import type {
    ServiceCapacity,
    DataStoreCapacity,
    LatencyMetrics,
  } from '../types/calibration.types.js';

  /** Time range for metric queries — Unix epoch seconds. */
  export interface MetricTimeRange {
    from: number; // Unix epoch seconds (k6 test start)
    to: number; // Unix epoch seconds (k6 test end)
  }

  /**
   * Abstraction over Coroot MCP tool calls.
   * The CLI orchestrator (Plan 4) provides a concrete implementation
   * that delegates to the actual MCP client. Tests provide a mock.
   */
  export interface CorootClient {
    healthCheck(): Promise<CorootHealthResult>;
    getApplication(params: {
      projectId: string;
      appId: string;
      fromTimestamp?: number;
      toTimestamp?: number;
    }): Promise<unknown>;
    getApplicationsOverview(params: { projectId: string; query?: string }): Promise<unknown>;
    getPanelData(params: {
      projectId: string;
      dashboardId: string;
      panelId: string;
      fromTime?: string;
      toTime?: string;
    }): Promise<unknown>;
  }

  export interface CorootHealthResult {
    healthy: boolean;
    message?: string;
  }

  /** Result wrapper — every collector function returns this. */
  export interface CollectorResult<T> {
    success: boolean;
    data: T | null;
    error?: { code: string; message: string };
  }
  ```

  Commit: `[ABLP-2] feat(sizing-calculator): add CorootClient interface and collector types`

- [ ] **Step 2: Write health check test** (~2 min)

  Create `packages/sizing-calculator/src/__tests__/coroot-collector.test.ts`:

  ```typescript
  import { describe, it, expect, vi } from 'vitest';
  import type { CorootClient } from '../engine/coroot-collector.js';
  import { checkCorootHealth } from '../engine/coroot-collector.js';

  function mockClient(overrides: Partial<CorootClient> = {}): CorootClient {
    return {
      healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
      getApplication: vi.fn().mockResolvedValue({}),
      getApplicationsOverview: vi.fn().mockResolvedValue({ applications: [] }),
      getPanelData: vi.fn().mockResolvedValue({}),
      ...overrides,
    };
  }

  describe('checkCorootHealth', () => {
    it('returns success when Coroot is healthy', async () => {
      const client = mockClient();
      const result = await checkCorootHealth(client, 'project-1');
      expect(result).toEqual({ success: true, data: { healthy: true }, error: undefined });
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
  ```

  Commit: `[ABLP-2] test(sizing-calculator): add checkCorootHealth tests`

- [ ] **Step 3: Implement checkCorootHealth** (~3 min)

  In `coroot-collector.ts`, add:

  ```typescript
  /**
   * Verify Coroot is reachable before attempting metric collection.
   * Called by the CLI orchestrator before starting the benchmark loop.
   */
  export async function checkCorootHealth(
    client: CorootClient,
    _projectId: string,
  ): Promise<CollectorResult<CorootHealthResult>> {
    try {
      const result = await client.healthCheck();
      return { success: true, data: result, error: undefined };
    } catch (err) {
      return {
        success: false,
        data: null,
        error: {
          code: 'COROOT_UNREACHABLE',
          message: `Coroot health check failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }
  ```

  Run tests: `pnpm vitest run --reporter=verbose packages/sizing-calculator/src/__tests__/coroot-collector.test.ts`

  Commit: `[ABLP-2] feat(sizing-calculator): implement checkCorootHealth with graceful degradation`

---

## Task 2: Resolve Coroot Application ID

**Files:**

- Modify: `packages/sizing-calculator/src/engine/coroot-collector.ts`
- Modify: `packages/sizing-calculator/src/__tests__/coroot-collector.test.ts`

The Coroot `app_id` format is `namespace/kind/name` (e.g., `abl/Deployment/runtime`). The service name from the benchmark config (e.g., `runtime`) needs to be resolved to the full app ID by querying `get_applications_overview`.

- [ ] **Step 1: Write resolveCorootAppId tests** (~3 min)

  Add to the test file:

  ```typescript
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
            { id: 'abl/Deployment/abl-platform-runtime', name: 'abl-platform-runtime' },
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
  ```

  Commit: `[ABLP-2] test(sizing-calculator): add resolveCorootAppId tests`

- [ ] **Step 2: Implement resolveCorootAppId** (~4 min)

  Add to `coroot-collector.ts`:

  ```typescript
  // Cache: projectId -> Map<serviceName, appId>
  // Max 50 entries (one per service per project), cleared between benchmark runs.
  // TTL is implicitly bounded by `clearAppIdCache()` called at the start of each benchmark run.
  const appIdCache = new Map<string, Map<string, string>>();
  const APP_ID_CACHE_MAX = 50;

  /** Clear the app ID cache — called at the start of each benchmark run. */
  export function clearAppIdCache(): void {
    appIdCache.clear();
  }

  /**
   * Maps a service name (e.g., "runtime") to a Coroot application ID
   * (e.g., "abl/Deployment/runtime"). Queries get_applications_overview
   * and caches the mapping for subsequent calls within the same run.
   *
   * Resolution order:
   * 1. Exact name match
   * 2. App ID ending with the service name (handles prefixed names like "abl-platform-runtime")
   */
  export async function resolveCorootAppId(
    client: CorootClient,
    serviceName: string,
    projectId: string,
  ): Promise<CollectorResult<string>> {
    // Check cache first
    const projectCache = appIdCache.get(projectId);
    if (projectCache?.has(serviceName)) {
      return { success: true, data: projectCache.get(serviceName)!, error: undefined };
    }

    try {
      const overview = await client.getApplicationsOverview({ projectId });
      const apps = extractApplicationList(overview);

      // Build cache for this project
      if (!appIdCache.has(projectId)) {
        appIdCache.set(projectId, new Map());
      }
      const cache = appIdCache.get(projectId)!;

      // Evict if over max
      if (cache.size >= APP_ID_CACHE_MAX) {
        const firstKey = cache.keys().next().value;
        if (firstKey !== undefined) cache.delete(firstKey);
      }

      // 1. Exact name match
      const exact = apps.find((a) => a.name === serviceName);
      if (exact) {
        cache.set(serviceName, exact.id);
        return { success: true, data: exact.id, error: undefined };
      }

      // 2. Partial match — app ID ends with service name
      const partial = apps.find(
        (a) => a.id.endsWith(`/${serviceName}`) || a.name.endsWith(serviceName),
      );
      if (partial) {
        cache.set(serviceName, partial.id);
        return { success: true, data: partial.id, error: undefined };
      }

      return {
        success: false,
        data: null,
        error: {
          code: 'APP_NOT_FOUND',
          message: `Service "${serviceName}" not found in Coroot project "${projectId}". Available: ${apps.map((a) => a.name).join(', ')}`,
        },
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        error: {
          code: 'COROOT_UNREACHABLE',
          message: `Failed to resolve app ID for "${serviceName}": ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }
  ```

  The `extractApplicationList` helper is used by `resolveCorootAppId` to parse the overview response:

  ```typescript
  /** Extracts application list from get_applications_overview response. */
  function extractApplicationList(response: unknown): Array<{ id: string; name: string }> {
    // Defensive extraction — Coroot response shape may vary
    if (response && typeof response === 'object' && 'applications' in response) {
      const apps = (response as Record<string, unknown>).applications;
      if (Array.isArray(apps)) {
        return apps
          .filter(
            (a): a is { id: string; name: string } =>
              typeof a === 'object' &&
              a !== null &&
              typeof (a as Record<string, unknown>).id === 'string' &&
              typeof (a as Record<string, unknown>).name === 'string',
          )
          .map((a) => ({ id: a.id, name: a.name }));
      }
    }
    return [];
  }
  ```

  Run tests.

  Commit: `[ABLP-2] feat(sizing-calculator): implement resolveCorootAppId with caching and fuzzy match`

---

## Task 3: Metric Extractor Functions

**Files:**

- Create: `packages/sizing-calculator/src/engine/coroot-metric-extractors.ts`
- Create: `packages/sizing-calculator/src/__tests__/coroot-metric-extractors.test.ts`
- Create: `packages/sizing-calculator/src/__tests__/fixtures/coroot-app-response.json`
- Create: `packages/sizing-calculator/src/__tests__/fixtures/coroot-datastore-response.json`
- Create: `packages/sizing-calculator/src/__tests__/fixtures/coroot-panel-response.json`

Pure functions that parse Coroot API responses into typed metric objects. Separated from the collector for testability — these are tested against fixture data without any mocked clients.

- [ ] **Step 1: Create Coroot response fixtures** (~5 min)

  Create three fixture files based on realistic Coroot `get_application` and `get_panel_data` response shapes. The fixtures should contain:

  **`coroot-app-response.json`** — App service (e.g., runtime):
  - CPU usage time series with peak/avg
  - Memory usage time series with peak/avg
  - Pod restart count
  - OOMKill events
  - Inbound request rate
  - Error rate (5xx)
  - Latency percentiles (p50/p95/p99/min/max)

  **`coroot-datastore-response.json`** — Data store (e.g., MongoDB):
  - CPU/memory usage
  - Connection count (used/max)
  - Query/write latency percentiles
  - Disk usage

  **`coroot-panel-response.json`** — Store-specific panel data (e.g., MongoDB WiredTiger):
  - Time series values for cache hit ratio, replication lag, slow queries

  > **IMPORTANT:** Read actual Coroot MCP `get_application` responses first (use `mcp__coroot__get_application` on a real project if available) to verify the response schema. If unavailable, model the fixture after common observability API patterns: `{ charts: { cpu: { series: [...] }, memory: { series: [...] } }, ... }`.

  > **NOTE:** These fixtures are synthetic. Before finalizing, validate against a real Coroot `get_application` response. If unavailable, mark fixtures with `// SYNTHETIC — validate against real Coroot response before shipping`.

  Commit: `[ABLP-2] test(sizing-calculator): add Coroot response fixtures for metric extraction tests`

- [ ] **Step 2: Write metric extractor tests — service metrics** (~4 min)

  Create `packages/sizing-calculator/src/__tests__/coroot-metric-extractors.test.ts`:

  ```typescript
  import { describe, it, expect } from 'vitest';
  import corootAppResponse from './fixtures/coroot-app-response.json';
  import {
    extractServiceMeasured,
    extractServiceLatency,
    extractRequestRate,
    extractErrorRate,
  } from '../engine/coroot-metric-extractors.js';

  describe('extractServiceMeasured', () => {
    it('extracts CPU peak/avg and memory peak/avg from app response', () => {
      const measured = extractServiceMeasured(corootAppResponse);
      expect(measured.cpuPeak).toMatch(/^\d+(\.\d+)?$/); // numeric string e.g. "1.8"
      expect(measured.cpuAvg).toMatch(/^\d+(\.\d+)?$/);
      expect(measured.memoryPeak).toMatch(/^\d+(\.\d+)?Gi$/); // e.g. "3.2Gi"
      expect(measured.memoryAvg).toMatch(/^\d+(\.\d+)?Gi$/);
      expect(typeof measured.podRestarts).toBe('number');
      expect(typeof measured.oomKills).toBe('number');
    });

    it('returns null fields when CPU/memory data is missing', () => {
      const measured = extractServiceMeasured({});
      expect(measured.cpuPeak).toBeNull();
      expect(measured.memoryPeak).toBeNull();
      expect(measured.podRestarts).toBe(0);
      expect(measured.oomKills).toBe(0);
    });
  });

  describe('extractServiceLatency', () => {
    it('extracts latency percentiles from app response', () => {
      const latency = extractServiceLatency(corootAppResponse);
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
    });
  });

  describe('extractRequestRate', () => {
    it('extracts inbound request rate for cross-validation', () => {
      const rps = extractRequestRate(corootAppResponse);
      expect(rps).toBeGreaterThan(0);
    });
  });

  describe('extractErrorRate', () => {
    it('extracts 5xx error rate for cross-validation', () => {
      const errorRate = extractErrorRate(corootAppResponse);
      expect(typeof errorRate).toBe('number');
      expect(errorRate).toBeGreaterThanOrEqual(0);
      expect(errorRate).toBeLessThanOrEqual(1); // fraction, not percentage
    });
  });
  ```

  Commit: `[ABLP-2] test(sizing-calculator): add service metric extractor tests`

- [ ] **Step 3: Implement service metric extractors** (~5 min)

  Create `packages/sizing-calculator/src/engine/coroot-metric-extractors.ts`:

  ```typescript
  import type { LatencyMetrics } from '../types/calibration.types.js';

  /** Measured resource fields for ServiceCapacity.measured */
  export interface ServiceMeasured {
    cpuPeak: string | null;
    cpuAvg: string | null;
    memoryPeak: string | null;
    memoryAvg: string | null;
    podRestarts: number;
    oomKills: number;
  }

  /**
   * Extracts CPU/memory peak+avg, pod restarts, and OOMKills from a
   * Coroot get_application response. All extraction is defensive —
   * missing paths yield null/0 instead of throwing.
   */
  export function extractServiceMeasured(response: unknown): ServiceMeasured {
    // Implementation: navigate the Coroot response structure defensively.
    // Use safeGet helper for nested property access.
    // CPU: find the cpu chart/series, compute peak (max) and avg across the time window.
    // Memory: same approach, convert bytes to Gi string.
    // Pod restarts: extract from health/restart count.
    // OOMKills: extract from events/conditions.
    // Return null for any field where data is not found.
  }

  export function extractServiceLatency(response: unknown): LatencyMetrics {
    // Extract p50/p95/p99/min/max from the latency chart in the response.
    // Return all-zeros when data is missing.
  }

  export function extractRequestRate(response: unknown): number {
    // Extract inbound RPS from the request rate chart.
    // Return 0 when data is missing.
  }

  export function extractErrorRate(response: unknown): number {
    // Extract 5xx error fraction from the error chart.
    // Return 0 when data is missing.
  }
  ```

  > **IMPORTANT:** Before implementing, READ the actual Coroot `get_application` response structure by examining the fixture created in Step 1. The Coroot API typically returns data in a `charts` or `widgets` structure with time series arrays. The exact path depends on the Coroot version — implement defensively with fallback paths.

  Run tests.

  Commit: `[ABLP-2] feat(sizing-calculator): implement service metric extractors from Coroot responses`

- [ ] **Step 4: Write metric extractor tests — data store metrics** (~4 min)

  Add to `coroot-metric-extractors.test.ts`:

  ```typescript
  import corootDatastoreResponse from './fixtures/coroot-datastore-response.json';
  import corootPanelResponse from './fixtures/coroot-panel-response.json';
  import {
    extractDataStoreResources,
    extractDataStoreLatency,
    extractDataStoreConnections,
    extractStoreSpecificMetrics,
    classifyDataSource,
  } from '../engine/coroot-metric-extractors.js';

  describe('extractDataStoreResources', () => {
    it('extracts CPU/memory/disk from data store app response', () => {
      const resources = extractDataStoreResources(corootDatastoreResponse);
      expect(resources.cpuPeak).not.toBeNull();
      expect(resources.memoryPeak).not.toBeNull();
      expect(typeof resources.diskUsageGB).toBe('number');
      expect(typeof resources.diskGrowthRateGBPerDay).toBe('number');
    });
  });

  describe('extractDataStoreLatency', () => {
    it('extracts query and write latency percentiles', () => {
      const latency = extractDataStoreLatency(corootDatastoreResponse);
      expect(latency.queryP50Ms).toBeGreaterThan(0);
      expect(latency.queryP95Ms).toBeGreaterThanOrEqual(latency.queryP50Ms);
      expect(latency.writeP50Ms).toBeGreaterThan(0);
    });
  });

  describe('extractDataStoreConnections', () => {
    it('extracts connection used/max/utilization', () => {
      const conns = extractDataStoreConnections(corootDatastoreResponse);
      expect(conns.used).toBeGreaterThan(0);
      expect(conns.max).toBeGreaterThan(0);
      expect(conns.utilizationPercent).toBeGreaterThanOrEqual(0);
      expect(conns.utilizationPercent).toBeLessThanOrEqual(100);
    });
  });

  describe('extractStoreSpecificMetrics', () => {
    it('extracts store-specific panel data for MongoDB', () => {
      const metrics = extractStoreSpecificMetrics('mongodb', corootPanelResponse);
      expect(metrics).toHaveProperty('wiredTigerCacheHitRatio');
    });

    it('returns empty object for unknown store type', () => {
      const metrics = extractStoreSpecificMetrics('unknown-store', corootPanelResponse);
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
  });
  ```

  Commit: `[ABLP-2] test(sizing-calculator): add data store metric extractor tests`

- [ ] **Step 5: Implement data store metric extractors** (~5 min)

  Add to `coroot-metric-extractors.ts`:

  ```typescript
  /** Data source classification per store — from design spec Section 9. */
  const STORE_DATA_SOURCE: Record<string, DataStoreCapacity['dataSource']> = {
    mongodb: 'coroot-native',
    redis: 'coroot-native',
    clickhouse: 'coroot-native',
    opensearch: 'coroot-tcp',
    qdrant: 'coroot-tcp',
    neo4j: 'coroot-tcp',
    restate: 'coroot-tcp',
  };

  export function classifyDataSource(
    storeName: string,
  ): DataStoreCapacity['dataSource'] {
    // Normalize name (e.g., "mongodb-primary" → "mongodb")
    const normalized = storeName.toLowerCase().replace(/-.*$/, '');
    return STORE_DATA_SOURCE[normalized] ?? 'coroot-tcp';
  }

  export function extractDataStoreResources(response: unknown): { ... } { /* ... */ }
  export function extractDataStoreLatency(response: unknown): { ... } { /* ... */ }
  export function extractDataStoreConnections(response: unknown): { ... } { /* ... */ }

  /**
   * Extracts store-specific metrics from get_panel_data response.
   * The metrics extracted depend on the store type:
   * - mongodb: wiredTigerCacheHitRatio, replicationLag, slowQueryCount, etc.
   * - redis: keyspaceHitRatio, evictionRate, blockedClients, etc.
   * - clickhouse: activeParts, mergeActivity, rejectedInserts, etc.
   * - opensearch/qdrant/neo4j: limited to what Coroot TCP-level provides
   */
  export function extractStoreSpecificMetrics(
    storeName: string,
    panelResponse: unknown,
  ): Record<string, number | string | boolean | null> { /* ... */ }
  ```

  Run tests.

  Commit: `[ABLP-2] feat(sizing-calculator): implement data store metric extractors with store-type classification`

---

## Task 4: collectServiceMetrics — Main Service Collection Function

**Files:**

- Modify: `packages/sizing-calculator/src/engine/coroot-collector.ts`
- Modify: `packages/sizing-calculator/src/__tests__/coroot-collector.test.ts`

This is the primary function the CLI orchestrator calls after each app service k6 test.

- [ ] **Step 1: Write collectServiceMetrics tests** (~4 min)

  Add to `coroot-collector.test.ts`:

  ```typescript
  import { collectServiceMetrics } from '../engine/coroot-collector.js';

  describe('collectServiceMetrics', () => {
    const timeRange: MetricTimeRange = { from: 1711324800, to: 1711328400 }; // 1 hour window

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
    });

    it('returns null measured fields when app not found in Coroot', async () => {
      const client = mockClient({
        getApplicationsOverview: vi.fn().mockResolvedValue({ applications: [] }),
      });

      const result = await collectServiceMetrics(client, 'runtime', timeRange, 'project-1');
      expect(result.success).toBe(false);
      expect(result.data).toBeNull();
      expect(result.error?.code).toBe('APP_NOT_FOUND');
    });

    it('returns null measured fields when Coroot is unreachable', async () => {
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
  ```

  Commit: `[ABLP-2] test(sizing-calculator): add collectServiceMetrics tests`

- [ ] **Step 2: Implement collectServiceMetrics** (~4 min)

  Add to `coroot-collector.ts`:

  ```typescript
  import {
    extractServiceMeasured,
    extractServiceLatency,
    extractRequestRate,
    extractErrorRate,
  } from './coroot-metric-extractors.js';

  /** Measured fields for a service — partial ServiceCapacity. */
  export interface ServiceMetricsResult {
    cpuPeak: string | null;
    cpuAvg: string | null;
    memoryPeak: string | null;
    memoryAvg: string | null;
    podRestarts: number;
    oomKills: number;
    latency: LatencyMetrics;
    /** Cross-validation: Coroot-observed RPS for comparison with k6 reported RPS. */
    observedRps: number;
    /** Cross-validation: Coroot-observed 5xx error rate (0-1 fraction). */
    observedErrorRate: number;
  }

  // Mapping to CalibrationProfile:
  //   result.data.cpuPeak → ServiceCapacity.measured.cpuPeak
  //   result.data.cpuAvg → ServiceCapacity.measured.cpuAvg
  //   result.data.memoryPeak → ServiceCapacity.measured.memoryPeak
  //   result.data.memoryAvg → ServiceCapacity.measured.memoryAvg
  //   result.data.podRestarts → ServiceCapacity.measured.podRestarts
  //   result.data.oomKills → ServiceCapacity.measured.oomKills
  //   result.data.latency → cross-validation (logged, not stored in CalibrationProfile)
  //   result.data.observedRps → cross-validation
  //   result.data.observedErrorRate → cross-validation

  /**
   * Collects service-level metrics from Coroot for a single app service.
   * Called after each k6 saturation test completes.
   *
   * Flow:
   * 1. Resolve service name → Coroot app ID
   * 2. Call get_application with the test time window
   * 3. Extract measured CPU/memory, latency, request rate, error rate
   * 4. Return partial ServiceCapacity.measured fields
   *
   * Graceful degradation: returns null data with error details if
   * Coroot is unreachable or the app is not found.
   */
  export async function collectServiceMetrics(
    client: CorootClient,
    serviceName: string,
    timeRange: MetricTimeRange,
    projectId: string,
  ): Promise<CollectorResult<ServiceMetricsResult>> {
    // 1. Resolve app ID
    const appIdResult = await resolveCorootAppId(client, serviceName, projectId);
    if (!appIdResult.success || !appIdResult.data) {
      return { success: false, data: null, error: appIdResult.error };
    }

    try {
      // 2. Fetch application data for the time window
      const appData = await client.getApplication({
        projectId,
        appId: appIdResult.data,
        fromTimestamp: timeRange.from,
        toTimestamp: timeRange.to,
      });

      // 3. Extract metrics
      const measured = extractServiceMeasured(appData);
      const latency = extractServiceLatency(appData);
      const observedRps = extractRequestRate(appData);
      const observedErrorRate = extractErrorRate(appData);

      return {
        success: true,
        data: { ...measured, latency, observedRps, observedErrorRate },
        error: undefined,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        error: {
          code: 'COROOT_FETCH_FAILED',
          message: `Failed to collect metrics for "${serviceName}": ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }
  ```

  Run tests.

  Commit: `[ABLP-2] feat(sizing-calculator): implement collectServiceMetrics orchestration`

---

## Task 5: collectDataStoreMetrics — Main Data Store Collection Function

**Files:**

- Modify: `packages/sizing-calculator/src/engine/coroot-collector.ts`
- Modify: `packages/sizing-calculator/src/__tests__/coroot-collector.test.ts`

Data stores require both `get_application` (for CPU/memory/connections) and optionally `get_panel_data` (for store-specific metrics like WiredTiger cache hit ratio).

- [ ] **Step 1: Write collectDataStoreMetrics tests** (~5 min)

  Add to `coroot-collector.test.ts`:

  ```typescript
  import { collectDataStoreMetrics } from '../engine/coroot-collector.js';

  describe('collectDataStoreMetrics', () => {
    const timeRange: MetricTimeRange = { from: 1711324800, to: 1711328400 };

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
      expect(result.data!.storeSpecific).toEqual({}); // degraded — no panel data
    });

    it('returns unavailable data source when Coroot is unreachable', async () => {
      const client = mockClient({
        getApplicationsOverview: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      });

      const result = await collectDataStoreMetrics(client, 'mongodb', timeRange, 'project-1');
      expect(result.success).toBe(false);
    });
  });
  ```

  Commit: `[ABLP-2] test(sizing-calculator): add collectDataStoreMetrics tests`

- [ ] **Step 2: Implement collectDataStoreMetrics** (~5 min)

  Add to `coroot-collector.ts`:

  ```typescript
  import {
    extractDataStoreResources,
    extractDataStoreLatency,
    extractDataStoreConnections,
    extractStoreSpecificMetrics,
    classifyDataSource,
  } from './coroot-metric-extractors.js';

  /** Partial DataStoreCapacity — everything except provisioned (which comes from k6 config). */
  export interface DataStoreMetricsResult {
    latency: DataStoreCapacity['latency'];
    connections: DataStoreCapacity['connections'];
    resources: DataStoreCapacity['resources'];
    storeSpecific: Record<string, number | string | boolean | null>;
    dataSource: DataStoreCapacity['dataSource'];
  }

  /** Dashboard IDs for store-specific panels in Coroot. */
  const STORE_DASHBOARD_CONFIG: Record<string, { dashboardId: string; panelIds: string[] }> = {
    mongodb: { dashboardId: 'mongodb', panelIds: ['wiredtiger', 'replication', 'operations'] },
    redis: { dashboardId: 'redis', panelIds: ['memory', 'clients', 'keyspace'] },
    clickhouse: { dashboardId: 'clickhouse', panelIds: ['parts', 'merges', 'queries'] },
  };

  /**
   * Collects data store metrics from Coroot.
   * Called after each data store k6 saturation test completes.
   *
   * Flow:
   * 1. Resolve store name → Coroot app ID
   * 2. Call get_application for CPU/memory/connections/latency
   * 3. If native-instrumented store, call get_panel_data for store-specific metrics
   * 4. Classify data source (coroot-native / coroot-tcp)
   * 5. Return partial DataStoreCapacity
   *
   * Graceful degradation:
   * - App data failure → full failure (no data)
   * - Panel data failure → partial success (storeSpecific = {})
   */
  export async function collectDataStoreMetrics(
    client: CorootClient,
    storeName: string,
    timeRange: MetricTimeRange,
    projectId: string,
  ): Promise<CollectorResult<DataStoreMetricsResult>> {
    // 1. Resolve app ID
    const appIdResult = await resolveCorootAppId(client, storeName, projectId);
    if (!appIdResult.success || !appIdResult.data) {
      return { success: false, data: null, error: appIdResult.error };
    }

    try {
      // 2. Fetch application data
      const appData = await client.getApplication({
        projectId,
        appId: appIdResult.data,
        fromTimestamp: timeRange.from,
        toTimestamp: timeRange.to,
      });

      const resources = extractDataStoreResources(appData);
      const latency = extractDataStoreLatency(appData);
      const connections = extractDataStoreConnections(appData);
      const dataSource = classifyDataSource(storeName);

      // 3. Fetch store-specific panel data (best-effort)
      let storeSpecific: Record<string, number | string | boolean | null> = {};
      const dashboardConfig = STORE_DASHBOARD_CONFIG[storeName.toLowerCase().replace(/-.*$/, '')];

      if (dashboardConfig) {
        try {
          const fromTime = new Date(timeRange.from * 1000).toISOString();
          const toTime = new Date(timeRange.to * 1000).toISOString();

          // Fetch all panels concurrently
          const panelResults = await Promise.allSettled(
            dashboardConfig.panelIds.map((panelId) =>
              client.getPanelData({
                projectId,
                dashboardId: dashboardConfig.dashboardId,
                panelId,
                fromTime,
                toTime,
              }),
            ),
          );

          // Merge results from all successful panels
          for (const result of panelResults) {
            if (result.status === 'fulfilled') {
              const extracted = extractStoreSpecificMetrics(storeName, result.value);
              storeSpecific = { ...storeSpecific, ...extracted };
            }
          }
        } catch {
          // Panel data is best-effort — storeSpecific stays {}
        }
      }

      return {
        success: true,
        data: { latency, connections, resources, storeSpecific, dataSource },
        error: undefined,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        error: {
          code: 'COROOT_FETCH_FAILED',
          message: `Failed to collect data store metrics for "${storeName}": ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }
  ```

  Run tests.

  Commit: `[ABLP-2] feat(sizing-calculator): implement collectDataStoreMetrics with panel data and graceful degradation`

---

## Task 6: Exports and Build Verification

**Files:**

- Create: `packages/sizing-calculator/src/engine/index.ts`
- Modify: `packages/sizing-calculator/src/index.ts`

- [ ] **Step 1: Export collector functions** (~2 min)

  Add to `packages/sizing-calculator/src/engine/index.ts`:

  ```typescript
  export {
    checkCorootHealth,
    resolveCorootAppId,
    collectServiceMetrics,
    collectDataStoreMetrics,
    clearAppIdCache,
  } from './coroot-collector.js';
  export type {
    CorootClient,
    CorootHealthResult,
    CollectorResult,
    MetricTimeRange,
    ServiceMetricsResult,
    DataStoreMetricsResult,
  } from './coroot-collector.js';
  export {
    extractServiceMeasured,
    extractServiceLatency,
    extractRequestRate,
    extractErrorRate,
    extractDataStoreResources,
    extractDataStoreLatency,
    extractDataStoreConnections,
    extractStoreSpecificMetrics,
    classifyDataSource,
  } from './coroot-metric-extractors.js';
  ```

  Ensure `packages/sizing-calculator/src/index.ts` re-exports from `./engine/index.js`.

  Commit: `[ABLP-2] feat(sizing-calculator): export coroot collector public API`

- [ ] **Step 2: Build and type-check** (~3 min)

  ```bash
  pnpm build --filter=@agent-platform/sizing-calculator
  ```

  Fix any type errors. Then run full test suite:

  ```bash
  pnpm vitest run --reporter=verbose packages/sizing-calculator/src/__tests__/coroot-collector.test.ts packages/sizing-calculator/src/__tests__/coroot-metric-extractors.test.ts
  ```

  Commit: `[ABLP-2] chore(sizing-calculator): verify coroot collector build and all tests pass`

---

## Summary

| Task      | What                                 | Files Created/Modified                                                        | Tests  | Est. Time   |
| --------- | ------------------------------------ | ----------------------------------------------------------------------------- | ------ | ----------- |
| 1         | CorootClient interface, health check | `coroot-collector.ts`, `coroot-collector.test.ts`                             | 2      | ~8 min      |
| 2         | resolveCorootAppId                   | `coroot-collector.ts`, `coroot-collector.test.ts`                             | 5      | ~7 min      |
| 3         | Metric extractor functions           | `coroot-metric-extractors.ts`, `coroot-metric-extractors.test.ts`, 3 fixtures | 10     | ~23 min     |
| 4         | collectServiceMetrics                | `coroot-collector.ts`, `coroot-collector.test.ts`                             | 4      | ~8 min      |
| 5         | collectDataStoreMetrics              | `coroot-collector.ts`, `coroot-collector.test.ts`                             | 5      | ~10 min     |
| 6         | Exports and build verification       | `engine/index.ts`, `index.ts`                                                 | —      | ~5 min      |
| **Total** |                                      | **4 new + 2 modified** files                                                  | **26** | **~61 min** |

### Integration Points for Plan 4 (CLI Orchestrator)

The CLI orchestrator (Plan 4) will:

1. Create a concrete `CorootClient` implementation that delegates to the MCP client's `mcp__coroot__*` tool calls
2. Call `checkCorootHealth()` before starting the benchmark loop
3. After each k6 service test: call `collectServiceMetrics()` and merge the result into the `CalibrationProfile.services[name].measured` fields
4. After each k6 data store test: call `collectDataStoreMetrics()` and merge the result into `CalibrationProfile.dataStores[name]`
5. Call `clearAppIdCache()` at the start of each benchmark run

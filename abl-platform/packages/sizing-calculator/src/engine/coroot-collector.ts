import type { DataStoreCapacity, LatencyMetrics } from '../types/calibration.types.js';

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
} from './coroot-metric-extractors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

/** Partial DataStoreCapacity — everything except provisioned (which comes from k6 config). */
export interface DataStoreMetricsResult {
  latency: DataStoreCapacity['latency'];
  connections: DataStoreCapacity['connections'];
  resources: DataStoreCapacity['resources'];
  storeSpecific: Record<string, number | string | boolean | null>;
  dataSource: DataStoreCapacity['dataSource'];
}

// ---------------------------------------------------------------------------
// App ID cache
// ---------------------------------------------------------------------------

// Cache: projectId -> Map<serviceName, appId>
// Max 50 entries (one per service per project), cleared between benchmark runs.
// TTL is implicitly bounded by `clearAppIdCache()` called at the start of each benchmark run.
const appIdCache = new Map<string, Map<string, string>>();
const APP_ID_CACHE_MAX = 50;

/** Clear the app ID cache — called at the start of each benchmark run. */
export function clearAppIdCache(): void {
  appIdCache.clear();
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// App ID resolution
// ---------------------------------------------------------------------------

/** Extracts application list from get_applications_overview response. */
function extractApplicationList(response: unknown): Array<{ id: string; name: string }> {
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
    return {
      success: true,
      data: projectCache.get(serviceName)!,
      error: undefined,
    };
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

// ---------------------------------------------------------------------------
// Service metrics collection
// ---------------------------------------------------------------------------

/**
 * Collects service-level metrics from Coroot for a single app service.
 * Called after each k6 saturation test completes.
 *
 * Flow:
 * 1. Resolve service name -> Coroot app ID
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

// ---------------------------------------------------------------------------
// Data store metrics collection
// ---------------------------------------------------------------------------

/** Dashboard IDs for store-specific panels in Coroot. */
const STORE_DASHBOARD_CONFIG: Record<string, { dashboardId: string; panelIds: string[] }> = {
  mongodb: {
    dashboardId: 'mongodb',
    panelIds: ['wiredtiger', 'replication', 'operations'],
  },
  redis: {
    dashboardId: 'redis',
    panelIds: ['memory', 'clients', 'keyspace'],
  },
  clickhouse: {
    dashboardId: 'clickhouse',
    panelIds: ['parts', 'merges', 'queries'],
  },
};

/**
 * Collects data store metrics from Coroot.
 * Called after each data store k6 saturation test completes.
 *
 * Flow:
 * 1. Resolve store name -> Coroot app ID
 * 2. Call get_application for CPU/memory/connections/latency
 * 3. If native-instrumented store, call get_panel_data for store-specific metrics
 * 4. Classify data source (coroot-native / coroot-tcp)
 * 5. Return partial DataStoreCapacity
 *
 * Graceful degradation:
 * - App data failure -> full failure (no data)
 * - Panel data failure -> partial success (storeSpecific = {})
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
    const normalizedStore = storeName.toLowerCase().replace(/-.*$/, '');
    const dashboardConfig = STORE_DASHBOARD_CONFIG[normalizedStore];

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

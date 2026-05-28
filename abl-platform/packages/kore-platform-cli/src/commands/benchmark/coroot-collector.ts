/**
 * Coroot REST API Client for Infra Metrics Collection
 *
 * Queries the Coroot observability platform for CPU, memory, pod restarts,
 * OOM kills, RPS, connection pool, and disk metrics over a given time window.
 *
 * Authentication: username/password login → session cookie.
 * Env vars: COROOT_BASE_URL, COROOT_USERNAME, COROOT_PASSWORD, COROOT_PROJECT_ID.
 */

import { SERVICE_REGISTRY } from './service-registry.js';

export interface CorootConfig {
  baseUrl: string;
  username: string;
  password: string;
  projectId: string;
}

export interface AppInfraMetrics {
  cpuPeak: string | null;
  cpuAvg: string | null;
  memoryPeak: string | null;
  memoryAvg: string | null;
  podRestarts: number;
  oomKills: number;
  observedRps: number;
  observedErrorRate: number;
}

export interface ConnectionBreakdownEntry {
  client: string;
  used: number;
  max: number;
}

export interface DataStoreInfraMetrics {
  connections: { used: number; max: number; utilizationPercent: number };
  connectionBreakdown: ConnectionBreakdownEntry[];
  resources: {
    cpuUsage: string | null;
    memoryUsage: string | null;
    diskUsageGB: number | null;
    diskGrowthRateGBPerDay: number | null;
  };
}

export interface DeploymentInfo {
  replicas: number;
  readyReplicas: number;
  cpuRequest: string | null;
  memoryRequest: string | null;
  cpuLimit: string | null;
  memoryLimit: string | null;
  kind: 'Deployment' | 'StatefulSet';
}

export interface ServiceInfraResult {
  infra?: AppInfraMetrics;
  dataStore?: DataStoreInfraMetrics;
  deployment?: DeploymentInfo;
}

export interface ServiceLatencyEntry {
  client: string;
  dataStore: string;
  requestLatencyMs: number | null;
  tcpLatencyMs: number | null;
  rps: number | null;
}

export interface NodeInfo {
  name: string;
  instanceType: string;
  pool: string;
  region: string;
  availabilityZone: string;
  cloudProvider: string;
  cpuCapacity: number;
  memoryCapacityGi: number;
  cpuAllocatable: number;
  memoryAllocatableGi: number;
  cpuUsagePercent: number;
  memoryUsagePercent: number;
}

export interface PodPlacement {
  service: string;
  pod: string;
  node: string;
  cpuRequest: string;
  cpuLimit: string;
  memoryRequest: string;
  memoryLimit: string;
}

export interface InfraMetricsFile {
  source: string;
  project: string;
  collectedAt: string;
  testWindow: { from: number; to: number };
  services: Record<string, ServiceInfraResult>;
  serviceLatency?: ServiceLatencyEntry[];
  nodes?: NodeInfo[];
  podPlacement?: PodPlacement[];
}

// ---------------------------------------------------------------------------
// Coroot API client
// ---------------------------------------------------------------------------

let sessionCookie = '';

async function corootLogin(config: CorootConfig): Promise<string> {
  const url = `${config.baseUrl}/api/login`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: config.username,
      password: config.password,
      action: 'login',
    }),
    redirect: 'manual',
  });

  if (!res.ok && res.status !== 302) {
    throw new Error(`Coroot login failed: ${res.status} ${res.statusText}`);
  }

  // Extract coroot_session from Set-Cookie
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = setCookie.match(/coroot_session=([^;]+)/);
  if (!match) {
    throw new Error('Coroot login succeeded but no session cookie received');
  }

  return match[1];
}

async function corootGet(
  config: CorootConfig,
  path: string,
  params?: Record<string, string>,
): Promise<unknown> {
  if (!sessionCookie) {
    sessionCookie = await corootLogin(config);
  }

  const url = new URL(path, config.baseUrl);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      Cookie: `coroot_session=${sessionCookie}`,
    },
  });

  if (res.status === 401) {
    // Session expired — re-login and retry once
    sessionCookie = await corootLogin(config);
    const retry = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        Cookie: `coroot_session=${sessionCookie}`,
      },
    });
    if (!retry.ok) {
      throw new Error(`Coroot API error after re-login: ${retry.status}`);
    }
    return retry.json();
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `Coroot API error: ${res.status} ${res.statusText}${detail ? ` — ${detail.substring(0, 200)}` : ''}`,
    );
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Metric extraction helpers
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Extract a numeric metric from Coroot's widget/chart response structure.
 * Coroot returns metrics in various nested formats — this tries common paths.
 */
function extractNumeric(data: any, ...keys: string[]): number | null {
  if (!data) return null;
  for (const key of keys) {
    const val = data[key];
    if (typeof val === 'number') return val;
    if (typeof val === 'string') {
      const num = parseFloat(val);
      if (!Number.isNaN(num)) return num;
    }
  }
  return null;
}

function formatCpuMillicores(cores: number | null): string | null {
  if (cores === null) return null;
  if (cores < 1) return `${Math.round(cores * 1000)}m`;
  return `${cores.toFixed(2)} cores`;
}

function formatMemoryBytes(bytes: number | null): string | null {
  if (bytes === null) return null;
  const mi = bytes / (1024 * 1024);
  if (mi >= 1024) return `${(mi / 1024).toFixed(1)}Gi`;
  return `${Math.round(mi)}Mi`;
}

/**
 * Get the reports array from a Coroot app response.
 *
 * Coroot's /api/project/{id}/app/{appId} returns:
 *   { context: {...}, data: { app_map: {...}, reports: [...] } }
 *
 * Each report has: { name: "CPU"|"Memory"|"SLO"|..., widgets: [...] }
 * Each widget may contain a chart_group: { title, charts: [{ title, series: [{ name, data, value }] }] }
 * Series data is a flat number[] (not [timestamp, value] pairs).
 */
function getReports(appData: any): any[] {
  const reports = appData?.data?.reports ?? appData?.reports ?? [];
  return Array.isArray(reports) ? reports : [];
}

/**
 * Extract numeric time-series values from all series across all charts in a widget's chart_group.
 * Aggregates across pods by summing values at each time point, then returns peak/avg.
 */
function extractChartGroupStats(
  widget: any,
  chartTitleFilter?: string,
): { peak: number; avg: number } | null {
  const cg = widget?.chart_group;
  if (!cg) return null;

  const charts: any[] = cg.charts ?? [];
  // Prefer the "total" chart if available, otherwise aggregate all charts
  const targetCharts = chartTitleFilter
    ? charts.filter((c: any) => (c.title ?? '').toLowerCase().includes(chartTitleFilter))
    : charts;
  if (targetCharts.length === 0) return null;

  // Collect all numeric values across all matching series
  const allValues: number[] = [];
  for (const chart of targetCharts) {
    for (const series of chart.series ?? []) {
      const data: any[] = series.data ?? [];
      for (const v of data) {
        const num = Array.isArray(v) ? v[1] : v;
        if (typeof num === 'number' && !Number.isNaN(num)) {
          allValues.push(num);
        }
      }
    }
  }

  if (allValues.length === 0) return null;
  const peak = Math.max(...allValues);
  const avg = allValues.reduce((a: number, b: number) => a + b, 0) / allValues.length;
  return { peak, avg };
}

/**
 * Parse Coroot application response into infra metrics.
 *
 * Coroot's actual response structure (v1.18+):
 *   appData.data.reports[] — array of { name, widgets[] }
 *   widget.chart_group.charts[].series[].data — flat number[]
 */
function parseAppMetrics(appData: any): AppInfraMetrics {
  const metrics: AppInfraMetrics = {
    cpuPeak: null,
    cpuAvg: null,
    memoryPeak: null,
    memoryAvg: null,
    podRestarts: 0,
    oomKills: 0,
    observedRps: 0,
    observedErrorRate: 0,
  };

  if (!appData) return metrics;

  const reports = getReports(appData);
  for (const report of reports) {
    const reportName = (report.name ?? '').toLowerCase();
    const widgets: any[] = report.widgets ?? [];

    if (reportName === 'cpu') {
      // First widget is "CPU usage", prefer the "total" chart
      // Exclude "Node CPU usage" which is host-level, not pod-level
      for (const w of widgets) {
        const cgTitle = (w.chart_group?.title ?? '').toLowerCase();
        if (!cgTitle.includes('cpu usage') || cgTitle.includes('node')) continue;
        const stats = extractChartGroupStats(w, 'total');
        if (stats) {
          metrics.cpuPeak = formatCpuMillicores(stats.peak);
          metrics.cpuAvg = formatCpuMillicores(stats.avg);
          break;
        }
      }
    }

    if (reportName === 'memory') {
      // First widget is "Memory usage", look for RSS total or any usage chart
      // Exclude "Memory consumers" which is node-level
      for (const w of widgets) {
        const cgTitle = (w.chart_group?.title ?? '').toLowerCase();
        if (!cgTitle.includes('memory usage')) continue;
        // Try "total" chart first, then fall back to aggregating all RSS charts
        const stats = extractChartGroupStats(w, 'total') ?? extractChartGroupStats(w);
        if (stats) {
          metrics.memoryPeak = formatMemoryBytes(stats.peak);
          metrics.memoryAvg = formatMemoryBytes(stats.avg);
          break;
        }
      }
    }

    if (reportName === 'instances') {
      // Instances report may have restart/OOM info in table rows
      for (const w of widgets) {
        const table = w.table;
        if (!table) continue;
        const rows: any[] = table.rows ?? [];
        let restarts = 0;
        let ooms = 0;
        for (const row of rows) {
          const cells: any[] = row.cells ?? row;
          if (Array.isArray(cells)) {
            for (const cell of cells) {
              const text = (cell.text ?? cell.value ?? '').toString().toLowerCase();
              if (text.includes('restart')) {
                const val = parseInt(text.replace(/\D/g, ''), 10);
                if (!Number.isNaN(val)) restarts += val;
              }
              if (text.includes('oom')) {
                const val = parseInt(text.replace(/\D/g, ''), 10);
                if (!Number.isNaN(val)) ooms += val;
              }
            }
          }
        }
        if (restarts > 0) metrics.podRestarts = restarts;
        if (ooms > 0) metrics.oomKills = ooms;
      }
    }

    if (reportName === 'slo') {
      // SLO report has "Requests ... per second" and "Errors, per second" charts.
      // Each series is a latency bucket; sum their averages for total RPS.
      for (const w of widgets) {
        const chart = w.chart;
        if (!chart) continue;
        const chartTitle = (chart.title ?? '').toLowerCase();
        if (chartTitle.includes('request') && chartTitle.includes('per second')) {
          let totalRps = 0;
          for (const s of chart.series ?? []) {
            const sName = (s.name ?? '').toLowerCase();
            if (sName === 'errors') continue; // skip error series in request chart
            const values: number[] = (s.data ?? []).filter(
              (v: any) => typeof v === 'number' && !Number.isNaN(v),
            );
            if (values.length > 0) {
              totalRps += values.reduce((a: number, b: number) => a + b, 0) / values.length;
            }
          }
          if (totalRps > 0) {
            metrics.observedRps = Math.round(totalRps * 10) / 10;
          }
        }
        if (chartTitle.includes('error') && chartTitle.includes('per second')) {
          let totalErrors = 0;
          for (const s of chart.series ?? []) {
            const values: number[] = (s.data ?? []).filter(
              (v: any) => typeof v === 'number' && !Number.isNaN(v),
            );
            if (values.length > 0) {
              totalErrors += values.reduce((a: number, b: number) => a + b, 0) / values.length;
            }
          }
          if (totalErrors > 0) {
            metrics.observedErrorRate = Math.round(totalErrors * 100) / 100;
          }
        }
      }
    }
  }

  return metrics;
}

function parseDataStoreMetrics(appData: any): DataStoreInfraMetrics {
  const ds: DataStoreInfraMetrics = {
    connections: { used: 0, max: 0, utilizationPercent: 0 },
    connectionBreakdown: [],
    resources: {
      cpuUsage: null,
      memoryUsage: null,
      diskUsageGB: null,
      diskGrowthRateGBPerDay: null,
    },
  };

  if (!appData) return ds;

  const reports = getReports(appData);
  for (const report of reports) {
    const reportName = (report.name ?? '').toLowerCase();
    const widgets: any[] = report.widgets ?? [];

    if (reportName === 'cpu') {
      for (const w of widgets) {
        const cgTitle = (w.chart_group?.title ?? '').toLowerCase();
        // Match "CPU usage" but exclude "Node CPU usage" (host-level)
        if (!cgTitle.includes('cpu usage') || cgTitle.includes('node')) continue;
        const stats = extractChartGroupStats(w, 'total') ?? extractChartGroupStats(w);
        if (stats) {
          ds.resources.cpuUsage = formatCpuMillicores(stats.avg);
          break;
        }
      }
    }

    if (reportName === 'memory') {
      for (const w of widgets) {
        const cgTitle = (w.chart_group?.title ?? '').toLowerCase();
        if (!cgTitle.includes('memory usage')) continue;
        const stats = extractChartGroupStats(w, 'total') ?? extractChartGroupStats(w);
        if (stats) {
          ds.resources.memoryUsage = formatMemoryBytes(stats.avg);
          break;
        }
      }
    }

    // Net report: "Active TCP connections" chart has connection counts
    if (reportName === 'net') {
      for (const w of widgets) {
        const chart = w.chart;
        if (!chart) continue;
        const chartTitle = (chart.title ?? '').toLowerCase();
        if (!chartTitle.includes('active') || !chartTitle.includes('connection')) continue;

        // Sum connections across all series (each series is a peer connection)
        let totalConnections = 0;
        for (const s of chart.series ?? []) {
          const values: number[] = (s.data ?? []).filter(
            (v: any) => typeof v === 'number' && !Number.isNaN(v),
          );
          if (values.length > 0) {
            const avg = values.reduce((a: number, b: number) => a + b, 0) / values.length;
            totalConnections += Math.round(avg);
          }
        }
        if (totalConnections > 0) {
          ds.connections.used = totalConnections;
        }
      }
    }

    // Net report: "Active TCP connections" shows inbound connections to this data store.
    // used = avg across the window, max = peak across the window.
    if (reportName === 'net') {
      for (const w of widgets) {
        const chart = w.chart;
        if (!chart) continue;
        const chartTitle = (chart.title ?? '').toLowerCase();
        if (!chartTitle.includes('active') || !chartTitle.includes('connection')) continue;

        let peakConns = 0;
        let avgConns = 0;
        for (const s of chart.series ?? []) {
          const values: number[] = (s.data ?? []).filter(
            (v: any) => typeof v === 'number' && !Number.isNaN(v),
          );
          if (values.length > 0) {
            const seriesMax = Math.max(...values);
            const seriesAvg = values.reduce((a: number, b: number) => a + b, 0) / values.length;
            peakConns += seriesMax;
            avgConns += seriesAvg;
          }
        }
        if (avgConns > 0) {
          ds.connections.used = Math.round(avgConns);
          ds.connections.max = Math.round(peakConns);
        }
      }
    }

    // Storage report: "Disk space" chart_group has disk usage in bytes
    if (reportName === 'storage') {
      for (const w of widgets) {
        const cgTitle = (w.chart_group?.title ?? '').toLowerCase();
        if (!cgTitle.includes('disk space')) continue;
        const stats = extractChartGroupStats(w);
        if (stats) {
          ds.resources.diskUsageGB = Math.round((stats.avg / (1024 * 1024 * 1024)) * 100) / 100;
          break;
        }
      }
    }
  }

  return ds;
}

/**
 * Extract TCP connection counts to a specific data store from a client app's Net report.
 *
 * Some data stores (Redis/DatabaseCluster, Clickhouse) don't have their own Net report
 * in Coroot. Their connection counts are only visible from the CLIENT side — e.g.,
 * the runtime app's Net report shows "→abl-platform-dev-redis: avg=37, max=37".
 *
 * This function parses the client's "Active TCP connections" chart and filters
 * series whose name contains the target data store's deployment name.
 */
function extractClientConnectionsToDataStore(
  clientAppData: any,
  targetDeploymentName: string,
): { used: number; max: number } | null {
  const reports = getReports(clientAppData);
  for (const report of reports) {
    const reportName = (report.name ?? '').toLowerCase();
    if (reportName !== 'net') continue;

    for (const w of report.widgets ?? []) {
      const chart = w.chart;
      if (!chart) continue;
      const chartTitle = (chart.title ?? '').toLowerCase();
      if (!chartTitle.includes('active') || !chartTitle.includes('connection')) continue;

      let totalAvg = 0;
      let totalPeak = 0;
      for (const s of chart.series ?? []) {
        const seriesName = (s.name ?? '').toLowerCase();
        if (!seriesName.includes(targetDeploymentName.toLowerCase())) continue;

        const values: number[] = (s.data ?? []).filter(
          (v: any) => typeof v === 'number' && !Number.isNaN(v),
        );
        if (values.length > 0) {
          const seriesAvg = values.reduce((a: number, b: number) => a + b, 0) / values.length;
          const seriesMax = Math.max(...values);
          totalAvg += seriesAvg;
          totalPeak += seriesMax;
        }
      }

      if (totalAvg > 0 || totalPeak > 0) {
        return { used: Math.round(totalAvg), max: Math.round(totalPeak) };
      }
    }
  }
  return null;
}

/**
 * Extract per-client request latency and RPS from a data store's SLO table.
 *
 * Coroot's SLO report for data stores has a table with columns:
 *   [Client, (status icon), Requests (rps), Latency (ms), Errors]
 * Returns one entry per client with request latency and RPS.
 */
function extractSloClientTable(
  dataStoreAppData: any,
): Array<{ client: string; requestLatencyMs: number; rps: number }> {
  const results: Array<{ client: string; requestLatencyMs: number; rps: number }> = [];
  const reports = getReports(dataStoreAppData);
  for (const report of reports) {
    if ((report.name ?? '').toLowerCase() !== 'slo') continue;
    for (const w of report.widgets ?? []) {
      const table = w.table;
      if (!table) continue;
      for (const row of table.rows ?? []) {
        const cells: any[] = row.cells ?? row;
        if (!Array.isArray(cells) || cells.length < 4) continue;
        const clientRaw =
          typeof cells[0] === 'string'
            ? cells[0]
            : (cells[0]?.value ?? cells[0]?.text ?? '').toString();
        if (!clientRaw) continue;
        const rpsVal = parseFloat(
          typeof cells[2] === 'string'
            ? cells[2]
            : (cells[2]?.value ?? cells[2]?.text ?? '').toString(),
        );
        const latVal = parseFloat(
          typeof cells[3] === 'string'
            ? cells[3]
            : (cells[3]?.value ?? cells[3]?.text ?? '').toString(),
        );
        if (clientRaw.includes('kubelet') || clientRaw.includes('kube-')) continue;
        results.push({
          client: clientRaw,
          requestLatencyMs: Number.isNaN(latVal) ? 0 : latVal,
          rps: Number.isNaN(rpsVal) ? 0 : rpsVal,
        });
      }
    }
  }
  return results;
}

/**
 * Extract TCP connection latency from a client app's Net report to all destinations.
 *
 * Returns a map of destination deployment name → { avgMs, maxMs }.
 */
function extractTcpLatencies(clientAppData: any): Map<string, { avgMs: number; maxMs: number }> {
  const result = new Map<string, { avgMs: number; maxMs: number }>();
  const reports = getReports(clientAppData);
  for (const report of reports) {
    if ((report.name ?? '').toLowerCase() !== 'net') continue;
    for (const w of report.widgets ?? []) {
      const chart = w.chart;
      if (!chart) continue;
      const chartTitle = (chart.title ?? '').toLowerCase();
      if (!chartTitle.includes('tcp connection latency')) continue;
      for (const s of chart.series ?? []) {
        const seriesName: string = s.name ?? '';
        // Series names look like "→abl-platform-dev-redis" or "→some-host:443"
        const cleanName = seriesName.replace(/^→/, '').trim();
        if (!cleanName) continue;
        const values: number[] = (s.data ?? []).filter(
          (v: any) => typeof v === 'number' && !Number.isNaN(v) && v > 0,
        );
        if (values.length === 0) continue;
        const avgSec = values.reduce((a: number, b: number) => a + b, 0) / values.length;
        const maxSec = Math.max(...values);
        result.set(cleanName.toLowerCase(), {
          avgMs: Math.round(avgSec * 1000 * 100) / 100,
          maxMs: Math.round(maxSec * 1000 * 100) / 100,
        });
      }
    }
  }
  return result;
}

/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Map of service registry names → Coroot app IDs.
 *
 * Coroot app IDs follow the pattern: projectId:namespace:kind:name.
 * The namespace is configurable via the `namespace` parameter.
 */
function buildCorootAppId(
  deploymentName: string,
  namespace: string,
  kind: string,
  projectId: string,
): string {
  return `${projectId}:${namespace}:${kind}:${deploymentName}`;
}

/** Data store kinds in Coroot */
const DATA_STORE_SERVICES = new Set([
  'mongodb',
  'redis',
  'clickhouse',
  'opensearch',
  'qdrant',
  'neo4j',
  'restate',
]);

/**
 * Check if Coroot is reachable and credentials are valid.
 */
export async function checkCorootHealth(
  config: CorootConfig,
): Promise<{ healthy: boolean; error?: string }> {
  try {
    sessionCookie = await corootLogin(config);
    return { healthy: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { healthy: false, error: message };
  }
}

/**
 * Collect infra metrics from Coroot for all specified services over a time window.
 */
export async function collectCorootMetrics(
  config: CorootConfig,
  services: Array<{ name: string; deploymentName: string; category: string }>,
  fromTimestamp: number,
  toTimestamp: number,
  namespace: string,
): Promise<InfraMetricsFile> {
  const result: InfraMetricsFile = {
    source: 'coroot',
    project: config.projectId,
    collectedAt: new Date().toISOString(),
    testWindow: { from: fromTimestamp, to: toTimestamp },
    services: {},
  };

  // Coroot API expects timestamps in milliseconds
  const fromMs = fromTimestamp;
  const toMs = toTimestamp;

  for (const svc of services) {
    const isDataStore = DATA_STORE_SERVICES.has(svc.name);
    // Coroot uses specific kind names that may differ from Kubernetes kinds
    let kind: string;
    let deployName = svc.deploymentName;
    if (svc.name === 'redis') {
      kind = 'DatabaseCluster';
    } else if (svc.name === 'clickhouse') {
      kind = 'StatefulSet';
      // Coroot indexes clickhouse with shard suffix
      deployName = `${svc.deploymentName}-shard-0`;
    } else if (isDataStore) {
      kind = 'StatefulSet';
    } else {
      kind = 'Deployment';
    }
    const appId = buildCorootAppId(deployName, namespace, kind, config.projectId);

    try {
      const appData = await corootGet(config, `/api/project/${config.projectId}/app/${appId}`, {
        from: String(fromMs),
        to: String(toMs),
      });

      const entry: ServiceInfraResult = {};

      if (isDataStore) {
        entry.dataStore = parseDataStoreMetrics(appData);
        // Supplement with parseAppMetrics only if dataStore parser missed values
        const appMetrics = parseAppMetrics(appData);
        if (!entry.dataStore.resources.cpuUsage && appMetrics.cpuPeak) {
          entry.dataStore.resources.cpuUsage = appMetrics.cpuPeak;
        }
        if (!entry.dataStore.resources.memoryUsage && appMetrics.memoryPeak) {
          entry.dataStore.resources.memoryUsage = appMetrics.memoryPeak;
        }
      } else {
        entry.infra = parseAppMetrics(appData);
      }

      result.services[svc.name] = entry;
      process.stdout.write(`    ${svc.name}: Coroot metrics collected\n`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`    ${svc.name}: Coroot metrics failed (${message})\n`);
    }
  }

  // ---------------------------------------------------------------------------
  // Second pass: query ALL compute services for connection counts + TCP latencies.
  // Many data stores (Redis, Clickhouse, neo4j, opensearch) don't have their own Net report —
  // connection counts and TCP latencies are only visible from the CLIENT side.
  // ---------------------------------------------------------------------------
  const allClientDeployments = Object.entries(SERVICE_REGISTRY)
    .filter(([name]) => !DATA_STORE_SERVICES.has(name))
    .map(([name, entry]) => ({ name, deploymentName: entry.deploymentName }));

  // All data stores need connection breakdown (per-client detail).
  // Data stores with zero totals also need connection totals accumulated from client side.
  const allDataStores = services.filter(
    (svc) => DATA_STORE_SERVICES.has(svc.name) && result.services[svc.name]?.dataStore,
  );
  const dataStoresNeedingTotals = new Set(
    allDataStores
      .filter(
        (svc) =>
          result.services[svc.name].dataStore!.connections.used === 0 ||
          result.services[svc.name].dataStore!.connections.max === 0,
      )
      .map((svc) => svc.name),
  );

  // Cache client app data so we fetch each client once (used for connections + latency)
  const clientAppDataCache = new Map<string, unknown>();

  if (allDataStores.length > 0) {
    for (const clientSvc of allClientDeployments) {
      const clientAppId = buildCorootAppId(
        clientSvc.deploymentName,
        namespace,
        'Deployment',
        config.projectId,
      );

      try {
        const clientAppData = await corootGet(
          config,
          `/api/project/${config.projectId}/app/${clientAppId}`,
          { from: String(fromMs), to: String(toMs) },
        );
        clientAppDataCache.set(clientSvc.name, clientAppData);

        for (const dsSvc of allDataStores) {
          const dsEntry = result.services[dsSvc.name]?.dataStore;
          if (!dsEntry) continue;

          let targetName = dsSvc.deploymentName;
          if (dsSvc.name === 'clickhouse') {
            targetName = `${dsSvc.deploymentName}-shard-0`;
          }

          const conns = extractClientConnectionsToDataStore(clientAppData, targetName);
          if (conns) {
            // Only accumulate totals for data stores that had zero from their own report
            if (dataStoresNeedingTotals.has(dsSvc.name)) {
              dsEntry.connections.used += conns.used;
              dsEntry.connections.max += conns.max;
            }
            dsEntry.connectionBreakdown.push({
              client: clientSvc.name,
              used: conns.used,
              max: conns.max,
            });
            process.stdout.write(
              `    ${dsSvc.name}: connections from ${clientSvc.name} — used=${conns.used}, max=${conns.max}\n`,
            );
          }
        }
      } catch {
        // Client app not found or error — skip silently
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Third pass: collect service-to-datastore latency breakdown.
  // Source 1: data store SLO table → per-client request latency + RPS
  // Source 2: client Net report → TCP connection latency to each destination
  // ---------------------------------------------------------------------------
  const latencyEntries: ServiceLatencyEntry[] = [];
  const dataStoreServices = services.filter((svc) => DATA_STORE_SERVICES.has(svc.name));

  // Collect SLO client tables from each data store (request latency + RPS)
  // We already fetched data store app data in the first pass — re-fetch for SLO parsing
  const sloByDataStore = new Map<
    string,
    Array<{ client: string; requestLatencyMs: number; rps: number }>
  >();
  for (const dsSvc of dataStoreServices) {
    let kind: string;
    let deployName = dsSvc.deploymentName;
    if (dsSvc.name === 'redis') {
      kind = 'DatabaseCluster';
    } else if (dsSvc.name === 'clickhouse') {
      kind = 'StatefulSet';
      deployName = `${dsSvc.deploymentName}-shard-0`;
    } else {
      kind = 'StatefulSet';
    }
    const appId = buildCorootAppId(deployName, namespace, kind, config.projectId);
    try {
      const dsAppData = await corootGet(config, `/api/project/${config.projectId}/app/${appId}`, {
        from: String(fromMs),
        to: String(toMs),
      });
      const clients = extractSloClientTable(dsAppData);
      if (clients.length > 0) {
        sloByDataStore.set(dsSvc.name, clients);
        process.stdout.write(`    ${dsSvc.name}: SLO table — ${clients.length} client(s)\n`);
      } else {
        process.stderr.write(`    ${dsSvc.name}: SLO table empty (appId=${appId})\n`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`    ${dsSvc.name}: SLO fetch failed — ${message} (appId=${appId})\n`);
    }
  }

  // Collect TCP latencies from each client service
  // Fetch client data for any clients not already cached
  for (const clientSvc of allClientDeployments) {
    if (!clientAppDataCache.has(clientSvc.name)) {
      const clientAppId = buildCorootAppId(
        clientSvc.deploymentName,
        namespace,
        'Deployment',
        config.projectId,
      );
      try {
        const clientAppData = await corootGet(
          config,
          `/api/project/${config.projectId}/app/${clientAppId}`,
          { from: String(fromMs), to: String(toMs) },
        );
        clientAppDataCache.set(clientSvc.name, clientAppData);
      } catch {
        // Skip
      }
    }
  }

  // Build the deployment name → service name mapping for data stores
  const dsDeployToName = new Map<string, string>();
  for (const dsSvc of dataStoreServices) {
    dsDeployToName.set(dsSvc.deploymentName.toLowerCase(), dsSvc.name);
    if (dsSvc.name === 'clickhouse') {
      dsDeployToName.set(`${dsSvc.deploymentName}-shard-0`.toLowerCase(), dsSvc.name);
    }
  }

  // Merge: for each client × data store pair, combine SLO latency + TCP latency
  const seenPairs = new Set<string>();
  for (const clientSvc of allClientDeployments) {
    const clientAppData = clientAppDataCache.get(clientSvc.name);
    const tcpLatencies = clientAppData ? extractTcpLatencies(clientAppData) : new Map();

    for (const dsSvc of dataStoreServices) {
      const pairKey = `${clientSvc.name}→${dsSvc.name}`;
      if (seenPairs.has(pairKey)) continue;

      // Find SLO entry matching this client → data store
      const sloClients = sloByDataStore.get(dsSvc.name) ?? [];
      const sloEntry = sloClients.find((c) =>
        c.client.toLowerCase().includes(clientSvc.deploymentName.toLowerCase()),
      );

      // Find TCP latency from this client to the data store
      let tcpEntry: { avgMs: number; maxMs: number } | undefined;
      for (const [dest, lat] of tcpLatencies) {
        if (dest.includes(dsSvc.deploymentName.toLowerCase())) {
          tcpEntry = lat;
          break;
        }
      }

      // Only include pairs where at least one latency source exists
      if (sloEntry || tcpEntry) {
        seenPairs.add(pairKey);
        latencyEntries.push({
          client: clientSvc.name,
          dataStore: dsSvc.name,
          requestLatencyMs: sloEntry?.requestLatencyMs ?? null,
          tcpLatencyMs: tcpEntry?.avgMs ?? null,
          rps: sloEntry?.rps ?? null,
        });
      }
    }
  }

  if (latencyEntries.length > 0) {
    result.serviceLatency = latencyEntries;
    process.stdout.write(
      `    Latency breakdown: ${latencyEntries.length} client→datastore pairs\n`,
    );
  }

  return result;
}

/**
 * Load Coroot config from environment variables.
 * Returns null if required vars are missing.
 */
export function loadCorootConfig(): CorootConfig | null {
  const baseUrl = process.env.COROOT_BASE_URL;
  const username = process.env.COROOT_USERNAME;
  const password = process.env.COROOT_PASSWORD;
  const projectId = process.env.COROOT_PROJECT_ID;

  if (!baseUrl || !username || !password || !projectId) {
    return null;
  }

  return { baseUrl: baseUrl.replace(/\/$/, ''), username, password, projectId };
}

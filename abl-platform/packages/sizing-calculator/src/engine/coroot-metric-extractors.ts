// SYNTHETIC — validate against real Coroot response before shipping.

import type { LatencyMetrics, DataStoreCapacity } from '../types/calibration.types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safely access a nested property path on an unknown object. */
function safeGet(obj: unknown, ...keys: string[]): unknown {
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Extract numeric time-series data from a Coroot chart series. */
function extractTimeSeries(series: unknown): Array<[number, number]> {
  if (!Array.isArray(series)) return [];
  return series.filter(
    (point): point is [number, number] =>
      Array.isArray(point) &&
      point.length >= 2 &&
      typeof point[0] === 'number' &&
      typeof point[1] === 'number',
  );
}

/** Find a chart within a report's widgets by title substring. */
function findChart(
  report: unknown,
  titleSubstring: string,
): { series: Array<{ name: string; data: Array<[number, number]> }> } | null {
  const widgets = safeGet(report, 'widgets');
  if (!Array.isArray(widgets)) return null;

  for (const widget of widgets) {
    const chart = safeGet(widget, 'chart');
    if (!chart || typeof chart !== 'object') continue;

    const title = safeGet(chart, 'title');
    if (typeof title === 'string' && title.toLowerCase().includes(titleSubstring.toLowerCase())) {
      const rawSeries = safeGet(chart, 'series');
      if (!Array.isArray(rawSeries)) return null;

      const parsed = rawSeries
        .filter(
          (s): s is { name: string; data: unknown } =>
            typeof s === 'object' &&
            s !== null &&
            typeof (s as Record<string, unknown>).name === 'string',
        )
        .map((s) => ({
          name: s.name,
          data: extractTimeSeries((s as Record<string, unknown>).data),
        }));

      return { series: parsed };
    }
  }
  return null;
}

/** Find a named series within a chart. */
function findSeries(
  chart: { series: Array<{ name: string; data: Array<[number, number]> }> } | null,
  seriesName: string,
): Array<[number, number]> {
  if (!chart) return [];
  const s = chart.series.find((item) => item.name.toLowerCase() === seriesName.toLowerCase());
  return s?.data ?? [];
}

/** Compute peak (max) of a time-series values. */
function peak(data: Array<[number, number]>): number {
  if (data.length === 0) return 0;
  return Math.max(...data.map((d) => d[1]));
}

/** Compute average of a time-series values. */
function avg(data: Array<[number, number]>): number {
  if (data.length === 0) return 0;
  const sum = data.reduce((acc, d) => acc + d[1], 0);
  return sum / data.length;
}

/** Convert bytes to Gi string (e.g., "3.2Gi"). */
function bytesToGi(bytes: number): string {
  const gi = bytes / (1024 * 1024 * 1024);
  return `${parseFloat(gi.toFixed(1))}Gi`;
}

/** Format CPU cores to string (e.g., "1.8"). */
function formatCpu(cores: number): string {
  return parseFloat(cores.toFixed(2)).toString();
}

/** Convert seconds to milliseconds. */
function secToMs(sec: number): number {
  return Math.round(sec * 1000 * 100) / 100;
}

// ---------------------------------------------------------------------------
// Service metric extractors
// ---------------------------------------------------------------------------

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
  const reports = safeGet(response, 'reports');

  // CPU
  const cpuReport = safeGet(reports, 'CPU');
  const cpuChart = findChart(cpuReport, 'CPU usage');
  const cpuData =
    findSeries(cpuChart, 'usage').length > 0
      ? findSeries(cpuChart, 'usage')
      : (cpuChart?.series[0]?.data ?? []);

  const cpuPeak = cpuData.length > 0 ? formatCpu(peak(cpuData)) : null;
  const cpuAvg = cpuData.length > 0 ? formatCpu(avg(cpuData)) : null;

  // Memory
  const memReport = safeGet(reports, 'Memory');
  const memChart = findChart(memReport, 'Memory usage');
  const memData =
    findSeries(memChart, 'RSS').length > 0
      ? findSeries(memChart, 'RSS')
      : (memChart?.series[0]?.data ?? []);

  const memoryPeak = memData.length > 0 ? bytesToGi(peak(memData)) : null;
  const memoryAvg = memData.length > 0 ? bytesToGi(avg(memData)) : null;

  // Pod restarts
  const healthReport = safeGet(reports, 'Health');
  const restartChart = findChart(healthReport, 'Restarts');
  const restartData =
    findSeries(restartChart, 'restarts').length > 0
      ? findSeries(restartChart, 'restarts')
      : (restartChart?.series[0]?.data ?? []);
  const podRestarts = restartData.reduce((sum, d) => sum + d[1], 0);

  // OOMKills
  let oomKills = 0;
  const healthChecks = safeGet(healthReport, 'checks');
  if (Array.isArray(healthChecks)) {
    for (const check of healthChecks) {
      if (
        typeof check === 'object' &&
        check !== null &&
        (check as Record<string, unknown>).id === 'oom_kills'
      ) {
        const val = (check as Record<string, unknown>).value;
        if (typeof val === 'number') {
          oomKills = val;
        }
      }
    }
  }

  return { cpuPeak, cpuAvg, memoryPeak, memoryAvg, podRestarts, oomKills };
}

/**
 * Extracts latency percentiles (p50/p95/p99/min/max) from the latency chart
 * in a Coroot get_application response.
 */
export function extractServiceLatency(response: unknown): LatencyMetrics {
  const reports = safeGet(response, 'reports');
  const sloReport = safeGet(reports, 'SLO');
  const latencyChart = findChart(sloReport, 'latency');

  if (!latencyChart) {
    return { p50Ms: 0, p95Ms: 0, p99Ms: 0, minMs: 0, maxMs: 0 };
  }

  const p50Data = findSeries(latencyChart, 'p50');
  const p95Data = findSeries(latencyChart, 'p95');
  const p99Data = findSeries(latencyChart, 'p99');

  // Coroot latency is in seconds, convert to ms
  const p50Ms = p50Data.length > 0 ? secToMs(avg(p50Data)) : 0;
  const p95Ms = p95Data.length > 0 ? secToMs(avg(p95Data)) : 0;
  const p99Ms = p99Data.length > 0 ? secToMs(avg(p99Data)) : 0;

  // min/max across all percentile data points
  const allValues = [...p50Data, ...p95Data, ...p99Data].map((d) => d[1]);
  const minMs = allValues.length > 0 ? secToMs(Math.min(...allValues)) : 0;
  const maxMs = allValues.length > 0 ? secToMs(Math.max(...allValues)) : 0;

  return { p50Ms, p95Ms, p99Ms, minMs, maxMs };
}

/**
 * Extracts inbound request rate (RPS) from the SLO report.
 * Used for cross-validation against k6-reported RPS.
 */
export function extractRequestRate(response: unknown): number {
  const reports = safeGet(response, 'reports');
  const sloReport = safeGet(reports, 'SLO');
  const requestChart = findChart(sloReport, 'Inbound requests');

  if (!requestChart) return 0;

  const totalData = findSeries(requestChart, 'total');
  if (totalData.length === 0) {
    // Fallback: use first series
    const first = requestChart.series[0]?.data ?? [];
    return first.length > 0 ? avg(first) : 0;
  }

  return avg(totalData);
}

/**
 * Extracts 5xx error fraction (0-1) from the SLO report.
 * Used for cross-validation against k6-reported error rate.
 */
export function extractErrorRate(response: unknown): number {
  const reports = safeGet(response, 'reports');
  const sloReport = safeGet(reports, 'SLO');
  const requestChart = findChart(sloReport, 'Inbound requests');

  if (!requestChart) return 0;

  const totalData = findSeries(requestChart, 'total');
  const errorData = findSeries(requestChart, 'errors');

  if (totalData.length === 0 || errorData.length === 0) return 0;

  const totalAvg = avg(totalData);
  const errorAvg = avg(errorData);

  if (totalAvg === 0) return 0;
  return Math.min(1, errorAvg / totalAvg);
}

// ---------------------------------------------------------------------------
// Data store metric extractors
// ---------------------------------------------------------------------------

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

/**
 * Classifies the data source type for a given store name.
 * Native-instrumented stores (MongoDB, Redis, ClickHouse) provide richer metrics.
 */
export function classifyDataSource(storeName: string): DataStoreCapacity['dataSource'] {
  const normalized = storeName.toLowerCase().replace(/-.*$/, '');
  return STORE_DATA_SOURCE[normalized] ?? 'coroot-tcp';
}

/** Extracts CPU/memory/disk resource metrics from a data store app response. */
export function extractDataStoreResources(response: unknown): {
  cpuPeak: string | null;
  cpuAvg: string | null;
  memoryPeak: string | null;
  memoryAvg: string | null;
  diskUsageGB: number;
  diskGrowthRateGBPerDay: number;
} {
  const reports = safeGet(response, 'reports');

  // CPU
  const cpuReport = safeGet(reports, 'CPU');
  const cpuChart = findChart(cpuReport, 'CPU usage');
  const cpuData =
    findSeries(cpuChart, 'usage').length > 0
      ? findSeries(cpuChart, 'usage')
      : (cpuChart?.series[0]?.data ?? []);

  const cpuPeak = cpuData.length > 0 ? formatCpu(peak(cpuData)) : null;
  const cpuAvg = cpuData.length > 0 ? formatCpu(avg(cpuData)) : null;

  // Memory
  const memReport = safeGet(reports, 'Memory');
  const memChart = findChart(memReport, 'Memory usage');
  const memData =
    findSeries(memChart, 'RSS').length > 0
      ? findSeries(memChart, 'RSS')
      : (memChart?.series[0]?.data ?? []);

  const memoryPeak = memData.length > 0 ? bytesToGi(peak(memData)) : null;
  const memoryAvg = memData.length > 0 ? bytesToGi(avg(memData)) : null;

  // Disk
  const storageReport = safeGet(reports, 'Storage');
  const diskChart = findChart(storageReport, 'Disk usage');
  const diskData =
    findSeries(diskChart, 'used').length > 0
      ? findSeries(diskChart, 'used')
      : (diskChart?.series[0]?.data ?? []);

  let diskUsageGB = 0;
  let diskGrowthRateGBPerDay = 0;

  if (diskData.length > 0) {
    const lastBytes = diskData[diskData.length - 1][1];
    diskUsageGB = parseFloat((lastBytes / (1024 * 1024 * 1024)).toFixed(2));

    if (diskData.length >= 2) {
      const firstPoint = diskData[0];
      const lastPoint = diskData[diskData.length - 1];
      const timeDiffSec = lastPoint[0] - firstPoint[0];
      const bytesDiff = lastPoint[1] - firstPoint[1];

      if (timeDiffSec > 0) {
        const bytesPerSec = bytesDiff / timeDiffSec;
        const bytesPerDay = bytesPerSec * 86400;
        diskGrowthRateGBPerDay = parseFloat((bytesPerDay / (1024 * 1024 * 1024)).toFixed(4));
      }
    }
  }

  return {
    cpuPeak,
    cpuAvg,
    memoryPeak,
    memoryAvg,
    diskUsageGB,
    diskGrowthRateGBPerDay,
  };
}

/** Extracts query and write latency percentiles from a data store app response. */
export function extractDataStoreLatency(response: unknown): DataStoreCapacity['latency'] {
  const reports = safeGet(response, 'reports');
  const latencyReport = safeGet(reports, 'Latency');

  const zero: DataStoreCapacity['latency'] = {
    queryP50Ms: 0,
    queryP95Ms: 0,
    queryP99Ms: 0,
    queryMinMs: 0,
    queryMaxMs: 0,
    writeP50Ms: 0,
    writeP95Ms: 0,
    writeP99Ms: 0,
    writeMinMs: 0,
    writeMaxMs: 0,
  };

  if (!latencyReport) return zero;

  // Query latency
  const queryChart = findChart(latencyReport, 'Query latency');
  if (queryChart) {
    const qp50 = findSeries(queryChart, 'p50');
    const qp95 = findSeries(queryChart, 'p95');
    const qp99 = findSeries(queryChart, 'p99');

    zero.queryP50Ms = qp50.length > 0 ? secToMs(avg(qp50)) : 0;
    zero.queryP95Ms = qp95.length > 0 ? secToMs(avg(qp95)) : 0;
    zero.queryP99Ms = qp99.length > 0 ? secToMs(avg(qp99)) : 0;

    const allQuery = [...qp50, ...qp95, ...qp99].map((d) => d[1]);
    zero.queryMinMs = allQuery.length > 0 ? secToMs(Math.min(...allQuery)) : 0;
    zero.queryMaxMs = allQuery.length > 0 ? secToMs(Math.max(...allQuery)) : 0;
  }

  // Write latency
  const writeChart = findChart(latencyReport, 'Write latency');
  if (writeChart) {
    const wp50 = findSeries(writeChart, 'p50');
    const wp95 = findSeries(writeChart, 'p95');
    const wp99 = findSeries(writeChart, 'p99');

    zero.writeP50Ms = wp50.length > 0 ? secToMs(avg(wp50)) : 0;
    zero.writeP95Ms = wp95.length > 0 ? secToMs(avg(wp95)) : 0;
    zero.writeP99Ms = wp99.length > 0 ? secToMs(avg(wp99)) : 0;

    const allWrite = [...wp50, ...wp95, ...wp99].map((d) => d[1]);
    zero.writeMinMs = allWrite.length > 0 ? secToMs(Math.min(...allWrite)) : 0;
    zero.writeMaxMs = allWrite.length > 0 ? secToMs(Math.max(...allWrite)) : 0;
  }

  return zero;
}

/** Extracts connection used/max/utilization from a data store app response. */
export function extractDataStoreConnections(response: unknown): DataStoreCapacity['connections'] {
  const reports = safeGet(response, 'reports');
  const connReport = safeGet(reports, 'Connections');
  const connChart = findChart(connReport, 'connections');

  if (!connChart) {
    return { used: 0, max: 0, utilizationPercent: 0 };
  }

  const currentData = findSeries(connChart, 'current');
  const maxData = findSeries(connChart, 'max');

  const used = currentData.length > 0 ? Math.round(peak(currentData)) : 0;
  const max = maxData.length > 0 ? Math.round(avg(maxData)) : 0;

  const utilizationPercent = max > 0 ? parseFloat(((used / max) * 100).toFixed(1)) : 0;

  return { used, max, utilizationPercent };
}

/**
 * Extracts store-specific metrics from get_panel_data response.
 * The metrics extracted depend on the store type.
 */
export function extractStoreSpecificMetrics(
  storeName: string,
  panelResponse: unknown,
): Record<string, number | string | boolean | null> {
  const normalized = storeName.toLowerCase().replace(/-.*$/, '');

  // Supported store types for store-specific metrics
  const supportedStores = ['mongodb', 'redis', 'clickhouse'];
  if (!supportedStores.includes(normalized)) {
    return {};
  }

  const result: Record<string, number | string | boolean | null> = {};

  // Extract from panel series
  const series = safeGet(panelResponse, 'series');
  if (!Array.isArray(series)) return result;

  for (const s of series) {
    if (typeof s !== 'object' || s === null) continue;

    const name = (s as Record<string, unknown>).name;
    const data = (s as Record<string, unknown>).data;

    if (typeof name !== 'string' || !Array.isArray(data)) continue;

    const tsData = extractTimeSeries(data);
    if (tsData.length === 0) continue;

    // Use the average value for the metric
    result[name] = parseFloat(avg(tsData).toFixed(4));
  }

  return result;
}

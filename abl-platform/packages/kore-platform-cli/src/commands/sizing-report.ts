/**
 * CLI Report Generation Commands
 *
 * Registers `sizing report` and `sizing load-report` subcommands for
 * generating saturation and load-test reports from calibration data.
 */

import type { Command } from 'commander';
import { readFile, writeFile, readdir, stat, mkdir } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import Handlebars from 'handlebars';

// ---------------------------------------------------------------------------
// Handlebars helpers
// ---------------------------------------------------------------------------

export function registerHandlebarsHelpers(): void {
  Handlebars.registerHelper('formatMs', (value: unknown) => {
    if (value === null || value === undefined) return 'N/A';
    const num = Number(value);
    if (Number.isNaN(num)) return 'N/A';
    return num < 1 ? num.toFixed(3) : num.toFixed(1);
  });

  Handlebars.registerHelper('formatPercent', (value: unknown) => {
    if (value === null || value === undefined) return 'N/A';
    const num = Number(value);
    if (Number.isNaN(num)) return 'N/A';
    return `${(num * 100).toFixed(1)}%`;
  });

  Handlebars.registerHelper('statusIcon', (status: string) => {
    switch (status) {
      case 'pass':
        return new Handlebars.SafeString('<span class="pass">PASS</span>');
      case 'fail':
        return new Handlebars.SafeString('<span class="fail">FAIL</span>');
      case 'warn':
        return new Handlebars.SafeString('<span class="warn">WARN</span>');
      default:
        return status;
    }
  });

  Handlebars.registerHelper('defaultVal', (value: unknown, fallback: string) => {
    if (value === null || value === undefined || value === '') return fallback;
    return String(value);
  });

  Handlebars.registerHelper('gt', (a: unknown, b: unknown) => {
    return Number(a) > Number(b);
  });

  Handlebars.registerHelper('eq', (a: unknown, b: unknown) => {
    return a === b;
  });

  Handlebars.registerHelper('json', (value: unknown) => {
    return new Handlebars.SafeString(JSON.stringify(value, null, 2));
  });

  Handlebars.registerHelper('serviceCount', (obj: unknown) => {
    if (obj && typeof obj === 'object') return Object.keys(obj).length;
    return 0;
  });

  Handlebars.registerHelper('join', (arr: unknown[], separator: string) => {
    if (!Array.isArray(arr)) return '';
    return arr.join(separator);
  });

  Handlebars.registerHelper('formatCpu', (value: unknown) => {
    if (value === null || value === undefined || value === '') return 'N/A';
    const str = String(value);
    // Already formatted (e.g., "250m", "1.5 cores")
    if (str.includes('m') || str.includes('core')) return str;
    const num = Number(str);
    if (Number.isNaN(num)) return str;
    // Assume millicores if > 10, else cores
    if (num > 10) return `${Math.round(num)}m`;
    return `${num.toFixed(2)} cores`;
  });

  Handlebars.registerHelper('multiply', (a: unknown, b: unknown) => {
    const numA = Number(a);
    const numB = Number(b);
    if (Number.isNaN(numA) || Number.isNaN(numB)) return 0;
    return Math.round(numA * numB);
  });

  Handlebars.registerHelper('add', (a: unknown, b: unknown) => {
    const numA = Number(a);
    const numB = Number(b);
    if (Number.isNaN(numA) || Number.isNaN(numB)) return 0;
    return numA + numB;
  });

  Handlebars.registerHelper('formatMemory', (value: unknown) => {
    if (value === null || value === undefined || value === '') return 'N/A';
    const str = String(value);
    // Already formatted (e.g., "512Mi", "2Gi")
    if (/\d+[KMGT]i?$/i.test(str)) return str;
    const num = Number(str);
    if (Number.isNaN(num)) return str;
    // Assume bytes
    if (num >= 1024 * 1024 * 1024) return `${(num / (1024 * 1024 * 1024)).toFixed(1)}Gi`;
    if (num >= 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(0)}Mi`;
    return `${num}`;
  });

  Handlebars.registerHelper('divide', (a: unknown, b: unknown) => {
    const numA = Number(a);
    const numB = Number(b);
    if (Number.isNaN(numA) || Number.isNaN(numB) || numB === 0) return 0;
    return numA / numB;
  });

  Handlebars.registerHelper(
    'daysRemaining',
    (dataStore: {
      resources?: { diskUsageGB?: number; diskGrowthRateGBPerDay?: number };
      provisioned?: { storage?: string };
    }) => {
      if (!dataStore?.resources || !dataStore.provisioned?.storage) return 'N/A';
      const growth = dataStore.resources.diskGrowthRateGBPerDay ?? 0;
      if (growth <= 0) return 'Stable';
      const storageStr = dataStore.provisioned.storage;
      const totalGB = parseStorageToGB(storageStr);
      if (totalGB <= 0) return 'N/A';
      const remaining = totalGB - (dataStore.resources.diskUsageGB ?? 0);
      if (remaining <= 0) return '0';
      return Math.floor(remaining / growth).toString();
    },
  );

  // --- Readable date/time formatting ---

  Handlebars.registerHelper('formatDate', (value: unknown) => {
    if (value === null || value === undefined || value === '') return 'N/A';
    const d = new Date(String(value));
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString('en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  });

  Handlebars.registerHelper('formatDateTime', (value: unknown) => {
    if (value === null || value === undefined || value === '') return 'N/A';
    const d = new Date(String(value));
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString('en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
    });
  });

  Handlebars.registerHelper('formatTime', (value: unknown) => {
    if (value === null || value === undefined || value === '') return 'N/A';
    const d = new Date(String(value));
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
    });
  });

  // --- Number formatting ---

  Handlebars.registerHelper('formatNumber', (value: unknown) => {
    if (value === null || value === undefined) return 'N/A';
    const num = Number(value);
    if (Number.isNaN(num)) return String(value);
    return num.toLocaleString('en-US');
  });

  Handlebars.registerHelper('formatDiskGB', (value: unknown) => {
    if (value === null || value === undefined || value === '') return 'N/A';
    const num = Number(value);
    if (Number.isNaN(num)) return String(value);
    return `${num.toFixed(2)} GB`;
  });

  Handlebars.registerHelper('formatDuration', (value: unknown) => {
    if (value === null || value === undefined || value === '' || value === 'N/A') return 'N/A';
    const str = String(value);
    // Already human-readable (e.g., "10m", "2h", "5m 30s")
    if (/\d+[hms]/.test(str)) return str;
    // Try parsing as seconds
    const sec = Number(str);
    if (Number.isNaN(sec) || sec <= 0) return str;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.round(sec % 60);
    const parts: string[] = [];
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    if (s > 0 && h === 0) parts.push(`${s}s`);
    return parts.join(' ') || '0s';
  });

  // Capitalize / humanize service name: "runtime-saturation" → "Runtime Saturation"
  Handlebars.registerHelper('humanize', (value: unknown) => {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  });

  // Render a latency value with color hint for markdown
  Handlebars.registerHelper('formatLatencyMs', (value: unknown) => {
    if (value === null || value === undefined) return '—';
    const num = Number(value);
    if (Number.isNaN(num)) return '—';
    if (num === 0) return '—';
    if (num < 1) return `${(num * 1000).toFixed(0)} µs`;
    if (num < 10) return `${num.toFixed(2)} ms`;
    return `${num.toFixed(1)} ms`;
  });

  // Shorten a k8s node name (e.g., "aks-user-13883314-vmss00000q" → "vmss00000q")
  Handlebars.registerHelper('shortNodeName', (value: unknown) => {
    if (value === null || value === undefined) return '';
    const name = String(value);
    const parts = name.split('-');
    if (parts.length > 2) return parts.slice(-1)[0];
    return name;
  });

  // Shorten a pod name by stripping the replicaset and pod hash suffixes
  // e.g., "abl-platform-dev-runtime-664d5986d9-8s4s7" → "runtime-8s4s7"
  Handlebars.registerHelper('shortPodName', (value: unknown) => {
    if (value === null || value === undefined) return '';
    const name = String(value);
    // Strip deployment prefix (everything up to and including the last known service name segment)
    // Pattern: {prefix}-{service}-{replicaset}-{pod} or {prefix}-{service}-{ordinal}
    const parts = name.split('-');
    if (parts.length <= 2) return name;
    // For statefulsets: name ends with -N (e.g., mongodb-0)
    const last = parts[parts.length - 1];
    if (/^\d+$/.test(last) && parts.length > 2) {
      // Return last 2-3 meaningful segments
      return parts.slice(-2).join('-');
    }
    // For deployments: return last 3 segments (service-hash-pod)
    return parts.slice(-3).join('-');
  });

  // Format a GiB value to 1 decimal place
  Handlebars.registerHelper('formatGi', (value: unknown) => {
    if (value === null || value === undefined) return '—';
    const num = Number(value);
    if (Number.isNaN(num)) return '—';
    return num.toFixed(1);
  });

  Handlebars.registerHelper('llmPercent', (llmMs: unknown, totalMs: unknown) => {
    const llm = Number(llmMs);
    const total = Number(totalMs);
    if (Number.isNaN(llm) || Number.isNaN(total) || total === 0) return 'N/A';
    return ((llm / total) * 100).toFixed(0);
  });
}

function parseStorageToGB(storage: string): number {
  const match = storage.match(/^(\d+(?:\.\d+)?)\s*(Gi|Ti|GB|TB|Mi|MB)?$/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = (match[2] ?? 'Gi').toLowerCase();
  switch (unit) {
    case 'ti':
    case 'tb':
      return value * 1024;
    case 'gi':
    case 'gb':
      return value;
    case 'mi':
    case 'mb':
      return value / 1024;
    default:
      return value;
  }
}

// ---------------------------------------------------------------------------
// Repo root finder
// ---------------------------------------------------------------------------

export async function findRepoRoot(): Promise<string> {
  let dir = process.cwd();
  while (true) {
    try {
      await stat(join(dir, 'pnpm-workspace.yaml'));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break; // reached filesystem root
      dir = parent;
    }
  }
  throw new Error('Could not find repository root (no pnpm-workspace.yaml found)');
}

// ---------------------------------------------------------------------------
// Auto-load benchmarks/config/cloud.env into process.env
// ---------------------------------------------------------------------------

/**
 * Load `benchmarks/config/cloud.env` into `process.env`.
 *
 * Only sets keys that are NOT already in `process.env`, so real env vars
 * and shell exports always take precedence — matching the k6 script
 * priority: CLI flag > env var > cloud.env > fallback.
 */
export async function loadCloudEnv(): Promise<void> {
  try {
    const repoRoot = await findRepoRoot();
    const envPath = join(repoRoot, 'benchmarks', 'config', 'cloud.env');
    const content = await readFile(envPath, 'utf-8');

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes if present
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      // Only set if not already in process.env (real env takes precedence)
      if (!(key in process.env)) {
        process.env[key] = value;
      } else if (CRITICAL_ENV_KEYS.includes(key) && process.env[key] !== value) {
        // Warn when shell env overrides a critical cloud.env value
        process.stderr.write(
          `  WARNING: ${key} in shell env ("${process.env[key]}") differs from cloud.env ("${value}"). ` +
            `Shell value takes precedence. Unset it if cloud.env is correct.\n`,
        );
      }
    }
  } catch {
    // cloud.env not found or unreadable — silently continue
  }
}

/** Keys where a shell/cloud.env mismatch should produce a warning. */
const CRITICAL_ENV_KEYS: readonly string[] = [
  'COROOT_USERNAME',
  'COROOT_PASSWORD',
  'COROOT_BASE_URL',
  'COROOT_PROJECT_ID',
  'K6_CLOUD_TOKEN',
  'K6_CLOUD_PROJECT_ID',
  'RUNTIME_URL',
  'INGRESS_BASE',
];

// ---------------------------------------------------------------------------
// Template loader
// ---------------------------------------------------------------------------

export async function loadTemplate(templateName: string): Promise<HandlebarsTemplateDelegate> {
  const repoRoot = await findRepoRoot();
  const templatePath = join(repoRoot, 'benchmarks', 'report', 'templates', `${templateName}.hbs`);
  const source = await readFile(templatePath, 'utf-8');
  return Handlebars.compile(source);
}

// ---------------------------------------------------------------------------
// PDF generation (graceful fallback)
// ---------------------------------------------------------------------------

export async function generatePdf(
  markdownPath: string,
  outputPath: string,
  stylesheetPath?: string,
): Promise<boolean> {
  try {
    const { mdToPdf } = await import('md-to-pdf');
    const content = await readFile(markdownPath, 'utf-8');
    const options: { content: string; dest: string; stylesheet?: string } = {
      content,
      dest: outputPath,
    };
    if (stylesheetPath) {
      options.stylesheet = stylesheetPath;
    }
    // md-to-pdf expects these as top-level options
    await mdToPdf(
      { content },
      {
        dest: outputPath,
        stylesheet: stylesheetPath ? [stylesheetPath] : undefined,
        launch_options: { args: ['--no-sandbox'] },
      },
    );
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`PDF generation failed (falling back to markdown only): ${message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Saturation report context builder
// ---------------------------------------------------------------------------

export async function buildSaturationReportContext(
  calibrationPath: string,
  questionnairePath?: string,
): Promise<Record<string, unknown>> {
  const { CalibrationProfileSchema } = await import('@agent-platform/sizing-calculator');

  const raw = await readFile(calibrationPath, 'utf-8');
  const parsed = JSON.parse(raw);
  const result = CalibrationProfileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid calibration profile: ${issues}`);
  }

  const profile = result.data;

  // Compute warnings
  const warnings: string[] = [];
  for (const [name, svc] of Object.entries(profile.services)) {
    if (svc.measured.oomKills > 0) {
      warnings.push(`${name}: ${svc.measured.oomKills} OOM kill(s) detected`);
    }
    if (svc.measured.podRestarts > 0) {
      warnings.push(`${name}: ${svc.measured.podRestarts} pod restart(s) during test`);
    }
    if (svc.latency.p95Ms > svc.latency.baselineP95Ms * 3) {
      warnings.push(
        `${name}: p95 latency (${svc.latency.p95Ms}ms) is >3x baseline (${svc.latency.baselineP95Ms}ms)`,
      );
    }
  }

  for (const [name, ds] of Object.entries(profile.dataStores)) {
    if (ds.connections.utilizationPercent > 85) {
      warnings.push(`${name}: connection utilization at ${ds.connections.utilizationPercent}%`);
    }
  }

  // Compute basic SLA targets
  const slaTargets: Array<{ name: string; target: string; measured: string; passed: boolean }> = [];

  // Default SLA: p95 latency < 500ms for all services
  for (const [name, svc] of Object.entries(profile.services)) {
    slaTargets.push({
      name: `${name} p95 latency`,
      target: '<500ms',
      measured: `${svc.latency.p95Ms.toFixed(1)}ms`,
      passed: svc.latency.p95Ms < 500,
    });
  }

  const slaCompliance = {
    allPassed: slaTargets.every((t) => t.passed),
  };

  let questionnaire;
  if (questionnairePath) {
    const qRaw = await readFile(questionnairePath, 'utf-8');
    questionnaire = JSON.parse(qRaw);
  }

  return {
    ...profile,
    warnings,
    slaTargets,
    slaCompliance,
    questionnaire,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// k6 Cloud API fetcher
// ---------------------------------------------------------------------------

interface K6CloudTest {
  id: number;
  name: string;
  project_id?: number;
  last_test_run_id?: number;
  created?: string;
  updated?: string;
}

interface K6CloudTestRun {
  id: number;
  test_id?: number;
  status: number;
  run_status?: number;
  created: string;
  started?: string;
  ended?: string;
  duration?: number;
  vus?: number;
  test_name?: string;
}

interface K6CloudTestsResponse {
  'k6-tests'?: K6CloudTest[];
}

interface K6CloudRunDetailResponse {
  'k6-run'?: K6CloudTestRun;
}

interface K6CloudRunsListResponse {
  'k6-runs'?: K6CloudTestRun[];
}

interface K6CloudV5AggregateResponse {
  status?: string;
  data?: {
    resultType?: string;
    result?: Array<{
      metric?: Record<string, string>;
      values?: Array<[number, number | string]>;
    }>;
  };
}

const K6_API_BASE = 'https://api.k6.io';

async function k6CloudFetch(path: string, token: string): Promise<unknown> {
  const url = `${K6_API_BASE}${path}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Token ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const status = response.status;
    let detail = '';
    try {
      detail = await response.text();
    } catch {
      // ignore
    }
    if (status === 401) {
      throw new Error('k6 Cloud API authentication failed — check K6_CLOUD_TOKEN');
    }
    if (status === 404) {
      throw new Error(`k6 Cloud API resource not found: ${path}`);
    }
    throw new Error(`k6 Cloud API error (HTTP ${status}): ${detail.substring(0, 200)}`);
  }

  return response.json();
}

/**
 * Query a single aggregate metric from the k6 Cloud v5 OData API.
 *
 * Endpoint: GET /cloud/v5/test_runs({runId})/query_aggregate_k6(metric='...',query='...',start=...,end=...)
 *
 * Returns the numeric value, or null if the metric is not available.
 */
async function queryAggregate(
  token: string,
  runId: number,
  metric: string,
  query: string,
  start: string,
  end: string,
): Promise<number | null> {
  const path =
    `/cloud/v5/test_runs(${runId})/query_aggregate_k6(` +
    `metric='${metric}',query='${query}',start=${start},end=${end})`;

  try {
    const data = (await k6CloudFetch(path, token)) as K6CloudV5AggregateResponse;
    const results = data.data?.result ?? [];
    if (results.length > 0 && results[0].values && results[0].values.length > 0) {
      return Number(results[0].values[0][1]);
    }
    return null;
  } catch {
    return null;
  }
}

/** Normalize ISO timestamp to seconds-precision UTC (required by v5 API). */
function toV5Timestamp(iso: string): string {
  // "2026-03-25T13:45:36+00:00" → "2026-03-25T13:45:36Z"
  const d = new Date(iso);
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
}

function extractServiceName(testName: string | undefined): string {
  if (!testName) return 'unknown';
  // "runtime.ts" → "runtime", "services/search-ai.js" → "search-ai"
  const filename = testName.split('/').pop() ?? testName;
  return filename.replace(/\.(ts|js|mjs)$/, '');
}

/**
 * Known per-scenario custom metrics for each service.
 * latencyMetric: custom Trend for latency distribution
 * requestsMetric: custom Counter for request count (optional, added in newer scripts)
 * errorsMetric: custom Counter for error count (optional)
 */
interface ScenarioMetricDef {
  name: string;
  latencyMetric: string;
  requestsMetric?: string;
  errorsMetric?: string;
}

/** Cloud-queryable LLM metric names per service (custom Trend/Counter from k6 scripts). */
const CLOUD_LLM_METRICS: Record<
  string,
  { latency: string; inputTokens: string; outputTokens: string }
> = {
  runtime: {
    latency: 'runtime_llm_latency_ms',
    inputTokens: 'runtime_llm_input_tokens',
    outputTokens: 'runtime_llm_output_tokens',
  },
};

/** Cloud-queryable WebSocket metric names per service (custom Trend/Counter from k6 scripts). */
const CLOUD_WS_METRICS: Record<
  string,
  {
    connectLatency: string;
    timeouts: string;
    totalRequests: string;
    errors: string;
    messageLatency?: string;
    messageRequests?: string;
    conversationLatency?: string;
  }
> = {
  runtime: {
    connectLatency: 'runtime_ws_connect_latency_ms',
    timeouts: 'runtime_ws_timeouts',
    totalRequests: 'runtime_concurrent_requests',
    errors: 'runtime_concurrent_errors',
    messageLatency: 'runtime_multi_turn_per_message_ms',
    messageRequests: 'runtime_multi_turn_requests',
    conversationLatency: 'runtime_multi_turn_total_ms',
  },
};

const CLOUD_SCENARIO_METRICS: Record<string, ScenarioMetricDef[]> = {
  runtime: [
    {
      name: 'single turn',
      latencyMetric: 'runtime_single_turn_latency_ms',
      requestsMetric: 'runtime_single_turn_requests',
      errorsMetric: 'runtime_single_turn_errors',
    },
    {
      name: 'multi turn',
      latencyMetric: 'runtime_multi_turn_per_message_ms',
      requestsMetric: 'runtime_multi_turn_requests',
      errorsMetric: 'runtime_multi_turn_errors',
    },
    {
      name: 'tool calling',
      latencyMetric: 'runtime_tool_calling_total_ms',
      requestsMetric: 'runtime_tool_calling_requests',
      errorsMetric: 'runtime_tool_calling_errors',
    },
    {
      name: 'concurrent (ws)',
      latencyMetric: 'runtime_ws_connect_latency_ms',
      requestsMetric: 'runtime_concurrent_requests',
      errorsMetric: 'runtime_concurrent_errors',
    },
  ],
  'search-ai': [
    { name: 'kb list', latencyMetric: 'searchai_kb_list_latency_ms' },
    { name: 'doc list', latencyMetric: 'searchai_doc_list_latency_ms' },
    { name: 'doc upload', latencyMetric: 'searchai_doc_upload_latency_ms' },
    { name: 'crawl submit', latencyMetric: 'searchai_crawl_submit_latency_ms' },
  ],
  'bge-m3': [
    { name: 'single embed', latencyMetric: 'bge_m3_sat_single_embed_latency_ms' },
    { name: 'batch embed', latencyMetric: 'bge_m3_sat_batch_embed_latency_ms' },
    { name: 'concurrent embed', latencyMetric: 'bge_m3_sat_concurrent_embed_latency_ms' },
  ],
};

/** Per-scenario result shape used in both cloud and local reports. */
interface ScenarioResult {
  name: string;
  metricName: string;
  requests: number;
  errors: number;
  errorRate: number;
  throughput: string;
  latency: {
    minMs: number;
    avgMs: number;
    medianMs: number;
    p50Ms: number;
    p90Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
  };
}

/**
 * Fetch per-scenario custom metrics from k6 Cloud for a given run.
 * Queries latency distribution + request/error counters per scenario.
 */
async function fetchCloudScenarioMetrics(
  token: string,
  run: K6CloudTestRun,
  serviceName: string,
): Promise<ScenarioResult[]> {
  // Resolve service name: "runtime-saturation" → "runtime"
  const cleanName = serviceName
    .replace(/^sat-/, '')
    .replace(/-saturation$/, '')
    .replace(/-service$/, '');
  const scenarioDefs = CLOUD_SCENARIO_METRICS[cleanName];
  if (!scenarioDefs || !run.started || !run.ended) return [];

  const start = toV5Timestamp(run.started);
  const end = toV5Timestamp(run.ended);
  const durationSec = (new Date(run.ended).getTime() - new Date(run.started).getTime()) / 1000;

  const results: ScenarioResult[] = [];

  for (const def of scenarioDefs) {
    // Query latency + counters in parallel
    const queries: Array<Promise<number | null>> = [
      queryAggregate(token, run.id, def.latencyMetric, 'avg()', start, end),
      queryAggregate(token, run.id, def.latencyMetric, 'mean()', start, end),
      queryAggregate(token, run.id, def.latencyMetric, 'histogram_quantile(0.50)', start, end),
      queryAggregate(token, run.id, def.latencyMetric, 'histogram_quantile(0.90)', start, end),
      queryAggregate(token, run.id, def.latencyMetric, 'histogram_quantile(0.95)', start, end),
      queryAggregate(token, run.id, def.latencyMetric, 'histogram_quantile(0.99)', start, end),
      queryAggregate(token, run.id, def.latencyMetric, 'histogram_quantile(1.0)', start, end),
    ];

    // Add counter queries if defined
    if (def.requestsMetric) {
      queries.push(queryAggregate(token, run.id, def.requestsMetric, 'value()', start, end));
    }
    if (def.errorsMetric) {
      queries.push(queryAggregate(token, run.id, def.errorsMetric, 'value()', start, end));
    }

    const queryResults = await Promise.all(queries);
    const [avgVal, meanVal, p50Val, p90Val, p95Val, p99Val, maxVal] = queryResults;

    // Counter results start at index 7 (after avg, mean, p50, p90, p95, p99, max)
    const requestCount = def.requestsMetric ? (queryResults[7] ?? 0) : 0;
    const errorCount = def.errorsMetric ? (queryResults[def.requestsMetric ? 8 : 7] ?? 0) : 0;

    // Skip scenarios where neither latency nor requests were recorded
    if (p50Val === null && p95Val === null && maxVal === null && requestCount === 0) continue;

    const reqs = Math.round(requestCount);
    const errs = Math.round(errorCount);
    const errRate = reqs > 0 ? errs / reqs : 0;
    const throughput = durationSec > 0 ? (reqs / durationSec).toFixed(1) : '0';

    results.push({
      name: def.name,
      metricName: def.latencyMetric,
      requests: reqs,
      errors: errs,
      errorRate: errRate,
      throughput,
      latency: {
        minMs: 0,
        avgMs: avgVal ?? meanVal ?? p50Val ?? 0,
        medianMs: p50Val ?? 0,
        p50Ms: p50Val ?? 0,
        p90Ms: p90Val ?? 0,
        p95Ms: p95Val ?? 0,
        p99Ms: p99Val ?? 0,
        maxMs: maxVal ?? 0,
      },
    });
  }

  return results;
}

/** LLM metrics returned from k6 Cloud custom Trend/Counter queries. */
export interface CloudLLMMetrics {
  avgMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Fetch LLM custom metrics (latency Trend + token Counters) from k6 Cloud for a given run.
 * Returns null if the service has no LLM metrics defined or no data was recorded.
 */
async function fetchCloudLLMMetrics(
  token: string,
  run: K6CloudTestRun,
  serviceName: string,
): Promise<CloudLLMMetrics | null> {
  const cleanName = serviceName
    .replace(/^sat-/, '')
    .replace(/-saturation$/, '')
    .replace(/-service$/, '');
  const llmDef = CLOUD_LLM_METRICS[cleanName];
  if (!llmDef || !run.started || !run.ended) return null;

  const start = toV5Timestamp(run.started);
  const end = toV5Timestamp(run.ended);

  const [avgVal, meanVal, medVal, p95Val, maxVal, inputCount, outputCount] = await Promise.all([
    queryAggregate(token, run.id, llmDef.latency, 'avg()', start, end),
    queryAggregate(token, run.id, llmDef.latency, 'mean()', start, end),
    queryAggregate(token, run.id, llmDef.latency, 'histogram_quantile(0.50)', start, end),
    queryAggregate(token, run.id, llmDef.latency, 'histogram_quantile(0.95)', start, end),
    queryAggregate(token, run.id, llmDef.latency, 'histogram_quantile(1.0)', start, end),
    queryAggregate(token, run.id, llmDef.inputTokens, 'value()', start, end),
    queryAggregate(token, run.id, llmDef.outputTokens, 'value()', start, end),
  ]);

  // No LLM data recorded in this run
  if (medVal === null && p95Val === null && maxVal === null) return null;

  // avg() may return null for Trend metrics in k6 Cloud v5 — fall back to mean(), then median
  const resolvedAvg = avgVal ?? meanVal ?? medVal ?? 0;

  return {
    avgMs: parseFloat(resolvedAvg.toFixed(1)),
    medianMs: parseFloat((medVal ?? 0).toFixed(1)),
    p95Ms: parseFloat((p95Val ?? 0).toFixed(1)),
    maxMs: parseFloat((maxVal ?? 0).toFixed(1)),
    inputTokens: Math.round(inputCount ?? 0),
    outputTokens: Math.round(outputCount ?? 0),
  };
}

/** WebSocket capacity metrics fetched from k6 Cloud custom metrics. */
export interface CloudWSMetrics {
  /** Total WebSocket connection attempts */
  totalConnections: number;
  /** Connection errors (failed to establish) */
  connectionErrors: number;
  /** Connection timeouts */
  connectionTimeouts: number;
  /** Connect latency distribution */
  connectLatency: {
    avgMs: number;
    medianMs: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
  };
  /** Per-message latency (multi-turn conversations) */
  messageLatency?: {
    avgMs: number;
    medianMs: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
  };
  /** Total multi-turn conversations */
  messageRequests?: number;
  /** Total conversation latency (multi-turn) */
  conversationLatency?: {
    avgMs: number;
    p95Ms: number;
    maxMs: number;
  };
}

/**
 * Fetch WebSocket custom metrics (connect latency, timeouts, message latency) from k6 Cloud.
 * Returns null if the service has no WS metrics defined or no data was recorded.
 */
async function fetchCloudWSMetrics(
  token: string,
  run: K6CloudTestRun,
  serviceName: string,
): Promise<CloudWSMetrics | null> {
  const cleanName = serviceName
    .replace(/^sat-/, '')
    .replace(/-saturation$/, '')
    .replace(/-service$/, '');
  const wsDef = CLOUD_WS_METRICS[cleanName];
  if (!wsDef || !run.started || !run.ended) return null;

  const start = toV5Timestamp(run.started);
  const end = toV5Timestamp(run.ended);

  // Core connection metrics
  const [
    connAvg,
    connMean,
    connMed,
    connP95,
    connP99,
    connMax,
    totalReqs,
    totalErrs,
    totalTimeouts,
  ] = await Promise.all([
    queryAggregate(token, run.id, wsDef.connectLatency, 'avg()', start, end),
    queryAggregate(token, run.id, wsDef.connectLatency, 'mean()', start, end),
    queryAggregate(token, run.id, wsDef.connectLatency, 'histogram_quantile(0.50)', start, end),
    queryAggregate(token, run.id, wsDef.connectLatency, 'histogram_quantile(0.95)', start, end),
    queryAggregate(token, run.id, wsDef.connectLatency, 'histogram_quantile(0.99)', start, end),
    queryAggregate(token, run.id, wsDef.connectLatency, 'histogram_quantile(1.0)', start, end),
    queryAggregate(token, run.id, wsDef.totalRequests, 'value()', start, end),
    queryAggregate(token, run.id, wsDef.errors, 'value()', start, end),
    queryAggregate(token, run.id, wsDef.timeouts, 'value()', start, end),
  ]);

  // No WS data recorded
  if (connMed === null && connP95 === null && connMax === null && totalReqs === null) return null;

  const resolvedConnAvg = connAvg ?? connMean ?? connMed ?? 0;

  const result: CloudWSMetrics = {
    totalConnections: Math.round(totalReqs ?? 0),
    connectionErrors: Math.round(totalErrs ?? 0),
    connectionTimeouts: Math.round(totalTimeouts ?? 0),
    connectLatency: {
      avgMs: parseFloat(resolvedConnAvg.toFixed(1)),
      medianMs: parseFloat((connMed ?? 0).toFixed(1)),
      p95Ms: parseFloat((connP95 ?? 0).toFixed(1)),
      p99Ms: parseFloat((connP99 ?? 0).toFixed(1)),
      maxMs: parseFloat((connMax ?? 0).toFixed(1)),
    },
  };

  // Message-level metrics (multi-turn WS conversations)
  if (wsDef.messageLatency) {
    const [msgAvg, msgMean, msgMed, msgP95, msgP99, msgMax, msgReqs] = await Promise.all([
      queryAggregate(token, run.id, wsDef.messageLatency, 'avg()', start, end),
      queryAggregate(token, run.id, wsDef.messageLatency, 'mean()', start, end),
      queryAggregate(token, run.id, wsDef.messageLatency, 'histogram_quantile(0.50)', start, end),
      queryAggregate(token, run.id, wsDef.messageLatency, 'histogram_quantile(0.95)', start, end),
      queryAggregate(token, run.id, wsDef.messageLatency, 'histogram_quantile(0.99)', start, end),
      queryAggregate(token, run.id, wsDef.messageLatency, 'histogram_quantile(1.0)', start, end),
      wsDef.messageRequests
        ? queryAggregate(token, run.id, wsDef.messageRequests, 'value()', start, end)
        : Promise.resolve(null),
    ]);

    if (msgMed !== null || msgP95 !== null || msgMax !== null) {
      const resolvedMsgAvg = msgAvg ?? msgMean ?? msgMed ?? 0;
      result.messageLatency = {
        avgMs: parseFloat(resolvedMsgAvg.toFixed(1)),
        medianMs: parseFloat((msgMed ?? 0).toFixed(1)),
        p95Ms: parseFloat((msgP95 ?? 0).toFixed(1)),
        p99Ms: parseFloat((msgP99 ?? 0).toFixed(1)),
        maxMs: parseFloat((msgMax ?? 0).toFixed(1)),
      };
      result.messageRequests = Math.round(msgReqs ?? 0);
    }
  }

  // Conversation-level latency
  if (wsDef.conversationLatency) {
    const [convAvg, convMean, convP95, convMax] = await Promise.all([
      queryAggregate(token, run.id, wsDef.conversationLatency, 'avg()', start, end),
      queryAggregate(token, run.id, wsDef.conversationLatency, 'mean()', start, end),
      queryAggregate(
        token,
        run.id,
        wsDef.conversationLatency,
        'histogram_quantile(0.95)',
        start,
        end,
      ),
      queryAggregate(
        token,
        run.id,
        wsDef.conversationLatency,
        'histogram_quantile(1.0)',
        start,
        end,
      ),
    ]);

    if (convP95 !== null || convMax !== null) {
      const resolvedConvAvg = convAvg ?? convMean ?? 0;
      result.conversationLatency = {
        avgMs: parseFloat(resolvedConvAvg.toFixed(1)),
        p95Ms: parseFloat((convP95 ?? 0).toFixed(1)),
        maxMs: parseFloat((convMax ?? 0).toFixed(1)),
      };
    }
  }

  return result;
}

/**
 * Fetch results from k6 Cloud API:
 *   1. GET /loadtests/v2/tests?project_id={id}      → list all tests
 *   2. GET /loadtests/v2/runs/{runId}                → run metadata (start/end times)
 *   3. GET /cloud/v5/test_runs({runId})/query_aggregate_k6(...)  → aggregate metrics
 */
export async function fetchCloudResults(
  projectId: string,
  token: string,
  last: number,
  filters?: { services?: string[]; testType?: string },
): Promise<Record<string, unknown>> {
  // Step 1: List all tests in the project
  const testsData = (await k6CloudFetch(
    `/loadtests/v2/tests?project_id=${projectId}`,
    token,
  )) as K6CloudTestsResponse;

  let tests = testsData['k6-tests'] ?? [];
  if (tests.length === 0) {
    throw new Error(
      `No tests found for project ${projectId}. Verify K6_CLOUD_PROJECT_ID is correct and that tests have been run.`,
    );
  }

  // Apply filters
  if (filters?.testType) {
    const typeFilter = filters.testType.toLowerCase();
    tests = tests.filter((t) => {
      const name = (t.name ?? '').toLowerCase();
      return name.includes(typeFilter);
    });
  }

  if (filters?.services && filters.services.length > 0) {
    const svcFilters = filters.services.map((s) => s.toLowerCase());
    tests = tests.filter((t) => {
      const name = (t.name ?? '').toLowerCase();
      return svcFilters.some((svc) => name.includes(svc));
    });
  }

  if (tests.length === 0) {
    const filterDesc = [
      filters?.testType ? `type=${filters.testType}` : '',
      filters?.services ? `services=${filters.services.join(',')}` : '',
    ]
      .filter(Boolean)
      .join(', ');
    throw new Error(
      `No tests matched filters (${filterDesc}) in project ${projectId}. ` +
        `Available tests: ${(testsData['k6-tests'] ?? []).map((t) => t.name).join(', ')}`,
    );
  }

  process.stderr.write(`  Found ${tests.length} test(s): ${tests.map((t) => t.name).join(', ')}\n`);

  // Step 2: For each test, fetch last N runs and average metrics
  const services: Record<string, unknown> = {};
  let totalRequests = 0;
  let totalErrors = 0;

  for (const test of tests) {
    const serviceName = extractServiceName(test.name);

    // Fetch the runs list for this test, sorted by created descending
    const runsData = (await k6CloudFetch(
      `/loadtests/v2/runs?test_id=${test.id}`,
      token,
    )) as K6CloudRunsListResponse;
    const allRuns = (runsData['k6-runs'] ?? [])
      .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime())
      .slice(0, last);

    if (allRuns.length === 0) {
      console.warn(`  No runs found for test "${test.name}" (id=${test.id}), skipping`);
      continue;
    }

    console.log(
      `  Fetching ${allRuns.length} run(s) for "${test.name}": ` +
        allRuns.map((r) => r.id).join(', '),
    );

    // Collect metrics from each run
    const runMetrics: Array<{
      reqs: number;
      reqRate: number;
      avgDuration: number;
      p50: number;
      p90: number;
      p95: number;
      p99: number;
      minMs: number;
      maxMs: number;
      errorRate: number;
      iterations: number;
    }> = [];

    let latestRun: K6CloudTestRun | undefined;

    for (const runEntry of allRuns) {
      // Fetch run detail for start/end times (list may not include them)
      let run: K6CloudTestRun | undefined;
      try {
        const detailData = (await k6CloudFetch(
          `/loadtests/v2/runs/${runEntry.id}`,
          token,
        )) as K6CloudRunDetailResponse;
        run = detailData['k6-run'];
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`  Failed to fetch run ${runEntry.id}: ${message}`);
        continue;
      }

      if (!run || !run.started || !run.ended) {
        console.warn(`  Run ${runEntry.id} has no start/end times, skipping`);
        continue;
      }

      if (!latestRun) latestRun = run;

      const start = toV5Timestamp(run.started);
      const end = toV5Timestamp(run.ended);

      // Query aggregate metrics via v5 OData API (parallel)
      const [
        reqs,
        reqRate,
        avgDuration,
        p50,
        p90,
        p95,
        p99,
        minMs,
        maxMs,
        httpReqFailed,
        iterations,
      ] = await Promise.all([
        queryAggregate(token, run.id, 'http_reqs', 'value()', start, end),
        queryAggregate(token, run.id, 'http_reqs', 'rate()', start, end),
        queryAggregate(token, run.id, 'http_req_duration', 'avg()', start, end),
        queryAggregate(token, run.id, 'http_req_duration', 'histogram_quantile(0.50)', start, end),
        queryAggregate(token, run.id, 'http_req_duration', 'histogram_quantile(0.90)', start, end),
        queryAggregate(token, run.id, 'http_req_duration', 'histogram_quantile(0.95)', start, end),
        queryAggregate(token, run.id, 'http_req_duration', 'histogram_quantile(0.99)', start, end),
        queryAggregate(token, run.id, 'http_req_duration', 'histogram_quantile(0.0)', start, end),
        queryAggregate(token, run.id, 'http_req_duration', 'histogram_quantile(1.0)', start, end),
        queryAggregate(token, run.id, 'http_req_failed', 'value()', start, end),
        queryAggregate(token, run.id, 'iterations', 'value()', start, end),
      ]);

      runMetrics.push({
        reqs: reqs ?? 0,
        reqRate: reqRate ?? 0,
        avgDuration: avgDuration ?? 0,
        p50: p50 ?? 0,
        p90: p90 ?? 0,
        p95: p95 ?? 0,
        p99: p99 ?? 0,
        minMs: minMs ?? 0,
        maxMs: maxMs ?? 0,
        errorRate: httpReqFailed !== null ? httpReqFailed : 0,
        iterations: iterations ?? 0,
      });
    }

    if (runMetrics.length === 0 || !latestRun) {
      console.warn(`  No usable runs for test "${test.name}", skipping`);
      continue;
    }

    // Average metrics across the N runs
    const avg = (key: keyof (typeof runMetrics)[0]): number =>
      runMetrics.reduce((sum, m) => sum + m[key], 0) / runMetrics.length;

    const avgReqs = avg('reqs');
    const avgErrorRate = avg('errorRate');

    totalRequests += avgReqs;
    totalErrors += Math.round(avgReqs * avgErrorRate);

    // Use max (not avg) for maxMs to capture true peak across runs
    const peakMax = Math.max(...runMetrics.map((m) => m.maxMs));

    // Query per-scenario custom Trend metrics, LLM metrics, and WS metrics from k6 Cloud
    const [scenarioMetrics, llmMetrics, wsMetrics] = await Promise.all([
      fetchCloudScenarioMetrics(token, latestRun, serviceName),
      fetchCloudLLMMetrics(token, latestRun, serviceName),
      fetchCloudWSMetrics(token, latestRun, serviceName),
    ]);

    services[serviceName] = {
      totalRequests: avgReqs,
      errorRate: avgErrorRate,
      throughput: avg('reqRate').toFixed(1),
      vus: latestRun.vus ?? 0,
      iterations: Math.round(avg('iterations')),
      latency: {
        minMs: avg('minMs'),
        avgMs: avg('avgDuration') || avg('p50'),
        medianMs: avg('p50'),
        p50Ms: avg('p50'),
        p90Ms: avg('p90'),
        p95Ms: avg('p95'),
        p99Ms: avg('p99'),
        maxMs: peakMax,
      },
      scenarios: scenarioMetrics.length > 0 ? scenarioMetrics : undefined,
      llmMetrics: llmMetrics ?? undefined,
      wsMetrics: wsMetrics ?? undefined,
      cloudRunId: latestRun.id,
      cloudRunCreated: latestRun.created,
      durationSec: latestRun.duration ?? 0,
      runStatus: latestRun.run_status,
      runsAveraged: runMetrics.length,
    };
  }

  const overallErrorRate = totalRequests > 0 ? totalErrors / totalRequests : 0;

  // Compute totals from per-service data
  let cloudTotalVUs = 0;
  for (const svc of Object.values(services)) {
    const s = svc as { vus?: number };
    cloudTotalVUs += s.vus ?? 0;
  }

  // Compute total iterations from per-service data
  let cloudTotalIterations = 0;
  for (const svc of Object.values(services)) {
    const s = svc as { iterations?: number };
    cloudTotalIterations += s.iterations ?? 0;
  }

  return {
    tier: 'unknown',
    timestamp: new Date().toISOString(),
    duration: 'N/A',
    totalRequests,
    totalVUs: cloudTotalVUs,
    totalIterations: cloudTotalIterations,
    overallErrorRate,
    services,
    comparison: undefined,
    slaTargets: [],
    generatedAt: new Date().toISOString(),
    source: 'k6-cloud',
    projectId,
  };
}

// ---------------------------------------------------------------------------
// Load test report context builder
// ---------------------------------------------------------------------------

/** Shape of a k6 Trend metric in the JSON summary export. */
interface K6TrendMetric {
  avg?: number;
  min?: number;
  med?: number;
  max?: number;
  'p(90)'?: number;
  'p(95)'?: number;
}

/** Shape of a k6 Counter metric. */
interface K6CounterMetric {
  count?: number;
  rate?: number;
}

/** Shape of a k6 Rate metric. */
interface K6RateMetric {
  passes?: number;
  fails?: number;
  value?: number;
  rate?: number;
}

interface K6Summary {
  metrics?: Record<string, K6TrendMetric | K6CounterMetric | K6RateMetric | unknown> & {
    http_reqs?: K6CounterMetric;
    http_req_duration?: K6TrendMetric;
    http_req_failed?: K6RateMetric;
    iterations?: K6CounterMetric;
    vus?: { min?: number; max?: number; value?: number };
    vus_max?: { min?: number; max?: number; value?: number };
    iteration_duration?: K6TrendMetric;
  };
  root_group?: {
    name?: string;
    checks?: Record<string, { name?: string; passes?: number; fails?: number }>;
  };
}

/**
 * Extract p50 (median) from a k6 Trend metric.
 * k6 exports it as "med", not "p(50)".
 */
function trendP50(t: K6TrendMetric): number {
  return t.med ?? 0;
}

/**
 * Approximate p99 from a k6 Trend metric.
 * k6 default summary only exports p(90) and p(95), not p(99).
 * We extrapolate: p99 ≈ p95 + 0.8 × (p95 − p90), capped at max.
 */
function trendP99(t: K6TrendMetric): number {
  const p95 = t['p(95)'] ?? 0;
  const p90 = t['p(90)'] ?? 0;
  const maxVal = t.max ?? p95;
  if (p95 === 0) return 0;
  const estimated = p95 + 0.8 * (p95 - p90);
  return Math.min(estimated, maxVal);
}

/**
 * Extract per-scenario metrics from k6 JSON custom Trend metrics.
 *
 * Convention: scenario-specific metrics are named `{prefix}_{scenarioSnake}_*_ms`
 * where prefix derives from the service name (e.g., "runtime", "searchai", "bge_m3").
 * Each custom Trend is effectively scenario-scoped since only one exec fn calls .add().
 */
function extractScenarioMetrics(
  metrics: Record<string, unknown>,
  serviceName: string,
  durationSec: number,
): ScenarioResult[] {
  // Map service names to their metric prefixes
  const prefixMap: Record<string, string> = {
    runtime: 'runtime_',
    'search-ai': 'searchai_',
    'bge-m3': 'bge_m3_sat_',
  };

  // Clean up service name from "sat-runtime" → "runtime"
  const cleanName = serviceName.replace(/^sat-/, '');
  const prefix = prefixMap[cleanName];
  if (!prefix) return [];

  // First pass: collect counter metrics (requests, errors) by scenario
  const countersByScenario: Record<string, { requests: number; errors: number }> = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (!key.startsWith(prefix)) continue;
    const counter = value as K6CounterMetric;
    if (counter.count === undefined) continue;
    // Check if it's a requests or errors counter
    if (key.endsWith('_requests')) {
      const scenarioKey = key.slice(prefix.length).replace(/_requests$/, '');
      if (!countersByScenario[scenarioKey])
        countersByScenario[scenarioKey] = { requests: 0, errors: 0 };
      countersByScenario[scenarioKey].requests = counter.count;
    } else if (key.endsWith('_errors')) {
      const scenarioKey = key.slice(prefix.length).replace(/_errors$/, '');
      if (!countersByScenario[scenarioKey])
        countersByScenario[scenarioKey] = { requests: 0, errors: 0 };
      countersByScenario[scenarioKey].errors = counter.count;
    }
  }

  const results: ScenarioResult[] = [];

  for (const [key, value] of Object.entries(metrics)) {
    if (!key.startsWith(prefix)) continue;
    // Only include Trend metrics (have med/avg/min/max)
    const trend = value as K6TrendMetric;
    if (trend.med === undefined && trend.avg === undefined) continue;
    // Skip counter/rate metrics that happen to match prefix
    if (
      'count' in (trend as Record<string, unknown>) &&
      !('med' in (trend as Record<string, unknown>))
    )
      continue;

    // Derive scenario name: strip prefix and "_ms" suffix, humanize
    const rawName = key
      .slice(prefix.length)
      .replace(/_ms$/, '')
      .replace(/_latency$/, '')
      .replace(/_total$/, '');
    const scenarioName = rawName.replace(/_/g, ' ');

    // Look up counter data for this scenario
    const counters = countersByScenario[rawName];
    const reqs = counters?.requests ?? 0;
    const errs = counters?.errors ?? 0;
    const errRate = reqs > 0 ? errs / reqs : 0;
    const throughput = durationSec > 0 ? (reqs / durationSec).toFixed(1) : '0';

    results.push({
      name: scenarioName,
      metricName: key,
      requests: reqs,
      errors: errs,
      errorRate: errRate,
      throughput,
      latency: {
        minMs: trend.min ?? 0,
        avgMs: trend.avg ?? 0,
        medianMs: trendP50(trend),
        p50Ms: trendP50(trend),
        p90Ms: trend['p(90)'] ?? 0,
        p95Ms: trend['p(95)'] ?? 0,
        p99Ms: trendP99(trend),
        maxMs: trend.max ?? 0,
      },
    });
  }

  return results;
}

export async function buildLoadTestReportContext(
  resultsDir: string,
  compareDir?: string,
): Promise<Record<string, unknown>> {
  const files = await readdir(resultsDir);
  const jsonFiles = files.filter((f) => f.endsWith('.json') && f !== 'infra-metrics.json');

  const services: Record<string, unknown> = {};
  let totalRequests = 0;
  let totalErrors = 0;
  let totalVUs = 0;
  let totalIterations = 0;

  for (const file of jsonFiles) {
    const raw = await readFile(join(resultsDir, file), 'utf-8');
    let summary: K6Summary;
    try {
      summary = JSON.parse(raw) as K6Summary;
    } catch {
      continue;
    }

    const serviceName = file.replace(/\.json$/, '').replace(/-summary$/, '');
    const metrics = summary.metrics;
    if (!metrics) continue;

    const reqs = metrics.http_reqs?.count ?? 0;
    const errorRate = metrics.http_req_failed?.value ?? metrics.http_req_failed?.rate ?? 0;
    const duration = metrics.http_req_duration ?? {};
    const vusMax = metrics.vus_max?.max ?? metrics.vus?.max ?? 0;
    const iterations = metrics.iterations?.count ?? 0;

    totalRequests += reqs;
    totalErrors += Math.round(reqs * errorRate);
    totalVUs += vusMax;
    totalIterations += iterations;

    // Extract per-scenario custom metrics
    const localDurationSec =
      reqs > 0 && (metrics.http_reqs?.rate ?? 0) > 0 ? reqs / (metrics.http_reqs?.rate ?? 1) : 0;
    const scenarioMetrics = extractScenarioMetrics(
      metrics as Record<string, unknown>,
      serviceName,
      localDurationSec,
    );

    services[serviceName] = {
      totalRequests: reqs,
      errorRate,
      throughput: (metrics.http_reqs?.rate ?? 0).toFixed(1),
      vus: vusMax,
      iterations,
      latency: {
        minMs: duration.min ?? 0,
        avgMs: duration.avg ?? 0,
        medianMs: trendP50(duration),
        p50Ms: trendP50(duration),
        p90Ms: duration['p(90)'] ?? 0,
        p95Ms: duration['p(95)'] ?? 0,
        p99Ms: trendP99(duration),
        maxMs: duration.max ?? 0,
      },
      scenarios: scenarioMetrics.length > 0 ? scenarioMetrics : undefined,
    };
  }

  const overallErrorRate = totalRequests > 0 ? totalErrors / totalRequests : 0;

  // Extract LLM metrics from k6 summaries (runtime_llm_latency_ms, etc.)
  let llmContext: Record<string, unknown> | undefined;
  for (const file of jsonFiles) {
    try {
      const raw = await readFile(join(resultsDir, file), 'utf-8');
      const summary = JSON.parse(raw) as {
        metrics?: Record<string, Record<string, unknown>>;
      };
      const m = summary.metrics;
      const llmTrend = m?.runtime_llm_latency_ms as
        | { avg?: number; med?: number; 'p(95)'?: number; max?: number }
        | undefined;
      if (llmTrend && llmTrend.avg != null) {
        llmContext = {
          hasLLMMetrics: true,
          llmLatency: {
            avgMs: parseFloat((llmTrend.avg ?? 0).toFixed(1)),
            medianMs: parseFloat((llmTrend.med ?? 0).toFixed(1)),
            p95Ms: parseFloat((llmTrend['p(95)'] ?? 0).toFixed(1)),
            maxMs: parseFloat((llmTrend.max ?? 0).toFixed(1)),
          },
          llmTokens: {
            input: (m?.runtime_llm_input_tokens as { count?: number } | undefined)?.count ?? 0,
            output: (m?.runtime_llm_output_tokens as { count?: number } | undefined)?.count ?? 0,
          },
        };
        break; // only need the first file with LLM data
      }
    } catch {
      // skip
    }
  }

  // Extract WebSocket metrics from k6 summaries and populate `websocket` on service entries
  for (const file of jsonFiles) {
    try {
      const raw = await readFile(join(resultsDir, file), 'utf-8');
      const summary = JSON.parse(raw) as {
        metrics?: Record<string, Record<string, unknown>>;
      };
      const m = summary.metrics;
      const wsConnect = m?.runtime_ws_connect_latency_ms as
        | { avg?: number; med?: number; 'p(95)'?: number; 'p(99)'?: number; max?: number }
        | undefined;
      if (wsConnect) {
        const wsTimeouts = (m?.runtime_ws_timeouts as { count?: number } | undefined)?.count ?? 0;
        const wsRequests =
          (m?.runtime_concurrent_requests as { count?: number } | undefined)?.count ?? 0;
        const wsErrors =
          (m?.runtime_concurrent_errors as { count?: number } | undefined)?.count ?? 0;

        const msgTrend = m?.runtime_multi_turn_per_message_ms as
          | { avg?: number; med?: number; 'p(95)'?: number; 'p(99)'?: number; max?: number }
          | undefined;
        const msgRequests =
          (m?.runtime_multi_turn_requests as { count?: number } | undefined)?.count ?? 0;
        const convTrend = m?.runtime_multi_turn_total_ms as
          | { avg?: number; 'p(95)'?: number; max?: number }
          | undefined;

        const localWs: CloudWSMetrics = {
          totalConnections: wsRequests,
          connectionErrors: wsErrors,
          connectionTimeouts: wsTimeouts,
          connectLatency: {
            avgMs: parseFloat((wsConnect.avg ?? wsConnect.med ?? 0).toFixed(1)),
            medianMs: parseFloat((wsConnect.med ?? 0).toFixed(1)),
            p95Ms: parseFloat((wsConnect['p(95)'] ?? 0).toFixed(1)),
            p99Ms: parseFloat((wsConnect['p(99)'] ?? 0).toFixed(1)),
            maxMs: parseFloat((wsConnect.max ?? 0).toFixed(1)),
          },
        };

        if (msgTrend && (msgTrend.med != null || msgTrend['p(95)'] != null)) {
          localWs.messageLatency = {
            avgMs: parseFloat((msgTrend.avg ?? msgTrend.med ?? 0).toFixed(1)),
            medianMs: parseFloat((msgTrend.med ?? 0).toFixed(1)),
            p95Ms: parseFloat((msgTrend['p(95)'] ?? 0).toFixed(1)),
            p99Ms: parseFloat((msgTrend['p(99)'] ?? 0).toFixed(1)),
            maxMs: parseFloat((msgTrend.max ?? 0).toFixed(1)),
          };
          localWs.messageRequests = msgRequests;
        }

        if (convTrend && (convTrend['p(95)'] != null || convTrend.max != null)) {
          localWs.conversationLatency = {
            avgMs: parseFloat((convTrend.avg ?? 0).toFixed(1)),
            p95Ms: parseFloat((convTrend['p(95)'] ?? 0).toFixed(1)),
            maxMs: parseFloat((convTrend.max ?? 0).toFixed(1)),
          };
        }

        // Find the matching service entry and attach websocket context
        const svcName = file.replace(/\.json$/, '').replace(/-summary$/, '');
        const svcEntry = services[svcName] as Record<string, unknown> | undefined;
        if (svcEntry) {
          svcEntry.websocket = buildWebSocketContext(localWs);
        }
        break; // only need the first file with WS data
      }
    } catch {
      // skip
    }
  }

  // Build comparison if compareDir provided
  let comparison: Record<string, unknown> | undefined;
  if (compareDir) {
    try {
      const prevFiles = await readdir(compareDir);
      const prevJsonFiles = prevFiles.filter((f) => f.endsWith('.json'));
      const prevServices: Record<string, { throughput: number; p95Ms: number; errorRate: number }> =
        {};

      for (const file of prevJsonFiles) {
        const raw = await readFile(join(compareDir, file), 'utf-8');
        let summary: K6Summary;
        try {
          summary = JSON.parse(raw) as K6Summary;
        } catch {
          continue;
        }
        const serviceName = file.replace(/\.json$/, '').replace(/-summary$/, '');
        const metrics = summary.metrics;
        if (!metrics) continue;

        prevServices[serviceName] = {
          throughput: metrics.http_reqs?.rate ?? 0,
          p95Ms: metrics.http_req_duration?.['p(95)'] ?? 0,
          errorRate: metrics.http_req_failed?.rate ?? 0,
        };
      }

      const throughputChanges: Array<Record<string, unknown>> = [];
      const latencyChanges: Array<Record<string, unknown>> = [];
      const errorRateChanges: Array<Record<string, unknown>> = [];
      const regressions: Array<Record<string, unknown>> = [];
      const improvements: Array<Record<string, unknown>> = [];

      for (const [svc, curr] of Object.entries(services)) {
        const prev = prevServices[svc];
        if (!prev) continue;

        const currData = curr as {
          throughput: string;
          errorRate: number;
          latency: { p95Ms: number };
        };
        const currThroughput = parseFloat(currData.throughput);
        const tChange =
          prev.throughput > 0
            ? (((currThroughput - prev.throughput) / prev.throughput) * 100).toFixed(1)
            : '0';

        throughputChanges.push({
          service: svc,
          previous: prev.throughput.toFixed(1),
          current: currData.throughput,
          changePercent: tChange,
        });

        const lChange =
          prev.p95Ms > 0
            ? (((currData.latency.p95Ms - prev.p95Ms) / prev.p95Ms) * 100).toFixed(1)
            : '0';

        latencyChanges.push({
          service: svc,
          previous: prev.p95Ms,
          current: currData.latency.p95Ms,
          changePercent: lChange,
        });

        const eChange =
          prev.errorRate > 0
            ? (((currData.errorRate - prev.errorRate) / prev.errorRate) * 100).toFixed(1)
            : '0';

        errorRateChanges.push({
          service: svc,
          previous: prev.errorRate,
          current: currData.errorRate,
          changePercent: eChange,
        });

        // Detect regressions (>10% worse) and improvements (>10% better)
        if (parseFloat(lChange) > 10) {
          regressions.push({
            service: svc,
            metric: 'p95 latency',
            changePercent: lChange,
            previous: `${prev.p95Ms.toFixed(1)}ms`,
            current: `${currData.latency.p95Ms.toFixed(1)}ms`,
          });
        } else if (parseFloat(lChange) < -10) {
          improvements.push({
            service: svc,
            metric: 'p95 latency',
            changePercent: Math.abs(parseFloat(lChange)).toFixed(1),
            previous: `${prev.p95Ms.toFixed(1)}ms`,
            current: `${currData.latency.p95Ms.toFixed(1)}ms`,
          });
        }
      }

      comparison = {
        previousDate: 'previous run',
        throughputChanges,
        latencyChanges,
        errorRateChanges,
        regressions: regressions.length > 0 ? regressions : undefined,
        improvements: improvements.length > 0 ? improvements : undefined,
      };
    } catch {
      // Comparison dir not readable — skip
    }
  }

  // Compute overall avg latency for LLM % calculation
  const svcValues = Object.values(services) as Array<{ latency?: { avgMs?: number } }>;
  const avgLatencies = svcValues.map((s) => s.latency?.avgMs ?? 0).filter((v) => v > 0);
  const overallAvgMs =
    avgLatencies.length > 0 ? avgLatencies.reduce((a, b) => a + b, 0) / avgLatencies.length : 0;

  return {
    tier: 'unknown',
    timestamp: new Date().toISOString(),
    duration: 'N/A',
    totalRequests,
    totalVUs,
    totalIterations,
    overallErrorRate,
    overallAvgMs: parseFloat(overallAvgMs.toFixed(1)),
    services,
    comparison,
    slaTargets: [],
    generatedAt: new Date().toISOString(),
    ...llmContext,
  };
}

// ---------------------------------------------------------------------------
// Infra metrics file enrichment (collected via Coroot MCP tools)
// ---------------------------------------------------------------------------

/**
 * Schema for the --infra-metrics JSON file.
 *
 * The file is produced by Coroot MCP tool calls (get_application, etc.)
 * and keyed by service name. Each entry has optional `infra` (app services)
 * and/or `dataStore` (data stores) sections.
 *
 * Example:
 * ```json
 * {
 *   "source": "coroot",
 *   "project": "my-project",
 *   "collectedAt": "2026-03-26T...",
 *   "services": {
 *     "runtime": {
 *       "infra": { "cpuPeak": "450m", "cpuAvg": "280m", "memoryPeak": "512Mi", ... }
 *     },
 *     "mongodb": {
 *       "dataStore": { "connections": { "used": 45, "max": 100, ... }, ... }
 *     }
 *   }
 * }
 * ```
 */
interface InfraMetricsFile {
  source?: string;
  project?: string;
  collectedAt?: string;
  services: Record<
    string,
    {
      infra?: {
        cpuPeak: string | null;
        cpuAvg: string | null;
        memoryPeak: string | null;
        memoryAvg: string | null;
        podRestarts: number;
        oomKills: number;
        observedRps: number;
        observedErrorRate: number;
      };
      dataStore?: {
        connections: { used: number; max: number; utilizationPercent: number };
        connectionBreakdown?: Array<{ client: string; used: number; max: number }>;
        resources: {
          cpuUsage?: string | null;
          memoryUsage?: string | null;
          diskUsageGB?: number | null;
          diskGrowthRateGBPerDay?: number | null;
        };
      };
      deployment?: {
        replicas: number;
        readyReplicas: number;
        cpuRequest: string | null;
        memoryRequest: string | null;
        cpuLimit: string | null;
        memoryLimit: string | null;
        kind: string;
      };
    }
  >;
  serviceLatency?: Array<{
    client: string;
    dataStore: string;
    requestLatencyMs: number | null;
    tcpLatencyMs: number | null;
    rps: number | null;
  }>;
  nodes?: Array<{
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
  }>;
  podPlacement?: Array<{
    service: string;
    pod: string;
    node: string;
    cpuRequest: string;
    cpuLimit: string;
    memoryRequest: string;
    memoryLimit: string;
  }>;
}

/**
 * Transform CloudWSMetrics into the `websocket` template context shape.
 * Maps k6 WS metrics to the template's expected fields.
 */
function buildWebSocketContext(ws: CloudWSMetrics, replicas?: number): Record<string, unknown> {
  const connectionsPerPod =
    replicas && replicas > 0 ? Math.round(ws.totalConnections / replicas) : ws.totalConnections;

  const endpoints: Array<Record<string, unknown>> = [
    {
      path: '/ws',
      configuredMax: 'N/A',
      measuredMax: ws.totalConnections,
      saturationSignal:
        ws.connectionErrors > 0
          ? 'Connection errors'
          : ws.connectionTimeouts > 0
            ? 'Timeouts'
            : 'None',
      messageLatency: ws.messageLatency
        ? {
            p50Ms: ws.messageLatency.medianMs,
            p95Ms: ws.messageLatency.p95Ms,
          }
        : { p50Ms: 0, p95Ms: 0 },
    },
  ];

  return {
    maxTotalConnectionsPerPod: connectionsPerPod,
    estimatedMemoryPerConnection: 'N/A',
    connectionErrors: ws.connectionErrors,
    connectionTimeouts: ws.connectionTimeouts,
    unexpectedDisconnects: 0,
    heartbeatFailures: 0,
    connectLatency: ws.connectLatency,
    messageLatency: ws.messageLatency ?? null,
    conversationLatency: ws.conversationLatency ?? null,
    messageRequests: ws.messageRequests ?? 0,
    endpoints,
  };
}

/**
 * Merge pre-collected infra metrics into the load test report context.
 *
 * Reads a JSON file (produced by Coroot MCP tools) and attaches `infra`
 * and/or `dataStoreInfra` to matching service entries in the context.
 */
async function mergeInfraMetrics(
  context: Record<string, unknown>,
  infraMetricsPath: string,
): Promise<void> {
  const raw = await readFile(infraMetricsPath, 'utf-8');
  let infraFile: InfraMetricsFile;
  try {
    infraFile = JSON.parse(raw) as InfraMetricsFile;
  } catch {
    console.error(`Failed to parse infra metrics file: ${infraMetricsPath}`);
    return;
  }

  if (!infraFile.services || typeof infraFile.services !== 'object') {
    console.error('Infra metrics file missing "services" object');
    return;
  }

  const services = context.services as Record<string, Record<string, unknown>>;
  const serviceKeys = Object.keys(services);
  let enrichedCount = 0;
  const deployments: Array<Record<string, unknown>> = [];

  // Match infra service name to report service name.
  // Cloud test names may have suffixes (e.g., "runtime-saturation" for infra key "runtime").
  function findServiceData(infraName: string): Record<string, unknown> | undefined {
    if (services[infraName]) return services[infraName];
    // Try finding a report key that starts with the infra name
    const match = serviceKeys.find(
      (k) => k === infraName || k.startsWith(infraName + '-') || k.startsWith('sat-' + infraName),
    );
    return match ? services[match] : undefined;
  }

  for (const [serviceName, infraData] of Object.entries(infraFile.services)) {
    let svcData = findServiceData(serviceName);

    // Create a stub entry for infra-only services (datastores, untested services)
    // so their CPU/memory usage appears in the report
    if (!svcData && (infraData.infra || infraData.dataStore)) {
      services[serviceName] = {};
      svcData = services[serviceName] as Record<string, unknown>;
    }

    if (svcData) {
      if (infraData.infra) {
        svcData.infra = infraData.infra;
        enrichedCount++;
      }

      if (infraData.dataStore) {
        svcData.dataStoreInfra = infraData.dataStore;
        enrichedCount++;
      }
    }

    // Collect deployment info for the infrastructure overview
    if (infraData.deployment) {
      deployments.push({
        name: serviceName,
        kind: infraData.deployment.kind ?? 'Deployment',
        replicas: infraData.deployment.replicas ?? 0,
        readyReplicas: infraData.deployment.readyReplicas ?? 0,
        cpuRequest: infraData.deployment.cpuRequest ?? 'N/A',
        memoryRequest: infraData.deployment.memoryRequest ?? 'N/A',
        cpuLimit: infraData.deployment.cpuLimit ?? 'N/A',
        memoryLimit: infraData.deployment.memoryLimit ?? 'N/A',
      });
    }
  }

  context.hasInfraMetrics = enrichedCount > 0 || deployments.length > 0;
  context.infraMetricsSource = infraFile.source ?? 'Coroot';
  context.corootProject = infraFile.project ?? '';

  // Pass through service-to-datastore latency breakdown
  if (infraFile.serviceLatency && infraFile.serviceLatency.length > 0) {
    context.serviceLatency = infraFile.serviceLatency;
    context.hasServiceLatency = true;
  }

  if (deployments.length > 0) {
    context.deployments = deployments;
    context.hasDeployments = true;
  }

  // Cluster nodes
  if (infraFile.nodes && infraFile.nodes.length > 0) {
    context.nodes = infraFile.nodes;
    context.hasNodes = true;
    context.nodeCount = infraFile.nodes.length;
    context.clusterCloud = infraFile.nodes[0]?.cloudProvider ?? 'unknown';
    context.clusterRegion = infraFile.nodes[0]?.region ?? 'unknown';
  }

  // Pod-to-node placement
  if (infraFile.podPlacement && infraFile.podPlacement.length > 0) {
    context.podPlacement = infraFile.podPlacement;
    context.hasPodPlacement = true;
  }

  // Build per-pod capacity recommendations
  const recommendations: Array<Record<string, unknown>> = [];
  const deploymentsByName: Record<string, Record<string, unknown>> = {};
  for (const d of deployments) {
    deploymentsByName[d.name as string] = d;
  }

  for (const [svcName, svcResult] of Object.entries(services)) {
    const svc = svcResult as {
      throughput?: string;
      vus?: number;
      latency?: { p95Ms?: number; p99Ms?: number; avgMs?: number };
      errorRate?: number;
    };
    const throughput = parseFloat(svc.throughput ?? '0');
    const vus = svc.vus ?? 0;
    if (throughput <= 0) continue;

    const cleanName = svcName
      .replace(/^sat-/, '')
      .replace(/-saturation$/, '')
      .replace(/-service$/, '');
    const depInfo = deploymentsByName[cleanName] ?? deploymentsByName[svcName];
    const replicas = (depInfo?.replicas as number) ?? 0;

    if (replicas > 0) {
      const perPodRps = throughput / replicas;
      const perPodVUs = Math.round(vus / replicas);
      const p95 = svc.latency?.p95Ms ?? 0;
      const p99 = svc.latency?.p99Ms ?? 0;
      const errorRate = svc.errorRate ?? 0;

      recommendations.push({
        service: cleanName,
        replicas,
        totalRps: throughput,
        perPodRps: parseFloat(perPodRps.toFixed(1)),
        totalVUs: vus,
        perPodVUs,
        p95Ms: parseFloat(p95.toFixed(1)),
        p99Ms: parseFloat(p99.toFixed(1)),
        errorRate: parseFloat((errorRate * 100).toFixed(2)),
        healthy: errorRate < 0.01 && p95 < 2000,
      });
    }
  }

  if (recommendations.length > 0) {
    context.recommendations = recommendations;
    context.hasRecommendations = true;
  }

  process.stdout.write(
    `  Merged infra metrics for ${enrichedCount} service(s) from ${infraMetricsPath}\n`,
  );
}

// ---------------------------------------------------------------------------
// Insights & Recommendations Engine
// ---------------------------------------------------------------------------

interface Insight {
  category: 'positive' | 'warning' | 'critical' | 'improvement';
  area: string;
  message: string;
}

/**
 * Analyze the full report context and generate actionable insights.
 *
 * Categories:
 *   positive    — things that went well
 *   warning     — areas of concern, not yet critical
 *   critical    — issues that need immediate attention
 *   improvement — concrete actions to improve performance
 */
export function generateInsights(context: Record<string, unknown>): void {
  const insights: Insight[] = [];
  const services = (context.services ?? {}) as Record<string, Record<string, unknown>>;
  const serviceLatency = (context.serviceLatency ?? []) as Array<{
    client: string;
    dataStore: string;
    requestLatencyMs: number | null;
    tcpLatencyMs: number | null;
    rps: number | null;
  }>;

  // --- Analyze per-service k6 results ---
  for (const [name, svc] of Object.entries(services)) {
    const errorRate = Number(svc.errorRate ?? 0);
    const latency = svc.latency as {
      p95Ms?: number;
      p99Ms?: number;
      avgMs?: number;
      maxMs?: number;
    } | null;
    const infra = svc.infra as {
      cpuPeak?: string;
      cpuAvg?: string;
      memoryPeak?: string;
      memoryAvg?: string;
      podRestarts?: number;
      oomKills?: number;
      observedRps?: number;
    } | null;
    const dsInfra = svc.dataStoreInfra as {
      connections?: { used: number; max: number };
      connectionBreakdown?: Array<{ client: string; used: number; max: number }>;
      resources?: { cpuUsage?: string; memoryUsage?: string; diskUsageGB?: number };
    } | null;

    // Error rate
    if (errorRate === 0) {
      insights.push({
        category: 'positive',
        area: name,
        message: 'Zero error rate — all requests succeeded.',
      });
    } else if (errorRate > 5) {
      insights.push({
        category: 'critical',
        area: name,
        message: `High error rate (${errorRate.toFixed(1)}%). Investigate failing endpoints and error logs.`,
      });
    } else if (errorRate > 1) {
      insights.push({
        category: 'warning',
        area: name,
        message: `Error rate ${errorRate.toFixed(1)}% exceeds 1% threshold. Review error patterns.`,
      });
    }

    // Latency
    if (latency) {
      const p95 = latency.p95Ms ?? 0;
      const p99 = latency.p99Ms ?? 0;
      const avg = latency.avgMs ?? 0;
      const max = latency.maxMs ?? 0;

      if (p95 > 0 && p95 < 500) {
        insights.push({
          category: 'positive',
          area: name,
          message: `p95 latency (${p95.toFixed(0)}ms) is well within 500ms target.`,
        });
      } else if (p95 > 2000) {
        insights.push({
          category: 'critical',
          area: name,
          message: `p95 latency (${p95.toFixed(0)}ms) exceeds 2s. This service is a bottleneck under load.`,
        });
      } else if (p95 > 500) {
        insights.push({
          category: 'warning',
          area: name,
          message: `p95 latency (${p95.toFixed(0)}ms) exceeds 500ms target. Consider scaling or optimizing.`,
        });
      }

      // Tail latency spread — p99 >> p95 indicates occasional outliers
      if (p95 > 0 && p99 > p95 * 2.5) {
        insights.push({
          category: 'warning',
          area: name,
          message: `Large tail latency spread: p99 (${p99.toFixed(0)}ms) is ${(p99 / p95).toFixed(1)}x p95 (${p95.toFixed(0)}ms). Investigate GC pauses, connection pool exhaustion, or cold starts.`,
        });
      }

      // Max latency spike
      if (avg > 0 && max > avg * 10) {
        insights.push({
          category: 'warning',
          area: name,
          message: `Max latency spike: ${max.toFixed(0)}ms is ${(max / avg).toFixed(0)}x the average (${avg.toFixed(0)}ms). Likely cold start or resource contention.`,
        });
      }
    }

    // Infrastructure — OOM / restarts
    if (infra) {
      if (infra.oomKills && infra.oomKills > 0) {
        insights.push({
          category: 'critical',
          area: name,
          message: `${infra.oomKills} OOM kill(s) detected. Increase memory limits or reduce per-request memory usage.`,
        });
      }
      if (infra.podRestarts && infra.podRestarts > 0) {
        insights.push({
          category: 'warning',
          area: name,
          message: `${infra.podRestarts} pod restart(s) during test. Check liveness probes and resource limits.`,
        });
      }

      // CPU headroom
      const cpuPeakNum = parseCpuToMillicores(infra.cpuPeak);
      if (cpuPeakNum !== null && cpuPeakNum < 100) {
        insights.push({
          category: 'positive',
          area: name,
          message: `Low CPU usage (peak ${infra.cpuPeak}). Service has ample CPU headroom.`,
        });
      }
    }

    // Data store connections
    if (dsInfra?.connections) {
      const { used, max } = dsInfra.connections;
      if (max > 0 && used / max > 0.85) {
        insights.push({
          category: 'critical',
          area: name,
          message: `Connection pool near saturation: ${used}/${max} (${((used / max) * 100).toFixed(0)}%). Risk of connection refused errors under load spikes.`,
        });
      } else if (max > 0 && used / max > 0.6) {
        insights.push({
          category: 'warning',
          area: name,
          message: `Connection pool at ${((used / max) * 100).toFixed(0)}% capacity (${used}/${max}). Monitor under higher load.`,
        });
      }
    }
  }

  // --- Analyze service-to-datastore latency ---
  for (const entry of serviceLatency) {
    if (entry.tcpLatencyMs !== null && entry.tcpLatencyMs > 5) {
      insights.push({
        category: 'warning',
        area: `${entry.client} → ${entry.dataStore}`,
        message: `TCP latency ${entry.tcpLatencyMs.toFixed(1)}ms is elevated. Check network path, pod placement (same zone?), or DNS resolution.`,
      });
    }
    if (entry.requestLatencyMs !== null && entry.requestLatencyMs > 10) {
      insights.push({
        category: 'warning',
        area: `${entry.client} → ${entry.dataStore}`,
        message: `Request latency ${entry.requestLatencyMs.toFixed(1)}ms. Consider query optimization, indexing, or caching.`,
      });
    } else if (entry.requestLatencyMs !== null && entry.requestLatencyMs <= 2) {
      insights.push({
        category: 'positive',
        area: `${entry.client} → ${entry.dataStore}`,
        message: `Request latency ${entry.requestLatencyMs.toFixed(1)}ms — fast data store access.`,
      });
    }
  }

  // --- Overall assessment ---
  const overallErrorRate = Number(context.overallErrorRate ?? 0);
  if (overallErrorRate === 0) {
    insights.push({
      category: 'positive',
      area: 'Overall',
      message: 'All tests completed with zero errors across all services.',
    });
  }

  // --- Generate improvement suggestions based on findings ---
  const criticals = insights.filter((i) => i.category === 'critical');
  const warnings = insights.filter((i) => i.category === 'warning');

  if (criticals.length === 0 && warnings.length === 0) {
    insights.push({
      category: 'improvement',
      area: 'Scaling',
      message:
        'All metrics healthy. Consider increasing VU count to find the saturation point and establish scaling thresholds.',
    });
  }

  // Check for services with high latency + low CPU — likely model/external-API bound
  for (const [name, svc] of Object.entries(services)) {
    const latency = svc.latency as { p95Ms?: number; avgMs?: number } | null;
    const infra = svc.infra as { cpuPeak?: string; cpuAvg?: string } | null;
    if (!latency || !infra) continue;
    const p95 = latency.p95Ms ?? 0;
    const avg = latency.avgMs ?? 0;
    const cpuPeakNum = parseCpuToMillicores(infra.cpuPeak);
    const cpuAvgNum = parseCpuToMillicores(infra.cpuAvg);
    if (p95 > 1000 && cpuPeakNum !== null && cpuPeakNum < 500) {
      insights.push({
        category: 'warning',
        area: name,
        message:
          `High latency (p95=${p95.toFixed(0)}ms, avg=${avg.toFixed(0)}ms) with low CPU (peak=${infra.cpuPeak}, avg=${infra.cpuAvg}). ` +
          `Service is NOT CPU-bound — latency is dominated by external model endpoint or downstream I/O. ` +
          `Scaling pods will NOT reduce latency; optimize model endpoint (batch size, model selection, provisioned throughput) or add request queuing.`,
      });
    } else if (p95 > 500 && cpuPeakNum !== null && cpuAvgNum !== null && cpuAvgNum < 200) {
      insights.push({
        category: 'improvement',
        area: name,
        message:
          `Moderate latency (p95=${p95.toFixed(0)}ms) with low avg CPU (${infra.cpuAvg}). ` +
          `Latency likely driven by external API calls (model endpoint, data store queries). ` +
          `Profile request breakdown to identify the dominant wait.`,
      });
    }
  }

  // Check for uneven data store load distribution
  for (const [name, svc] of Object.entries(services)) {
    const dsInfra = svc.dataStoreInfra as {
      connectionBreakdown?: Array<{ client: string; used: number; max: number }>;
    } | null;
    if (!dsInfra?.connectionBreakdown || dsInfra.connectionBreakdown.length < 2) continue;
    const conns = dsInfra.connectionBreakdown.map((c) => c.used);
    const maxConn = Math.max(...conns);
    const minConn = Math.min(...conns);
    if (maxConn > 0 && minConn > 0 && maxConn / minConn > 10) {
      const heavy = dsInfra.connectionBreakdown.find((c) => c.used === maxConn);
      insights.push({
        category: 'improvement',
        area: name,
        message: `Uneven connection distribution: ${heavy?.client} uses ${maxConn} connections vs ${minConn} min. Consider connection pooling or load distribution.`,
      });
    }
  }

  // --- Node-level insights ---
  const nodes = (context.nodes ?? []) as Array<{
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
  }>;
  const podPlacement = (context.podPlacement ?? []) as Array<{
    service: string;
    pod: string;
    node: string;
    cpuRequest: string;
    cpuLimit: string;
    memoryRequest: string;
    memoryLimit: string;
  }>;

  // Check for overloaded nodes
  for (const node of nodes) {
    if (node.cpuUsagePercent > 80) {
      insights.push({
        category: 'critical',
        area: `node:${node.name}`,
        message: `CPU usage at ${node.cpuUsagePercent}% on ${node.instanceType} (${node.cpuCapacity} vCPU). Risk of throttling and scheduling failures.`,
      });
    } else if (node.cpuUsagePercent > 60) {
      insights.push({
        category: 'warning',
        area: `node:${node.name}`,
        message: `CPU usage at ${node.cpuUsagePercent}% on ${node.instanceType}. Limited burst headroom under load spikes.`,
      });
    }
    if (node.memoryUsagePercent > 85) {
      insights.push({
        category: 'critical',
        area: `node:${node.name}`,
        message: `Memory usage at ${node.memoryUsagePercent}% on ${node.instanceType} (${node.memoryCapacityGi.toFixed(0)} GiB). OOM eviction risk.`,
      });
    } else if (node.memoryUsagePercent > 70) {
      insights.push({
        category: 'warning',
        area: `node:${node.name}`,
        message: `Memory usage at ${node.memoryUsagePercent}% on ${node.instanceType}. Monitor for eviction pressure.`,
      });
    }
  }

  // Detect co-location risks: compute service + data store on the same node
  if (podPlacement.length > 0) {
    const DATA_STORES = new Set([
      'mongodb',
      'redis',
      'clickhouse',
      'opensearch',
      'neo4j',
      'qdrant',
      'restate',
    ]);
    const COMPUTE_SERVICES = new Set([
      'runtime',
      'search-ai',
      'search-ai-runtime',
      'studio',
      'admin',
    ]);

    // Group pods by node
    const podsByNode = new Map<string, Array<{ service: string; pod: string }>>();
    for (const pp of podPlacement) {
      if (!podsByNode.has(pp.node)) podsByNode.set(pp.node, []);
      podsByNode.get(pp.node)!.push({ service: pp.service, pod: pp.pod });
    }

    for (const [nodeName, nodePods] of podsByNode) {
      const dsOnNode = nodePods.filter((p) => DATA_STORES.has(p.service));
      const computeOnNode = nodePods.filter((p) => COMPUTE_SERVICES.has(p.service));

      // Flag compute + data store co-location
      if (dsOnNode.length > 0 && computeOnNode.length > 0) {
        const dsNames = [...new Set(dsOnNode.map((p) => p.service))].join(', ');
        const computeNames = [...new Set(computeOnNode.map((p) => p.service))].join(', ');
        const shortNode = nodeName.split('-').slice(-1)[0];
        insights.push({
          category: 'warning',
          area: `node:${shortNode}`,
          message: `Co-location risk: ${computeNames} and ${dsNames} share the same node. CPU burst contention under load. Consider pod anti-affinity or dedicated node pools.`,
        });
      }

      // Flag multiple data stores on the same node
      if (dsOnNode.length > 1) {
        const dsNames = [...new Set(dsOnNode.map((p) => p.service))].join(', ');
        const shortNode = nodeName.split('-').slice(-1)[0];
        insights.push({
          category: 'improvement',
          area: `node:${shortNode}`,
          message: `Multiple data stores (${dsNames}) on one node. For I/O isolation, spread data stores across nodes with anti-affinity rules.`,
        });
      }
    }

    // Node type recommendations based on workload and cloud provider
    const nodeTypes = new Set(nodes.map((n) => n.instanceType));
    const cloudProvider = nodes[0]?.cloudProvider ?? 'unknown';
    const hasOnlyGeneralPurpose = [...nodeTypes].every(
      (t) =>
        t.includes('Standard_D') ||
        t.includes('m5.') ||
        t.includes('m6i.') ||
        t.includes('m7i.') ||
        t === 'unknown',
    );

    if (hasOnlyGeneralPurpose && nodes.length > 3) {
      // Cloud-specific node pool recommendations
      if (cloudProvider === 'Azure') {
        insights.push({
          category: 'improvement',
          area: 'cluster',
          message:
            'All nodes use general-purpose D-series. Recommended node pool strategy: ' +
            '(1) **Data pool**: Standard_E4s_v5 (memory-optimized, 4 vCPU / 32 GiB) for MongoDB, Redis, ClickHouse, OpenSearch, Neo4j — 2x RAM per vCPU for caching and connection pools. ' +
            '(2) **Compute pool**: Standard_D4s_v5 or Standard_F4s_v2 (compute-optimized) for Runtime, Studio, Search-AI. ' +
            '(3) **ML pool**: Standard_D8s_v5 (8 vCPU / 32 GiB) for BGE-M3, Docling — CPU-intensive inference workloads.',
        });
      } else if (cloudProvider === 'AWS') {
        insights.push({
          category: 'improvement',
          area: 'cluster',
          message:
            'All nodes use general-purpose instances. Recommended node pool strategy: ' +
            '(1) **Data pool**: r6i.xlarge (memory-optimized, 4 vCPU / 32 GiB) for data stores. ' +
            '(2) **Compute pool**: m6i.xlarge or c6i.xlarge for API services. ' +
            '(3) **ML pool**: c6i.2xlarge for inference workloads.',
        });
      } else if (cloudProvider === 'GCP') {
        insights.push({
          category: 'improvement',
          area: 'cluster',
          message:
            'All nodes use general-purpose instances. Recommended node pool strategy: ' +
            '(1) **Data pool**: n2-highmem-4 (memory-optimized) for data stores. ' +
            '(2) **Compute pool**: n2-standard-4 for API services. ' +
            '(3) **ML pool**: c2-standard-8 for inference workloads.',
        });
      } else {
        insights.push({
          category: 'improvement',
          area: 'cluster',
          message:
            'All nodes use general-purpose instances. Consider dedicated node pools: ' +
            'memory-optimized for data stores, compute-optimized for ML workloads.',
        });
      }
    }

    // Redis cluster recommendation if single-instance with high connection count
    const redisPods = podPlacement.filter((p) => p.service === 'redis');
    const redisDs = services['redis']?.dataStoreInfra as {
      connections?: { used: number; max: number };
    } | null;
    if (redisPods.length === 1 && redisDs?.connections) {
      const { used } = redisDs.connections;
      if (used > 100) {
        insights.push({
          category: 'improvement',
          area: 'redis',
          message:
            `Single Redis instance with ${used} connections. For HA and read scaling: ` +
            'deploy Redis Sentinel (3 nodes) or Redis Cluster (6 nodes min). ' +
            'Separate BullMQ queue connections from cache reads using dedicated Redis instances.',
        });
      }
    }

    // Single AZ warning
    const azs = new Set(nodes.map((n) => n.availabilityZone).filter((z) => z !== 'unknown'));
    if (azs.size <= 1 && nodes.length > 2) {
      insights.push({
        category: 'warning',
        area: 'cluster',
        message:
          `All ${nodes.length} nodes are in a single availability zone${azs.size === 1 ? ` (${[...azs][0]})` : ''}. ` +
          'No zone-level fault tolerance. Spread nodes across 3 AZs for production resilience.',
      });
    }
  }

  // --- Service-to-datastore latency pattern: model endpoint detection ---
  // If the tested service has high latency but low CPU, and there are high-latency
  // data store connections, identify the dominant latency contributor
  const highLatencyDsEntries = serviceLatency.filter(
    (e) => e.requestLatencyMs !== null && e.requestLatencyMs > 500,
  );
  if (highLatencyDsEntries.length > 0) {
    const dsNames = highLatencyDsEntries
      .map((e) => `${e.dataStore} (${e.requestLatencyMs}ms)`)
      .join(', ');
    insights.push({
      category: 'improvement',
      area: 'latency-analysis',
      message:
        `High data store latency detected: ${dsNames}. ` +
        'If these are BullMQ BRPOP operations (blocked waiting for jobs), the latency is expected and not a bottleneck. ' +
        'Check Redis SLOWLOG and separate queue connections from cache connections to confirm.',
    });
  }

  if (insights.length > 0) {
    const positives = insights.filter((i) => i.category === 'positive');
    const improvements = insights.filter((i) => i.category === 'improvement');
    context.insights = {
      positives,
      warnings,
      criticals,
      improvements,
      hasPositives: positives.length > 0,
      hasWarnings: warnings.length > 0,
      hasCriticals: criticals.length > 0,
      hasImprovements: improvements.length > 0,
    };
    context.hasInsights = true;
  }
}

/** Parse CPU string like "250m" or "1.5 cores" to millicores. */
function parseCpuToMillicores(cpu: string | null | undefined): number | null {
  if (!cpu) return null;
  const str = String(cpu).trim();
  if (str.endsWith('m')) {
    const num = parseFloat(str);
    return Number.isNaN(num) ? null : num;
  }
  if (str.includes('core')) {
    const num = parseFloat(str);
    return Number.isNaN(num) ? null : num * 1000;
  }
  const num = parseFloat(str);
  if (Number.isNaN(num)) return null;
  return num > 10 ? num : num * 1000;
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerReportCommands(sizing: Command): void {
  sizing
    .command('report')
    .description('Generate a saturation benchmark report from a CalibrationProfile')
    .requiredOption('--calibration <path>', 'Path to CalibrationProfile JSON')
    .option('--questionnaire <path>', 'Path to questionnaire JSON (for customer report)')
    .option('--format <format>', 'Output format: md or pdf', 'md')
    .option('--output-dir <dir>', 'Output directory for generated reports', '.')
    .action(
      async (opts: {
        calibration: string;
        questionnaire?: string;
        format: string;
        outputDir: string;
      }) => {
        // Auto-load benchmarks/config/cloud.env (real env vars take precedence)
        await loadCloudEnv();
        registerHandlebarsHelpers();

        const context = await buildSaturationReportContext(opts.calibration, opts.questionnaire);

        await mkdir(opts.outputDir, { recursive: true });

        // Generate internal report
        const internalTemplate = await loadTemplate('internal');
        const internalMd = internalTemplate(context);
        const internalMdPath = join(opts.outputDir, 'saturation-report-internal.md');
        await writeFile(internalMdPath, internalMd);
        console.log(`Internal report written to ${internalMdPath}`);

        // Generate customer report
        const customerTemplate = await loadTemplate('customer');
        const customerMd = customerTemplate(context);
        const customerMdPath = join(opts.outputDir, 'saturation-report-customer.md');
        await writeFile(customerMdPath, customerMd);
        console.log(`Customer report written to ${customerMdPath}`);

        if (opts.format === 'pdf') {
          const repoRoot = await findRepoRoot();
          const cssPath = join(repoRoot, 'benchmarks', 'report', 'styles', 'customer-report.css');

          const internalPdfPath = join(opts.outputDir, 'saturation-report-internal.pdf');
          const customerPdfPath = join(opts.outputDir, 'saturation-report-customer.pdf');

          const internalOk = await generatePdf(internalMdPath, internalPdfPath, cssPath);
          if (internalOk) {
            console.log(`Internal PDF written to ${internalPdfPath}`);
          }

          const customerOk = await generatePdf(customerMdPath, customerPdfPath, cssPath);
          if (customerOk) {
            console.log(`Customer PDF written to ${customerPdfPath}`);
          }
        }
      },
    );

  sizing
    .command('load-report')
    .description('Generate a load test report from k6 summary results')
    .option('--results <dir>', 'Directory containing k6 JSON summaries')
    .option(
      '--cloud',
      'Fetch results from k6 Cloud API (requires K6_CLOUD_TOKEN and K6_CLOUD_PROJECT_ID)',
      false,
    )
    .option('--last <count>', 'Use the last N test runs', '1')
    .option('--compare <dir>', 'Directory with previous run for comparison')
    .option(
      '--infra-metrics <path>',
      'Path to infra metrics JSON (collected via Coroot MCP tools) — adds CPU, memory, connections',
    )
    .option(
      '--services <names>',
      'Comma-separated service names to include (filters cloud tests by name match)',
    )
    .option('--test-type <type>', 'Filter cloud tests by type: saturation, service, integration')
    .option('--tier <tier>', 'Deployment tier: s, m, l, xl (adds tier config to report)')
    .option('--format <format>', 'Output format: md or pdf', 'md')
    .option('--output-dir <dir>', 'Output directory for generated reports', '.')
    .action(
      async (opts: {
        results?: string;
        cloud: boolean;
        tier?: string;
        last: string;
        compare?: string;
        infraMetrics?: string;
        services?: string;
        testType?: string;
        format: string;
        outputDir: string;
      }) => {
        // Auto-load benchmarks/config/cloud.env (real env vars take precedence)
        await loadCloudEnv();
        registerHandlebarsHelpers();

        let context: Record<string, unknown>;

        if (opts.cloud) {
          const token = process.env.K6_CLOUD_TOKEN;
          const projectId = process.env.K6_CLOUD_PROJECT_ID;

          if (!token) {
            console.error(
              'K6_CLOUD_TOKEN environment variable is required when using --cloud. ' +
                'Set it in benchmarks/config/cloud.env or export K6_CLOUD_TOKEN.',
            );
            process.exit(1);
          }
          if (!projectId) {
            console.error(
              'K6_CLOUD_PROJECT_ID environment variable is required when using --cloud. ' +
                'Set it in benchmarks/config/cloud.env or export K6_CLOUD_PROJECT_ID.',
            );
            process.exit(1);
          }

          const last = parseInt(opts.last, 10) || 1;
          const serviceFilter = opts.services
            ? opts.services
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : undefined;
          context = await fetchCloudResults(projectId, token, last, {
            services: serviceFilter,
            testType: opts.testType,
          });

          // Extract LLM metrics from cloud service data into top-level context
          const cloudServices = context.services as Record<
            string,
            { llmMetrics?: CloudLLMMetrics; latency?: { avgMs?: number } }
          >;
          for (const svc of Object.values(cloudServices)) {
            if (svc.llmMetrics) {
              context.hasLLMMetrics = true;
              context.llmLatency = {
                avgMs: svc.llmMetrics.avgMs,
                medianMs: svc.llmMetrics.medianMs,
                p95Ms: svc.llmMetrics.p95Ms,
                maxMs: svc.llmMetrics.maxMs,
              };
              context.llmTokens = {
                input: svc.llmMetrics.inputTokens,
                output: svc.llmMetrics.outputTokens,
              };
              // Compute overall avg for LLM % calculation
              const svcAvgValues = Object.values(cloudServices)
                .map((s) => s.latency?.avgMs ?? 0)
                .filter((v) => v > 0);
              context.overallAvgMs =
                svcAvgValues.length > 0
                  ? parseFloat(
                      (svcAvgValues.reduce((a, b) => a + b, 0) / svcAvgValues.length).toFixed(1),
                    )
                  : 0;
              break; // first service with LLM data
            }
          }

          // Extract WebSocket metrics from cloud service data and populate `websocket` on each service
          const cloudSvcsForWs = context.services as Record<
            string,
            { wsMetrics?: CloudWSMetrics; websocket?: unknown }
          >;
          for (const svc of Object.values(cloudSvcsForWs)) {
            if (svc.wsMetrics) {
              svc.websocket = buildWebSocketContext(svc.wsMetrics);
            }
          }

          process.stderr.write(
            `Fetched ${Object.keys(context.services as Record<string, unknown>).length} service result(s) from k6 Cloud.\n`,
          );
        } else {
          if (!opts.results) {
            console.error(
              '--results is required (path to directory with k6 JSON summaries), ' +
                'or use --cloud to fetch from k6 Cloud.',
            );
            process.exit(1);
          }

          context = await buildLoadTestReportContext(
            resolve(opts.results),
            opts.compare ? resolve(opts.compare) : undefined,
          );
        }

        // Enrich with tier config and scenario weights
        if (opts.tier) {
          context.tier = opts.tier;
          try {
            const repoRoot = await findRepoRoot();
            const tierProfilesRaw = await readFile(
              join(repoRoot, 'benchmarks', 'config', 'tier-profiles.json'),
              'utf-8',
            );
            const tierProfiles = JSON.parse(tierProfilesRaw) as Record<
              string,
              Record<string, unknown>
            >;
            if (tierProfiles[opts.tier]) {
              context.tierConfig = tierProfiles[opts.tier];
            }

            const weightsRaw = await readFile(
              join(repoRoot, 'benchmarks', 'config', 'scenario-weights.json'),
              'utf-8',
            );
            const allWeights = JSON.parse(weightsRaw) as Record<string, Record<string, number>>;
            // Filter to only tested services
            const testedServices = Object.keys(context.services as Record<string, unknown>);
            const filteredWeights: Record<string, Record<string, number>> = {};
            for (const svc of testedServices) {
              const cleanName = svc.replace(/^sat-/, '');
              if (allWeights[cleanName]) {
                filteredWeights[cleanName] = allWeights[cleanName];
              }
            }
            if (Object.keys(filteredWeights).length > 0) {
              context.scenarioWeights = filteredWeights;
            }
          } catch {
            // Config files not found — skip
          }
        }

        // Enrich with infra metrics if provided (collected via Coroot MCP tools)
        if (opts.infraMetrics) {
          console.log(`Merging infra metrics from ${opts.infraMetrics}...`);
          await mergeInfraMetrics(context, resolve(opts.infraMetrics));
        }

        // Generate insights and recommendations based on all collected data
        generateInsights(context);

        await mkdir(opts.outputDir, { recursive: true });

        const template = await loadTemplate('load-test');
        const markdown = template(context);
        const mdPath = join(opts.outputDir, 'load-test-report.md');
        await writeFile(mdPath, markdown);
        console.log(`Load test report written to ${mdPath}`);

        if (opts.format === 'pdf') {
          const repoRoot = await findRepoRoot();
          const cssPath = join(repoRoot, 'benchmarks', 'report', 'styles', 'customer-report.css');
          const pdfPath = join(opts.outputDir, 'load-test-report.pdf');
          const ok = await generatePdf(mdPath, pdfPath, cssPath);
          if (ok) {
            console.log(`Load test PDF written to ${pdfPath}`);
          }
        }
      },
    );
}

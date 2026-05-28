/**
 * ClickHouse benchmark: bulk trace inserts and time-range analytic queries.
 *
 * Targets ClickHouse HTTP interface directly for high-throughput
 * trace event ingestion and time-series aggregation queries.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { config } from '../lib/config.ts';
import { ensureFreshAuth } from '../lib/auth.ts';
import { dbQueryLatency, dbWriteLatency, successRate } from '../lib/metrics.ts';

const CH_URL = config.clickhouseUrl;
const TENANT_ID = config.tenantId;
const DB = 'abl_traces';

// ---------------------------------------------------------------------------
// Setup — direct service connection (no auth required)
// ---------------------------------------------------------------------------

interface SetupData {
  token: string;
  refreshToken: string;
  headers: Record<string, string>;
}

export function setup(): SetupData {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  return { token: '', refreshToken: '', headers };
}

function query(sql: string, headers: Record<string, string>): http.RefinedResponse<'text'> {
  return http.post(`${CH_URL}/?database=${DB}`, sql, { headers });
}

export const options = {
  scenarios: {
    bulkTraceInsert: {
      executor: 'constant-vus',
      vus: 10,
      duration: '2m',
      exec: 'bulkTraceInsert',
    },
    timeRangeQuery: {
      executor: 'constant-vus',
      vus: 8,
      duration: '2m',
      exec: 'timeRangeQuery',
    },
    aggregationQuery: {
      executor: 'ramping-vus',
      startVUs: 2,
      stages: [
        { duration: '1m', target: 10 },
        { duration: '1m', target: 15 },
      ],
      exec: 'aggregationQuery',
    },
  },
  thresholds: {
    abl_db_write_latency_ms: ['p(95)<300', 'p(99)<800'],
    abl_db_query_latency_ms: ['p(95)<1000', 'p(99)<3000'],
    abl_success_rate: ['rate>0.99'],
  },
};

/** Bulk insert trace events in batches of 100. */
export function bulkTraceInsert(data: SetupData): void {
  ensureFreshAuth(data);

  const eventTypes = ['llm_call', 'tool_call', 'decision', 'constraint_check', 'handoff'];
  const now = Date.now();
  const rows: string[] = [];

  for (let i = 0; i < 100; i++) {
    const eventType = eventTypes[i % eventTypes.length];
    const ts = new Date(now - i * 100).toISOString().replace('T', ' ').replace('Z', '');
    rows.push(
      `('${TENANT_ID}','bench-session-${__VU}','bench-agent','${eventType}',` +
        `'${ts}',${Math.floor(Math.random() * 500)},` +
        `'{"vu":${__VU},"iter":${__ITER},"idx":${i}}')`,
    );
  }

  const sql =
    `INSERT INTO trace_events ` +
    `(tenant_id, session_id, agent_id, event_type, timestamp, duration_ms, metadata) ` +
    `VALUES ${rows.join(',')}`;

  const start = Date.now();
  const res = query(sql, data.headers);
  dbWriteLatency.add(Date.now() - start);

  const ok = check(res, { 'insert 2xx': (r) => r.status >= 200 && r.status < 300 });
  successRate.add(ok ? 1 : 0);
  if (!ok) console.log(`[bulk_trace_insert] status=${res.status}`);

  sleep(0.1);
}

/** Time-range queries filtering trace events within sliding windows. */
export function timeRangeQuery(data: SetupData): void {
  ensureFreshAuth(data);

  const windows = ['1 HOUR', '6 HOUR', '24 HOUR', '7 DAY'];
  const window = windows[__ITER % windows.length];

  const sql =
    `SELECT event_type, count() as cnt, avg(duration_ms) as avg_dur, ` +
    `quantile(0.95)(duration_ms) as p95_dur ` +
    `FROM trace_events ` +
    `WHERE tenant_id = '${TENANT_ID}' ` +
    `AND timestamp >= now() - INTERVAL ${window} ` +
    `GROUP BY event_type ` +
    `ORDER BY cnt DESC ` +
    `FORMAT JSON`;

  const start = Date.now();
  const res = query(sql, data.headers);
  dbQueryLatency.add(Date.now() - start);

  const ok = check(res, { 'time-range 2xx': (r) => r.status >= 200 && r.status < 300 });
  successRate.add(ok ? 1 : 0);
  if (!ok) console.log(`[time_range_query] status=${res.status}`);

  sleep(0.2);
}

/** Heavy aggregation queries: per-session stats, error rates, throughput histograms. */
export function aggregationQuery(data: SetupData): void {
  ensureFreshAuth(data);

  const queries = [
    // Per-session latency percentiles
    `SELECT session_id, quantile(0.5)(duration_ms) as p50, ` +
      `quantile(0.95)(duration_ms) as p95, quantile(0.99)(duration_ms) as p99 ` +
      `FROM trace_events WHERE tenant_id = '${TENANT_ID}' ` +
      `AND timestamp >= now() - INTERVAL 1 HOUR ` +
      `GROUP BY session_id ORDER BY p95 DESC LIMIT 50 FORMAT JSON`,

    // Error rate per agent over time buckets
    `SELECT agent_id, ` +
      `toStartOfFiveMinutes(timestamp) as bucket, ` +
      `countIf(event_type = 'error') as errors, ` +
      `count() as total ` +
      `FROM trace_events WHERE tenant_id = '${TENANT_ID}' ` +
      `AND timestamp >= now() - INTERVAL 6 HOUR ` +
      `GROUP BY agent_id, bucket ORDER BY bucket DESC FORMAT JSON`,

    // Throughput histogram (events per minute)
    `SELECT toStartOfMinute(timestamp) as minute, count() as events_per_min ` +
      `FROM trace_events WHERE tenant_id = '${TENANT_ID}' ` +
      `AND timestamp >= now() - INTERVAL 1 HOUR ` +
      `GROUP BY minute ORDER BY minute FORMAT JSON`,
  ];

  const sql = queries[__ITER % queries.length];
  const start = Date.now();
  const res = query(sql, data.headers);
  dbQueryLatency.add(Date.now() - start);

  const ok = check(res, { 'aggregation 2xx': (r) => r.status >= 200 && r.status < 300 });
  successRate.add(ok ? 1 : 0);
  if (!ok) console.log(`[aggregation_query] status=${res.status}`);

  sleep(0.3);
}

// ---------------------------------------------------------------------------
// Default export — allows `k6 run --vus 1 --iterations 1` quick smoke tests
// ---------------------------------------------------------------------------

export default function (data: SetupData): void {
  bulkTraceInsert(data);
}

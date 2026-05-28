/**
 * Disk Pressure Test
 *
 * Sustained write workload to test storage I/O limits.
 * Targets document ingestion, trace logging, and session persistence.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { config, apiPath } from '../lib/config.ts';
import { ensureFreshAuth, getAuthToken, getRefreshToken, makeAuthHeaders } from '../lib/auth.ts';
import {
  dbWriteLatency,
  ingestionRate,
  queueDepth,
  successRate,
  errorCount,
} from '../lib/metrics.ts';
import { Trend, Counter, Gauge } from 'k6/metrics';

const RUNTIME = config.runtimeUrl;
const SEARCH_AI = config.searchAiUrl;
const PROJECT_ID = config.projectId;

interface SetupData {
  token: string;
  refreshToken: string;
  headers: Record<string, string>;
}

export function setup(): SetupData {
  const token = getAuthToken();
  const refreshToken = getRefreshToken();
  const headers = makeAuthHeaders(token, refreshToken);
  return { token, refreshToken, headers };
}

const writeOpsPerSec = new Gauge('abl_write_ops_per_sec');
const totalBytesWritten = new Counter('abl_total_bytes_written');
const writeDegradation = new Trend('abl_write_degradation_ms', true);

/** Generate a document with approximately the given size in KB */
function generateLargeContent(sizeKB: number): string {
  const base =
    'Enterprise knowledge base document for disk pressure benchmarking. ' +
    'This content simulates real-world document ingestion with representative text patterns. ' +
    'The document covers topics including agent configuration, workflow automation, ' +
    'multi-tenant architecture, and deployment best practices. ';

  const repeats = Math.ceil((sizeKB * 1024) / base.length);
  return base.repeat(repeats).substring(0, sizeKB * 1024);
}

export const options = {
  scenarios: {
    heavy_document_writes: {
      executor: 'constant-arrival-rate',
      rate: 10,
      timeUnit: '1s',
      duration: '10m',
      preAllocatedVUs: 15,
      maxVUs: 40,
      exec: 'heavyDocumentWrites',
    },
    trace_event_flood: {
      executor: 'constant-arrival-rate',
      rate: 50,
      timeUnit: '1s',
      duration: '10m',
      preAllocatedVUs: 25,
      maxVUs: 60,
      exec: 'traceEventFlood',
    },
    session_persistence: {
      executor: 'constant-arrival-rate',
      rate: 20,
      timeUnit: '1s',
      duration: '10m',
      preAllocatedVUs: 15,
      maxVUs: 40,
      exec: 'sessionPersistence',
    },
    large_document_ingestion: {
      executor: 'per-vu-iterations',
      vus: 3,
      iterations: 30,
      startTime: '2m',
      exec: 'largeDocumentIngestion',
    },
    write_throughput_monitor: {
      executor: 'constant-arrival-rate',
      rate: 1,
      timeUnit: '10s',
      duration: '10m',
      preAllocatedVUs: 1,
      maxVUs: 2,
      exec: 'writeThroughputMonitor',
    },
  },
  thresholds: {
    'http_req_duration{scenario:heavy_document_writes}': ['p(95)<5000', 'p(99)<10000'],
    'http_req_duration{scenario:trace_event_flood}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{scenario:session_persistence}': ['p(95)<1000', 'p(99)<2000'],
    http_req_failed: ['rate<0.05'],
    abl_db_write_latency_ms: ['p(95)<3000', 'p(99)<8000'],
    abl_success_rate: ['rate>0.90'],
  },
};

/** High volume document writes to Search AI (MongoDB + OpenSearch) */
export function heavyDocumentWrites(data: SetupData): void {
  ensureFreshAuth(data);

  const docId = `disk-doc-${__VU}-${__ITER}-${Date.now()}`;
  const content = generateLargeContent(10); // 10KB per document

  const payload = JSON.stringify({
    documents: [
      {
        id: docId,
        title: `Disk Pressure Document ${docId}`,
        content,
        metadata: { source: 'disk-pressure-test', sizeKB: 10 },
      },
    ],
  });

  totalBytesWritten.add(payload.length);
  const start = Date.now();

  const res = http.post(`${SEARCH_AI}${apiPath(`/projects/${PROJECT_ID}/documents`)}`, payload, {
    headers: data.headers,
    tags: { scenario: 'heavy_document_writes' },
    timeout: '15s',
  });

  dbWriteLatency.add(Date.now() - start);
  writeDegradation.add(Date.now() - start);

  const ok = check(res, {
    'doc write accepted': (r) => r.status === 200 || r.status === 201 || r.status === 202,
  });

  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[heavy_document_writes] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(0.1);
}

/** Flood trace events to ClickHouse via Runtime */
export function traceEventFlood(data: SetupData): void {
  ensureFreshAuth(data);

  const tracePayload = JSON.stringify({
    events: Array.from({ length: 10 }, (_, i) => ({
      type: 'benchmark_trace',
      timestamp: new Date().toISOString(),
      sessionId: `disk-pressure-${__VU}`,
      agentId: 'benchmark-agent',
      data: {
        step: i,
        message: `Trace event ${i} for disk pressure test iteration ${__ITER}`,
        metadata: { vuId: __VU, iter: __ITER, eventIndex: i },
      },
    })),
  });

  totalBytesWritten.add(tracePayload.length);
  const start = Date.now();

  const res = http.post(`${RUNTIME}${apiPath(`/projects/${PROJECT_ID}/traces`)}`, tracePayload, {
    headers: data.headers,
    tags: { scenario: 'trace_event_flood' },
  });

  dbWriteLatency.add(Date.now() - start);

  const ok = check(res, {
    'trace write accepted': (r) => r.status === 200 || r.status === 202,
  });

  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[trace_event_flood] status=${res.status}`);
    errorCount.add(1);
  }
}

/** Rapid session creation and message persistence */
export function sessionPersistence(data: SetupData): void {
  ensureFreshAuth(data);

  const sessionPayload = JSON.stringify({
    agentId: 'benchmark-agent',
    metadata: { source: 'disk-pressure-test', vuId: __VU },
  });

  const start = Date.now();
  const sessionRes = http.post(
    `${RUNTIME}${apiPath(`/projects/${PROJECT_ID}/sessions`)}`,
    sessionPayload,
    {
      headers: data.headers,
      tags: { scenario: 'session_persistence' },
    },
  );

  if (sessionRes.status !== 200 && sessionRes.status !== 201) {
    errorCount.add(1);
    successRate.add(0);
    return;
  }

  const sessionId = (sessionRes.json() as Record<string, string>).sessionId;

  // Write 3 messages to this session
  for (let i = 0; i < 3; i++) {
    const msgPayload = JSON.stringify({
      message: `Disk pressure message ${i} from VU ${__VU} iteration ${__ITER}`,
      sessionId,
    });

    totalBytesWritten.add(msgPayload.length);

    const res = http.post(`${RUNTIME}${apiPath(`/projects/${PROJECT_ID}/chat`)}`, msgPayload, {
      headers: data.headers,
      tags: { scenario: 'session_persistence' },
      timeout: '15s',
    });

    const ok = check(res, { 'session msg write ok': (r) => r.status === 200 });
    if (!ok) {
      console.log(`[session_persistence] status=${res.status}`);
      errorCount.add(1);
    }
  }

  dbWriteLatency.add(Date.now() - start);
  successRate.add(1);
  sleep(0.1);
}

/** Ingest larger documents (50-100KB) to stress storage throughput */
export function largeDocumentIngestion(data: SetupData): void {
  ensureFreshAuth(data);

  const sizeKB = 50 + Math.floor(Math.random() * 50); // 50-100KB
  const content = generateLargeContent(sizeKB);
  const docId = `large-doc-${__VU}-${__ITER}`;

  const payload = JSON.stringify({
    documents: [
      {
        id: docId,
        title: `Large Document ${docId}`,
        content,
        metadata: { source: 'disk-pressure-large', sizeKB },
      },
    ],
  });

  totalBytesWritten.add(payload.length);
  const start = Date.now();

  const res = http.post(`${SEARCH_AI}${apiPath(`/projects/${PROJECT_ID}/documents`)}`, payload, {
    headers: data.headers,
    tags: { scenario: 'large_document_ingestion' },
    timeout: '30s',
  });

  const elapsed = Date.now() - start;
  dbWriteLatency.add(elapsed);
  writeDegradation.add(elapsed);
  ingestionRate.add(3600 / (elapsed / 1000)); // docs per hour

  const ok = check(res, {
    'large doc accepted': (r) => r.status === 200 || r.status === 201 || r.status === 202,
  });

  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[large_document_ingestion] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(1);
}

/** Monitor write throughput over time to detect degradation */
export function writeThroughputMonitor(data: SetupData): void {
  ensureFreshAuth(data);

  const testPayload = JSON.stringify({
    documents: [
      {
        id: `monitor-${Date.now()}`,
        title: 'Write throughput monitor probe',
        content: 'Small probe document for measuring write latency over time.',
        metadata: { source: 'throughput-monitor' },
      },
    ],
  });

  const start = Date.now();
  const res = http.post(
    `${SEARCH_AI}${apiPath(`/projects/${PROJECT_ID}/documents`)}`,
    testPayload,
    {
      headers: data.headers,
      timeout: '10s',
    },
  );

  const elapsed = Date.now() - start;
  writeDegradation.add(elapsed);

  if (elapsed > 0) {
    writeOpsPerSec.add(1000 / elapsed);
  }

  check(res, {
    'monitor probe ok': (r) => r.status === 200 || r.status === 201 || r.status === 202,
  });
}

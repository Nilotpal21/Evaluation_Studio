/**
 * MongoDB benchmark: CRUD conversations, message inserts, aggregations.
 *
 * Targets the Runtime API HTTP proxy for MongoDB operations.
 * Tests conversation lifecycle, high-throughput message inserts,
 * and aggregation pipeline queries typical of analytics dashboards.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { config, apiPath } from '../lib/config.ts';
import { getAuthToken, getRefreshToken, makeAuthHeaders, ensureFreshAuth } from '../lib/auth.ts';
import { dbQueryLatency, dbWriteLatency, successRate } from '../lib/metrics.ts';

const BASE_URL = config.runtimeUrl;
const TENANT_ID = config.tenantId;
const PROJECT_ID = config.projectId;

export const options = {
  scenarios: {
    conversationCrud: {
      executor: 'constant-vus',
      vus: 10,
      duration: '2m',
      exec: 'conversationCrud',
    },
    messageInserts: {
      executor: 'constant-vus',
      vus: 20,
      duration: '2m',
      exec: 'messageInserts',
    },
    aggregationQueries: {
      executor: 'ramping-vus',
      startVUs: 2,
      stages: [
        { duration: '1m', target: 10 },
        { duration: '1m', target: 20 },
      ],
      exec: 'aggregationQueries',
    },
  },
  thresholds: {
    abl_db_write_latency_ms: ['p(95)<200', 'p(99)<500'],
    abl_db_query_latency_ms: ['p(95)<500', 'p(99)<1000'],
    abl_success_rate: ['rate>0.99'],
  },
  cloud: {
    projectID: __ENV.K6_CLOUD_PROJECT_ID || undefined,
    name: 'mongodb-per-service',
    tags: {
      service: 'mongodb',
      type: 'per-service',
      tier: __ENV.TIER || 'm',
      env: __ENV.ENV || 'staging',
    },
  },
};

// ---------------------------------------------------------------------------
// Setup — obtain auth token once per test run
// ---------------------------------------------------------------------------

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

/** Create, read, update, delete a conversation document. */
export function conversationCrud(data: SetupData): void {
  ensureFreshAuth(data);

  const conversationId = `bench-conv-${__VU}-${__ITER}`;

  // Create
  const createPayload = JSON.stringify({
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    conversationId,
    agentId: 'benchmark-agent',
    status: 'active',
    metadata: { source: 'k6-benchmark', vu: __VU },
  });

  const createStart = Date.now();
  const createRes = http.post(`${BASE_URL}${apiPath('/conversations')}`, createPayload, {
    headers: data.headers,
  });
  dbWriteLatency.add(Date.now() - createStart);
  const created = check(createRes, { 'create 2xx': (r) => r.status >= 200 && r.status < 300 });
  successRate.add(created ? 1 : 0);
  if (!created) console.log(`[create 2xx] status=${createRes.status}`);

  // Read
  const readStart = Date.now();
  const readRes = http.get(
    `${BASE_URL}${apiPath(`/conversations/${conversationId}?tenantId=${TENANT_ID}`)}`,
    { headers: data.headers },
  );
  dbQueryLatency.add(Date.now() - readStart);
  successRate.add(readRes.status === 200 ? 1 : 0);

  // Update
  const updateStart = Date.now();
  const updateRes = http.patch(
    `${BASE_URL}${apiPath(`/conversations/${conversationId}`)}`,
    JSON.stringify({ status: 'closed', tenantId: TENANT_ID }),
    { headers: data.headers },
  );
  dbWriteLatency.add(Date.now() - updateStart);
  successRate.add(updateRes.status >= 200 && updateRes.status < 300 ? 1 : 0);

  // Delete
  const deleteStart = Date.now();
  const deleteRes = http.del(
    `${BASE_URL}${apiPath(`/conversations/${conversationId}?tenantId=${TENANT_ID}`)}`,
    null,
    { headers: data.headers },
  );
  dbWriteLatency.add(Date.now() - deleteStart);
  successRate.add(deleteRes.status >= 200 && deleteRes.status < 300 ? 1 : 0);

  sleep(0.1);
}

/** High-throughput message inserts simulating active conversations. */
export function messageInserts(data: SetupData): void {
  ensureFreshAuth(data);

  const conversationId = `bench-msgs-${__VU}`;
  const messages = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Benchmark message ${i} from VU ${__VU} iteration ${__ITER}`,
    timestamp: new Date().toISOString(),
  }));

  const start = Date.now();
  const res = http.post(
    `${BASE_URL}${apiPath(`/conversations/${conversationId}/messages`)}`,
    JSON.stringify({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      messages,
    }),
    { headers: data.headers },
  );
  dbWriteLatency.add(Date.now() - start);

  const ok = check(res, { 'batch insert 2xx': (r) => r.status >= 200 && r.status < 300 });
  successRate.add(ok ? 1 : 0);
  if (!ok) console.log(`[batch insert 2xx] status=${res.status}`);

  sleep(0.05);
}

/** Aggregation pipeline queries: message counts, avg response time, per-agent stats. */
export function aggregationQueries(data: SetupData): void {
  ensureFreshAuth(data);

  const queries = [
    apiPath(
      `/analytics/conversations/count?tenantId=${TENANT_ID}&projectId=${PROJECT_ID}&period=1h`,
    ),
    apiPath(
      `/analytics/messages/stats?tenantId=${TENANT_ID}&projectId=${PROJECT_ID}&groupBy=agentId`,
    ),
    apiPath(
      `/analytics/conversations/duration?tenantId=${TENANT_ID}&projectId=${PROJECT_ID}&period=24h`,
    ),
  ];

  for (const path of queries) {
    const start = Date.now();
    const res = http.get(`${BASE_URL}${path}`, { headers: data.headers });
    dbQueryLatency.add(Date.now() - start);

    const ok = check(res, { 'aggregation 2xx': (r) => r.status >= 200 && r.status < 300 });
    successRate.add(ok ? 1 : 0);
    if (!ok) console.log(`[aggregation 2xx] status=${res.status}`);
  }

  sleep(0.2);
}

// ---------------------------------------------------------------------------
// Default export — allows `k6 run --vus 1 --iterations 1` quick smoke tests
// ---------------------------------------------------------------------------

export default function (data: SetupData): void {
  conversationCrud(data);
  messageInserts(data);
  aggregationQueries(data);
}

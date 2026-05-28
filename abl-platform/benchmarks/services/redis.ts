/**
 * Redis benchmark: GET/SET operations, BullMQ enqueue/dequeue.
 *
 * Targets the Runtime API which proxies Redis operations for
 * session state, caching, and BullMQ job queues.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { config, apiPath } from '../lib/config.ts';
import { getAuthToken, getRefreshToken, makeAuthHeaders, ensureFreshAuth } from '../lib/auth.ts';
import {
  dbQueryLatency,
  dbWriteLatency,
  successRate,
  queueWaitTime,
  queueDepth,
} from '../lib/metrics.ts';

const BASE_URL = config.runtimeUrl;
const TENANT_ID = config.tenantId;

export const options = {
  scenarios: {
    getSet: {
      executor: 'constant-vus',
      vus: 20,
      duration: '2m',
      exec: 'getSet',
    },
    sessionState: {
      executor: 'constant-vus',
      vus: 15,
      duration: '2m',
      exec: 'sessionState',
    },
    bullmqEnqueueDequeue: {
      executor: 'ramping-vus',
      startVUs: 5,
      stages: [
        { duration: '1m', target: 20 },
        { duration: '1m', target: 40 },
      ],
      exec: 'bullmqEnqueueDequeue',
    },
  },
  thresholds: {
    abl_db_write_latency_ms: ['p(95)<50', 'p(99)<100'],
    abl_db_query_latency_ms: ['p(95)<20', 'p(99)<50'],
    abl_queue_wait_time_ms: ['p(95)<500', 'p(99)<1000'],
    abl_success_rate: ['rate>0.99'],
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

/** Basic GET/SET operations with varying payload sizes. */
export function getSet(data: SetupData): void {
  ensureFreshAuth(data);

  const key = `bench:kv:${__VU}:${__ITER}`;
  const payloadSizes = [64, 512, 4096, 16384];
  const size = payloadSizes[__ITER % payloadSizes.length];
  const value = 'x'.repeat(size);

  // SET
  const setStart = Date.now();
  const setRes = http.post(
    `${BASE_URL}${apiPath('/cache/set')}`,
    JSON.stringify({ key, value, ttl: 300, tenantId: TENANT_ID }),
    { headers: data.headers },
  );
  dbWriteLatency.add(Date.now() - setStart);
  successRate.add(setRes.status >= 200 && setRes.status < 300 ? 1 : 0);

  // GET
  const getStart = Date.now();
  const getRes = http.get(`${BASE_URL}${apiPath(`/cache/get?key=${key}&tenantId=${TENANT_ID}`)}`, {
    headers: data.headers,
  });
  dbQueryLatency.add(Date.now() - getStart);

  const ok = check(getRes, {
    'get 2xx': (r) => r.status >= 200 && r.status < 300,
  });
  successRate.add(ok ? 1 : 0);
  if (!ok) console.log(`[get 2xx] status=${getRes.status}`);

  sleep(0.02);
}

/** Session state read/write simulating concurrent agent conversations. */
export function sessionState(data: SetupData): void {
  ensureFreshAuth(data);

  const sessionId = `bench-session-${__VU}`;

  // Write session context
  const writeStart = Date.now();
  const writeRes = http.put(
    `${BASE_URL}${apiPath(`/sessions/${sessionId}/state`)}`,
    JSON.stringify({
      tenantId: TENANT_ID,
      context: {
        currentStep: `step-${__ITER % 5}`,
        collectedFields: { name: 'Test User', intent: 'benchmark' },
        turnCount: __ITER,
        lastActivity: new Date().toISOString(),
      },
    }),
    { headers: data.headers },
  );
  dbWriteLatency.add(Date.now() - writeStart);
  successRate.add(writeRes.status >= 200 && writeRes.status < 300 ? 1 : 0);

  // Read session context
  const readStart = Date.now();
  const readRes = http.get(
    `${BASE_URL}${apiPath(`/sessions/${sessionId}/state?tenantId=${TENANT_ID}`)}`,
    { headers: data.headers },
  );
  dbQueryLatency.add(Date.now() - readStart);
  successRate.add(readRes.status >= 200 && readRes.status < 300 ? 1 : 0);

  sleep(0.05);
}

/** BullMQ job enqueue and status polling simulating async task processing. */
export function bullmqEnqueueDequeue(data: SetupData): void {
  ensureFreshAuth(data);

  const jobName = `bench-job-${__VU}-${__ITER}`;

  // Enqueue a job
  const enqueueStart = Date.now();
  const enqueueRes = http.post(
    `${BASE_URL}${apiPath('/jobs/enqueue')}`,
    JSON.stringify({
      queue: 'agent-tasks',
      name: jobName,
      data: {
        tenantId: TENANT_ID,
        agentId: 'benchmark-agent',
        action: 'process_message',
        payload: { message: `Benchmark task from VU ${__VU}` },
      },
      options: { priority: __ITER % 3, attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
    }),
    { headers: data.headers },
  );
  dbWriteLatency.add(Date.now() - enqueueStart);

  const enqueued = check(enqueueRes, {
    'enqueue 2xx': (r) => r.status >= 200 && r.status < 300,
  });
  successRate.add(enqueued ? 1 : 0);

  if (!enqueued) {
    console.log(`[enqueue 2xx] status=${enqueueRes.status}`);
    return;
  }

  // Poll job status (simulates dequeue observation)
  const jobId = enqueueRes.json('jobId') as string | undefined;
  if (jobId) {
    sleep(0.2);
    const statusStart = Date.now();
    const statusRes = http.get(
      `${BASE_URL}${apiPath(`/jobs/${jobId}/status?tenantId=${TENANT_ID}`)}`,
      { headers: data.headers },
    );
    queueWaitTime.add(Date.now() - statusStart);
    successRate.add(statusRes.status >= 200 && statusRes.status < 300 ? 1 : 0);
  }

  // Check queue depth
  const depthRes = http.get(
    `${BASE_URL}${apiPath(`/jobs/queues/agent-tasks/depth?tenantId=${TENANT_ID}`)}`,
    { headers: data.headers },
  );
  const depth = depthRes.json('depth') as number | undefined;
  if (typeof depth === 'number') {
    queueDepth.add(depth);
  }

  sleep(0.1);
}

// ---------------------------------------------------------------------------
// Default export — allows `k6 run --vus 1 --iterations 1` quick smoke tests
// ---------------------------------------------------------------------------

export default function (data: SetupData): void {
  getSet(data);
  sessionState(data);
  bullmqEnqueueDequeue(data);
}

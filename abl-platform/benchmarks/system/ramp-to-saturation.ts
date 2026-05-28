/**
 * Ramp to Saturation Test
 *
 * Linear ramp from minimal load to breaking point.
 * Identifies the maximum throughput and the load level where errors begin.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { config, apiPath, studioApiPath } from '../lib/config.ts';
import { ensureFreshAuth, getAuthToken, getRefreshToken, makeAuthHeaders } from '../lib/auth.ts';
import {
  agentTurnLatency,
  vectorSearchLatency,
  successRate,
  errorCount,
  rateLimitHits,
} from '../lib/metrics.ts';
import { Trend, Gauge } from 'k6/metrics';

const RUNTIME = config.runtimeUrl;
const SEARCH_RT = config.searchAiRuntimeUrl;
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

const saturationType = new Gauge('abl_saturation_type');
const activeVUsAtError = new Gauge('abl_active_vus_at_first_error');
const maxThroughput = new Gauge('abl_max_throughput_rps');

const QUERIES = [
  'How do I configure agent constraints?',
  'Search for deployment documentation',
  'What tools are available?',
];

const MESSAGES = [
  'Help me configure my agent',
  'What are the system requirements?',
  'Show me example DSL code',
];

export const options = {
  scenarios: {
    ramp_chat: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '2m', target: 10 },
        { duration: '3m', target: 50 },
        { duration: '5m', target: 150 },
        { duration: '5m', target: 300 },
        { duration: '5m', target: 500 },
        { duration: '3m', target: 500 },
        { duration: '2m', target: 0 },
      ],
      exec: 'rampChat',
    },
    ramp_search: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '2m', target: 20 },
        { duration: '3m', target: 100 },
        { duration: '5m', target: 300 },
        { duration: '5m', target: 600 },
        { duration: '5m', target: 1000 },
        { duration: '3m', target: 1000 },
        { duration: '2m', target: 0 },
      ],
      exec: 'rampSearch',
    },
    ramp_mixed: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '2m', target: 15 },
        { duration: '3m', target: 75 },
        { duration: '5m', target: 200 },
        { duration: '5m', target: 400 },
        { duration: '5m', target: 400 },
        { duration: '2m', target: 0 },
      ],
      exec: 'rampMixed',
    },
  },
  thresholds: {
    // No hard failure thresholds -- we want to find the breaking point
    // These are informational markers
    'http_req_duration{scenario:ramp_chat}': [{ threshold: 'p(95)<10000', abortOnFail: false }],
    'http_req_duration{scenario:ramp_search}': [{ threshold: 'p(95)<5000', abortOnFail: false }],
    http_req_failed: [{ threshold: 'rate<0.10', abortOnFail: false }],
  },
};

let firstErrorRecorded = false;

function recordFirstError(vuCount: number): void {
  if (!firstErrorRecorded) {
    activeVUsAtError.add(vuCount);
    firstErrorRecorded = true;
  }
}

/** Ramp chat load until saturation */
export function rampChat(data: SetupData): void {
  ensureFreshAuth(data);

  const sessionRes = http.post(
    `${RUNTIME}${apiPath(`/projects/${PROJECT_ID}/sessions`)}`,
    JSON.stringify({ agentId: 'benchmark-agent' }),
    { headers: data.headers },
  );

  if (sessionRes.status !== 200 && sessionRes.status !== 201) {
    recordFirstError(__VU);
    errorCount.add(1);
    successRate.add(0);
    sleep(1);
    return;
  }

  const sessionId = (sessionRes.json() as Record<string, string>).sessionId;
  const message = MESSAGES[Math.floor(Math.random() * MESSAGES.length)];

  const start = Date.now();
  const res = http.post(
    `${RUNTIME}${apiPath(`/projects/${PROJECT_ID}/chat`)}`,
    JSON.stringify({ message, sessionId }),
    { headers: data.headers, tags: { scenario: 'ramp_chat' }, timeout: '30s' },
  );

  agentTurnLatency.add(Date.now() - start);

  if (res.status === 429) {
    rateLimitHits.add(1);
    saturationType.add(1); // 1 = rate-limited
    recordFirstError(__VU);
    sleep(2);
    return;
  }

  const ok = check(res, {
    'ramp chat 200': (r) => r.status === 200,
  });

  if (!ok) recordFirstError(__VU);
  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[ramp_chat] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(0.5);
}

/** Ramp search load until saturation */
export function rampSearch(data: SetupData): void {
  ensureFreshAuth(data);

  const query = QUERIES[Math.floor(Math.random() * QUERIES.length)];
  const start = Date.now();

  const res = http.post(
    `${SEARCH_RT}${apiPath(`/projects/${PROJECT_ID}/search`)}`,
    JSON.stringify({ query, topK: 5 }),
    { headers: data.headers, tags: { scenario: 'ramp_search' }, timeout: '15s' },
  );

  vectorSearchLatency.add(Date.now() - start);

  if (res.status === 429) {
    rateLimitHits.add(1);
    saturationType.add(2); // 2 = search rate-limited
    recordFirstError(__VU);
    sleep(1);
    return;
  }

  if (res.status === 503) {
    saturationType.add(3); // 3 = service unavailable
    recordFirstError(__VU);
    errorCount.add(1);
    successRate.add(0);
    sleep(2);
    return;
  }

  const ok = check(res, {
    'ramp search 200': (r) => r.status === 200,
  });

  if (!ok) recordFirstError(__VU);
  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[ramp_search] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(0.05);
}

/** Mixed workload ramp (chat + search + API) */
export function rampMixed(data: SetupData): void {
  ensureFreshAuth(data);

  const roll = Math.random();

  if (roll < 0.3) {
    // Chat
    const sessionRes = http.post(
      `${RUNTIME}${apiPath(`/projects/${PROJECT_ID}/sessions`)}`,
      JSON.stringify({ agentId: 'benchmark-agent' }),
      { headers: data.headers },
    );

    if (sessionRes.status === 200 || sessionRes.status === 201) {
      const sessionId = (sessionRes.json() as Record<string, string>).sessionId;
      const message = MESSAGES[Math.floor(Math.random() * MESSAGES.length)];
      const start = Date.now();

      const res = http.post(
        `${RUNTIME}${apiPath(`/projects/${PROJECT_ID}/chat`)}`,
        JSON.stringify({ message, sessionId }),
        { headers: data.headers, tags: { scenario: 'ramp_mixed' }, timeout: '30s' },
      );

      agentTurnLatency.add(Date.now() - start);
      const ok = check(res, { 'mixed chat 200': (r) => r.status === 200 });
      successRate.add(ok ? 1 : 0);
      if (!ok) {
        console.log(`[ramp_mixed] status=${res.status}`);
        errorCount.add(1);
        recordFirstError(__VU);
      }
    } else {
      errorCount.add(1);
      successRate.add(0);
      recordFirstError(__VU);
    }
  } else if (roll < 0.7) {
    // Search
    const query = QUERIES[Math.floor(Math.random() * QUERIES.length)];
    const start = Date.now();

    const res = http.post(
      `${SEARCH_RT}${apiPath(`/projects/${PROJECT_ID}/search`)}`,
      JSON.stringify({ query, topK: 5 }),
      { headers: data.headers, tags: { scenario: 'ramp_mixed' } },
    );

    vectorSearchLatency.add(Date.now() - start);
    const ok = check(res, { 'mixed search 200': (r) => r.status === 200 });
    successRate.add(ok ? 1 : 0);
    if (!ok) {
      console.log(`[ramp_mixed] status=${res.status}`);
      errorCount.add(1);
      recordFirstError(__VU);
    }
  } else {
    // API listing
    const res = http.get(`${config.studioUrl}${studioApiPath(`/projects/${PROJECT_ID}/agents`)}`, {
      headers: data.headers,
      tags: { scenario: 'ramp_mixed' },
    });

    const ok = check(res, { 'mixed api 200': (r) => r.status === 200 });
    successRate.add(ok ? 1 : 0);
    if (!ok) {
      console.log(`[ramp_mixed] status=${res.status}`);
      errorCount.add(1);
      recordFirstError(__VU);
    }
  }

  sleep(0.1);
}

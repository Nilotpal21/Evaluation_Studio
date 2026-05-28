/**
 * Burst Traffic Test
 *
 * Simulates a 10x spike for 5 minutes on top of baseline load.
 * Validates autoscaling, queue buffering, and graceful degradation.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { config, apiPath } from '../lib/config.ts';
import { ensureFreshAuth, getAuthToken, getRefreshToken, makeAuthHeaders } from '../lib/auth.ts';
import {
  agentTurnLatency,
  vectorSearchLatency,
  queueWaitTime,
  queueDepth,
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

const recoveryLatency = new Trend('abl_burst_recovery_latency_ms', true);
const maxConcurrentVUs = new Gauge('abl_burst_max_concurrent_vus');

const MESSAGES = [
  'Help me set up a new agent',
  'What are the available integrations?',
  'I need to troubleshoot an error',
];

const QUERIES = [
  'How do I configure webhooks?',
  'Agent deployment documentation',
  'Troubleshooting connection issues',
];

export const options = {
  scenarios: {
    baseline_chat: {
      executor: 'constant-arrival-rate',
      rate: 5,
      timeUnit: '1s',
      duration: '20m',
      preAllocatedVUs: 10,
      maxVUs: 20,
      exec: 'baselineChat',
    },
    baseline_search: {
      executor: 'constant-arrival-rate',
      rate: 10,
      timeUnit: '1s',
      duration: '20m',
      preAllocatedVUs: 10,
      maxVUs: 20,
      exec: 'baselineSearch',
    },
    burst_chat: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        // 5 min warm-up at 0, then 10x spike for 5 min, then back down
        { duration: '5m', target: 0 },
        { duration: '30s', target: 100 }, // rapid spike
        { duration: '5m', target: 100 }, // sustain 10x
        { duration: '30s', target: 0 }, // rapid drop
        { duration: '5m', target: 0 }, // recovery observation
        { duration: '30s', target: 100 }, // second spike
        { duration: '3m', target: 100 },
        { duration: '30s', target: 0 },
      ],
      exec: 'burstChat',
    },
    burst_search: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '5m', target: 0 },
        { duration: '30s', target: 200 },
        { duration: '5m', target: 200 },
        { duration: '30s', target: 0 },
        { duration: '5m', target: 0 },
        { duration: '30s', target: 200 },
        { duration: '3m', target: 200 },
        { duration: '30s', target: 0 },
      ],
      exec: 'burstSearch',
    },
  },
  thresholds: {
    // Baseline should remain stable during burst
    'http_req_duration{scenario:baseline_chat}': ['p(95)<8000', 'p(99)<15000'],
    'http_req_duration{scenario:baseline_search}': ['p(95)<1500', 'p(99)<3000'],
    // Burst can degrade but should not break
    'http_req_duration{scenario:burst_chat}': [{ threshold: 'p(95)<20000', abortOnFail: false }],
    'http_req_duration{scenario:burst_search}': [{ threshold: 'p(95)<5000', abortOnFail: false }],
    http_req_failed: ['rate<0.10'], // allow up to 10% during bursts
  },
};

/** Baseline chat that should remain stable */
export function baselineChat(data: SetupData): void {
  ensureFreshAuth(data);

  const sessionRes = http.post(
    `${RUNTIME}${apiPath(`/projects/${PROJECT_ID}/sessions`)}`,
    JSON.stringify({ agentId: 'benchmark-agent' }),
    { headers: data.headers },
  );

  if (sessionRes.status !== 200 && sessionRes.status !== 201) {
    errorCount.add(1);
    successRate.add(0);
    return;
  }

  const sessionId = (sessionRes.json() as Record<string, string>).sessionId;
  const message = MESSAGES[Math.floor(Math.random() * MESSAGES.length)];

  const start = Date.now();
  const res = http.post(
    `${RUNTIME}${apiPath(`/projects/${PROJECT_ID}/chat`)}`,
    JSON.stringify({ message, sessionId }),
    { headers: data.headers, tags: { scenario: 'baseline_chat' }, timeout: '30s' },
  );

  agentTurnLatency.add(Date.now() - start);

  const ok = check(res, { 'baseline chat 200': (r) => r.status === 200 });
  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[baseline_chat] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(0.1);
}

/** Baseline search that should remain stable */
export function baselineSearch(data: SetupData): void {
  ensureFreshAuth(data);

  const query = QUERIES[Math.floor(Math.random() * QUERIES.length)];
  const start = Date.now();

  const res = http.post(
    `${SEARCH_RT}${apiPath(`/projects/${PROJECT_ID}/search`)}`,
    JSON.stringify({ query, topK: 5 }),
    { headers: data.headers, tags: { scenario: 'baseline_search' } },
  );

  vectorSearchLatency.add(Date.now() - start);

  const ok = check(res, { 'baseline search 200': (r) => r.status === 200 });
  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[baseline_search] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(0.05);
}

/** Burst chat: 10x spike */
export function burstChat(data: SetupData): void {
  ensureFreshAuth(data);

  maxConcurrentVUs.add(__VU);

  const sessionRes = http.post(
    `${RUNTIME}${apiPath(`/projects/${PROJECT_ID}/sessions`)}`,
    JSON.stringify({ agentId: 'benchmark-agent' }),
    { headers: data.headers },
  );

  if (sessionRes.status === 429) {
    rateLimitHits.add(1);
    sleep(1);
    return;
  }

  if (sessionRes.status !== 200 && sessionRes.status !== 201) {
    errorCount.add(1);
    successRate.add(0);
    sleep(0.5);
    return;
  }

  const sessionId = (sessionRes.json() as Record<string, string>).sessionId;
  const message = MESSAGES[Math.floor(Math.random() * MESSAGES.length)];

  const start = Date.now();
  const res = http.post(
    `${RUNTIME}${apiPath(`/projects/${PROJECT_ID}/chat`)}`,
    JSON.stringify({ message, sessionId }),
    { headers: data.headers, tags: { scenario: 'burst_chat' }, timeout: '30s' },
  );

  const elapsed = Date.now() - start;
  agentTurnLatency.add(elapsed);
  recoveryLatency.add(elapsed);

  if (res.status === 429) {
    rateLimitHits.add(1);
    sleep(1);
    return;
  }

  if (res.status === 200) {
    const body = res.json() as Record<string, unknown>;
    if (typeof body.queueWaitMs === 'number') queueWaitTime.add(body.queueWaitMs as number);
  }

  const ok = check(res, { 'burst chat ok': (r) => r.status === 200 });
  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[burst_chat] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(0.2);
}

/** Burst search: 10x spike */
export function burstSearch(data: SetupData): void {
  ensureFreshAuth(data);

  const query = QUERIES[Math.floor(Math.random() * QUERIES.length)];
  const start = Date.now();

  const res = http.post(
    `${SEARCH_RT}${apiPath(`/projects/${PROJECT_ID}/search`)}`,
    JSON.stringify({ query, topK: 5 }),
    { headers: data.headers, tags: { scenario: 'burst_search' }, timeout: '10s' },
  );

  const elapsed = Date.now() - start;
  vectorSearchLatency.add(elapsed);
  recoveryLatency.add(elapsed);

  if (res.status === 429) {
    rateLimitHits.add(1);
    sleep(0.5);
    return;
  }

  const ok = check(res, { 'burst search ok': (r) => r.status === 200 });
  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[burst_search] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(0.02);
}

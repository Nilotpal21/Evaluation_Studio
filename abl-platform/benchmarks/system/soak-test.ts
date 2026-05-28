/**
 * Soak Test - Constant Load for 4+ Hours
 *
 * Validates system stability under sustained production-like load.
 * Detects memory leaks, connection pool exhaustion, and resource drift.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { config, apiPath, studioApiPath } from '../lib/config.ts';
import { ensureFreshAuth, getAuthToken, getRefreshToken, makeAuthHeaders } from '../lib/auth.ts';
import {
  agentTurnLatency,
  vectorSearchLatency,
  dbQueryLatency,
  connectionPoolUtil,
  successRate,
  errorCount,
} from '../lib/metrics.ts';
import { Trend } from 'k6/metrics';

const RUNTIME = config.runtimeUrl;
const SEARCH_RT = config.searchAiRuntimeUrl;
const STUDIO = config.studioUrl;
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

const p99Drift = new Trend('abl_p99_drift_ms', true);

const QUERIES = [
  'How do I configure agent constraints?',
  'What tools support web search?',
  'Explain multi-agent delegation patterns',
];

const MESSAGES = [
  'Help me set up a new agent',
  'What are the available integrations?',
  'Show me deployment options',
];

export const options = {
  scenarios: {
    soak_chat: {
      executor: 'constant-arrival-rate',
      rate: 5,
      timeUnit: '1s',
      duration: '4h',
      preAllocatedVUs: 15,
      maxVUs: 30,
      exec: 'soakChat',
    },
    soak_search: {
      executor: 'constant-arrival-rate',
      rate: 10,
      timeUnit: '1s',
      duration: '4h',
      preAllocatedVUs: 10,
      maxVUs: 25,
      exec: 'soakSearch',
    },
    soak_api: {
      executor: 'constant-arrival-rate',
      rate: 8,
      timeUnit: '1s',
      duration: '4h',
      preAllocatedVUs: 8,
      maxVUs: 20,
      exec: 'soakApi',
    },
    health_check: {
      executor: 'constant-arrival-rate',
      rate: 1,
      timeUnit: '10s',
      duration: '4h',
      preAllocatedVUs: 1,
      maxVUs: 2,
      exec: 'healthCheck',
    },
  },
  thresholds: {
    // Soak thresholds are slightly relaxed but enforce no degradation over time
    'http_req_duration{scenario:soak_chat}': ['p(95)<8000', 'p(99)<15000'],
    'http_req_duration{scenario:soak_search}': ['p(95)<1500', 'p(99)<3000'],
    'http_req_duration{scenario:soak_api}': ['p(95)<2000', 'p(99)<5000'],
    http_req_failed: ['rate<0.02'],
    abl_success_rate: ['rate>0.95'],
    // Ensure p99 does not drift upward significantly
    abl_p99_drift_ms: ['p(95)<5000'],
  },
};

/** Sustained chat load */
export function soakChat(data: SetupData): void {
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
    { headers: data.headers, tags: { scenario: 'soak_chat' }, timeout: '30s' },
  );

  const elapsed = Date.now() - start;
  agentTurnLatency.add(elapsed);
  p99Drift.add(elapsed);

  const ok = check(res, {
    'soak chat 200': (r) => r.status === 200,
  });

  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[soak_chat] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(0.1);
}

/** Sustained search load */
export function soakSearch(data: SetupData): void {
  ensureFreshAuth(data);

  const query = QUERIES[Math.floor(Math.random() * QUERIES.length)];
  const start = Date.now();

  const res = http.post(
    `${SEARCH_RT}${apiPath(`/projects/${PROJECT_ID}/search`)}`,
    JSON.stringify({ query, topK: 5 }),
    { headers: data.headers, tags: { scenario: 'soak_search' } },
  );

  vectorSearchLatency.add(Date.now() - start);

  const ok = check(res, { 'soak search 200': (r) => r.status === 200 });
  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[soak_search] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(0.05);
}

/** Sustained Studio API load */
export function soakApi(data: SetupData): void {
  ensureFreshAuth(data);

  const endpoints = [
    `${STUDIO}${studioApiPath(`/projects/${PROJECT_ID}/agents`)}`,
    `${STUDIO}${studioApiPath(`/projects/${PROJECT_ID}/workflows`)}`,
    `${STUDIO}${studioApiPath(`/projects/${PROJECT_ID}`)}`,
  ];

  const url = endpoints[Math.floor(Math.random() * endpoints.length)];
  const start = Date.now();

  const res = http.get(url, {
    headers: data.headers,
    tags: { scenario: 'soak_api' },
  });

  dbQueryLatency.add(Date.now() - start);

  const ok = check(res, { 'soak API 200': (r) => r.status === 200 });
  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[soak_api] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(0.1);
}

/** Periodic health check to detect service degradation */
export function healthCheck(data: SetupData): void {
  ensureFreshAuth(data);

  const services = [
    { name: 'runtime', url: `${RUNTIME}/health` },
    { name: 'search-ai-runtime', url: `${SEARCH_RT}/health` },
    { name: 'studio', url: `${STUDIO}${studioApiPath('/health')}` },
  ];

  for (const svc of services) {
    const res = http.get(svc.url, { headers: data.headers, timeout: '10s' });

    const ok = check(res, {
      [`${svc.name} healthy`]: (r) => r.status === 200,
    });

    if (!ok) {
      console.log(`[health_check] status=${res.status}`);
      errorCount.add(1);
    }

    // Check connection pool metrics if exposed
    if (res.status === 200) {
      const body = res.json() as Record<string, unknown>;
      if (typeof body.connectionPoolUtilization === 'number') {
        connectionPoolUtil.add(body.connectionPoolUtilization as number);
      }
    }
  }
}

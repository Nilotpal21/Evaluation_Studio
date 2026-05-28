/**
 * Studio Service Benchmarks
 *
 * Tests: page load, API CRUD operations, concurrent developer sessions.
 * Target: Studio at port 5173.
 */
import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { config, studioApiPath, runHealthCheck } from '../lib/config.ts';
import {
  getAuthToken,
  getRefreshToken,
  makeAuthHeaders,
  freshHeaders,
  ensureFreshAuth,
} from '../lib/auth.ts';
import { successRate, errorCount, dbQueryLatency } from '../lib/metrics.ts';

const BASE = config.studioUrl;
const PROJECT_ID = config.projectId;
const TENANT_ID = config.tenantId;

export const options = {
  scenarios: {
    page_load: {
      executor: 'constant-arrival-rate',
      rate: 10,
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 10,
      maxVUs: 30,
      exec: 'pageLoad',
    },
    api_crud: {
      executor: 'per-vu-iterations',
      vus: 5,
      iterations: 20,
      startTime: '2m',
      exec: 'apiCrud',
    },
    concurrent_developers: {
      executor: 'ramping-vus',
      startVUs: 2,
      stages: [
        { duration: '1m', target: 20 },
        { duration: '3m', target: 50 },
        { duration: '1m', target: 50 },
        { duration: '1m', target: 0 },
      ],
      startTime: '5m',
      exec: 'concurrentDevelopers',
    },
  },
  thresholds: {
    'http_req_duration{scenario:page_load}': ['p(95)<3000', 'p(99)<5000'],
    'http_req_duration{scenario:api_crud}': ['p(95)<1000', 'p(99)<2000'],
    'http_req_duration{scenario:concurrent_developers}': ['p(95)<2000', 'p(99)<5000'],
    http_req_failed: ['rate<0.02'],
    abl_success_rate: ['rate>0.95'],
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

  // Smoke-check: verify Studio is reachable (skipped if HEALTH_CHECK=false)
  runHealthCheck(BASE, 'studio', headers);

  return { token, refreshToken, headers };
}

/** Simulate page loads across main Studio routes */
export function pageLoad(data: SetupData): void {
  ensureFreshAuth(data);

  const routes = [
    '/',
    `/projects/${PROJECT_ID}`,
    `/projects/${PROJECT_ID}/agents`,
    `/projects/${PROJECT_ID}/knowledge`,
    `/projects/${PROJECT_ID}/workflows`,
    `/projects/${PROJECT_ID}/settings`,
  ];

  const route = routes[Math.floor(Math.random() * routes.length)];
  const res = http.get(`${BASE}${route}`, {
    headers: freshHeaders(data),
    tags: { scenario: 'page_load' },
  });

  const ok = check(res, {
    'page loads 200': (r) => r.status === 200,
    'response has body': (r) => r.body !== null && (r.body as string).length > 0,
  });

  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[page_load] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(0.1);
}

/** Full CRUD lifecycle on agents */
export function apiCrud(data: SetupData): void {
  ensureFreshAuth(data);

  group('create agent', () => {
    const agentName = `bench_agent_${__VU}_${__ITER}`;
    const createPayload = JSON.stringify({
      name: agentName,
      agentPath: `${PROJECT_ID}/default/${agentName}`,
      description: 'Benchmark test agent',
      instructions: 'Respond concisely',
      dslContent: `\nAGENT: ${agentName}-${__VU}-${__ITER}\nGOAL: \"responsd to user question. if you do not know answer, respond NO.\"\nPERSONA: |\n  Calm, Cool person\n  CRITICAL: Keep each response to 1 sentence. each sentence should be more 2-3 words.\nLIMITATIONS:\n  - \"do not perform any web search\"`,
    });

    const createRes = http.post(
      `${BASE}${studioApiPath(`/projects/${PROJECT_ID}/agents`)}`,
      createPayload,
      {
        headers: freshHeaders(data),
        tags: { scenario: 'api_crud' },
      },
    );

    const created = check(createRes, {
      'agent created 201': (r) => r.status === 201 || r.status === 200,
    });

    if (!created) {
      console.log(`[create_agent] status=${createRes.status}`);
      errorCount.add(1);
      successRate.add(0);
      return;
    }

    const body = createRes.json() as { agent?: { id: string }; id?: string };
    const agentId = body.agent?.id || body.id;

    // Read (GET uses agent name, not ID)
    const readStart = Date.now();
    const readRes = http.get(
      `${BASE}${studioApiPath(`/projects/${PROJECT_ID}/agents/${encodeURIComponent(agentName)}`)}`,
      {
        headers: freshHeaders(data),
        tags: { scenario: 'api_crud' },
      },
    );
    dbQueryLatency.add(Date.now() - readStart);

    check(readRes, { 'agent read 200': (r) => r.status === 200 });

    // Update
    const updatePayload = JSON.stringify({
      description: 'Updated benchmark test agent',
      instructions: 'Respond concisely and helpfully',
    });

    const updateRes = http.patch(
      `${BASE}${studioApiPath(`/projects/${PROJECT_ID}/agents/${agentId}`)}`,
      updatePayload,
      { headers: freshHeaders(data), tags: { scenario: 'api_crud' } },
    );

    check(updateRes, { 'agent updated 200': (r) => r.status === 200 });

    // Delete
    const deleteRes = http.del(
      `${BASE}${studioApiPath(`/projects/${PROJECT_ID}/agents/${agentId}`)}`,
      null,
      {
        headers: freshHeaders(data),
        tags: { scenario: 'api_crud' },
      },
    );

    const ok = check(deleteRes, {
      'agent deleted 200|204': (r) => r.status === 200 || r.status === 204,
    });
    successRate.add(ok ? 1 : 0);
    if (!ok) console.log(`[delete_agent] status=${deleteRes.status}`);
  });

  sleep(0.5);
}

/** Simulate concurrent developers browsing and editing */
export function concurrentDevelopers(data: SetupData): void {
  ensureFreshAuth(data);

  // List agents
  const listRes = http.get(`${BASE}${studioApiPath(`/projects/${PROJECT_ID}/agents`)}`, {
    headers: freshHeaders(data),
    tags: { scenario: 'concurrent_developers' },
  });

  check(listRes, { 'list agents 200': (r) => r.status === 200 });

  // List workflows
  const wfRes = http.get(`${BASE}${studioApiPath(`/projects/${PROJECT_ID}/workflows`)}`, {
    headers: freshHeaders(data),
    tags: { scenario: 'concurrent_developers' },
  });

  check(wfRes, { 'list workflows 200': (r) => r.status === 200 });

  // Get project info
  const projRes = http.get(`${BASE}${studioApiPath(`/projects/${PROJECT_ID}`)}`, {
    headers: freshHeaders(data),
    tags: { scenario: 'concurrent_developers' },
  });

  const ok = check(projRes, { 'project info 200': (r) => r.status === 200 });
  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[concurrent_developers] status=${projRes.status}`);
    errorCount.add(1);
  }

  sleep(Math.random() * 2 + 0.5); // simulate think time
}

// ---------------------------------------------------------------------------
// Default export — allows `k6 run --vus 1 --iterations 1` quick smoke tests
// ---------------------------------------------------------------------------

export default function (data: SetupData): void {
  pageLoad(data);
  apiCrud(data);
  concurrentDevelopers(data);
}

/**
 * Workflow Engine Benchmarks
 *
 * Tests: simple linear workflow, branching workflow, external API workflow.
 * Target: Workflow Engine via Runtime at port 3112.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { config, apiPath, runHealthCheck } from '../lib/config.ts';
import { getAuthToken, getRefreshToken, makeAuthHeaders, ensureFreshAuth } from '../lib/auth.ts';
import {
  workflowStepLatency,
  workflowTotalDuration,
  workflowRecoveryTime,
  successRate,
  errorCount,
} from '../lib/metrics.ts';

const RUNTIME_BASE = config.runtimeUrl;
const RESTATE_BASE = config.restateUrl;
const PROJECT_ID = config.projectId;

export const options = {
  scenarios: {
    simple_workflow: {
      executor: 'constant-arrival-rate',
      rate: 5,
      timeUnit: '1s',
      duration: '3m',
      preAllocatedVUs: 10,
      maxVUs: 25,
      exec: 'simpleWorkflow',
    },
    branching_workflow: {
      executor: 'per-vu-iterations',
      vus: 5,
      iterations: 30,
      startTime: '3m',
      exec: 'branchingWorkflow',
    },
    external_api_workflow: {
      executor: 'constant-arrival-rate',
      rate: 2,
      timeUnit: '1s',
      duration: '3m',
      preAllocatedVUs: 5,
      maxVUs: 15,
      startTime: '6m',
      exec: 'externalApiWorkflow',
    },
  },
  thresholds: {
    'http_req_duration{scenario:simple_workflow}': ['p(95)<3000', 'p(99)<5000'],
    'http_req_duration{scenario:branching_workflow}': ['p(95)<5000', 'p(99)<10000'],
    'http_req_duration{scenario:external_api_workflow}': ['p(95)<10000', 'p(99)<20000'],
    http_req_failed: ['rate<0.05'],
    abl_workflow_total_duration_ms: ['p(95)<8000'],
    abl_success_rate: ['rate>0.90'],
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

  // Health check (skipped if HEALTH_CHECK=false)
  runHealthCheck(RUNTIME_BASE, 'runtime', headers);

  return { token, refreshToken, headers };
}

/** Execute a simple 3-step linear workflow */
export function simpleWorkflow(data: SetupData): void {
  ensureFreshAuth(data);

  const payload = JSON.stringify({
    workflowId: 'benchmark-simple',
    input: { message: `Simple workflow run ${__VU}-${__ITER}` },
    steps: [
      { type: 'transform', config: { template: '{{input.message}} - step 1' } },
      { type: 'transform', config: { template: '{{prev}} - step 2' } },
      { type: 'respond', config: { template: '{{prev}} - done' } },
    ],
  });

  const start = Date.now();
  const res = http.post(
    `${RUNTIME_BASE}${apiPath(`/projects/${PROJECT_ID}/workflows/execute`)}`,
    payload,
    {
      headers: data.headers,
      tags: { scenario: 'simple_workflow' },
      timeout: '15s',
    },
  );
  workflowTotalDuration.add(Date.now() - start);

  const ok = check(res, {
    'simple workflow 200': (r) => r.status === 200,
    'workflow completed': (r) => {
      const body = r.json() as Record<string, string>;
      return body.status === 'completed';
    },
  });

  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[simple_workflow] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(0.2);
}

/** Execute a workflow with conditional branching */
export function branchingWorkflow(data: SetupData): void {
  ensureFreshAuth(data);

  const usePathA = Math.random() > 0.5;
  const payload = JSON.stringify({
    workflowId: 'benchmark-branching',
    input: { route: usePathA ? 'A' : 'B', value: Math.floor(Math.random() * 100) },
    steps: [
      {
        type: 'condition',
        config: { expression: '{{input.route}} === "A"', trueStep: 1, falseStep: 2 },
      },
      { type: 'transform', config: { template: 'Path A: value={{input.value}}' } },
      { type: 'transform', config: { template: 'Path B: doubled={{input.value * 2}}' } },
      { type: 'respond', config: { template: 'Result: {{prev}}' } },
    ],
  });

  const start = Date.now();
  const res = http.post(
    `${RUNTIME_BASE}${apiPath(`/projects/${PROJECT_ID}/workflows/execute`)}`,
    payload,
    {
      headers: data.headers,
      tags: { scenario: 'branching_workflow' },
      timeout: '20s',
    },
  );

  const elapsed = Date.now() - start;
  workflowTotalDuration.add(elapsed);
  workflowStepLatency.add(elapsed / 4); // approximate per-step

  const ok = check(res, {
    'branching workflow 200': (r) => r.status === 200,
    'workflow completed': (r) => {
      const body = r.json() as Record<string, string>;
      return body.status === 'completed';
    },
  });

  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[branching_workflow] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(0.5);
}

/** Execute a workflow that calls an external API mid-flow */
export function externalApiWorkflow(data: SetupData): void {
  ensureFreshAuth(data);

  const payload = JSON.stringify({
    workflowId: 'benchmark-external-api',
    input: { query: 'benchmark test', userId: `user-${__VU}` },
    steps: [
      { type: 'transform', config: { template: 'Preparing query: {{input.query}}' } },
      {
        type: 'http_call',
        config: { url: 'https://httpbin.org/delay/1', method: 'GET', timeout: 5000 },
      },
      { type: 'transform', config: { template: 'API responded for user {{input.userId}}' } },
      { type: 'respond', config: { template: '{{prev}}' } },
    ],
  });

  const start = Date.now();
  const res = http.post(
    `${RUNTIME_BASE}${apiPath(`/projects/${PROJECT_ID}/workflows/execute`)}`,
    payload,
    {
      headers: data.headers,
      tags: { scenario: 'external_api_workflow' },
      timeout: '30s',
    },
  );

  const elapsed = Date.now() - start;
  workflowTotalDuration.add(elapsed);

  const ok = check(res, {
    'external API workflow 200|202': (r) => r.status === 200 || r.status === 202,
  });

  if (res.status === 202) {
    // Async workflow: poll for result
    const body = res.json() as Record<string, string>;
    const executionId = body.executionId;
    for (let i = 0; i < 10; i++) {
      sleep(2);
      const poll = http.get(
        `${RUNTIME_BASE}${apiPath(`/projects/${PROJECT_ID}/workflows/executions/${executionId}`)}`,
        { headers: data.headers, tags: { scenario: 'external_api_workflow' } },
      );
      const status = (poll.json() as Record<string, string>).status;
      if (status === 'completed' || status === 'failed') {
        workflowRecoveryTime.add(Date.now() - start);
        successRate.add(status === 'completed' ? 1 : 0);
        return;
      }
    }
    errorCount.add(1);
    successRate.add(0);
  } else {
    successRate.add(ok ? 1 : 0);
    if (!ok) {
      console.log(`[external_api_workflow] status=${res.status}`);
      errorCount.add(1);
    }
  }

  sleep(0.5);
}

// ---------------------------------------------------------------------------
// Default export — allows `k6 run --vus 1 --iterations 1` quick smoke tests
// ---------------------------------------------------------------------------

export default function (data: SetupData): void {
  simpleWorkflow(data);
}

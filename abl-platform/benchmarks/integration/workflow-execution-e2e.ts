/**
 * Workflow Execution E2E Benchmark
 *
 * Full flow: Studio -> Workflow Engine -> Restate -> Runtime
 * Tests the complete workflow lifecycle from creation through distributed execution.
 */
import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { config, apiPath, studioApiPath } from '../lib/config.ts';
import { getAuthToken, getRefreshToken, makeAuthHeaders, ensureFreshAuth } from '../lib/auth.ts';
import {
  workflowStepLatency,
  workflowTotalDuration,
  workflowRecoveryTime,
  queueWaitTime,
  successRate,
  errorCount,
} from '../lib/metrics.ts';
import { vuScale, scaleStages, scaleArrivalRate } from '../lib/vu-scaling.ts';

const STUDIO = config.studioUrl;
const RUNTIME = config.runtimeUrl;
const PROJECT_ID = config.projectId;

// Baseline total: 5 + 25 (maxVUs) + 50 (peak) + 2 = 82 VUs — scale via MAX_VUS env var
const scale = vuScale(82);
const execExistingRate = scaleArrivalRate(82, { rate: 5, preAllocatedVUs: 10, maxVUs: 25 });

export const options = {
  scenarios: {
    create_and_execute: {
      executor: 'per-vu-iterations',
      vus: scale(5),
      iterations: 10,
      exec: 'createAndExecute',
    },
    execute_existing: {
      executor: 'constant-arrival-rate',
      rate: execExistingRate.rate,
      timeUnit: '1s',
      duration: '3m',
      preAllocatedVUs: execExistingRate.preAllocatedVUs,
      maxVUs: execExistingRate.maxVUs,
      startTime: '5m',
      exec: 'executeExisting',
    },
    parallel_executions: {
      executor: 'ramping-vus',
      startVUs: scale(2),
      stages: scaleStages(
        [
          { duration: '1m', target: 20 },
          { duration: '3m', target: 50 },
          { duration: '1m', target: 0 },
        ],
        82,
      ),
      startTime: '8m',
      exec: 'parallelExecutions',
    },
    long_running_workflow: {
      executor: 'per-vu-iterations',
      vus: scale(2),
      iterations: 5,
      startTime: '13m',
      exec: 'longRunningWorkflow',
    },
  },
  thresholds: {
    'http_req_duration{scenario:create_and_execute}': ['p(95)<5000', 'p(99)<10000'],
    'http_req_duration{scenario:execute_existing}': ['p(95)<3000', 'p(99)<8000'],
    'http_req_duration{scenario:parallel_executions}': ['p(95)<5000', 'p(99)<10000'],
    http_req_failed: ['rate<0.05'],
    abl_workflow_total_duration_ms: ['p(95)<10000'],
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
  return { token, refreshToken, headers };
}

/** Poll workflow execution until done */
function pollExecution(
  data: SetupData,
  executionId: string,
  maxWaitSec: number,
): { ok: boolean; durationMs: number } {
  const start = Date.now();
  const interval = 2;
  const maxPolls = Math.ceil(maxWaitSec / interval);

  for (let i = 0; i < maxPolls; i++) {
    sleep(interval);
    const res = http.get(
      `${RUNTIME}${apiPath(`/projects/${PROJECT_ID}/workflows/executions/${executionId}`)}`,
      { headers: data.headers },
    );
    if (res.status !== 200) continue;

    const body = res.json() as Record<string, unknown>;
    const status = body.status as string;
    if (status === 'completed') return { ok: true, durationMs: Date.now() - start };
    if (status === 'failed') return { ok: false, durationMs: Date.now() - start };
  }
  return { ok: false, durationMs: Date.now() - start };
}

/** Create a workflow via Studio, then execute it via Runtime */
export function createAndExecute(data: SetupData): void {
  ensureFreshAuth(data);

  const workflowName = `bench-wf-${__VU}-${__ITER}`;

  group('create workflow', () => {
    const createPayload = JSON.stringify({
      name: workflowName,
      description: 'Benchmark workflow for E2E testing',
      steps: [
        { id: 'start', type: 'trigger', next: 'process' },
        {
          id: 'process',
          type: 'transform',
          config: { template: 'Processing: {{input.data}}' },
          next: 'end',
        },
        { id: 'end', type: 'respond', config: { template: '{{prev}}' } },
      ],
    });

    const createRes = http.post(
      `${STUDIO}${studioApiPath(`/projects/${PROJECT_ID}/workflows`)}`,
      createPayload,
      {
        headers: data.headers,
        tags: { scenario: 'create_and_execute' },
      },
    );

    const created = check(createRes, {
      'workflow created': (r) => r.status === 200 || r.status === 201,
    });

    if (!created) {
      console.log(`[create_and_execute] createRes status=${createRes.status}`);
      errorCount.add(1);
      successRate.add(0);
      return;
    }

    const workflowId = (createRes.json() as Record<string, string>).id;

    // Execute the workflow
    group('execute workflow', () => {
      const execPayload = JSON.stringify({
        input: { data: `benchmark-${__VU}-${__ITER}` },
      });

      const start = Date.now();
      const execRes = http.post(
        `${RUNTIME}${apiPath(`/projects/${PROJECT_ID}/workflows/${workflowId}/execute`)}`,
        execPayload,
        { headers: data.headers, tags: { scenario: 'create_and_execute' }, timeout: '30s' },
      );

      if (execRes.status === 202) {
        const execId = (execRes.json() as Record<string, string>).executionId;
        const result = pollExecution(data, execId, 30);
        workflowTotalDuration.add(result.durationMs);
        successRate.add(result.ok ? 1 : 0);
        if (!result.ok) errorCount.add(1);
      } else {
        workflowTotalDuration.add(Date.now() - start);
        const ok = check(execRes, { 'workflow executed 200': (r) => r.status === 200 });
        successRate.add(ok ? 1 : 0);
        if (!ok) {
          console.log(`[create_and_execute] execRes status=${execRes.status}`);
          errorCount.add(1);
        }
      }
    });

    // Cleanup
    http.del(`${STUDIO}${studioApiPath(`/projects/${PROJECT_ID}/workflows/${workflowId}`)}`, null, {
      headers: data.headers,
    });
  });

  sleep(1);
}

/** Execute a pre-existing benchmark workflow repeatedly */
export function executeExisting(data: SetupData): void {
  ensureFreshAuth(data);

  const execPayload = JSON.stringify({
    input: { data: `exec-${__VU}-${__ITER}`, timestamp: Date.now() },
  });

  const start = Date.now();
  const res = http.post(
    `${RUNTIME}${apiPath(`/projects/${PROJECT_ID}/workflows/benchmark-workflow/execute`)}`,
    execPayload,
    { headers: data.headers, tags: { scenario: 'execute_existing' }, timeout: '20s' },
  );

  queueWaitTime.add(Date.now() - start);

  if (res.status === 202) {
    const execId = (res.json() as Record<string, string>).executionId;
    const result = pollExecution(data, execId, 20);
    workflowTotalDuration.add(result.durationMs);
    workflowStepLatency.add(result.durationMs / 3); // approximate 3 steps
    successRate.add(result.ok ? 1 : 0);
    if (!result.ok) errorCount.add(1);
  } else {
    workflowTotalDuration.add(Date.now() - start);
    const ok = check(res, { 'execute existing 200': (r) => r.status === 200 });
    successRate.add(ok ? 1 : 0);
    if (!ok) {
      console.log(`[execute_existing] status=${res.status}`);
      errorCount.add(1);
    }
  }

  sleep(0.2);
}

/** Many parallel workflow executions to stress Restate */
export function parallelExecutions(data: SetupData): void {
  ensureFreshAuth(data);

  const execPayload = JSON.stringify({
    input: { data: `parallel-${__VU}-${__ITER}` },
  });

  const start = Date.now();
  const res = http.post(
    `${RUNTIME}${apiPath(`/projects/${PROJECT_ID}/workflows/benchmark-workflow/execute`)}`,
    execPayload,
    { headers: data.headers, tags: { scenario: 'parallel_executions' }, timeout: '30s' },
  );

  workflowTotalDuration.add(Date.now() - start);

  const ok = check(res, {
    'parallel exec accepted': (r) => r.status === 200 || r.status === 202,
  });

  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[parallel_executions] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(0.1);
}

/** Workflow with 10+ steps and timer delays to test long-running execution */
export function longRunningWorkflow(data: SetupData): void {
  ensureFreshAuth(data);

  const steps = Array.from({ length: 10 }, (_, i) => ({
    id: `step-${i}`,
    type: 'transform',
    config: { template: `Step ${i}: processing {{prev || input.data}}` },
    ...(i < 9 ? { next: `step-${i + 1}` } : {}),
  }));

  const execPayload = JSON.stringify({
    workflowDefinition: { steps },
    input: { data: `long-running-${__VU}-${__ITER}` },
  });

  const start = Date.now();
  const res = http.post(
    `${RUNTIME}${apiPath(`/projects/${PROJECT_ID}/workflows/execute-adhoc`)}`,
    execPayload,
    { headers: data.headers, tags: { scenario: 'long_running_workflow' }, timeout: '120s' },
  );

  if (res.status === 202) {
    const execId = (res.json() as Record<string, string>).executionId;
    const result = pollExecution(data, execId, 90);
    workflowTotalDuration.add(result.durationMs);
    workflowRecoveryTime.add(result.durationMs);
    workflowStepLatency.add(result.durationMs / 10);
    successRate.add(result.ok ? 1 : 0);
    if (!result.ok) errorCount.add(1);
  } else {
    workflowTotalDuration.add(Date.now() - start);
    const ok = check(res, { 'long workflow 200': (r) => r.status === 200 });
    successRate.add(ok ? 1 : 0);
    if (!ok) {
      console.log(`[long_running_workflow] status=${res.status}`);
      errorCount.add(1);
    }
  }

  sleep(2);
}

// ---------------------------------------------------------------------------
// Default export — allows `k6 run --vus 1 --iterations 1` quick smoke tests
// ---------------------------------------------------------------------------

export default function (data: SetupData): void {
  createAndExecute(data);
}

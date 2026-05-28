/**
 * Restate benchmark: durable workflow execution with sleep and retry.
 *
 * Targets the Restate HTTP ingress API for invoking durable workflows
 * of varying complexity (3-step, 10-step) with sleep timers and
 * retry/recovery patterns.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { config } from '../lib/config.ts';
import { ensureFreshAuth } from '../lib/auth.ts';
import {
  successRate,
  workflowStepLatency,
  workflowTotalDuration,
  workflowRecoveryTime,
} from '../lib/metrics.ts';

const RESTATE_URL = config.restateUrl;
const TENANT_ID = config.tenantId;

export const options = {
  scenarios: {
    threeStepWorkflow: {
      executor: 'constant-vus',
      vus: 10,
      duration: '2m',
      exec: 'threeStepWorkflow',
    },
    tenStepWorkflow: {
      executor: 'constant-vus',
      vus: 5,
      duration: '2m',
      exec: 'tenStepWorkflow',
    },
    sleepWorkflow: {
      executor: 'constant-vus',
      vus: 8,
      duration: '2m',
      exec: 'sleepWorkflow',
    },
    retryWorkflow: {
      executor: 'ramping-vus',
      startVUs: 2,
      stages: [
        { duration: '1m', target: 8 },
        { duration: '1m', target: 15 },
      ],
      exec: 'retryWorkflow',
    },
  },
  thresholds: {
    abl_workflow_step_latency_ms: ['p(95)<500', 'p(99)<1000'],
    abl_workflow_total_duration_ms: ['p(95)<5000', 'p(99)<10000'],
    abl_workflow_recovery_time_ms: ['p(95)<2000', 'p(99)<5000'],
    abl_success_rate: ['rate>0.95'],
  },
};

// ---------------------------------------------------------------------------
// Setup — direct service connection (no auth required)
// ---------------------------------------------------------------------------

interface SetupData {
  token: string;
  refreshToken: string;
  headers: Record<string, string>;
}

export function setup(): SetupData {
  const headers = { 'Content-Type': 'application/json' };
  return { token: '', refreshToken: '', headers };
}

/** Invoke a 3-step sequential workflow (validate -> process -> respond). */
export function threeStepWorkflow(data: SetupData): void {
  ensureFreshAuth(data);

  const workflowId = `bench-3step-${__VU}-${__ITER}`;

  const totalStart = Date.now();
  const res = http.post(
    `${RESTATE_URL}/AgentWorkflow/${workflowId}/run`,
    JSON.stringify({
      tenantId: TENANT_ID,
      steps: [
        { name: 'validate', type: 'transform', input: { message: `VU ${__VU} msg` } },
        { name: 'process', type: 'llm_call', input: { prompt: 'Benchmark processing step' } },
        { name: 'respond', type: 'transform', input: { format: 'json' } },
      ],
    }),
    { headers: data.headers },
  );
  workflowTotalDuration.add(Date.now() - totalStart);

  const ok = check(res, { '3-step 2xx': (r) => r.status >= 200 && r.status < 300 });
  successRate.add(ok ? 1 : 0);
  if (!ok) console.log(`[three_step_workflow] status=${res.status}`);

  // Parse step latencies from response if available
  if (res.status >= 200 && res.status < 300) {
    try {
      const body = res.json() as { stepDurations?: number[] };
      if (body.stepDurations) {
        for (const duration of body.stepDurations) {
          workflowStepLatency.add(duration);
        }
      }
    } catch {
      // Response may not include step durations
    }
  }

  sleep(0.2);
}

/** Invoke a 10-step workflow simulating a complex agent pipeline. */
export function tenStepWorkflow(data: SetupData): void {
  ensureFreshAuth(data);

  const workflowId = `bench-10step-${__VU}-${__ITER}`;
  const stepTypes = ['transform', 'llm_call', 'tool_call', 'decision', 'transform'];

  const steps = Array.from({ length: 10 }, (_, i) => ({
    name: `step-${i}`,
    type: stepTypes[i % stepTypes.length],
    input: {
      iteration: i,
      payload: `Step ${i} of 10-step benchmark workflow from VU ${__VU}`,
    },
  }));

  const totalStart = Date.now();
  const res = http.post(
    `${RESTATE_URL}/AgentWorkflow/${workflowId}/run`,
    JSON.stringify({ tenantId: TENANT_ID, steps }),
    { headers: data.headers },
  );
  workflowTotalDuration.add(Date.now() - totalStart);

  const ok = check(res, { '10-step 2xx': (r) => r.status >= 200 && r.status < 300 });
  successRate.add(ok ? 1 : 0);
  if (!ok) console.log(`[ten_step_workflow] status=${res.status}`);

  if (res.status >= 200 && res.status < 300) {
    try {
      const body = res.json() as { stepDurations?: number[] };
      if (body.stepDurations) {
        for (const duration of body.stepDurations) {
          workflowStepLatency.add(duration);
        }
      }
    } catch {
      // Response may not include step durations
    }
  }

  sleep(0.5);
}

/** Workflow with sleep timers simulating delayed processing. */
export function sleepWorkflow(data: SetupData): void {
  ensureFreshAuth(data);

  const workflowId = `bench-sleep-${__VU}-${__ITER}`;

  const totalStart = Date.now();
  const res = http.post(
    `${RESTATE_URL}/TimedWorkflow/${workflowId}/run`,
    JSON.stringify({
      tenantId: TENANT_ID,
      steps: [
        { name: 'start', type: 'transform', input: { action: 'initialize' } },
        { name: 'wait', type: 'sleep', duration: 1000 },
        { name: 'process', type: 'transform', input: { action: 'finalize' } },
      ],
    }),
    { headers: data.headers },
  );
  workflowTotalDuration.add(Date.now() - totalStart);

  const ok = check(res, { 'sleep workflow 2xx': (r) => r.status >= 200 && r.status < 300 });
  successRate.add(ok ? 1 : 0);
  if (!ok) console.log(`[sleep_workflow] status=${res.status}`);

  sleep(0.2);
}

/** Workflow with intentional failures to test retry and recovery. */
export function retryWorkflow(data: SetupData): void {
  ensureFreshAuth(data);

  const workflowId = `bench-retry-${__VU}-${__ITER}`;
  const failRate = 0.3; // 30% of steps configured to fail initially

  const totalStart = Date.now();
  const res = http.post(
    `${RESTATE_URL}/RetryWorkflow/${workflowId}/run`,
    JSON.stringify({
      tenantId: TENANT_ID,
      steps: [
        { name: 'validate', type: 'transform', input: { action: 'validate' } },
        {
          name: 'unreliable-call',
          type: 'tool_call',
          input: { action: 'external_api', simulateFailRate: failRate },
          retryPolicy: { maxAttempts: 3, initialDelay: 100, backoffMultiplier: 2 },
        },
        { name: 'confirm', type: 'transform', input: { action: 'confirm' } },
      ],
    }),
    { headers: data.headers },
  );
  const elapsed = Date.now() - totalStart;
  workflowTotalDuration.add(elapsed);
  workflowRecoveryTime.add(elapsed);

  const ok = check(res, { 'retry workflow 2xx': (r) => r.status >= 200 && r.status < 300 });
  successRate.add(ok ? 1 : 0);
  if (!ok) console.log(`[retry_workflow] status=${res.status}`);

  sleep(0.3);
}

// ---------------------------------------------------------------------------
// Default export — allows `k6 run --vus 1 --iterations 1` quick smoke tests
// ---------------------------------------------------------------------------

export default function (data: SetupData): void {
  threeStepWorkflow(data);
}

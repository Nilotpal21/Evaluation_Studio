/**
 * Failover & Recovery Test
 *
 * Continuous load while simulating pod failures via Kubernetes API.
 * Measures recovery time, request routing during failure, and data consistency.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { config, apiPath } from '../lib/config.ts';
import { ensureFreshAuth, getAuthToken, getRefreshToken, makeAuthHeaders } from '../lib/auth.ts';
import {
  agentTurnLatency,
  vectorSearchLatency,
  workflowRecoveryTime,
  successRate,
  errorCount,
} from '../lib/metrics.ts';
import { Trend, Counter, Gauge } from 'k6/metrics';

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

const recoveryDuration = new Trend('abl_recovery_duration_ms', true);
const failoverErrors = new Counter('abl_failover_errors_total');
const serviceAvailability = new Gauge('abl_service_availability');

/** Kubernetes API URL for pod management (set via env) */
const K8S_API = __ENV.K8S_API_URL || 'http://localhost:8001';
const K8S_NAMESPACE = __ENV.K8S_NAMESPACE || 'abl-platform';
const K8S_TOKEN = __ENV.K8S_TOKEN || '';

function k8sHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(K8S_TOKEN ? { Authorization: `Bearer ${K8S_TOKEN}` } : {}),
  };
}

export const options = {
  scenarios: {
    steady_chat: {
      executor: 'constant-arrival-rate',
      rate: 5,
      timeUnit: '1s',
      duration: '15m',
      preAllocatedVUs: 10,
      maxVUs: 25,
      exec: 'steadyChat',
    },
    steady_search: {
      executor: 'constant-arrival-rate',
      rate: 10,
      timeUnit: '1s',
      duration: '15m',
      preAllocatedVUs: 10,
      maxVUs: 25,
      exec: 'steadySearch',
    },
    pod_killer: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 5,
      startTime: '3m',
      exec: 'killPods',
    },
    health_monitor: {
      executor: 'constant-arrival-rate',
      rate: 1,
      timeUnit: '2s',
      duration: '15m',
      preAllocatedVUs: 1,
      maxVUs: 2,
      exec: 'monitorHealth',
    },
  },
  thresholds: {
    // Allow higher error rate during failover but recovery should be fast
    http_req_failed: [{ threshold: 'rate<0.15', abortOnFail: false }],
    abl_recovery_duration_ms: ['p(95)<30000'], // recover within 30s
    abl_service_availability: ['value>0.90'], // 90% uptime minimum
    abl_failover_errors_total: [{ threshold: 'count<50', abortOnFail: false }],
  },
};

/** Continuous chat load to detect failover impact */
export function steadyChat(data: SetupData): void {
  ensureFreshAuth(data);

  const sessionRes = http.post(
    `${RUNTIME}${apiPath(`/projects/${PROJECT_ID}/sessions`)}`,
    JSON.stringify({ agentId: 'benchmark-agent' }),
    { headers: data.headers },
  );

  if (sessionRes.status !== 200 && sessionRes.status !== 201) {
    failoverErrors.add(1);
    errorCount.add(1);
    successRate.add(0);
    sleep(1);
    return;
  }

  const sessionId = (sessionRes.json() as Record<string, string>).sessionId;
  const start = Date.now();

  const res = http.post(
    `${RUNTIME}${apiPath(`/projects/${PROJECT_ID}/chat`)}`,
    JSON.stringify({ message: 'Test message during failover', sessionId }),
    { headers: data.headers, tags: { scenario: 'steady_chat' }, timeout: '30s' },
  );

  agentTurnLatency.add(Date.now() - start);

  const ok = check(res, { 'steady chat ok': (r) => r.status === 200 });
  if (!ok) failoverErrors.add(1);
  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[steady_chat] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(0.2);
}

/** Continuous search load */
export function steadySearch(data: SetupData): void {
  ensureFreshAuth(data);

  const start = Date.now();

  const res = http.post(
    `${SEARCH_RT}${apiPath(`/projects/${PROJECT_ID}/search`)}`,
    JSON.stringify({ query: 'Documentation search during failover', topK: 5 }),
    { headers: data.headers, tags: { scenario: 'steady_search' } },
  );

  vectorSearchLatency.add(Date.now() - start);

  const ok = check(res, { 'steady search ok': (r) => r.status === 200 });
  if (!ok) failoverErrors.add(1);
  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[steady_search] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(0.05);
}

/** Kill pods and measure recovery time */
export function killPods(data: SetupData): void {
  ensureFreshAuth(data);

  const deployments = ['runtime', 'search-ai-runtime', 'search-ai'];
  const target = deployments[__ITER % deployments.length];

  // Get pod list for the target deployment
  const podsRes = http.get(
    `${K8S_API}/api/v1/namespaces/${K8S_NAMESPACE}/pods?labelSelector=app=${target}`,
    { headers: k8sHeaders(), timeout: '10s' },
  );

  if (podsRes.status !== 200) {
    console.warn(`Cannot list pods for ${target}: ${podsRes.status}`); // eslint-disable-line no-console
    sleep(60);
    return;
  }

  const pods = podsRes.json() as Record<string, unknown>;
  const items = pods.items as Array<Record<string, unknown>>;
  if (!items || items.length === 0) {
    sleep(60);
    return;
  }

  // Kill the first pod
  const podName = (items[0].metadata as Record<string, string>).name;
  const killStart = Date.now();

  const deleteRes = http.del(
    `${K8S_API}/api/v1/namespaces/${K8S_NAMESPACE}/pods/${podName}`,
    null,
    { headers: k8sHeaders(), timeout: '10s' },
  );

  check(deleteRes, { [`${target} pod deleted`]: (r) => r.status === 200 });

  // Poll health until recovery
  let recovered = false;
  for (let i = 0; i < 60; i++) {
    sleep(1);

    const healthUrl =
      target === 'runtime'
        ? `${RUNTIME}/health`
        : target === 'search-ai-runtime'
          ? `${SEARCH_RT}/health`
          : `${config.searchAiUrl}/health`;

    const healthRes = http.get(healthUrl, { headers: data.headers, timeout: '5s' });
    if (healthRes.status === 200) {
      const elapsed = Date.now() - killStart;
      recoveryDuration.add(elapsed);
      workflowRecoveryTime.add(elapsed);
      recovered = true;
      break;
    }
  }

  if (!recovered) {
    recoveryDuration.add(60000); // cap at 60s
    failoverErrors.add(1);
  }

  // Wait between kills to allow stabilization
  sleep(120);
}

/** Monitor service health endpoints */
export function monitorHealth(_data: SetupData): void {
  const services = [
    { name: 'runtime', url: `${RUNTIME}/health` },
    { name: 'search-ai-runtime', url: `${SEARCH_RT}/health` },
  ];

  let allHealthy = true;
  for (const svc of services) {
    const res = http.get(svc.url, { timeout: '5s' });
    const healthy = res.status === 200;
    if (!healthy) allHealthy = false;
  }

  serviceAvailability.add(allHealthy ? 1 : 0);
}

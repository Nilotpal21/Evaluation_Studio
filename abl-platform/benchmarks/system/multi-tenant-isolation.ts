/**
 * Multi-Tenant Isolation Test
 *
 * Multiple tenants with different workloads running concurrently.
 * Validates that one tenant's load does not degrade another's performance.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { config, apiPath, studioApiPath } from '../lib/config.ts';
import { ensureFreshAuth, getAuthToken, getRefreshToken, makeAuthHeaders } from '../lib/auth.ts';
import { agentTurnLatency, vectorSearchLatency, successRate, errorCount } from '../lib/metrics.ts';
import { Trend, Counter } from 'k6/metrics';

const RUNTIME = config.runtimeUrl;
const SEARCH_RT = config.searchAiRuntimeUrl;
const STUDIO = config.studioUrl;

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

const tenantLatency = new Trend('abl_tenant_latency_ms', true);
const crossTenantErrors = new Counter('abl_cross_tenant_errors');

/** Tenants with different workload profiles */
const TENANTS = [
  { id: 'tenant-light', name: 'Light Tenant', projectId: 'proj-light' },
  { id: 'tenant-medium', name: 'Medium Tenant', projectId: 'proj-medium' },
  { id: 'tenant-heavy', name: 'Heavy Tenant', projectId: 'proj-heavy' },
  { id: 'tenant-bursty', name: 'Bursty Tenant', projectId: 'proj-bursty' },
];

function getTenant(): { id: string; name: string; projectId: string } {
  return TENANTS[__VU % TENANTS.length];
}

function getHeaders(tenantId: string, token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'X-Tenant-Id': tenantId,
  };
}

export const options = {
  scenarios: {
    light_tenant: {
      executor: 'constant-arrival-rate',
      rate: 2,
      timeUnit: '1s',
      duration: '10m',
      preAllocatedVUs: 3,
      maxVUs: 8,
      exec: 'lightTenantWorkload',
    },
    medium_tenant: {
      executor: 'constant-arrival-rate',
      rate: 10,
      timeUnit: '1s',
      duration: '10m',
      preAllocatedVUs: 10,
      maxVUs: 25,
      exec: 'mediumTenantWorkload',
    },
    heavy_tenant: {
      executor: 'constant-arrival-rate',
      rate: 30,
      timeUnit: '1s',
      duration: '10m',
      preAllocatedVUs: 30,
      maxVUs: 60,
      exec: 'heavyTenantWorkload',
    },
    bursty_tenant: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '2m', target: 5 },
        { duration: '1m', target: 80 },
        { duration: '1m', target: 80 },
        { duration: '1m', target: 5 },
        { duration: '1m', target: 100 },
        { duration: '1m', target: 100 },
        { duration: '1m', target: 5 },
        { duration: '2m', target: 5 },
      ],
      exec: 'burstyTenantWorkload',
    },
    isolation_verification: {
      executor: 'constant-arrival-rate',
      rate: 1,
      timeUnit: '5s',
      duration: '10m',
      preAllocatedVUs: 2,
      maxVUs: 4,
      exec: 'verifyIsolation',
    },
  },
  thresholds: {
    // Light tenant should not be degraded by heavy/bursty tenants
    'http_req_duration{scenario:light_tenant}': ['p(95)<3000', 'p(99)<5000'],
    'http_req_duration{scenario:medium_tenant}': ['p(95)<5000', 'p(99)<10000'],
    http_req_failed: ['rate<0.05'],
    abl_cross_tenant_errors: ['count<1'],
    abl_success_rate: ['rate>0.90'],
  },
};

/** Light tenant: occasional search queries */
export function lightTenantWorkload(data: SetupData): void {
  ensureFreshAuth(data);

  const tenant = TENANTS[0];
  const headers = getHeaders(tenant.id, data.token);

  const start = Date.now();
  const res = http.post(
    `${SEARCH_RT}${apiPath(`/projects/${tenant.projectId}/search`)}`,
    JSON.stringify({ query: 'How do I get started?', topK: 3 }),
    { headers, tags: { scenario: 'light_tenant' } },
  );

  const elapsed = Date.now() - start;
  tenantLatency.add(elapsed);
  vectorSearchLatency.add(elapsed);

  const ok = check(res, { 'light tenant 200': (r) => r.status === 200 });
  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[light_tenant] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(0.5);
}

/** Medium tenant: mixed chat and search */
export function mediumTenantWorkload(data: SetupData): void {
  ensureFreshAuth(data);

  const tenant = TENANTS[1];
  const headers = getHeaders(tenant.id, data.token);

  if (Math.random() > 0.5) {
    // Chat
    const sessionRes = http.post(
      `${RUNTIME}${apiPath(`/projects/${tenant.projectId}/sessions`)}`,
      JSON.stringify({ agentId: 'benchmark-agent' }),
      { headers },
    );

    if (sessionRes.status === 200 || sessionRes.status === 201) {
      const sessionId = (sessionRes.json() as Record<string, string>).sessionId;
      const start = Date.now();
      const res = http.post(
        `${RUNTIME}${apiPath(`/projects/${tenant.projectId}/chat`)}`,
        JSON.stringify({ message: 'Help me with my configuration', sessionId }),
        { headers, tags: { scenario: 'medium_tenant' }, timeout: '20s' },
      );
      agentTurnLatency.add(Date.now() - start);
      tenantLatency.add(Date.now() - start);
      const ok = check(res, { 'medium chat 200': (r) => r.status === 200 });
      successRate.add(ok ? 1 : 0);
      if (!ok) {
        console.log(`[medium_tenant] status=${res.status}`);
        errorCount.add(1);
      }
    }
  } else {
    // Search
    const start = Date.now();
    const res = http.post(
      `${SEARCH_RT}${apiPath(`/projects/${tenant.projectId}/search`)}`,
      JSON.stringify({ query: 'Configuration best practices', topK: 5 }),
      { headers, tags: { scenario: 'medium_tenant' } },
    );
    tenantLatency.add(Date.now() - start);
    const ok = check(res, { 'medium search 200': (r) => r.status === 200 });
    successRate.add(ok ? 1 : 0);
    if (!ok) {
      console.log(`[medium_tenant] status=${res.status}`);
      errorCount.add(1);
    }
  }

  sleep(0.1);
}

/** Heavy tenant: high-volume search and API calls */
export function heavyTenantWorkload(data: SetupData): void {
  ensureFreshAuth(data);

  const tenant = TENANTS[2];
  const headers = getHeaders(tenant.id, data.token);

  const start = Date.now();
  const res = http.post(
    `${SEARCH_RT}${apiPath(`/projects/${tenant.projectId}/search`)}`,
    JSON.stringify({ query: 'Detailed technical documentation', topK: 10 }),
    { headers, tags: { scenario: 'heavy_tenant' } },
  );

  tenantLatency.add(Date.now() - start);

  const ok = check(res, { 'heavy tenant 200': (r) => r.status === 200 });
  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[heavy_tenant] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(0.02);
}

/** Bursty tenant: spikes of traffic */
export function burstyTenantWorkload(data: SetupData): void {
  ensureFreshAuth(data);

  const tenant = TENANTS[3];
  const headers = getHeaders(tenant.id, data.token);

  const start = Date.now();
  const res = http.post(
    `${SEARCH_RT}${apiPath(`/projects/${tenant.projectId}/search`)}`,
    JSON.stringify({ query: 'Urgent support query', topK: 5 }),
    { headers, tags: { scenario: 'bursty_tenant' } },
  );

  tenantLatency.add(Date.now() - start);

  const ok = check(res, { 'bursty tenant 200|429': (r) => r.status === 200 || r.status === 429 });
  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[bursty_tenant] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(0.05);
}

/** Verify cross-tenant data isolation */
export function verifyIsolation(data: SetupData): void {
  ensureFreshAuth(data);

  // Try to access tenant-light's data using tenant-heavy's credentials
  const attackerHeaders = getHeaders('tenant-heavy', data.token);

  const res = http.get(`${STUDIO}${studioApiPath(`/projects/${TENANTS[0].projectId}/agents`)}`, {
    headers: attackerHeaders,
    tags: { scenario: 'isolation_verification' },
  });

  // Should be 404 (resource not found for this tenant) or 403
  const isolated = check(res, {
    'cross-tenant blocked': (r) => r.status === 404 || r.status === 403 || r.status === 401,
  });

  if (!isolated && res.status === 200) {
    crossTenantErrors.add(1);
    errorCount.add(1);
  }

  // Verify each tenant can access their own data
  for (const tenant of TENANTS) {
    const headers = getHeaders(tenant.id, data.token);
    const ownRes = http.get(`${STUDIO}${studioApiPath(`/projects/${tenant.projectId}`)}`, {
      headers,
    });

    check(ownRes, {
      [`${tenant.name} own data accessible`]: (r) => r.status === 200,
    });
  }

  sleep(1);
}

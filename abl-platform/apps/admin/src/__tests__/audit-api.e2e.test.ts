// @vitest-environment node

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { startAdminApiHarness, type AdminApiHarness } from './helpers/admin-api-harness';

const nativeFetch = globalThis.fetch.bind(globalThis);
vi.stubGlobal('fetch', nativeFetch);

interface ApiResponse<T> {
  status: number;
  body: T;
  headers: Headers;
}

interface AdminAuditResponse {
  count: number;
  entries: Array<{
    actor: string;
    action: string;
    target: string;
    environment?: string;
    ipAddress?: string;
    timestamp: string;
  }>;
}

function authHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function requestJson<T>(
  harness: AdminApiHarness,
  path: string,
  init: RequestInit = {},
): Promise<ApiResponse<T>> {
  const response = await fetch(`${harness.baseUrl}${path}`, init);
  const text = await response.text();

  return {
    status: response.status,
    body: text.length > 0 ? (JSON.parse(text) as T) : ({} as T),
    headers: response.headers,
  };
}

async function requestText(
  harness: AdminApiHarness,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: string; headers: Headers }> {
  const response = await fetch(`${harness.baseUrl}${path}`, init);
  return {
    status: response.status,
    body: await response.text(),
    headers: response.headers,
  };
}

async function createSecret(
  harness: AdminApiHarness,
  token: string,
  body: { name: string; value: string; scope: string; environment: string },
): Promise<void> {
  const response = await requestJson<{ success: boolean }>(harness, '/api/secrets', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });

  expect(response.status).toBe(201);
  expect(response.body.success).toBe(true);
}

async function listSecrets(
  harness: AdminApiHarness,
  token: string,
  query = '?scope=shared&env=dev',
): Promise<void> {
  const response = await requestJson<{ secrets: unknown[] }>(harness, `/api/secrets${query}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  expect(response.status).toBe(200);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.sequential('Admin audit API e2e', () => {
  let harness: AdminApiHarness;

  beforeAll(async () => {
    harness = await startAdminApiHarness();
  }, 60_000);

  afterAll(async () => {
    if (!harness) {
      return;
    }
    await harness.close();
  }, 60_000);

  test('supports real audit query filters over HTTP', async () => {
    const actorA = 'admin-query-a';
    const actorB = 'admin-query-b';
    const tokenA = await harness.createAccessToken({
      userId: actorA,
      email: `${actorA}@example.com`,
    });
    const tokenB = await harness.createAccessToken({
      userId: actorB,
      email: `${actorB}@example.com`,
    });

    await createSecret(harness, tokenA, {
      name: `alpha-${Date.now()}`,
      value: 'secret-alpha',
      scope: 'shared',
      environment: 'dev',
    });
    await sleep(25);
    const fromBoundary = new Date().toISOString();
    await sleep(25);
    await listSecrets(harness, tokenA);
    await createSecret(harness, tokenB, {
      name: `beta-${Date.now()}`,
      value: 'secret-beta',
      scope: 'shared',
      environment: 'dev',
    });

    const byActor = await requestJson<AdminAuditResponse>(
      harness,
      `/api/audit?actor=${actorA}&limit=10`,
      { headers: { Authorization: `Bearer ${tokenA}` } },
    );
    expect(byActor.status).toBe(200);
    expect(byActor.body.count).toBeGreaterThanOrEqual(2);
    expect(byActor.body.entries.every((entry) => entry.actor === actorA)).toBe(true);

    const byAction = await requestJson<AdminAuditResponse>(
      harness,
      `/api/audit?actor=${actorA}&action=secret_list&limit=10`,
      { headers: { Authorization: `Bearer ${tokenA}` } },
    );
    expect(byAction.status).toBe(200);
    expect(byAction.body.count).toBe(1);
    expect(byAction.body.entries[0]?.action).toBe('secret_list');

    const byDate = await requestJson<AdminAuditResponse>(
      harness,
      `/api/audit?actor=${actorA}&from=${encodeURIComponent(fromBoundary)}&limit=10`,
      { headers: { Authorization: `Bearer ${tokenA}` } },
    );
    expect(byDate.status).toBe(200);
    expect(byDate.body.count).toBe(1);
    expect(byDate.body.entries[0]?.action).toBe('secret_list');

    const limited = await requestJson<AdminAuditResponse>(
      harness,
      `/api/audit?actor=${actorA}&limit=1`,
      { headers: { Authorization: `Bearer ${tokenA}` } },
    );
    expect(limited.status).toBe(200);
    expect(limited.body.count).toBe(1);
  });

  test('exports filtered admin audit rows as CSV over HTTP', async () => {
    const actor = 'admin-export';
    const token = await harness.createAccessToken({
      userId: actor,
      email: `${actor}@example.com`,
    });

    await createSecret(harness, token, {
      name: `export-a-${Date.now()}`,
      value: 'secret-export-a',
      scope: 'shared',
      environment: 'staging',
    });
    await createSecret(harness, token, {
      name: `export-b-${Date.now()}`,
      value: 'secret-export-b',
      scope: 'shared',
      environment: 'staging',
    });

    const response = await requestText(
      harness,
      `/api/audit/export?actor=${actor}&action=secret_create&limit=10`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(response.body).toContain('Timestamp,Actor,Role,Action,Target,Environment,IP Address');
    expect(response.body).toContain(actor);
    expect(response.body).toContain('secret_create');
    expect(response.body).toContain('secrets/shared/');
    expect(response.body.split('\n').length).toBeGreaterThanOrEqual(3);
  });
});

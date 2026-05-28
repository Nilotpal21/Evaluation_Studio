// @vitest-environment node

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { startStudioApiHarness, type StudioApiHarness } from './helpers/studio-api-harness';

const nativeFetch = (globalThis as Record<string, unknown>).__nativeFetch as typeof fetch;
vi.stubGlobal('fetch', nativeFetch);

interface ApiResponse<T> {
  status: number;
  body: T;
}

interface DevLoginResponse {
  user: {
    id: string;
    email: string;
  };
  accessToken: string;
}

interface CreateWorkspaceResponse {
  workspace: {
    id: string;
    name: string;
    slug: string;
  };
  accessToken: string;
}

interface StudioAuditResponse {
  total: number;
  scope: string;
  personalScopeMode?: string;
  logs: Array<{
    id: string;
    userId: string | null;
    tenantId: string | null;
    action: string;
    ip: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: string;
  }>;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

function uniqueEmail(prefix: string): string {
  return `${prefix}.${randomSuffix()}@e2e-smoke.test`;
}

function authHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function requestJson<T>(
  harness: StudioApiHarness,
  path: string,
  init: RequestInit = {},
): Promise<ApiResponse<T>> {
  const response = await fetch(`${harness.baseUrl}${path}`, init);
  const text = await response.text();

  return {
    status: response.status,
    body: text.length > 0 ? (JSON.parse(text) as T) : ({} as T),
  };
}

async function devLogin(harness: StudioApiHarness, email: string): Promise<DevLoginResponse> {
  const response = await requestJson<DevLoginResponse>(harness, '/api/auth/dev-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name: email.split('@')[0] }),
  });

  expect(response.status).toBe(200);
  return response.body;
}

async function createWorkspace(
  harness: StudioApiHarness,
  token: string,
  name: string,
  forwardedFor = '198.51.100.10, 10.0.0.5',
): Promise<CreateWorkspaceResponse> {
  const response = await requestJson<CreateWorkspaceResponse>(
    harness,
    '/api/auth/create-workspace',
    {
      method: 'POST',
      headers: {
        ...authHeaders(token),
        'x-forwarded-for': forwardedFor,
      },
      body: JSON.stringify({ name }),
    },
  );

  expect(response.status).toBe(200);
  return response.body;
}

async function setAuditWriteFailure(
  harness: StudioApiHarness,
  message: string | null,
): Promise<void> {
  const response = await requestJson<{ enabled: boolean }>(
    harness,
    '/__test/audit/create-failure',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    },
  );

  expect(response.status).toBe(200);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollForAuditLogs(
  harness: StudioApiHarness,
  token: string,
  path: string,
  predicate: (body: StudioAuditResponse) => boolean,
): Promise<StudioAuditResponse> {
  let lastBody: StudioAuditResponse | null = null;

  await expect
    .poll(
      async () => {
        const response = await requestJson<StudioAuditResponse>(harness, path, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(response.status).toBe(200);
        lastBody = response.body;
        return predicate(response.body);
      },
      {
        timeout: 10_000,
        interval: 200,
      },
    )
    .toBe(true);

  return lastBody as StudioAuditResponse;
}

describe.sequential('Studio audit API e2e', () => {
  let harness: StudioApiHarness;

  beforeAll(async () => {
    harness = await startStudioApiHarness();
  });

  afterAll(async () => {
    if (!harness) {
      return;
    }
    await setAuditWriteFailure(harness, null);
    await harness.close();
  });

  test('roundtrips workspace audit events through the HTTP API', async () => {
    const login = await devLogin(harness, uniqueEmail('audit-roundtrip'));
    const workspace = await createWorkspace(
      harness,
      login.accessToken,
      `Audit Roundtrip ${randomSuffix()}`,
    );

    const body = await pollForAuditLogs(
      harness,
      workspace.accessToken,
      '/api/audit?scope=workspace&action=workspace_created',
      (result) => result.logs.length > 0,
    );

    const event = body.logs[0];
    expect(event.action).toBe('workspace_created');
    expect(event.userId).toBe(login.user.id);
    expect(event.tenantId).toBe(workspace.workspace.id);
    expect(event.ip).toBe('10.0.0.5');
    expect(event.metadata).toMatchObject({
      workspaceName: workspace.workspace.name,
      slug: workspace.workspace.slug,
    });
    expect(Date.now() - new Date(event.createdAt).getTime()).toBeLessThan(60_000);
  });

  test('does not leak tenant audit events across workspace scope', async () => {
    const tenantALogin = await devLogin(harness, uniqueEmail('audit-tenant-a'));
    const tenantAWorkspace = await createWorkspace(
      harness,
      tenantALogin.accessToken,
      `Tenant A ${randomSuffix()}`,
    );
    const tenantBLogin = await devLogin(harness, uniqueEmail('audit-tenant-b'));
    const tenantBWorkspace = await createWorkspace(
      harness,
      tenantBLogin.accessToken,
      `Tenant B ${randomSuffix()}`,
    );

    const tenantALogs = await pollForAuditLogs(
      harness,
      tenantAWorkspace.accessToken,
      '/api/audit?scope=workspace&action=workspace_created',
      (result) => result.logs.some((entry) => entry.tenantId === tenantAWorkspace.workspace.id),
    );

    expect(tenantALogs.logs.some((entry) => entry.tenantId === tenantBWorkspace.workspace.id)).toBe(
      false,
    );
    expect(
      tenantALogs.logs.every((entry) => entry.tenantId === tenantAWorkspace.workspace.id),
    ).toBe(true);
  });

  test('keeps workspace creation successful when audit writes fail', async () => {
    await setAuditWriteFailure(harness, 'forced audit failure');

    const login = await devLogin(harness, uniqueEmail('audit-failure'));
    const workspace = await createWorkspace(
      harness,
      login.accessToken,
      `Audit Failure ${randomSuffix()}`,
      '203.0.113.20, 10.0.0.9',
    );

    expect(workspace.workspace.id).toBeTruthy();
    expect(workspace.accessToken).toBeTruthy();

    await sleep(500);

    const auditResponse = await requestJson<StudioAuditResponse>(
      harness,
      '/api/audit?scope=workspace&action=workspace_created',
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${workspace.accessToken}` },
      },
    );

    expect(auditResponse.status).toBe(200);
    expect(auditResponse.body.logs).toEqual([]);

    await setAuditWriteFailure(harness, null);
  });
});

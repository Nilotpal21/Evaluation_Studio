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
  accessToken: string;
}

interface CreateWorkspaceResponse {
  accessToken: string;
}

interface CreateProjectResponse {
  success: boolean;
  project: {
    id: string;
    tenantId: string;
  };
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

function uniqueEmail(prefix: string): string {
  return `${prefix}.${randomSuffix()}@studio-e2e.test`;
}

function uniqueSlug(prefix: string): string {
  return `${prefix}-${randomSuffix()}`;
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
): Promise<CreateWorkspaceResponse> {
  const response = await requestJson<CreateWorkspaceResponse>(
    harness,
    '/api/auth/create-workspace',
    {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ name }),
    },
  );

  expect(response.status).toBe(200);
  return response.body;
}

async function createProject(
  harness: StudioApiHarness,
  token: string,
  name: string,
  slug: string,
): Promise<CreateProjectResponse['project']> {
  const response = await requestJson<CreateProjectResponse>(harness, '/api/projects', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ name, slug }),
  });

  expect(response.status).toBe(201);
  expect(response.body.success).toBe(true);
  return response.body.project;
}

describe.sequential('Studio project session lifecycle API e2e', () => {
  let harness!: StudioApiHarness;

  beforeAll(async () => {
    harness = await startStudioApiHarness();
  }, 120_000);

  afterAll(async () => {
    await harness.close();
  }, 120_000);

  test('proxies lifecycle TTL writes while preserving legacy transfer settings reads', async () => {
    const owner = await devLogin(harness, uniqueEmail('session-lifecycle-owner'));
    const workspace = await createWorkspace(
      harness,
      owner.accessToken,
      `Session Lifecycle ${randomSuffix()}`,
    );
    const project = await createProject(
      harness,
      workspace.accessToken,
      `Session Lifecycle ${randomSuffix()}`,
      uniqueSlug('session-lifecycle'),
    );

    const legacySave = await requestJson<{
      success: boolean;
      data: {
        session: {
          maxConcurrentPerContact: number;
        };
        defaultRouting: {
          queue: string;
          postAgentAction: string;
        };
      };
    }>(harness, `/api/projects/${project.id}/agent-transfer/settings`, {
      method: 'PUT',
      headers: authHeaders(workspace.accessToken),
      body: JSON.stringify({
        session: {
          maxConcurrentPerContact: 4,
        },
        defaultRouting: {
          queue: 'vip-support',
          postAgentAction: 'return',
        },
      }),
    });

    expect(legacySave.status).toBe(200);
    expect(legacySave.body.success).toBe(true);

    const lifecyclePatch = await requestJson<{
      success: boolean;
      data: {
        runtime: {
          idleSeconds?: number;
        };
        agentTransfer: {
          ttl: Record<string, number>;
        };
      };
    }>(harness, `/api/projects/${project.id}/session-lifecycle`, {
      method: 'PATCH',
      headers: authHeaders(workspace.accessToken),
      body: JSON.stringify({
        runtime: {
          idleSeconds: 1200,
        },
        agentTransfer: {
          ttl: {
            chat: 1800,
            voice: 0,
          },
        },
      }),
    });

    expect(lifecyclePatch.status).toBe(200);
    expect(lifecyclePatch.body.success).toBe(true);
    expect(lifecyclePatch.body.data.runtime).toEqual({
      idleSeconds: 1200,
    });
    expect(lifecyclePatch.body.data.agentTransfer.ttl).toEqual({
      chat: 1800,
      voice: 0,
    });

    const lifecycleRead = await requestJson<{
      success: boolean;
      data: {
        runtime: {
          idleSeconds?: number;
        };
        agentTransfer: {
          ttl: Record<string, number>;
        };
      };
    }>(harness, `/api/projects/${project.id}/session-lifecycle`, {
      method: 'GET',
      headers: authHeaders(workspace.accessToken),
    });

    expect(lifecycleRead.status).toBe(200);
    expect(lifecycleRead.body.data.runtime).toEqual({
      idleSeconds: 1200,
    });
    expect(lifecycleRead.body.data.agentTransfer.ttl).toEqual({
      chat: 1800,
      voice: 0,
    });

    const legacyRead = await requestJson<{
      success: boolean;
      data: {
        session: {
          ttl: Record<string, number>;
          maxConcurrentPerContact: number;
        };
        defaultRouting: {
          queue: string;
          postAgentAction: string;
        };
      } | null;
    }>(harness, `/api/projects/${project.id}/agent-transfer/settings`, {
      method: 'GET',
      headers: authHeaders(workspace.accessToken),
    });

    expect(legacyRead.status).toBe(200);
    expect(legacyRead.body.success).toBe(true);
    expect(legacyRead.body.data).toMatchObject({
      session: {
        ttl: {
          chat: 1800,
          voice: 0,
        },
        maxConcurrentPerContact: 4,
      },
      defaultRouting: {
        queue: 'vip-support',
        postAgentAction: 'return',
      },
    });
  }, 120_000);
});

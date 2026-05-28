// @vitest-environment node

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Express, type Request as ExpressRequest } from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const nativeFetch = (globalThis as Record<string, unknown>).__nativeFetch as typeof fetch;
vi.stubGlobal('fetch', nativeFetch);

const TEST_JWT_SECRET = '3'.repeat(64);
const TEST_MASTER_KEY = '4'.repeat(64);
const MONGOMS_VERSION = process.env.MONGOMS_VERSION || '7.0.20';

interface ApiResponse<T> {
  status: number;
  body: T;
}

interface DevLoginResponse {
  user: {
    id: string;
  };
  accessToken: string;
}

interface CreateWorkspaceResponse {
  workspace: {
    id: string;
  };
  accessToken: string;
}

interface ErrorResponse {
  error: string;
}

interface TenantRetentionResponse {
  success: boolean;
  data: {
    defaults: {
      evalConversationsTtlDays: number;
      evalScoresTtlDays: number;
      productionScoresTtlDays: number;
      syntheticTtlDays: number;
      hardDeleteExpiredRuns: boolean;
      scrubPiiOnStore: boolean;
    };
    effective: {
      evalConversationsTtlDays: number;
      evalScoresTtlDays: number;
      productionScoresTtlDays: number;
      syntheticTtlDays: number;
      hardDeleteExpiredRuns: boolean;
      scrubPiiOnStore: boolean;
    };
  };
}

interface MiniStudioHarness {
  baseUrl: string;
  close(): Promise<void>;
}

type SimpleRouteHandler = (request: Request) => Promise<Response>;

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

function authHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function buildRequestInit(req: ExpressRequest): RequestInit {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
      continue;
    }
    headers.set(key, value);
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    return { method: req.method, headers };
  }

  return { method: req.method, headers, body: typeof req.body === 'string' ? req.body : '' };
}

function wrapRoute(handler: SimpleRouteHandler | undefined, baseUrlProvider: () => string) {
  return async (req: ExpressRequest, res: express.Response, next: express.NextFunction) => {
    if (!handler) {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const request = new Request(new URL(req.originalUrl || req.url, baseUrlProvider()), {
        ...buildRequestInit(req),
      });
      const response = await handler(request);
      res.status(response.status);
      for (const [key, value] of response.headers.entries()) {
        res.setHeader(key, value);
      }
      res.send(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      next(error);
    }
  };
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function startMiniStudioHarness(): Promise<MiniStudioHarness> {
  const previousEnv = { ...process.env };
  const mongod = await MongoMemoryServer.create({
    binary: { version: MONGOMS_VERSION },
  });
  const mongoUri = mongod.getUri();

  process.env.NODE_ENV = 'test';
  process.env.ENABLE_DEV_LOGIN = 'true';
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY;
  process.env.ENCRYPTION_ENABLED = 'true';
  process.env.MONGODB_URL = mongoUri;
  process.env.MONGODB_URI = mongoUri;
  process.env.MONGODB_MANAGED = 'false';
  process.env.REDIS_ENABLED = 'false';

  const [devLogin, createWorkspace, tenantRetention] = await Promise.all([
    import('../app/api/auth/dev-login/route'),
    import('../app/api/auth/create-workspace/route'),
    import('../app/api/tenant/retention/route'),
  ]);

  const app: Express = express();
  app.use(express.text({ type: '*/*', limit: '1mb' }));

  let baseUrl = 'http://127.0.0.1:0';
  app.post(
    '/api/auth/dev-login',
    wrapRoute(devLogin.POST, () => baseUrl),
  );
  app.post(
    '/api/auth/create-workspace',
    wrapRoute(createWorkspace.POST, () => baseUrl),
  );
  app.get(
    '/api/tenant/retention',
    wrapRoute(tenantRetention.GET, () => baseUrl),
  );
  app.patch(
    '/api/tenant/retention',
    wrapRoute(tenantRetention.PATCH, () => baseUrl),
  );

  const server = await new Promise<http.Server>((resolve) => {
    const candidate = http.createServer(app);
    candidate.listen(0, '127.0.0.1', () => resolve(candidate));
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  process.env.FRONTEND_URL = baseUrl;

  return {
    baseUrl,
    async close() {
      await closeServer(server);
      await mongoose.disconnect();
      await mongod.stop();
      process.env = previousEnv;
    },
  };
}

async function requestJson<T>(
  harness: MiniStudioHarness,
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

async function devLogin(harness: MiniStudioHarness): Promise<DevLoginResponse> {
  const email = `eval-retention.${randomSuffix()}@e2e-smoke.test`;
  const response = await requestJson<DevLoginResponse>(harness, '/api/auth/dev-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name: email.split('@')[0] }),
  });

  expect(response.status).toBe(200);
  return response.body;
}

async function createWorkspace(
  harness: MiniStudioHarness,
  token: string,
): Promise<CreateWorkspaceResponse> {
  const response = await requestJson<CreateWorkspaceResponse>(
    harness,
    '/api/auth/create-workspace',
    {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ name: `Eval Retention ${randomSuffix()}` }),
    },
  );

  expect(response.status).toBe(200);
  return response.body;
}

async function updateTenantRole(tenantId: string, userId: string, role: string): Promise<void> {
  const { TenantMember } = await import('@agent-platform/database/models');
  const result = await TenantMember.updateOne({ tenantId, userId }, { $set: { role } });
  expect(result.matchedCount).toBe(1);
}

describe.sequential('Studio eval retention API e2e', () => {
  let harness: MiniStudioHarness;

  beforeAll(async () => {
    harness = await startMiniStudioHarness();
  });

  afterAll(async () => {
    if (harness) {
      await harness.close();
    }
  });

  test('lets a tenant owner read defaults and persist effective retention overrides', async () => {
    const login = await devLogin(harness);
    const workspace = await createWorkspace(harness, login.accessToken);

    const initial = await requestJson<TenantRetentionResponse>(harness, '/api/tenant/retention', {
      method: 'GET',
      headers: authHeaders(workspace.accessToken),
    });

    expect(initial.status).toBe(200);
    expect(initial.body.data.defaults.evalConversationsTtlDays).toBe(730);
    expect(initial.body.data.effective.syntheticTtlDays).toBe(30);

    const updated = await requestJson<TenantRetentionResponse>(harness, '/api/tenant/retention', {
      method: 'PATCH',
      headers: authHeaders(workspace.accessToken),
      body: JSON.stringify({
        evalConversationsTtlDays: 120,
        evalScoresTtlDays: 90,
        productionScoresTtlDays: 180,
        syntheticTtlDays: 14,
        hardDeleteExpiredRuns: true,
        scrubPiiOnStore: true,
      }),
    });

    expect(updated.status).toBe(200);
    expect(updated.body.data.effective).toMatchObject({
      evalConversationsTtlDays: 120,
      evalScoresTtlDays: 90,
      productionScoresTtlDays: 180,
      syntheticTtlDays: 14,
      hardDeleteExpiredRuns: true,
      scrubPiiOnStore: true,
    });

    const readBack = await requestJson<TenantRetentionResponse>(harness, '/api/tenant/retention', {
      method: 'GET',
      headers: authHeaders(workspace.accessToken),
    });

    expect(readBack.status).toBe(200);
    expect(readBack.body.data.effective.evalConversationsTtlDays).toBe(120);
    expect(readBack.body.data.effective.syntheticTtlDays).toBe(14);
  });

  test('forbids tenant admins from mutating retention while keeping read access available', async () => {
    const login = await devLogin(harness);
    const workspace = await createWorkspace(harness, login.accessToken);
    await updateTenantRole(workspace.workspace.id, login.user.id, 'ADMIN');

    const readAsAdmin = await requestJson<TenantRetentionResponse>(
      harness,
      '/api/tenant/retention',
      {
        method: 'GET',
        headers: authHeaders(workspace.accessToken),
      },
    );

    expect(readAsAdmin.status).toBe(200);

    const denied = await requestJson<ErrorResponse>(harness, '/api/tenant/retention', {
      method: 'PATCH',
      headers: authHeaders(workspace.accessToken),
      body: JSON.stringify({
        evalConversationsTtlDays: 120,
        evalScoresTtlDays: 90,
        syntheticTtlDays: 14,
      }),
    });

    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('Insufficient permissions');
  });

  test.each(['OWNER', 'ADMIN', 'OPERATOR', 'MEMBER', 'VIEWER', 'AUDITOR'])(
    'allows %s to read retention settings',
    async (role) => {
      const login = await devLogin(harness);
      const workspace = await createWorkspace(harness, login.accessToken);
      await updateTenantRole(workspace.workspace.id, login.user.id, role);

      const response = await requestJson<TenantRetentionResponse>(
        harness,
        '/api/tenant/retention',
        {
          method: 'GET',
          headers: authHeaders(workspace.accessToken),
        },
      );

      expect(response.status).toBe(200);
      expect(response.body.data.defaults.evalConversationsTtlDays).toBe(730);
    },
  );
});

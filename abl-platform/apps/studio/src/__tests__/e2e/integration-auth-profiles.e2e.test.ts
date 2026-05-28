// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CLICKHOUSE_PORT,
  DEFAULT_MONGODB_PORT,
  DEFAULT_REDIS_PORT,
} from '@agent-platform/config/constants';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { NextRequest } from 'next/server';
import { resetSharedMongoDatabase } from './_test-infra/reset-mongo';

// Next.js uses the `server-only` sentinel package to fail loudly when a
// server module is imported into a client bundle. Vitest runs outside
// Next's runtime, so any route handler this suite imports would throw
// at module-load. Stubbing the sentinel is the only way to dispatch route
// handlers via callStudioRoute without booting a full Next server.
// `server-only` is a third-party package, allowed by CLAUDE.md
// "Test Architecture" rule 5 (external packages only).
vi.mock('server-only', () => ({}));

const TEST_TIMEOUT_MS = 120_000;
const SUITE_HOOK_TIMEOUT_MS = 300_000;
const MEMORY_MONGO_VERSION = process.env.MONGOMS_VERSION || '7.0.20';
const MEMORY_MONGO_LAUNCH_TIMEOUT_MS = 30_000;
const SHARED_DOCKER_MONGODB_DATABASE = 'integ_auth_profiles_e2e';
const SHARED_DOCKER_MONGODB_URL = `mongodb://abl_admin:abl_dev_password@127.0.0.1:${DEFAULT_MONGODB_PORT}/${SHARED_DOCKER_MONGODB_DATABASE}?authSource=admin&directConnection=true`;
const SHARED_DOCKER_REDIS_URL = `redis://:localdev@127.0.0.1:${DEFAULT_REDIS_PORT}`;
const SHARED_DOCKER_CLICKHOUSE_URL = `http://127.0.0.1:${DEFAULT_CLICKHOUSE_PORT}`;
const SHARED_DOCKER_RESTATE_INGRESS_URL = 'http://127.0.0.1:8091';
const SHARED_DOCKER_RESTATE_ADMIN_URL = 'http://127.0.0.1:9070';

const PROJECT_NAME = 'Integration Auth Profiles E2E';
const DEV_LOGIN_EMAIL = 'integ1@e2e-smoke.test';
const DEV_LOGIN_EMAIL_2 = 'integ2@e2e-smoke.test';
const CROSS_TENANT_EMAIL = 'cross@other-tenant.test';

const REDIS_SERVER_BINARY_CANDIDATES = [
  process.env['REDIS_SERVER_BIN'],
  '/opt/homebrew/bin/redis-server',
  '/usr/local/bin/redis-server',
  'redis-server',
].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

interface StudioRouteModule {
  GET?: (request: NextRequest, context: RouteContext) => Promise<Response>;
  POST?: (request: NextRequest, context: RouteContext) => Promise<Response>;
  PUT?: (request: NextRequest, context: RouteContext) => Promise<Response>;
  DELETE?: (request: NextRequest, context: RouteContext) => Promise<Response>;
}

interface RouteContext {
  params: Promise<Record<string, string>>;
}

interface StudioModules {
  devLogin: StudioRouteModule;
  projects: StudioRouteModule;
  authProfiles: StudioRouteModule;
  authProfileDetail: StudioRouteModule;
  providers: StudioRouteModule;
  connectors: StudioRouteModule;
  workspaceProviders: StudioRouteModule;
  workspaceAuthProfiles: StudioRouteModule;
  workspaceAuthProfileDetail: StudioRouteModule;
  workspaceValidate: StudioRouteModule;
  projectValidate: StudioRouteModule;
  oauthInitiate: StudioRouteModule;
}

interface TestState {
  accessToken: string;
  tenantId: string;
  projectId: string;
  user2AccessToken: string;
  user2TenantId: string;
}

let mongoServer: MongoMemoryServer;
let studioModules: StudioModules;
let redisPort = 0;
let redisProcess: ChildProcessWithoutNullStreams | null = null;
let useSharedDockerInfra = false;

const state: TestState = {
  accessToken: '',
  tenantId: '',
  projectId: '',
  user2AccessToken: '',
  user2TenantId: '',
};

// Tracks profile IDs created during tests for cross-test references
const createdProfiles: Record<string, string> = {};

function debugStep(message: string): void {
  if (process.env['INTEG_AUTH_E2E_DEBUG'] === 'true') {
    process.stderr.write(`[integ-auth-e2e] ${message}\n`);
  }
}

async function callStudioRoute(
  handler: (request: NextRequest, context: RouteContext) => Promise<Response>,
  options: {
    path: string;
    token?: string;
    params?: Record<string, string>;
    body?: unknown;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  },
): Promise<{ status: number; json: Record<string, any> }> {
  const method = options.method ?? 'GET';
  const headers = new Headers();
  if (options.token) {
    headers.set('Authorization', `Bearer ${options.token}`);
  }
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }

  const request = new NextRequest(new URL(options.path, 'http://localhost:3000'), {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  debugStep(`studio route: ${method} ${options.path}`);
  const response = await handler(request, {
    params: Promise.resolve(options.params ?? {}),
  });
  debugStep(`studio route complete: ${response.status} ${options.path}`);

  return {
    status: response.status,
    json: (await response.json()) as Record<string, any>,
  };
}

function setTestEnvironment(params: {
  mongoDatabase: string;
  mongoUri: string;
  redisUrl: string;
  clickhouseUrl?: string;
  restateAdminUrl?: string;
  restateIngressUrl?: string;
}): void {
  (process.env as Record<string, string | undefined>)['NODE_ENV'] = 'test';
  process.env['HOST'] = '127.0.0.1';
  process.env['FRONTEND_URL'] = 'http://127.0.0.1:5173';
  process.env['JWT_SECRET'] = 'integ-auth-e2e-jwt-secret-0123456789';
  process.env['ENABLE_DEV_LOGIN'] = 'true';
  process.env['ENCRYPTION_ENABLED'] = 'true';
  process.env['ENCRYPTION_MASTER_KEY'] = 'ab'.repeat(32);
  process.env['AUTH_PROFILE_ENABLED'] = 'true';
  process.env['REDIS_ENABLED'] = 'true';
  process.env['REDIS_URL'] = params.redisUrl;
  process.env['FEATURE_LIVEKIT_ENABLED'] = 'false';
  process.env['MONGODB_URL'] = params.mongoUri;
  process.env['MONGODB_DATABASE'] = params.mongoDatabase;
  process.env['MONGODB_MANAGED'] = 'true';
  process.env['MONGODB_MIN_POOL_SIZE'] = '1';
  process.env['MONGODB_MAX_POOL_SIZE'] = '5';
  process.env['CLICKHOUSE_URL'] = params.clickhouseUrl ?? '';
  process.env['RESTATE_INGRESS_URL'] = params.restateIngressUrl ?? '';
  process.env['RESTATE_ADMIN_URL'] = params.restateAdminUrl ?? '';
  process.env['EVENT_KAFKA_ENABLED'] = 'false';
  process.env['SANDBOX_BACKEND'] = 'mock';
  process.env['SMTP_PORT'] = '';
  process.env['EMAIL_FROM_ADDRESS'] = '';
  process.env['NEXT_PUBLIC_APP_URL'] = 'http://localhost:3000';
  process.env['AUTH_SDK_SESSION_SIGNING_SECRET'] = 's'.repeat(64);
  process.env['AUTH_SDK_BOOTSTRAP_SIGNING_SECRET'] = 'b'.repeat(64);
}

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to reserve port'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function resolveRedisServerBinary(): string {
  for (const candidate of REDIS_SERVER_BINARY_CANDIDATES) {
    if (!candidate.includes('/') || existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error('redis-server binary not found. Set REDIS_SERVER_BIN to a valid path.');
}

function startRedisProcess(port: number): ChildProcessWithoutNullStreams {
  const redisEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? REPO_ROOT,
  };

  if (process.env['TMPDIR']) {
    redisEnv['TMPDIR'] = process.env['TMPDIR'];
  }

  const child = spawn(
    resolveRedisServerBinary(),
    ['--save', '', '--appendonly', 'no', '--bind', '127.0.0.1', '--port', String(port)],
    {
      cwd: REPO_ROOT,
      env: redisEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  if (process.env['INTEG_AUTH_E2E_DEBUG'] === 'true') {
    child.stdout.on('data', (chunk: Buffer | string) => {
      process.stdout.write(`[redis:stdout] ${chunk.toString()}`);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      process.stderr.write(`[redis:stderr] ${chunk.toString()}`);
    });
  }

  return child;
}

async function waitForRedis(port: number): Promise<void> {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    if (await pingRedis(port)) {
      return;
    }
    await delay(100);
  }

  throw new Error(`Timed out waiting for Redis on port ${port}`);
}

async function canConnectTcp(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;

    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(1000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
  });
}

async function shouldUseSharedDockerInfra(): Promise<boolean> {
  const [mongoReady, redisReady] = await Promise.all([
    canConnectTcp(DEFAULT_MONGODB_PORT),
    pingRedis(DEFAULT_REDIS_PORT),
  ]);

  return mongoReady && redisReady;
}

async function pingRedis(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;

    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.write('*1\r\n$4\r\nPING\r\n');
    });
    socket.on('data', (chunk: Buffer | string) => {
      if (chunk.toString().includes('PONG')) {
        finish(true);
      }
    });
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
  });
}

async function stopRedisProcess(child: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!child || child.exitCode !== null) {
    return;
  }

  child.kill('SIGTERM');

  await Promise.race([
    new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    }),
    delay(5_000).then(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }),
  ]);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedApiState(): Promise<void> {
  debugStep('seed: dev login user1');
  const login1 = await callStudioRoute(studioModules.devLogin.POST!, {
    path: '/api/auth/dev-login',
    method: 'POST',
    body: { email: DEV_LOGIN_EMAIL, name: 'Integ User 1' },
  });
  expect(login1.status).toBe(200);
  state.accessToken = String(login1.json.accessToken);

  debugStep('seed: create project');
  const project = await callStudioRoute(studioModules.projects.POST!, {
    path: '/api/projects',
    method: 'POST',
    token: state.accessToken,
    body: {
      name: PROJECT_NAME,
      description: 'E2E coverage for integration auth profiles',
    },
  });
  expect(project.status).toBe(201);
  state.projectId = String(project.json.project.id);
  state.tenantId = String(project.json.project.tenantId);

  debugStep('seed: dev login user2 (same tenant)');
  const login2 = await callStudioRoute(studioModules.devLogin.POST!, {
    path: '/api/auth/dev-login',
    method: 'POST',
    body: { email: DEV_LOGIN_EMAIL_2, name: 'Integ User 2' },
  });
  expect(login2.status).toBe(200);
  state.user2AccessToken = String(login2.json.accessToken);
  // user2 is in the same tenant due to the e2e-smoke.test domain
  state.user2TenantId = state.tenantId;
}

describe.sequential(
  'Integration Auth Profiles E2E',
  () => {
    beforeAll(async () => {
      useSharedDockerInfra = await shouldUseSharedDockerInfra();

      if (useSharedDockerInfra) {
        debugStep('using shared docker infra');
        setTestEnvironment({
          mongoDatabase: SHARED_DOCKER_MONGODB_DATABASE,
          mongoUri: SHARED_DOCKER_MONGODB_URL,
          redisUrl: SHARED_DOCKER_REDIS_URL,
          clickhouseUrl: SHARED_DOCKER_CLICKHOUSE_URL,
          restateIngressUrl: SHARED_DOCKER_RESTATE_INGRESS_URL,
          restateAdminUrl: SHARED_DOCKER_RESTATE_ADMIN_URL,
        });
        debugStep('resetting external mongo database');
        await resetSharedMongoDatabase(SHARED_DOCKER_MONGODB_URL, SHARED_DOCKER_MONGODB_DATABASE);
      } else {
        debugStep('shared docker infra unavailable; falling back to local test infra');
        redisPort = await reservePort();

        debugStep('starting in-memory mongo');
        mongoServer = await MongoMemoryServer.create({
          binary: { version: MEMORY_MONGO_VERSION },
          instance: { launchTimeout: MEMORY_MONGO_LAUNCH_TIMEOUT_MS },
        });

        debugStep('setting test environment');
        setTestEnvironment({
          mongoDatabase: 'integ_auth_profiles_e2e',
          mongoUri: mongoServer.getUri('integ_auth_profiles_e2e'),
          redisUrl: `redis://127.0.0.1:${redisPort}`,
        });
      }

      vi.resetModules();

      if (!useSharedDockerInfra) {
        debugStep(`starting redis on ${redisPort}`);
        redisProcess = startRedisProcess(redisPort);
        await waitForRedis(redisPort);
        debugStep('redis ready');
      }

      debugStep('initializing studio redis client');
      const { loadConfig } = await import('../../config');
      await loadConfig();
      const { initializeRedis } = await import('../../lib/redis-client');
      await initializeRedis();

      debugStep('ensuring DB connection');
      const { ensureDb } = await import('../../lib/ensure-db');
      await ensureDb();

      debugStep('loading studio route modules');
      studioModules = {
        devLogin:
          (await import('../../app/api/auth/dev-login/route')) as unknown as StudioRouteModule,
        projects: (await import('../../app/api/projects/route')) as unknown as StudioRouteModule,
        authProfiles:
          (await import('../../app/api/projects/[id]/auth-profiles/route')) as unknown as StudioRouteModule,
        authProfileDetail:
          (await import('../../app/api/projects/[id]/auth-profiles/[profileId]/route')) as unknown as StudioRouteModule,
        providers:
          (await import('../../app/api/projects/[id]/auth-profiles/providers/route')) as unknown as StudioRouteModule,
        connectors:
          (await import('../../app/api/projects/[id]/connectors/route')) as unknown as StudioRouteModule,
        workspaceProviders:
          (await import('../../app/api/auth-profiles/providers/route')) as unknown as StudioRouteModule,
        workspaceAuthProfiles:
          (await import('../../app/api/auth-profiles/route')) as unknown as StudioRouteModule,
        workspaceAuthProfileDetail:
          (await import('../../app/api/auth-profiles/[profileId]/route')) as unknown as StudioRouteModule,
        workspaceValidate:
          (await import('../../app/api/auth-profiles/[profileId]/validate/route')) as unknown as StudioRouteModule,
        projectValidate:
          (await import('../../app/api/projects/[id]/auth-profiles/[profileId]/validate/route')) as unknown as StudioRouteModule,
        oauthInitiate:
          (await import('../../app/api/projects/[id]/auth-profiles/oauth/initiate/route')) as unknown as StudioRouteModule,
      };

      debugStep('seeding API state');
      await seedApiState();
      debugStep('seed complete');
    }, SUITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      const { disconnectRedis } = await import('../../lib/redis-client');
      await disconnectRedis();

      if (useSharedDockerInfra) {
        const { disconnectDatabase } = await import('../../db');
        await disconnectDatabase();
        await resetSharedMongoDatabase(SHARED_DOCKER_MONGODB_URL, SHARED_DOCKER_MONGODB_DATABASE);
      } else {
        await stopRedisProcess(redisProcess);
        redisProcess = null;
        await mongoServer?.stop();
      }
    }, SUITE_HOOK_TIMEOUT_MS);

    // ─── E2E-1: Create Preconfigured OAuth Integration Profile (Gmail) ───

    it(
      'E2E-1: creates a preconfigured OAuth integration profile for Gmail',
      async () => {
        const res = await callStudioRoute(studioModules.authProfiles.POST!, {
          path: `/api/projects/${state.projectId}/auth-profiles`,
          method: 'POST',
          token: state.accessToken,
          params: { id: state.projectId },
          body: {
            name: 'Gmail E2E',
            authType: 'oauth2_app',
            scope: 'project',
            projectId: state.projectId,
            connector: 'gmail',
            usageMode: 'preflight',
            config: {
              authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
              tokenUrl: 'https://oauth2.googleapis.com/token',
              defaultScopes: ['gmail.send'],
            },
            secrets: {
              clientId: 'e2e-client-id',
              clientSecret: 'e2e-secret',
            },
          },
        });

        expect(res.status).toBe(201);
        expect(res.json.success).toBe(true);
        expect(res.json.data.connector).toBe('gmail');
        expect(res.json.data.authType).toBe('oauth2_app');
        expect(res.json.data.name).toBe('Gmail E2E');

        createdProfiles['gmail_e2e'] = String(res.json.data.id ?? res.json.data._id);
      },
      TEST_TIMEOUT_MS,
    );

    // ─── E2E-2: Provider Endpoint Returns Enriched Catalog ───────────────

    it(
      'E2E-2: provider endpoint returns enriched catalog with current auth-aware connector mappings',
      async () => {
        const res = await callStudioRoute(studioModules.providers.GET!, {
          path: `/api/projects/${state.projectId}/auth-profiles/providers`,
          method: 'GET',
          token: state.accessToken,
          params: { id: state.projectId },
        });

        expect(res.status).toBe(200);
        expect(res.json.success).toBe(true);
        expect(Array.isArray(res.json.data)).toBe(true);

        const gmailEntry = (res.json.data as any[]).find((p: any) => p.connectorName === 'gmail');
        expect(gmailEntry).toBeDefined();
        expect(gmailEntry.profileCount).toBeGreaterThanOrEqual(1);
        expect(gmailEntry.oauth2?.authorizationUrl).toBeDefined();
        expect(gmailEntry.oauth2?.tokenUrl).toBeDefined();

        const shopifyEntry = (res.json.data as any[]).find(
          (p: any) => p.connectorName === 'shopify',
        );
        expect(shopifyEntry).toBeDefined();
        expect(shopifyEntry.availableAuthTypes).toEqual([
          'oauth2',
          'oauth2_client_credentials',
          'api_key',
        ]);
        expect(shopifyEntry.authPrefill?.oauth2_client_credentials).toEqual({
          tokenUrl: 'https://${connectionConfig.subdomain}.myshopify.com/admin/oauth/access_token',
          scopes: [],
        });

        const powerBiEntry = (res.json.data as any[]).find(
          (p: any) => p.connectorName === 'microsoft-power-bi',
        );
        expect(powerBiEntry).toBeDefined();
        expect(powerBiEntry.availableAuthTypes).toEqual(['azure_ad']);
        expect(powerBiEntry.authPrefill?.azure_ad).toEqual({
          endpoint: 'https://login.microsoftonline.com',
          resource: 'https://analysis.windows.net/powerbi/api',
        });

        const businessCentralEntry = (res.json.data as any[]).find(
          (p: any) => p.connectorName === 'microsoft-dynamics-365-business-central',
        );
        expect(businessCentralEntry).toBeDefined();
        expect(businessCentralEntry.availableAuthTypes).toEqual(['oauth2_client_credentials']);
        expect(businessCentralEntry.authPrefill?.oauth2_client_credentials).toEqual({
          tokenUrl:
            'https://login.microsoftonline.com/${connectionConfig.tenantId}/oauth2/v2.0/token',
        });

        const sqsEntry = (res.json.data as any[]).find(
          (p: any) => p.connectorName === 'amazon-sqs',
        );
        expect(sqsEntry).toBeDefined();
        expect(sqsEntry.availableAuthTypes).toEqual(['aws_iam']);
        expect(sqsEntry.authPrefill?.aws_iam).toEqual({ service: 'sqs' });
      },
      TEST_TIMEOUT_MS,
    );

    // ─── E2E-3: Visibility Filtering ─────────────────────────────────────

    it(
      'E2E-3: personal profiles are hidden from other users',
      async () => {
        // Step 1: Create personal OAuth profile as user1
        const createRes = await callStudioRoute(studioModules.authProfiles.POST!, {
          path: `/api/projects/${state.projectId}/auth-profiles`,
          method: 'POST',
          token: state.accessToken,
          params: { id: state.projectId },
          body: {
            name: 'Personal Gmail',
            authType: 'oauth2_app',
            scope: 'project',
            projectId: state.projectId,
            connector: 'gmail',
            visibility: 'personal',
            config: {
              authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
              tokenUrl: 'https://oauth2.googleapis.com/token',
              defaultScopes: ['gmail.send'],
            },
            secrets: {
              clientId: 'personal-client-id',
              clientSecret: 'personal-secret',
            },
          },
        });
        expect(createRes.status).toBe(201);
        createdProfiles['personal_gmail'] = String(
          createRes.json.data.id ?? createRes.json.data._id,
        );

        // Step 2: user2 should NOT see the personal profile in providers
        const user2Providers = await callStudioRoute(studioModules.providers.GET!, {
          path: `/api/projects/${state.projectId}/auth-profiles/providers`,
          method: 'GET',
          token: state.user2AccessToken,
          params: { id: state.projectId },
        });
        expect(user2Providers.status).toBe(200);
        const user2Gmail = (user2Providers.json.data as any[]).find(
          (p: any) => p.connectorName === 'gmail',
        );
        // user2 should not see the personal profile in the profiles list
        if (user2Gmail?.profiles) {
          const personalInUser2 = (user2Gmail.profiles as any[]).find(
            (p: any) => p.name === 'Personal Gmail',
          );
          expect(personalInUser2).toBeUndefined();
        }

        // Step 3: user1 SHOULD see the personal profile in providers
        const user1Providers = await callStudioRoute(studioModules.providers.GET!, {
          path: `/api/projects/${state.projectId}/auth-profiles/providers`,
          method: 'GET',
          token: state.accessToken,
          params: { id: state.projectId },
        });
        expect(user1Providers.status).toBe(200);
        const user1Gmail = (user1Providers.json.data as any[]).find(
          (p: any) => p.connectorName === 'gmail',
        );
        expect(user1Gmail).toBeDefined();
        if (user1Gmail?.profiles) {
          const personalInUser1 = (user1Gmail.profiles as any[]).find(
            (p: any) => p.name === 'Personal Gmail',
          );
          expect(personalInUser1).toBeDefined();
        }
      },
      TEST_TIMEOUT_MS,
    );

    // ─── E2E-4: Delete Profile Cascades to Bridge ConnectorConnection ────

    it(
      'E2E-4: delete profile cascades to bridge ConnectorConnection',
      async () => {
        // Step 1: Create a profile with connector
        const createRes = await callStudioRoute(studioModules.authProfiles.POST!, {
          path: `/api/projects/${state.projectId}/auth-profiles`,
          method: 'POST',
          token: state.accessToken,
          params: { id: state.projectId },
          body: {
            name: 'Stripe-Delete-Test',
            authType: 'api_key',
            scope: 'project',
            projectId: state.projectId,
            connector: 'stripe',
            config: { headerName: 'Authorization' },
            secrets: { apiKey: 'sk_test_xxx' },
          },
        });
        expect(createRes.status).toBe(201);
        const profileId = String(createRes.json.data.id ?? createRes.json.data._id);

        // Step 2: Verify it appears in providers
        const beforeProviders = await callStudioRoute(studioModules.providers.GET!, {
          path: `/api/projects/${state.projectId}/auth-profiles/providers`,
          method: 'GET',
          token: state.accessToken,
          params: { id: state.projectId },
        });
        expect(beforeProviders.status).toBe(200);
        const stripeBefore = (beforeProviders.json.data as any[]).find(
          (p: any) => p.connectorName === 'stripe',
        );
        expect(stripeBefore).toBeDefined();
        expect(stripeBefore.profileCount).toBeGreaterThanOrEqual(1);
        const stripeCountBefore = stripeBefore.profileCount;

        // Step 3: DELETE the profile
        const deleteRes = await callStudioRoute(studioModules.authProfileDetail.DELETE!, {
          path: `/api/projects/${state.projectId}/auth-profiles/${profileId}`,
          method: 'DELETE',
          token: state.accessToken,
          params: { id: state.projectId, profileId },
        });
        expect(deleteRes.status).toBe(200);
        expect(deleteRes.json.success).toBe(true);

        // Step 4: Verify it's gone from providers
        const afterProviders = await callStudioRoute(studioModules.providers.GET!, {
          path: `/api/projects/${state.projectId}/auth-profiles/providers`,
          method: 'GET',
          token: state.accessToken,
          params: { id: state.projectId },
        });
        expect(afterProviders.status).toBe(200);
        const stripeAfter = (afterProviders.json.data as any[]).find(
          (p: any) => p.connectorName === 'stripe',
        );
        // Count should be less than before (or stripe entry may be gone)
        if (stripeAfter) {
          expect(stripeAfter.profileCount).toBeLessThan(stripeCountBefore);
        }
      },
      TEST_TIMEOUT_MS,
    );

    // ─── E2E-5: Workspace Profile Inheritance at Project Level ───────────

    it(
      'E2E-5: workspace-scoped profile appears in project provider listing',
      async () => {
        // Step 1: Create workspace-scoped profile via workspace route
        const createRes = await callStudioRoute(studioModules.workspaceAuthProfiles.POST!, {
          path: '/api/auth-profiles',
          method: 'POST',
          token: state.accessToken,
          body: {
            name: 'Workspace Slack',
            authType: 'oauth2_app',
            scope: 'tenant',
            projectId: null,
            connector: 'slack',
            config: {
              authorizationUrl: 'https://slack.com/oauth/v2/authorize',
              tokenUrl: 'https://slack.com/api/oauth.v2.access',
              defaultScopes: ['chat:write'],
            },
            secrets: {
              clientId: 'ws-id',
              clientSecret: 'ws-secret',
            },
          },
        });
        expect(createRes.status).toBe(201);
        createdProfiles['workspace_slack'] = String(
          createRes.json.data.id ?? createRes.json.data._id,
        );

        // Step 2: Verify it appears in project-level providers
        const providersRes = await callStudioRoute(studioModules.providers.GET!, {
          path: `/api/projects/${state.projectId}/auth-profiles/providers`,
          method: 'GET',
          token: state.accessToken,
          params: { id: state.projectId },
        });
        expect(providersRes.status).toBe(200);
        const slackEntry = (providersRes.json.data as any[]).find(
          (p: any) => p.connectorName === 'slack',
        );
        expect(slackEntry).toBeDefined();
        expect(slackEntry.profileCount).toBeGreaterThanOrEqual(1);
        // Verify the workspace profile is in the profiles list
        if (slackEntry.profiles) {
          const wsProfile = (slackEntry.profiles as any[]).find(
            (p: any) => p.name === 'Workspace Slack',
          );
          expect(wsProfile).toBeDefined();
        }
      },
      TEST_TIMEOUT_MS,
    );

    // ─── E2E-6: Project Access Isolation Returns 404 ─────────────────────

    it(
      'E2E-6: non-existent project returns 404 from providers endpoint (project access isolation)',
      async () => {
        // Use a project ID that does not exist — requireProjectAccess should
        // return 404 (not 403) to avoid leaking project existence.
        // NOTE: True cross-tenant isolation testing requires multi-tenant
        // infrastructure (separate tenants). In the E2E test env, dev-login
        // auto-attaches all users to the same e2e-workspace tenant.
        const fakeProjectId = '000000000000000000000099';
        const res = await callStudioRoute(studioModules.providers.GET!, {
          path: `/api/projects/${fakeProjectId}/auth-profiles/providers`,
          method: 'GET',
          token: state.accessToken,
          params: { id: fakeProjectId },
        });

        // requireProjectAccess returns 404 for non-existent projects
        expect(res.status).toBe(404);
      },
      TEST_TIMEOUT_MS,
    );

    // ─── E2E-7: API Key Integration Profile (Stripe) ────────────────────

    it(
      'E2E-7: creates an API key integration profile for Stripe',
      async () => {
        const res = await callStudioRoute(studioModules.authProfiles.POST!, {
          path: `/api/projects/${state.projectId}/auth-profiles`,
          method: 'POST',
          token: state.accessToken,
          params: { id: state.projectId },
          body: {
            name: 'Stripe Prod',
            authType: 'api_key',
            scope: 'project',
            projectId: state.projectId,
            connector: 'stripe',
            config: { headerName: 'Authorization' },
            secrets: { apiKey: 'sk_live_test' },
          },
        });

        expect(res.status).toBe(201);
        expect(res.json.success).toBe(true);
        expect(res.json.data.connector).toBe('stripe');
        expect(res.json.data.authType).toBe('api_key');

        // Secrets must NOT be exposed in the response (security: redaction check)
        expect(res.json.data.encryptedSecrets).toBeUndefined();
        expect(res.json.data.previousEncryptedSecrets).toBeUndefined();

        createdProfiles['stripe_prod'] = String(res.json.data.id ?? res.json.data._id);
      },
      TEST_TIMEOUT_MS,
    );

    // ─── E2E-8: Usage Mode Validation Rejects Invalid Combinations ──────

    it(
      'E2E-8: rejects invalid usage mode for api_key (jit not allowed)',
      async () => {
        const res = await callStudioRoute(studioModules.authProfiles.POST!, {
          path: `/api/projects/${state.projectId}/auth-profiles`,
          method: 'POST',
          token: state.accessToken,
          params: { id: state.projectId },
          body: {
            name: 'Bad Mode',
            authType: 'api_key',
            scope: 'project',
            projectId: state.projectId,
            connector: 'stripe',
            usageMode: 'jit',
            config: { headerName: 'X-Key' },
            secrets: { apiKey: 'xxx' },
          },
        });

        expect(res.status).toBe(400);
      },
      TEST_TIMEOUT_MS,
    );

    // ─── E2E-9: OAuth Initiate with authorizationParams ─────────────────

    it(
      'E2E-9: OAuth initiate includes custom authorizationParams in URL',
      async () => {
        // Step 1: Create oauth2_app profile with authorizationParams
        const createRes = await callStudioRoute(studioModules.authProfiles.POST!, {
          path: `/api/projects/${state.projectId}/auth-profiles`,
          method: 'POST',
          token: state.accessToken,
          params: { id: state.projectId },
          body: {
            name: 'Gmail-AuthParams',
            authType: 'oauth2_app',
            scope: 'project',
            projectId: state.projectId,
            connector: 'gmail',
            config: {
              authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
              tokenUrl: 'https://oauth2.googleapis.com/token',
              defaultScopes: ['gmail.send'],
              authorizationParams: {
                access_type: 'offline',
                prompt: 'consent',
              },
            },
            secrets: {
              clientId: 'ap-client',
              clientSecret: 'ap-secret',
            },
          },
        });
        expect(createRes.status).toBe(201);
        const profileId = String(createRes.json.data.id ?? createRes.json.data._id);

        // Step 2: Initiate OAuth flow
        const initiateRes = await callStudioRoute(studioModules.oauthInitiate.POST!, {
          path: `/api/projects/${state.projectId}/auth-profiles/oauth/initiate`,
          method: 'POST',
          token: state.accessToken,
          params: { id: state.projectId },
          body: {
            connectorName: 'gmail',
            authProfileId: profileId,
          },
        });

        expect(initiateRes.status).toBe(200);
        expect(initiateRes.json.success).toBe(true);
        const authUrl = initiateRes.json.data.authUrl as string;
        expect(authUrl).toContain('access_type=offline');
        expect(authUrl).toContain('prompt=consent');
        expect(authUrl).toContain('client_id=ap-client');
      },
      TEST_TIMEOUT_MS,
    );

    // ─── E2E-10: OAuth Initiate with connectionConfig URL Templates ─────

    it(
      'E2E-10: OAuth initiate works with fully-resolved template URLs',
      async () => {
        // Step 1: Create oauth2_app profile with template-free URLs (already resolved)
        const createRes = await callStudioRoute(studioModules.authProfiles.POST!, {
          path: `/api/projects/${state.projectId}/auth-profiles`,
          method: 'POST',
          token: state.accessToken,
          params: { id: state.projectId },
          body: {
            name: 'SF-Template',
            authType: 'oauth2_app',
            scope: 'project',
            projectId: state.projectId,
            connector: 'salesforce',
            config: {
              authorizationUrl: 'https://mycompany.salesforce.com/services/oauth2/authorize',
              tokenUrl: 'https://mycompany.salesforce.com/services/oauth2/token',
              defaultScopes: ['api'],
            },
            secrets: {
              clientId: 'sf-id',
              clientSecret: 'sf-secret',
            },
          },
        });
        expect(createRes.status).toBe(201);
        const profileId = String(createRes.json.data.id ?? createRes.json.data._id);

        // Step 2: Initiate OAuth flow
        const initiateRes = await callStudioRoute(studioModules.oauthInitiate.POST!, {
          path: `/api/projects/${state.projectId}/auth-profiles/oauth/initiate`,
          method: 'POST',
          token: state.accessToken,
          params: { id: state.projectId },
          body: {
            connectorName: 'salesforce',
            authProfileId: profileId,
          },
        });

        expect(initiateRes.status).toBe(200);
        expect(initiateRes.json.success).toBe(true);
        const authUrl = initiateRes.json.data.authUrl as string;
        expect(authUrl).toMatch(/^https:\/\/mycompany\.salesforce\.com/);
      },
      TEST_TIMEOUT_MS,
    );

    // ─── E2E-11: OAuth Initiate Rejects Unresolved Template Variables ───

    it(
      'E2E-11: OAuth initiate rejects unresolved connectionConfig templates',
      async () => {
        // Step 1: Create profile with unresolved template
        const createRes = await callStudioRoute(studioModules.authProfiles.POST!, {
          path: `/api/projects/${state.projectId}/auth-profiles`,
          method: 'POST',
          token: state.accessToken,
          params: { id: state.projectId },
          body: {
            name: 'SF-Unresolved',
            authType: 'oauth2_app',
            scope: 'project',
            projectId: state.projectId,
            connector: 'salesforce',
            config: {
              authorizationUrl:
                'https://${connectionConfig.instance}.salesforce.com/services/oauth2/authorize',
              tokenUrl: 'https://${connectionConfig.instance}.salesforce.com/services/oauth2/token',
              defaultScopes: ['api'],
            },
            secrets: {
              clientId: 'sf-id2',
              clientSecret: 'sf-secret2',
            },
          },
        });

        // The URL validation schema might reject the template URL.
        // If so, expect 400 from creation. Otherwise, proceed to initiate.
        if (createRes.status !== 201) {
          // Creation itself rejected the template URL — that's also acceptable
          expect(createRes.status).toBe(400);
          return;
        }

        const profileId = String(createRes.json.data.id ?? createRes.json.data._id);

        // Step 2: Initiate OAuth flow — should fail with unresolved template error
        const initiateRes = await callStudioRoute(studioModules.oauthInitiate.POST!, {
          path: `/api/projects/${state.projectId}/auth-profiles/oauth/initiate`,
          method: 'POST',
          token: state.accessToken,
          params: { id: state.projectId },
          body: {
            connectorName: 'salesforce',
            authProfileId: profileId,
          },
        });

        expect(initiateRes.status).toBe(400);
        // errorJson returns { errors: [{ msg, code }] } — check the first error message
        const errMsg = initiateRes.json.errors?.[0]?.msg ?? initiateRes.json.error?.message ?? '';
        expect(errMsg).toContain('Unresolved template variables');
      },
      TEST_TIMEOUT_MS,
    );

    // ─── E2E-12: Auth-Aware Connector Catalog ────────────────────────────

    it(
      'E2E-12: project connector catalog exposes auth-aware entries and real connector capabilities',
      async () => {
        const providersRes = await callStudioRoute(studioModules.providers.GET!, {
          path: `/api/projects/${state.projectId}/auth-profiles/providers`,
          method: 'GET',
          token: state.accessToken,
          params: { id: state.projectId },
        });

        expect(providersRes.status).toBe(200);
        expect(Array.isArray(providersRes.json.data)).toBe(true);

        const providerNames = new Set(
          (providersRes.json.data as any[]).map((provider: any) => provider.connectorName),
        );
        expect(providerNames.has('shopify')).toBe(true);
        expect(providerNames.has('microsoft-power-bi')).toBe(true);

        const connectorsRes = await callStudioRoute(studioModules.connectors.GET!, {
          path: `/api/projects/${state.projectId}/connectors`,
          method: 'GET',
          token: state.accessToken,
          params: { id: state.projectId },
        });

        expect(connectorsRes.status).toBe(200);
        expect(connectorsRes.json.success).toBe(true);
        expect(Array.isArray(connectorsRes.json.data)).toBe(true);

        const connectors = connectorsRes.json.data as any[];

        expect(connectors.some((connector) => connector.name === 'http')).toBe(false);
        expect(connectors.some((connector) => connector.name === 'postgres')).toBe(false);

        const shopifyConnector = connectors.find((connector) => connector.name === 'shopify');
        expect(shopifyConnector).toBeDefined();
        expect(shopifyConnector.availableAuthTypes).toEqual([
          'oauth2',
          'oauth2_client_credentials',
          'api_key',
        ]);

        const sharepointConnector = connectors.find(
          (connector) => connector.name === 'microsoft-sharepoint',
        );
        expect(sharepointConnector).toBeDefined();
        expect(sharepointConnector.authType).toBe('azure_ad');
        expect(sharepointConnector.actions.length).toBeGreaterThan(0);
        expect(sharepointConnector.triggers.length).toBeGreaterThan(0);

        const powerBiConnector = connectors.find(
          (connector) => connector.name === 'microsoft-power-bi',
        );
        expect(powerBiConnector).toBeDefined();
        expect(powerBiConnector.authType).toBe('azure_ad');
        expect(powerBiConnector.actions.length).toBeGreaterThan(0);

        const businessCentralConnector = connectors.find(
          (connector) => connector.name === 'microsoft-dynamics-365-business-central',
        );
        expect(businessCentralConnector).toBeDefined();
        expect(businessCentralConnector.authType).toBe('oauth2_client_credentials');
        expect(businessCentralConnector.actions.length).toBeGreaterThan(0);
        expect(businessCentralConnector.triggers.length).toBeGreaterThan(0);
      },
      TEST_TIMEOUT_MS,
    );

    // ─── E2E-13: Cross-Project Isolation Returns 404 ────────────────────

    it(
      'E2E-13: profiles from project1 do not appear in project2 providers',
      async () => {
        // Step 1: Create a second project
        const project2 = await callStudioRoute(studioModules.projects.POST!, {
          path: '/api/projects',
          method: 'POST',
          token: state.accessToken,
          body: {
            name: 'Isolation Test Project 2',
            description: 'Cross-project isolation test',
          },
        });
        expect(project2.status).toBe(201);
        const project2Id = String(project2.json.project.id);

        // Step 2: Create a profile with a unique connector in project1
        const createRes = await callStudioRoute(studioModules.authProfiles.POST!, {
          path: `/api/projects/${state.projectId}/auth-profiles`,
          method: 'POST',
          token: state.accessToken,
          params: { id: state.projectId },
          body: {
            name: 'Isolated-Twilio',
            authType: 'api_key',
            scope: 'project',
            projectId: state.projectId,
            connector: 'twilio',
            config: { headerName: 'Authorization' },
            secrets: { apiKey: 'twilio_key' },
          },
        });
        expect(createRes.status).toBe(201);

        // Step 3: Verify project2 providers do NOT include twilio from project1
        const project2Providers = await callStudioRoute(studioModules.providers.GET!, {
          path: `/api/projects/${project2Id}/auth-profiles/providers`,
          method: 'GET',
          token: state.accessToken,
          params: { id: project2Id },
        });
        expect(project2Providers.status).toBe(200);
        const twilioInProject2 = (project2Providers.json.data as any[]).find(
          (p: any) => p.connectorName === 'twilio',
        );
        // twilio should either not exist or have 0 project-scoped profiles
        if (twilioInProject2) {
          // The profile from project1 should NOT appear
          if (twilioInProject2.profiles) {
            const isolatedProfile = (twilioInProject2.profiles as any[]).find(
              (p: any) => p.name === 'Isolated-Twilio',
            );
            expect(isolatedProfile).toBeUndefined();
          }
        }
      },
      TEST_TIMEOUT_MS,
    );

    // ─── E2E-14: Unauthenticated Request Returns 401 ────────────────────

    it(
      'E2E-14: unauthenticated request returns 401',
      async () => {
        const res = await callStudioRoute(studioModules.providers.GET!, {
          path: `/api/projects/${state.projectId}/auth-profiles/providers`,
          method: 'GET',
          // No token — unauthenticated
          params: { id: state.projectId },
        });

        expect(res.status).toBe(401);
      },
      TEST_TIMEOUT_MS,
    );

    // ─── E2E-15: Phase 2 Basic Auth Profile Round-Trip ──────────────────

    it(
      'E2E-15: creates and lists a basic auth profile through Studio routes',
      async () => {
        const createRes = await callStudioRoute(studioModules.authProfiles.POST!, {
          path: `/api/projects/${state.projectId}/auth-profiles`,
          method: 'POST',
          token: state.accessToken,
          params: { id: state.projectId },
          body: {
            name: 'Basic Internal API',
            authType: 'basic',
            scope: 'project',
            projectId: state.projectId,
            config: {},
            secrets: {
              username: 'basic-user',
              password: 'basic-pass',
            },
          },
        });

        expect(createRes.status).toBe(201);
        expect(createRes.json.success).toBe(true);
        expect(createRes.json.data.authType).toBe('basic');
        expect(createRes.json.data.encryptedSecrets).toBeUndefined();

        const profileId = String(createRes.json.data.id ?? createRes.json.data._id);
        createdProfiles['basic_internal_api'] = profileId;

        const listRes = await callStudioRoute(studioModules.authProfiles.GET!, {
          path: `/api/projects/${state.projectId}/auth-profiles`,
          method: 'GET',
          token: state.accessToken,
          params: { id: state.projectId },
        });

        expect(listRes.status).toBe(200);
        expect(Array.isArray(listRes.json.data)).toBe(true);

        const basicProfile = (listRes.json.data as Array<Record<string, unknown>>).find(
          (profile) => profile.id === profileId || profile.name === 'Basic Internal API',
        );
        expect(basicProfile).toBeDefined();
        expect(basicProfile?.authType).toBe('basic');
      },
      TEST_TIMEOUT_MS,
    );

    // ─── E2E-16: Phase 2 Custom Header Validation ───────────────────────

    it(
      'E2E-16: rejects custom_header profiles when header names and secret keys diverge',
      async () => {
        const res = await callStudioRoute(studioModules.authProfiles.POST!, {
          path: `/api/projects/${state.projectId}/auth-profiles`,
          method: 'POST',
          token: state.accessToken,
          params: { id: state.projectId },
          body: {
            name: 'Broken Header Profile',
            authType: 'custom_header',
            scope: 'project',
            projectId: state.projectId,
            config: {
              headers: {
                'X-API-Key': 'X-API-Key',
              },
            },
            secrets: {
              headerValues: {
                'X-Org-Id': 'tenant-123',
              },
            },
          },
        });

        expect(res.status).toBe(400);
      },
      TEST_TIMEOUT_MS,
    );

    // ─── E2E-17: Phase 2 AWS IAM Profile Round-Trip ─────────────────────

    it(
      'E2E-17: creates an AWS IAM auth profile through Studio routes',
      async () => {
        const createRes = await callStudioRoute(studioModules.authProfiles.POST!, {
          path: `/api/projects/${state.projectId}/auth-profiles`,
          method: 'POST',
          token: state.accessToken,
          params: { id: state.projectId },
          body: {
            name: 'AWS API Gateway SigV4',
            authType: 'aws_iam',
            scope: 'project',
            projectId: state.projectId,
            config: {
              region: 'us-east-1',
              service: 'execute-api',
            },
            secrets: {
              accessKeyId: 'AKIA_TEST_E2E',
              secretAccessKey: 'secret-access-key',
              sessionToken: 'temporary-token',
            },
          },
        });

        expect(createRes.status).toBe(201);
        expect(createRes.json.success).toBe(true);
        expect(createRes.json.data.authType).toBe('aws_iam');
        expect(createRes.json.data.encryptedSecrets).toBeUndefined();

        const profileId = String(createRes.json.data.id ?? createRes.json.data._id);
        createdProfiles['aws_api_gateway_sigv4'] = profileId;

        const detailRes = await callStudioRoute(studioModules.authProfileDetail.GET!, {
          path: `/api/projects/${state.projectId}/auth-profiles/${profileId}`,
          method: 'GET',
          token: state.accessToken,
          params: { id: state.projectId, profileId },
        });

        expect(detailRes.status).toBe(200);
        expect(detailRes.json.data.authType).toBe('aws_iam');
        expect(detailRes.json.data.config.region).toBe('us-east-1');
        expect(detailRes.json.data.config.service).toBe('execute-api');
      },
      TEST_TIMEOUT_MS,
    );

    // ─── E2E-18: Phase 2 mTLS Profile Round-Trip ────────────────────────

    it(
      'E2E-18: creates an mTLS auth profile through Studio routes',
      async () => {
        const createRes = await callStudioRoute(studioModules.authProfiles.POST!, {
          path: `/api/projects/${state.projectId}/auth-profiles`,
          method: 'POST',
          token: state.accessToken,
          params: { id: state.projectId },
          body: {
            name: 'Partner mTLS Profile',
            authType: 'mtls',
            scope: 'project',
            projectId: state.projectId,
            config: {},
            secrets: {
              clientCert: '-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----',
              clientKey: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----',
              caCert: '-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----',
            },
          },
        });

        expect(createRes.status).toBe(201);
        expect(createRes.json.success).toBe(true);
        expect(createRes.json.data.authType).toBe('mtls');
        expect(createRes.json.data.encryptedSecrets).toBeUndefined();

        const profileId = String(createRes.json.data.id ?? createRes.json.data._id);
        createdProfiles['partner_mtls_profile'] = profileId;

        const detailRes = await callStudioRoute(studioModules.authProfileDetail.GET!, {
          path: `/api/projects/${state.projectId}/auth-profiles/${profileId}`,
          method: 'GET',
          token: state.accessToken,
          params: { id: state.projectId, profileId },
        });

        expect(detailRes.status).toBe(200);
        expect(detailRes.json.data.authType).toBe('mtls');
      },
      TEST_TIMEOUT_MS,
    );

    // ─── E2E-19: Validate endpoint — config valid (none auth type) ───────

    it(
      'E2E-19: POST /validate on a none-auth workspace profile returns configuration valid',
      async () => {
        // Create a workspace-scoped none-auth profile — no secrets, no config.
        const createRes = await callStudioRoute(studioModules.workspaceAuthProfiles.POST!, {
          path: '/api/auth-profiles',
          method: 'POST',
          token: state.accessToken,
          body: {
            name: 'E2E None Auth Profile',
            authType: 'none',
            scope: 'tenant',
            projectId: null,
            config: {},
            secrets: {},
          },
        });
        expect(createRes.status).toBe(201);
        const profileId = String(createRes.json.data.id ?? createRes.json.data._id);
        createdProfiles['validate_none_profile'] = profileId;

        const res = await callStudioRoute(studioModules.workspaceValidate.POST!, {
          path: `/api/auth-profiles/${profileId}/validate`,
          method: 'POST',
          token: state.accessToken,
          params: { profileId },
        });

        expect(res.status).toBe(200);
        expect(res.json.success).toBe(true);
        expect(res.json.data.valid).toBe(true);
        expect(res.json.data.validationType).toBe('configuration');
        expect(typeof res.json.data.latencyMs).toBe('number');
      },
      TEST_TIMEOUT_MS,
    );

    // ─── E2E-20: Validate endpoint — OAuth grant invalid ─────────────────

    it(
      'E2E-20: POST /validate on an oauth2_app workspace profile with no grant returns grant invalid',
      async () => {
        // Reuse the workspace Slack oauth2_app profile from E2E-5.
        // No grant has been issued, so validateOAuth2AppProfile returns invalid.
        const profileId = createdProfiles['workspace_slack'];
        expect(profileId).toBeTruthy();

        const res = await callStudioRoute(studioModules.workspaceValidate.POST!, {
          path: `/api/auth-profiles/${profileId}/validate`,
          method: 'POST',
          token: state.accessToken,
          params: { profileId },
        });

        expect(res.status).toBe(200);
        expect(res.json.success).toBe(true);
        expect(res.json.data.valid).toBe(false);
        expect(res.json.data.validationType).toBe('oauth_grant');
        expect(typeof res.json.data.message).toBe('string');
        expect(res.json.data.message).toMatch(/grant|OAuth|authorization/i);
      },
      TEST_TIMEOUT_MS,
    );

    // ─── E2E-21: Validate endpoint — config valid (bearer) ───────────────

    it(
      'E2E-21: POST /validate on a bearer workspace profile with no connector returns configuration valid',
      async () => {
        // A bearer profile with no connector slug validates structurally
        // through the route's configuration branch.
        const createRes = await callStudioRoute(studioModules.workspaceAuthProfiles.POST!, {
          path: '/api/auth-profiles',
          method: 'POST',
          token: state.accessToken,
          body: {
            name: 'E2E Bearer No Connector',
            authType: 'bearer',
            scope: 'tenant',
            projectId: null,
            config: {},
            secrets: { token: 'test-bearer-token-e2e' },
          },
        });
        expect(createRes.status).toBe(201);
        const profileId = String(createRes.json.data.id ?? createRes.json.data._id);
        createdProfiles['validate_bearer_optimistic'] = profileId;

        const res = await callStudioRoute(studioModules.workspaceValidate.POST!, {
          path: `/api/auth-profiles/${profileId}/validate`,
          method: 'POST',
          token: state.accessToken,
          params: { profileId },
        });

        expect(res.status).toBe(200);
        expect(res.json.success).toBe(true);
        expect(res.json.data.valid).toBe(true);
        expect(res.json.data.validationType).toBe('configuration');
      },
      TEST_TIMEOUT_MS,
    );

    // ─── E2E-22: Validate endpoint — 404 for non-existent profile ────────

    it(
      'E2E-22: POST /validate returns 404 for a non-existent workspace profile',
      async () => {
        const fakeId = '000000000000000000000099';
        const res = await callStudioRoute(studioModules.workspaceValidate.POST!, {
          path: `/api/auth-profiles/${fakeId}/validate`,
          method: 'POST',
          token: state.accessToken,
          params: { profileId: fakeId },
        });

        expect(res.status).toBe(404);
      },
      TEST_TIMEOUT_MS,
    );

    // ─── E2E-23: Validate endpoint — 401 for unauthenticated ─────────────

    it(
      'E2E-23: POST /validate returns 401 for an unauthenticated request',
      async () => {
        const profileId = createdProfiles['validate_none_profile'];
        expect(profileId).toBeTruthy();

        const res = await callStudioRoute(studioModules.workspaceValidate.POST!, {
          path: `/api/auth-profiles/${profileId}/validate`,
          method: 'POST',
          // No token
          params: { profileId },
        });

        expect(res.status).toBe(401);
      },
      TEST_TIMEOUT_MS,
    );

    // ─── E2E-24: lastValidatedAt written after successful project validate ─

    it(
      'E2E-24: POST project /validate writes lastValidatedAt on success',
      async () => {
        // Create a none-auth project profile
        const createRes = await callStudioRoute(studioModules.authProfiles.POST!, {
          path: `/api/projects/${state.projectId}/auth-profiles`,
          method: 'POST',
          token: state.accessToken,
          params: { id: state.projectId },
          body: {
            name: 'E2E Validate LastValidatedAt',
            authType: 'none',
            scope: 'project',
            projectId: state.projectId,
            config: {},
            secrets: {},
          },
        });
        expect(createRes.status).toBe(201);
        const profileId = String(createRes.json.data.id ?? createRes.json.data._id);
        createdProfiles['validate_lva_project'] = profileId;

        // Validate
        const validateRes = await callStudioRoute(studioModules.projectValidate.POST!, {
          path: `/api/projects/${state.projectId}/auth-profiles/${profileId}/validate`,
          method: 'POST',
          token: state.accessToken,
          params: { id: state.projectId, profileId },
        });
        expect(validateRes.status).toBe(200);
        expect(validateRes.json.success).toBe(true);
        expect(validateRes.json.data.valid).toBe(true);

        // Read profile back and confirm lastValidatedAt is set
        const getRes = await callStudioRoute(studioModules.authProfileDetail.GET!, {
          path: `/api/projects/${state.projectId}/auth-profiles/${profileId}`,
          method: 'GET',
          token: state.accessToken,
          params: { id: state.projectId, profileId },
        });
        expect(getRes.status).toBe(200);
        expect(getRes.json.data.lastValidatedAt).toBeTruthy();
        // ISO date string or Date object — verify it parses
        const lva = new Date(getRes.json.data.lastValidatedAt as string);
        expect(lva.getTime()).not.toBeNaN();
      },
      TEST_TIMEOUT_MS,
    );

    // ─── E2E-25: Personal project profile returns 404 to non-creator ──────

    it(
      'E2E-25: POST project /validate returns 404 for a personal profile owned by a different user',
      async () => {
        // Create a personal project profile as user1
        const createRes = await callStudioRoute(studioModules.authProfiles.POST!, {
          path: `/api/projects/${state.projectId}/auth-profiles`,
          method: 'POST',
          token: state.accessToken,
          params: { id: state.projectId },
          body: {
            name: 'E2E Personal Validate User1',
            authType: 'none',
            scope: 'project',
            projectId: state.projectId,
            visibility: 'personal',
            config: {},
            secrets: {},
          },
        });
        expect(createRes.status).toBe(201);
        const profileId = String(createRes.json.data.id ?? createRes.json.data._id);
        createdProfiles['personal_validate_project'] = profileId;

        // user2 tries to validate — same tenant, different creator → 404
        const res = await callStudioRoute(studioModules.projectValidate.POST!, {
          path: `/api/projects/${state.projectId}/auth-profiles/${profileId}/validate`,
          method: 'POST',
          token: state.user2AccessToken,
          params: { id: state.projectId, profileId },
        });

        expect(res.status).toBe(404);
      },
      TEST_TIMEOUT_MS,
    );

    // ─── E2E-26: Project profile is hidden from workspace validation ──────

    it(
      'E2E-26: POST workspace /validate returns 404 for a project-scoped personal profile',
      async () => {
        // Tenant-level profiles cannot be personal, so create a project-owned
        // personal profile and verify the workspace validate route cannot see it.
        const createRes = await callStudioRoute(studioModules.authProfiles.POST!, {
          path: `/api/projects/${state.projectId}/auth-profiles`,
          method: 'POST',
          token: state.accessToken,
          params: { id: state.projectId },
          body: {
            name: 'E2E Personal Workspace Validate User1',
            authType: 'none',
            scope: 'project',
            projectId: state.projectId,
            visibility: 'personal',
            config: {},
            secrets: {},
          },
        });
        expect(createRes.status).toBe(201);
        const profileId = String(createRes.json.data.id ?? createRes.json.data._id);
        createdProfiles['personal_validate_workspace'] = profileId;

        // user2 tries to validate — same tenant, different creator → 404
        const res = await callStudioRoute(studioModules.workspaceValidate.POST!, {
          path: `/api/auth-profiles/${profileId}/validate`,
          method: 'POST',
          token: state.user2AccessToken,
          params: { profileId },
        });

        expect(res.status).toBe(404);
      },
      TEST_TIMEOUT_MS,
    );
  },
  TEST_TIMEOUT_MS,
);

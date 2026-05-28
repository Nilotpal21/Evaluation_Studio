import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, {
  type Express,
  type Request as ExpressRequest,
  type Response as ExpressResponse,
} from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  startRuntimeServerHarness,
  TEST_RUNTIME_SDK_BOOTSTRAP_SIGNING_SECRET,
  TEST_RUNTIME_SDK_SESSION_SIGNING_SECRET,
  type RuntimeApiHarness,
} from '../../../../runtime/src/__tests__/helpers/runtime-api-harness.js';

const TEST_JWT_SECRET = '3'.repeat(64);
const TEST_MASTER_KEY = '4'.repeat(64);
export const TEST_STUDIO_SDK_SESSION_SIGNING_SECRET = TEST_RUNTIME_SDK_SESSION_SIGNING_SECRET;
export const TEST_STUDIO_SDK_BOOTSTRAP_SIGNING_SECRET = TEST_RUNTIME_SDK_BOOTSTRAP_SIGNING_SECRET;
const MONGOMS_VERSION = process.env.MONGOMS_VERSION || '7.0.20';
const MONGOMS_LAUNCH_TIMEOUT_MS = 30_000;

const MANAGED_ENV_KEYS = [
  'NODE_ENV',
  'ENABLE_DEV_LOGIN',
  'JWT_SECRET',
  'AUTH_SDK_SESSION_SIGNING_SECRET',
  'AUTH_SDK_BOOTSTRAP_SIGNING_SECRET',
  'ENCRYPTION_MASTER_KEY',
  'ENCRYPTION_ENABLED',
  'MONGODB_URL',
  'MONGODB_URI',
  'MONGODB_MANAGED',
  'FRONTEND_URL',
  'RUNTIME_URL',
  'RUNTIME_PUBLIC_BASE_URL',
  'NEXT_PUBLIC_RUNTIME_URL',
  'REDIS_ENABLED',
  'REDIS_URL',
  'AUDIT_PIPELINE_TEST_BACKEND',
] as const;

type ManagedEnvKey = (typeof MANAGED_ENV_KEYS)[number];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test harness accepts both NextRequest and RequestLike handlers
type StudioRouteHandler = (...args: any[]) => Promise<globalThis.Response>;

interface RequestLike extends globalThis.Request {
  nextUrl: URL;
}

interface StudioRouteModule {
  GET?: StudioRouteHandler;
  POST?: StudioRouteHandler;
  PUT?: StudioRouteHandler;
  PATCH?: StudioRouteHandler;
  DELETE?: StudioRouteHandler;
  [key: string]: unknown;
}

export interface StudioApiHarness {
  app: Express;
  server: http.Server;
  baseUrl: string;
  runtimeBaseUrl: string;
  close(): Promise<void>;
}

function setManagedEnv(key: ManagedEnvKey, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  Reflect.set(process.env, key, value);
}

function snapshotEnv(): Record<ManagedEnvKey, string | undefined> {
  const snapshot = {} as Record<ManagedEnvKey, string | undefined>;
  for (const key of MANAGED_ENV_KEYS) {
    snapshot[key] = process.env[key];
  }
  return snapshot;
}

function restoreEnv(snapshot: Record<ManagedEnvKey, string | undefined>): void {
  const env = process.env as Record<string, string | undefined>;
  for (const key of MANAGED_ENV_KEYS) {
    setManagedEnv(key, snapshot[key]);
  }
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function buildRequestInit(req: ExpressRequest): RequestInit {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(key, entry);
      }
      continue;
    }

    headers.set(key, value);
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    return { method: req.method, headers };
  }

  if (req.body === undefined || req.body === null) {
    return { method: req.method, headers };
  }

  if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
    return {
      method: req.method,
      headers,
      body: typeof req.body === 'string' ? req.body : new Uint8Array(req.body),
    };
  }

  if (req.body instanceof Uint8Array) {
    return { method: req.method, headers, body: Buffer.from(req.body) };
  }

  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  return { method: req.method, headers, body: JSON.stringify(req.body) };
}

function buildNextRequest(req: ExpressRequest, baseUrl: string): RequestLike {
  const nextUrl = new URL(req.originalUrl || req.url, baseUrl);
  const request = new Request(nextUrl, buildRequestInit(req)) as RequestLike;
  request.nextUrl = nextUrl;
  return request;
}

async function sendFetchResponse(
  res: ExpressResponse,
  response: globalThis.Response,
): Promise<void> {
  res.status(response.status);

  for (const [key, value] of response.headers.entries()) {
    res.setHeader(key, value);
  }

  const body = Buffer.from(await response.arrayBuffer());
  res.send(body);
}

function wrapRoute(
  handler: StudioRouteHandler | undefined,
  baseUrlProvider: () => string,
): express.RequestHandler {
  return async (req, res, next) => {
    if (!handler) {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const response = await handler(buildNextRequest(req, baseUrlProvider()));
      await sendFetchResponse(res, response);
    } catch (error) {
      next(error);
    }
  };
}

function wrapRouteWithParams<TParams extends Record<string, string>>(
  handler:
    | ((
        request: RequestLike,
        context: { params: Promise<TParams> },
      ) => Promise<globalThis.Response>)
    | undefined,
  baseUrlProvider: () => string,
  buildParams: (req: ExpressRequest) => TParams,
): express.RequestHandler {
  return async (req, res, next) => {
    if (!handler) {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      const response = await handler(buildNextRequest(req, baseUrlProvider()), {
        params: Promise.resolve(buildParams(req)),
      });
      await sendFetchResponse(res, response);
    } catch (error) {
      next(error);
    }
  };
}

async function importStudioSdkRoutes(): Promise<{
  devLogin: StudioRouteModule;
  createWorkspace: StudioRouteModule;
  projects: StudioRouteModule;
  audit: StudioRouteModule;
  auditExport: StudioRouteModule;
  workspaceInvitations: StudioRouteModule;
  projectAgentTransferSettings: StudioRouteModule;
  projectSessionLifecycle: StudioRouteModule;
  tenantRetention: StudioRouteModule;
  sdkKeys: StudioRouteModule;
  platformKeys: StudioRouteModule;
  platformKeyScopes: StudioRouteModule;
  platformKeyDetail: StudioRouteModule;
  projectMembers: StudioRouteModule;
  projectAgents: StudioRouteModule;
  runtimeSdkChannels: StudioRouteModule;
  runtimeSdkChannelDetail: StudioRouteModule;
  sdkWidget: StudioRouteModule;
  sdkEmbed: StudioRouteModule;
  previewToken: StudioRouteModule;
  share: StudioRouteModule;
  shareExchange: StudioRouteModule;
}> {
  const [
    devLogin,
    createWorkspace,
    projects,
    audit,
    auditExport,
    workspaceInvitations,
    projectAgentTransferSettings,
    projectSessionLifecycle,
    tenantRetention,
    sdkKeys,
    platformKeys,
    platformKeyScopes,
    platformKeyDetail,
    projectMembers,
    projectAgents,
    runtimeSdkChannels,
    runtimeSdkChannelDetail,
    sdkWidget,
    sdkEmbed,
    previewToken,
    share,
    shareExchange,
  ] = await Promise.all([
    import('../../app/api/auth/dev-login/route'),
    import('../../app/api/auth/create-workspace/route'),
    import('../../app/api/projects/route'),
    import('../../app/api/audit/route'),
    import('../../app/api/archives/audit-export/route'),
    import('../../app/api/workspaces/[tenantId]/invitations/route'),
    import('../../app/api/projects/[id]/agent-transfer/settings/route'),
    import('../../app/api/projects/[id]/session-lifecycle/route'),
    import('../../app/api/tenant/retention/route'),
    import('../../app/api/sdk/keys/route'),
    import('../../app/api/keys/route'),
    import('../../app/api/keys/scopes/route'),
    import('../../app/api/keys/[keyId]/route'),
    import('../../app/api/projects/[id]/members/route'),
    import('../../app/api/projects/[id]/agents/route'),
    import('../../app/api/runtime/sdk-channels/route'),
    import('../../app/api/runtime/sdk-channels/[channelId]/route'),
    import('../../app/api/sdk/widget/[projectId]/route'),
    import('../../app/api/sdk/embed/[projectId]/route'),
    import('../../app/api/sdk/preview-token/route'),
    import('../../app/api/sdk/share/route'),
    import('../../app/api/sdk/share/exchange/route'),
  ]);

  return {
    devLogin,
    createWorkspace,
    projects,
    audit,
    auditExport,
    workspaceInvitations,
    projectAgentTransferSettings,
    projectSessionLifecycle,
    tenantRetention,
    sdkKeys,
    platformKeys,
    platformKeyScopes,
    platformKeyDetail,
    projectMembers,
    projectAgents,
    runtimeSdkChannels,
    runtimeSdkChannelDetail,
    sdkWidget,
    sdkEmbed,
    previewToken,
    share,
    shareExchange,
  };
}

function mountSdkRoutes(
  app: Express,
  routes: Awaited<ReturnType<typeof importStudioSdkRoutes>>,
  baseUrlProvider: () => string,
): void {
  app.post('/api/auth/dev-login', wrapRoute(routes.devLogin.POST, baseUrlProvider));
  app.post('/api/auth/create-workspace', wrapRoute(routes.createWorkspace.POST, baseUrlProvider));
  app.post('/api/projects', wrapRoute(routes.projects.POST, baseUrlProvider));
  app.get('/api/audit', wrapRoute(routes.audit.GET, baseUrlProvider));
  app.post('/api/archives/audit-export', wrapRoute(routes.auditExport.POST, baseUrlProvider));
  app.post(
    '/api/workspaces/:tenantId/invitations',
    wrapRouteWithParams(
      routes.workspaceInvitations.POST as
        | ((
            request: RequestLike,
            context: { params: Promise<{ tenantId: string }> },
          ) => Promise<globalThis.Response>)
        | undefined,
      baseUrlProvider,
      (req) => ({ tenantId: req.params.tenantId as string }),
    ),
  );
  app.get(
    '/api/projects/:id/agent-transfer/settings',
    wrapRouteWithParams(
      routes.projectAgentTransferSettings.GET as
        | ((
            request: RequestLike,
            context: { params: Promise<{ id: string }> },
          ) => Promise<globalThis.Response>)
        | undefined,
      baseUrlProvider,
      (req) => ({ id: req.params.id as string }),
    ),
  );
  app.put(
    '/api/projects/:id/agent-transfer/settings',
    wrapRouteWithParams(
      routes.projectAgentTransferSettings.PUT as
        | ((
            request: RequestLike,
            context: { params: Promise<{ id: string }> },
          ) => Promise<globalThis.Response>)
        | undefined,
      baseUrlProvider,
      (req) => ({ id: req.params.id as string }),
    ),
  );
  app.get(
    '/api/projects/:id/session-lifecycle',
    wrapRouteWithParams(
      routes.projectSessionLifecycle.GET as
        | ((
            request: RequestLike,
            context: { params: Promise<{ id: string }> },
          ) => Promise<globalThis.Response>)
        | undefined,
      baseUrlProvider,
      (req) => ({ id: req.params.id as string }),
    ),
  );
  app.patch(
    '/api/projects/:id/session-lifecycle',
    wrapRouteWithParams(
      routes.projectSessionLifecycle.PATCH as
        | ((
            request: RequestLike,
            context: { params: Promise<{ id: string }> },
          ) => Promise<globalThis.Response>)
        | undefined,
      baseUrlProvider,
      (req) => ({ id: req.params.id as string }),
    ),
  );
  app.put(
    '/api/projects/:id/session-lifecycle',
    wrapRouteWithParams(
      routes.projectSessionLifecycle.PUT as
        | ((
            request: RequestLike,
            context: { params: Promise<{ id: string }> },
          ) => Promise<globalThis.Response>)
        | undefined,
      baseUrlProvider,
      (req) => ({ id: req.params.id as string }),
    ),
  );
  app.get('/api/tenant/retention', wrapRoute(routes.tenantRetention.GET, baseUrlProvider));
  app.patch('/api/tenant/retention', wrapRoute(routes.tenantRetention.PATCH, baseUrlProvider));
  app.get('/api/sdk/keys', wrapRoute(routes.sdkKeys.GET, baseUrlProvider));
  app.post('/api/sdk/keys', wrapRoute(routes.sdkKeys.POST, baseUrlProvider));

  // Platform keys (ApiKey model)
  app.get('/api/keys', wrapRoute(routes.platformKeys.GET, baseUrlProvider));
  app.post('/api/keys', wrapRoute(routes.platformKeys.POST, baseUrlProvider));
  app.get('/api/keys/scopes', wrapRoute(routes.platformKeyScopes.GET, baseUrlProvider));
  app.patch(
    '/api/keys/:keyId',
    wrapRouteWithParams(
      routes.platformKeyDetail.PATCH as
        | ((
            request: RequestLike,
            context: { params: Promise<{ keyId: string }> },
          ) => Promise<globalThis.Response>)
        | undefined,
      baseUrlProvider,
      (req) => ({ keyId: req.params.keyId as string }),
    ),
  );
  app.delete(
    '/api/keys/:keyId',
    wrapRouteWithParams(
      routes.platformKeyDetail.DELETE as
        | ((
            request: RequestLike,
            context: { params: Promise<{ keyId: string }> },
          ) => Promise<globalThis.Response>)
        | undefined,
      baseUrlProvider,
      (req) => ({ keyId: req.params.keyId as string }),
    ),
  );
  app.get(
    '/api/projects/:id/members',
    wrapRouteWithParams(
      routes.projectMembers.GET as
        | ((
            request: RequestLike,
            context: { params: Promise<{ id: string }> },
          ) => Promise<globalThis.Response>)
        | undefined,
      baseUrlProvider,
      (req) => ({ id: req.params.id as string }),
    ),
  );
  app.post(
    '/api/projects/:id/members',
    wrapRouteWithParams(
      routes.projectMembers.POST as
        | ((
            request: RequestLike,
            context: { params: Promise<{ id: string }> },
          ) => Promise<globalThis.Response>)
        | undefined,
      baseUrlProvider,
      (req) => ({ id: req.params.id as string }),
    ),
  );
  app.get(
    '/api/projects/:id/agents',
    wrapRouteWithParams(
      routes.projectAgents.GET as
        | ((
            request: RequestLike,
            context: { params: Promise<{ id: string }> },
          ) => Promise<globalThis.Response>)
        | undefined,
      baseUrlProvider,
      (req) => ({ id: req.params.id as string }),
    ),
  );
  app.post(
    '/api/projects/:id/agents',
    wrapRouteWithParams(
      routes.projectAgents.POST as
        | ((
            request: RequestLike,
            context: { params: Promise<{ id: string }> },
          ) => Promise<globalThis.Response>)
        | undefined,
      baseUrlProvider,
      (req) => ({ id: req.params.id as string }),
    ),
  );
  app.get('/api/runtime/sdk-channels', wrapRoute(routes.runtimeSdkChannels.GET, baseUrlProvider));
  app.post('/api/runtime/sdk-channels', wrapRoute(routes.runtimeSdkChannels.POST, baseUrlProvider));
  app.get(
    '/api/runtime/sdk-channels/:channelId',
    wrapRouteWithParams(
      routes.runtimeSdkChannelDetail.GET as
        | ((
            request: RequestLike,
            context: { params: Promise<{ channelId: string }> },
          ) => Promise<globalThis.Response>)
        | undefined,
      baseUrlProvider,
      (req) => ({ channelId: req.params.channelId as string }),
    ),
  );
  app.patch(
    '/api/runtime/sdk-channels/:channelId',
    wrapRouteWithParams(
      routes.runtimeSdkChannelDetail.PATCH as
        | ((
            request: RequestLike,
            context: { params: Promise<{ channelId: string }> },
          ) => Promise<globalThis.Response>)
        | undefined,
      baseUrlProvider,
      (req) => ({ channelId: req.params.channelId as string }),
    ),
  );
  app.delete(
    '/api/runtime/sdk-channels/:channelId',
    wrapRouteWithParams(
      routes.runtimeSdkChannelDetail.DELETE as
        | ((
            request: RequestLike,
            context: { params: Promise<{ channelId: string }> },
          ) => Promise<globalThis.Response>)
        | undefined,
      baseUrlProvider,
      (req) => ({ channelId: req.params.channelId as string }),
    ),
  );
  app.get(
    '/api/sdk/widget/:projectId',
    wrapRouteWithParams(
      routes.sdkWidget.GET as
        | ((
            request: RequestLike,
            context: { params: Promise<{ projectId: string }> },
          ) => Promise<globalThis.Response>)
        | undefined,
      baseUrlProvider,
      (req) => ({ projectId: req.params.projectId as string }),
    ),
  );
  app.put(
    '/api/sdk/widget/:projectId',
    wrapRouteWithParams(
      routes.sdkWidget.PUT as
        | ((
            request: RequestLike,
            context: { params: Promise<{ projectId: string }> },
          ) => Promise<globalThis.Response>)
        | undefined,
      baseUrlProvider,
      (req) => ({ projectId: req.params.projectId as string }),
    ),
  );
  app.get(
    '/api/sdk/embed/:projectId',
    wrapRouteWithParams(
      routes.sdkEmbed.GET as
        | ((
            request: RequestLike,
            context: { params: Promise<{ projectId: string }> },
          ) => Promise<globalThis.Response>)
        | undefined,
      baseUrlProvider,
      (req) => ({ projectId: req.params.projectId as string }),
    ),
  );
  app.post('/api/sdk/preview-token', wrapRoute(routes.previewToken.POST, baseUrlProvider));
  app.post('/api/sdk/share', wrapRoute(routes.share.POST, baseUrlProvider));
  app.post('/api/sdk/share/exchange', wrapRoute(routes.shareExchange.POST, baseUrlProvider));
}

function mountTestRoutes(app: Express): void {
  app.post('/__test/audit/create-failure', async (req, res, next) => {
    try {
      const bodyText = typeof req.body === 'string' ? req.body : '';
      const body = (bodyText ? JSON.parse(bodyText) : {}) as { message?: string | null };
      const message =
        typeof body.message === 'string' && body.message.trim().length > 0
          ? body.message.trim()
          : null;

      const { setInMemoryAuditTestWriteFailure } = await import('@abl/compiler/platform/stores');
      setInMemoryAuditTestWriteFailure(message);

      res.status(200).json({ enabled: message !== null });
    } catch (error) {
      next(error);
    }
  });

  app.post('/__test/seed-platform-key', async (req, res, next) => {
    try {
      const bodyText = typeof req.body === 'string' ? req.body : '';
      const body = (bodyText ? JSON.parse(bodyText) : {}) as {
        tenantId?: string;
        createdBy?: string;
        name?: string;
        scopes?: string[];
        projectIds?: string[];
        expiresAt?: string | null;
        rawKey?: string;
      };

      const tenantId = typeof body.tenantId === 'string' ? body.tenantId.trim() : '';
      const createdBy = typeof body.createdBy === 'string' ? body.createdBy.trim() : '';
      const name =
        typeof body.name === 'string' && body.name.trim().length > 0
          ? body.name.trim()
          : 'Seeded Platform Key';
      const scopes = Array.isArray(body.scopes)
        ? body.scopes.filter(
            (scope): scope is string => typeof scope === 'string' && scope.length > 0,
          )
        : [];
      const projectIds = Array.isArray(body.projectIds)
        ? body.projectIds.filter(
            (projectId): projectId is string =>
              typeof projectId === 'string' && projectId.length > 0,
          )
        : [];

      if (!tenantId || !createdBy || scopes.length === 0 || projectIds.length === 0) {
        res.status(400).json({
          error: 'tenantId, createdBy, scopes, and projectIds are required for test seeding',
        });
        return;
      }

      const rawKey =
        typeof body.rawKey === 'string' && body.rawKey.length > 0
          ? body.rawKey
          : `abl_${crypto.randomBytes(24).toString('hex')}`;
      const prefix = rawKey.substring(0, 8);
      const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

      const { ApiKey } = await import('@agent-platform/database/models');
      const apiKey = await ApiKey.create({
        tenantId,
        name,
        clientId: `plt-seed-${crypto.randomUUID()}`,
        keyHash,
        prefix,
        scopes,
        projectIds,
        environments: [],
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        createdBy,
      });

      res.status(201).json({
        id: apiKey._id,
        prefix: apiKey.prefix,
        name: apiKey.name,
        clientId: apiKey.clientId,
        scopes: apiKey.scopes,
        projectIds: apiKey.projectIds,
        expiresAt: apiKey.expiresAt ? apiKey.expiresAt.toISOString() : null,
        lastUsedAt: apiKey.lastUsedAt ? apiKey.lastUsedAt.toISOString() : null,
        createdAt: apiKey.createdAt.toISOString(),
        key: rawKey,
      });
    } catch (error) {
      next(error);
    }
  });
}

export async function startStudioApiHarness(): Promise<StudioApiHarness> {
  const previousEnv = snapshotEnv();
  const mongod = await MongoMemoryServer.create({
    binary: { version: MONGOMS_VERSION },
    instance: { launchTimeout: MONGOMS_LAUNCH_TIMEOUT_MS },
  });
  const mongoUri = mongod.getUri();

  setManagedEnv('NODE_ENV', 'test');
  setManagedEnv('ENABLE_DEV_LOGIN', 'true');
  setManagedEnv('JWT_SECRET', TEST_JWT_SECRET);
  setManagedEnv('AUTH_SDK_SESSION_SIGNING_SECRET', TEST_STUDIO_SDK_SESSION_SIGNING_SECRET);
  setManagedEnv('AUTH_SDK_BOOTSTRAP_SIGNING_SECRET', TEST_STUDIO_SDK_BOOTSTRAP_SIGNING_SECRET);
  setManagedEnv('ENCRYPTION_MASTER_KEY', TEST_MASTER_KEY);
  setManagedEnv('ENCRYPTION_ENABLED', 'true');
  setManagedEnv('MONGODB_URL', mongoUri);
  setManagedEnv('MONGODB_URI', mongoUri);
  setManagedEnv('MONGODB_MANAGED', 'false');
  setManagedEnv('REDIS_ENABLED', 'false');
  setManagedEnv('REDIS_URL', undefined);
  setManagedEnv('AUDIT_PIPELINE_TEST_BACKEND', 'memory');
  const { resetInMemoryAuditTestBackend } = await import('@abl/compiler/platform/stores');
  resetInMemoryAuditTestBackend();

  const runtimeHarness: RuntimeApiHarness = await startRuntimeServerHarness(
    {},
    { mongoUri, autoIndex: false },
  );
  setManagedEnv('RUNTIME_URL', runtimeHarness.baseUrl);
  setManagedEnv('RUNTIME_PUBLIC_BASE_URL', runtimeHarness.baseUrl);
  setManagedEnv('NEXT_PUBLIC_RUNTIME_URL', undefined);

  const routes = await importStudioSdkRoutes();
  const app = express();
  // Keep request bodies raw so Next route handlers own JSON parsing/validation.
  app.use(express.text({ type: '*/*', limit: '1mb' }));

  let baseUrl = 'http://127.0.0.1:0';
  mountSdkRoutes(app, routes, () => baseUrl);
  mountTestRoutes(app);

  const server = await new Promise<http.Server>((resolve) => {
    const candidate = http.createServer(app);
    candidate.listen(0, '127.0.0.1', () => resolve(candidate));
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  setManagedEnv('FRONTEND_URL', baseUrl);

  return {
    app,
    server,
    baseUrl,
    runtimeBaseUrl: runtimeHarness.baseUrl,
    async close() {
      resetInMemoryAuditTestBackend();
      await closeServer(server);
      await runtimeHarness.close();
      await mongoose.disconnect();
      await mongod.stop();
      restoreEnv(previousEnv);
    },
  };
}

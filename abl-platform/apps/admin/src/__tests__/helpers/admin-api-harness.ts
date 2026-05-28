import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { SignJWT } from 'jose';
import mongoose from 'mongoose';
import { NextRequest } from 'next/server';

const TEST_JWT_SECRET = 'admin-audit-test-secret-0123456789';
const MONGOMS_VERSION = process.env.MONGOMS_VERSION || '7.0.20';
const MONGOMS_LAUNCH_TIMEOUT_MS = 30_000;
const MONGOMS_PORT_BASE = 27_100;
const MONGOMS_PORT_SPAN = 500;

const MANAGED_ENV_KEYS = [
  'NODE_ENV',
  'JWT_SECRET',
  'AUDIT_PIPELINE_TEST_BACKEND',
  'SUPER_ADMIN_USER_IDS',
] as const;

type ManagedEnvKey = (typeof MANAGED_ENV_KEYS)[number];

type AdminRouteHandler = (
  request: NextRequest,
  routeCtx: { params: Promise<Record<string, string | string[]>> },
) => Promise<globalThis.Response>;

type HttpMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST';

interface MongoMemoryServerLike {
  getUri(): string;
  stop(): Promise<void>;
}

interface MongoMemoryServerFactory {
  create(options: {
    binary: { version: string };
    instance: { launchTimeout: number; ip?: string; port?: number };
  }): Promise<MongoMemoryServerLike>;
}

interface AdminRouteModule {
  GET?: AdminRouteHandler;
  POST?: AdminRouteHandler;
  PATCH?: AdminRouteHandler;
  DELETE?: AdminRouteHandler;
}

interface RouteDefinition {
  pathname: string;
  handlers: Partial<Record<HttpMethod, AdminRouteHandler>>;
}

export interface AdminApiHarness {
  server: http.Server;
  baseUrl: string;
  createAccessToken(input: { userId: string; email: string; role?: string }): Promise<string>;
  close(): Promise<void>;
}

function getJwtSecret(): Uint8Array {
  return new TextEncoder().encode(TEST_JWT_SECRET);
}

function resolveMongoMemoryServerPort(): number {
  return MONGOMS_PORT_BASE + (process.pid % MONGOMS_PORT_SPAN);
}

const rootRequire = createRequire(new URL('../../../../../package.json', import.meta.url));
const { MongoMemoryServer } = rootRequire('mongodb-memory-server') as {
  MongoMemoryServer: MongoMemoryServerFactory;
};

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
    if (snapshot[key] === undefined) {
      delete env[key];
    } else {
      env[key] = snapshot[key];
    }
  }
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return undefined;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  return Buffer.concat(chunks);
}

function buildHeaders(req: IncomingMessage): Headers {
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

  return headers;
}

async function buildNextRequest(req: IncomingMessage, baseUrl: string): Promise<NextRequest> {
  const nextUrl = new URL(req.url ?? '/', baseUrl);
  const headers = buildHeaders(req);
  const body = await readRequestBody(req);
  const init: ConstructorParameters<typeof NextRequest>[1] = {
    method: req.method ?? 'GET',
    headers,
  };

  if (body) {
    init.body = body as unknown as BodyInit;
  }

  return new NextRequest(nextUrl, init);
}

async function sendFetchResponse(
  res: ServerResponse<IncomingMessage>,
  response: globalThis.Response,
): Promise<void> {
  res.statusCode = response.status;

  for (const [key, value] of response.headers.entries()) {
    res.setHeader(key, value);
  }

  const body = Buffer.from(await response.arrayBuffer());
  res.end(body);
}

function sendJson(
  res: ServerResponse<IncomingMessage>,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function findRouteHandler(
  routes: RouteDefinition[],
  pathname: string,
  method: string | undefined,
): AdminRouteHandler | null | undefined {
  const route = routes.find((candidate) => candidate.pathname === pathname);
  if (!route) {
    return null;
  }

  const normalizedMethod = (method ?? 'GET').toUpperCase() as HttpMethod;
  return route.handlers[normalizedMethod];
}

async function importAdminRoutes(): Promise<{
  secrets: AdminRouteModule;
  audit: AdminRouteModule;
  auditExport: AdminRouteModule;
}> {
  const [secrets, audit, auditExport] = await Promise.all([
    import('../../app/api/secrets/route'),
    import('../../app/api/audit/route'),
    import('../../app/api/audit/export/route'),
  ]);

  return { secrets, audit, auditExport };
}

function buildRoutes(routes: Awaited<ReturnType<typeof importAdminRoutes>>): RouteDefinition[] {
  return [
    {
      pathname: '/api/secrets',
      handlers: {
        GET: routes.secrets.GET,
        POST: routes.secrets.POST,
      },
    },
    {
      pathname: '/api/audit',
      handlers: {
        GET: routes.audit.GET,
      },
    },
    {
      pathname: '/api/audit/export',
      handlers: {
        GET: routes.auditExport.GET,
      },
    },
  ];
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

export async function startAdminApiHarness(): Promise<AdminApiHarness> {
  const previousEnv = snapshotEnv();
  let mongod: MongoMemoryServerLike | undefined;
  let server: http.Server | undefined;

  try {
    mongod = await MongoMemoryServer.create({
      binary: { version: MONGOMS_VERSION },
      instance: {
        launchTimeout: MONGOMS_LAUNCH_TIMEOUT_MS,
        ip: '127.0.0.1',
        port: resolveMongoMemoryServerPort(),
      },
    });

    const env = process.env as Record<string, string | undefined>;
    env.NODE_ENV = 'test';
    env.JWT_SECRET = TEST_JWT_SECRET;
    env.AUDIT_PIPELINE_TEST_BACKEND = 'memory';
    const { resetInMemoryAuditTestBackend } = await import('@abl/compiler/platform/stores');
    resetInMemoryAuditTestBackend();

    await mongoose.connect(mongod.getUri(), {
      directConnection: true,
      connectTimeoutMS: 120_000,
      socketTimeoutMS: 120_000,
      serverSelectionTimeoutMS: 120_000,
      heartbeatFrequencyMS: 60_000,
    });
    await mongoose.connection.asPromise();
    await mongoose.connection.syncIndexes();

    const routes = buildRoutes(await importAdminRoutes());
    let baseUrl = 'http://127.0.0.1:0';

    server = http.createServer(async (req, res) => {
      const requestUrl = new URL(req.url ?? '/', baseUrl);
      const handler = findRouteHandler(routes, requestUrl.pathname, req.method);

      if (handler === null) {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }

      if (!handler) {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }

      try {
        const request = await buildNextRequest(req, baseUrl);
        const response = await handler(request, { params: Promise.resolve({}) });
        await sendFetchResponse(res, response);
      } catch (error) {
        sendJson(res, 500, {
          error: 'Internal server error',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    });

    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    return {
      server,
      baseUrl,
      async createAccessToken({ userId, email, role = 'VIEWER' }) {
        process.env.SUPER_ADMIN_USER_IDS = [process.env.SUPER_ADMIN_USER_IDS, userId]
          .filter(Boolean)
          .join(',');
        return await new SignJWT({
          email,
          type: 'access',
          role,
          isSuperAdmin: true,
        })
          .setProtectedHeader({ alg: 'HS256' })
          .setSubject(userId)
          .setIssuedAt()
          .sign(getJwtSecret());
      },
      async close() {
        resetInMemoryAuditTestBackend();
        await closeServer(server!);
        await mongoose.disconnect();
        await mongod?.stop();
        restoreEnv(previousEnv);
      },
    };
  } catch (error) {
    if (server) {
      await closeServer(server);
    }

    await mongoose.disconnect();
    await mongod?.stop();
    restoreEnv(previousEnv);
    throw error;
  }
}

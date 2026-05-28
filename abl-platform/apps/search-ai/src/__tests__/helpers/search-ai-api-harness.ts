/**
 * SearchAI E2E API Test Harness
 *
 * Provides a real Express server with:
 * - MongoMemoryServer (dual-connection: platform + content)
 * - Test auth bypass (x-tenant-id header OR fixed tenantId → tenantContext injection)
 * - Real connector routes (CRUD, auth, discovery)
 * - DI-based fake queue factory (no Redis/BullMQ needed)
 * - HTTP server on random port for supertest
 *
 * Modeled after apps/runtime/src/__tests__/helpers/runtime-api-harness.ts.
 *
 * Queue handling:
 * Routes that enqueue BullMQ jobs (discovery, sync) use the DI-injected fake
 * queue factory. Jobs are captured in `harness.capturedJobs` for assertions.
 * No real Redis connection is needed.
 *
 * Auth handling:
 * A test auth bypass middleware injects tenantContext from the `x-tenant-id`
 * header. The real auth middleware in the connector routes then passes because
 * `requireAuth()` checks `req.user || req.tenantContext`.
 */

import http from 'http';
import type { AddressInfo } from 'net';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { setupTestMongo, teardownTestMongo, clearCollections } from './setup-mongo.js';
import { getModel } from '../../db/index.js';
import { setQueueFactory, resetQueueFactory } from '../../workers/shared.js';
import type { ITenant } from '@agent-platform/database/models';
import type { ISearchIndex } from '@agent-platform/database/models';

// =============================================================================
// TYPES
// =============================================================================

/** A job captured by the fake queue factory. */
export interface CapturedJob {
  queueName: string;
  jobName: string;
  data: Record<string, unknown>;
  opts: Record<string, unknown>;
}

export interface SearchAIApiHarness {
  /** Express application instance */
  app: Express;
  /** HTTP server (listening on random port) */
  server: http.Server;
  /** Base URL for HTTP requests (e.g. http://127.0.0.1:12345) */
  baseUrl: string;
  /** MongoDB URI used by this harness */
  mongoUri: string;
  /** Jobs captured by the DI-injected fake queue factory. */
  capturedJobs: CapturedJob[];
  /** Clear all collections between tests */
  clearAll(): Promise<void>;
  /** Shut down server, disconnect database, stop MongoMemoryServer */
  close(): Promise<void>;
  /**
   * Seed a tenant document in MongoDB.
   * Returns the tenant ID.
   */
  seedTenant(tenantId: string, name?: string): Promise<string>;
  /**
   * Seed a search index document in MongoDB.
   * Returns the index ID.
   */
  seedSearchIndex(tenantId: string, indexId: string, name?: string): Promise<string>;
}

// =============================================================================
// ENVIRONMENT MANAGEMENT
// =============================================================================

const MANAGED_ENV_KEYS = [
  'NODE_ENV',
  'DEV_BYPASS_AUTH',
  'ENCRYPTION_MASTER_KEY',
  'JWT_SECRET',
  'REDIS_URL',
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_ENABLED',
] as const;

type ManagedEnvKey = (typeof MANAGED_ENV_KEYS)[number];

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

// =============================================================================
// DEV AUTH BYPASS (inline — simpler than importing config-dependent module)
// =============================================================================

/**
 * Test auth bypass middleware. Reads x-tenant-id header and injects
 * tenantContext directly — no config module dependency, no JWT verification.
 */
function testAuthBypass(req: Request, _res: Response, next: NextFunction): void {
  if (!req.tenantContext) {
    const headerTenantId = req.headers['x-tenant-id'] as string | undefined;
    const tenantId = headerTenantId ?? 'test-tenant-default';
    const headerUserId = req.headers['x-user-id'] as string | undefined;
    const userId = headerUserId ?? 'test-user';

    (req as any).tenantContext = {
      tenantId,
      orgId: undefined,
      userId,
      role: 'ADMIN',
      permissions: ['*'],
      authType: 'user' as const,
      isSuperAdmin: false,
    };
  }
  next();
}

// =============================================================================
// SERVER HELPERS
// =============================================================================

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

// =============================================================================
// HARNESS FACTORY
// =============================================================================

/**
 * Start a SearchAI E2E API harness.
 *
 * This creates:
 * 1. An in-memory MongoDB (platform + content dual connection)
 * 2. An Express app with JSON parsing and test auth bypass
 * 3. Real connector routes mounted at the correct paths
 * 4. An HTTP server listening on a random port
 *
 * Usage:
 * ```ts
 * let harness: SearchAIApiHarness;
 * beforeAll(async () => { harness = await startSearchAIApiHarness(); });
 * afterAll(async () => { await harness.close(); });
 * afterEach(async () => { await harness.clearAll(); });
 * ```
 */
export async function startSearchAIApiHarness(): Promise<SearchAIApiHarness> {
  const previousEnv = snapshotEnv();

  // Set environment variables BEFORE initializing anything.
  // NODE_ENV must be 'test' (setupTestMongo relies on this).
  // Disable Redis to prevent BullMQ/ioredis from connecting.
  const env = process.env as Record<string, string | undefined>;
  env.NODE_ENV = 'test';
  env.DEV_BYPASS_AUTH = 'true';
  env.ENCRYPTION_MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  env.JWT_SECRET = '1'.repeat(64);
  // Point Redis to a non-routable address to prevent background connections.
  // Port 1 is privileged and will be refused immediately on most systems.
  env.REDIS_URL = 'redis://127.0.0.1:1';
  env.REDIS_ENABLED = 'false';

  // Initialize in-memory MongoDB with dual connections
  const mongoUri = await setupTestMongo();

  // Inject a DI-based fake queue factory so routes that enqueue BullMQ jobs
  // (discovery, sync) work without a real Redis connection.
  const capturedJobs: CapturedJob[] = [];
  setQueueFactory((queueName: string) => {
    let jobCounter = 0;
    return {
      name: queueName,
      add: async (
        jobName: string,
        data: Record<string, unknown>,
        opts?: Record<string, unknown>,
      ) => {
        jobCounter++;
        const jobId = opts?.jobId ?? `fake-${queueName}-${jobCounter}`;
        capturedJobs.push({ queueName, jobName, data, opts: opts ?? {} });
        return { id: jobId, name: jobName, data };
      },
      close: async () => {},
    } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  // Dynamically import the real connector routes.
  // These modules use getLazyModel() which resolves against the dual connection
  // initialized by setupTestMongo → initMongoBackend.
  const [connectorRouterModule, connectorDiscoveryRouterModule] = await Promise.all([
    import('../../routes/connectors.js'),
    import('../../routes/connector-discovery.js'),
  ]);

  const connectorRouter = connectorRouterModule.default;
  const connectorDiscoveryRouter = connectorDiscoveryRouterModule.default;

  // Build Express app
  const app: Express = express();
  app.use(express.json({ limit: '10mb' }));

  // Test auth bypass — BEFORE routes so tenantContext is available.
  // The connector router's internal authMiddleware will pass because
  // requireAuth() checks `req.user || req.tenantContext`.
  app.use(testAuthBypass);

  // Mount connector routes at the same paths as server.ts
  // server.ts: app.use('/api/indexes', connectorRouter);   // /:indexId/connectors paths
  // server.ts: app.use('/api', connectorRouter);            // /connectors/:connectorId paths
  // server.ts: app.use('/api', connectorDiscoveryRouter);   // /connectors/:connectorId/discover etc.
  app.use('/api/indexes', connectorRouter);
  app.use('/api', connectorRouter);
  app.use('/api', connectorDiscoveryRouter);

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
  });

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: err.message },
    });
  });

  // Start HTTP server on random port
  const server = await new Promise<http.Server>((resolve) => {
    const candidate = http.createServer(app);
    candidate.listen(0, '127.0.0.1', () => resolve(candidate));
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    app,
    server,
    baseUrl,
    mongoUri,
    capturedJobs,

    async clearAll() {
      await clearCollections();
    },

    async close() {
      resetQueueFactory();
      await closeServer(server);
      await teardownTestMongo();
      restoreEnv(previousEnv);
    },

    async seedTenant(tenantId: string, name?: string): Promise<string> {
      const Tenant = getModel<ITenant>('Tenant');
      await Tenant.create({
        _id: tenantId,
        name: name ?? `Test Tenant ${tenantId}`,
        slug: `test-tenant-${tenantId}`,
        organizationId: null,
        ownerId: 'test-user',
        status: 'active',
      });
      return tenantId;
    },

    async seedSearchIndex(tenantId: string, indexId: string, name?: string): Promise<string> {
      const SearchIndex = getModel<ISearchIndex>('SearchIndex');
      await SearchIndex.create({
        _id: indexId,
        tenantId,
        projectId: 'test-project',
        slug: `test-index-${indexId}`,
        name: name ?? `Test Index ${indexId}`,
        description: null,
        embeddingModel: 'bge-m3',
        embeddingDimensions: 1024,
        vectorStore: {
          provider: 'opensearch',
          collectionName: `test_${indexId}`,
        },
        searchDefaults: {
          topK: 10,
          similarityThreshold: 0.7,
          includeMetadata: true,
          includeContent: true,
        },
        status: 'active',
      });
      return indexId;
    },
  };
}

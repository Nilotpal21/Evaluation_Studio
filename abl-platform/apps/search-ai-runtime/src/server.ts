/**
 * SearchAI Runtime Express Server
 *
 * Handles query execution, vocabulary resolution, and retrieval.
 */

import express, { type Express } from 'express';
import { createServer } from 'http';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import { createQueryRouter } from './routes/query.js';
import { createAuthRouter } from './routes/auth.js';
import { createEndUserCorsMiddleware } from './middleware/end-user-cors.middleware.js';
import { QueryPipeline } from './services/query/query-pipeline.js';
import { createStructuredRouter } from './routes/structured.js';
import { createAggregateRouter } from './routes/aggregate.js';
import suggestRouter from './routes/suggest.js';
import { createSimilarRouter } from './routes/similar.js';
import resolveRouter from './routes/resolve.js';
import discoverRouter from './routes/discover.js';
import { createBrowseRouter } from './routes/browse.js';
import { createInteractionsRouter, interactionWriter } from './routes/interactions.js';
import healthRouter from './routes/health.js';
import { metricsRouter } from './routes/metrics.js';
import idpSyncRouter from './routes/idp-sync.js';
import {
  requestIdMiddleware,
  createObservabilityMiddleware,
} from '@agent-platform/shared-observability';
import { runWithObservabilityContext } from '@abl/compiler/platform/observability';
import { createLogger } from '@abl/compiler/platform';
// Auth is applied per-route in each router (not globally) so routes remain
// independently testable. See each router's `router.use(authMiddleware)`.
// import { authMiddleware } from './middleware/auth.js';  // per-route, not global
import agentIntegrationRouter from './routes/agent-integration.routes.js';
import capabilitiesRouter from './routes/capabilities.routes.js';
import vocabularyRouter from './routes/vocabulary.routes.js';
import { initMongoBackend, isDatabaseAvailable, disconnectDatabase } from './db/index.js';
import { getConfig } from './config/index.js';
import { serviceContainer } from './services/service-container.js';
import { WorkerLLMClient } from '@agent-platform/llm';
import { getEmbeddingProvider } from './services/embedding/provider.js';

// =============================================================================
// EXPRESS APP
// =============================================================================

const app: Express = express();
const logger = createLogger('search-ai-runtime-server');
const getConfigLazy = () => getConfig();
let clickhouseReady = false;
let isShuttingDown = false;

// Security
app.use((req, res, next) => {
  const config = getConfigLazy();
  const helmetConfig =
    config.env === 'production'
      ? {
          contentSecurityPolicy: false,
          crossOriginEmbedderPolicy: false,
          hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
        }
      : {
          contentSecurityPolicy: false,
          crossOriginEmbedderPolicy: false,
        };
  helmet(helmetConfig)(req, res, next);
});

// CORS
app.use((req, res, next) => {
  const config = getConfigLazy();
  // Production: allow frontendUrl + any additional configured origins
  const additionalOrigins = process.env.SEARCH_AI_CORS_ORIGINS?.split(',').filter(Boolean) || [];
  const origin =
    config.env === 'production'
      ? [config.server.frontendUrl, ...additionalOrigins].filter((o): o is string => Boolean(o))
      : config.cors.origins;
  const exposedHeaders = [
    ...(config.cors.exposedHeaders || []),
    'X-RateLimit-Limit',
    'X-RateLimit-Remaining',
    'X-RateLimit-Reset',
    'X-Request-Id',
  ];
  const corsOptions = {
    origin,
    credentials: config.cors.credentials,
    methods: config.cors.methods,
    allowedHeaders: config.cors.allowedHeaders,
    exposedHeaders,
  };
  cors(corsOptions)(req, res, next);
});

// Response compression (threshold: 1KB)
app.use(compression({ threshold: 1024 }) as unknown as express.RequestHandler);

// Body parsing
app.use(express.json());

// Paths excluded from observability/request-ID wrapping (health probes, metrics)
const observabilityExcludePaths = ['/health', '/health/ready', '/metrics'];

// Request ID correlation
app.use(requestIdMiddleware({ excludePaths: observabilityExcludePaths }));

// Observability context (W3C traceparent, traceId propagation via AsyncLocalStorage)
app.use(
  createObservabilityMiddleware({
    runWithContext: (ctx, fn) => runWithObservabilityContext(ctx, fn),
    excludePaths: observabilityExcludePaths,
  }),
);

// Health check
app.use('/health', healthRouter);

// Readiness probe — fails during shutdown or if database is unavailable
app.get('/health/ready', (_req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ ok: false, reason: 'shutting_down' });
  }
  if (!isDatabaseAvailable()) {
    return res.status(503).json({ ok: false, reason: 'database_not_ready' });
  }
  return res.json({ ok: true });
});

// Per-tenant rate limiting — after auth (applied per-route) so tenant context is available
import { searchAiRateLimit } from './middleware/rate-limit.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.use('/api', searchAiRateLimit() as any);

// End-user dynamic CORS (before auth — handles OPTIONS preflight)
app.use('/api/search', createEndUserCorsMiddleware());

// Path B: OAuth redirect/PKCE flow (no platform auth required — public endpoints)
// MUST be mounted BEFORE the general auth router (Express matches top-down)
import { createAuthOAuthRouter } from './routes/auth-oauth.js';
app.use('/api/search/auth/oauth', createAuthOAuthRouter());

// End-user auth routes (no platform auth required)
app.use('/api/search/auth', createAuthRouter());

// Search routes under /api/search prefix
// Query router is created with default pipeline initially.
// After ServiceContainer init, it gets replaced with the unified pipeline (see startServer).
app.use('/api/search', createQueryRouter());
app.use('/api/search', createStructuredRouter());
app.use('/api/search', createAggregateRouter());
app.use('/api/search', suggestRouter);
app.use('/api/search', createSimilarRouter());
app.use('/api/search', resolveRouter);
app.use('/api/search', discoverRouter);
app.use('/api/search', createInteractionsRouter());
app.use('/api/search', createBrowseRouter());

// Agent Integration routes under /api/agent prefix (API-7, API-8)
app.use('/api/agent', agentIntegrationRouter);
// Capability Management routes under /api/agent prefix (API-11 to API-16)
app.use('/api/agent', capabilitiesRouter);
// Vocabulary Management routes under /api/agent prefix (API-1 to API-6)
app.use('/api/agent', vocabularyRouter);

// IdP sync routes under /api/idp prefix (Phase 2B: IdP Authentication)
app.use('/api/idp/sync', idpSyncRouter);

// Metrics routes (Prometheus + JSON)
app.use(metricsRouter);

// ─── Internal API: cache invalidation (called by search-ai after publish) ─────
app.post('/api/internal/invalidate-embedding-cache', (req, res) => {
  const { indexId, tenantId } = req.body ?? {};
  const resolver = serviceContainer.getEmbeddingProviderResolver();
  if (!resolver) {
    return res.status(503).json({ error: 'Resolver not initialized' });
  }
  if (indexId && tenantId) {
    resolver.invalidate(indexId, tenantId);
  } else if (tenantId) {
    resolver.invalidateTenant(tenantId);
  } else {
    resolver.clear();
  }
  return res.json({ ok: true, invalidated: indexId || tenantId || 'all' });
});

// ─── Internal API: pipeline + discovery cache invalidation ──────────────────
// Called by search-ai when queryLLMConfig or searchDefaults change.
// Ensures the next search request picks up the new config immediately.
import { invalidatePipelineCache } from './routes/shared-pipeline.js';
import { invalidateDiscoveryCache } from './routes/discover.js';
import { invalidateOwnershipCache } from './middleware/verify-index-ownership.js';

app.post('/api/internal/invalidate-pipeline-cache', (req, res) => {
  const { indexId, tenantId } = req.body ?? {};
  if (indexId && tenantId) {
    invalidatePipelineCache(tenantId, indexId);
    invalidateDiscoveryCache(indexId);
    invalidateOwnershipCache(tenantId, indexId);
    return res.json({ ok: true, invalidated: `${tenantId}:${indexId}` });
  }
  return res.status(400).json({ error: 'indexId and tenantId required' });
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Server error', { error: err.message, stack: err.stack });
  res
    .status(500)
    .json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
});

// =============================================================================
// HTTP SERVER
// =============================================================================

const server = createServer(app);

// Connection timeouts — prevent indefinite hangs from long search/LLM requests
server.timeout = 300_000; // 5 min max request duration (Docker service calls can take up to 5 min)
server.keepAliveTimeout = 65_000; // slightly above typical ALB 60s idle timeout
server.headersTimeout = 70_000; // must be > keepAliveTimeout per Node.js docs

// =============================================================================
// START SERVER
// =============================================================================

export async function startServer(): Promise<void> {
  const config = getConfigLazy();
  const port = config.server.port || 3004;
  const host = config.server.host || '0.0.0.0';

  // ─── Database Initialization (MongoDB) ──────────────────────────────────
  try {
    const sharedMongoOptions = {
      enabled: true as const,
      minPoolSize: parseInt(process.env.MONGODB_MIN_POOL_SIZE || '2', 10),
      maxPoolSize: parseInt(process.env.MONGODB_MAX_POOL_SIZE || '10', 10),
      maxIdleTimeMs: 30000,
      connectTimeoutMs: 10000,
      socketTimeoutMs: 45000,
      serverSelectionTimeoutMs: 10000,
      heartbeatFrequencyMs: 10000,
      tls: process.env.MONGODB_TLS === 'true',
      tlsAllowInvalidCertificates: process.env.MONGODB_TLS_ALLOW_INVALID === 'true',
      authSource: process.env.MONGODB_AUTH_SOURCE || 'admin',
      writeConcern: (process.env.MONGODB_WRITE_CONCERN as 'majority' | '1' | '0') || 'majority',
      readPreference: (process.env.MONGODB_READ_PREFERENCE as 'primary') || 'primary',
      retryWrites: true,
      retryReads: true,
      // Local dev mongo (docker) advertises a replica-set host that's not
      // reachable from the host network; with directConnection=false, the
      // driver follows the advertised host and times out. Default to true
      // (matching the local-dev URL's ?directConnection=true query param)
      // unless explicitly disabled in production.
      directConnection: (process.env.MONGODB_DIRECT_CONNECTION ?? 'true') === 'true',
      autoIndex: process.env.NODE_ENV !== 'production',
      slowQueryThresholdMs: parseInt(process.env.MONGODB_SLOW_QUERY_MS || '200', 10),
    };

    await initMongoBackend({
      platformDb: {
        ...sharedMongoOptions,
        url:
          process.env.PLATFORM_MONGO_URL ||
          process.env.MONGODB_URL ||
          'mongodb://abl_admin:abl_dev_password@localhost:27018/abl_platform?authSource=admin&directConnection=true',
        database:
          process.env.PLATFORM_MONGO_DATABASE || process.env.MONGODB_DATABASE || 'abl_platform',
        appName: 'search-ai-runtime-platform',
      },
      contentDb: {
        ...sharedMongoOptions,
        url:
          process.env.SEARCH_AI_MONGO_URL ||
          process.env.MONGODB_URL ||
          'mongodb://abl_admin:abl_dev_password@localhost:27018/search_ai?authSource=admin&directConnection=true',
        database: process.env.SEARCH_AI_MONGO_DATABASE || 'search_ai',
        appName: 'search-ai-runtime-content',
      },
    });
    logger.info('Dual-database initialized (abl_platform + search_ai)');

    // Set the Mongoose encryption plugin master key
    const encMasterKey =
      process.env.ENCRYPTION_ENABLED !== 'false' ? process.env.ENCRYPTION_MASTER_KEY : undefined;
    if (!encMasterKey) {
      throw new Error('ENCRYPTION_MASTER_KEY is required for search-ai-runtime startup');
    }

    const { setMasterKey } = await import('@agent-platform/database/models');
    setMasterKey(encMasterKey);
    logger.info('Mongoose field encryption master key set');

    try {
      const { initDEKFacade } = await import('@agent-platform/database/kms');
      await initDEKFacade({ masterKeyHex: encMasterKey, logger });
      logger.info('DEK facade initialized');
    } catch (tenantEncError) {
      throw new Error(
        `[search-ai-runtime] DEK facade initialization failed: ${tenantEncError instanceof Error ? tenantEncError.message : String(tenantEncError)}`,
      );
    }
  } catch (error) {
    logger.error('MongoDB initialization failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  // ─── Redis Initialization ─────────────────────────────────────────────
  // Initialize global Redis client for JWKS caching, OAuth state, and auth profile caching.
  // Uses @agent-platform/redis which is cluster-aware (REDIS_CLUSTER=true).
  try {
    const { createRedisConnection, resolveRedisOptionsFromEnv } =
      await import('@agent-platform/redis');
    const redisOpts = resolveRedisOptionsFromEnv();
    if (redisOpts) {
      const handle = createRedisConnection({ ...redisOpts, lazyConnect: false });
      handle.client.on('error', (err: Error) => {
        logger.warn('Global Redis client error', { error: err.message });
      });
      const { setGlobalRedisClient } = await import('./services/cache/redis-client.js');
      setGlobalRedisClient(handle.client);
      logger.info('Global Redis client initialized');
    } else {
      logger.warn(
        'Redis disabled (REDIS_ENABLED=false) — OAuth state and auth profile caching unavailable',
      );
    }
  } catch (redisError) {
    logger.warn('Redis initialization failed — degraded mode (no caching)', {
      error: redisError instanceof Error ? redisError.message : String(redisError),
    });
  }

  // ─── ClickHouse Initialization (optional) ───────────────────────────────
  if (process.env.CLICKHOUSE_URL || process.env.CLICKHOUSE_HOST) {
    try {
      // ClickHouse schema DDL is now handled by the centralized PreSync CLI.
      // Transitional safety net: verify tables exist, run init as fallback if not.
      const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
      const { ensureClickHouseSchemaReady } =
        await import('@agent-platform/database/clickhouse-schemas/init-all');
      const chClient = getClickHouseClient({
        url: process.env.CLICKHOUSE_URL || process.env.CLICKHOUSE_HOST,
        username: process.env.CLICKHOUSE_USER,
        password: process.env.CLICKHOUSE_PASSWORD,
        database: process.env.CLICKHOUSE_DATABASE,
      });
      await ensureClickHouseSchemaReady(chClient);
      clickhouseReady = true;

      // Initialize query store for search analytics recording
      const { initQueryStore } = await import('./services/stores/query-store-singleton.js');
      initQueryStore(chClient);

      logger.info('[search-ai-runtime] ClickHouse client ready');
    } catch (error) {
      console.warn(
        '[search-ai-runtime] ClickHouse initialization failed — analytics stores unavailable:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // ─── Service Container Initialization ───────────────────────────────────
  try {
    // Initialize LLM client (using default configuration)
    // In production, this would use tenant-specific credentials
    const llmClient = new WorkerLLMClient(
      'anthropic',
      process.env.ANTHROPIC_API_KEY || '',
      'claude-3-5-sonnet-20241022',
    );

    // Initialize embedding provider (using configured provider from environment)
    // Supports BGE-M3, OpenAI, Cohere, and custom providers via getEmbeddingProvider()
    const embeddingProvider = getEmbeddingProvider();

    // Initialize service container
    serviceContainer.initialize({
      llmClient,
      embeddingProvider,
    });

    console.log('[search-ai-runtime] Service container initialized');

    // Wire unified pipeline options for query routes
    // The unified pipeline can now use DynamicVocabularyResolver + HybridSearchBuilder
    // for all 4 query types (structured, semantic, hybrid, aggregation)
    const pipelineOptions = serviceContainer.getPipelineOptions();
    console.log('[search-ai-runtime] Unified pipeline options available:', {
      dynamicVocabularyResolver: !!pipelineOptions.dynamicVocabularyResolver,
      hybridSearchBuilder: !!pipelineOptions.hybridSearchBuilder,
    });
  } catch (error) {
    console.warn(
      '[search-ai-runtime] Service container initialization failed — unified pipeline unavailable:',
      error instanceof Error ? error.message : String(error),
    );
  }

  // ─── MongoDB Permission Store Initialization (replaces Neo4j) ────────────
  try {
    const { MongoPermissionStore } = await import('@agent-platform/search-ai-internal/permissions');

    // Runtime only needs blindIndexFn for getUserGroups lookups.
    // Build a lightweight blind-index function using the master key.
    const masterKeyHex = process.env.ENCRYPTION_MASTER_KEY;
    if (masterKeyHex) {
      const crypto = await import('node:crypto');
      const blindIndexFn = (tenantId: string, value: string): string => {
        const key = Buffer.from(
          crypto.hkdfSync(
            'sha512',
            Buffer.from(masterKeyHex, 'hex'),
            `blind:${tenantId}`,
            'blind-index-key',
            32,
          ),
        );
        return crypto.createHmac('sha256', key).update(value).digest('hex');
      };

      // Runtime doesn't create contacts, so encryptFn is not needed.
      // We pass a minimal contactModel since runtime only calls getUserGroups.
      const { Contact, AclGroupHierarchy, AclDocumentPermissions } =
        await import('@agent-platform/database/models');

      MongoPermissionStore.getInstance({
        contactModel: Contact as any,
        groupHierarchyModel: AclGroupHierarchy as any,
        documentPermissionsModel: AclDocumentPermissions as any,
        blindIndexFn,
      });
      logger.info('MongoDB Permission Store initialized for runtime (replaces Neo4j)');
    } else {
      logger.warn(
        'ENCRYPTION_MASTER_KEY not set — permission filtering unavailable (no blind index)',
      );
    }
  } catch (error) {
    logger.warn(
      'MongoDB Permission Store initialization failed — permission filtering unavailable',
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      console.log(`
╔════════════════════════════════════════════════════════════╗
║           SearchAI Runtime Server                            ║
╠════════════════════════════════════════════════════════════╣
║  HTTP API:    http://${host}:${port}                           ║
║  Health:      http://${host}:${port}/health                    ║
╠════════════════════════════════════════════════════════════╣
║  Search Endpoints:                                         ║
║    POST /api/search/:indexId/query       Vector/hybrid     ║
║    POST /api/search/:indexId/structured  Structured        ║
║    POST /api/search/:indexId/aggregate   Aggregation       ║
║    POST /api/search/:indexId/suggest     Autocomplete      ║
║    POST /api/search/:indexId/similar     Similar docs      ║
║    POST /api/search/:indexId/resolve     Vocabulary        ║
╚════════════════════════════════════════════════════════════╝
`);
      resolve();
    });
  });
}

// =============================================================================
// GRACEFUL SHUTDOWN
// =============================================================================

async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  // Force exit if shutdown takes too long
  const forceTimer = setTimeout(() => {
    console.error('[search-ai-runtime] Forced shutdown after timeout');
    process.exit(1);
  }, 30_000);
  forceTimer.unref();

  try {
    console.log('[search-ai-runtime] Shutting down gracefully');

    // Close HTTP server first — stop accepting new connections
    server.keepAliveTimeout = 0;
    await new Promise<void>((resolve) => {
      let resolved = false;
      server.close(() => {
        if (!resolved) {
          resolved = true;
          console.log('[search-ai-runtime] HTTP server closed');
          resolve();
        }
      });
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          console.warn('[search-ai-runtime] HTTP server close timed out after 10s');
          resolve();
        }
      }, 10_000);
    });

    // Flush and close interaction writer before closing ClickHouse
    try {
      await interactionWriter.flush();
      await interactionWriter.close();
    } catch (err) {
      console.warn(
        '[search-ai-runtime] Interaction writer shutdown error:',
        err instanceof Error ? err.message : String(err),
      );
    }

    // Clean up backend connections
    if (clickhouseReady) {
      try {
        // Flush buffered query records before closing the client
        const { getQueryStore } = await import('./services/stores/query-store-singleton.js');
        const queryStore = getQueryStore();
        if (queryStore && typeof queryStore.close === 'function') {
          await queryStore.close();
        }
        const { closeClickHouseClient } = await import('@agent-platform/database/clickhouse');
        await closeClickHouseClient();
      } catch (err) {
        console.warn(
          '[search-ai-runtime] ClickHouse close error during shutdown:',
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    try {
      await disconnectDatabase();
    } catch (err) {
      console.warn(
        '[search-ai-runtime] MongoDB disconnect error during shutdown:',
        err instanceof Error ? err.message : String(err),
      );
    }

    process.exit(0);
  } catch (err) {
    console.error(
      '[search-ai-runtime] Shutdown error, forcing exit:',
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { app, server, clickhouseReady, isDatabaseAvailable };

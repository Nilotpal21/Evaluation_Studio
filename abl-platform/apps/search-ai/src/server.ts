/**
 * SearchAI Express Server
 *
 * Handles search index management, source ingestion, schema mapping,
 * and job orchestration. Includes WebSocket support for real-time progress.
 */

import express, { type Express, type RequestHandler } from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import indexesRouter from './routes/indexes.js';
import sourcesRouter from './routes/sources.js';
import schemasRouter from './routes/schemas.js';
import mappingsRouter from './routes/mappings.js';
import jobsRouter from './routes/jobs.js';
import knowledgeBasesRouter from './routes/knowledge-bases.js';
import documentsRouter from './routes/documents.js';
import documentUploadRouter from './routes/document-upload.js';
import documentDownloadRouter from './routes/document-download.js';
import chunksRouter from './routes/chunks.js';
import vocabularyRouter from './routes/vocabulary.js';
import createAttributesRouter from './routes/attributes.js';
import healthRouter from './routes/health.js';
import adminRouter from './routes/admin.js';
import structuredDataIngestRouter from './routes/structured-data-ingest.js';
import structuredDataQueryRouter from './routes/structured-data-query.js';
import jsonFieldConfigRouter from './routes/json-field-config.js';
// KG routes
import kgEnrichmentRouter from './routes/kg-enrichment.js';
import kgTaxonomyRouter from './routes/kg-taxonomy.js';
// Crawler routes
import crawlRouter, { closeCrawlQueue } from './routes/crawl.js';
import crawlerIngestionRouter from './routes/crawler-ingestion.js';
import crawlPreviewRouter from './routes/crawl-preview.js';
// Discovery routes (unified site discovery with SSE proxy)
import discoveryRouter from './routes/discovery.js';
// Intelligence analysis route
import { intelligenceRouter } from './routes/intelligence.js';
// Enterprise connector routes
import connectorRouter from './routes/connectors.js';
// Connector discovery routes
import connectorDiscoveryRouter from './routes/connector-discovery.js';
// Connector field configuration routes (pre-sync field mapping)
import connectorFieldConfigRouter from './routes/connector-field-config.js';
// Connector audit log routes
import connectorAuditRouter from './routes/connector-audit.js';
// Connector config version routes
import connectorConfigVersionRouter from './routes/connector-config-versions.js';
// Connector proposal routes
import connectorProposalRouter from './routes/connector-proposal.js';
// Connector security routes (Wave 4)
import connectorSecurityRouter from './routes/connector-security.js';
// Connector content purge routes (Wave 4)
import connectorContentPurgeRouter from './routes/connector-content-purge.js';
// Connector presence routes (Wave 4)
import connectorPresenceRouter from './routes/connector-presence.js';
// Connector policy routes (Wave 4)
import connectorPolicyRouter from './routes/connector-policy.js';
// Connector config management routes (Wave 4)
import connectorConfigMgmtRouter from './routes/connector-config-mgmt.js';
// Connector multi-connector routes (Wave 4 — clone, template, import)
import connectorMultiRouter from './routes/connector-multi.js';
// Connector monitoring routes (Wave 3)
import connectorMonitoringRouter from './routes/connector-monitoring.js';
// Connector notification routes (Wave 3)
import connectorNotificationsRouter from './routes/connector-notifications.js';
// Connector error recovery routes (Wave 3)
import connectorErrorRecoveryRouter from './routes/connector-error-recovery.js';
// Connector utility routes (Wave 3)
import connectorUtilitiesRouter from './routes/connector-utilities.js';
// Circuit breaker status route
import circuitStatusRouter from './routes/circuit-status.js';
// Webhook routes (Microsoft Graph notifications — unauthenticated, mounted before auth)
import webhooksRouter from './routes/webhooks.js';
// Citation download route (JWT-authenticated, mounted before auth middleware)
import { createCitationDownloadRouter } from './routes/citation-download.js';
import { getRedisConnection } from './workers/shared.js';
import type { RedisClient } from '@agent-platform/redis';
// Pipeline configuration routes
import pipelinesRouter from './routes/pipelines.js';
import pipelineTriggersRouter from './routes/pipeline-triggers.js';
// Analytics routes
import analyticsRouter from './routes/analytics.js';
// Query history routes
import queryHistoryRouter from './routes/query-history.js';
import { initMongoBackend, isDatabaseAvailable, disconnectDatabase } from './db/index.js';
import { getConfig } from './config/index.js';
import {
  requestIdMiddleware,
  createObservabilityMiddleware,
} from '@agent-platform/shared-observability';
import { runWithObservabilityContext } from '@abl/compiler/platform/observability';
import { createLogger } from '@abl/compiler/platform';
import { loadServiceChangeCompatibility } from '@agent-platform/database';
import { authMiddleware } from './middleware/auth.js';
import { searchAiRateLimit } from './middleware/rate-limit.js';
import { getClickHouseClient, closeClickHouseClient } from '@agent-platform/database/clickhouse';
import { ensureClickHouseSchemaReady } from '@agent-platform/database/clickhouse-schemas/init-all';
import { startWorkers, stopWorkers, getWorkerCount } from './workers/index.js';
import { registerAllProviders } from './services/provider-registry/providers/register-providers.js';
import { closeAllQueues } from './queues/index.js';
import { initProgressWebSocket, closeProgressSubscriptions } from './routes/progress.js';
import { getSearchAiChangeRequirement } from './change-management/requirements.js';
import { createSearchAiReadinessHandler } from './change-management/readiness.js';
import {
  initTaxonomyGraphService,
  closeTaxonomyGraphService,
} from './services/knowledge-graph/taxonomy-graph.service.js';

// =============================================================================
// EXPRESS APP
// =============================================================================

const app: Express = express();
const logger = createLogger('search-ai-server');
const getConfigLazy = () => getConfig();
let clickhouseReady = false;

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

// Body parsing (50mb limit for file uploads)
app.use(express.json({ limit: '50mb' }));

// Paths excluded from observability/request-ID wrapping (health probes, metrics)
const observabilityExcludePaths = ['/health', '/health/ready', '/metrics'];

// Request correlation ID
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

// Readiness probe — fails during shutdown, if databases are unavailable,
// or when required change-management entries are missing.
app.get(
  '/health/ready',
  createSearchAiReadinessHandler({
    isShuttingDown: () => isShuttingDown,
    isDatabaseReady: () => isDatabaseAvailable(),
    loadCompatibility: async () => {
      if (!isDatabaseAvailable()) {
        return null;
      }

      const mongoose = (await import('mongoose')).default;
      const db = mongoose.connection.db;
      if (!db) {
        return null;
      }

      return loadServiceChangeCompatibility(db, getSearchAiChangeRequirement());
    },
    onHardFail: (result) => {
      logger.error('SearchAI change compatibility requires hard fail handling', {
        blockers: result.blockingIssues,
      });
    },
  }),
);

// Development auth bypass (only when DEV_BYPASS_AUTH=true)
if (process.env.NODE_ENV === 'development' && process.env.DEV_BYPASS_AUTH === 'true') {
  const { devAuthBypass } = await import('./middleware/dev-auth.js');
  app.use(devAuthBypass);
  logger.info('Development auth bypass enabled (DEV_BYPASS_AUTH=true)');
}

// Webhook endpoints — mounted BEFORE auth middleware because external providers
// (e.g. Microsoft Graph) send unauthenticated HTTP requests. Authenticity is
// verified via encrypted clientState, not bearer tokens.
app.use('/api/webhooks', webhooksRouter);

// Document download — mounted BEFORE auth middleware because Custom API webhooks
// send unauthenticated requests. Authenticity is verified via HMAC-signed token
// in the query parameter (scoped to documentId + tenantId, expires in 15 min).
app.use(documentDownloadRouter);

// Citation download endpoint — mounted BEFORE auth middleware because citation
// tokens are self-authenticating JWTs. The token IS the authentication.
// Shared citation service instances (lazy-initialized, cached)
let citationRedis: RedisClient | null = null;
app.use(
  '/api/citations',
  createCitationDownloadRouter({
    getRedis: () => {
      if (!citationRedis) {
        citationRedis = getRedisConnection();
      }
      return citationRedis;
    },
  }),
);

// Authentication — all /api routes require verified credentials
// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.use('/api', authMiddleware as any);

// Per-tenant rate limiting — after auth so tenant context is available
// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.use('/api', searchAiRateLimit() as any);

// Admin routes
app.use('/api/admin', adminRouter);

// API routes
app.use('/api/indexes', indexesRouter);
app.use('/api/indexes', sourcesRouter);
app.use('/api/schemas', schemasRouter);
app.use('/api/mappings', mappingsRouter);
app.use('/api/jobs', jobsRouter);
app.use('/api/knowledge-bases', knowledgeBasesRouter);
// documentUploadRouter must be first — it has static routes (e.g. /documents/status)
// that would be swallowed by documentsRouter's /:documentId param
app.use('/api/indexes', documentUploadRouter);
app.use('/api/indexes', documentsRouter);
app.use('/api/indexes', chunksRouter);
app.use('/api/indexes', vocabularyRouter);
app.use('/api/indexes', createAttributesRouter());
app.use('/api/indexes', structuredDataIngestRouter);
app.use('/api/indexes', structuredDataQueryRouter);
app.use('/api/indexes', jsonFieldConfigRouter);
// KG endpoints
app.use('/api/indexes', kgEnrichmentRouter);
app.use('/api/indexes', kgTaxonomyRouter);
// Crawler endpoints
app.use('/api/crawl', intelligenceRouter);
app.use('/api/crawl', crawlRouter);
app.use('/api/crawl', crawlPreviewRouter);
// Discovery routes (mounted at /api/crawl — routes use /discovery/* prefix internally)
app.use('/api/crawl', discoveryRouter);
app.use('/api/crawler', crawlerIngestionRouter);
// Enterprise connector endpoints (dual-mount pattern intentional)
// - Index-scoped: POST /indexes/:indexId/connectors (create, list) → used by Studio UI
// - Direct: POST /connectors/:connectorId/auth/* (OAuth, sync) → used by ingress routing
// Both mounts required — see docs/architecture/searchai-routing-architecture.md
app.use('/api/indexes', connectorRouter);
app.use('/api', connectorRouter);
// Connector audit log endpoints
app.use('/api/indexes', connectorAuditRouter);
// Connector config version endpoints
app.use('/api/indexes', connectorConfigVersionRouter);
// Connector proposal endpoints
app.use('/api/indexes', connectorProposalRouter);
// Connector discovery & recommendation endpoints
app.use('/api', connectorDiscoveryRouter);
// Connector field configuration endpoints (pre-sync field mapping)
app.use('/api/indexes', connectorFieldConfigRouter);
// Connector security endpoints (Wave 4)
app.use('/api/indexes', connectorSecurityRouter);
// Connector content purge endpoints (Wave 4)
app.use('/api/indexes', connectorContentPurgeRouter);
// Connector presence endpoints (Wave 4)
app.use('/api/indexes', connectorPresenceRouter);
// Connector policy endpoints (Wave 4)
app.use('/api/indexes', connectorPolicyRouter);
// Connector config management endpoints (Wave 4 — export, drift, import)
app.use('/api/indexes', connectorConfigMgmtRouter);
// Connector multi-connector endpoints (Wave 4 — clone, template, import)
app.use('/api/indexes', connectorMultiRouter);
// Connector monitoring endpoints (Wave 3 — overview, content-breakdown, sync-history, permission-schedule)
app.use('/api/indexes', connectorMonitoringRouter);
// Connector notification endpoints (Wave 3)
app.use('/api/indexes', connectorNotificationsRouter);
// Connector error recovery endpoints (Wave 3)
app.use('/api/indexes', connectorErrorRecoveryRouter);
// Connector utility endpoints (Wave 3 — site-statuses, filter-analysis, check-site-access)
app.use('/api/indexes', connectorUtilitiesRouter);

// Pipeline configuration
app.use(pipelinesRouter);
app.use(pipelineTriggersRouter);

// Query history endpoints
app.use('/api/indexes/:indexId/query-history', queryHistoryRouter);

// Analytics endpoints
app.use('/api/search-ai/analytics', analyticsRouter);

// Circuit breaker status (mounted under /api/search-ai/mappings for admin UI)
app.use('/api/search-ai/mappings', circuitStatusRouter);

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

// Connection timeouts — prevent indefinite hangs from long LLM/upload requests
server.timeout = 300_000; // 5 min max request duration (Docker service calls can take up to 5 min)
server.keepAliveTimeout = 65_000; // slightly above typical ALB 60s idle timeout
server.headersTimeout = 70_000; // must be > keepAliveTimeout per Node.js docs

// Initialize WebSocket server for real-time progress updates
const wss = initProgressWebSocket(server);

// =============================================================================
// EXPORTS
// =============================================================================

export async function startServer(): Promise<void> {
  const config = getConfigLazy();
  const port = config.server.port || 3005;
  const host = config.server.host || '0.0.0.0';

  // ─── Provider Registry Initialization ────────────────────────────────────
  const { registerStubProviders } = await import('./providers/stub-providers.js');
  registerStubProviders();
  logger.info('Registered stub providers for pipeline validation');

  // ─── Database Initialization (Dual MongoDB) ─────────────────────────────
  try {
    await initMongoBackend({
      // Platform DB (abl_platform) - application config
      platformDb: {
        enabled: true,
        url:
          (config.database as any).url ||
          (config.database as any).uri ||
          process.env.MONGODB_URL ||
          `mongodb://abl_admin:abl_dev_password@localhost:27018/abl_platform?authSource=admin&directConnection=true`,
        database:
          (config.database as any).database ||
          (config.database as any).name ||
          process.env.MONGODB_DATABASE ||
          'abl_platform',
        minPoolSize: (config.database as any).minPoolSize || 10,
        maxPoolSize: (config.database as any).maxPoolSize || 100,
        maxIdleTimeMs: 30000,
        connectTimeoutMs: 30000,
        socketTimeoutMs: (config.database as any).socketTimeoutMS || 60000,
        serverSelectionTimeoutMs: (config.database as any).serverSelectionTimeoutMS || 30000,
        heartbeatFrequencyMs: (config.database as any).heartbeatFrequencyMS || 10000,
        tls: process.env.MONGODB_TLS === 'true',
        tlsAllowInvalidCertificates: false,
        authSource: process.env.MONGODB_AUTH_SOURCE || 'admin',
        writeConcern: '1',
        readPreference: 'primary',
        retryWrites: true,
        retryReads: true,
        directConnection: process.env.MONGODB_DIRECT_CONNECTION === 'true',
        autoIndex: true,
        slowQueryThresholdMs: 100,
        appName: 'search-ai',
      },
      // Content DB (search_ai) - search content
      contentDb: {
        enabled: true,
        url:
          process.env.SEARCHAI_CONTENT_URI ||
          process.env.MONGODB_URL ||
          config.searchaiContentDb.uri,
        database: process.env.SEARCH_AI_MONGO_DATABASE || config.searchaiContentDb.database,
        minPoolSize: config.searchaiContentDb.minPoolSize || 10,
        maxPoolSize: config.searchaiContentDb.maxPoolSize || 50,
        maxIdleTimeMs: 30000,
        connectTimeoutMs: 30000,
        socketTimeoutMs: config.searchaiContentDb.socketTimeoutMs || 60000,
        serverSelectionTimeoutMs: config.searchaiContentDb.serverSelectionTimeoutMs || 30000,
        heartbeatFrequencyMs: 10000,
        tls: process.env.MONGODB_TLS === 'true',
        tlsAllowInvalidCertificates: false,
        authSource: process.env.MONGODB_AUTH_SOURCE || 'admin',
        writeConcern: '1',
        readPreference: 'primary',
        retryWrites: true,
        retryReads: true,
        directConnection: process.env.MONGODB_DIRECT_CONNECTION === 'true',
        autoIndex: true,
        slowQueryThresholdMs: 100,
        appName: 'search-ai',
      },
    });
    console.log('[search-ai] Dual MongoDB connections initialized');

    // Wait for connections to be fully stable before starting workers
    // This prevents buffering timeout errors when workers immediately try to query
    await new Promise((resolve) => setTimeout(resolve, 2000));
    console.log('[search-ai] Database connections stabilized');

    // Set the Mongoose encryption plugin master key — required to decrypt
    // LLMCredential.encryptedApiKey when resolving tenant model credentials
    // for LLM-gated workers (question synthesis, scope classification, etc.)
    const encMasterKey =
      process.env.ENCRYPTION_ENABLED !== 'false' ? process.env.ENCRYPTION_MASTER_KEY : undefined;
    if (!encMasterKey) {
      throw new Error('ENCRYPTION_MASTER_KEY is required for search-ai startup');
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
        `[search-ai] DEK facade initialization failed: ${tenantEncError instanceof Error ? tenantEncError.message : String(tenantEncError)}`,
      );
    }
  } catch (error) {
    logger.error('MongoDB initialization failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error; // Fatal — cannot start without DB
  }

  // ─── ClickHouse Initialization (optional) ───────────────────────────────
  if (process.env.CLICKHOUSE_URL || process.env.CLICKHOUSE_HOST) {
    try {
      const chClient = getClickHouseClient({
        url: process.env.CLICKHOUSE_URL || process.env.CLICKHOUSE_HOST,
        username: process.env.CLICKHOUSE_USER,
        password: process.env.CLICKHOUSE_PASSWORD,
        database: process.env.CLICKHOUSE_DATABASE,
      });
      // ClickHouse schema DDL is now handled by the centralized PreSync CLI.
      // Transitional safety net: verify tables exist, run init as fallback if not.
      await ensureClickHouseSchemaReady(chClient);
      clickhouseReady = true;
    } catch (error) {
      console.warn(
        '[search-ai] ClickHouse initialization failed — analytics stores unavailable:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // ─── MongoDB Permission Store (replaces Neo4j) ─────────────────────────
  try {
    const { MongoPermissionStore } = await import('@agent-platform/search-ai-internal/permissions');
    const { Contact, AclGroupHierarchy, AclDocumentPermissions } =
      await import('@agent-platform/database/models');
    const { createBlindIndexFn, createEncryptFn } = await import('./workers/shared.js');

    MongoPermissionStore.getInstance({
      contactModel: Contact as any,
      groupHierarchyModel: AclGroupHierarchy as any,
      documentPermissionsModel: AclDocumentPermissions as any,
      blindIndexFn: createBlindIndexFn(),
      encryptFn: createEncryptFn(),
    });
    logger.info('MongoDB Permission Store initialized (replaces Neo4j)');
  } catch (error) {
    logger.warn(
      'MongoDB Permission Store initialization failed — document permissions unavailable',
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }

  // ─── Neo4j Taxonomy Graph (singleton driver) ────────────────────────────
  try {
    await initTaxonomyGraphService();
    logger.info('Taxonomy graph service initialized');
  } catch (error) {
    logger.warn('Taxonomy graph service initialization failed — KG graph queries unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // ─── Structured Data Analysis Cache (Redis) ─────────────────────────────
  if (process.env.REDIS_URL || process.env.REDIS_HOST) {
    try {
      const { AnalysisCacheService } = await import('./services/structured-data/analysis-cache.js');
      const redisUrl =
        process.env.REDIS_URL ||
        `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}`;
      await AnalysisCacheService.initialize(redisUrl);
      console.log('[search-ai] Structured data analysis cache initialized');
    } catch (error) {
      console.warn(
        '[search-ai] Failed to initialize analysis cache:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // ─── Pipeline Provider Registry ─────────────────────────────────────────
  try {
    const providerCount = registerAllProviders();
    console.log(`[search-ai] Registered ${providerCount} pipeline providers`);
  } catch (error) {
    console.warn(
      '[search-ai] Failed to register pipeline providers:',
      error instanceof Error ? error.message : String(error),
    );
  }

  // ─── Ingestion Pipeline Workers (BullMQ) ───────────────────────────────
  if (process.env.REDIS_URL || process.env.REDIS_HOST) {
    try {
      const concurrency = parseInt(process.env.INGESTION_MAX_CONCURRENT_JOBS || '5', 10);
      await startWorkers(concurrency);
      console.log('[search-ai] Ingestion pipeline workers started');
    } catch (error) {
      console.warn(
        '[search-ai] Failed to start ingestion workers:',
        error instanceof Error ? error.message : String(error),
      );
    }
  } else {
    console.log('[search-ai] Redis not configured — ingestion workers disabled');
  }

  return new Promise<void>((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(
          `[search-ai] Port ${port} is already in use. ` +
            `Kill the existing process or use a different PORT.`,
        );
        process.exit(1);
      }
      reject(err);
    });

    server.listen(port, host, () => {
      console.log(`
╔════════════════════════════════════════════════════════════╗
║           SearchAI Server                             ║
╠════════════════════════════════════════════════════════════╣
║  HTTP API:    http://${host}:${port}                           ║
║  Health:      http://${host}:${port}/health                    ║
║  WebSocket:   ws://${host}:${port}/api/admin/progress/subscribe?jobId=...  ║
╠════════════════════════════════════════════════════════════╣
║  Endpoints:                                                ║
║    CRUD /api/knowledge-bases      Knowledge base mgmt      ║
║    CRUD /api/indexes              Index management         ║
║    CRUD /api/indexes/:id/sources  Source management         ║
║    GET  /api/schemas              Schema discovery          ║
║    CRUD /api/mappings             Field mappings            ║
║    CRUD /api/jobs                 Ingestion jobs            ║
║    POST /api/crawl/batch          Web crawler jobs          ║
║    GET  /api/crawl/status         Crawl job status          ║
║    POST /api/crawler/ingest/crawled-content  Crawler ingestion  ║
║    GET  /api/crawler/ingest/status/:documentId  Ingest status  ║
║    WS   /api/admin/progress/subscribe  Real-time progress    ║
╚════════════════════════════════════════════════════════════╝
`);
      resolve();
    });
  });
}

// =============================================================================
// GRACEFUL SHUTDOWN
// =============================================================================

let isShuttingDown = false;
async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  // Force exit if shutdown takes too long (e.g. BullMQ workers stuck on long jobs)
  const forceTimer = setTimeout(() => {
    console.error('[search-ai] Forced shutdown after timeout');
    process.exit(1);
  }, 30_000);
  forceTimer.unref();

  try {
    console.log('[search-ai] Shutting down gracefully');

    // Close HTTP server FIRST to release the port immediately.
    // This allows tsx watch to bind the port on restart without EADDRINUSE.
    server.keepAliveTimeout = 0;
    await new Promise<void>((resolve) => {
      let resolved = false;
      server.close(() => {
        if (!resolved) {
          resolved = true;
          console.log('[search-ai] HTTP server closed, port released');
          resolve();
        }
      });
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          console.warn('[search-ai] HTTP server close timed out after 10s');
          resolve();
        }
      }, 10_000);
    });

    // Now clean up background resources (order doesn't matter for port)
    console.log('[resource-audit] Pre-cleanup state:', {
      workers: getWorkerCount(),
      mongoConnected: isDatabaseAvailable(),
      clickHouseReady: clickhouseReady,
    });

    await closeProgressSubscriptions();
    await stopWorkers();
    await closeCrawlQueue();
    await closeAllQueues();
    await closeClickHouseClient();
    await closeTaxonomyGraphService();
    await disconnectDatabase();

    console.log('[resource-audit] Post-cleanup state:', {
      workers: getWorkerCount(),
      mongoConnected: isDatabaseAvailable(),
      clickHouseReady: clickhouseReady,
    });

    process.exit(0);
  } catch (err) {
    console.error(
      '[search-ai] Shutdown error, forcing exit:',
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { app, server, clickhouseReady, wss };

/**
 * Multimodal Service Express Server
 *
 * Handles file upload, storage, virus scanning, and processing pipeline.
 * No voice/WebSocket — pure REST API with BullMQ job workers.
 */

import express, { type Express } from 'express';
import { createRedisConnection, resolveRedisOptionsFromEnv } from '@agent-platform/redis';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import { requestIdMiddleware } from '@agent-platform/shared';
import { createObservabilityMiddleware } from '@agent-platform/shared-observability';
import { runWithObservabilityContext } from '@abl/compiler/platform/observability';
import { Attachment } from '@agent-platform/database';
import { getConfig } from './config.js';
import { createAttachmentRouter } from './routes/attachments.js';
import { AttachmentService } from './services/multimodal-service.js';
import { UploadRateLimiter } from './security/upload-rate-limiter.js';
import { createStorageProvider } from './storage/storage-factory.js';
import { initMongoBackend, isDatabaseAvailable, disconnectDatabase } from './db/index.js';
import { initAttachmentQueues, getScanQueue, closeAttachmentQueues } from './services/queues.js';
import { Worker } from 'bullmq';
import {
  QUEUE_NAMES,
  createQueue,
  createWorkerOptions,
  type CleanupJobData,
  type ScanJobData,
  type ValidateJobData,
  type ProcessJobData,
  type IndexJobData,
} from './jobs/queues.js';
import { createCleanupWorker } from './jobs/cleanup-job.js';
import { createExpirySweep } from './jobs/expiry-sweep-job.js';
import { createScanWorker } from './jobs/scan-job.js';
import { createValidateWorker } from './jobs/validate-job.js';
import { createProcessWorker } from './jobs/process-job.js';
import { createIndexWorker } from './jobs/index-job.js';
import { ClamAVScanner } from './security/clamav-scanner.js';
import { TikaParser } from './processing/document-parser-tika.js';
import { WhisperTranscriber } from './processing/transcriber-whisper.js';
import { ImageProcessor } from './processing/image-processor.js';
import { FFmpegVideoProcessor } from './processing/video-processor-ffmpeg.js';
import { createLogger } from '@abl/compiler/platform';
import { TenantConfigService } from './services/tenant-config-service.js';
import { createAdminRouter } from './routes/admin.js';

const log = createLogger('multimodal-server');

// =============================================================================
// EXPRESS APP
// =============================================================================

const app: Express = express();
const getConfigLazy = () => getConfig();

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
  const corsOptions = {
    origin: config.env === 'production' ? config.server.frontendUrl : config.cors.origins,
    credentials: config.cors.credentials,
    methods: config.cors.methods,
    allowedHeaders: config.cors.allowedHeaders,
    exposedHeaders: config.cors.exposedHeaders,
  };
  cors(corsOptions)(req, res, next);
});

// Response compression (threshold: 1KB)
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- compression types conflict with @types/express v4
app.use(compression({ threshold: 1024 }) as any);

// Body parsing (50mb limit for file uploads)
app.use(express.json({ limit: '50mb' }));

// Request correlation ID
app.use(requestIdMiddleware());

// Observability context (W3C traceparent, traceId propagation via AsyncLocalStorage)
app.use(
  createObservabilityMiddleware({
    runWithContext: (ctx, fn) => runWithObservabilityContext(ctx, fn),
  }),
);

// Health check
app.get('/health', (_req, res) => res.json({ ok: true, service: 'multimodal-service' }));

// Readiness probe — fails during shutdown
app.get('/health/ready', (_req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ ok: false, reason: 'shutting_down' });
  }
  return res.json({ ok: true });
});

// API routes — attachment endpoints
// The router is lazy-initialized after config is loaded (startServer).
// For tests that import `app` directly, a placeholder is used until wired.
let attachmentRouterWired = false;

/** Wire the attachment routes with real dependencies. Call once at startup. */
export async function wireAttachmentRoutes(): Promise<void> {
  if (attachmentRouterWired) return;
  const config = getConfigLazy();
  const storageProvider = createStorageProvider({
    provider: config.storage.provider,
    bucket: config.storage.bucket,
    region: config.storage.region,
    endpoint: config.storage.endpoint,
    basePath: config.storage.basePath,
  });
  // When scan is disabled, skip directly to validate queue; otherwise enqueue to scan.
  // The scanQueue duck-type matches AttachmentService's { add(name, data) } interface.
  let pipelineEntryQueue: { add(name: string, data: Record<string, unknown>): Promise<unknown> };
  if (process.env.REDIS_URL || process.env.REDIS_HOST) {
    if (config.scan.enabled) {
      pipelineEntryQueue = createQueue(QUEUE_NAMES.SCAN);
    } else {
      const validateQueue = createQueue(QUEUE_NAMES.VALIDATE);
      pipelineEntryQueue = {
        async add(_name: string, data: Record<string, unknown>): Promise<void> {
          // Mark scan as skipped in DB, then enqueue validate directly
          await Attachment.findOneAndUpdate(
            { _id: data.attachmentId, tenantId: data.tenantId },
            { $set: { scanStatus: 'skipped', scannedAt: new Date() } },
          );
          void (await validateQueue.add(QUEUE_NAMES.VALIDATE, data));
        },
      };
    }
  } else {
    pipelineEntryQueue = { add: async () => {} }; // No Redis = no pipeline
  }
  const attachmentService = new AttachmentService({
    storageProvider,
    scanQueue: pipelineEntryQueue as {
      add(name: string, data: Record<string, unknown>): Promise<void>;
    },
    storageBucket: config.storage.bucket,
  });

  // Instantiate per-tenant upload rate limiter (Redis if available, memory fallback)
  let uploadRedisClient: unknown = undefined;
  const uploadRedisOpts = resolveRedisOptionsFromEnv();
  if (uploadRedisOpts) {
    try {
      const handle = createRedisConnection({
        ...uploadRedisOpts,
        maxRetriesPerRequest: 1,
        lazyConnect: true,
      });
      handle.client.on('error', (err: Error) => {
        log.warn('Upload rate-limiter Redis error', { error: err.message });
      });
      await handle.client.connect();
      uploadRedisClient = handle.client;
    } catch (err) {
      log.warn('Upload rate-limiter Redis connection failed, using memory fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
      uploadRedisClient = undefined; // memory fallback
    }
  }
  const uploadRateLimiter = new UploadRateLimiter(undefined, uploadRedisClient);

  app.use('/internal/attachments', createAttachmentRouter(attachmentService, uploadRateLimiter));
  attachmentRouterWired = true;
}

/**
 * Wire routes from a pre-built AttachmentService (for testing or custom DI).
 */
export function wireAttachmentRoutesWithService(service: AttachmentService): void {
  app.use('/internal/attachments', createAttachmentRouter(service));
}

/** Register 404 + error handlers. Must be called AFTER all routes are wired. */
function wireErrorHandlers(): void {
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      log.error('Server error', { error: err.message, stack: err.stack });
      res.status(500).json({ error: 'Internal server error' });
    },
  );
}

// =============================================================================
// HTTP SERVER
// =============================================================================

const server = createServer(app);

// Worker refs for graceful shutdown
let cleanupWorker: Worker<CleanupJobData> | null = null;
let expirySweepWorker: Worker | null = null;
let scanWorker: Worker<ScanJobData> | null = null;
let validateWorker: Worker<ValidateJobData> | null = null;
let processWorker: Worker<ProcessJobData> | null = null;
let indexWorker: Worker<IndexJobData> | null = null;

// =============================================================================
// EXPORTS
// =============================================================================

export async function startServer(): Promise<void> {
  const config = getConfigLazy();
  const port = config.server.port || 3006;
  const host = config.server.host || '0.0.0.0';

  // ─── Database Initialization (MongoDB) ──────────────────────────────────
  // (Will be wired in later tasks when routes need DB)

  // ─── Attachment Routes ────────────────────────────────────────────────
  await wireAttachmentRoutes();

  // ─── Admin Routes ───────────────────────────────────────────────────
  const configService = new TenantConfigService();
  app.use('/admin', createAdminRouter(configService));

  // ─── Error Handlers (must be after all routes) ────────────────────────
  wireErrorHandlers();

  // ─── Processing Pipeline Workers (BullMQ) ──────────────────────────────
  if (process.env.REDIS_URL || process.env.REDIS_HOST) {
    try {
      const storageProvider = createStorageProvider({
        provider: config.storage.provider,
        bucket: config.storage.bucket,
        region: config.storage.region,
        endpoint: config.storage.endpoint,
        basePath: config.storage.basePath,
      });

      // Import search producer lazily to avoid circular deps
      const { AttachmentSearchProducer } = await import('./services/attachment-search-producer.js');
      const { SearchAIClient } = await import('@agent-platform/search-ai-sdk');
      const searchClient = new SearchAIClient({
        runtimeUrl: process.env.SEARCH_RUNTIME_URL || 'http://search-ai-runtime:3004',
        engineUrl: process.env.SEARCH_AI_URL || 'http://search-ai:3005',
      });
      const searchProducer = new AttachmentSearchProducer({
        searchClient,
        indexResolver: {
          resolveForProject: async () => null, // Will be wired when search index resolution is built
        },
      });

      // ─── Initialize Processing Pipeline Providers ────────────────────────

      // ClamAV virus scanner
      const scanProvider = new ClamAVScanner({
        host: config.scan.clamavHost,
        port: config.scan.clamavPort,
      });

      // Document text extraction (Apache Tika)
      const documentParser = new TikaParser({
        tikaUrl: config.processing.tikaUrl,
      });

      // Audio transcription (Whisper)
      const transcriptionProvider = new WhisperTranscriber({
        whisperUrl: config.processing.whisperUrl,
      });

      // Image processing (sharp)
      const imageProcessor = new ImageProcessor({
        maxDimension: config.processing.imageMaxDimension,
        thumbnailSize: config.processing.thumbnailSize,
        outputFormat: 'webp',
        quality: 85,
      });

      // Video processing (FFmpeg)
      const videoProcessor = new FFmpegVideoProcessor({
        ffmpegPath: process.env.FFMPEG_PATH,
        ffprobePath: process.env.FFPROBE_PATH,
      });

      // ─── Create Pipeline Queues ──────────────────────────────────────────

      const scanQueue = createQueue(QUEUE_NAMES.SCAN);
      const validateQueue = createQueue(QUEUE_NAMES.VALIDATE);
      const processQueue = createQueue(QUEUE_NAMES.PROCESS);
      const indexQueue = createQueue(QUEUE_NAMES.INDEX);

      // ─── Pipeline Workers (scan → validate → process → index) ────────────

      // 1. Scan worker (concurrency 5)
      const scanProcessor = createScanWorker({
        storageProvider,
        scanProvider,
        validateQueue,
      });
      scanWorker = new Worker<ScanJobData>(QUEUE_NAMES.SCAN, scanProcessor, createWorkerOptions(5));

      // 2. Validate worker (concurrency 10 - fast, just magic bytes)
      const validateProcessor = createValidateWorker({
        storageProvider,
        processQueue,
      });
      validateWorker = new Worker<ValidateJobData>(
        QUEUE_NAMES.VALIDATE,
        validateProcessor,
        createWorkerOptions(10),
      );

      // 3. Process worker (concurrency 3 - CPU intensive)
      const processProcessor = createProcessWorker({
        storageProvider,
        imageProcessor,
        documentParser,
        transcriptionProvider,
        videoProcessor,
        indexQueue,
      });
      processWorker = new Worker<ProcessJobData>(
        QUEUE_NAMES.PROCESS,
        processProcessor,
        createWorkerOptions(3),
      );

      // 4. Index worker (concurrency 5)
      const indexProcessor = createIndexWorker({
        searchProducer,
      });
      indexWorker = new Worker<IndexJobData>(
        QUEUE_NAMES.INDEX,
        indexProcessor,
        createWorkerOptions(5),
      );

      // ─── Cleanup & Maintenance Workers ───────────────────────────────────

      // Cleanup worker (concurrency 3)
      const cleanupProcessor = createCleanupWorker({
        storageProvider,
        searchProducer,
        onCleanupComplete: (event) => {
          log.info('Attachment deleted', {
            type: 'attachment_delete',
            ...event,
            timestamp: new Date().toISOString(),
          });
        },
      });
      cleanupWorker = new Worker<CleanupJobData>(
        QUEUE_NAMES.CLEANUP,
        cleanupProcessor,
        createWorkerOptions(3),
      );

      // Expiry sweep (repeating hourly)
      const cleanupQueue = createQueue(QUEUE_NAMES.CLEANUP);
      const sweepFn = createExpirySweep(cleanupQueue);
      expirySweepWorker = new Worker(
        'attachment-expiry-sweep',
        async () => sweepFn(),
        createWorkerOptions(1),
      );
      // Register the repeating job
      const sweepQueue = createQueue('attachment-expiry-sweep');
      await sweepQueue.add(
        'sweep',
        {},
        {
          repeat: { every: 60 * 60 * 1000 }, // hourly
          jobId: 'expiry-sweep',
        },
      );

      log.info('BullMQ workers started', {
        workers: ['scan', 'validate', 'process', 'index', 'cleanup', 'expiry-sweep'],
      });
    } catch (err) {
      log.error('CRITICAL: Failed to start BullMQ workers — processing pipeline DISABLED', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      log.info('Server started', { host, port, url: `http://${host}:${port}` });
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
    log.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30_000);
  forceTimer.unref();

  try {
    log.info('Shutting down gracefully');

    // 1. Stop accepting new connections FIRST
    server.keepAliveTimeout = 0;
    await new Promise<void>((resolve) => {
      let resolved = false;
      server.close(() => {
        if (!resolved) {
          resolved = true;
          log.info('HTTP server closed');
          resolve();
        }
      });
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          log.warn('HTTP server close timed out after 10s');
          resolve();
        }
      }, 10_000);
    });

    // 2. Close BullMQ pipeline workers (scan → validate → process → index)
    if (scanWorker) {
      await scanWorker.close().catch((err) => {
        log.warn('Scan worker close error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    if (validateWorker) {
      await validateWorker.close().catch((err) => {
        log.warn('Validate worker close error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    if (processWorker) {
      await processWorker.close().catch((err) => {
        log.warn('Process worker close error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    if (indexWorker) {
      await indexWorker.close().catch((err) => {
        log.warn('Index worker close error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    // Close BullMQ cleanup/sweep workers
    if (cleanupWorker) {
      await cleanupWorker.close().catch((err) => {
        log.warn('Cleanup worker close error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    if (expirySweepWorker) {
      await expirySweepWorker.close().catch((err) => {
        log.warn('Expiry sweep worker close error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    // Close BullMQ queues
    try {
      await closeAttachmentQueues();
    } catch (error) {
      log.error('Error closing queues', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // 3. Close MongoDB connection
    try {
      if (isDatabaseAvailable()) {
        await disconnectDatabase();
      }
    } catch (error) {
      log.error('Error closing MongoDB', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    process.exit(0);
  } catch (err) {
    log.error('Shutdown error, forcing exit', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { app, server };

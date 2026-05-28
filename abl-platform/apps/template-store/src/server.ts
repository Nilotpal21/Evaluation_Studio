/**
 * Template Store Express Server
 *
 * Public-facing API for template browsing, publishing, and management.
 * Follows the same middleware ordering pattern as runtime/src/server.ts.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import {
  requestIdMiddleware,
  createObservabilityMiddleware,
  runWithObservabilityContext,
  createLogger,
} from '@agent-platform/shared-observability';
import healthRouter from './routes/health.js';
import marketplaceRouter from './routes/marketplace.js';
import adminRouter from './routes/admin.js';
import { errorHandler } from './middleware/error-handler.js';
import { optionalAuth, requireAuth } from './middleware/auth.js';
import { createRateLimiter } from './middleware/rate-limit.js';
import { getConfig } from './config.js';

const log = createLogger('template-store-server');

// =============================================================================
// EXPRESS APP
// =============================================================================

const app: Express = express();

// Trust one proxy hop (K8s ingress / Docker networking) so req.ip
// uses the real client IP from X-Forwarded-For for rate limiting.
app.set('trust proxy', 1);

// Security
app.use((_req, res, next) => {
  const config = getConfig();
  const helmetConfig =
    config.env === 'production'
      ? {
          contentSecurityPolicy: false, // Template Store is API-only
          crossOriginEmbedderPolicy: false,
          hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
        }
      : {
          contentSecurityPolicy: false,
          crossOriginEmbedderPolicy: false,
        };
  helmet(helmetConfig)(_req, res, next);
});

// CORS — allow marketing site + configured origins
app.use((_req, res, next) => {
  const config = getConfig();
  const corsOptions = {
    origin: config.env === 'production' ? config.corsOrigins : true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Tenant-Id'],
    exposedHeaders: ['X-Request-ID', 'X-Trace-Id'],
  };
  cors(corsOptions)(_req, res, next);
});

// Response compression (threshold: 1KB)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.use(compression({ threshold: 1024 }) as any);

// Body parsing
app.use(express.json({ limit: '10mb' }));

// Paths excluded from observability/request-ID wrapping (health probes)
const observabilityExcludePaths = ['/health', '/ready'];

// Request correlation ID
app.use(requestIdMiddleware({ excludePaths: observabilityExcludePaths }));

// Observability context (W3C traceparent, traceId propagation via AsyncLocalStorage)
app.use(
  createObservabilityMiddleware({
    runWithContext: (ctx, fn) => runWithObservabilityContext(ctx, fn),
    excludePaths: observabilityExcludePaths,
  }),
);

// ─── Routes ────────────────────────────────────────────────────────────────

// Health & readiness probes (no auth)
app.use(healthRouter);

// ─── Static Assets ──────────────────────────────────────────────────────
// Serve media assets (images, videos) for template detail pages.
// Mounted BEFORE API routes and rate limiter — no auth or rate limiting on static files.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(
  '/assets/templates',
  express.static(path.join(__dirname, '../public/assets/templates'), {
    maxAge: '1d',
    etag: true,
    lastModified: true,
  }),
);

// Marketplace routes (public browse API)
// optionalAuth: populates req.user if JWT present, continues if not
// rateLimiter: per-IP sliding window (configurable via env)
const config = getConfig();
const rateLimiter = createRateLimiter({
  windowMs: config.rateLimitWindowMs,
  maxRequests: config.rateLimitMaxRequests,
});
app.use('/api/v1/marketplace', optionalAuth, rateLimiter, marketplaceRouter);

// Admin routes (require auth)
app.use('/api/v1/admin', requireAuth, adminRouter);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: 'Not found' },
  });
});

// Error handler (must be last)
app.use(errorHandler);

// =============================================================================
// SERVER LIFECYCLE
// =============================================================================

let isShuttingDown = false;

export async function startServer(): Promise<void> {
  const config = getConfig();
  const port = config.port;
  const host = config.host;

  return new Promise((resolve) => {
    const server = app.listen(port, host, () => {
      log.info(`Template Store listening on ${host}:${port}`, { env: config.env });
      resolve();
    });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      log.info(`Received ${signal}, shutting down gracefully...`);

      server.close(async () => {
        try {
          const { disconnectDatabase } = await import('./lib/db.js');
          await disconnectDatabase();
          log.info('Database disconnected');
        } catch (err) {
          log.error('Error during shutdown', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        process.exit(0);
      });

      // Force exit after 10 seconds
      setTimeout(() => {
        log.error('Forced shutdown after timeout');
        process.exit(1);
      }, 10_000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  });
}

export { app };

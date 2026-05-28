/**
 * Academy Service Express Server
 *
 * API for Learning Academy progress tracking, quizzes, and gamification.
 * Follows the same middleware ordering pattern as template-store/src/server.ts.
 */

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
import academyRouter from './routes/academy.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler } from './middleware/error-handler.js';
import { getConfig } from './config.js';

const log = createLogger('academy-server');

// =============================================================================
// EXPRESS APP
// =============================================================================

const app: Express = express();

// Security
app.use((_req, res, next) => {
  const config = getConfig();
  const helmetConfig =
    config.env === 'production'
      ? {
          contentSecurityPolicy: false, // Academy Service is API-only
          crossOriginEmbedderPolicy: false,
          hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
        }
      : {
          contentSecurityPolicy: false,
          crossOriginEmbedderPolicy: false,
        };
  helmet(helmetConfig)(_req, res, next);
});

// CORS — allow Studio + configured origins
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

// Academy API (requires authentication)
app.use('/api/v1/academy', requireAuth, academyRouter);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
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
      log.info(`Academy Service listening on ${host}:${port}`, { env: config.env });
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

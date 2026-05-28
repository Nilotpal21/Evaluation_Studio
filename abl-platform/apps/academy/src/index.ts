/**
 * Academy Service Entry Point
 *
 * Initializes database connection and academy services, then starts the Express server.
 * Follows the same startup pattern as template-store/src/index.ts.
 */

// Load environment variables from .env file
import 'dotenv/config';

import { createLogger } from '@agent-platform/shared-observability';
import { getConfig } from './config.js';
import { initMongoBackend } from './lib/db.js';

const log = createLogger('academy-service');

async function main(): Promise<void> {
  try {
    const config = getConfig();
    log.info('Starting Academy Service', { env: config.env, port: config.port });

    // ─── Database Initialization (MongoDB) ────────────────────────────────
    try {
      await initMongoBackend(
        {
          enabled: true,
          url: config.mongoUrl,
          database: config.mongoDatabase,
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
          directConnection: process.env.MONGODB_DIRECT_CONNECTION === 'true',
          autoIndex: process.env.NODE_ENV !== 'production',
          slowQueryThresholdMs: parseInt(process.env.MONGODB_SLOW_QUERY_MS || '200', 10),
          appName: 'abl-academy-service',
        },
        config.contentRoot,
      );
      log.info('MongoDB initialized');
    } catch (error) {
      log.error('MongoDB initialization failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error; // Fatal — cannot start without DB
    }

    // ─── Start Express Server ─────────────────────────────────────────────
    const { startServer } = await import('./server.js');
    await startServer();
  } catch (error) {
    log.error('Failed to start academy service', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

main();

// Note: Graceful shutdown (server.close, DB disconnect) is handled by
// signal handlers registered in server.ts. Do NOT register competing
// handlers here that call process.exit() — they race against the server
// shutdown and prevent the port from being released cleanly.

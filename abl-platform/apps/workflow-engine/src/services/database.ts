/**
 * Workflow Engine — MongoDB Connection
 *
 * Initializes the MongoDB connection via MongoConnectionManager and sets
 * the encryption master key for field-level encryption (LLMCredential, etc.).
 *
 * Follows the same pattern as apps/runtime/src/db/index.ts.
 */

import mongoose from 'mongoose';
import { MongoConnectionManager } from '@agent-platform/database/mongo';
import type { MongoDBConfig } from '@agent-platform/database/mongo';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('workflow-engine:database');

/** MongoDB URL from environment — no hardcoded credentials */
const MONGODB_URL = process.env.MONGODB_URL;

let _initCompleted = false;

/**
 * Build the MongoDB config from environment variables with sensible defaults.
 */
function buildMongoConfig(): MongoDBConfig {
  if (!MONGODB_URL) {
    throw new Error('MONGODB_URL environment variable is required');
  }
  return {
    enabled: true,
    url: MONGODB_URL,
    database: process.env.MONGODB_DATABASE || 'abl_platform',
    minPoolSize: parseInt(process.env.MONGODB_MIN_POOL_SIZE || '2', 10),
    maxPoolSize: parseInt(process.env.MONGODB_MAX_POOL_SIZE || '10', 10),
    maxIdleTimeMs: 30_000,
    connectTimeoutMs: 10_000,
    socketTimeoutMs: 45_000,
    serverSelectionTimeoutMs: 10_000,
    heartbeatFrequencyMs: 10_000,
    tls: process.env.MONGODB_TLS === 'true',
    tlsAllowInvalidCertificates: process.env.MONGODB_TLS_ALLOW_INVALID === 'true',
    authSource: process.env.MONGODB_AUTH_SOURCE || 'admin',
    writeConcern: (process.env.MONGODB_WRITE_CONCERN as 'majority' | '1' | '0') || 'majority',
    readPreference:
      (process.env.MONGODB_READ_PREFERENCE as MongoDBConfig['readPreference']) || 'primary',
    retryWrites: true,
    retryReads: true,
    directConnection: process.env.MONGODB_DIRECT_CONNECTION === 'true',
    autoIndex: process.env.NODE_ENV !== 'production',
    slowQueryThresholdMs: parseInt(process.env.MONGODB_SLOW_QUERY_MS || '200', 10),
    appName: 'abl-workflow-engine',
  };
}

/**
 * Initialize MongoDB connection. Call once at startup before any model access.
 *
 * Also sets the encryption master key when `ENCRYPTION_MASTER_KEY` is present,
 * enabling field-level decryption on Mongoose hooks (e.g. LLMCredential.encryptedApiKey).
 */
export async function initDatabase(): Promise<void> {
  const config = buildMongoConfig();

  await MongoConnectionManager.initialize(config);
  _initCompleted = true;
  log.info('MongoDB initialized', { database: config.database, appName: config.appName });

  // Set Mongoose encryption plugin master key (same pattern as Runtime)
  const encMasterKey =
    process.env.ENCRYPTION_ENABLED !== 'false' ? process.env.ENCRYPTION_MASTER_KEY : undefined;
  if (!encMasterKey) {
    throw new Error('ENCRYPTION_MASTER_KEY is required for workflow-engine startup');
  }

  const { setMasterKey } = await import('@agent-platform/database/models');
  setMasterKey(encMasterKey);
  log.info('Mongoose field encryption master key set');

  try {
    const { initDEKFacade } = await import('@agent-platform/database/kms/facade');
    await initDEKFacade({ masterKeyHex: encMasterKey, logger: log });
    log.info('Mongoose encryption plugin DEK facade initialized');
  } catch (tenantEncError) {
    throw new Error(
      `DEK facade initialization failed: ${tenantEncError instanceof Error ? tenantEncError.message : String(tenantEncError)}`,
    );
  }
}

/**
 * Check if the MongoDB connection is ready.
 * Checks both that init completed AND the live Mongoose connection is up.
 * mongoose.connection.readyState: 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
 */
export function isDatabaseAvailable(): boolean {
  return _initCompleted && mongoose.connection.readyState === 1;
}

/**
 * Disconnect MongoDB gracefully. Call during shutdown.
 */
export async function disconnectDatabase(): Promise<void> {
  if (_initCompleted) {
    await MongoConnectionManager.getInstance().disconnect();
    _initCompleted = false;
    log.info('MongoDB disconnected');
  }
}

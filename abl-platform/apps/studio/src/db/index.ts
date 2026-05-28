/**
 * Studio Database Access
 *
 * MongoDB-only backend using Mongoose via MongoConnectionManager.
 * Imported lazily by DB-backed routes via ensureDb().
 */

import { DEFAULT_MONGODB_PORT } from '@agent-platform/config';

let _mongoReady = false;

// Exported promise so ensureDb() can await connection readiness on first use
export const dbReady = (async () => {
  try {
    const { MongoConnectionManager, setMasterKey } = await import('@agent-platform/database/mongo');
    const { ensureAuditLogTTLIndex } = await import('@agent-platform/database');

    // Set encryption master key before any model operations
    const masterKey =
      process.env.ENCRYPTION_ENABLED !== 'false' ? process.env.ENCRYPTION_MASTER_KEY : undefined;
    if (masterKey) {
      setMasterKey(masterKey);
    }

    await MongoConnectionManager.initialize({
      enabled: true,
      url:
        process.env.MONGODB_URL ||
        process.env.MONGODB_URI ||
        `mongodb://abl_admin:abl_dev_password@localhost:${DEFAULT_MONGODB_PORT}/abl_platform?authSource=admin`,
      database: process.env.MONGODB_DATABASE || process.env.MONGODB_DB_NAME || 'abl_platform',
      minPoolSize: parseInt(process.env.MONGODB_MIN_POOL_SIZE || '2', 10),
      maxPoolSize: parseInt(process.env.MONGODB_MAX_POOL_SIZE || '5', 10),
      maxIdleTimeMs: 30000,
      connectTimeoutMs: 10000,
      socketTimeoutMs: 45000,
      serverSelectionTimeoutMs: 10000,
      heartbeatFrequencyMs: 10000,
      tls: false,
      tlsAllowInvalidCertificates: false,
      authSource: process.env.MONGODB_AUTH_SOURCE || 'admin',
      writeConcern: 'majority',
      readPreference: 'primary',
      retryWrites: true,
      retryReads: true,
      directConnection: process.env.MONGODB_URL?.includes('directConnection=true') ?? false,
      autoIndex: process.env.NODE_ENV !== 'production',
      slowQueryThresholdMs: 200,
      appName: 'abl-studio',
    });

    await ensureAuditLogTTLIndex();
    _mongoReady = true;
    console.log('[studio/db] MongoDB connected');
  } catch (err) {
    console.error('[studio/db] MongoDB connection failed:', err);
  }
})();

export function isDatabaseAvailable(): boolean {
  return _mongoReady;
}

export async function disconnectDatabase(): Promise<void> {
  const { MongoConnectionManager } = await import('@agent-platform/database/mongo');
  await MongoConnectionManager.reset();
}

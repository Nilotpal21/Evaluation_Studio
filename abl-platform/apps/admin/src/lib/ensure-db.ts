import 'server-only';

let dbReadyPromise: Promise<void> | null = null;

async function connectDb(): Promise<void> {
  const mongoUrl =
    process.env.MONGODB_URL || process.env.MONGODB_URI || 'mongodb://localhost:27018/abl_platform';
  const masterKey =
    process.env.ENCRYPTION_ENABLED !== 'false' ? process.env.ENCRYPTION_MASTER_KEY : undefined;

  if (process.env.MONGODB_MANAGED === 'true') {
    const { MongoConnectionManager, setMasterKey } = await import('@agent-platform/database/mongo');
    if (masterKey) {
      setMasterKey(masterKey);
    }

    await MongoConnectionManager.initialize({
      enabled: true,
      url: mongoUrl,
      database: process.env.MONGODB_DATABASE || process.env.MONGODB_DB_NAME || 'abl_platform',
      minPoolSize: parseInt(process.env.MONGODB_MIN_POOL_SIZE || '2', 10),
      maxPoolSize: parseInt(process.env.MONGODB_MAX_POOL_SIZE || '5', 10),
      maxIdleTimeMs: 30000,
      connectTimeoutMs: 10000,
      socketTimeoutMs: 45000,
      serverSelectionTimeoutMs: 10000,
      heartbeatFrequencyMs: 10000,
      tls: process.env.MONGODB_TLS === 'true',
      tlsAllowInvalidCertificates: process.env.MONGODB_TLS_ALLOW_INVALID === 'true',
      authSource: process.env.MONGODB_AUTH_SOURCE || 'admin',
      writeConcern: 'majority',
      readPreference: 'primary',
      retryWrites: true,
      retryReads: true,
      directConnection:
        process.env.MONGODB_DIRECT_CONNECTION === 'true' ||
        mongoUrl.includes('directConnection=true'),
      autoIndex: process.env.NODE_ENV !== 'production',
      slowQueryThresholdMs: parseInt(process.env.MONGODB_SLOW_QUERY_MS || '200', 10),
      appName: 'abl-admin',
    });
    return;
  }

  const { ensureConnected, setMasterKey } = await import('@agent-platform/database/models');
  if (masterKey) {
    setMasterKey(masterKey);
  }
  await ensureConnected(mongoUrl);
}

export async function ensureDb(): Promise<void> {
  if (!dbReadyPromise) {
    dbReadyPromise = connectDb().catch((error) => {
      dbReadyPromise = null;
      throw error;
    });
  }

  return dbReadyPromise;
}

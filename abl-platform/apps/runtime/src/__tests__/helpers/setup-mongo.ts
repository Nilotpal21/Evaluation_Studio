/**
 * MongoDB Memory Server Test Setup
 *
 * Provides in-memory MongoDB for integration tests.
 * Usage:
 *   beforeAll(async () => { await setupTestMongo(); });
 *   afterEach(async () => { await clearCollections(); });
 *   afterAll(async () => { await teardownTestMongo(); });
 *
 * Requires vitest pool: 'forks' for process isolation (each test file
 * gets its own mongoose singleton).
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

interface SharedTestMongoState {
  mongod: MongoMemoryServer;
  uri: string;
}

const MONGO_VERSION = process.env.MONGOMS_VERSION || '7.0.20';
const MONGO_LAUNCH_TIMEOUT_MS = 60_000;
const MONGO_START_RETRY_LIMIT = 3;
const MONGO_START_RETRY_BACKOFF_MS = 250;
const TEST_MONGO_MAX_POOL_SIZE = Number(process.env.TEST_MONGO_MAX_POOL_SIZE ?? '5');
const TEST_MONGO_MIN_POOL_SIZE = 1;
const TEST_MONGO_CONNECT_TIMEOUT_MS = 10_000;
const TEST_MONGO_HEARTBEAT_FREQUENCY_MS = 10_000;
const TEST_MONGO_DATABASE_PREFIX = 'abl_platform_test';
const testIndexInitializers = new Map<string, Promise<void>>();

let sharedMongoState: SharedTestMongoState | null = null;
let sharedMongoStatePromise: Promise<SharedTestMongoState> | null = null;
let sharedMongoCleanupRegistered = false;
let previousAutoCreate: boolean | undefined;

function registerSharedMongoCleanup(): void {
  if (sharedMongoCleanupRegistered) {
    return;
  }

  sharedMongoCleanupRegistered = true;
  process.once('beforeExit', () => {
    if (!sharedMongoState) {
      return;
    }

    void sharedMongoState.mongod.stop().catch(() => {
      /* best-effort process cleanup */
    });
    sharedMongoState = null;
    sharedMongoStatePromise = null;
  });
}

async function createSharedMongoState(): Promise<SharedTestMongoState> {
  const mongod = await createMongoMemoryServerWithRetry();

  return {
    mongod,
    uri: mongod.getUri(),
  };
}

function isPortInUseError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes('already in use') || message.includes('eaddrinuse');
}

async function createMongoMemoryServerWithRetry(): Promise<MongoMemoryServer> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MONGO_START_RETRY_LIMIT; attempt++) {
    try {
      return await MongoMemoryServer.create({
        binary: { version: MONGO_VERSION },
        instance: { launchTimeout: MONGO_LAUNCH_TIMEOUT_MS },
      });
    } catch (error) {
      lastError = error;

      if (!isPortInUseError(error) || attempt === MONGO_START_RETRY_LIMIT) {
        throw error;
      }

      console.warn(
        `[TEST] MongoMemoryServer port conflict; retrying startup (${attempt + 1}/${MONGO_START_RETRY_LIMIT})`,
      );
      await new Promise((resolve) => setTimeout(resolve, MONGO_START_RETRY_BACKOFF_MS * attempt));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('MongoMemoryServer failed to start after retry attempts');
}

async function getSharedMongoState(): Promise<SharedTestMongoState> {
  if (sharedMongoState) {
    return sharedMongoState;
  }

  if (!sharedMongoStatePromise) {
    sharedMongoStatePromise = createSharedMongoState()
      .then((state) => {
        sharedMongoState = state;
        registerSharedMongoCleanup();
        return state;
      })
      .catch((error) => {
        sharedMongoStatePromise = null;
        throw error;
      });
  }

  return sharedMongoStatePromise;
}

function sanitizeMongoDatabaseNamePart(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'worker'
  );
}

function getTestMongoDatabaseName(): string {
  if (process.env.TEST_MONGODB_DATABASE) {
    return process.env.TEST_MONGODB_DATABASE;
  }

  const workerId =
    process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? process.env.JEST_WORKER_ID;
  return `${TEST_MONGO_DATABASE_PREFIX}_${sanitizeMongoDatabaseNamePart(
    workerId ?? String(process.pid),
  )}`;
}

export async function setupTestMongo(): Promise<string> {
  const { uri } = await getSharedMongoState();

  if (mongoose.connection.readyState === 1) {
    return uri;
  }

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  previousAutoCreate = mongoose.get('autoCreate') as boolean | undefined;
  mongoose.set('autoCreate', false);

  await mongoose.connect(uri, {
    dbName: getTestMongoDatabaseName(),
    maxPoolSize: TEST_MONGO_MAX_POOL_SIZE,
    minPoolSize: TEST_MONGO_MIN_POOL_SIZE,
    connectTimeoutMS: TEST_MONGO_CONNECT_TIMEOUT_MS,
    serverSelectionTimeoutMS: TEST_MONGO_CONNECT_TIMEOUT_MS,
    socketTimeoutMS: TEST_MONGO_CONNECT_TIMEOUT_MS,
    heartbeatFrequencyMS: TEST_MONGO_HEARTBEAT_FREQUENCY_MS,
    maxIdleTimeMS: TEST_MONGO_CONNECT_TIMEOUT_MS,
    directConnection: true,
  });
  return uri;
}

export async function teardownTestMongo(): Promise<void> {
  try {
    const { flushBufferedPersistenceOnShutdown } =
      await import('../../services/runtime-shutdown-flush.js');
    await flushBufferedPersistenceOnShutdown();
  } catch {
    /* best-effort test cleanup */
  }

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  mongoose.set('autoCreate', previousAutoCreate ?? true);
}

export async function clearCollections(): Promise<void> {
  if (!mongoose.connection.db) return;
  const collections = await mongoose.connection.db.listCollections().toArray();
  await Promise.all(
    collections
      .filter((collection) => !collection.name.startsWith('system.'))
      .map((collection) => mongoose.connection.db.collection(collection.name).deleteMany({})),
  );
}

export async function ensureTestIndexes(
  key: string,
  initialize: () => Promise<void>,
): Promise<void> {
  const dbScopedKey = `${mongoose.connection.db?.databaseName ?? getTestMongoDatabaseName()}:${key}`;
  const existing = testIndexInitializers.get(dbScopedKey);
  if (existing) {
    await existing;
    return;
  }

  const initializer = initialize().catch((error) => {
    testIndexInitializers.delete(dbScopedKey);
    throw error;
  });

  testIndexInitializers.set(dbScopedKey, initializer);
  await initializer;
}

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

let mongod: MongoMemoryServer | null = null;

const MONGO_VERSION = process.env.MONGOMS_VERSION || '7.0.20';
const MONGO_START_RETRY_LIMIT = 3;
const MONGO_START_RETRY_BACKOFF_MS = 250;

/** Whether MongoMemoryServer started successfully. Checked after setupTestMongo(). */
export let mongoAvailable = false;

interface SetupTestMongoOptions {
  syncIndexes?: boolean;
}

// Increase Mongoose's buffer timeout globally so model operations don't time out
// while MongoMemoryServer is starting or when many indexes are being ensured.
mongoose.set('bufferTimeoutMS', 60_000);

/** Check both the initial flag and live connection state. */
export function isMongoReady(): boolean {
  return mongoAvailable && mongoose.connection.readyState === 1;
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
        instance: { launchTimeout: 60_000 },
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

export async function setupTestMongo(options?: SetupTestMongoOptions): Promise<string> {
  try {
    mongod = await createMongoMemoryServerWithRetry();
    const uri = mongod.getUri();
    await mongoose.connect(uri);
    // Ensure connection is fully ready before returning
    await mongoose.connection.asPromise();
    // Sync all indexes for all registered models so index creation
    // doesn't race with the first test operations.
    if (options?.syncIndexes !== false) {
      await mongoose.connection.syncIndexes();
    }
    mongoAvailable = true;
    // If the connection drops mid-test (e.g. SIGABRT), mark as unavailable
    // so subsequent tests skip instead of timing out.
    mongoose.connection.on('disconnected', () => {
      mongoAvailable = false;
    });
    mongoose.connection.on('error', () => {
      mongoAvailable = false;
    });
    return uri;
  } catch (err) {
    mongoAvailable = false;
    console.warn(
      '[TEST] MongoMemoryServer unavailable -- MongoDB-dependent tests will be skipped',
      err,
    );
    return '';
  }
}

export async function teardownTestMongo(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongod) {
    await mongod.stop();
    mongod = null;
  }
}

export async function clearCollections(): Promise<void> {
  if (!isMongoReady()) return;
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
}

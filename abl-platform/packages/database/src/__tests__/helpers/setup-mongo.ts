import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import {
  initDEKFacade,
  shutdownKMSRegistry,
  _resetKMSRegistryForTesting,
} from '../../kms/index.js';
import {
  setMasterKey,
  _resetEncryptionStateForTesting,
} from '../../mongo/plugins/encryption.plugin.js';
import { _resetEncryptionServiceForTesting } from '@agent-platform/shared-encryption';

let mongod: MongoMemoryServer | undefined;

const TEST_MONGO_VERSION = process.env.MONGOMS_VERSION || '7.0.20';
const TEST_MONGO_LAUNCH_TIMEOUT_MS = 60_000;
const TEST_MONGO_CONNECT_TIMEOUT_MS = 120_000;
const TEST_MONGO_SOCKET_TIMEOUT_MS = 120_000;
const TEST_MONGO_SERVER_SELECTION_TIMEOUT_MS = 120_000;
const TEST_MONGO_HEARTBEAT_FREQUENCY_MS = 60_000;

/** Whether MongoMemoryServer started successfully. Checked after setupTestMongo(). */
export let mongoAvailable = false;

// Increase Mongoose's buffer timeout globally so model operations don't time out
// while MongoMemoryServer is starting or when many indexes are being ensured.
mongoose.set('bufferTimeoutMS', 60_000);

/** Check both the initial flag and live connection state. */
export function isMongoReady(): boolean {
  return mongoAvailable && mongoose.connection.readyState === 1;
}

export async function setupTestMongo() {
  try {
    mongod = await MongoMemoryServer.create({
      binary: { version: TEST_MONGO_VERSION },
      instance: { launchTimeout: TEST_MONGO_LAUNCH_TIMEOUT_MS },
    });
    const uri = mongod.getUri();
    await mongoose.connect(uri, {
      directConnection: true,
      connectTimeoutMS: TEST_MONGO_CONNECT_TIMEOUT_MS,
      socketTimeoutMS: TEST_MONGO_SOCKET_TIMEOUT_MS,
      serverSelectionTimeoutMS: TEST_MONGO_SERVER_SELECTION_TIMEOUT_MS,
      heartbeatFrequencyMS: TEST_MONGO_HEARTBEAT_FREQUENCY_MS,
    });
    // Ensure connection is fully ready before returning
    await mongoose.connection.asPromise();
    // Sync all indexes for all registered models so index creation
    // doesn't race with the first test operations.
    await mongoose.connection.syncIndexes();
    mongoAvailable = true;
    // If the connection drops mid-test (e.g. SIGABRT), mark as unavailable
    // so subsequent tests skip instead of timing out.
    mongoose.connection.on('disconnected', () => {
      mongoAvailable = false;
    });
    mongoose.connection.on('error', () => {
      mongoAvailable = false;
    });
  } catch (err) {
    mongoAvailable = false;
    console.warn(
      '[TEST] MongoMemoryServer unavailable -- MongoDB-dependent tests will be skipped',
      err,
    );
  }
}

export async function teardownTestMongo() {
  await resetTestEncryptionStack();
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongod) {
    await mongod.stop();
  }
  mongod = undefined;
  mongoAvailable = false;
}

export async function clearCollections() {
  if (!isMongoReady()) return;
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
}

/**
 * Guard to skip a test if MongoDB is unavailable.
 * Call at the very start of any MongoDB-dependent test body.
 *
 * In environments where MongoMemoryServer crashes (e.g. SIGABRT on some platforms),
 * this prevents tests from hanging on buffering timeouts by skipping immediately.
 *
 * Usage:
 *   it('does something', async ({ skip }) => {
 *     requireMongo(skip);
 *     // ... test body ...
 *   });
 */
export function requireMongo(skip?: (reason?: string) => void): void {
  if (!isMongoReady()) {
    if (skip) {
      skip('MongoMemoryServer unavailable');
    }
  }
}

/**
 * Initialize the real DEK facade for encrypted-model test suites.
 *
 * These suites used to rely on master-key-only fallback paths, but the
 * encryption plugin now requires the DEK facade to be wired in explicitly.
 */
export async function initTestDEKFacade(masterKeyHex = 'a'.repeat(64)): Promise<void> {
  if (!isMongoReady()) return;
  setMasterKey(masterKeyHex);
  await initDEKFacade({ masterKeyHex });
}

/**
 * Reset the global DEK/encryption singletons between test suites.
 */
export async function resetTestEncryptionStack(): Promise<void> {
  try {
    await shutdownKMSRegistry();
  } catch {
    // Ignore double-shutdown and partial-init cleanup in tests.
  }
  _resetKMSRegistryForTesting();
  _resetEncryptionStateForTesting();
  _resetEncryptionServiceForTesting();
}

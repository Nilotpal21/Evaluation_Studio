/**
 * MongoDB Test Helper for Workflow Engine System Tests
 *
 * Provides in-process MongoDB via MongoMemoryServer for system tests
 * that need real Mongoose schema validation, indexes, and queries.
 *
 * Adapted from packages/database/src/__tests__/helpers/setup-mongo.ts
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let mongod: MongoMemoryServer | undefined;

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
    mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri();
    await mongoose.connect(uri);
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
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[TEST] MongoMemoryServer unavailable -- MongoDB-dependent tests will be skipped: ${message}\n`,
    );
  }
}

export async function teardownTestMongo() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongod) {
    await mongod.stop();
  }
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

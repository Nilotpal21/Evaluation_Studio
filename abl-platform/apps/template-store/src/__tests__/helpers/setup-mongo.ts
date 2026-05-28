/**
 * MongoDB Test Helper for Template Store Integration Tests
 *
 * Provides in-process MongoDB via MongoMemoryServer for tests that need
 * real Mongoose schema validation, indexes, and queries.
 *
 * Adapted from apps/workflow-engine/src/__tests__/helpers/setup-mongo.ts
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let mongod: MongoMemoryServer | undefined;

/** Whether MongoMemoryServer started successfully. */
export let mongoAvailable = false;

// Increase Mongoose's buffer timeout so model operations don't time out
// while MongoMemoryServer is starting or indexes are being ensured.
mongoose.set('bufferTimeoutMS', 60_000);

/** Check both the initial flag and live connection state. */
export function isMongoReady(): boolean {
  return mongoAvailable && mongoose.connection.readyState === 1;
}

export async function setupTestMongo(): Promise<string> {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri);
  await mongoose.connection.asPromise();
  await mongoose.connection.syncIndexes();
  mongoAvailable = true;

  mongoose.connection.on('disconnected', () => {
    mongoAvailable = false;
  });
  mongoose.connection.on('error', () => {
    mongoAvailable = false;
  });

  return uri;
}

export async function teardownTestMongo(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongod) {
    await mongod.stop();
  }
}

export async function clearCollections(): Promise<void> {
  if (!isMongoReady()) return;
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
}

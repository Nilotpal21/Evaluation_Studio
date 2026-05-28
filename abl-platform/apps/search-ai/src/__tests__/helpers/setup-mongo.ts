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
import { setMasterKey, _resetEncryptionStateForTesting } from '@agent-platform/database/mongo';
import {
  initDEKFacade,
  shutdownKMSRegistry,
  _resetKMSRegistryForTesting,
} from '@agent-platform/database/kms';
import { _resetEncryptionServiceForTesting } from '@agent-platform/shared/encryption';
import { initMongoBackend, disconnectDatabase, getDualConnection } from '../../db/index.js';

let mongod: MongoMemoryServer | null = null;

const MONGO_VERSION = process.env.MONGOMS_VERSION || '7.0.20';
const MONGO_LAUNCH_TIMEOUT_MS = 60_000;
const MONGO_CONNECT_TIMEOUT_MS = 30_000;

export async function setupTestMongo(): Promise<string> {
  // Set encryption master key for tests (64-character hex string = 32 bytes)
  const masterKeyHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  setMasterKey(masterKeyHex);

  // Disable autoIndex globally to avoid slow index builds on in-memory MongoDB.
  // Index building across ~48 compound indexes on multiple connections can exceed
  // default hook timeouts. Tests don't need indexes for correctness.
  mongoose.set('autoIndex', false);

  mongod = await MongoMemoryServer.create({
    binary: { version: MONGO_VERSION },
    instance: { launchTimeout: MONGO_LAUNCH_TIMEOUT_MS },
  });
  const uri = mongod.getUri();

  // Connect default mongoose FIRST so models imported by initMongoBackend
  // can resolve their connection immediately (avoids 10s buffering timeout).
  await mongoose.connect(uri, {
    autoIndex: false,
    connectTimeoutMS: MONGO_CONNECT_TIMEOUT_MS,
    serverSelectionTimeoutMS: MONGO_CONNECT_TIMEOUT_MS,
  });

  // Initialize dual-connection layer for SearchAI tests
  // Use the same memory server for both platform and content databases (testing only)
  await initMongoBackend({
    platformDb: {
      enabled: true,
      url: uri,
      database: 'test_platform',
      minPoolSize: 1,
      maxPoolSize: 10,
      maxIdleTimeMs: 10000,
      connectTimeoutMs: MONGO_CONNECT_TIMEOUT_MS,
      socketTimeoutMs: 45000,
      serverSelectionTimeoutMs: MONGO_CONNECT_TIMEOUT_MS,
      heartbeatFrequencyMs: 10000,
      tls: false,
      tlsAllowInvalidCertificates: false,
      authSource: 'admin',
      writeConcern: '1',
      readPreference: 'primary',
    },
    contentDb: {
      enabled: true,
      url: uri,
      database: 'test_content',
      minPoolSize: 1,
      maxPoolSize: 10,
      maxIdleTimeMs: 10000,
      connectTimeoutMs: MONGO_CONNECT_TIMEOUT_MS,
      socketTimeoutMs: 45000,
      serverSelectionTimeoutMs: MONGO_CONNECT_TIMEOUT_MS,
      heartbeatFrequencyMs: 10000,
      tls: false,
      tlsAllowInvalidCertificates: false,
      authSource: 'admin',
      writeConcern: '1',
      readPreference: 'primary',
    },
  });

  // SearchAI now relies on the DEK facade path for encrypted fields like
  // LLMCredential.encryptedApiKey. Test suites need the same bootstrap as
  // production startup before creating encrypted documents.
  await initDEKFacade({ masterKeyHex });

  return uri;
}

export async function teardownTestMongo(): Promise<void> {
  await resetTestEncryptionStack();

  // Disconnect dual-connection layer
  await disconnectDatabase();

  // Disconnect default mongoose
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  if (mongod) {
    await mongod.stop();
    mongod = null;
  }
}

async function resetTestEncryptionStack(): Promise<void> {
  try {
    await shutdownKMSRegistry();
  } catch {
    // Ignore partial-init and double-shutdown cleanup in tests.
  }

  _resetKMSRegistryForTesting();
  _resetEncryptionStateForTesting();
  _resetEncryptionServiceForTesting();
}

export async function clearCollections(collectionNames?: string[]): Promise<void> {
  // Try dual-connection layer first, fall back to default mongoose
  let cleared = false;

  try {
    const dualConn = getDualConnection();
    const platformConn = dualConn.getPlatformConnection();

    // Since both connections use the same test database, we only need to clear once
    if (platformConn.db) {
      if (collectionNames && collectionNames.length > 0) {
        for (const name of collectionNames) {
          try {
            await platformConn.db.collection(name).deleteMany({});
          } catch (error) {
            // Ignore if collection doesn't exist
          }
        }
      } else {
        const collections = await platformConn.db.listCollections().toArray();
        for (const coll of collections) {
          await platformConn.db.collection(coll.name).deleteMany({});
        }
      }
      cleared = true;
    }
  } catch (error) {
    // Dual connection not available, will fall back below
  }

  // Fall back to default mongoose if dual connection was not available
  if (!cleared && mongoose.connection.db) {
    if (collectionNames && collectionNames.length > 0) {
      for (const name of collectionNames) {
        try {
          await mongoose.connection.db.collection(name).deleteMany({});
        } catch (error) {
          // Ignore if collection doesn't exist
        }
      }
    } else {
      const collections = await mongoose.connection.db.listCollections().toArray();
      for (const coll of collections) {
        await mongoose.connection.db.collection(coll.name).deleteMany({});
      }
    }
  }
}

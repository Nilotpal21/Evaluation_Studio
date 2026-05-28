import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { MongoConnectionManager } from '@agent-platform/database/mongo';
import { disconnectDatabase, initMongoBackend } from '../db/index.js';
import { repairLegacyChannelConnectionIndexes } from '../db/channel-connection-index-repair.js';

const MONGOMS_VERSION = process.env.MONGOMS_VERSION || '7.0.20';

let mongod: MongoMemoryServer | null = null;
let mongoAvailable = false;

const testLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('channel connection index repair', () => {
  beforeAll(async () => {
    try {
      mongod = await MongoMemoryServer.create({
        binary: { version: MONGOMS_VERSION },
        instance: {
          ip: '127.0.0.1',
          launchTimeout: 30_000,
        },
      });

      await MongoConnectionManager.reset();
      await initMongoBackend({
        enabled: true,
        url: mongod.getUri(),
        database: 'abl_platform_channel_index_repair_test',
        minPoolSize: 1,
        maxPoolSize: 5,
        maxIdleTimeMs: 10_000,
        connectTimeoutMs: 10_000,
        socketTimeoutMs: 10_000,
        serverSelectionTimeoutMs: 10_000,
        heartbeatFrequencyMs: 10_000,
        tls: false,
        tlsAllowInvalidCertificates: false,
        authSource: 'admin',
        writeConcern: '1',
        readPreference: 'primary',
        retryWrites: true,
        retryReads: true,
        directConnection: true,
        autoIndex: false,
        slowQueryThresholdMs: 250,
        appName: 'channel-connection-index-repair-test',
      });
      mongoAvailable = true;
    } catch (err: unknown) {
      mongoAvailable = false;
      console.warn('[TEST] MongoMemoryServer unavailable -- skipping index repair tests', err);
    }
  }, 60_000);

  beforeEach(async ({ skip }) => {
    if (!mongoAvailable) {
      skip('MongoMemoryServer unavailable');
      return;
    }

    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('MongoDB not connected');
    }

    const collection = db.collection('channel_connections');
    await collection.deleteMany({});

    // listIndexes() throws "ns does not exist" when the collection has not
    // been materialized yet (deleteMany on a missing collection is a no-op
    // that does not create it). Skip the cleanup loop in that case.
    const collectionExists = await db.listCollections({ name: 'channel_connections' }).hasNext();
    if (!collectionExists) {
      return;
    }
    const indexes = await collection.indexes();
    for (const index of indexes) {
      if (index.name !== '_id_') {
        await collection.dropIndex(index.name);
      }
    }
  });

  afterAll(async () => {
    await disconnectDatabase();
    await MongoConnectionManager.reset();
    if (mongod) {
      await mongod.stop();
      mongod = null;
    }
    mongoAvailable = false;
  }, 30_000);

  test('replaces the legacy sparse verifyTokenHash index with the partial active-only index', async () => {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('MongoDB not connected');
    }

    const collection = db.collection('channel_connections');
    await collection.createIndex(
      { channelType: 1, verifyTokenHash: 1 },
      {
        name: 'channelType_1_verifyTokenHash_1',
        unique: true,
        sparse: true,
      },
    );

    await repairLegacyChannelConnectionIndexes(testLogger);

    const indexes = await collection.indexes();
    const repairedIndex = indexes.find((index) => index.name === 'channelType_1_verifyTokenHash_1');

    expect(repairedIndex).toBeDefined();
    expect(repairedIndex?.sparse).not.toBe(true);
    expect(repairedIndex?.partialFilterExpression).toEqual({
      status: 'active',
      verifyTokenHash: { $type: 'string' },
    });
  });

  test('creates the verifyTokenHash index when it is missing', async () => {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('MongoDB not connected');
    }

    const collection = db.collection('channel_connections');

    await repairLegacyChannelConnectionIndexes(testLogger);

    const indexes = await collection.indexes();
    const repairedIndex = indexes.find((index) => index.name === 'channelType_1_verifyTokenHash_1');

    expect(repairedIndex).toBeDefined();
    expect(repairedIndex?.unique).toBe(true);
    expect(repairedIndex?.partialFilterExpression).toEqual({
      status: 'active',
      verifyTokenHash: { $type: 'string' },
    });
  });
});

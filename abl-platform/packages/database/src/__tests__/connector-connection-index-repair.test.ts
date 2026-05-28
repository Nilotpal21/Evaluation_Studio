import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { repairLegacyConnectorConnectionIndexes } from '../mongo/connector-connection-index-repair.js';

const MONGOMS_VERSION = process.env.MONGOMS_VERSION || '7.0.20';

let mongod: MongoMemoryServer | null = null;
let mongoAvailable = false;

const testLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const tenantWideLegacyIndexName = 'tenantId_1_connectorName_1_scope_1_userId_1';
const projectScopedLegacyIndexName = 'tenantId_1_projectId_1_connectorName_1_scope_1_userId_1';
const currentIndexName = 'tenantId_1_projectId_1_connectorName_1_authProfileId_1';

async function resetConnectorConnectionCollection(): Promise<mongoose.mongo.Collection> {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('MongoDB not connected');
  }

  const collection = db.collection('connector_connections');
  await collection.deleteMany({});

  const indexes = await collection.indexes().catch(() => []);
  for (const index of indexes) {
    if (index.name !== '_id_') {
      await collection.dropIndex(index.name);
    }
  }

  return collection;
}

describe('connector connection index repair', () => {
  beforeAll(async () => {
    try {
      mongod = await MongoMemoryServer.create({
        binary: { version: MONGOMS_VERSION },
        instance: {
          ip: '127.0.0.1',
          launchTimeout: 30_000,
        },
      });

      await mongoose.connect(mongod.getUri(), {
        dbName: 'abl_platform_connector_index_repair_test',
        directConnection: true,
        connectTimeoutMS: 10_000,
        socketTimeoutMS: 10_000,
        serverSelectionTimeoutMS: 10_000,
      });

      mongoAvailable = true;
    } catch (err: unknown) {
      mongoAvailable = false;
      console.warn(
        '[TEST] MongoMemoryServer unavailable -- skipping connector index repair tests',
        err,
      );
    }
  }, 60_000);

  beforeEach(async ({ skip }) => {
    if (!mongoAvailable) {
      skip('MongoMemoryServer unavailable');
      return;
    }

    await resetConnectorConnectionCollection();
  });

  afterAll(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }

    if (mongod) {
      await mongod.stop();
      mongod = null;
    }

    mongoAvailable = false;
  }, 30_000);

  test('replaces the tenant-wide legacy unique index and allows the same connector in another project', async () => {
    const collection = await resetConnectorConnectionCollection();

    await collection.createIndex(
      { tenantId: 1, connectorName: 1, scope: 1, userId: 1 },
      {
        name: tenantWideLegacyIndexName,
        unique: true,
      },
    );

    await collection.insertOne({
      _id: 'conn-1',
      tenantId: 'tenant-1',
      projectId: 'project-a',
      connectorName: 'smartassist',
      displayName: 'SmartAssist A',
      scope: 'tenant',
      userId: null,
      authProfileId: 'ap-1',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      collection.insertOne({
        _id: 'conn-2',
        tenantId: 'tenant-1',
        projectId: 'project-b',
        connectorName: 'smartassist',
        displayName: 'SmartAssist B',
        scope: 'tenant',
        userId: null,
        authProfileId: 'ap-2',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: 11000 });

    await repairLegacyConnectorConnectionIndexes(testLogger);

    await expect(
      collection.insertOne({
        _id: 'conn-2',
        tenantId: 'tenant-1',
        projectId: 'project-b',
        connectorName: 'smartassist',
        displayName: 'SmartAssist B',
        scope: 'tenant',
        userId: null,
        authProfileId: 'ap-2',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).resolves.toBeDefined();

    const indexes = await collection.indexes();
    expect(indexes.some((index) => index.name === tenantWideLegacyIndexName)).toBe(false);
    expect(indexes.some((index) => index.name === currentIndexName)).toBe(true);
  });

  test('replaces the project-scoped legacy unique index and allows a second auth profile in the same project', async () => {
    const collection = await resetConnectorConnectionCollection();

    await collection.createIndex(
      { tenantId: 1, projectId: 1, connectorName: 1, scope: 1, userId: 1 },
      {
        name: projectScopedLegacyIndexName,
        unique: true,
      },
    );

    await collection.insertOne({
      _id: 'conn-1',
      tenantId: 'tenant-1',
      projectId: 'project-a',
      connectorName: 'smartassist',
      displayName: 'SmartAssist A',
      scope: 'tenant',
      userId: null,
      authProfileId: 'ap-1',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      collection.insertOne({
        _id: 'conn-2',
        tenantId: 'tenant-1',
        projectId: 'project-a',
        connectorName: 'smartassist',
        displayName: 'SmartAssist B',
        scope: 'tenant',
        userId: null,
        authProfileId: 'ap-2',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: 11000 });

    await repairLegacyConnectorConnectionIndexes(testLogger);

    await expect(
      collection.insertOne({
        _id: 'conn-2',
        tenantId: 'tenant-1',
        projectId: 'project-a',
        connectorName: 'smartassist',
        displayName: 'SmartAssist B',
        scope: 'tenant',
        userId: null,
        authProfileId: 'ap-2',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).resolves.toBeDefined();

    const indexes = await collection.indexes();
    expect(indexes.some((index) => index.name === projectScopedLegacyIndexName)).toBe(false);
    expect(indexes.some((index) => index.name === currentIndexName)).toBe(true);
  });

  test('keeps the legacy unique index in place when duplicate auth-profile bindings block the current contract', async () => {
    const collection = await resetConnectorConnectionCollection();

    await collection.createIndex(
      { tenantId: 1, projectId: 1, connectorName: 1, scope: 1, userId: 1 },
      {
        name: projectScopedLegacyIndexName,
        unique: true,
      },
    );

    await collection.insertOne({
      _id: 'conn-1',
      tenantId: 'tenant-1',
      projectId: 'project-a',
      connectorName: 'smartassist',
      displayName: 'SmartAssist A',
      scope: 'tenant',
      userId: null,
      authProfileId: 'ap-1',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await collection.insertOne({
      _id: 'conn-2',
      tenantId: 'tenant-1',
      projectId: 'project-a',
      connectorName: 'smartassist',
      displayName: 'SmartAssist B',
      scope: 'user',
      userId: 'user-1',
      authProfileId: 'ap-1',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(repairLegacyConnectorConnectionIndexes(testLogger)).rejects.toThrow(
      /Cannot enforce connector connection uniqueness index/,
    );

    const indexes = await collection.indexes();
    expect(indexes.some((index) => index.name === projectScopedLegacyIndexName)).toBe(true);
    expect(indexes.some((index) => index.name === currentIndexName)).toBe(false);
  });
});

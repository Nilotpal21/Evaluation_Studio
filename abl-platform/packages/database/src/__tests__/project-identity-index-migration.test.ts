import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import mongoose from 'mongoose';
import {
  clearCollections,
  isMongoReady,
  setupTestMongo,
  teardownTestMongo,
} from './helpers/setup-mongo.js';
import { migration as repairProjectIdentityIndexes } from '../migrations/scripts/20260516_035_repair_project_identity_indexes.js';

const PROJECTS_COLLECTION = 'projects';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
  if (!isMongoReady()) return;

  const db = mongoose.connection.db!;
  const collections = await db.listCollections({ name: PROJECTS_COLLECTION }).toArray();
  if (collections.length > 0) {
    await db.dropCollection(PROJECTS_COLLECTION);
  }
});

describe('20260516_035 project identity index migration', () => {
  test('drops legacy global uniqueness and keeps project slug tenant-scoped', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const projects = db.collection(PROJECTS_COLLECTION);

    await projects.insertOne({
      _id: 'project-1',
      tenantId: 'tenant-1',
      ownerId: 'user-1',
      name: 'Support Ops',
      slug: 'support-ops',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await projects.createIndex({ slug: 1 }, { unique: true, name: 'slug_1' });
    await projects.createIndex({ name: 1 }, { unique: true, name: 'name_1' });

    await repairProjectIdentityIndexes.up(db);

    const indexes = await projects.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: { tenantId: 1, slug: 1 },
          name: 'tenantId_1_slug_1',
          unique: true,
        }),
        expect.objectContaining({
          key: { tenantId: 1, name: 1 },
          name: 'tenantId_1_name_1',
        }),
      ]),
    );
    expect(indexes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: { slug: 1 },
          unique: true,
        }),
      ]),
    );
    expect(indexes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: { name: 1 },
          unique: true,
        }),
      ]),
    );

    await expect(
      projects.insertOne({
        _id: 'project-2',
        tenantId: 'tenant-2',
        ownerId: 'user-2',
        name: 'Support Ops',
        slug: 'support-ops',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).resolves.toBeDefined();

    await expect(
      projects.insertOne({
        _id: 'project-3',
        tenantId: 'tenant-1',
        ownerId: 'user-3',
        name: 'Support Ops Copy',
        slug: 'support-ops',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toThrow(/duplicate key/);

    const validation = await repairProjectIdentityIndexes.validate?.(db);
    expect(validation?.ok).toBe(true);
    expect(validation?.details).toMatchObject({
      canonicalSlugIndexPresent: true,
      nameLookupIndexPresent: true,
      legacyGlobalUniqueIndexes: [],
    });
  });

  test('rollback does not restore global uniqueness after valid cross-tenant duplicates exist', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const projects = db.collection(PROJECTS_COLLECTION);

    await projects.insertOne({
      _id: 'project-1',
      tenantId: 'tenant-1',
      ownerId: 'user-1',
      name: 'Support Ops',
      slug: 'support-ops',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await projects.createIndex({ slug: 1 }, { unique: true, name: 'slug_1' });

    await repairProjectIdentityIndexes.up(db);

    await projects.insertOne({
      _id: 'project-2',
      tenantId: 'tenant-2',
      ownerId: 'user-2',
      name: 'Support Ops',
      slug: 'support-ops',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await repairProjectIdentityIndexes.down?.(db);

    const indexes = await projects.indexes();
    expect(indexes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: { slug: 1 },
          unique: true,
        }),
      ]),
    );

    await expect(
      projects.insertOne({
        _id: 'project-3',
        tenantId: 'tenant-3',
        ownerId: 'user-3',
        name: 'Support Ops',
        slug: 'support-ops',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).resolves.toBeDefined();
  });
});

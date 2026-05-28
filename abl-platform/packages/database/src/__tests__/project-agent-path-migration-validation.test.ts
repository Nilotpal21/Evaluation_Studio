import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import mongoose from 'mongoose';
import {
  clearCollections,
  isMongoReady,
  setupTestMongo,
  teardownTestMongo,
} from './helpers/setup-mongo.js';
import { migration as projectScopedMigration } from '../migrations/scripts/20260227_005_scope_agent_path_to_project.js';
import { migration as tenantScopedMigration } from '../migrations/scripts/20260503_026_scope_project_agent_path_to_tenant.js';
import { migration as dropAgentPathUniqueMigration } from '../migrations/scripts/20260509_028_drop_project_agent_path_unique_index.js';

const PROJECT_AGENTS_COLLECTION = 'project_agents';

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
  const collections = await db.listCollections({ name: PROJECT_AGENTS_COLLECTION }).toArray();
  if (collections.length > 0) {
    await db.dropCollection(PROJECT_AGENTS_COLLECTION);
  }
});

describe('20260227_005 project agent path validation', () => {
  test('accepts the newer tenant-scoped unique index as a superseding migration state', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const agents = db.collection(PROJECT_AGENTS_COLLECTION);

    await agents.createIndex(
      { tenantId: 1, projectId: 1, agentPath: 1 },
      { unique: true, name: 'tenantId_1_projectId_1_agentPath_1' },
    );

    const validation = await projectScopedMigration.validate?.(db);

    expect(validation?.ok).toBe(true);
    expect(validation?.details).toMatchObject({
      newIndexPresent: false,
      supersedingTenantScopedUniqueIndexPresent: true,
      supersedingTenantScopedLookupIndexPresent: true,
      oldIndexPresent: false,
    });
  });

  test('accepts the latest non-unique tenant-scoped lookup index as a superseding migration state', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const agents = db.collection(PROJECT_AGENTS_COLLECTION);

    await agents.createIndex(
      { tenantId: 1, projectId: 1, agentPath: 1 },
      { name: 'tenantId_1_projectId_1_agentPath_1' },
    );

    const validation = await projectScopedMigration.validate?.(db);

    expect(validation?.ok).toBe(true);
    expect(validation?.details).toMatchObject({
      newIndexPresent: false,
      supersedingTenantScopedUniqueIndexPresent: false,
      supersedingTenantScopedLookupIndexPresent: true,
      oldIndexPresent: false,
    });
  });
});

describe('20260503_026 project agent path validation', () => {
  test('accepts the latest non-unique tenant-scoped lookup index as a superseding migration state', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const agents = db.collection(PROJECT_AGENTS_COLLECTION);

    await agents.insertOne({
      _id: 'agent-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      name: 'Main',
      agentPath: 'project-1/Main',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await agents.createIndex(
      { tenantId: 1, projectId: 1, agentPath: 1 },
      { name: 'tenantId_1_projectId_1_agentPath_1' },
    );

    const validation = await tenantScopedMigration.validate?.(db);

    expect(validation?.ok).toBe(true);
    expect(validation?.details).toMatchObject({
      uniqueIndexPresent: false,
      lookupIndexPresent: true,
      oldIndexPresent: false,
      nonCanonicalPaths: 0,
    });
  });
});

describe('20260509_028 project agent path uniqueness migration', () => {
  test('drops all known unique agentPath indexes and keeps a non-unique lookup index', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const agents = db.collection(PROJECT_AGENTS_COLLECTION);

    await agents.insertOne({
      _id: 'agent-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      name: 'Main',
      agentPath: 'project-1/Main',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await agents.createIndex({ agentPath: 1 }, { unique: true, name: 'agentPath_1' });
    await agents.createIndex(
      { projectId: 1, agentPath: 1 },
      { unique: true, name: 'projectId_1_agentPath_1' },
    );
    await agents.createIndex(
      { tenantId: 1, projectId: 1, agentPath: 1 },
      { unique: true, name: 'tenantId_1_projectId_1_agentPath_1' },
    );

    await dropAgentPathUniqueMigration.up(db);

    const indexes = await agents.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: { tenantId: 1, projectId: 1, name: 1 },
          name: 'tenantId_1_projectId_1_name_1',
          unique: true,
        }),
        expect.objectContaining({
          key: { tenantId: 1, projectId: 1, agentPath: 1 },
          name: 'tenantId_1_projectId_1_agentPath_1',
        }),
      ]),
    );
    expect(indexes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: { tenantId: 1, projectId: 1, agentPath: 1 },
          unique: true,
        }),
      ]),
    );
    expect(indexes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: { projectId: 1, agentPath: 1 },
          unique: true,
        }),
      ]),
    );
    expect(indexes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: { agentPath: 1 },
          unique: true,
        }),
      ]),
    );

    await expect(
      agents.insertOne({
        _id: 'agent-2',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        name: 'Secondary',
        agentPath: 'project-1/Main',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).resolves.toBeDefined();

    await expect(
      agents.insertOne({
        _id: 'agent-3',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        name: 'Main',
        agentPath: 'project-1/MainAgain',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toThrow(/duplicate key/);

    const validation = await dropAgentPathUniqueMigration.validate?.(db);
    expect(validation?.ok).toBe(true);
    expect(validation?.details).toMatchObject({
      identityIndexPresent: true,
      lookupIndexPresent: true,
      uniqueAgentPathIndexes: [],
    });
  });
});

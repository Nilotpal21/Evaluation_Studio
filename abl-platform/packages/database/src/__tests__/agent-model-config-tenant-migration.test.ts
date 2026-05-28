import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import mongoose from 'mongoose';
import {
  clearCollections,
  isMongoReady,
  setupTestMongo,
  teardownTestMongo,
} from './helpers/setup-mongo.js';
import { migration } from '../migrations/scripts/20260503_025_backfill_agent_model_config_tenant_ids.js';

const PROJECTS_COLLECTION = 'projects';
const AGENT_MODEL_CONFIGS_COLLECTION = 'agent_model_configs';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

describe('20260503_025 backfill AgentModelConfig tenant ids', () => {
  test('backfills tenantId and replaces legacy non-tenant-scoped indexes', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const configs = db.collection(AGENT_MODEL_CONFIGS_COLLECTION);

    await db.collection(PROJECTS_COLLECTION).insertMany([
      {
        _id: 'project-a',
        tenantId: 'tenant-a',
        name: 'Project A',
        slug: 'project-a',
        ownerId: 'user-a',
        kind: 'application',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: 'project-b',
        tenantId: 'tenant-b',
        name: 'Project B',
        slug: 'project-b',
        ownerId: 'user-b',
        kind: 'application',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    await configs.insertMany([
      {
        _id: 'config-a',
        projectId: 'project-a',
        agentName: 'Main',
        defaultModel: 'gpt-4o',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: 'config-b',
        tenantId: null,
        projectId: 'project-b',
        agentName: 'Main',
        defaultModel: 'gpt-4o-mini',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    await configs.createIndex(
      { projectId: 1, agentName: 1 },
      { unique: true, name: 'projectId_1_agentName_1' },
    );
    await configs.createIndex({ projectId: 1 }, { name: 'projectId_1' });

    await migration.up(db);

    const [configA, configB] = await Promise.all([
      configs.findOne({ _id: 'config-a' }),
      configs.findOne({ _id: 'config-b' }),
    ]);
    expect(configA?.tenantId).toBe('tenant-a');
    expect(configB?.tenantId).toBe('tenant-b');

    const indexes = await configs.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'tenantId_1_projectId_1_agentName_1',
          unique: true,
          key: { tenantId: 1, projectId: 1, agentName: 1 },
        }),
        expect.objectContaining({
          name: 'tenantId_1_projectId_1',
          key: { tenantId: 1, projectId: 1 },
        }),
      ]),
    );
    expect(indexes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: { projectId: 1, agentName: 1 },
          unique: true,
        }),
      ]),
    );

    const validation = await migration.validate?.(db);
    expect(validation?.ok).toBe(true);
    expect(validation?.details).toMatchObject({
      remainingEligibleRows: 0,
      currentUniqueIndexPresent: true,
      currentProjectIndexPresent: true,
      legacyUniqueIndexPresent: false,
    });
  });

  test('treats rollback as a safe no-op', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    await expect(migration.down(db)).resolves.toBeUndefined();
  });
});

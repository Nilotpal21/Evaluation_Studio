import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import mongoose from 'mongoose';
import {
  clearCollections,
  isMongoReady,
  setupTestMongo,
  teardownTestMongo,
} from './helpers/setup-mongo.js';
import { migration as guardrailPolicyScopeIndexMigration } from '../migrations/scripts/20260510_031_fix_guardrail_policy_scope_unique_index.js';
import { migration as guardrailPolicyScopeIndexReconciliation } from '../migrations/scripts/20260511_032_reconcile_guardrail_policy_scope_unique_index.js';

const COLLECTION = 'guardrail_policies';
const LEGACY_INDEX_NAME = 'tenantId_1_name_1_scope.type_1';
const SCOPED_INDEX_NAME = 'tenantId_1_name_1_scope.type_1_scope.projectId_1_scope.agentDefId_1';

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
  const collections = await db.listCollections({ name: COLLECTION }).toArray();
  if (collections.length > 0) {
    await db.dropCollection(COLLECTION);
  }
});

describe('20260510_031 guardrail policy scope uniqueness migration', () => {
  test('replaces tenant-wide policy name uniqueness with project and agent scoped uniqueness', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const policies = db.collection(COLLECTION);

    await policies.insertOne({
      _id: 'policy-project-a',
      tenantId: 'tenant-1',
      projectId: 'project-a',
      name: 'Content Safety',
      scope: { type: 'project', projectId: 'project-a' },
      settings: {},
      caching: {},
      budget: {},
      status: 'active',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await policies.createIndex(
      { tenantId: 1, name: 1, 'scope.type': 1 },
      { unique: true, name: LEGACY_INDEX_NAME },
    );

    await expect(
      policies.insertOne({
        _id: 'policy-project-b-before',
        tenantId: 'tenant-1',
        projectId: 'project-b',
        name: 'Content Safety',
        scope: { type: 'project', projectId: 'project-b' },
        settings: {},
        caching: {},
        budget: {},
        status: 'active',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toThrow(/duplicate key/);

    await guardrailPolicyScopeIndexMigration.up(db);

    const indexes = await policies.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: {
            tenantId: 1,
            name: 1,
            'scope.type': 1,
            'scope.projectId': 1,
            'scope.agentDefId': 1,
          },
          name: SCOPED_INDEX_NAME,
          unique: true,
        }),
      ]),
    );
    expect(indexes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: { tenantId: 1, name: 1, 'scope.type': 1 },
          unique: true,
        }),
      ]),
    );

    await expect(
      policies.insertOne({
        _id: 'policy-project-b-after',
        tenantId: 'tenant-1',
        projectId: 'project-b',
        name: 'Content Safety',
        scope: { type: 'project', projectId: 'project-b' },
        settings: {},
        caching: {},
        budget: {},
        status: 'active',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).resolves.toBeDefined();

    await expect(
      policies.insertOne({
        _id: 'policy-project-a-duplicate',
        tenantId: 'tenant-1',
        projectId: 'project-a',
        name: 'Content Safety',
        scope: { type: 'project', projectId: 'project-a' },
        settings: {},
        caching: {},
        budget: {},
        status: 'active',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toThrow(/duplicate key/);

    const validation = await guardrailPolicyScopeIndexMigration.validate?.(db);
    expect(validation?.ok).toBe(true);
    expect(validation?.details).toMatchObject({
      scopedIndexPresent: true,
      legacyUniqueIndexes: [],
    });
  });
});

describe('20260511_032 guardrail policy scope uniqueness reconciliation', () => {
  test('drops a legacy policy name index that reappeared after the first migration', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const policies = db.collection(COLLECTION);

    await policies.insertOne({
      _id: 'policy-project-a',
      tenantId: 'tenant-1',
      projectId: 'project-a',
      name: 'Content Safety',
      scope: { type: 'project', projectId: 'project-a' },
      settings: {},
      caching: {},
      budget: {},
      status: 'active',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await policies.createIndex(
      {
        tenantId: 1,
        name: 1,
        'scope.type': 1,
        'scope.projectId': 1,
        'scope.agentDefId': 1,
      },
      { unique: true, name: SCOPED_INDEX_NAME },
    );
    await policies.createIndex(
      { tenantId: 1, name: 1, 'scope.type': 1 },
      { unique: true, name: LEGACY_INDEX_NAME },
    );

    await guardrailPolicyScopeIndexReconciliation.up(db);

    const indexes = await policies.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: {
            tenantId: 1,
            name: 1,
            'scope.type': 1,
            'scope.projectId': 1,
            'scope.agentDefId': 1,
          },
          name: SCOPED_INDEX_NAME,
          unique: true,
        }),
      ]),
    );
    expect(indexes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: { tenantId: 1, name: 1, 'scope.type': 1 },
          unique: true,
        }),
      ]),
    );

    const validation = await guardrailPolicyScopeIndexReconciliation.validate?.(db);
    expect(validation?.ok).toBe(true);
    expect(validation?.details).toMatchObject({
      scopedIndexPresent: true,
      legacyUniqueIndexes: [],
    });
  });
});

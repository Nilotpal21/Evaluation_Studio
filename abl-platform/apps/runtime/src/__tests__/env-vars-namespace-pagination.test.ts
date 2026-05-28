/**
 * Namespace Pagination Integration Test (INT-9)
 *
 * Tests the MongoDB aggregation pipeline used for namespace-filtered
 * pagination of environment variables. Uses MongoMemoryServer for a
 * real aggregation pipeline test.
 *
 * Verifies GAP-003 fix: namespace filtering happens BEFORE pagination,
 * so total counts reflect only the namespace-scoped variables.
 *
 * Run with: npx vitest run --config vitest.integration.config.ts src/__tests__/env-vars-namespace-pagination.test.ts
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose, { Schema, model } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// ---------------------------------------------------------------------------
// Simplified models (no encryption/audit plugins — testing aggregation only)
// ---------------------------------------------------------------------------

const EnvVarSchema = new Schema(
  {
    _id: { type: String },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    environment: { type: String, default: null },
    key: { type: String, required: true },
    encryptedValue: { type: String, default: '' },
    isSecret: { type: Boolean, default: false },
    description: { type: String, default: null },
    createdBy: { type: String, default: 'test' },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, collection: 'environment_variables' },
);

const MembershipSchema = new Schema(
  {
    _id: { type: String },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    namespaceId: { type: String, required: true },
    variableId: { type: String, required: true },
    variableType: { type: String, required: true, enum: ['env', 'config'] },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'variable_namespace_memberships',
  },
);

let EnvVar: mongoose.Model<any>;
let Membership: mongoose.Model<any>;

// ---------------------------------------------------------------------------
// MongoMemoryServer lifecycle
// ---------------------------------------------------------------------------

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({
    binary: { version: process.env.MONGOMS_VERSION || '7.0.20' },
    instance: { launchTimeout: 30_000 },
  });
  await mongoose.connect(mongod.getUri());

  // Register models after connection
  EnvVar = mongoose.models.TestEnvVar || model('TestEnvVar', EnvVarSchema, 'environment_variables');
  Membership =
    mongoose.models.TestMembership ||
    model('TestMembership', MembershipSchema, 'variable_namespace_memberships');
});

afterEach(async () => {
  await EnvVar.deleteMany({});
  await Membership.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

// ---------------------------------------------------------------------------
// Aggregation pipeline (copied from environment-variables.ts route handler)
// ---------------------------------------------------------------------------

async function runNamespacePagination(params: {
  tenantId: string;
  projectId: string;
  environment: string;
  namespaceId: string;
  skip: number;
  limit: number;
}) {
  const { tenantId, projectId, environment, namespaceId, skip, limit } = params;

  const where = { tenantId, projectId, environment };

  const pipeline: any[] = [
    { $match: where },
    {
      $lookup: {
        from: 'variable_namespace_memberships',
        let: { varId: '$_id' },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ['$variableId', '$$varId'] },
              variableType: 'env',
              namespaceId,
            },
          },
          { $limit: 1 },
        ],
        as: '_nsMembership',
      },
    },
    { $match: { '_nsMembership.0': { $exists: true } } },
    {
      $project: {
        _id: true,
        key: true,
        environment: true,
        isSecret: true,
        description: true,
        createdAt: true,
        updatedAt: true,
      },
    },
  ];

  const facetResult = await EnvVar.aggregate([
    ...pipeline,
    {
      $facet: {
        data: [{ $skip: skip }, { $limit: limit }],
        count: [{ $count: 'total' }],
      },
    },
  ]);

  return {
    variables: facetResult[0]?.data ?? [],
    total: facetResult[0]?.count?.[0]?.total ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Test data seeding
// ---------------------------------------------------------------------------

async function seedData() {
  const t = 'tenant-1';
  const p = 'proj-1';

  // Create 15 env vars for 'dev'
  const vars: any[] = [];
  for (let i = 0; i < 15; i++) {
    vars.push({
      _id: `var-${i}`,
      tenantId: t,
      projectId: p,
      environment: 'dev',
      key: `VAR_${i}`,
      encryptedValue: `val-${i}`,
      isSecret: false,
      createdBy: 'test',
    });
  }
  await EnvVar.insertMany(vars);

  // Assign first 10 to namespace-A
  const membershipsA = [];
  for (let i = 0; i < 10; i++) {
    membershipsA.push({
      _id: `mem-a-${i}`,
      tenantId: t,
      projectId: p,
      namespaceId: 'ns-a',
      variableId: `var-${i}`,
      variableType: 'env',
    });
  }
  await Membership.insertMany(membershipsA);

  // Assign last 5 to namespace-B
  const membershipsB = [];
  for (let i = 10; i < 15; i++) {
    membershipsB.push({
      _id: `mem-b-${i}`,
      tenantId: t,
      projectId: p,
      namespaceId: 'ns-b',
      variableId: `var-${i}`,
      variableType: 'env',
    });
  }
  await Membership.insertMany(membershipsB);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('INT-9: Namespace pagination at DB level', () => {
  test('page 1 of namespace-A returns 5 items with total=10', async () => {
    await seedData();

    const result = await runNamespacePagination({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      environment: 'dev',
      namespaceId: 'ns-a',
      skip: 0,
      limit: 5,
    });

    expect(result.variables).toHaveLength(5);
    expect(result.total).toBe(10);
  });

  test('page 2 of namespace-A returns 5 items with total=10', async () => {
    await seedData();

    const result = await runNamespacePagination({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      environment: 'dev',
      namespaceId: 'ns-a',
      skip: 5,
      limit: 5,
    });

    expect(result.variables).toHaveLength(5);
    expect(result.total).toBe(10);
  });

  test('page 3 of namespace-A returns 0 items with total=10', async () => {
    await seedData();

    const result = await runNamespacePagination({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      environment: 'dev',
      namespaceId: 'ns-a',
      skip: 10,
      limit: 5,
    });

    expect(result.variables).toHaveLength(0);
    expect(result.total).toBe(10);
  });

  test('page 1 of namespace-B returns 5 items with total=5', async () => {
    await seedData();

    const result = await runNamespacePagination({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      environment: 'dev',
      namespaceId: 'ns-b',
      skip: 0,
      limit: 5,
    });

    expect(result.variables).toHaveLength(5);
    expect(result.total).toBe(5);
  });

  test('all 10 namespace-A vars are retrievable across pages (no gaps, no dupes)', async () => {
    await seedData();

    const allKeys = new Set<string>();

    for (let page = 0; page < 3; page++) {
      const result = await runNamespacePagination({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        environment: 'dev',
        namespaceId: 'ns-a',
        skip: page * 5,
        limit: 5,
      });
      for (const v of result.variables) {
        allKeys.add(v.key);
      }
    }

    expect(allKeys.size).toBe(10);
    // All should be VAR_0 through VAR_9
    for (let i = 0; i < 10; i++) {
      expect(allKeys.has(`VAR_${i}`)).toBe(true);
    }
  });

  test('non-existent namespace returns 0 items with total=0', async () => {
    await seedData();

    const result = await runNamespacePagination({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      environment: 'dev',
      namespaceId: 'ns-nonexistent',
      skip: 0,
      limit: 10,
    });

    expect(result.variables).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});

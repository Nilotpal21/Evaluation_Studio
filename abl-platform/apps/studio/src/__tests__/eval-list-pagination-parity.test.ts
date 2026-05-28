// @vitest-environment node
/**
 * Regression coverage for eval list cursor pagination.
 *
 * ABLP-1060 surfaced when the Scenarios tab silently stopped at the
 * default page size. These tests exercise the repository page contract
 * against Mongo so cursor behavior stays tied to the real indexes and
 * document shape.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

const TEST_MASTER_KEY = '4'.repeat(64);
const MONGOMS_VERSION = process.env.MONGOMS_VERSION ?? '7.0.20';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({
    binary: { version: MONGOMS_VERSION },
    instance: { launchTimeout: 30_000 },
  });
  const mongoUri = mongod.getUri();
  process.env.MONGODB_URL = mongoUri;
  process.env.MONGODB_URI = mongoUri;
  process.env.MONGODB_MANAGED = 'false';
  process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY;
  process.env.ENCRYPTION_ENABLED = 'true';

  const { ensureConnected } = await import('@agent-platform/database/models');
  await ensureConnected(mongoUri);
}, 40_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
}, 15_000);

describe('findScenariosPageByProject', () => {
  it('returns scenarios beyond the first 50 via a stable cursor', async () => {
    const { EvalScenario } = await import('@agent-platform/database/models');
    const { findScenariosPageByProject } = await import('@/repos/eval-repo');
    const tenantId = 'tenant-ablp-1060';
    const projectId = 'project-ablp-1060';
    const createdAt = new Date('2026-05-15T12:00:00.000Z');

    await EvalScenario.insertMany(
      Array.from({ length: 55 }, (_, index) => ({
        _id: `scenario-${String(index).padStart(3, '0')}`,
        tenantId,
        projectId,
        name: `Scenario ${String(index).padStart(3, '0')}`,
        description: 'ABLP-1060 pagination regression fixture',
        category: 'general',
        difficulty: 'medium',
        maxTurns: 10,
        tags: [],
        agentPath: [],
        expectedMilestones: [],
        version: 1,
        createdBy: 'test-user',
        _v: 1,
        createdAt,
        updatedAt: createdAt,
      })),
    );

    const firstPage = await findScenariosPageByProject(projectId, tenantId, { limit: 50 });
    expect(firstPage.items).toHaveLength(50);
    expect(firstPage.pagination).toMatchObject({
      hasMore: true,
      limit: 50,
      total: 55,
    });
    expect(firstPage.pagination.nextCursor).toEqual(expect.any(String));

    const secondPage = await findScenariosPageByProject(projectId, tenantId, {
      limit: 50,
      cursor: firstPage.pagination.nextCursor,
    });

    expect(secondPage.items).toHaveLength(5);
    expect(secondPage.pagination).toMatchObject({
      hasMore: false,
      limit: 50,
      nextCursor: null,
      total: 55,
    });

    const firstPageIds = new Set(firstPage.items.map((scenario) => scenario.id));
    const secondPageIds = secondPage.items.map((scenario) => scenario.id);
    expect(secondPageIds.some((id) => firstPageIds.has(id))).toBe(false);
    expect([...firstPageIds, ...secondPageIds]).toHaveLength(55);
  });

  it('caps oversized limits at the shared maximum page size', async () => {
    const { EvalScenario } = await import('@agent-platform/database/models');
    const { findScenariosPageByProject } = await import('@/repos/eval-repo');
    const tenantId = 'tenant-ablp-1060-limit';
    const projectId = 'project-ablp-1060-limit';
    const createdAt = new Date('2026-05-15T13:00:00.000Z');

    await EvalScenario.insertMany(
      Array.from({ length: 105 }, (_, index) => ({
        _id: `limit-scenario-${String(index).padStart(3, '0')}`,
        tenantId,
        projectId,
        name: `Limit Scenario ${String(index).padStart(3, '0')}`,
        description: 'ABLP-1060 page-size cap fixture',
        category: 'general',
        difficulty: 'medium',
        maxTurns: 10,
        tags: [],
        agentPath: [],
        expectedMilestones: [],
        version: 1,
        createdBy: 'test-user',
        _v: 1,
        createdAt,
        updatedAt: createdAt,
      })),
    );

    const page = await findScenariosPageByProject(projectId, tenantId, { limit: 500 });

    expect(page.items).toHaveLength(100);
    expect(page.pagination).toMatchObject({
      hasMore: true,
      limit: 100,
      total: 105,
    });
  });

  it('rejects malformed cursors before querying the next page', async () => {
    const { findScenariosPageByProject } = await import('@/repos/eval-repo');

    await expect(
      findScenariosPageByProject('project-ablp-1060-bad-cursor', 'tenant-ablp-1060-bad-cursor', {
        cursor: 'not-valid-base64-json',
      }),
    ).rejects.toMatchObject({
      message: 'Invalid pagination cursor',
      statusCode: 400,
    });
  });
});

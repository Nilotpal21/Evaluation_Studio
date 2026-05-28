/**
 * INT-3: Usage Count Denormalization
 *
 * Tests that incrementUsageCount correctly updates the counter.
 * Uses MongoMemoryServer for real MongoDB operations.
 * Steps 1-2 only; steps 3-4 descoped (compile hook is Phase 3).
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PromptLibraryItem } from '@agent-platform/database/models';
import { PromptLibraryService } from '../prompt-library-service.js';

let mongod: MongoMemoryServer;
let service: PromptLibraryService;

const TENANT_ID = 'test-tenant-usage';
const PROJECT_ID = 'test-project-usage';
const USER_ID = 'test-user-usage';

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({
    binary: { version: process.env.MONGOMS_VERSION || '7.0.20' },
    instance: { launchTimeout: 30_000 },
  });
  await mongoose.connect(mongod.getUri());
  service = new PromptLibraryService();
});

afterEach(async () => {
  await PromptLibraryItem.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('INT-3: incrementUsageCount', () => {
  test('increments usage count atomically', async () => {
    const item = await service.createPrompt({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      name: `usage-test-${Date.now()}`,
      createdBy: USER_ID,
    });

    expect(item.usageCount).toBe(0);

    await service.incrementUsageCount(String(item._id), TENANT_ID);
    await service.incrementUsageCount(String(item._id), TENANT_ID);

    const updated = (await PromptLibraryItem.findOne({
      _id: item._id,
    }).lean()) as { usageCount: number } | null;

    expect(updated?.usageCount).toBe(2);
  });

  test('concurrent increments all succeed', async () => {
    const item = await service.createPrompt({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      name: `usage-concurrent-${Date.now()}`,
      createdBy: USER_ID,
    });

    const promptId = String(item._id);

    // Run 5 concurrent increments
    await Promise.all(
      Array.from({ length: 5 }, () => service.incrementUsageCount(promptId, TENANT_ID)),
    );

    const updated = (await PromptLibraryItem.findOne({
      _id: promptId,
    }).lean()) as { usageCount: number } | null;

    expect(updated?.usageCount).toBe(5);
  });
});

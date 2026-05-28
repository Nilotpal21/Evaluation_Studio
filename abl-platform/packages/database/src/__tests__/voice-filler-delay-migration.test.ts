import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import mongoose from 'mongoose';
import {
  clearCollections,
  isMongoReady,
  setupTestMongo,
  teardownTestMongo,
} from './helpers/setup-mongo.js';
import { migration } from '../migrations/scripts/20260513_034_backfill_voice_filler_delay.js';

const COLLECTION = 'project_runtime_configs';

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
    await db.collection(COLLECTION).deleteMany({});
  }
});

describe('20260513_034 backfill voice filler delay', () => {
  test('rewrites legacy zero voice delays to the 500ms default and validates', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const configs = db.collection(COLLECTION);
    await configs.insertMany([
      {
        _id: 'legacy-zero',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        filler: { voiceDelayMs: 0 },
      },
      {
        _id: 'explicit-delay',
        tenantId: 'tenant-1',
        projectId: 'project-2',
        filler: { voiceDelayMs: 800 },
      },
      {
        _id: 'missing-delay',
        tenantId: 'tenant-1',
        projectId: 'project-3',
        filler: {},
      },
    ]);

    await migration.up(db);

    await expect(configs.findOne({ _id: 'legacy-zero' })).resolves.toMatchObject({
      filler: { voiceDelayMs: 500 },
    });
    await expect(configs.findOne({ _id: 'explicit-delay' })).resolves.toMatchObject({
      filler: { voiceDelayMs: 800 },
    });
    await expect(configs.findOne({ _id: 'missing-delay' })).resolves.toMatchObject({
      filler: {},
    });

    const validation = await migration.validate?.(db);
    expect(validation?.ok).toBe(true);
    expect(validation?.details).toEqual({
      remainingLegacyZeros: 0,
      defaultVoiceDelayMs: 500,
    });
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import mongoose from 'mongoose';
import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
} from './helpers/setup-mongo.js';
import { SeedRunner, type SeedTask } from '../seed/runner.js';

interface SeedTestContext {
  db: mongoose.mongo.Db;
  targetKey: string;
}

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
  for (const collectionName of [
    'seed_widgets',
    '_seed_history',
    '_change_history',
    '_change_lock',
  ]) {
    const collections = await db.listCollections({ name: collectionName }).toArray();
    if (collections.length > 0) {
      await db.collection(collectionName).deleteMany({});
    }
  }
});

describe('SeedRunner', () => {
  function createTask(): SeedTask<SeedTestContext> {
    return {
      id: 'seed-widget',
      description: 'Seed a widget',
      idempotent: true,
      compensation: 'manual',
      targetKey: (context) => context.targetKey,
      targetLabel: () => 'test target',
      async run(context) {
        await context.db
          .collection('seed_widgets')
          .updateOne({ _id: 'widget-1' }, { $set: { ready: true } }, { upsert: true });
      },
      async validate(context) {
        const readyWidgets = await context.db.collection('seed_widgets').countDocuments({
          _id: 'widget-1',
          ready: true,
        });
        return readyWidgets === 1
          ? { ok: true, summary: 'widget present' }
          : { ok: false, summary: 'widget missing' };
      },
    };
  }

  test('status reports verified for legacy state without history', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    await db
      .collection('seed_widgets')
      .updateOne({ _id: 'widget-1' }, { $set: { ready: true } }, { upsert: true });

    const runner = new SeedRunner<SeedTestContext>(db);
    const statuses = await runner.status([createTask()], {
      db,
      targetKey: 'tenant:test',
    });

    expect(statuses[0]?.status).toBe('verified');
    expect(statuses[0]?.tracked).toBe(false);
    expect(statuses[0]?.validationStatus).toBe('passed');
  });

  test('run records tracked history with checksum and validation', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const runner = new SeedRunner<SeedTestContext>(db);
    const result = await runner.run([createTask()], {
      db,
      targetKey: 'tenant:test',
    });

    expect(result.applied).toEqual(['seed-widget']);
    expect(result.validated).toEqual(['seed-widget']);

    const history = await db.collection('_seed_history').findOne<{
      status?: string;
      checksum?: string;
      validationStatus?: string;
      runCount?: number;
    }>({
      taskId: 'seed-widget',
      targetKey: 'tenant:test',
    });

    expect(history?.status).toBe('applied');
    expect(history?.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(history?.validationStatus).toBe('passed');
    expect(history?.runCount).toBe(1);

    const sharedHistory = await db.collection('_change_history').findOne<{
      changeId?: string;
      targetKey?: string;
      shadowSource?: string;
      validationStatus?: string;
      runCount?: number;
      appliedAt?: Date;
    }>({
      changeId: 'seed.seed-widget',
      targetKey: 'tenant:test',
    });

    expect(sharedHistory?.shadowSource).toBe('_seed_history');
    expect(sharedHistory?.validationStatus).toBe('passed');
    expect(sharedHistory?.runCount).toBe(1);
    expect(sharedHistory?.appliedAt).toBeInstanceOf(Date);
  });

  test('validate adopts untracked verified state into history', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    await db
      .collection('seed_widgets')
      .updateOne({ _id: 'widget-1' }, { $set: { ready: true } }, { upsert: true });

    const runner = new SeedRunner<SeedTestContext>(db);
    const results = await runner.validate([createTask()], {
      db,
      targetKey: 'tenant:test',
    });

    expect(results[0]?.status).toBe('verified');
    expect(results[0]?.tracked).toBe(true);

    const history = await db.collection('_seed_history').findOne<{
      status?: string;
      validationStatus?: string;
      runCount?: number;
    }>({
      taskId: 'seed-widget',
      targetKey: 'tenant:test',
    });
    expect(history?.status).toBe('verified');
    expect(history?.validationStatus).toBe('passed');
    expect(history?.runCount).toBe(0);
  });

  test('validate updates tracked tasks when validation fails later', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const runner = new SeedRunner<SeedTestContext>(db);
    await runner.run([createTask()], {
      db,
      targetKey: 'tenant:test',
    });

    await db.collection('seed_widgets').updateOne({ _id: 'widget-1' }, { $set: { ready: false } });

    const results = await runner.validate([createTask()], {
      db,
      targetKey: 'tenant:test',
    });

    expect(results[0]?.status).toBe('failed');

    const history = await db.collection('_seed_history').findOne<{
      validationStatus?: string;
      lastError?: string;
    }>({
      taskId: 'seed-widget',
      targetKey: 'tenant:test',
    });
    expect(history?.validationStatus).toBe('failed');
    expect(history?.lastError).toBe('widget missing');
  });

  test('run enforces per-task seed lock contention', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const slowTask: SeedTask<SeedTestContext> = {
      ...createTask(),
      async run(context) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        await context.db
          .collection('seed_widgets')
          .updateOne({ _id: 'widget-1' }, { $set: { ready: true } }, { upsert: true });
      },
    };

    const firstRunner = new SeedRunner<SeedTestContext>(db);
    const secondRunner = new SeedRunner<SeedTestContext>(db);

    const firstRun = firstRunner.run([slowTask], {
      db,
      targetKey: 'tenant:test',
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    const secondResult = await secondRunner.run([slowTask], {
      db,
      targetKey: 'tenant:test',
    });
    const firstResult = await firstRun;

    expect(firstResult.applied).toEqual(['seed-widget']);
    expect(secondResult.failed).toContain('Could not acquire seed lock');
  });
});

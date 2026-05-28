import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import mongoose from 'mongoose';
import {
  clearCollections,
  isMongoReady,
  setupTestMongo,
  teardownTestMongo,
} from '../helpers/setup-mongo.js';
import { readChangeHistory, writeChangeHistory } from '../../change-management/history.js';
import { acquireChangeLease, StaleLeaseFenceError } from '../../change-management/lease.js';

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
  for (const collectionName of ['_change_lock', '_change_history']) {
    const collections = await db.listCollections({ name: collectionName }).toArray();
    if (collections.length > 0) {
      await db.collection(collectionName).deleteMany({});
    }
  }
});

describe('change-management history', () => {
  test('rejects history writes with a stale fence value', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const start = new Date('2026-04-15T00:00:00.000Z');
    const first = await acquireChangeLease(db, {
      lockId: 'global',
      holderId: 'holder-a',
      ttlMs: 10,
      now: start,
    });
    await acquireChangeLease(db, {
      lockId: 'global',
      holderId: 'holder-b',
      ttlMs: 10,
      now: new Date(start.getTime() + 50),
    });

    await expect(
      writeChangeHistory(
        db,
        {
          changeId: 'mongodb.20260415_001.test',
          description: 'test',
          environment: 'dev',
          engine: 'mongodb',
          kind: 'schema',
          phase: 'pre_deploy',
          scope: 'global',
          status: 'failed',
          lastError: 'stale',
        },
        {
          lockId: 'global',
          holderId: 'holder-a',
          fence: first!.fence,
          runCountDelta: 1,
        },
      ),
    ).rejects.toBeInstanceOf(StaleLeaseFenceError);
  });

  test('persists normalized history with owner and build metadata', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const lease = await acquireChangeLease(db, {
      lockId: 'global',
      holderId: 'holder-a',
    });

    const persisted = await writeChangeHistory(
      db,
      {
        changeId: 'seed.platform-core',
        description: 'Seed platform core',
        environment: 'staging',
        engine: 'mongodb',
        kind: 'seed_platform',
        phase: 'continuous',
        scope: 'global',
        status: 'applied',
        appliedBy: 'argo-presync-job',
        buildInfo: {
          imageTag: 'runtime:1.2.3',
          manifestDigest: 'sha256:abc123',
        },
        releaseId: 'release-2026-04-15.1',
        releaseEvidence: {
          configSnapshotRef: 'cfg-snap-1',
          configDiffRef: 'cfg-diff-1',
          observabilityRef: 'trace-1',
        },
        checksum: 'abc',
      },
      {
        lockId: 'global',
        holderId: 'holder-a',
        fence: lease!.fence,
        runCountDelta: 1,
        shadowSource: '_seed_history',
        shadowKey: 'platform-core::global:platform-core',
      },
    );

    expect(persisted._id).toBe('staging:seed.platform-core:global');
    expect(persisted.appliedBy).toBe('argo-presync-job');
    expect(persisted.buildInfo?.['imageTag']).toBe('runtime:1.2.3');
    expect(persisted.shadowSource).toBe('_seed_history');
    expect(persisted.fence).toBe(lease?.fence);
    expect(persisted.runCount).toBe(1);
  });

  test('preserves last error and run count across retries', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const lease = await acquireChangeLease(db, {
      lockId: 'global',
      holderId: 'holder-a',
    });

    await writeChangeHistory(
      db,
      {
        changeId: 'mongodb.20260415_002.retry-test',
        description: 'Retry test',
        environment: 'prod',
        engine: 'mongodb',
        kind: 'backfill',
        phase: 'post_deploy',
        scope: 'global',
        status: 'failed',
        lastError: 'first failure',
      },
      {
        lockId: 'global',
        holderId: 'holder-a',
        fence: lease!.fence,
        runCountDelta: 1,
      },
    );

    await writeChangeHistory(
      db,
      {
        changeId: 'mongodb.20260415_002.retry-test',
        description: 'Retry test',
        environment: 'prod',
        engine: 'mongodb',
        kind: 'backfill',
        phase: 'post_deploy',
        scope: 'global',
        status: 'failed',
        lastError: 'second failure',
      },
      {
        lockId: 'global',
        holderId: 'holder-a',
        fence: lease!.fence,
        runCountDelta: 1,
      },
    );

    const [persisted] = await readChangeHistory(db, {
      changeId: 'mongodb.20260415_002.retry-test',
    });

    expect(persisted?.runCount).toBe(2);
    expect(persisted?.lastError).toBe('second failure');
  });
});

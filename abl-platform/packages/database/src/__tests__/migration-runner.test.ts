import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
} from './helpers/setup-mongo.js';
import { MigrationRunner } from '../migrations/runner.js';
import type { Migration } from '../migrations/types.js';

const ORIGINAL_CHANGE_LOCK_TTL_MS = process.env.CHANGE_LOCK_TTL_MS;
const ORIGINAL_CHANGE_LOCK_HEARTBEAT_MS = process.env.CHANGE_LOCK_HEARTBEAT_MS;

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
    'widgets',
    '_migration_history',
    '_migration_lock',
    '_change_history',
  ]) {
    const collections = await db.listCollections({ name: collectionName }).toArray();
    if (collections.length > 0) {
      await db.collection(collectionName).deleteMany({});
    }
  }
});

afterEach(() => {
  if (ORIGINAL_CHANGE_LOCK_TTL_MS === undefined) {
    delete process.env.CHANGE_LOCK_TTL_MS;
  } else {
    process.env.CHANGE_LOCK_TTL_MS = ORIGINAL_CHANGE_LOCK_TTL_MS;
  }

  if (ORIGINAL_CHANGE_LOCK_HEARTBEAT_MS === undefined) {
    delete process.env.CHANGE_LOCK_HEARTBEAT_MS;
  } else {
    process.env.CHANGE_LOCK_HEARTBEAT_MS = ORIGINAL_CHANGE_LOCK_HEARTBEAT_MS;
  }
});

describe('MigrationRunner', () => {
  test('migrate() only runs pending migrations for the requested phase', async () => {
    if (!isMongoReady()) return;

    const preDeployMigration: Migration = {
      version: '20260510_031',
      description: 'Fix GuardrailPolicy uniqueness to include project and agent scope',
      async up(db) {
        await db.collection('widgets').insertOne({ _id: 'pre-deploy', phase: 'pre_deploy' });
      },
      async down(db) {
        await db.collection('widgets').deleteOne({ _id: 'pre-deploy' });
      },
    };
    const postDeployMigration: Migration = {
      version: '20260511_032',
      description: 'Reconcile GuardrailPolicy scoped uniqueness after rollout',
      async up(db) {
        await db.collection('widgets').insertOne({ _id: 'post-deploy', phase: 'post_deploy' });
      },
      async down(db) {
        await db.collection('widgets').deleteOne({ _id: 'post-deploy' });
      },
    };

    const runner = new MigrationRunner([postDeployMigration, preDeployMigration]);
    const result = await runner.migrate({ phase: 'pre_deploy', requireManifestMetadata: true });

    expect(result.applied).toEqual(['20260510_031']);
    await expect(
      mongoose.connection.db!.collection('widgets').findOne({ _id: 'post-deploy' }),
    ).resolves.toBeNull();
  });

  test('migrate() enforces manifest dependencies for phased runs', async () => {
    if (!isMongoReady()) return;

    const preDeployMigration: Migration = {
      version: '20260510_031',
      description: 'Fix GuardrailPolicy uniqueness to include project and agent scope',
      async up(db) {
        await db.collection('widgets').insertOne({ _id: 'pre-deploy', phase: 'pre_deploy' });
      },
      async down(db) {
        await db.collection('widgets').deleteOne({ _id: 'pre-deploy' });
      },
    };
    const postDeployMigration: Migration = {
      version: '20260511_032',
      description: 'Reconcile GuardrailPolicy scoped uniqueness after rollout',
      async up(db) {
        await db.collection('widgets').insertOne({ _id: 'post-deploy', phase: 'post_deploy' });
      },
      async down(db) {
        await db.collection('widgets').deleteOne({ _id: 'post-deploy' });
      },
    };

    const runner = new MigrationRunner([preDeployMigration, postDeployMigration]);
    const result = await runner.migrate({ phase: 'post_deploy', requireManifestMetadata: true });

    expect(result.applied).toEqual([]);
    expect(result.failed).toBe('20260511_032');
    const history = await mongoose.connection
      .db!.collection('_migration_history')
      .findOne<{ lastError?: string }>({ version: '20260511_032' });
    expect(history?.lastError).toContain(
      'cannot run in post_deploy before dependency mongodb.20260510_031.fix-guardrail-policy-scope-unique-index is applied',
    );
  });

  test('migrate() fails closed when an active MongoDB dependency is absent from the runner', async () => {
    if (!isMongoReady()) return;

    const postDeployMigration: Migration = {
      version: '20260511_032',
      description: 'Reconcile GuardrailPolicy scoped uniqueness after rollout',
      async up(db) {
        await db.collection('widgets').insertOne({ _id: 'post-deploy', phase: 'post_deploy' });
      },
      async down(db) {
        await db.collection('widgets').deleteOne({ _id: 'post-deploy' });
      },
    };

    const runner = new MigrationRunner([postDeployMigration]);
    const result = await runner.migrate({ phase: 'post_deploy', requireManifestMetadata: true });

    expect(result.applied).toEqual([]);
    expect(result.failed).toBe('20260511_032');
    const history = await mongoose.connection
      .db!.collection('_migration_history')
      .findOne<{ lastError?: string }>({ version: '20260511_032' });
    expect(history?.lastError).toContain(
      'requires active MongoDB dependency mongodb.20260510_031.fix-guardrail-policy-scope-unique-index, but it is not registered in the migration runner',
    );
  });

  test('validate() only revalidates applied migrations for the requested phase', async () => {
    if (!isMongoReady()) return;

    const preDeployMigration: Migration = {
      version: '20260510_031',
      description: 'Fix GuardrailPolicy uniqueness to include project and agent scope',
      async up(db) {
        await db.collection('widgets').insertOne({ _id: 'pre-deploy', phase: 'pre_deploy' });
      },
      async down(db) {
        await db.collection('widgets').deleteOne({ _id: 'pre-deploy' });
      },
      async validate() {
        return { ok: true, summary: 'pre deploy valid' };
      },
    };
    const postDeployMigration: Migration = {
      version: '20260511_032',
      description: 'Reconcile GuardrailPolicy scoped uniqueness after rollout',
      async up(db) {
        await db.collection('widgets').insertOne({ _id: 'post-deploy', phase: 'post_deploy' });
      },
      async down(db) {
        await db.collection('widgets').deleteOne({ _id: 'post-deploy' });
      },
      async validate() {
        return { ok: true, summary: 'post deploy valid' };
      },
    };

    const runner = new MigrationRunner([preDeployMigration, postDeployMigration]);
    await runner.migrate({ phase: 'pre_deploy', requireManifestMetadata: true });
    await runner.migrate({ phase: 'post_deploy', requireManifestMetadata: true });

    const results = await runner.validate({
      phase: 'post_deploy',
      requireManifestMetadata: true,
    });

    expect(results.map((result) => result.version)).toEqual(['20260511_032']);
    expect(results[0]?.summary).toBe('post deploy valid');
  });

  test('phased CI runs fail closed when a migration has no manifest metadata', async () => {
    if (!isMongoReady()) return;

    const migration: Migration = {
      version: '20990101_001',
      description: 'Unregistered migration',
      async up(db) {
        await db.collection('widgets').insertOne({ _id: 'unregistered' });
      },
      async down(db) {
        await db.collection('widgets').deleteOne({ _id: 'unregistered' });
      },
    };

    const runner = new MigrationRunner([migration]);
    await expect(
      runner.migrate({ phase: 'pre_deploy', requireManifestMetadata: true }),
    ).rejects.toThrow('Migration 20990101_001 is missing change-management manifest metadata');
  });

  test('records checksum and validation details for applied migrations', async () => {
    if (!isMongoReady()) return;

    const migration: Migration = {
      version: '20260415_001',
      description: 'Seed a validation widget',
      async up(db) {
        await db
          .collection('widgets')
          .updateOne({ _id: 'widget-1' }, { $set: { ready: true } }, { upsert: true });
      },
      async down(db) {
        await db.collection('widgets').deleteOne({ _id: 'widget-1' });
      },
      async validate(db) {
        const readyWidgets = await db.collection('widgets').countDocuments({
          _id: 'widget-1',
          ready: true,
        });
        return readyWidgets === 1
          ? { ok: true, summary: 'widget present' }
          : { ok: false, summary: 'widget missing' };
      },
    };

    const runner = new MigrationRunner([migration]);
    const result = await runner.migrate();
    expect(result.applied).toEqual(['20260415_001']);
    expect(result.validated).toEqual(['20260415_001']);

    const history = await mongoose.connection
      .db!.collection('_migration_history')
      .findOne<{ checksum?: string; validationStatus?: string; runCount?: number }>({
        version: '20260415_001',
      });

    expect(history?.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(history?.validationStatus).toBe('passed');
    expect(history?.runCount).toBe(1);

    const sharedHistory = await mongoose.connection.db!.collection('_change_history').findOne<{
      changeId?: string;
      shadowSource?: string;
      validationStatus?: string;
      runCount?: number;
      appliedAt?: Date;
    }>({
      changeId: 'mongodb.20260415_001',
    });

    expect(sharedHistory?.shadowSource).toBe('_migration_history');
    expect(sharedHistory?.validationStatus).toBe('passed');
    expect(sharedHistory?.runCount).toBe(1);
    expect(sharedHistory?.appliedAt).toBeInstanceOf(Date);

    const status = await runner.status();
    expect(status[0]?.checksumStatus).toBe('match');
    expect(status[0]?.validationStatus).toBe('passed');
  });

  test('validate() records failures for already-applied migrations', async () => {
    if (!isMongoReady()) return;

    const migration: Migration = {
      version: '20260415_002',
      description: 'Seed and validate a widget',
      async up(db) {
        await db
          .collection('widgets')
          .updateOne({ _id: 'widget-2' }, { $set: { ready: true } }, { upsert: true });
      },
      async down(db) {
        await db.collection('widgets').deleteOne({ _id: 'widget-2' });
      },
      async validate(db) {
        const readyWidgets = await db.collection('widgets').countDocuments({
          _id: 'widget-2',
          ready: true,
        });
        return readyWidgets === 1
          ? { ok: true, summary: 'widget ready' }
          : { ok: false, summary: 'widget no longer ready' };
      },
    };

    const runner = new MigrationRunner([migration]);
    await runner.migrate();

    await mongoose.connection
      .db!.collection('widgets')
      .updateOne({ _id: 'widget-2' }, { $set: { ready: false } });

    const results = await runner.validate();
    expect(results[0]?.status).toBe('failed');
    expect(results[0]?.summary).toBe('widget no longer ready');

    const history = await mongoose.connection
      .db!.collection('_migration_history')
      .findOne<{ validationStatus?: string; lastError?: string }>({
        version: '20260415_002',
      });
    expect(history?.validationStatus).toBe('failed');
    expect(history?.lastError).toBe('widget no longer ready');
  });

  test('migrate() records validation details when post-apply validation fails', async () => {
    if (!isMongoReady()) return;

    const migration: Migration = {
      version: '20260415_006',
      description: 'Apply widget with failing validation',
      async up(db) {
        await db
          .collection('widgets')
          .updateOne({ _id: 'widget-invalid' }, { $set: { ready: false } }, { upsert: true });
      },
      async down(db) {
        await db.collection('widgets').deleteOne({ _id: 'widget-invalid' });
      },
      async validate() {
        return {
          ok: false,
          summary: 'widget failed post-apply validation',
          details: { expectedReady: true },
        };
      },
    };

    const runner = new MigrationRunner([migration]);
    const result = await runner.migrate();

    expect(result.failed).toBe('20260415_006');
    const history = await mongoose.connection.db!.collection('_migration_history').findOne<{
      status?: string;
      validationStatus?: string;
      validationSummary?: string;
      validationDetails?: Record<string, unknown>;
      lastError?: string;
    }>({ version: '20260415_006' });

    expect(history).toMatchObject({
      status: 'failed',
      validationStatus: 'failed',
      validationSummary: 'widget failed post-apply validation',
      validationDetails: { expectedReady: true },
      lastError: 'widget failed post-apply validation',
    });
  });

  test('status surfaces failed migration attempts', async () => {
    if (!isMongoReady()) return;

    const migration: Migration = {
      version: '20260415_003',
      description: 'Always fail',
      async up() {
        throw new Error('boom');
      },
      async down() {
        // no-op
      },
    };

    const runner = new MigrationRunner([migration]);
    const result = await runner.migrate();
    expect(result.failed).toBe('20260415_003');

    const statuses = await runner.status();
    expect(statuses[0]?.status).toBe('failed');
    expect(statuses[0]?.lastError).toContain('boom');
  });

  test('renews the migration lease heartbeat during long-running work', async () => {
    if (!isMongoReady()) return;

    process.env.CHANGE_LOCK_TTL_MS = '40';
    process.env.CHANGE_LOCK_HEARTBEAT_MS = '10';

    let initialExpiresAt = 0;
    let renewedExpiresAt = 0;

    const migration: Migration = {
      version: '20260415_004',
      description: 'Slow migration with heartbeat',
      async up(db) {
        const before = await db
          .collection('_migration_lock')
          .findOne<{ expiresAt?: Date }>({ _id: 'migration_runner' });
        initialExpiresAt = before?.expiresAt?.getTime() ?? 0;

        await new Promise((resolve) => setTimeout(resolve, 70));

        const after = await db
          .collection('_migration_lock')
          .findOne<{ expiresAt?: Date }>({ _id: 'migration_runner' });
        renewedExpiresAt = after?.expiresAt?.getTime() ?? 0;
      },
      async down() {
        // no-op
      },
    };

    const runner = new MigrationRunner([migration]);
    const result = await runner.migrate();

    expect(result.applied).toEqual(['20260415_004']);
    expect(renewedExpiresAt).toBeGreaterThan(initialExpiresAt);

    const sharedHistory = await mongoose.connection
      .db!.collection('_change_history')
      .findOne<{ runCount?: number }>({
        changeId: 'mongodb.20260415_004',
      });
    expect(sharedHistory?.runCount).toBe(1);
  });

  test('skips transaction wrapping for migrations marked transactionMode none', async () => {
    if (!isMongoReady()) return;

    const db = mongoose.connection.db!;
    const originalAdmin = db.admin;
    const startSessionSpy = vi
      .spyOn(mongoose, 'startSession')
      .mockRejectedValue(new Error('startSession should not be called for transactionMode none'));

    (db as typeof db & { admin: () => { command: () => Promise<{ setName: string }> } }).admin =
      () => ({
        command: async () => ({ setName: 'rs0' }),
      });

    const migration: Migration = {
      version: '20260415_005',
      description: 'Non-transactional DDL migration',
      transactionMode: 'none',
      async up(db) {
        await db
          .collection('widgets')
          .updateOne({ _id: 'widget-ddl' }, { $set: { ready: true } }, { upsert: true });
      },
      async down(db) {
        await db.collection('widgets').deleteOne({ _id: 'widget-ddl' });
      },
    };

    try {
      const runner = new MigrationRunner([migration]);
      const result = await runner.migrate();
      expect(result.applied).toEqual(['20260415_005']);
      expect(startSessionSpy).not.toHaveBeenCalled();

      startSessionSpy.mockClear();
      await runner.rollback();
      expect(startSessionSpy).not.toHaveBeenCalled();
    } finally {
      db.admin = originalAdmin;
      startSessionSpy.mockRestore();
    }
  });
});

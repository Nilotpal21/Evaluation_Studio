#!/usr/bin/env npx tsx
/**
 * Migration: Unify trigger types across workflow_executions and trigger_registrations.
 *
 * Remaps legacy trigger type values to the new unified set:
 *   webhook | cron | event | studio | agent
 *
 * workflow_executions:
 *   manual   → studio
 *   api      → webhook  + webhookMode:'sync'
 *   trigger  → webhook  + webhookMode:'async', webhookDelivery:'poll'
 *   schedule → cron
 *   polling  → cron
 *   webhook (missing webhookMode) → webhookMode:'async', webhookDelivery:'poll'
 *
 * trigger_registrations:
 *   Rename field strategy → triggerType
 *   polling   → cron
 *   connector → event
 *
 * Idempotent: skips documents that already have the new values.
 * Run with: npx tsx packages/database/src/migrations/20260414-unified-trigger-types.ts
 */

import mongoose from 'mongoose';

/** Lightweight logger for standalone migration script (no platform deps) */
const log = {
  info: (msg: string, meta?: Record<string, unknown>) =>
    process.stdout.write(`[INFO] ${msg} ${meta ? JSON.stringify(meta) : ''}\n`),
  warn: (msg: string, meta?: Record<string, unknown>) =>
    process.stderr.write(`[WARN] ${msg} ${meta ? JSON.stringify(meta) : ''}\n`),
  error: (msg: string, meta?: Record<string, unknown>) =>
    process.stderr.write(`[ERROR] ${msg} ${meta ? JSON.stringify(meta) : ''}\n`),
};

const EXECUTIONS_COLLECTION = 'workflow_executions';
const REGISTRATIONS_COLLECTION = 'trigger_registrations';

async function migrateExecutions(db: mongoose.mongo.Db): Promise<void> {
  const coll = db.collection(EXECUTIONS_COLLECTION);

  // manual → studio
  const manualResult = await coll.updateMany(
    { triggerType: 'manual' },
    { $set: { triggerType: 'studio' } },
  );
  log.info('Remapped manual → studio', {
    matched: manualResult.matchedCount,
    modified: manualResult.modifiedCount,
  });

  // api → webhook + webhookMode:'sync'
  const apiResult = await coll.updateMany(
    { triggerType: 'api' },
    { $set: { triggerType: 'webhook', webhookMode: 'sync' } },
  );
  log.info('Remapped api → webhook (sync)', {
    matched: apiResult.matchedCount,
    modified: apiResult.modifiedCount,
  });

  // trigger → webhook + webhookMode:'async', webhookDelivery:'poll'
  const triggerResult = await coll.updateMany(
    { triggerType: 'trigger' },
    {
      $set: {
        triggerType: 'webhook',
        webhookMode: 'async',
        webhookDelivery: 'poll',
      },
    },
  );
  log.info('Remapped trigger → webhook (async/poll)', {
    matched: triggerResult.matchedCount,
    modified: triggerResult.modifiedCount,
  });

  // schedule → cron
  const scheduleResult = await coll.updateMany(
    { triggerType: 'schedule' },
    { $set: { triggerType: 'cron' } },
  );
  log.info('Remapped schedule → cron', {
    matched: scheduleResult.matchedCount,
    modified: scheduleResult.modifiedCount,
  });

  // polling (leaked) → cron
  const pollingResult = await coll.updateMany(
    { triggerType: 'polling' },
    { $set: { triggerType: 'cron' } },
  );
  log.info('Remapped polling → cron', {
    matched: pollingResult.matchedCount,
    modified: pollingResult.modifiedCount,
  });

  // Backfill leaked webhook docs missing webhookMode
  const backfillResult = await coll.updateMany(
    { triggerType: 'webhook', webhookMode: { $exists: false } },
    { $set: { webhookMode: 'async', webhookDelivery: 'poll' } },
  );
  log.info('Backfilled webhook docs missing webhookMode', {
    matched: backfillResult.matchedCount,
    modified: backfillResult.modifiedCount,
  });
}

async function migrateRegistrations(db: mongoose.mongo.Db): Promise<void> {
  const coll = db.collection(REGISTRATIONS_COLLECTION);

  // Rename field strategy → triggerType (for docs that still have strategy)
  const renameResult = await coll.updateMany(
    { strategy: { $exists: true } },
    { $rename: { strategy: 'triggerType' } },
  );
  log.info('Renamed strategy → triggerType', {
    matched: renameResult.matchedCount,
    modified: renameResult.modifiedCount,
  });

  // polling → cron
  const pollingResult = await coll.updateMany(
    { triggerType: 'polling' },
    { $set: { triggerType: 'cron' } },
  );
  log.info('Remapped registration polling → cron', {
    matched: pollingResult.matchedCount,
    modified: pollingResult.modifiedCount,
  });

  // connector → event
  const connectorResult = await coll.updateMany(
    { triggerType: 'connector' },
    { $set: { triggerType: 'event' } },
  );
  log.info('Remapped registration connector → event', {
    matched: connectorResult.matchedCount,
    modified: connectorResult.modifiedCount,
  });
}

async function verify(db: mongoose.mongo.Db): Promise<void> {
  const execColl = db.collection(EXECUTIONS_COLLECTION);
  const regColl = db.collection(REGISTRATIONS_COLLECTION);

  const oldExecValues = ['manual', 'api', 'trigger', 'schedule', 'polling'];
  const execRemaining = await execColl.countDocuments({
    triggerType: { $in: oldExecValues },
  });

  const oldRegValues = ['polling', 'connector'];
  const regRemaining = await regColl.countDocuments({
    triggerType: { $in: oldRegValues },
  });

  const strategyRemaining = await regColl.countDocuments({
    strategy: { $exists: true },
  });

  const leakedWebhook = await execColl.countDocuments({
    triggerType: 'webhook',
    webhookMode: { $exists: false },
  });

  if (execRemaining > 0 || regRemaining > 0 || strategyRemaining > 0 || leakedWebhook > 0) {
    log.error('Verification FAILED — old values remain', {
      execRemaining,
      regRemaining,
      strategyRemaining,
      leakedWebhook,
    });
    throw new Error(
      `Migration verification failed: ${execRemaining} old exec values, ${regRemaining} old reg values, ${strategyRemaining} strategy fields, ${leakedWebhook} leaked webhook docs`,
    );
  }

  log.info('Verification passed — no old values remain');
}

async function main(): Promise<void> {
  const uri =
    process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/abl-platform';

  log.info('Connecting to MongoDB', {
    uri: uri.replace(/\/\/[^@]+@/, '//<redacted>@'),
  });
  await mongoose.connect(uri);
  log.info('Connected');

  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('Failed to get database reference from mongoose connection');
  }

  try {
    log.info('Migrating workflow_executions...');
    await migrateExecutions(db);

    log.info('Migrating trigger_registrations...');
    await migrateRegistrations(db);

    log.info('Running verification...');
    await verify(db);

    log.info('Migration completed successfully');
  } finally {
    await mongoose.disconnect();
    log.info('Disconnected from MongoDB');
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  // Use process.stderr since the logger may not be available if the import fails
  process.stderr.write(`Migration failed: ${message}\n`);
  process.exit(1);
});

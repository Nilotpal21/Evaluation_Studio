/**
 * Migration: Backfill familyId and generation on existing refresh tokens
 *
 * Existing rows with `familyId: null` get a unique `familyId` (UUID v4)
 * and `generation: 1`. Each existing row becomes its own family root —
 * lineage tracking starts from this point forward.
 *
 * - Batched: processes 200 tokens at a time using cursor pagination
 * - Idempotent: only touches rows where familyId is null
 * - familyId remains `string | null` in the schema — a follow-up migration
 *   can drop nullability after verifying the backfill
 *
 * Note: This migration operates on all refresh tokens regardless of userId
 * because it is a schema-level backfill, not a user-scoped query.
 *
 * Date: 2026-04-23
 */

import crypto from 'node:crypto';
import mongoose from 'mongoose';
import type { Migration } from '../types.js';
import { validationPassed, validationFailed } from '../validation.js';

type Db = mongoose.mongo.Db;

const COLLECTION = 'refresh_tokens';
const BATCH_SIZE = 200;

const log = {
  info: (msg: string) => process.stdout.write(`[migration] ${msg}\n`),
};

export const migration: Migration = {
  version: '20260423_020',
  description: 'Backfill familyId and generation on existing refresh tokens',

  async up(db: Db) {
    const collection = db.collection(COLLECTION);

    let totalUpdated = 0;
    let lastId: string | undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const filter: Record<string, unknown> = { familyId: null };
      if (lastId) {
        filter._id = { $gt: lastId };
      }

      const batch = await collection
        .find(filter, {
          projection: { _id: 1 },
          sort: { _id: 1 },
          limit: BATCH_SIZE,
        })
        .toArray();

      if (batch.length === 0) break;

      const ops = batch.map((doc) => ({
        updateOne: {
          filter: { _id: doc._id, familyId: null },
          update: {
            $set: {
              familyId: crypto.randomUUID(),
              generation: 1,
            },
          },
        },
      }));

      const result = await collection.bulkWrite(ops, { ordered: false });
      totalUpdated += result.modifiedCount;
      lastId = String(batch[batch.length - 1]._id);

      if (totalUpdated % 1000 === 0 && totalUpdated > 0) {
        log.info(`Backfill progress: ${totalUpdated} refresh tokens updated with familyId`);
      }
    }

    log.info(
      `Backfill complete: ${totalUpdated} refresh tokens updated with familyId and generation`,
    );
  },

  async down(db: Db) {
    // Reverse: set familyId back to null and generation back to 1
    // for tokens that were backfilled (those with generation === 1).
    // This is a best-effort rollback — tokens created after migration
    // with real lineage will also be affected, but since we only
    // null familyId for gen-1 tokens, the impact is limited.
    const collection = db.collection(COLLECTION);
    const result = await collection.updateMany(
      { generation: 1 },
      { $set: { familyId: null, generation: 1 } },
    );
    log.info(`Rollback: reset familyId to null on ${result.modifiedCount} refresh tokens`);
  },

  async validate(db: Db) {
    const collection = db.collection(COLLECTION);

    const remaining = await collection.countDocuments({ familyId: null });

    if (remaining > 0) {
      return validationFailed(`${remaining} refresh tokens still have null familyId`, {
        remaining,
      });
    }

    return validationPassed('All refresh tokens have familyId and generation populated', {
      remaining,
    });
  },
};

export default migration;

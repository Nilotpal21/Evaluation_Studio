/**
 * Migration: backfill profileType on auth_profiles
 *
 * Sets `profileType = 'integration'` for rows with a non-null `connector` field,
 * and `profileType = 'custom'` for rows without a `connector`.
 *
 * Idempotent: only updates rows where `profileType` is not already set.
 * Reversible: `down()` removes the `profileType` field from all rows.
 *
 * Date: 2026-05-08
 */

import mongoose from 'mongoose';
import type { Migration } from '../types.js';

type Db = mongoose.mongo.Db;

const log = {
  info: (msg: string) => process.stdout.write(`[migration] ${msg}\n`),
};

const COLLECTION = 'auth_profiles';

export const migration: Migration = {
  version: '20260508_019',
  description: 'Backfill profileType from connector presence on auth_profiles',
  transactionMode: 'none',

  async up(db: Db) {
    const col = db.collection(COLLECTION);

    // Case 1: rows with connector → 'integration'
    const integrationResult = await col.updateMany(
      {
        connector: { $ne: null, $exists: true, $nin: ['', undefined] },
        profileType: { $exists: false },
      },
      { $set: { profileType: 'integration' } },
    );
    log.info(`Backfilled ${integrationResult.modifiedCount} auth_profiles as 'integration'`);

    // Case 2: rows without connector (null, missing, or empty) → 'custom'
    const customResult = await col.updateMany(
      {
        $or: [{ connector: null }, { connector: { $exists: false } }, { connector: '' }],
        profileType: { $exists: false },
      },
      { $set: { profileType: 'custom' } },
    );
    log.info(`Backfilled ${customResult.modifiedCount} auth_profiles as 'custom'`);
  },

  async down(db: Db) {
    const col = db.collection(COLLECTION);
    const result = await col.updateMany({}, { $unset: { profileType: '' } });
    log.info(`Unset profileType on ${result.modifiedCount} auth_profiles`);
  },

  async validate(db: Db) {
    const col = db.collection(COLLECTION);
    const missingCount = await col.countDocuments({
      profileType: { $exists: false },
    });

    if (missingCount > 0) {
      return {
        ok: false,
        summary: `${missingCount} auth_profiles rows still missing profileType`,
        details: { missingCount },
      };
    }

    return {
      ok: true,
      summary: 'All auth_profiles rows have profileType set',
    };
  },
};

export default migration;

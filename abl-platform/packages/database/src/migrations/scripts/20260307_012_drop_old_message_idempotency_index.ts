/**
 * Migration: Drop old message idempotencyKey index
 *
 * The message model previously had a unique sparse index on {idempotencyKey: 1}.
 * It was changed to a tenant+session-scoped compound index:
 *   {tenantId: 1, sessionId: 1, idempotencyKey: 1} (unique, partialFilterExpression)
 *
 * Mongoose only creates new indexes — it never drops old ones. So existing
 * databases may still have the old index, which causes duplicate key errors
 * when different sessions/tenants reuse the same idempotencyKey value.
 *
 * This migration drops the old index if it exists.
 *
 * Date: 2026-03-07
 */

import mongoose from 'mongoose';
import type { Migration } from '../types.js';
import { hasIndex, validationFailed, validationPassed } from '../validation.js';

type Db = mongoose.mongo.Db;

const COLLECTION = 'messages';
const OLD_INDEX_NAME = 'idempotencyKey_1';

export const migration: Migration = {
  version: '20260307_012',
  description: 'Drop old message idempotencyKey sparse unique index (replaced by compound index)',

  async up(db: Db) {
    const col = db.collection(COLLECTION);

    try {
      await col.dropIndex(OLD_INDEX_NAME);
      console.log(`[migration] Dropped old index: ${OLD_INDEX_NAME}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Index may not exist (fresh databases or already dropped) — safe to continue
      console.log(`[migration] Index ${OLD_INDEX_NAME} not found (${message}), continuing`);
    }
  },

  async down(db: Db) {
    const col = db.collection(COLLECTION);

    // Restore the old sparse unique index
    await col.createIndex({ idempotencyKey: 1 }, { unique: true, sparse: true });
    console.log('[migration] Restored old sparse unique index on idempotencyKey');
  },

  async validate(db: Db) {
    const oldIndexPresent = await hasIndex(
      db,
      COLLECTION,
      { idempotencyKey: 1 },
      { name: OLD_INDEX_NAME },
    );

    if (oldIndexPresent) {
      return validationFailed('The legacy message idempotency index still exists', {
        oldIndexPresent,
      });
    }

    return validationPassed('The legacy message idempotency index has been removed', {
      oldIndexPresent,
    });
  },
};

export default migration;

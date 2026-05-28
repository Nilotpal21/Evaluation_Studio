/**
 * Migration: fix workflow name uniqueness index to exclude soft-deleted documents
 *
 * The original index `{ tenantId, projectId, name }` (unique) had no partial filter,
 * so soft-deleted or archived workflows permanently blocked re-use of their name.
 * The new index adds `partialFilterExpression: { deleted: false }` so that
 * only live workflows compete for name uniqueness within a project.
 *
 * Date: 2026-04-23
 */

import type { Migration } from '../types.js';
import { hasIndex, validationFailed, validationPassed } from '../validation.js';
import type mongoose from 'mongoose';

type Db = mongoose.mongo.Db;

const COLLECTION = 'workflows';
const OLD_INDEX_NAME = 'tenantId_1_projectId_1_name_1';
const NEW_INDEX_NAME = 'tenantId_1_projectId_1_name_1_active';
const INDEX_KEY = { tenantId: 1, projectId: 1, name: 1 } as const;

export const migration: Migration = {
  version: '20260423_022',
  description: 'Fix workflow name uniqueness index to exclude soft-deleted documents',
  transactionMode: 'none',

  async up(db: Db) {
    const col = db.collection(COLLECTION);

    try {
      await col.dropIndex(OLD_INDEX_NAME);
      console.log(`[migration] Dropped old index: ${OLD_INDEX_NAME}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[migration] Index ${OLD_INDEX_NAME} not found (${message}), continuing`);
    }

    await col.createIndex(INDEX_KEY, {
      name: NEW_INDEX_NAME,
      unique: true,
      partialFilterExpression: { deleted: false },
    });
    console.log(`[migration] Created new partial unique index: ${NEW_INDEX_NAME}`);
  },

  async down(db: Db) {
    const col = db.collection(COLLECTION);

    try {
      await col.dropIndex(NEW_INDEX_NAME);
      console.log(`[migration] Dropped new index: ${NEW_INDEX_NAME}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[migration] Index ${NEW_INDEX_NAME} not found (${message}), continuing`);
    }

    await col.createIndex(INDEX_KEY, {
      name: OLD_INDEX_NAME,
      unique: true,
    });
    console.log(`[migration] Restored old index: ${OLD_INDEX_NAME}`);
  },

  async validate(db: Db) {
    const newIndexPresent = await hasIndex(db, COLLECTION, INDEX_KEY, {
      unique: true,
      name: NEW_INDEX_NAME,
      partialFilterExpression: { deleted: false },
    });
    const oldIndexPresent = await hasIndex(db, COLLECTION, INDEX_KEY, {
      unique: true,
      name: OLD_INDEX_NAME,
    });

    if (!newIndexPresent || oldIndexPresent) {
      return validationFailed('workflow name uniqueness index does not match expected state', {
        newIndexPresent,
        oldIndexPresent,
      });
    }

    return validationPassed(
      'workflow name uniqueness index correctly excludes soft-deleted documents',
      { newIndexPresent, oldIndexPresent },
    );
  },
};

export default migration;

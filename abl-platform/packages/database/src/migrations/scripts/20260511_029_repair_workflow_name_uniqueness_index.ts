/**
 * Migration: repair workflow name uniqueness index.
 *
 * Some environments can end up with the legacy `{ tenantId, projectId, name }`
 * unique index, the newer `_active` partial unique index, or both, depending on
 * how index creation raced with prior deploys. Normalize the collection by
 * dropping both known names and recreating the canonical partial unique index.
 */

import type { Migration } from '../types.js';
import { hasIndex, validationFailed, validationPassed } from '../validation.js';
import type mongoose from 'mongoose';

type Db = mongoose.mongo.Db;

const COLLECTION = 'workflows';
const OLD_INDEX_NAME = 'tenantId_1_projectId_1_name_1';
const NEW_INDEX_NAME = 'tenantId_1_projectId_1_name_1_active';
const INDEX_KEY = { tenantId: 1, projectId: 1, name: 1 } as const;
const INDEX_NAMES_TO_DROP = [OLD_INDEX_NAME, NEW_INDEX_NAME] as const;

async function dropIndexIfPresent(
  collection: mongoose.mongo.Collection,
  indexName: string,
): Promise<boolean> {
  try {
    await collection.dropIndex(indexName);
    console.log(`[migration] Dropped workflow name index: ${indexName}`);
    return true;
  } catch (err: unknown) {
    const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : null;
    const codeName =
      typeof err === 'object' && err !== null ? (err as { codeName?: unknown }).codeName : null;
    if (code === 27 || codeName === 'IndexNotFound') {
      console.log(`[migration] Workflow name index ${indexName} not found; skipping drop`);
      return false;
    }
    throw err;
  }
}

async function ensureCanonicalIndex(collection: mongoose.mongo.Collection): Promise<void> {
  await collection.createIndex(INDEX_KEY, {
    name: NEW_INDEX_NAME,
    unique: true,
    partialFilterExpression: { deleted: false },
  });
  console.log(`[migration] Ensured canonical workflow name index: ${NEW_INDEX_NAME}`);
}

export const migration: Migration = {
  version: '20260511_029',
  description: 'Repair workflow name uniqueness index and force canonical _active partial index',
  transactionMode: 'none',

  async up(db: Db) {
    const collection = db.collection(COLLECTION);

    for (const indexName of INDEX_NAMES_TO_DROP) {
      await dropIndexIfPresent(collection, indexName);
    }

    await ensureCanonicalIndex(collection);
  },

  async down(db: Db) {
    const collection = db.collection(COLLECTION);

    for (const indexName of INDEX_NAMES_TO_DROP) {
      await dropIndexIfPresent(collection, indexName);
    }

    await collection.createIndex(INDEX_KEY, {
      name: OLD_INDEX_NAME,
      unique: true,
    });
    console.log(`[migration] Restored legacy workflow name index: ${OLD_INDEX_NAME}`);
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
      return validationFailed(
        'workflow name uniqueness index has not been normalized to the canonical _active partial index',
        {
          newIndexPresent,
          oldIndexPresent,
        },
      );
    }

    return validationPassed(
      'workflow name uniqueness index is normalized to the canonical _active partial index',
      {
        newIndexPresent,
        oldIndexPresent,
      },
    );
  },
};

export default migration;

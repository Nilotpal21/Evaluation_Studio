/**
 * Migration: repair project identity indexes.
 *
 * Project slugs are unique within a workspace/tenant, not globally. Project
 * names are not an identity field and may repeat across tenants. Some
 * environments can still carry legacy global unique indexes on `slug` or
 * `name`; those indexes make otherwise valid cross-workspace project creation
 * fail with duplicate key errors.
 */

import type mongoose from 'mongoose';
import type { Migration } from '../types.js';
import { hasIndex, validationFailed, validationPassed } from '../validation.js';

type Db = mongoose.mongo.Db;
type IndexDescription = mongoose.mongo.IndexDescriptionInfo;

const COLLECTION = 'projects';
const CANONICAL_SLUG_INDEX_NAME = 'tenantId_1_slug_1';
const NAME_LOOKUP_INDEX_NAME = 'tenantId_1_name_1';
const GLOBAL_UNIQUE_INDEX_KEYS = [{ slug: 1 }, { name: 1 }] as const;
const CANONICAL_SLUG_INDEX_KEY = { tenantId: 1, slug: 1 } as const;
const NAME_LOOKUP_INDEX_KEY = { tenantId: 1, name: 1 } as const;

function writeMigrationLog(message: string): void {
  process.stdout.write(`[migration] ${message}\n`);
}

function sameIndexKey(left: IndexDescription['key'], right: Record<string, 1>): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right);
}

async function dropLegacyGlobalUniqueIndexes(db: Db): Promise<string[]> {
  const collection = db.collection(COLLECTION);
  const indexes = await collection.indexes();
  const dropped: string[] = [];

  for (const index of indexes) {
    if (
      index.name &&
      index.unique === true &&
      GLOBAL_UNIQUE_INDEX_KEYS.some((key) => sameIndexKey(index.key, key))
    ) {
      await collection.dropIndex(index.name);
      dropped.push(index.name);
      writeMigrationLog(`Dropped legacy global project uniqueness index ${index.name}`);
    }
  }

  return dropped;
}

async function ensureCanonicalIndexes(collection: mongoose.mongo.Collection): Promise<void> {
  await collection.createIndex(CANONICAL_SLUG_INDEX_KEY, {
    name: CANONICAL_SLUG_INDEX_NAME,
    unique: true,
  });
  writeMigrationLog(`Ensured canonical project slug index: ${CANONICAL_SLUG_INDEX_NAME}`);

  await collection.createIndex(NAME_LOOKUP_INDEX_KEY, {
    name: NAME_LOOKUP_INDEX_NAME,
  });
  writeMigrationLog(`Ensured project name lookup index: ${NAME_LOOKUP_INDEX_NAME}`);
}

export const migration: Migration = {
  version: '20260516_035',
  description: 'Repair project name and slug indexes to use tenant-scoped identity',
  transactionMode: 'none',

  async up(db: Db) {
    const collection = db.collection(COLLECTION);

    await dropLegacyGlobalUniqueIndexes(db);
    await ensureCanonicalIndexes(collection);
  },

  async down() {
    // Rollback is intentionally a no-op: the legacy global indexes were the
    // bug. Recreating them would reject valid cross-workspace projects and may
    // fail after duplicates have been created in different tenants.
    writeMigrationLog(
      'Rollback is a no-op because restoring global project uniqueness would reject valid cross-tenant projects',
    );
  },

  async validate(db: Db) {
    const collection = db.collection(COLLECTION);
    const [canonicalSlugIndexPresent, nameLookupIndexPresent, legacyGlobalUniqueIndexes] =
      await Promise.all([
        hasIndex(db, COLLECTION, CANONICAL_SLUG_INDEX_KEY, {
          unique: true,
          name: CANONICAL_SLUG_INDEX_NAME,
        }),
        hasIndex(db, COLLECTION, NAME_LOOKUP_INDEX_KEY, {
          name: NAME_LOOKUP_INDEX_NAME,
        }),
        collection
          .indexes()
          .then((indexes) =>
            indexes
              .filter(
                (index) =>
                  index.unique === true &&
                  GLOBAL_UNIQUE_INDEX_KEYS.some((key) => sameIndexKey(index.key, key)),
              )
              .map((index) => index.name),
          ),
      ]);

    if (
      !canonicalSlugIndexPresent ||
      !nameLookupIndexPresent ||
      legacyGlobalUniqueIndexes.length > 0
    ) {
      return validationFailed(
        'project identity indexes have not been normalized to tenant-scoped slug uniqueness',
        {
          canonicalSlugIndexPresent,
          nameLookupIndexPresent,
          legacyGlobalUniqueIndexes,
        },
      );
    }

    return validationPassed('project identity indexes are tenant-scoped', {
      canonicalSlugIndexPresent,
      nameLookupIndexPresent,
      legacyGlobalUniqueIndexes,
    });
  },
};

export default migration;

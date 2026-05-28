/**
 * Migration: Backfill tenantId on model_configs and enforce tenant-scoped indexes.
 *
 * Project ModelConfig rows are imported/exported across tenants, but once they
 * land in a destination project every runtime lookup must be tenant-scoped.
 */

import mongoose from 'mongoose';
import type { Migration } from '../types.js';
import { hasIndex, validationFailed, validationPassed } from '../validation.js';

type Db = mongoose.mongo.Db;

interface ProjectTenantDocument {
  _id: string;
  tenantId?: string | null;
}

interface ModelConfigDocument {
  _id: string;
  projectId?: string | null;
  tenantId?: string | null;
}

const COLLECTION = 'model_configs';
const PROJECTS_COLLECTION = 'projects';
const BATCH_SIZE = 200;

const CURRENT_UNIQUE_INDEX_KEY = { tenantId: 1, projectId: 1, name: 1 } as const;
const CURRENT_PROJECT_INDEX_KEY = { tenantId: 1, projectId: 1 } as const;
const CURRENT_MODEL_ID_INDEX_KEY = { tenantId: 1, projectId: 1, modelId: 1 } as const;
const CURRENT_TIER_DEFAULT_INDEX_KEY = {
  tenantId: 1,
  projectId: 1,
  tier: 1,
  isDefault: 1,
} as const;
const CURRENT_DEFAULT_INDEX_KEY = { tenantId: 1, projectId: 1, isDefault: 1 } as const;

const LEGACY_UNIQUE_INDEX_KEY = { projectId: 1, name: 1 } as const;
const LEGACY_PROJECT_INDEX_KEY = { projectId: 1 } as const;
const LEGACY_MODEL_ID_INDEX_KEY = { projectId: 1, modelId: 1 } as const;
const LEGACY_TIER_DEFAULT_INDEX_KEY = { projectId: 1, tier: 1, isDefault: 1 } as const;
const LEGACY_DEFAULT_INDEX_KEY = { projectId: 1, isDefault: 1 } as const;

const log = {
  info: (msg: string) => process.stdout.write(`[migration] ${msg}\n`),
  warn: (msg: string) => process.stdout.write(`[migration] WARN ${msg}\n`),
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function tenantGapClauses() {
  return [{ tenantId: { $exists: false } }, { tenantId: null }, { tenantId: '' }];
}

function keysEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && a[key] === b[key])
  );
}

async function backfillTenantIds(db: Db): Promise<void> {
  const collection = db.collection<ModelConfigDocument>(COLLECTION);
  const projects = db.collection<ProjectTenantDocument>(PROJECTS_COLLECTION);
  let processed = 0;
  let updated = 0;
  let unresolved = 0;
  let lastId: string | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const filter: Record<string, unknown> = { $or: tenantGapClauses() };
    if (lastId) {
      filter._id = { $gt: lastId };
    }

    const batch = await collection
      .find(filter, {
        projection: { _id: 1, projectId: 1 },
        sort: { _id: 1 },
        limit: BATCH_SIZE,
      })
      .toArray();

    if (batch.length === 0) break;

    const projectIds = [
      ...new Set(
        batch.map((doc) => doc.projectId).filter((projectId) => isNonEmptyString(projectId)),
      ),
    ];
    const projectDocs = await projects
      .find(
        { _id: { $in: projectIds }, tenantId: { $nin: [null, ''] } },
        { projection: { _id: 1, tenantId: 1 } },
      )
      .toArray();
    const projectTenantMap = new Map(
      projectDocs
        .filter((doc): doc is ProjectTenantDocument & { tenantId: string } =>
          isNonEmptyString(doc.tenantId),
        )
        .map((doc) => [doc._id, doc.tenantId]),
    );

    const ops = batch.flatMap((doc) => {
      const projectId = isNonEmptyString(doc.projectId) ? doc.projectId : null;
      const tenantId = projectId ? projectTenantMap.get(projectId) : null;
      if (!tenantId) {
        unresolved += 1;
        return [];
      }

      return [
        {
          updateOne: {
            filter: { _id: doc._id, $or: tenantGapClauses() },
            update: { $set: { tenantId } },
          },
        },
      ];
    });

    if (ops.length > 0) {
      const result = await collection.bulkWrite(ops, { ordered: false });
      updated += result.modifiedCount;
    }

    processed += batch.length;
    lastId = String(batch[batch.length - 1]._id);
  }

  log.info(`model_configs: processed ${processed}, updated ${updated}, unresolved ${unresolved}`);
}

async function dropIndexByKey(
  db: Db,
  key: Record<string, 1 | -1>,
  unique?: boolean,
): Promise<void> {
  const collection = db.collection(COLLECTION);
  const indexes = await collection.indexes();
  const index = indexes.find(
    (entry) =>
      keysEqual(entry.key as Record<string, unknown>, key) &&
      (unique === undefined || (entry as { unique?: boolean }).unique === unique),
  );

  if (!index?.name) return;

  await collection.dropIndex(index.name);
  log.info(`${COLLECTION}: dropped legacy index ${index.name}`);
}

async function ensureTenantIndexes(db: Db): Promise<void> {
  const collection = db.collection(COLLECTION);
  await collection.createIndex(CURRENT_UNIQUE_INDEX_KEY, {
    name: 'tenantId_1_projectId_1_name_1',
    unique: true,
  });
  await collection.createIndex(CURRENT_PROJECT_INDEX_KEY, {
    name: 'tenantId_1_projectId_1',
  });
  await collection.createIndex(CURRENT_MODEL_ID_INDEX_KEY, {
    name: 'tenantId_1_projectId_1_modelId_1',
  });
  await collection.createIndex(CURRENT_TIER_DEFAULT_INDEX_KEY, {
    name: 'tenantId_1_projectId_1_tier_1_isDefault_1',
  });
  await collection.createIndex(CURRENT_DEFAULT_INDEX_KEY, {
    name: 'tenantId_1_projectId_1_isDefault_1',
  });
}

async function countRemainingEligibleRows(db: Db): Promise<number> {
  const [result] = await db
    .collection(COLLECTION)
    .aggregate<{ count: number }>([
      { $match: { $or: tenantGapClauses() } },
      {
        $lookup: {
          from: PROJECTS_COLLECTION,
          localField: 'projectId',
          foreignField: '_id',
          as: 'projectDocs',
        },
      },
      { $unwind: '$projectDocs' },
      { $match: { 'projectDocs.tenantId': { $nin: [null, ''] } } },
      { $count: 'count' },
    ])
    .toArray();

  return result?.count ?? 0;
}

export const migration: Migration = {
  version: '20260505_027',
  description: 'Backfill ModelConfig tenantId and enforce tenant-scoped indexes',
  transactionMode: 'none',

  async up(db: Db) {
    await backfillTenantIds(db);
    await ensureTenantIndexes(db);
    await dropIndexByKey(db, LEGACY_UNIQUE_INDEX_KEY, true);
    await dropIndexByKey(db, LEGACY_PROJECT_INDEX_KEY);
    await dropIndexByKey(db, LEGACY_MODEL_ID_INDEX_KEY);
    await dropIndexByKey(db, LEGACY_TIER_DEFAULT_INDEX_KEY);
    await dropIndexByKey(db, LEGACY_DEFAULT_INDEX_KEY);
  },

  async down() {
    log.warn(
      'Rollback is a no-op because recreating non-tenant-scoped ModelConfig indexes would reintroduce cross-tenant collision risk',
    );
  },

  async validate(db: Db) {
    const remainingEligibleRows = await countRemainingEligibleRows(db);
    const currentUniqueIndexPresent = await hasIndex(db, COLLECTION, CURRENT_UNIQUE_INDEX_KEY, {
      unique: true,
    });
    const currentProjectIndexPresent = await hasIndex(db, COLLECTION, CURRENT_PROJECT_INDEX_KEY);
    const currentModelIdIndexPresent = await hasIndex(db, COLLECTION, CURRENT_MODEL_ID_INDEX_KEY);
    const currentTierDefaultIndexPresent = await hasIndex(
      db,
      COLLECTION,
      CURRENT_TIER_DEFAULT_INDEX_KEY,
    );
    const currentDefaultIndexPresent = await hasIndex(db, COLLECTION, CURRENT_DEFAULT_INDEX_KEY);
    const legacyUniqueIndexPresent = await hasIndex(db, COLLECTION, LEGACY_UNIQUE_INDEX_KEY, {
      unique: true,
    });
    const legacyProjectIndexPresent = await hasIndex(db, COLLECTION, LEGACY_PROJECT_INDEX_KEY);
    const legacyModelIdIndexPresent = await hasIndex(db, COLLECTION, LEGACY_MODEL_ID_INDEX_KEY);
    const legacyTierDefaultIndexPresent = await hasIndex(
      db,
      COLLECTION,
      LEGACY_TIER_DEFAULT_INDEX_KEY,
    );
    const legacyDefaultIndexPresent = await hasIndex(db, COLLECTION, LEGACY_DEFAULT_INDEX_KEY);

    if (
      remainingEligibleRows > 0 ||
      !currentUniqueIndexPresent ||
      !currentProjectIndexPresent ||
      !currentModelIdIndexPresent ||
      !currentTierDefaultIndexPresent ||
      !currentDefaultIndexPresent ||
      legacyUniqueIndexPresent ||
      legacyProjectIndexPresent ||
      legacyModelIdIndexPresent ||
      legacyTierDefaultIndexPresent ||
      legacyDefaultIndexPresent
    ) {
      return validationFailed('ModelConfig tenant-scoped migration is incomplete', {
        remainingEligibleRows,
        currentUniqueIndexPresent,
        currentProjectIndexPresent,
        currentModelIdIndexPresent,
        currentTierDefaultIndexPresent,
        currentDefaultIndexPresent,
        legacyUniqueIndexPresent,
        legacyProjectIndexPresent,
        legacyModelIdIndexPresent,
        legacyTierDefaultIndexPresent,
        legacyDefaultIndexPresent,
      });
    }

    return validationPassed('ModelConfig tenantId and tenant-scoped indexes are ready', {
      remainingEligibleRows,
      currentUniqueIndexPresent,
      currentProjectIndexPresent,
      currentModelIdIndexPresent,
      currentTierDefaultIndexPresent,
      currentDefaultIndexPresent,
      legacyUniqueIndexPresent,
      legacyProjectIndexPresent,
      legacyModelIdIndexPresent,
      legacyTierDefaultIndexPresent,
      legacyDefaultIndexPresent,
    });
  },
};

export default migration;

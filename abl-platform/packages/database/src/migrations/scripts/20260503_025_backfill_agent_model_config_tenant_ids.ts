/**
 * Migration: Backfill tenantId on agent_model_configs and enforce tenant-scoped indexes.
 *
 * AgentModelConfig used to be keyed only by projectId + agentName. Newer runtime
 * and Studio paths require tenant-scoped reads and writes, so historical rows need
 * tenantId copied from their parent Project before the schema/index contract can be
 * trusted.
 *
 * Date: 2026-05-03
 */

import mongoose from 'mongoose';
import type { Migration } from '../types.js';
import { hasIndex, validationFailed, validationPassed } from '../validation.js';

type Db = mongoose.mongo.Db;

interface ProjectTenantDocument {
  _id: string;
  tenantId?: string | null;
}

interface AgentModelConfigDocument {
  _id: string;
  projectId?: string | null;
  tenantId?: string | null;
}

const COLLECTION = 'agent_model_configs';
const PROJECTS_COLLECTION = 'projects';
const BATCH_SIZE = 200;

const CURRENT_UNIQUE_INDEX_KEY = { tenantId: 1, projectId: 1, agentName: 1 } as const;
const CURRENT_PROJECT_INDEX_KEY = { tenantId: 1, projectId: 1 } as const;
const LEGACY_UNIQUE_INDEX_KEY = { projectId: 1, agentName: 1 } as const;
const LEGACY_PROJECT_INDEX_KEY = { projectId: 1 } as const;

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
  if (aKeys.length !== bKeys.length) return false;
  if (aKeys.some((key) => !(key in b))) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

async function backfillTenantIds(db: Db): Promise<{
  processed: number;
  updated: number;
  unresolved: number;
}> {
  const collection = db.collection<AgentModelConfigDocument>(COLLECTION);
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

    if (batch.length === 0) {
      break;
    }

    const projectIds = [
      ...new Set(
        batch.map((doc) => doc.projectId).filter((projectId) => isNonEmptyString(projectId)),
      ),
    ];
    const projectDocs = await projects
      .find(
        {
          _id: { $in: projectIds },
          tenantId: { $nin: [null, ''] },
        },
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
            filter: {
              _id: doc._id,
              $or: tenantGapClauses(),
            },
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

  log.info(
    `agent_model_configs: processed ${processed}, updated ${updated}, unresolved ${unresolved}`,
  );
  return { processed, updated, unresolved };
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

  if (!index?.name) {
    log.info(`${COLLECTION}: legacy index ${JSON.stringify(key)} not found`);
    return;
  }

  await collection.dropIndex(index.name);
  log.info(`${COLLECTION}: dropped legacy index ${index.name}`);
}

async function ensureTenantIndexes(db: Db): Promise<void> {
  const collection = db.collection(COLLECTION);
  await collection.createIndex(CURRENT_UNIQUE_INDEX_KEY, {
    name: 'tenantId_1_projectId_1_agentName_1',
    unique: true,
  });
  await collection.createIndex(CURRENT_PROJECT_INDEX_KEY, {
    name: 'tenantId_1_projectId_1',
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
  version: '20260503_025',
  description: 'Backfill AgentModelConfig tenantId and enforce tenant-scoped indexes',
  transactionMode: 'none',

  async up(db: Db) {
    await backfillTenantIds(db);
    await ensureTenantIndexes(db);
    await dropIndexByKey(db, LEGACY_UNIQUE_INDEX_KEY, true);
    await dropIndexByKey(db, LEGACY_PROJECT_INDEX_KEY);
  },

  async down() {
    log.warn(
      'Rollback is a no-op because recreating non-tenant-scoped AgentModelConfig indexes would reintroduce cross-tenant collision risk',
    );
  },

  async validate(db: Db) {
    const remainingEligibleRows = await countRemainingEligibleRows(db);
    const currentUniqueIndexPresent = await hasIndex(db, COLLECTION, CURRENT_UNIQUE_INDEX_KEY, {
      unique: true,
    });
    const currentProjectIndexPresent = await hasIndex(db, COLLECTION, CURRENT_PROJECT_INDEX_KEY);
    const legacyUniqueIndexPresent = await hasIndex(db, COLLECTION, LEGACY_UNIQUE_INDEX_KEY, {
      unique: true,
    });

    if (
      remainingEligibleRows > 0 ||
      !currentUniqueIndexPresent ||
      !currentProjectIndexPresent ||
      legacyUniqueIndexPresent
    ) {
      return validationFailed('AgentModelConfig tenant-scoped migration is incomplete', {
        remainingEligibleRows,
        currentUniqueIndexPresent,
        currentProjectIndexPresent,
        legacyUniqueIndexPresent,
      });
    }

    return validationPassed('AgentModelConfig tenantId and tenant-scoped indexes are ready', {
      remainingEligibleRows,
      currentUniqueIndexPresent,
      currentProjectIndexPresent,
      legacyUniqueIndexPresent,
    });
  },
};

export default migration;

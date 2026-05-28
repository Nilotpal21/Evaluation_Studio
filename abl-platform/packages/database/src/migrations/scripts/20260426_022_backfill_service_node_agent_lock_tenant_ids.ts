/**
 * Migration: Backfill tenantId on service_nodes and agent_locks from their parent project
 *
 * Existing rows written before Studio started persisting tenantId on these
 * collections need a one-time backfill so the new tenant-scoped schema/index
 * contract applies to historical documents as well.
 *
 * Backfill strategy:
 * - Iterate rows with missing/null/empty tenantId in stable _id order
 * - Resolve projectId -> Project.tenantId in batches
 * - Update only rows that still have a tenantId gap at write time
 * - Leave rows whose parent project has no tenantId untouched (best effort)
 *
 * Date: 2026-04-26
 */

import mongoose from 'mongoose';
import type { Migration } from '../types.js';
import { validationFailed, validationPassed } from '../validation.js';

type Db = mongoose.mongo.Db;

interface ProjectTenantDocument {
  _id: string;
  tenantId?: string | null;
}

interface BackfillableDocument {
  _id: string;
  projectId?: string | null;
  tenantId?: string | null;
}

const PROJECTS_COLLECTION = 'projects';
const BATCH_SIZE = 200;

const TARGET_COLLECTIONS = [
  { name: 'service_nodes', label: 'service nodes' },
  { name: 'agent_locks', label: 'agent locks' },
] as const;

const log = {
  info: (msg: string) => process.stdout.write(`[migration] ${msg}\n`),
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function tenantGapClauses() {
  return [{ tenantId: { $exists: false } }, { tenantId: null }, { tenantId: '' }];
}

function buildTenantGapFilter(lastId?: string): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    $or: tenantGapClauses(),
  };

  if (lastId) {
    filter._id = { $gt: lastId };
  }

  return filter;
}

async function backfillCollection(
  db: Db,
  collectionName: string,
  label: string,
): Promise<{ processed: number; updated: number; unresolved: number }> {
  const collection = db.collection<BackfillableDocument>(collectionName);
  const projects = db.collection<ProjectTenantDocument>(PROJECTS_COLLECTION);

  let processed = 0;
  let updated = 0;
  let unresolved = 0;
  let lastId: string | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await collection
      .find(buildTenantGapFilter(lastId), {
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
        {
          projection: { _id: 1, tenantId: 1 },
        },
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
            update: {
              $set: { tenantId },
            },
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

    if (processed % 1000 === 0) {
      log.info(`${label}: processed ${processed}, updated ${updated}, unresolved ${unresolved}`);
    }
  }

  log.info(`${label}: processed ${processed}, updated ${updated}, unresolved ${unresolved}`);
  return { processed, updated, unresolved };
}

async function countRemainingEligibleRows(db: Db, collectionName: string): Promise<number> {
  const [result] = await db
    .collection(collectionName)
    .aggregate<{ count: number }>([
      {
        $match: {
          $or: tenantGapClauses(),
        },
      },
      {
        $lookup: {
          from: PROJECTS_COLLECTION,
          localField: 'projectId',
          foreignField: '_id',
          as: 'projectDocs',
        },
      },
      { $unwind: '$projectDocs' },
      {
        $match: {
          'projectDocs.tenantId': { $nin: [null, ''] },
        },
      },
      { $count: 'count' },
    ])
    .toArray();

  return result?.count ?? 0;
}

export const migration: Migration = {
  version: '20260426_022',
  description: 'Backfill tenantId on service nodes and agent locks from their projects',

  async up(db: Db) {
    for (const target of TARGET_COLLECTIONS) {
      await backfillCollection(db, target.name, target.label);
    }
  },

  async down(_db: Db) {
    log.info(
      'Rollback is a no-op — cannot distinguish tenantIds backfilled by this migration from tenantIds written after the schema hardening shipped',
    );
  },

  async validate(db: Db) {
    const serviceNodesRemaining = await countRemainingEligibleRows(db, 'service_nodes');
    const agentLocksRemaining = await countRemainingEligibleRows(db, 'agent_locks');

    if (serviceNodesRemaining > 0 || agentLocksRemaining > 0) {
      return validationFailed(
        'Some service nodes or agent locks are still missing tenantId despite their parent project having one',
        {
          serviceNodesRemaining,
          agentLocksRemaining,
        },
      );
    }

    return validationPassed(
      'All eligible service nodes and agent locks have tenantId backfilled from their parent project',
      {
        serviceNodesRemaining,
        agentLocksRemaining,
      },
    );
  },
};

export default migration;

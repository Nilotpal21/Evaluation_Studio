#!/usr/bin/env tsx
/**
 * Backfill tenantId on public_api_keys from the owning project.
 *
 * Parallel script to backfill-widget-config-tenant-id.ts — resolves each
 * PublicApiKey's projectId to its owning tenant and sets tenantId.
 *
 * Note: This is an admin migration tool that operates across all records.
 * User-scoped filtering (userId/createdBy) is not applicable here — this
 * backfills a system-level field on every public_api_keys document.
 *
 * Usage:
 *   pnpm tsx tools/backfill-public-api-key-tenant-id.ts
 *   pnpm tsx tools/backfill-public-api-key-tenant-id.ts --apply
 */

import mongoose from 'mongoose';

const DEFAULT_MONGO_URI = 'mongodb://localhost:27017/agent-platform';
const BATCH_SIZE = 200;
const args = process.argv.slice(2);
const apply = args.includes('--apply');

function getMongoUri(): string {
  return process.env.MONGODB_URI || process.env.DATABASE_URL || DEFAULT_MONGO_URI;
}

type PublicApiKeyRecord = {
  _id: string;
  projectId?: string;
  tenantId?: string | null;
  // userId/createdBy not applicable for admin backfill
};

type ProjectRecord = {
  _id: string;
  tenantId?: string | null;
};

async function main(): Promise<void> {
  const mongoUri = getMongoUri();
  await mongoose.connect(mongoUri);

  try {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('MongoDB connection is not ready');
    }

    const publicApiKeys = db.collection<PublicApiKeyRecord>('public_api_keys');
    const projects = db.collection<ProjectRecord>('projects');

    let scanned = 0;
    let updated = 0;
    let skippedMissingProjectId = 0;
    let skippedProjectNotFound = 0;
    let lastId: string | undefined;

    console.log(
      `[public-api-key-tenant-backfill] Starting in ${apply ? 'apply' : 'dry-run'} mode against ${mongoUri}`,
    );

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const filter: Record<string, unknown> = {
        $or: [{ tenantId: { $exists: false } }, { tenantId: null }, { tenantId: '' }],
      };
      if (lastId) {
        filter._id = { $gt: lastId };
      }

      const batch = await publicApiKeys
        .find(filter, {
          projection: { _id: 1, projectId: 1, tenantId: 1 },
          sort: { _id: 1 },
          limit: BATCH_SIZE,
        })
        .toArray();

      if (batch.length === 0) {
        break;
      }

      scanned += batch.length;
      lastId = String(batch[batch.length - 1]._id);

      const validProjectIds = batch
        .map((record) => record.projectId)
        .filter(
          (projectId): projectId is string => typeof projectId === 'string' && projectId.length > 0,
        );
      const uniqueProjectIds = [...new Set(validProjectIds)];

      const projectDocs =
        uniqueProjectIds.length > 0
          ? await projects
              .find({ _id: { $in: uniqueProjectIds } }, { projection: { _id: 1, tenantId: 1 } })
              .toArray()
          : [];
      const projectTenantMap = new Map(
        projectDocs
          .filter(
            (project): project is ProjectRecord & { tenantId: string } =>
              typeof project.tenantId === 'string' && project.tenantId.length > 0,
          )
          .map((project) => [String(project._id), project.tenantId]),
      );

      const operations = [];

      for (const record of batch) {
        if (typeof record.projectId !== 'string' || record.projectId.length === 0) {
          skippedMissingProjectId += 1;
          continue;
        }

        const tenantId = projectTenantMap.get(record.projectId);
        if (!tenantId) {
          skippedProjectNotFound += 1;
          console.warn(
            `[public-api-key-tenant-backfill] Skipping key ${record._id}: project ${record.projectId} has no tenant`,
          );
          continue;
        }

        operations.push({
          updateOne: {
            filter: { _id: record._id },
            update: { $set: { tenantId } },
          },
        });
      }

      if (apply && operations.length > 0) {
        const result = await publicApiKeys.bulkWrite(operations);
        updated += result.modifiedCount;
      } else {
        updated += operations.length;
      }

      console.log(
        `[public-api-key-tenant-backfill] Processed ${scanned} records so far; ${updated} ${apply ? 'updated' : 'would update'}`,
      );
    }

    console.log(
      `[public-api-key-tenant-backfill] Complete: scanned=${scanned} ${apply ? 'updated' : 'wouldUpdate'}=${updated} skippedMissingProjectId=${skippedMissingProjectId} skippedProjectNotFound=${skippedProjectNotFound}`,
    );
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[public-api-key-tenant-backfill] Failed: ${message}`);
  process.exit(1);
});

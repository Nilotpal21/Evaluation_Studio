#!/usr/bin/env tsx
/**
 * Normalize legacy DEK status values in dek_registry.
 *
 * Converts:
 *   decrypt-only -> decrypt_only
 *
 * Usage:
 *   pnpm tsx tools/normalize-kms-dek-status.ts
 *   pnpm tsx tools/normalize-kms-dek-status.ts --apply
 *   pnpm tsx tools/normalize-kms-dek-status.ts --apply --tenant tenant-dev-001
 *   MONGODB_URI='mongodb://...' pnpm tsx tools/normalize-kms-dek-status.ts --apply
 */

import mongoose from 'mongoose';

const DEFAULT_MONGO_URI =
  'mongodb://abl_admin:abl_dev_password@localhost:27018/abl_platform?authSource=admin&directConnection=true';
const BATCH_SIZE = 500;
const LEGACY_STATUS = 'decrypt-only';
const CANONICAL_STATUS = 'decrypt_only';

const args = process.argv.slice(2);
const apply = args.includes('--apply');

function readArg(flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function getMongoUri(): string {
  return process.env.MONGODB_URI || process.env.DATABASE_URL || DEFAULT_MONGO_URI;
}

function maskMongoUri(uri: string): string {
  return uri.replace(/\/\/([^@]+)@/, '//<credentials>@');
}

type DekRecord = {
  _id: string;
  tenantId?: string;
  status?: string;
};

async function main(): Promise<void> {
  const mongoUri = getMongoUri();
  const tenantId = readArg('--tenant');

  await mongoose.connect(mongoUri);

  try {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('MongoDB connection is not ready');
    }

    const dekRegistry = db.collection<DekRecord>('dek_registry');
    const baseFilter: Record<string, unknown> = { status: LEGACY_STATUS };
    if (tenantId) {
      baseFilter.tenantId = tenantId;
    }

    const totalLegacy = await dekRegistry.countDocuments(baseFilter);
    console.log(
      `[normalize-kms-dek-status] Starting in ${apply ? 'apply' : 'dry-run'} mode against ${maskMongoUri(mongoUri)}`,
    );
    if (tenantId) {
      console.log(`[normalize-kms-dek-status] Tenant filter: ${tenantId}`);
    }
    console.log(
      `[normalize-kms-dek-status] Found ${totalLegacy} legacy '${LEGACY_STATUS}' DEK records`,
    );

    if (totalLegacy === 0) {
      console.log('[normalize-kms-dek-status] Nothing to do');
      return;
    }

    let scanned = 0;
    let updated = 0;
    let lastId: string | undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const batchFilter: Record<string, unknown> = { ...baseFilter };
      if (lastId) {
        batchFilter._id = { $gt: lastId };
      }

      const batch = await dekRegistry
        .find(batchFilter, {
          projection: { _id: 1, tenantId: 1, status: 1 },
          sort: { _id: 1 },
          limit: BATCH_SIZE,
        })
        .toArray();

      if (batch.length === 0) {
        break;
      }

      scanned += batch.length;
      lastId = String(batch[batch.length - 1]?._id);

      if (apply) {
        const ids = batch.map((record) => record._id);
        const result = await dekRegistry.updateMany(
          { _id: { $in: ids }, status: LEGACY_STATUS },
          { $set: { status: CANONICAL_STATUS } },
        );
        updated += result.modifiedCount;
      } else {
        updated += batch.length;
      }

      console.log(
        `[normalize-kms-dek-status] Processed ${scanned}/${totalLegacy}; ${updated} ${apply ? 'updated' : 'would update'}`,
      );
    }

    const remainingLegacy = await dekRegistry.countDocuments(baseFilter);
    const canonicalFilter: Record<string, unknown> = { status: CANONICAL_STATUS };
    if (tenantId) {
      canonicalFilter.tenantId = tenantId;
    }
    const canonicalCount = await dekRegistry.countDocuments(canonicalFilter);

    console.log(
      `[normalize-kms-dek-status] Complete: ${apply ? 'updated' : 'wouldUpdate'}=${updated} remainingLegacy=${remainingLegacy} canonicalCount=${canonicalCount}`,
    );
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[normalize-kms-dek-status] Failed: ${message}`);
  process.exit(1);
});

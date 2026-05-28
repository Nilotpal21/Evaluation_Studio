#!/usr/bin/env tsx
/**
 * Repair corrupted public_api_keys.allowedOrigins and permissions fields.
 *
 * Fixes records created when Studio double-serialized allowedOrigins or
 * permissions before writing them to MongoDB.
 *
 * Usage:
 *   pnpm tsx tools/repair-allowed-origins.ts
 *   pnpm tsx tools/repair-allowed-origins.ts --apply
 */

import mongoose from 'mongoose';
import {
  type PublicApiKeyPermissions,
  normalizePublicApiKeyAllowedOrigins,
  normalizePublicApiKeyPermissions,
} from '../packages/database/src/models/public-api-key.model.js';

const DEFAULT_MONGO_URI = 'mongodb://localhost:27017/agent-platform';
const BATCH_SIZE = 200;
const args = process.argv.slice(2);
const apply = args.includes('--apply');

type PublicApiKeyRepairRecord = {
  _id: string;
  allowedOrigins?: unknown;
  permissions?: unknown;
};

function getMongoUri(): string {
  return (
    process.env.MONGODB_URL ||
    process.env.MONGODB_URI ||
    process.env.DATABASE_URL ||
    DEFAULT_MONGO_URI
  );
}

function shouldRepairAllowedOrigins(
  rawValue: unknown,
  normalizedValue: string[] | null,
): normalizedValue is string[] | null {
  if (normalizedValue === null) {
    return false;
  }

  if (typeof rawValue === 'string') {
    return true;
  }

  return (
    Array.isArray(rawValue) &&
    rawValue.length === 1 &&
    typeof rawValue[0] === 'string' &&
    rawValue[0].trim().startsWith('[')
  );
}

function shouldRepairPermissions(
  rawValue: unknown,
  normalizedValue: PublicApiKeyPermissions | null,
): normalizedValue is PublicApiKeyPermissions {
  if (normalizedValue === null) {
    return false;
  }

  if (typeof rawValue === 'string') {
    return true;
  }

  return (
    Array.isArray(rawValue) &&
    rawValue.length === 1 &&
    typeof rawValue[0] === 'string' &&
    rawValue[0].trim().startsWith('{')
  );
}

async function main(): Promise<void> {
  const mongoUri = getMongoUri();
  await mongoose.connect(mongoUri);

  try {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('MongoDB connection is not ready');
    }

    const publicApiKeys = db.collection<PublicApiKeyRepairRecord>('public_api_keys');

    let scanned = 0;
    let repaired = 0;
    let allowedOriginsFixed = 0;
    let permissionsFixed = 0;
    let lastId: string | undefined;

    console.log(
      `[repair-allowed-origins] Starting in ${apply ? 'apply' : 'dry-run'} mode against ${mongoUri}`,
    );

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const filter: Record<string, unknown> = {};
      if (lastId) {
        filter._id = { $gt: lastId };
      }

      const batch = await publicApiKeys
        .find(filter, {
          projection: { _id: 1, allowedOrigins: 1, permissions: 1 },
          sort: { _id: 1 },
          limit: BATCH_SIZE,
        })
        .toArray();

      if (batch.length === 0) {
        break;
      }

      scanned += batch.length;
      lastId = String(batch[batch.length - 1]?._id);

      const operations = [];

      for (const record of batch) {
        const normalizedAllowedOrigins = normalizePublicApiKeyAllowedOrigins(record.allowedOrigins);
        const normalizedPermissions = normalizePublicApiKeyPermissions(record.permissions);
        const updateSet: Record<string, unknown> = {};

        if (shouldRepairAllowedOrigins(record.allowedOrigins, normalizedAllowedOrigins)) {
          updateSet.allowedOrigins = normalizedAllowedOrigins;
          allowedOriginsFixed += 1;
        }

        if (shouldRepairPermissions(record.permissions, normalizedPermissions)) {
          updateSet.permissions = normalizedPermissions;
          permissionsFixed += 1;
        }

        if (Object.keys(updateSet).length > 0) {
          operations.push({
            updateOne: {
              filter: { _id: record._id },
              update: { $set: updateSet },
            },
          });
        }
      }

      if (apply && operations.length > 0) {
        const result = await publicApiKeys.bulkWrite(operations);
        repaired += result.modifiedCount;
      } else {
        repaired += operations.length;
      }

      console.log(
        `[repair-allowed-origins] Processed ${scanned} records so far; ${repaired} ${apply ? 'repaired' : 'would repair'}`,
      );
    }

    console.log(
      `[repair-allowed-origins] Complete: scanned=${scanned} ${apply ? 'repaired' : 'wouldRepair'}=${repaired} allowedOriginsFixed=${allowedOriginsFixed} permissionsFixed=${permissionsFixed}`,
    );
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[repair-allowed-origins] Failed: ${message}`);
  process.exit(1);
});

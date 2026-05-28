/**
 * Migration: repair duplicate refresh-token generations and enforce uniqueness
 *
 * Refresh-token lineage depends on generation numbers being unique within a
 * family. Repair any duplicate family/generation collisions by renumbering
 * later siblings, then create a partial unique index that only applies to
 * rows with populated lineage metadata.
 *
 * Date: 2026-04-23
 */

import mongoose from 'mongoose';
import type { Migration } from '../types.js';
import { hasIndex, validationFailed, validationPassed } from '../validation.js';

type Db = mongoose.mongo.Db;

const COLLECTION = 'refresh_tokens';
const INDEX_NAME = 'familyId_1_generation_1_unique';
const INDEX_KEY = { familyId: 1, generation: 1 } as const;
const INDEX_PARTIAL_FILTER = {
  familyId: { $type: 'string' },
  generation: { $exists: true },
} as const;

type RefreshTokenRow = {
  _id: string;
  familyId: string | null;
  generation?: number | null;
  createdAt?: Date | null;
};

type RefreshTokenBulkOperation = Parameters<
  mongoose.mongo.Collection<RefreshTokenRow>['bulkWrite']
>[0][number];

async function findFamiliesWithDuplicateGenerations(
  collection: mongoose.mongo.Collection<RefreshTokenRow>,
): Promise<string[]> {
  const duplicates = await collection
    .aggregate<{ _id: string }>([
      {
        $match: INDEX_PARTIAL_FILTER,
      },
      {
        $group: {
          _id: {
            familyId: '$familyId',
            generation: '$generation',
          },
          count: { $sum: 1 },
        },
      },
      {
        $match: {
          count: { $gt: 1 },
        },
      },
      {
        $group: {
          _id: '$_id.familyId',
        },
      },
    ])
    .toArray();

  return duplicates
    .map((row) => row._id)
    .filter((familyId): familyId is string => typeof familyId === 'string' && familyId.length > 0);
}

async function repairDuplicateGenerationsForFamily(
  collection: mongoose.mongo.Collection<RefreshTokenRow>,
  familyId: string,
): Promise<number> {
  const rows = await collection
    .find<RefreshTokenRow>(
      {
        familyId,
        generation: { $exists: true },
      },
      {
        projection: {
          _id: 1,
          familyId: 1,
          generation: 1,
          createdAt: 1,
        },
      },
    )
    .sort({ generation: 1, createdAt: 1, _id: 1 })
    .toArray();

  const usedGenerations = new Set<number>();
  let nextGeneration = rows.reduce((max, row) => Math.max(max, row.generation ?? 1), 1) + 1;
  const operations: RefreshTokenBulkOperation[] = [];

  for (const row of rows) {
    const generation = row.generation ?? 1;
    if (!usedGenerations.has(generation)) {
      usedGenerations.add(generation);
      continue;
    }

    operations.push({
      updateOne: {
        filter: { _id: row._id },
        update: {
          $set: {
            generation: nextGeneration,
          },
        },
      },
    });
    usedGenerations.add(nextGeneration);
    nextGeneration += 1;
  }

  if (operations.length === 0) {
    return 0;
  }

  const result = await collection.bulkWrite(operations, { ordered: true });
  return result.modifiedCount;
}

export const migration: Migration = {
  version: '20260423_021',
  description: 'Repair duplicate refresh-token generations and enforce unique family generations',

  async up(db: Db) {
    const collection = db.collection<RefreshTokenRow>(COLLECTION);
    const familiesWithDuplicates = await findFamiliesWithDuplicateGenerations(collection);

    let repairedRows = 0;
    for (const familyId of familiesWithDuplicates) {
      repairedRows += await repairDuplicateGenerationsForFamily(collection, familyId);
    }

    if (familiesWithDuplicates.length > 0) {
      process.stdout.write(
        `[migration] Repaired ${repairedRows} refresh token generation collisions across ${familiesWithDuplicates.length} families\n`,
      );
    }

    await collection.createIndex(INDEX_KEY, {
      name: INDEX_NAME,
      unique: true,
      partialFilterExpression: INDEX_PARTIAL_FILTER,
      background: true,
    });

    process.stdout.write(`[migration] Ensured unique refresh token lineage index: ${INDEX_NAME}\n`);
  },

  async down(db: Db) {
    const collection = db.collection<RefreshTokenRow>(COLLECTION);
    try {
      await collection.dropIndex(INDEX_NAME);
      process.stdout.write(`[migration] Dropped refresh token lineage index: ${INDEX_NAME}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`[migration] Index ${INDEX_NAME} not found (${message}), continuing\n`);
    }
  },

  async validate(db: Db) {
    const indexPresent = await hasIndex(db, COLLECTION, INDEX_KEY, {
      unique: true,
      name: INDEX_NAME,
      partialFilterExpression: INDEX_PARTIAL_FILTER,
    });
    const familiesWithDuplicates = await findFamiliesWithDuplicateGenerations(
      db.collection<RefreshTokenRow>(COLLECTION),
    );

    if (!indexPresent || familiesWithDuplicates.length > 0) {
      return validationFailed('refresh token lineage uniqueness is not fully enforced', {
        indexPresent,
        duplicateFamilies: familiesWithDuplicates,
      });
    }

    return validationPassed('refresh token lineage uniqueness is enforced', {
      indexPresent,
      auditedDuplicateFamilyCount: familiesWithDuplicates.length,
    });
  },
};

export default migration;

/**
 * Index Reconciliation Script
 *
 * Compares declared indexes (from Mongoose schemas) with existing indexes
 * in the database. Creates missing indexes and warns about orphaned ones.
 *
 * Run: pnpm db:ensure-indexes
 *
 * Production safety:
 * - Uses `background: true` for zero-downtime index builds
 * - Does NOT auto-drop orphaned indexes (manual decision)
 * - Idempotent — safe to run multiple times
 */

import mongoose from 'mongoose';

interface IndexDiff {
  collection: string;
  created: string[];
  orphaned: string[];
  existing: number;
  declared: number;
}

/**
 * Ensure all indexes declared on registered Mongoose models exist in the database.
 *
 * @returns Summary of index reconciliation per collection
 */
export async function ensureIndexes(): Promise<IndexDiff[]> {
  const results: IndexDiff[] = [];

  const models = mongoose.modelNames();

  for (const modelName of models) {
    const model = mongoose.model(modelName);
    const collection = model.collection;
    const collectionName = collection.collectionName;

    const diff: IndexDiff = {
      collection: collectionName,
      created: [],
      orphaned: [],
      existing: 0,
      declared: 0,
    };

    try {
      // Get existing indexes from database
      const existingIndexes = await collection.indexes();
      diff.existing = existingIndexes.length;

      // Get declared indexes from schema
      const schemaIndexes = model.schema.indexes();
      diff.declared = schemaIndexes.length;

      // Build a set of existing index key signatures
      const existingKeys = new Set(
        existingIndexes.map((idx) => indexKeySignature(idx.key as Record<string, unknown>)),
      );

      // Create missing indexes
      for (const [keys, options] of schemaIndexes) {
        const sig = indexKeySignature(keys as Record<string, unknown>);
        if (!existingKeys.has(sig)) {
          try {
            await collection.createIndex(
              keys as any,
              {
                background: true,
                ...options,
              } as any,
            );
            diff.created.push(sig);
            console.log(`  [+] ${collectionName}: created index ${sig}`);
          } catch (error: any) {
            // Index exists with different options — warn but continue
            if (error.code === 85 || error.code === 86) {
              console.warn(`  [!] ${collectionName}: index conflict for ${sig} — ${error.message}`);
            } else {
              throw error;
            }
          }
        }
      }

      // Detect orphaned indexes (exist in DB but not in schema)
      const declaredKeys = new Set(
        schemaIndexes.map(([keys]) => indexKeySignature(keys as Record<string, unknown>)),
      );

      for (const idx of existingIndexes) {
        const sig = indexKeySignature(idx.key);
        // Skip the default _id index
        if (sig === '_id_1') continue;

        if (!declaredKeys.has(sig)) {
          diff.orphaned.push(idx.name ?? sig);
          console.warn(
            `  [?] ${collectionName}: orphaned index "${idx.name}" (${sig}) — consider manual removal`,
          );
        }
      }
    } catch (error: any) {
      console.error(`  [x] ${collectionName}: error reconciling indexes — ${error.message}`);
    }

    results.push(diff);
  }

  return results;
}

/**
 * Print a summary of the index reconciliation.
 */
export function printIndexSummary(results: IndexDiff[]): void {
  let totalCreated = 0;
  let totalOrphaned = 0;
  let totalExisting = 0;

  for (const r of results) {
    totalCreated += r.created.length;
    totalOrphaned += r.orphaned.length;
    totalExisting += r.existing;
  }

  console.log('\n─── Index Reconciliation Summary ───');
  console.log(`  Collections scanned: ${results.length}`);
  console.log(`  Existing indexes:    ${totalExisting}`);
  console.log(`  Indexes created:     ${totalCreated}`);
  console.log(`  Orphaned indexes:    ${totalOrphaned}`);

  if (totalOrphaned > 0) {
    console.log('\n  ⚠ Orphaned indexes found. Review and drop manually if no longer needed.');
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Generate a stable string signature for an index key specification.
 * e.g., { tenantId: 1, status: -1 } → "tenantId_1_status_-1"
 */
function indexKeySignature(key: Record<string, unknown>): string {
  return Object.entries(key)
    .map(([field, dir]) => `${field}_${dir}`)
    .join('_');
}

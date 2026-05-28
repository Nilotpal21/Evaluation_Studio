/**
 * Migration: Rename chunkStrategy to tokenChunkStrategy
 *
 * Date: 2026-02-24
 * Issue: ABLP-2 (Feature branch merge)
 *
 * Purpose:
 * - Rename SearchIndex.chunkStrategy → SearchIndex.tokenChunkStrategy
 * - Clarifies that this field is specifically for token-based chunking
 * - Page-based chunking (Docling) is the new default when field is null
 *
 * Context:
 * - Develop branch: All indices have chunkStrategy (required, default: fixed)
 * - Feature branch: Field renamed to tokenChunkStrategy (optional, default: null)
 * - This migration bridges the gap for indices created in develop
 *
 * Safety:
 * - Idempotent: Safe to run multiple times
 * - Non-destructive: Only renames the field, preserves all values
 * - Dry-run mode: Test without making changes
 */

import mongoose from 'mongoose';

// =============================================================================
// TYPES
// =============================================================================

interface MigrationStats {
  totalIndices: number;
  needsMigration: number;
  alreadyMigrated: number;
  migrated: number;
  errors: number;
}

interface MigrationOptions {
  dryRun?: boolean;
  batchSize?: number;
  verbose?: boolean;
}

// =============================================================================
// MIGRATION LOGIC
// =============================================================================

export async function migrateChunkStrategyToTokenChunkStrategy(
  options: MigrationOptions = {},
): Promise<MigrationStats> {
  const { dryRun = false, batchSize = 100, verbose = false } = options;

  const stats: MigrationStats = {
    totalIndices: 0,
    needsMigration: 0,
    alreadyMigrated: 0,
    migrated: 0,
    errors: 0,
  };

  console.log('========================================');
  console.log('Migration: chunkStrategy → tokenChunkStrategy');
  console.log('========================================');
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE (will modify data)'}`);
  console.log(`Batch size: ${batchSize}`);
  console.log('');

  try {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('Database connection not established. Call connectDB() first.');
    }

    const collection = db.collection('search_indexes');

    // Step 1: Count total indices
    stats.totalIndices = await collection.countDocuments();
    console.log(`✓ Found ${stats.totalIndices} total indices`);

    // Step 2: Find indices that need migration (have chunkStrategy but not tokenChunkStrategy)
    const needsMigration = await collection
      .find({
        chunkStrategy: { $exists: true },
        tokenChunkStrategy: { $exists: false },
      })
      .toArray();

    stats.needsMigration = needsMigration.length;
    console.log(`✓ Found ${stats.needsMigration} indices needing migration`);

    // Step 3: Find indices already migrated (have tokenChunkStrategy)
    stats.alreadyMigrated = await collection.countDocuments({
      tokenChunkStrategy: { $exists: true },
    });
    console.log(`✓ Found ${stats.alreadyMigrated} indices already migrated`);
    console.log('');

    if (stats.needsMigration === 0) {
      console.log('✅ No migration needed. All indices already use tokenChunkStrategy.');
      return stats;
    }

    // Step 4: Migrate in batches
    console.log(`Starting migration of ${stats.needsMigration} indices...`);
    console.log('');

    for (let i = 0; i < needsMigration.length; i += batchSize) {
      const batch = needsMigration.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(needsMigration.length / batchSize);

      console.log(`Processing batch ${batchNum}/${totalBatches} (${batch.length} indices)...`);

      for (const doc of batch) {
        try {
          if (verbose) {
            console.log(`  - Migrating index: ${doc._id} (${doc.name || 'unnamed'})`);
            console.log(`    Old: chunkStrategy = ${JSON.stringify(doc.chunkStrategy)}`);
          }

          if (!dryRun) {
            // Perform the field rename
            await collection.updateOne(
              { _id: doc._id },
              {
                $rename: { chunkStrategy: 'tokenChunkStrategy' },
              },
            );
          }

          stats.migrated++;

          if (verbose) {
            console.log(`    New: tokenChunkStrategy = ${JSON.stringify(doc.chunkStrategy)}`);
            console.log(`    ✓ Migrated`);
          }
        } catch (error) {
          stats.errors++;
          console.error(`    ✗ Error migrating index ${doc._id}:`, error);
        }
      }

      console.log(`  ✓ Batch ${batchNum}/${totalBatches} complete`);
      console.log('');
    }

    // Step 5: Verify migration
    if (!dryRun) {
      const remaining = await collection.countDocuments({
        chunkStrategy: { $exists: true },
        tokenChunkStrategy: { $exists: false },
      });

      if (remaining > 0) {
        console.warn(`⚠️  Warning: ${remaining} indices still have chunkStrategy`);
      } else {
        console.log('✅ Verification passed: All indices migrated successfully');
      }
    }

    // Step 6: Summary
    console.log('');
    console.log('========================================');
    console.log('Migration Summary');
    console.log('========================================');
    console.log(`Total indices:        ${stats.totalIndices}`);
    console.log(`Needed migration:     ${stats.needsMigration}`);
    console.log(`Already migrated:     ${stats.alreadyMigrated}`);
    console.log(`Migrated this run:    ${stats.migrated}`);
    console.log(`Errors:               ${stats.errors}`);
    console.log('');

    if (dryRun) {
      console.log('✓ DRY RUN COMPLETE - No changes made');
      console.log('  Run without --dry-run flag to apply changes');
    } else {
      console.log('✅ MIGRATION COMPLETE');
    }

    return stats;
  } catch (error) {
    console.error('');
    console.error('❌ Migration failed:', error);
    throw error;
  }
}

// =============================================================================
// CLI RUNNER
// =============================================================================

/**
 * Run migration from command line
 *
 * Usage (from repository root):
 *
 *   # Dry run (no changes) - RECOMMENDED FIRST
 *   npx tsx scripts/migrate-chunkStrategy-to-tokenChunkStrategy.ts --dry-run
 *
 *   # Live run (applies changes)
 *   npx tsx scripts/migrate-chunkStrategy-to-tokenChunkStrategy.ts
 *
 *   # Verbose mode (shows each index being migrated)
 *   npx tsx scripts/migrate-chunkStrategy-to-tokenChunkStrategy.ts --verbose
 *
 *   # Dry run + verbose
 *   npx tsx scripts/migrate-chunkStrategy-to-tokenChunkStrategy.ts --dry-run --verbose
 */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verbose = args.includes('--verbose');

  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/agent-platform';
    console.log(`Connecting to MongoDB: ${mongoUri.replace(/:[^:@]+@/, ':****@')}`);
    await mongoose.connect(mongoUri);
    console.log('✓ Connected to MongoDB');
    console.log('');

    // Run migration
    await migrateChunkStrategyToTokenChunkStrategy({ dryRun, verbose });

    // Disconnect
    await mongoose.disconnect();
    console.log('');
    console.log('✓ Disconnected from MongoDB');

    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

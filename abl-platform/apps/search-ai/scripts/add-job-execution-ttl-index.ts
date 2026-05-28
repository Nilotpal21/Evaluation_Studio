/**
 * Migration: Add TTL Index to job_executions Collection
 *
 * Purpose: Implements 90-day automatic retention policy to prevent unbounded storage growth
 *
 * Background:
 * - Without TTL: 730GB/year growth (unbounded)
 * - With 90-day TTL: ~180GB cap (75%+ savings)
 *
 * Execution:
 * - Zero downtime (background: true index creation)
 * - TTL deletion starts within 60 seconds after index creation
 * - Monitor first 24 hours to verify deletion behavior
 *
 * Reference: docs/searchai/pipelines/design/backend/02-JOB-TRACKING-RETENTION.md
 */

import mongoose from 'mongoose';
import { JobExecution } from '@agent-platform/database';
import { createLogger } from '@agent-platform/compiler/platform';

const logger = createLogger('migration:job-execution-ttl');

interface MigrationResult {
  success: boolean;
  skipped?: boolean;
  documentsToDelete?: number;
  retentionDays?: number;
  cutoffDate?: string;
}

export async function addJobExecutionTTLIndex(): Promise<MigrationResult> {
  logger.info('Starting migration: Add TTL index to job_executions');

  try {
    // Step 1: Check if TTL index already exists
    const indexes = await JobExecution.collection.indexes();
    const hasTTLIndex = indexes.some(
      (index) => index.name === 'ttl_createdAt_90days' || index.expireAfterSeconds !== undefined,
    );

    if (hasTTLIndex) {
      logger.info('TTL index already exists, skipping migration');
      return { success: true, skipped: true };
    }

    // Step 2: Create TTL index
    logger.info('Creating TTL index: ttl_createdAt_90days (90 days retention)');

    await JobExecution.collection.createIndex(
      { createdAt: 1 },
      {
        expireAfterSeconds: 7776000, // 90 days (90 * 24 * 3600)
        name: 'ttl_createdAt_90days',
        background: true, // Non-blocking index creation
      },
    );

    logger.info('TTL index created successfully');

    // Step 3: Verify index
    const updatedIndexes = await JobExecution.collection.indexes();
    const ttlIndex = updatedIndexes.find((index) => index.name === 'ttl_createdAt_90days');

    if (!ttlIndex) {
      throw new Error('TTL index creation verification failed');
    }

    logger.info('TTL index verified', {
      indexName: ttlIndex.name,
      expireAfterSeconds: ttlIndex.expireAfterSeconds,
      key: ttlIndex.key,
    });

    // Step 4: Estimate documents to be deleted
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 90);

    const countToDelete = await JobExecution.countDocuments({
      createdAt: { $lt: cutoffDate },
    });

    logger.info('Migration complete', {
      documentsToDelete: countToDelete,
      retentionDays: 90,
      cutoffDate: cutoffDate.toISOString(),
      estimatedDeletionStart: 'Within 60 seconds (MongoDB TTL background thread)',
    });

    return {
      success: true,
      documentsToDelete: countToDelete,
      retentionDays: 90,
      cutoffDate: cutoffDate.toISOString(),
    };
  } catch (error) {
    logger.error('Migration failed', { error });
    throw error;
  }
}

// CLI execution
async function main() {
  const mongoUrl =
    process.env.MONGODB_URI || process.env.MONGODB_URL || 'mongodb://localhost:27018/abl_platform';

  logger.info('Connecting to MongoDB', {
    mongoUrl: mongoUrl.replace(/\/\/.*@/, '//<credentials>@'),
  });

  try {
    await mongoose.connect(mongoUrl);
    logger.info('Connected to MongoDB');

    const result = await addJobExecutionTTLIndex();

    if (result.skipped) {
      console.log('\n✅ Migration skipped: TTL index already exists\n');
    } else {
      console.log('\n✅ Migration completed successfully!\n');
      console.log('Results:');
      console.log(`  - Documents to be deleted: ${result.documentsToDelete}`);
      console.log(`  - Retention period: ${result.retentionDays} days`);
      console.log(`  - Cutoff date: ${result.cutoffDate}`);
      console.log('\nNote: TTL deletion will start within 60 seconds.');
      console.log('Monitor CloudWatch metrics: SearchAI/JobTracking\n');
    }

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

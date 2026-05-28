#!/usr/bin/env node
/**
 * Migration Script: Fix Source Document Counts
 *
 * Problem: Existing documents have sourceId set, but source.documentCount was never incremented.
 * Solution: Count all documents per source and update source.documentCount field.
 *
 * Usage:
 *   node apps/search-ai/src/scripts/migrate-source-document-counts.ts
 */

import { MongoClient } from 'mongodb';

const MONGODB_URL =
  'mongodb://abl_admin:abl_dev_password@localhost:27018/abl_platform?authSource=admin';

async function migrateSourceDocumentCounts() {
  console.log('[migrate-source-counts] Starting source document count migration...');
  console.log('[migrate-source-counts] Connecting to MongoDB...');

  const client = new MongoClient(MONGODB_URL);

  try {
    await client.connect();
    console.log('[migrate-source-counts] Connected to MongoDB');

    const db = client.db('abl_platform');
    const searchDocuments = db.collection('search_documents');
    const searchSources = db.collection('search_sources');

    // Aggregate documents by sourceId to get counts
    const documentCounts = await searchDocuments
      .aggregate([
        {
          $match: {
            sourceId: { $exists: true, $ne: null },
          },
        },
        {
          $group: {
            _id: {
              sourceId: '$sourceId',
              tenantId: '$tenantId',
            },
            count: { $sum: 1 },
          },
        },
      ])
      .toArray();

    console.log(`[migrate-source-counts] Found ${documentCounts.length} sources with documents`);

    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    // Update each source's documentCount
    for (const item of documentCounts) {
      const { sourceId, tenantId } = item._id;
      const count = item.count;

      try {
        // Get current source to compare
        const source = await searchSources.findOne({
          _id: sourceId,
          tenantId,
        });

        if (!source) {
          console.log(`[migrate-source-counts] WARN: Source not found - ${sourceId}`);
          skippedCount++;
          continue;
        }

        const currentCount = source.documentCount || 0;

        if (currentCount === count) {
          console.log(
            `[migrate-source-counts] Source already has correct count: ${source.name} (${count})`,
          );
          skippedCount++;
          continue;
        }

        // Update the count
        await searchSources.updateOne(
          { _id: sourceId, tenantId },
          { $set: { documentCount: count } },
        );

        console.log(
          `[migrate-source-counts] Updated source: ${source.name} (${currentCount} → ${count})`,
        );
        updatedCount++;
      } catch (err) {
        console.error(`[migrate-source-counts] ERROR: Failed to update source ${sourceId}:`, err);
        errorCount++;
      }
    }

    console.log('[migrate-source-counts] Migration completed!');
    console.log(`[migrate-source-counts] Total sources: ${documentCounts.length}`);
    console.log(`[migrate-source-counts] Updated: ${updatedCount}`);
    console.log(`[migrate-source-counts] Skipped: ${skippedCount}`);
    console.log(`[migrate-source-counts] Errors: ${errorCount}`);

    await client.close();
    process.exit(0);
  } catch (error) {
    console.error('[migrate-source-counts] Migration failed:', error);
    await client.close();
    process.exit(1);
  }
}

// Run migration
migrateSourceDocumentCounts();

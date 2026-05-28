/**
 * One-time fix: Set hasStructuredData flag for indexes with table_metadata chunks
 *
 * Usage: pnpm exec tsx tools/fix-structured-flag.ts <indexId>
 */

import { getLazyModel } from '../apps/search-ai/src/db/index.js';
import type { ISearchIndex, ISearchChunk } from '@agent-platform/database/models';
import { initializeDualConnection } from '../apps/search-ai/src/db/index.js';

const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');
const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk');

async function run() {
  const indexId = process.argv[2];
  if (!indexId) {
    console.error('Usage: pnpm exec tsx tools/fix-structured-flag.ts <indexId>');
    process.exit(1);
  }

  try {
    // Initialize MongoDB connections
    await initializeDualConnection();

    console.log(`Checking index ${indexId}...`);

    // Find index (check all tenants since this is admin tool)
    const index = await SearchIndex.findOne({ _id: indexId }).lean();
    if (!index) {
      console.error(`Index ${indexId} not found`);
      process.exit(1);
    }

    console.log(`Found index: ${(index as any).name || indexId}`);
    console.log(`Tenant: ${(index as any).tenantId}`);
    console.log(`Current hasStructuredData: ${(index as any).hasStructuredData || false}`);

    // Check for table_metadata chunks
    const chunkCount = await SearchChunk.countDocuments({
      indexId,
      tenantId: (index as any).tenantId,
      chunkType: 'table_metadata',
    });

    console.log(`Found ${chunkCount} table_metadata chunks`);

    if (chunkCount === 0) {
      console.log('No table_metadata chunks found - flag should remain false');
      process.exit(0);
    }

    // Set the flag
    const result = await SearchIndex.updateOne(
      { _id: indexId, tenantId: (index as any).tenantId },
      { $set: { hasStructuredData: true } },
    );

    console.log(`\nUpdate result:`);
    console.log(`  Matched: ${result.matchedCount}`);
    console.log(`  Modified: ${result.modifiedCount}`);

    if (result.modifiedCount > 0) {
      console.log(`\n✓ SUCCESS: hasStructuredData flag set to true`);
    } else if (result.matchedCount > 0) {
      console.log(`\n✓ Flag already set (no change needed)`);
    }

    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

run();

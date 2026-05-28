/**
 * One-time fix: Set hasStructuredData flag for indexes with table_metadata chunks
 *
 * Usage: node tools/fix-structured-flag-simple.mjs <indexId>
 */

import { MongoClient } from 'mongodb';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from project root
dotenv.config({ path: join(__dirname, '..', '.env') });

const indexId = process.argv[2];
if (!indexId) {
  console.error('Usage: node tools/fix-structured-flag-simple.mjs <indexId>');
  process.exit(1);
}

// Use dev MongoDB URL from environment
const MONGODB_URI = process.env.SEARCH_AI_MONGODB_URI || process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('Error: MONGODB_URI not found in environment');
  process.exit(1);
}

console.log(`Connecting to MongoDB...`);
const client = new MongoClient(MONGODB_URI);

try {
  await client.connect();
  console.log(`Connected\n`);

  const platformDb = client.db('abl_platform');
  const contentDb = client.db('search_ai');

  const searchIndexes = platformDb.collection('searchindexes');
  const searchChunks = contentDb.collection('searchchunks');

  console.log(`Checking index ${indexId}...`);

  // Find index
  const index = await searchIndexes.findOne({ _id: indexId });
  if (!index) {
    console.error(`Index ${indexId} not found`);
    process.exit(1);
  }

  console.log(`Found index: ${index.name || indexId}`);
  console.log(`Tenant: ${index.tenantId}`);
  console.log(`Current hasStructuredData: ${index.hasStructuredData || false}\n`);

  // Check for table_metadata chunks
  const chunkCount = await searchChunks.countDocuments({
    indexId,
    tenantId: index.tenantId,
    chunkType: 'table_metadata',
  });

  console.log(`Found ${chunkCount} table_metadata chunks\n`);

  if (chunkCount === 0) {
    console.log('No table_metadata chunks found - flag should remain false');
    process.exit(0);
  }

  // Set the flag
  const result = await searchIndexes.updateOne(
    { _id: indexId, tenantId: index.tenantId },
    { $set: { hasStructuredData: true } }
  );

  console.log(`Update result:`);
  console.log(`  Matched: ${result.matchedCount}`);
  console.log(`  Modified: ${result.modifiedCount}\n`);

  if (result.modifiedCount > 0) {
    console.log(`✓ SUCCESS: hasStructuredData flag set to true`);
    console.log(`\nStructured data enrichment will now work for this index.`);
  } else if (result.matchedCount > 0) {
    console.log(`✓ Flag already set (no change needed)`);
  }

} finally {
  await client.close();
}

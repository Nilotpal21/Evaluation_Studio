/**
 * One-time fix: Set hasStructuredData flag
 * Usage: cd apps/search-ai && node scripts/fix-structured-flag.js <indexId>
 */

const { MongoClient } = require('mongodb');
require('dotenv').config({ path: '../../.env' });

const indexId = process.argv[2];
if (!indexId) {
  console.error('Usage: node scripts/fix-structured-flag.js <indexId>');
  process.exit(1);
}

const MONGODB_URI = process.env.SEARCH_AI_MONGODB_URI || process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('Error: MONGODB_URI not found in .env');
  process.exit(1);
}

async function run() {
  const client = new MongoClient(MONGODB_URI);

  try {
    console.log('Connecting to MongoDB...');
    await client.connect();
    console.log('Connected\n');

    const platformDb = client.db('abl_platform');
    const contentDb = client.db('search_ai');

    const searchIndexes = platformDb.collection('searchindexes');
    const searchChunks = contentDb.collection('searchchunks');

    console.log(`Checking index ${indexId}...`);

    const index = await searchIndexes.findOne({ _id: indexId });
    if (!index) {
      console.error(`Index ${indexId} not found`);
      process.exit(1);
    }

    console.log(`Found index: ${index.name || indexId}`);
    console.log(`Tenant: ${index.tenantId}`);
    console.log(`Current hasStructuredData: ${index.hasStructuredData || false}\n`);

    const chunkCount = await searchChunks.countDocuments({
      indexId,
      tenantId: index.tenantId,
      chunkType: 'table_metadata',
    });

    console.log(`Found ${chunkCount} table_metadata chunks\n`);

    if (chunkCount === 0) {
      console.log('No table_metadata chunks - flag should remain false');
      process.exit(0);
    }

    const result = await searchIndexes.updateOne(
      { _id: indexId, tenantId: index.tenantId },
      { $set: { hasStructuredData: true } }
    );

    console.log(`Update result:`);
    console.log(`  Matched: ${result.matchedCount}`);
    console.log(`  Modified: ${result.modifiedCount}\n`);

    if (result.modifiedCount > 0) {
      console.log(`✓ SUCCESS: hasStructuredData flag set to true`);
      console.log(`\nTry your search query again - structured data should appear now.`);
    } else if (result.matchedCount > 0) {
      console.log(`✓ Flag already set`);
    }
  } finally {
    await client.close();
  }
}

run().catch(console.error);

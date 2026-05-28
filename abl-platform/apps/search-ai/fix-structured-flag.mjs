import { MongoClient } from 'mongodb';

const uri = 'mongodb+srv://doadmin:bJ085C7S26a49Ytp@abl-platform-db-dev-74a7a81e.mongo.ondigitalocean.com/abl_platform?tls=true&authSource=admin&replicaSet=abl-platform-db-dev';
const client = new MongoClient(uri);

async function run() {
  try {
    await client.connect();
    const db = client.db('abl_platform');
    const collection = db.collection('searchindexes');

    const result = await collection.updateOne(
      { _id: '019d87d1-ea29-7453-abaa-4d2ef7c41229', tenantId: 'tenant-dev-001' },
      { $set: { hasStructuredData: true } }
    );

    console.log(JSON.stringify({
      matched: result.matchedCount,
      modified: result.modifiedCount,
      acknowledged: result.acknowledged
    }, null, 2));

    if (result.matchedCount === 0) {
      console.log('ERROR: Index not found');
      process.exit(1);
    }

    if (result.modifiedCount === 0) {
      console.log('Note: Field already set (no change needed)');
    } else {
      console.log('SUCCESS: hasStructuredData flag set');
    }

  } finally {
    await client.close();
  }
}

run().catch(console.error);

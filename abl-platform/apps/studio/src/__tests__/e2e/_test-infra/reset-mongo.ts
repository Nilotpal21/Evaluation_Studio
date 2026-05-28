/**
 * Test-fixture lifecycle helper for the shared-docker MongoDB target.
 *
 * E2E tests must NOT touch the database from inside the test bodies — see
 * CLAUDE.md "E2E Test Standards". This helper exists so the suite can clear
 * a previously-used shared docker mongo database between full runs without
 * pulling raw Mongoose calls into the .test.ts file.
 *
 * The local-mode path uses MongoMemoryServer per run and never calls this.
 */

import mongoose from 'mongoose';

export async function resetSharedMongoDatabase(
  mongoUri: string,
  mongoDatabase: string,
): Promise<void> {
  const connection = mongoose.createConnection(mongoUri, {
    dbName: mongoDatabase,
    authSource: process.env['MONGODB_AUTH_SOURCE'] || 'admin',
    serverSelectionTimeoutMS: 10_000,
    directConnection: mongoUri.includes('directConnection=true'),
    autoIndex: false,
  });
  try {
    await connection.asPromise();
    const db = connection.db;
    if (db) {
      await db.dropDatabase();
    }
  } finally {
    await connection.close();
  }
}

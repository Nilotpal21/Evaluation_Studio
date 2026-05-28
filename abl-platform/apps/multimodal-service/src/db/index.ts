/**
 * Multimodal Service Database Client
 *
 * MongoDB-only backend using Mongoose models via MongoConnectionManager.
 */

import { MongoConnectionManager } from '@agent-platform/database/mongo';
import type { MongoDBConfig } from '@agent-platform/database/mongo';

let _mongoReady = false;

/**
 * Initialize MongoDB connection. Call once at startup.
 */
export async function initMongoBackend(config: MongoDBConfig): Promise<void> {
  await MongoConnectionManager.initialize(config);
  _mongoReady = true;
}

/**
 * Check if the database is available.
 */
export function isDatabaseAvailable(): boolean {
  return _mongoReady;
}

/**
 * Disconnect the database.
 */
export async function disconnectDatabase(): Promise<void> {
  if (_mongoReady) {
    await MongoConnectionManager.getInstance().disconnect();
    _mongoReady = false;
  }
}

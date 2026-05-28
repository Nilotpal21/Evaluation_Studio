/**
 * Template Store Database Client
 *
 * MongoDB backend using Mongoose models via MongoConnectionManager.
 * Follows the same pattern as runtime/src/db/index.ts.
 */

import {
  MongoConnectionManager,
  registerTenantContextProvider,
} from '@agent-platform/database/mongo';
import type { MongoDBConfig } from '@agent-platform/database/mongo';
import { getTenantContextData } from '@agent-platform/shared-auth';

let _mongoReady = false;

/**
 * Initialize MongoDB connection. Call once at startup.
 */
export async function initMongoBackend(config: MongoDBConfig): Promise<void> {
  const manager = await MongoConnectionManager.initialize(config);

  // Bridge shared-auth ALS -> Mongoose tenant isolation plugin.
  registerTenantContextProvider(() => {
    const ctx = getTenantContextData();
    if (!ctx) return undefined;
    return { tenantId: ctx.tenantId, isSuperAdmin: ctx.isSuperAdmin };
  });

  // Suppress unused variable warning — manager is used for lifecycle only
  void manager;

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

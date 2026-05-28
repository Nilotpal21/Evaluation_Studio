/**
 * Academy Service Database Client
 *
 * MongoDB backend using Mongoose models via MongoConnectionManager.
 * After connection, creates Academy services (storage + content + progress + gamification).
 * Follows the same pattern as template-store/src/lib/db.ts.
 */

import mongoose from 'mongoose';
import {
  MongoConnectionManager,
  registerTenantContextProvider,
} from '@agent-platform/database/mongo';
import type { MongoDBConfig } from '@agent-platform/database/mongo';
import { getTenantContextData } from '@agent-platform/shared-auth';
import {
  createMongooseAcademyStorage,
  createAcademyServices,
  type AcademyServices,
} from '@agent-platform/academy';

let _mongoReady = false;
let _services: AcademyServices | null = null;

/**
 * Initialize MongoDB connection and wire up Academy services.
 * Call once at startup.
 */
export async function initMongoBackend(config: MongoDBConfig, contentRoot?: string): Promise<void> {
  const manager = await MongoConnectionManager.initialize(config);

  // Bridge shared-auth ALS -> Mongoose tenant isolation plugin.
  registerTenantContextProvider(() => {
    const ctx = getTenantContextData();
    if (!ctx) return undefined;
    return { tenantId: ctx.tenantId, isSuperAdmin: ctx.isSuperAdmin };
  });

  // Suppress unused variable warning — manager is used for lifecycle only
  void manager;

  // Create academy services using the active Mongoose connection
  const storage = createMongooseAcademyStorage(mongoose.connection);
  _services = createAcademyServices(storage, { contentRoot });

  _mongoReady = true;
}

/**
 * Get the initialized academy services.
 * Throws if called before initMongoBackend() completes.
 */
export function getAcademyServices(): AcademyServices {
  if (!_services) {
    throw new Error('Academy services not initialized — call initMongoBackend() first');
  }
  return _services;
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
    _services = null;
  }
}

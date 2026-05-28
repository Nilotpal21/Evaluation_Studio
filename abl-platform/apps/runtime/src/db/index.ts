/**
 * Runtime Database Client
 *
 * MongoDB-only backend using Mongoose models via MongoConnectionManager.
 */

import mongoose from 'mongoose';
import { ensureAuditLogTTLIndex } from '@agent-platform/database';
import {
  MongoConnectionManager,
  registerTenantContextProvider,
  repairLegacyConnectorConnectionIndexes,
} from '@agent-platform/database/mongo';
import type { MongoDBConfig } from '@agent-platform/database/mongo';
import { getTenantContextData } from '@agent-platform/shared-auth';
import {
  recordPoolCheckoutFailure,
  recordPoolCheckedOut,
  recordPoolCheckedIn,
  recordPoolConnectionCreated,
  recordPoolConnectionClosed,
} from '../observability/metrics.js';
import { createLogger } from '@abl/compiler/platform';
import { repairLegacyChannelConnectionIndexes } from './channel-connection-index-repair.js';

let _mongoReady = false;
const log = createLogger('runtime-db');
const repairedIndexTargets = new Set<string>();

function getRepairTargetKey(config: MongoDBConfig): string {
  return `${config.url}::${config.database}`;
}

/**
 * Initialize MongoDB connection. Call once at startup.
 */
export async function initMongoBackend(config: MongoDBConfig): Promise<void> {
  const manager = await MongoConnectionManager.initialize(config);
  await ensureAuditLogTTLIndex();

  // Wire pool CMAP monitoring → OTEL metrics
  manager.onPoolCheckoutFailed((event) => {
    recordPoolCheckoutFailure(event.reason);
  });
  manager.onPoolCheckedOut(recordPoolCheckedOut);
  manager.onPoolCheckedIn(recordPoolCheckedIn);
  manager.onPoolConnectionCreated(recordPoolConnectionCreated);
  manager.onPoolConnectionClosed(recordPoolConnectionClosed);

  // Bridge shared-auth ALS → Mongoose tenant isolation plugin.
  // This makes the Mongoose plugin auto-inject tenantId from the same context
  // set by unified auth middleware and WS handlers via runWithTenantContext().
  registerTenantContextProvider(() => {
    const ctx = getTenantContextData();
    if (!ctx) return undefined;
    return { tenantId: ctx.tenantId, isSuperAdmin: ctx.isSuperAdmin };
  });

  const repairTargetKey = getRepairTargetKey(config);
  if (!repairedIndexTargets.has(repairTargetKey)) {
    try {
      await repairLegacyChannelConnectionIndexes(log);
      await repairLegacyConnectorConnectionIndexes(log);
      repairedIndexTargets.add(repairTargetKey);
    } catch (err: unknown) {
      log.warn('Failed to reconcile legacy MongoDB indexes during startup', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  _mongoReady = true;
}

/**
 * Check if the database is available.
 * Checks both that init completed AND the live Mongoose connection is up.
 * mongoose.connection.readyState: 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
 */
export function isDatabaseAvailable(): boolean {
  return _mongoReady && mongoose.connection.readyState === 1;
}

/**
 * Check whether MongoDB is both configured and currently connected.
 * @deprecated Use isDatabaseAvailable() — both now check live connection state.
 */
export function isDatabaseReady(): boolean {
  return _mongoReady && mongoose.connection.readyState === 1;
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

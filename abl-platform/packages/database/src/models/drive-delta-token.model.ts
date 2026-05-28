/**
 * Drive Delta Token Model
 *
 * Stores per-drive delta sync tokens for SharePoint connectors.
 * Each drive in a SharePoint site has its own delta token for incremental sync.
 *
 * Delta tokens allow the connector to fetch only changed items since the last sync,
 * significantly improving sync performance (10x faster than full sync).
 */

import mongoose, { Schema, type Model } from 'mongoose';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Interface ───────────────────────────────────────────────────────────────

export interface IDriveDeltaToken {
  _id: string;
  tenantId: string;
  connectorId: string;
  driveId: string;
  deltaLink: string; // Microsoft Graph delta token URL
  lastSyncAt: Date;
  itemsProcessedSinceToken: number; // Track how many items processed with this token
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const driveDeltaTokenSchema = new Schema<IDriveDeltaToken>(
  {
    tenantId: {
      type: String,
      required: true,
      index: true,
    },
    connectorId: {
      type: String,
      required: true,
      index: true,
    },
    driveId: {
      type: String,
      required: true,
      index: true,
    },
    deltaLink: {
      type: String,
      required: true,
    },
    lastSyncAt: {
      type: Date,
      required: true,
    },
    itemsProcessedSinceToken: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true, // Adds createdAt and updatedAt
    collection: 'drive_delta_tokens',
  },
);

// ─── Indexes ─────────────────────────────────────────────────────────────────

// Unique compound index: one token per drive per connector
driveDeltaTokenSchema.index(
  { tenantId: 1, connectorId: 1, driveId: 1 },
  { unique: true, name: 'idx_tenant_connector_drive' },
);

// Index for finding stale tokens (for cleanup or forced refresh)
driveDeltaTokenSchema.index({ lastSyncAt: 1 }, { name: 'idx_last_sync' });

// Index for finding all tokens for a connector
driveDeltaTokenSchema.index({ tenantId: 1, connectorId: 1 }, { name: 'idx_tenant_connector' });

// ─── Plugins ─────────────────────────────────────────────────────────────────

driveDeltaTokenSchema.plugin(tenantIsolationPlugin);

// ─── Model ───────────────────────────────────────────────────────────────────

export const DriveDeltaToken: Model<IDriveDeltaToken> =
  mongoose.models.DriveDeltaToken ||
  mongoose.model<IDriveDeltaToken>('DriveDeltaToken', driveDeltaTokenSchema);

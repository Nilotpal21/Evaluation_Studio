/**
 * ConnectorKVStore Model
 *
 * Per-connection key-value store for polling cursors, tokens,
 * and other stateful data needed by connector triggers and actions.
 * Supports optional TTL via expiresAt field with MongoDB TTL index.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IConnectorKVStore {
  _id: string;
  tenantId: string;
  connectionId: string;
  key: string;
  value: unknown;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ConnectorKVStoreSchema = new Schema<IConnectorKVStore>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    connectionId: { type: String, required: true },
    key: { type: String, required: true },
    value: { type: Schema.Types.Mixed, required: true },
    expiresAt: { type: Date },
  },
  { timestamps: true, collection: 'connector_kv_store' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ConnectorKVStoreSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

ConnectorKVStoreSchema.index({ tenantId: 1, connectionId: 1, key: 1 }, { unique: true });
ConnectorKVStoreSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ─── Model ───────────────────────────────────────────────────────────────

export const ConnectorKVStore =
  (mongoose.models.ConnectorKVStore as any) ||
  model<IConnectorKVStore>('ConnectorKVStore', ConnectorKVStoreSchema);

/**
 * Connector Config Version Model
 *
 * Stores immutable snapshots of connector configuration at each version.
 * Enables config history, diffs, and restore capability.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { ModelRegistry } from '../model-registry.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IConnectorConfigVersion {
  _id: string;
  connectorId: string;
  tenantId: string;
  /** Auto-incrementing integer (1, 2, 3, ...) */
  version: number;
  /** Full config at this version */
  configSnapshot: Record<string, unknown>;
  /** List of top-level fields that changed (e.g., ["filterConfig", "permissionConfig"]) */
  changedFields: string[];
  /** User email or "system" */
  changedBy: string;
  /** What triggered the change */
  changeSource: 'user' | 'system' | 'import' | 'restore';
  /** Human-readable description (e.g., "Updated file type filters") */
  summary: string;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ConnectorConfigVersionSchema = new Schema<IConnectorConfigVersion>(
  {
    _id: { type: String, default: uuidv7 },
    connectorId: { type: String, required: true },
    tenantId: { type: String, required: true },
    version: { type: Number, required: true },
    configSnapshot: { type: Schema.Types.Mixed, required: true },
    changedFields: { type: [String], default: [] },
    changedBy: { type: String, required: true },
    changeSource: {
      type: String,
      enum: ['user', 'system', 'import', 'restore'],
      default: 'user',
    },
    summary: { type: String, default: '' },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'connector_config_versions' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ConnectorConfigVersionSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Primary query: latest version first
ConnectorConfigVersionSchema.index({ tenantId: 1, connectorId: 1, version: -1 });

// Unique version per connector per tenant (optimistic concurrency guard)
ConnectorConfigVersionSchema.index({ tenantId: 1, connectorId: 1, version: 1 }, { unique: true });

// ─── Model ───────────────────────────────────────────────────────────────

// Register with ModelRegistry for dual-database support
ModelRegistry.registerModelDefinition(
  'ConnectorConfigVersion',
  ConnectorConfigVersionSchema,
  'platform',
);

export const ConnectorConfigVersion =
  (mongoose.models.ConnectorConfigVersion as mongoose.Model<IConnectorConfigVersion>) ||
  model<IConnectorConfigVersion>('ConnectorConfigVersion', ConnectorConfigVersionSchema);

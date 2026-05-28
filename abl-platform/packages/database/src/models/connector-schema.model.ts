/**
 * Connector Schema Model (Layer 1)
 *
 * Stores the discovered schema from a source connector.
 * Auto-discovered during connector sync via API introspection.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { ModelRegistry } from '../model-registry.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IConnectorSchemaField {
  path: string;
  label: string;
  type: string;
  isCustom: boolean;
  isRequired: boolean;
  enumValues?: string[];
  sampleValues?: unknown[];
  children?: IConnectorSchemaField[];
  metadata?: any;
}

export interface IConnectorSchema {
  _id: string;
  tenantId: string;
  connectorId: string;
  version: number;
  fields: IConnectorSchemaField[];
  fieldCount: number;
  customFieldCount: number;
  status: string;
  discoveredAt: Date;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ConnectorSchemaFieldSchema: Schema = new Schema(
  {
    path: { type: String, required: true },
    label: { type: String, required: true },
    type: { type: String, required: true },
    isCustom: { type: Boolean, default: false },
    isRequired: { type: Boolean, default: false },
    enumValues: { type: [String] },
    sampleValues: { type: [Schema.Types.Mixed] },
    children: { type: [Schema.Types.Mixed] }, // Recursive — validated at app level
    metadata: { type: Schema.Types.Mixed },
  },
  { _id: false },
);

const ConnectorSchemaSchema = new Schema<IConnectorSchema>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    connectorId: { type: String, required: true },
    version: { type: Number, required: true, default: 1 },
    fields: { type: [ConnectorSchemaFieldSchema], default: [] },
    fieldCount: { type: Number, default: 0 },
    customFieldCount: { type: Number, default: 0 },
    status: { type: String, required: true, default: 'draft' },
    discoveredAt: { type: Date, required: true, default: Date.now },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'connector_schemas' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ConnectorSchemaSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

ConnectorSchemaSchema.index({ connectorId: 1, version: 1 }, { unique: true });
ConnectorSchemaSchema.index({ connectorId: 1 });
ConnectorSchemaSchema.index({ tenantId: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

// Register with ModelRegistry for dual-database support
ModelRegistry.registerModelDefinition('ConnectorSchema', ConnectorSchemaSchema, 'platform');

export const ConnectorSchema =
  (mongoose.models.ConnectorSchema as any) ||
  model<IConnectorSchema>('ConnectorSchema', ConnectorSchemaSchema);

/**
 * Connector Template Model
 *
 * Stores reusable connector configuration templates that can be applied
 * when creating new connectors. Supports drift detection by comparing
 * current connector config against the template snapshot.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { ModelRegistry } from '../model-registry.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IConnectorTemplate {
  _id: string;
  tenantId: string;
  name: string;
  description: string;
  connectorType: string;
  /** Snapshot of connector config: scope, filters, schedule, permissionMode */
  configSnapshot: Record<string, unknown>;
  permissionMode: 'enabled' | 'disabled';
  createdBy: string;
  updatedBy: string;
  usageCount: number;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ConnectorTemplateSchema = new Schema<IConnectorTemplate>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, default: '' },
    connectorType: { type: String, required: true },
    configSnapshot: { type: Schema.Types.Mixed, required: true },
    permissionMode: {
      type: String,
      enum: ['enabled', 'disabled'],
      default: 'disabled',
    },
    createdBy: { type: String, required: true },
    updatedBy: { type: String, required: true },
    usageCount: { type: Number, default: 0 },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'connector_templates' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ConnectorTemplateSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Unique template name per tenant
ConnectorTemplateSchema.index({ tenantId: 1, name: 1 }, { unique: true });

// List templates by connector type
ConnectorTemplateSchema.index({ tenantId: 1, connectorType: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

ModelRegistry.registerModelDefinition('ConnectorTemplate', ConnectorTemplateSchema, 'platform');

export const ConnectorTemplate =
  (mongoose.models.ConnectorTemplate as mongoose.Model<IConnectorTemplate>) ||
  model<IConnectorTemplate>('ConnectorTemplate', ConnectorTemplateSchema);

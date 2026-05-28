/**
 * Discovered Schema Model
 *
 * Stores enriched schemas produced by the SchemaDiscoveryService pipeline (Stories 1.1-1.6).
 * Includes type inference, enum detection, and template enrichment.
 * Distinct from ConnectorSchema (Layer 1 raw connector fields from sync).
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { ModelRegistry } from '../model-registry.js';

// ─── Document Interfaces ────────────────────────────────────────────────

export interface IDiscoveredSchemaField {
  name: string;
  type: string;
  path: string;
  description?: string;
  required?: boolean;
  enumValues?: string[];
  format?: string;
  enumDisplayNames?: Record<string, string>;
  enumSource?: 'template' | 'inferred';
}

export interface IDiscoveredSchema {
  _id: string;
  tenantId: string;
  connectorId: string;
  knowledgeBaseId: string;
  version: number;
  fields: IDiscoveredSchemaField[];
  fieldCount: number;
  discoveryMethod: 'api' | 'hybrid';
  discoveredAt: Date;
  status: string;
  metadata: {
    connectorType: string;
    version?: string;
  };
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ─────────────────────────────────────────────────────────────

const DiscoveredSchemaFieldSchema = new Schema<IDiscoveredSchemaField>(
  {
    name: { type: String, required: true },
    type: { type: String, required: true },
    path: { type: String, required: true },
    description: { type: String },
    required: { type: Boolean },
    enumValues: { type: [String], default: undefined },
    format: { type: String },
    enumDisplayNames: { type: Schema.Types.Mixed },
    enumSource: { type: String, enum: ['template', 'inferred'] },
  },
  { _id: false },
);

const DiscoveredSchemaSchema = new Schema<IDiscoveredSchema>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    connectorId: { type: String, required: true },
    knowledgeBaseId: { type: String, required: true },
    version: { type: Number, required: true },
    fields: { type: [DiscoveredSchemaFieldSchema], default: [] },
    fieldCount: { type: Number, default: 0 },
    discoveryMethod: { type: String, required: true, enum: ['api', 'hybrid'] },
    discoveredAt: { type: Date, required: true, default: Date.now },
    status: { type: String, required: true, default: 'draft' },
    metadata: {
      connectorType: { type: String, required: true },
      version: { type: String },
    },
    _v: { type: Number },
  },
  { timestamps: true, collection: 'discovered_schemas' },
);

// ─── Plugins ────────────────────────────────────────────────────────────

DiscoveredSchemaSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ────────────────────────────────────────────────────────────

DiscoveredSchemaSchema.index({ tenantId: 1, knowledgeBaseId: 1, connectorId: 1 }, { unique: true });
DiscoveredSchemaSchema.index({ tenantId: 1, connectorId: 1 });
DiscoveredSchemaSchema.index({ tenantId: 1, discoveredAt: -1 });

// ─── Model ──────────────────────────────────────────────────────────────

ModelRegistry.registerModelDefinition('DiscoveredSchema', DiscoveredSchemaSchema, 'platform');

export const DiscoveredSchema =
  (mongoose.models.DiscoveredSchema as any) ||
  model<IDiscoveredSchema>('DiscoveredSchema', DiscoveredSchemaSchema);

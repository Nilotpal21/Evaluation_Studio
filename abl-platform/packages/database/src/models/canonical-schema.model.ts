/**
 * Canonical Schema Model (Layer 2)
 *
 * Defines the normalized field schema for a knowledge base.
 * Source fields are mapped to canonical fields via FieldMapping documents.
 * Canonical metadata is materialized at ingestion time on search chunks.
 *
 * Each field has two identities:
 * - `name` (alias): business-friendly name used by agents, vocabulary, and UI
 * - `storageField`: actual field path in the vector store under metadata.canonical.*
 *
 * The alias layer lives here (MongoDB only). The vector store never sees alias names.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface ICanonicalField {
  /** Alias name — business-friendly identifier used by agents, vocabulary, and UI */
  name: string;
  /** Display label shown in UI (e.g., "Priority Level") */
  label: string;
  /** Data type: string, number, float, date, boolean, text, array */
  type: string;
  /** Description for LLM context — helps agents understand field purpose */
  description?: string;
  /** Actual vector store field path under metadata.canonical.* (e.g., "priority", "custom_string_1") */
  storageField: string;
  /** Whether the underlying field is indexed */
  indexed: boolean;
  /** Exposed for filtering in queries */
  filterable: boolean;
  /** Exposed for aggregation/grouping in queries */
  aggregatable: boolean;
  /** Exposed for sorting in queries */
  sortable: boolean;
  /** Display value → stored value mapping for enum coercion (e.g., { "high": 0.8, "low": 0.2 }) */
  enumValues?: Record<string, unknown>;
  /** Original connector field path for traceability (e.g., "fields.priority.name") */
  sourceConnectorField?: string;
}

export interface ICanonicalSchema {
  _id: string;
  tenantId: string;
  knowledgeBaseId: string;
  version: number;
  fields: ICanonicalField[];
  status: string;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const CanonicalFieldSchema = new Schema<ICanonicalField>(
  {
    name: { type: String, required: true },
    label: { type: String, required: true },
    type: { type: String, required: true },
    description: { type: String },
    storageField: { type: String, required: true },
    indexed: { type: Boolean, default: false },
    filterable: { type: Boolean, default: false },
    aggregatable: { type: Boolean, default: false },
    sortable: { type: Boolean, default: false },
    enumValues: { type: Schema.Types.Mixed },
    sourceConnectorField: { type: String },
  },
  { _id: false },
);

const CanonicalSchemaSchema = new Schema<ICanonicalSchema>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    knowledgeBaseId: { type: String, required: true },
    version: { type: Number, required: true, default: 1 },
    fields: { type: [CanonicalFieldSchema], default: [] },
    status: { type: String, required: true, default: 'draft' },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'canonical_schemas' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

CanonicalSchemaSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

CanonicalSchemaSchema.index({ knowledgeBaseId: 1, version: 1 }, { unique: true });
CanonicalSchemaSchema.index({ knowledgeBaseId: 1 });
CanonicalSchemaSchema.index({ tenantId: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const CanonicalSchema =
  (mongoose.models.CanonicalSchema as any) ||
  model<ICanonicalSchema>('CanonicalSchema', CanonicalSchemaSchema);

/**
 * Field Mapping Model
 *
 * Maps source connector fields to canonical schema fields.
 * Can be auto-suggested by LLM or manually created by users.
 * Applied at ingestion time to materialize canonical metadata on chunks.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { ModelRegistry } from '../model-registry.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IFieldTransform {
  type: string;
  valueMap?: Record<string, string>;
  expression?: string;
  sources?: string[];
  computeExpression?: string;
  sourceFormat?: string;
  delimiter?: string;
}

export interface IFieldMapping {
  _id: string;
  tenantId: string;
  canonicalSchemaId: string;
  canonicalField: string;
  connectorId: string;
  /** Path in the source connector schema */
  sourcePath: string;
  /** Transform to apply during ingestion */
  transform: IFieldTransform;
  /** Confidence score from LLM suggestion (0-1) */
  confidence: number;
  status: string;
  /** Who suggested this mapping */
  suggestedBy: string;
  /** Who reviewed/confirmed */
  reviewedBy: string | null;
  reviewedAt: Date | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const FieldTransformSchema = new Schema<IFieldTransform>(
  {
    type: { type: String, required: true, default: 'direct' },
    valueMap: { type: Schema.Types.Mixed },
    expression: { type: String },
    sources: { type: [String] },
    computeExpression: { type: String },
    sourceFormat: { type: String },
    delimiter: { type: String },
  },
  { _id: false },
);

const FieldMappingSchema = new Schema<IFieldMapping>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    canonicalSchemaId: { type: String, required: true },
    canonicalField: { type: String, required: true },
    connectorId: { type: String, required: true },
    sourcePath: { type: String, required: true },
    transform: { type: FieldTransformSchema, required: true, default: () => ({ type: 'direct' }) },
    confidence: { type: Number, required: true, default: 0 },
    status: { type: String, required: true, default: 'suggested' },
    suggestedBy: { type: String, required: true, default: 'user' },
    reviewedBy: { type: String, default: null },
    reviewedAt: { type: Date, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'field_mappings' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

FieldMappingSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

FieldMappingSchema.index(
  { canonicalSchemaId: 1, canonicalField: 1, connectorId: 1 },
  { unique: true },
);
FieldMappingSchema.index({ status: 1 });
FieldMappingSchema.index({ tenantId: 1, canonicalSchemaId: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

// Register with ModelRegistry for dual-database support
ModelRegistry.registerModelDefinition('FieldMapping', FieldMappingSchema, 'platform');

export const FieldMapping =
  (mongoose.models.FieldMapping as any) || model<IFieldMapping>('FieldMapping', FieldMappingSchema);

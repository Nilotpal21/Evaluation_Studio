/**
 * NodeTypeDefinition Model
 *
 * Stores node type definitions for the pipeline engine.
 * Each node type describes its config schema, execution behavior,
 * traits (for auto-merged standard fields), and storage schema.
 *
 * Replaces the hardcoded ACTIVITY_TYPES dict and registerBuiltinNodes().
 * tenantId='SYSTEM' for platform-provided types; tenant-specific for custom.
 */

import mongoose, { Schema } from 'mongoose';
import type { NodeTypeDefinitionDoc } from '../pipeline/types.js';

// ─── Sub-schemas ──────────────────────────────────────────────────────────

const ConfigFieldDefinitionSchema: Schema = new Schema(
  {
    name: { type: String, required: true },
    type: {
      type: String,
      required: true,
      enum: ['string', 'number', 'boolean', 'enum', 'string[]', 'object', 'object[]', 'info'],
    },
    required: { type: Boolean, default: false },
    default: { type: Schema.Types.Mixed },
    label: {
      type: String,
      required: function requiredConfigLabel(this: { type?: string }) {
        return this.type !== 'info';
      },
    },
    description: { type: String, required: true },
    placeholder: { type: String },
    multiline: { type: Boolean },
    expressionAware: { type: Boolean },
    group: { type: String },
    validation: {
      min: { type: Number },
      max: { type: Number },
      minLength: { type: Number },
      maxLength: { type: Number },
      pattern: { type: String },
      minItems: { type: Number },
      maxItems: { type: Number },
    },
    values: [{ type: String }],
    showWhen: {
      field: { type: String },
      equals: { type: Schema.Types.Mixed },
    },
    itemSchema: [{ type: Schema.Types.Mixed }],
    intent: { type: String, enum: ['info', 'warning', 'success', 'error'] },
    dynamicOptions: { type: String, enum: ['mongo-collections', 'clickhouse-tables'] },
    suggestions: [
      {
        label: { type: String },
        value: { type: String },
        showWhen: {
          field: { type: String },
          equals: { type: Schema.Types.Mixed },
        },
      },
    ],
    resetFields: [{ type: String }],
  },
  { _id: false },
);

const StorageColumnDefinitionSchema = new Schema(
  {
    name: { type: String, required: true },
    type: { type: String, required: true },
    source: { type: String, required: true, enum: ['system', 'computed'] },
    description: { type: String, required: true },
  },
  { _id: false },
);

const StorageTableDefinitionSchema = new Schema(
  {
    table: { type: String, required: true },
    granularity: {
      type: String,
      required: true,
      enum: ['message', 'session', 'customer', 'metric'],
    },
    columns: [StorageColumnDefinitionSchema],
  },
  { _id: false },
);

// ─── Main Schema ──────────────────────────────────────────────────────────

const NodeTypeDefinitionSchema = new Schema<NodeTypeDefinitionDoc>(
  {
    _id: { type: String, required: true },
    tenantId: { type: String, required: true, index: true },

    label: { type: String, required: true },
    description: { type: String, required: true },
    category: {
      type: String,
      required: true,
      enum: ['data', 'logic', 'integration', 'compute', 'action'],
    },
    icon: { type: String },

    executionModel: {
      type: String,
      required: true,
      enum: ['sync', 'async', 'control-flow'],
    },
    defaultTimeout: { type: Number, required: true, default: 60000 },
    defaultRetries: { type: Number, required: true, default: 0 },
    retryable: { type: Boolean },
    requiredCapabilities: [{ type: String }],
    contextKey: { type: String },

    traits: [{ type: String, enum: ['compute', 'llm', 'storage'] }],

    configSchema: [ConfigFieldDefinitionSchema],

    outputSchema: { type: Schema.Types.Mixed },

    storageSchema: {
      tables: [StorageTableDefinitionSchema],
    },

    inputSchema: {
      requiresPreviousStep: { type: String },
      requiredInputFields: [{ type: String }],
    },

    version: { type: Number, required: true, default: 1 },
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true, collection: 'node_type_definitions' },
);

// ─── Indexes ──────────────────────────────────────────────────────────────

NodeTypeDefinitionSchema.index({ tenantId: 1, isActive: 1 });
NodeTypeDefinitionSchema.index({ tenantId: 1, category: 1, isActive: 1 });

// ─── Model ────────────────────────────────────────────────────────────────

export const NodeTypeDefinitionModel =
  mongoose.models['NodeTypeDefinition'] ??
  mongoose.model<NodeTypeDefinitionDoc>('NodeTypeDefinition', NodeTypeDefinitionSchema);

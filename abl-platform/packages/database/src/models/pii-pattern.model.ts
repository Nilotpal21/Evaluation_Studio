/**
 * PII Pattern Model
 *
 * Defines custom and built-in-override PII detection patterns scoped to
 * a tenant + project. Each pattern specifies a regex, redaction strategy,
 * per-consumer access rules, and a default render mode.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { ModelRegistry } from '../model-registry.js';

// ─── Embedded Interfaces ─────────────────────────────────────────────────

export interface IPIIPatternMaskConfig {
  showFirst: number;
  showLast: number;
  maskChar: string;
}

export interface IPIIPatternRandomConfig {
  charset: 'alphanumeric' | 'alphabetic' | 'numeric' | 'custom';
  customChars?: string;
  length?: number;
}

export interface IPIIPatternRedaction {
  type: 'predefined' | 'masked' | 'random';
  label?: string;
  maskConfig?: IPIIPatternMaskConfig;
  randomConfig?: IPIIPatternRandomConfig;
}

export interface IPIIPatternConsumerAccess {
  consumer: string;
  renderMode: string;
}

// ─── Document Interface ──────────────────────────────────────────────────

export interface IPIIPattern {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  description?: string;
  piiType: string;
  /** Required for custom patterns, null for built-in overrides */
  regex?: string;
  /** Optional validator expression */
  validate?: string;
  redaction: IPIIPatternRedaction;
  consumerAccess: IPIIPatternConsumerAccess[];
  defaultRenderMode: string;
  enabled: boolean;
  builtinOverride: boolean;
  _v: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Embedded Schemas ────────────────────────────────────────────────────

const MaskConfigSchema = new Schema<IPIIPatternMaskConfig>(
  {
    showFirst: { type: Number, required: true },
    showLast: { type: Number, required: true },
    maskChar: { type: String, required: true },
  },
  { _id: false },
);

const RandomConfigSchema = new Schema<IPIIPatternRandomConfig>(
  {
    charset: {
      type: String,
      required: true,
      enum: ['alphanumeric', 'alphabetic', 'numeric', 'custom'],
    },
    customChars: { type: String, default: undefined },
    length: { type: Number, default: undefined },
  },
  { _id: false },
);

const RedactionSchema = new Schema<IPIIPatternRedaction>(
  {
    type: {
      type: String,
      required: true,
      enum: ['predefined', 'masked', 'random'],
    },
    label: { type: String, default: undefined },
    maskConfig: { type: MaskConfigSchema, default: undefined },
    randomConfig: { type: RandomConfigSchema, default: undefined },
  },
  { _id: false },
);

const ConsumerAccessSchema = new Schema<IPIIPatternConsumerAccess>(
  {
    consumer: { type: String, required: true },
    renderMode: { type: String, required: true },
  },
  { _id: false },
);

// ─── Schema ──────────────────────────────────────────────────────────────

const PIIPatternSchema = new Schema<IPIIPattern>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, default: undefined },
    piiType: { type: String, required: true },
    regex: { type: String, default: undefined },
    validate: { type: String, default: undefined },
    redaction: { type: RedactionSchema, required: true },
    consumerAccess: { type: [ConsumerAccessSchema], default: [] },
    defaultRenderMode: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    builtinOverride: { type: Boolean, default: false },
    _v: { type: Number, default: 1 },
    createdBy: { type: String, required: true },
  },
  {
    timestamps: true,
    collection: 'pii_patterns',
    // Preserve the existing API/storage field name `validate` for PII pattern
    // payload compatibility until we can do a broader migration away from
    // Mongoose's reserved key. Without this, every stable test run emits the
    // same warning even though the field is intentionally supported here.
    suppressReservedKeysWarning: true,
  },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

PIIPatternSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

PIIPatternSchema.index({ tenantId: 1, projectId: 1 });

// Name uniqueness applies only to CUSTOM patterns. Built-in overrides are
// allowed to share names with custom patterns (and with each other across
// projects) because they are identified by piiType, not by name.
PIIPatternSchema.index(
  { tenantId: 1, projectId: 1, name: 1 },
  { unique: true, partialFilterExpression: { builtinOverride: false } },
);

// At most ONE built-in override per (project, piiType). This is the canonical
// uniqueness constraint for overrides — two clients cannot accidentally create
// duplicates by racing POSTs with the same payload.
PIIPatternSchema.index(
  { tenantId: 1, projectId: 1, piiType: 1 },
  { unique: true, partialFilterExpression: { builtinOverride: true } },
);

// ─── Registry ────────────────────────────────────────────────────────────

ModelRegistry.registerModelDefinition('PIIPattern', PIIPatternSchema, 'platform');

// ─── Model ───────────────────────────────────────────────────────────────

export const PIIPattern =
  (mongoose.models.PIIPattern as any) || model<IPIIPattern>('PIIPattern', PIIPatternSchema);

/**
 * PipelineDefinition Model
 *
 * Stores pipeline definitions for the workflow engine.
 * Each pipeline belongs to a tenant (and optionally a project), defining
 * trigger configuration, input schema, and an ordered list of steps.
 *
 * Supports multi-trigger definitions with per-trigger execution strategies.
 */

import mongoose, { Schema, model } from 'mongoose';
import type {
  ConfigField,
  TriggerEntry,
  ExecutionStrategy,
  PipelineStep,
} from '../pipeline/types.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IPipelineDefinition {
  _id: string;
  tenantId: string;
  projectId?: string;
  name: string;
  description?: string;
  pipelineType?: string;
  version: number;
  status: 'draft' | 'active' | 'archived';

  /** Self-describing config schema */
  configSchema: {
    fields: ConfigField[];
  };

  /** All triggers this pipeline supports */
  supportedTriggers: TriggerEntry[];

  /** Default active trigger IDs */
  defaultTriggerIds: string[];

  /** Per-trigger execution strategies */
  strategies: Map<string, ExecutionStrategy>;

  // ── Kept as optional for migration compat ──
  trigger?: {
    type: 'kafka' | 'schedule' | 'manual';
    kafkaTopic?: string;
    eventFilter?: { field: string; equals: string };
    schedule?: string;
  };
  inputSchema?: {
    required: string[];
    properties: Record<string, { type: string; description?: string }>;
  };
  outputSchema?: {
    properties: Record<string, { type: string; description?: string }>;
  };
  steps?: Array<{
    id: string;
    activity?: string;
    name?: string;
    type?: string;
    parallel?: string;
    condition?: string | { expression: string };
    config?: Record<string, any>;
    timeout?: number;
    retries?: number;
    onFailure?: 'stop' | 'skip' | 'continue';
  }>;
  onStepFailure?: 'stop' | 'skip' | 'continue';

  /** Graph-based flow (universal pipeline engine) */
  nodes?: Array<Record<string, any>>;
  entryNodeId?: string;
  onNodeFailure?: 'stop' | 'skip' | 'continue';

  tags?: string[];
  maxConcurrency?: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Sub-schemas ─────────────────────────────────────────────────────────

// ConfigField is stored as Mixed so the ConfigField type can evolve without
// requiring schema migrations. The TypeScript type in `pipeline/types.ts`
// remains the authoritative shape; persistence is just a pass-through.
const ConfigFieldSchema = Schema.Types.Mixed;

const TriggerEntrySchema = new Schema(
  {
    id: { type: String, required: true },
    type: { type: String, required: true, enum: ['kafka', 'schedule', 'manual'] },
    kafkaTopic: { type: String },
    eventFilter: {
      field: { type: String },
      equals: { type: String },
    },
    schedule: { type: String },
    strategy: { type: String, required: true },
    label: { type: String, required: true },
    description: { type: String, required: true },
    inputSchema: { type: Schema.Types.Mixed },
    // ABLP-564 Phase 3: realistic payload for the Studio test drawer.
    exampleOutput: { type: Schema.Types.Mixed },
  },
  { _id: false },
);

const PipelineStepSchema = new Schema(
  {
    id: { type: String, required: true },
    activity: { type: String },
    name: { type: String },
    type: { type: String },
    parallel: { type: String },
    condition: { type: Schema.Types.Mixed },
    config: { type: Schema.Types.Mixed, default: {} },
    timeout: { type: Number },
    retries: { type: Number },
    onFailure: { type: String, enum: ['stop', 'skip', 'continue'] },
  },
  { _id: false },
);

const ExecutionStrategySchema = new Schema(
  {
    executionMode: { type: String, required: true, enum: ['batch', 'realtime'] },
    steps: [PipelineStepSchema],
    onStepFailure: { type: String, enum: ['stop', 'skip', 'continue'] },
  },
  { _id: false },
);

// ─── Schema ──────────────────────────────────────────────────────────────

const PipelineDefinitionSchema = new Schema<IPipelineDefinition>(
  {
    _id: { type: String, required: true },
    tenantId: { type: String, required: true, index: true },
    projectId: { type: String },
    name: { type: String, required: true },
    description: { type: String },
    pipelineType: { type: String, index: true },
    version: { type: Number, required: true, default: 1 },
    status: {
      type: String,
      required: true,
      enum: ['draft', 'active', 'archived'],
      default: 'draft',
    },

    // ── NEW: Multi-trigger fields ──
    configSchema: {
      fields: { type: [ConfigFieldSchema], default: [] },
    },
    supportedTriggers: [TriggerEntrySchema],
    defaultTriggerIds: [{ type: String }],
    strategies: { type: Map, of: ExecutionStrategySchema },

    // ── OLD: Kept for migration compat ──
    trigger: {
      type: { type: String, enum: ['kafka', 'schedule', 'manual'] },
      kafkaTopic: { type: String },
      eventFilter: {
        field: { type: String },
        equals: { type: String },
      },
      schedule: { type: String },
    },
    inputSchema: { type: Schema.Types.Mixed },
    outputSchema: { type: Schema.Types.Mixed },
    steps: [{ type: Schema.Types.Mixed }],
    onStepFailure: { type: String, enum: ['stop', 'skip', 'continue'] },

    // ── NEW: Graph-based pipeline fields ──
    nodes: [{ type: Schema.Types.Mixed }],
    entryNodeId: { type: String },
    onNodeFailure: { type: String, enum: ['stop', 'skip', 'continue'] },

    tags: [{ type: String }],
    maxConcurrency: { type: Number },
    createdBy: { type: String, required: true },
  },
  { timestamps: true, collection: 'pipeline_definitions' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

PipelineDefinitionSchema.index({ tenantId: 1, status: 1 });
PipelineDefinitionSchema.index({ tenantId: 1, projectId: 1, status: 1 });
PipelineDefinitionSchema.index({ tenantId: 1, 'supportedTriggers.kafkaTopic': 1, status: 1 });
PipelineDefinitionSchema.index({ tenantId: 1, tags: 1 });

// Race-safe enforcement of pipeline name uniqueness.
// Partial filter excludes archived pipelines so a soft-deleted name can be reused
// in a new pipeline. Built-in pipelines (tenantId === '__platform__') live alongside
// custom pipelines in this collection but built-in vs custom collisions are detected
// in code (assertUniquePipelineName) since the platform tenant uses a different scope.
PipelineDefinitionSchema.index(
  { tenantId: 1, projectId: 1, name: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['draft', 'active'] } } },
);

// ─── Model ───────────────────────────────────────────────────────────────

export const PipelineDefinitionModel =
  (mongoose.models.PipelineDefinition as mongoose.Model<IPipelineDefinition>) ||
  model<IPipelineDefinition>('PipelineDefinition', PipelineDefinitionSchema);

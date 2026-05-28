/**
 * PipelineConfig Model
 *
 * Stores per-tenant, per-project pipeline configuration.
 * Supports a resolution chain: project-level > tenant-level > null.
 * Tracks version history with diffs and reprocessing detection.
 */

import mongoose, { Schema, type Document } from 'mongoose';

// ─── Types ──────────────────────────────────────────────────────────────

export type PipelineType =
  | 'sentiment_analysis'
  | 'intent_classification'
  | 'quality_evaluation'
  | 'anomaly_detection'
  | 'nl_to_sql'
  | 'knowledge_gap'
  | 'hallucination_detection'
  | 'embedding_drift'
  | 'predictive_ml'
  | 'simulation'
  | 'guardrail_analysis'
  | 'context_preservation'
  | 'friction_detection'
  | 'drift_detection';

export interface ConfigChange {
  version: number;
  changedBy: string;
  changedAt: Date;
  diff: Record<string, { old: unknown; new: unknown }>;
  reprocessingRequired: boolean;
}

// ─── Document Interface ──────────────────────────────────────────────────

export interface IPipelineConfig extends Document {
  tenantId: string;
  projectId?: string | null;
  pipelineType: PipelineType;
  version: number;
  enabled: boolean;
  config: Record<string, unknown>;
  /** Which trigger IDs are active for this tenant/project */
  activeTriggers?: string[];
  /** Per-trigger config overrides */
  triggerConfigs?: Map<
    string,
    {
      samplingRate?: number;
      stepOverrides?: Map<string, Record<string, unknown>>;
    }
  >;
  lastBackfillAt?: Date;
  backfillStatus?: 'idle' | 'running' | 'completed' | 'failed';
  lastProcessedAt?: Date;
  createdBy: string;
  updatedBy: string;
  configHistory?: ConfigChange[];
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const PipelineConfigSchema = new Schema<IPipelineConfig>(
  {
    tenantId: { type: String, required: true },
    projectId: { type: String, default: null },
    pipelineType: {
      type: String,
      required: true,
      enum: [
        'sentiment_analysis',
        'intent_classification',
        'quality_evaluation',
        'anomaly_detection',
        'nl_to_sql',
        'knowledge_gap',
        'hallucination_detection',
        'embedding_drift',
        'predictive_ml',
        'simulation',
        'guardrail_analysis',
        'context_preservation',
        'friction_detection',
        'drift_detection',
      ],
    },
    version: { type: Number, default: 1 },
    enabled: { type: Boolean, default: false },
    config: { type: Schema.Types.Mixed, default: {} },
    activeTriggers: [{ type: String }],
    triggerConfigs: {
      type: Map,
      of: new Schema(
        {
          samplingRate: { type: Number, min: 0, max: 1 },
          stepOverrides: { type: Map, of: Schema.Types.Mixed },
        },
        { _id: false },
      ),
    },
    lastBackfillAt: Date,
    backfillStatus: {
      type: String,
      enum: ['idle', 'running', 'completed', 'failed'],
      default: 'idle',
    },
    lastProcessedAt: Date,
    createdBy: { type: String, required: true },
    updatedBy: { type: String, required: true },
    configHistory: [
      {
        version: Number,
        changedBy: String,
        changedAt: Date,
        diff: Schema.Types.Mixed,
        reprocessingRequired: Boolean,
      },
    ],
  },
  { timestamps: true, collection: 'pipeline_configs' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

PipelineConfigSchema.index({ tenantId: 1, pipelineType: 1, projectId: 1 }, { unique: true });
PipelineConfigSchema.index({ tenantId: 1, enabled: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const PipelineConfigModel =
  mongoose.models['PipelineConfig'] ??
  mongoose.model<IPipelineConfig>('PipelineConfig', PipelineConfigSchema);

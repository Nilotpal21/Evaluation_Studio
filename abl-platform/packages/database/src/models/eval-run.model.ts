/**
 * EvalRun Model
 *
 * Run metadata for eval executions. Scores and conversation results
 * live in ClickHouse — this model tracks status, snapshots, and aggregated summaries.
 */

import mongoose, { Schema, model } from 'mongoose';
import { EVAL_DEFAULT_VERSION } from '../constants/eval-limits.js';
import { EVAL_KNOWN_SOURCES, type EvalKnownSource } from '../eval-retention.js';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Sub-document Interfaces ─────────────────────────────────────────────

export interface IEvalRunSummary {
  totalConversations: number;
  totalEvaluations: number;
  avgScore: number;
  scoresByEvaluator: Record<string, number>;
  durationMs: number;
  estimatedCost: number;
  actualCost: number;
  stdDev: number;
  confidenceInterval: [number, number];
  passAtK: number;
  passExpK: number;
}

export interface IEvalRegressionDetail {
  evaluatorId: string;
  personaId: string;
  scenarioId: string;
  baselineScore: number;
  currentScore: number;
  delta: number;
}

// ─── Document Interface ──────────────────────────────────────────────────

export interface IEvalRun {
  _id: string;
  tenantId: string;
  projectId: string;
  evalSetId: string;
  name?: string;
  notes?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  triggerSource: 'manual' | 'ci' | 'scheduled';
  knownSource: EvalKnownSource;
  triggeredBy: string;
  pipelineRunId?: string;
  snapshot: {
    personaVersions: Record<string, number>;
    scenarioVersions: Record<string, number>;
    evaluatorVersions: Record<string, number>;
  };
  summary?: IEvalRunSummary;
  regressionDetected: boolean;
  baselineRunId?: string;
  regressionDetails?: IEvalRegressionDetail[];
  archived: boolean;
  archivedAt?: Date;
  archivedReason?: 'retention_expired';
  startedAt?: Date;
  completedAt?: Date;
  _v: number;
  createdAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const EvalRunSchema = new Schema<IEvalRun>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    evalSetId: { type: String, required: true },
    name: String,
    notes: String,
    status: {
      type: String,
      enum: ['pending', 'running', 'completed', 'failed', 'cancelled'],
      default: 'pending',
    },
    triggerSource: {
      type: String,
      enum: ['manual', 'ci', 'scheduled'],
      default: 'manual',
    },
    knownSource: {
      type: String,
      enum: EVAL_KNOWN_SOURCES,
      default: 'eval',
    },
    triggeredBy: { type: String, required: true },
    pipelineRunId: String,
    snapshot: {
      type: Schema.Types.Mixed,
      default: () => ({
        personaVersions: {},
        scenarioVersions: {},
        evaluatorVersions: {},
      }),
    },
    summary: Schema.Types.Mixed,
    regressionDetected: { type: Boolean, default: false },
    baselineRunId: String,
    regressionDetails: [Schema.Types.Mixed],
    archived: { type: Boolean, default: false },
    archivedAt: Date,
    archivedReason: {
      type: String,
      enum: ['retention_expired'],
    },
    startedAt: Date,
    completedAt: Date,
    _v: { type: Number, default: EVAL_DEFAULT_VERSION },
  },
  { timestamps: true, collection: 'eval_runs' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

EvalRunSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

EvalRunSchema.index({ tenantId: 1, projectId: 1 });
EvalRunSchema.index({ tenantId: 1, projectId: 1, createdAt: -1, _id: -1 });
EvalRunSchema.index({ tenantId: 1, projectId: 1, status: 1, createdAt: -1 });
EvalRunSchema.index({ tenantId: 1, projectId: 1, archived: 1, createdAt: -1 });
EvalRunSchema.index({ tenantId: 1, evalSetId: 1, createdAt: -1 });
EvalRunSchema.index({ tenantId: 1, status: 1 });
EvalRunSchema.index({ pipelineRunId: 1 }, { sparse: true, unique: true });

// ─── Model ───────────────────────────────────────────────────────────────

export const EvalRun =
  (mongoose.models.EvalRun as mongoose.Model<IEvalRun>) ||
  model<IEvalRun>('EvalRun', EvalRunSchema);

/**
 * Experiment Model
 *
 * Stores per-tenant, per-project A/B experiment definitions that compare
 * a control agent version against an experiment version with configurable
 * traffic splits and safety thresholds.
 */

import mongoose, { Schema, type Document } from 'mongoose';

// ─── Sub-types ────────────────────────────────────────────────────────────

/** A safety rule that auto-stops the experiment if a metric breaches the threshold. */
export interface ExperimentSafetyRule {
  metric: string;
  operator: 'lt' | 'gt' | 'lte' | 'gte';
  threshold: number;
  minSampleSize: number;
  comparison: 'absolute' | 'relative_to_control';
}

/** Per-metric significance result stored with the experiment. */
export interface StoredSignificanceResult {
  metric: string;
  controlMean: number;
  experimentMean: number;
  pValue: number;
  significant: boolean;
  confidenceInterval: [number, number];
  lift: number;
}

/** Cached results stored on the experiment document. */
export interface StoredExperimentResults {
  controlSampleSize: number;
  experimentSampleSize: number;
  significance: StoredSignificanceResult[];
  sampleSizeAdequate: boolean;
  computedAt: Date;
}

/** Detail recorded when a safety rule breach triggers auto-stop. */
export interface ExperimentBreachDetail {
  metric: string;
  value: number;
  controlValue: number | null;
  threshold: number;
  comparison: 'absolute' | 'relative_to_control';
  checkedAt: Date;
}

// ─── Document Interface ──────────────────────────────────────────────────

export interface IExperiment extends Document {
  tenantId: string;
  projectId: string;
  name: string;
  description?: string;
  status: 'draft' | 'running' | 'stopped' | 'completed';
  assignmentMode: 'version' | 'deployment';
  // version-mode fields (required when assignmentMode === 'version')
  controlVersion?: string;
  experimentVersion?: string;
  // deployment-mode fields (required when assignmentMode === 'deployment')
  controlDeploymentId?: string;
  experimentDeploymentId?: string;
  trafficSplit: number;
  successMetrics: string[];
  /** @deprecated use safetyRules for structured safety config */
  safetyMetrics: string[];
  channels: string[];
  safetyRules: ExperimentSafetyRule[];
  stoppedReason: 'manual' | 'safety_breach' | 'completed' | null;
  breachDetail: ExperimentBreachDetail | null;
  lastResultsAt: Date | null;
  results: StoredExperimentResults | null;
  controlAssignments: number;
  experimentAssignments: number;
  startedAt?: Date;
  stoppedAt?: Date;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Sub-schemas ──────────────────────────────────────────────────────────

const ExperimentSafetyRuleSchema = new Schema<ExperimentSafetyRule>(
  {
    metric: { type: String, required: true },
    operator: { type: String, required: true, enum: ['lt', 'gt', 'lte', 'gte'] },
    threshold: { type: Number, required: true },
    minSampleSize: { type: Number, required: true, default: 100 },
    comparison: {
      type: String,
      required: true,
      enum: ['absolute', 'relative_to_control'],
      default: 'absolute',
    },
  },
  { _id: false },
);

const SignificanceResultSchema = new Schema<StoredSignificanceResult>(
  {
    metric: { type: String, required: true },
    controlMean: { type: Number, required: true },
    experimentMean: { type: Number, required: true },
    pValue: { type: Number, required: true },
    significant: { type: Boolean, required: true },
    confidenceInterval: { type: [Number], required: true },
    lift: { type: Number, required: true },
  },
  { _id: false },
);

const ExperimentResultsSchema = new Schema<StoredExperimentResults>(
  {
    controlSampleSize: { type: Number, required: true },
    experimentSampleSize: { type: Number, required: true },
    significance: { type: [SignificanceResultSchema], default: [] },
    sampleSizeAdequate: { type: Boolean, required: true },
    computedAt: { type: Date, required: true },
  },
  { _id: false },
);

const ExperimentBreachDetailSchema = new Schema<ExperimentBreachDetail>(
  {
    metric: { type: String, required: true },
    value: { type: Number, required: true },
    controlValue: { type: Number, default: null },
    threshold: { type: Number, required: true },
    comparison: {
      type: String,
      required: true,
      enum: ['absolute', 'relative_to_control'],
    },
    checkedAt: { type: Date, required: true },
  },
  { _id: false },
);

// ─── Schema ──────────────────────────────────────────────────────────────

const ExperimentSchema = new Schema<IExperiment>(
  {
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String },
    status: {
      type: String,
      enum: ['draft', 'running', 'stopped', 'completed'],
      default: 'draft',
    },
    assignmentMode: { type: String, enum: ['version', 'deployment'], default: 'version' },
    controlVersion: { type: String },
    experimentVersion: { type: String },
    controlDeploymentId: { type: String },
    experimentDeploymentId: { type: String },
    trafficSplit: { type: Number, required: true, min: 0.01, max: 0.99 },
    successMetrics: { type: [String], required: true },
    safetyMetrics: { type: [String], default: [] },
    channels: { type: [String], default: [] },
    safetyRules: { type: [ExperimentSafetyRuleSchema], default: [] },
    stoppedReason: {
      type: String,
      enum: ['manual', 'safety_breach', 'completed', null],
      default: null,
    },
    breachDetail: { type: ExperimentBreachDetailSchema, default: null },
    lastResultsAt: { type: Date, default: null },
    results: { type: ExperimentResultsSchema, default: null },
    controlAssignments: { type: Number, default: 0 },
    experimentAssignments: { type: Number, default: 0 },
    startedAt: { type: Date },
    stoppedAt: { type: Date },
    createdBy: { type: String, required: true },
  },
  { timestamps: true, collection: 'experiments' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

ExperimentSchema.index({ tenantId: 1, projectId: 1, status: 1 });
ExperimentSchema.index({ tenantId: 1, projectId: 1 });

// Partial unique index: only one running experiment per project at a time.
// DB-level enforcement avoids application-level race conditions.
ExperimentSchema.index(
  { projectId: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'running' },
    name: 'one_running_per_project',
  },
);

// ─── Model ───────────────────────────────────────────────────────────────

export const ExperimentModel =
  mongoose.models['Experiment'] ?? mongoose.model<IExperiment>('Experiment', ExperimentSchema);

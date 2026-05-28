/**
 * EvalEvaluator Model
 *
 * LLM judges and code scorers that evaluate agent performance.
 * Supports structured rubrics, bias mitigation settings, and trajectory metrics.
 */

import mongoose, { Schema, model } from 'mongoose';
import {
  EVAL_DEFAULT_TEMPERATURE,
  EVAL_DEFAULT_VERSION,
  EVAL_TEMPERATURE_MAX,
  EVAL_TEMPERATURE_MIN,
} from '../constants/eval-limits.js';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Sub-document Interfaces ─────────────────────────────────────────────

export interface IScoringRubricPoint {
  value: number;
  label: string;
  criteria: string;
  examples?: string[];
}

export interface IScoringRubric {
  scaleType: '1-5' | 'pass-fail';
  points: IScoringRubricPoint[];
}

export interface IBiasSettings {
  positionSwapEnabled: boolean;
  blindEvaluation: boolean;
  crossModelJudge: boolean;
  evidenceFirstMode: boolean;
}

// ─── Document Interface ──────────────────────────────────────────────────

export interface IEvalEvaluator {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  description?: string;
  type: 'llm_judge' | 'code_scorer' | 'trajectory' | 'human_review';
  category: 'quality' | 'safety' | 'efficiency' | 'empathy' | 'tool_correctness' | 'custom';
  judgeModel?: string;
  judgePrompt?: string;
  chainOfThought: boolean;
  temperature: number;
  scoringRubric?: IScoringRubric;
  biasSettings: IBiasSettings;
  scorerName?: string;
  scorerConfig?: Record<string, unknown>;
  trajectoryMetrics?: (
    | 'milestone_completion'
    | 'handoff_correctness'
    | 'path_efficiency'
    | 'tool_sequence'
  )[];
  humanReviewThreshold?: number;
  isBuiltIn: boolean;
  templateId?: string;
  version: number;
  createdBy: string;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Sub-document Schemas ────────────────────────────────────────────────

const ScoringRubricPointSchema = new Schema(
  {
    value: { type: Number, required: true },
    label: { type: String, required: true },
    criteria: { type: String, required: true },
    examples: [String],
  },
  { _id: false },
);

const ScoringRubricSchema = new Schema(
  {
    scaleType: { type: String, enum: ['1-5', 'pass-fail'], required: true },
    points: { type: [ScoringRubricPointSchema], required: true },
  },
  { _id: false },
);

const BiasSettingsSchema = new Schema(
  {
    positionSwapEnabled: { type: Boolean, default: true },
    blindEvaluation: { type: Boolean, default: true },
    crossModelJudge: { type: Boolean, default: false },
    evidenceFirstMode: { type: Boolean, default: true },
  },
  { _id: false },
);

// ─── Schema ──────────────────────────────────────────────────────────────

const EvalEvaluatorSchema = new Schema<IEvalEvaluator>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    name: { type: String, required: true },
    description: String,
    type: {
      type: String,
      enum: ['llm_judge', 'code_scorer', 'trajectory', 'human_review'],
      required: true,
    },
    category: {
      type: String,
      enum: ['quality', 'safety', 'efficiency', 'empathy', 'tool_correctness', 'custom'],
      default: 'custom',
    },
    judgeModel: String,
    judgePrompt: String,
    chainOfThought: { type: Boolean, default: true },
    temperature: {
      type: Number,
      default: EVAL_DEFAULT_TEMPERATURE,
      min: EVAL_TEMPERATURE_MIN,
      max: EVAL_TEMPERATURE_MAX,
    },
    scoringRubric: ScoringRubricSchema,
    biasSettings: { type: BiasSettingsSchema, default: () => ({}) },
    scorerName: String,
    scorerConfig: { type: Schema.Types.Mixed },
    trajectoryMetrics: [
      {
        type: String,
        enum: ['milestone_completion', 'handoff_correctness', 'path_efficiency', 'tool_sequence'],
      },
    ],
    humanReviewThreshold: Number,
    isBuiltIn: { type: Boolean, default: false },
    templateId: String,
    version: { type: Number, default: EVAL_DEFAULT_VERSION },
    createdBy: { type: String, required: true },
    _v: { type: Number, default: EVAL_DEFAULT_VERSION },
  },
  { timestamps: true, collection: 'eval_evaluators' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

EvalEvaluatorSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

EvalEvaluatorSchema.index({ tenantId: 1, projectId: 1 });
EvalEvaluatorSchema.index({ tenantId: 1, projectId: 1, name: 1 }, { unique: true });
EvalEvaluatorSchema.index({ tenantId: 1, projectId: 1, createdAt: -1, _id: -1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const EvalEvaluator =
  (mongoose.models.EvalEvaluator as mongoose.Model<IEvalEvaluator>) ||
  model<IEvalEvaluator>('EvalEvaluator', EvalEvaluatorSchema);

/**
 * EvalSet Model
 *
 * Combines personas, scenarios, and evaluators into runnable test suites.
 * The Cartesian product (personas x scenarios x evaluators x variants)
 * defines the evaluation matrix.
 */

import mongoose, { Schema, model } from 'mongoose';
import {
  EVAL_DEFAULT_MAX_CONCURRENCY,
  EVAL_DEFAULT_PERSONA_MAX_TOKENS,
  EVAL_DEFAULT_PERSONA_TEMPERATURE,
  EVAL_DEFAULT_VARIANTS,
  EVAL_DEFAULT_VERSION,
  EVAL_MAX_CONCURRENCY_MAX,
  EVAL_MAX_CONCURRENCY_MIN,
  EVAL_VARIANTS_MAX,
  EVAL_VARIANTS_MIN,
} from '../constants/eval-limits.js';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IEvalSet {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  description?: string;
  personaIds: string[];
  scenarioIds: string[];
  evaluatorIds: string[];
  variants: number;
  maxConcurrency: number;
  regressionThreshold?: number;
  baselineRunId?: string;
  ciEnabled: boolean;
  estimatedCostPerRun?: number;
  personaModel?: string | null;
  personaModelConfig?: {
    temperature?: number;
    maxTokens?: number;
  };
  _personaNames?: Record<string, string>;
  _scenarioNames?: Record<string, string>;
  _evaluatorNames?: Record<string, string>;
  createdBy: string;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const EvalSetSchema = new Schema<IEvalSet>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    name: { type: String, required: true },
    description: String,
    personaIds: { type: [String], default: [] },
    scenarioIds: { type: [String], default: [] },
    evaluatorIds: { type: [String], default: [] },
    variants: {
      type: Number,
      default: EVAL_DEFAULT_VARIANTS,
      min: EVAL_VARIANTS_MIN,
      max: EVAL_VARIANTS_MAX,
    },
    maxConcurrency: {
      type: Number,
      default: EVAL_DEFAULT_MAX_CONCURRENCY,
      min: EVAL_MAX_CONCURRENCY_MIN,
      max: EVAL_MAX_CONCURRENCY_MAX,
    },
    regressionThreshold: Number,
    baselineRunId: String,
    ciEnabled: { type: Boolean, default: false },
    estimatedCostPerRun: Number,
    personaModel: { type: String, default: null },
    personaModelConfig: {
      type: new Schema(
        {
          temperature: { type: Number, default: EVAL_DEFAULT_PERSONA_TEMPERATURE },
          maxTokens: { type: Number, default: EVAL_DEFAULT_PERSONA_MAX_TOKENS },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
    _personaNames: { type: Schema.Types.Mixed },
    _scenarioNames: { type: Schema.Types.Mixed },
    _evaluatorNames: { type: Schema.Types.Mixed },
    createdBy: { type: String, required: true },
    _v: { type: Number, default: EVAL_DEFAULT_VERSION },
  },
  { timestamps: true, collection: 'eval_sets' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

EvalSetSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

EvalSetSchema.index({ tenantId: 1, projectId: 1 });
EvalSetSchema.index({ tenantId: 1, projectId: 1, name: 1 }, { unique: true });
EvalSetSchema.index({ tenantId: 1, projectId: 1, createdAt: -1, _id: -1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const EvalSet =
  (mongoose.models.EvalSet as mongoose.Model<IEvalSet>) ||
  model<IEvalSet>('EvalSet', EvalSetSchema);

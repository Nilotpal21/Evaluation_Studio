/**
 * EvalHumanReview Model
 *
 * Tracks human review requests for low-confidence LLM judge scores.
 * When an evaluator's confidence drops below its humanReviewThreshold,
 * a review record is created for human override.
 */

import mongoose, { Schema, model } from 'mongoose';
import { EVAL_DEFAULT_VERSION } from '../constants/eval-limits.js';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IEvalHumanReview {
  _id: string;
  tenantId: string;
  projectId: string;
  runId: string;
  evaluatorId: string;
  personaId: string;
  scenarioId: string;
  variantIndex: number;
  llmScore: number;
  llmReasoning: string;
  llmConfidence: number;
  humanScore?: number;
  humanReasoning?: string;
  reviewedBy?: string;
  reviewedAt?: Date;
  status: 'pending' | 'reviewed' | 'dismissed';
  _v: number;
  createdAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const EvalHumanReviewSchema = new Schema<IEvalHumanReview>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    runId: { type: String, required: true },
    evaluatorId: { type: String, required: true },
    personaId: { type: String, required: true },
    scenarioId: { type: String, required: true },
    variantIndex: { type: Number, required: true },
    llmScore: { type: Number, required: true },
    llmReasoning: { type: String, required: true },
    llmConfidence: { type: Number, required: true },
    humanScore: Number,
    humanReasoning: String,
    reviewedBy: String,
    reviewedAt: Date,
    status: {
      type: String,
      enum: ['pending', 'reviewed', 'dismissed'],
      default: 'pending',
    },
    _v: { type: Number, default: EVAL_DEFAULT_VERSION },
  },
  { timestamps: true, collection: 'eval_human_reviews' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

EvalHumanReviewSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

EvalHumanReviewSchema.index({ tenantId: 1, projectId: 1, status: 1 });
EvalHumanReviewSchema.index({ tenantId: 1, runId: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const EvalHumanReview =
  (mongoose.models.EvalHumanReview as mongoose.Model<IEvalHumanReview>) ||
  model<IEvalHumanReview>('EvalHumanReview', EvalHumanReviewSchema);

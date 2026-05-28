/**
 * EvalScenario Model
 *
 * Conversation flows to test against agents. Defines multi-turn interactions
 * with expected outcomes, milestones, and agent handoff paths.
 */

import mongoose, { Schema, model } from 'mongoose';
import {
  EVAL_DEFAULT_MAX_TURNS,
  EVAL_DEFAULT_VERSION,
  EVAL_MAX_TURNS_MAX,
  EVAL_MAX_TURNS_MIN,
} from '../constants/eval-limits.js';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import {
  scrubEvalDefinitionPii,
  scrubEvalDefinitionUpdateIfEnabled,
  shouldScrubEvalDefinitionsForTenant,
} from '../eval-pii-scrubber.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IEvalScenario {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  description?: string;
  category?: string;
  difficulty: 'easy' | 'medium' | 'hard';
  entryAgent?: string;
  initialMessage?: string;
  expectedOutcome?: string;
  maxTurns: number;
  tags: string[];
  agentPath: string[];
  expectedMilestones: string[];
  maxToolCalls?: number;
  version: number;
  createdBy: string;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const EvalScenarioSchema = new Schema<IEvalScenario>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    name: { type: String, required: true },
    description: String,
    category: String,
    difficulty: {
      type: String,
      enum: ['easy', 'medium', 'hard'],
      default: 'medium',
    },
    entryAgent: String,
    initialMessage: String,
    expectedOutcome: String,
    maxTurns: {
      type: Number,
      default: EVAL_DEFAULT_MAX_TURNS,
      min: EVAL_MAX_TURNS_MIN,
      max: EVAL_MAX_TURNS_MAX,
    },
    tags: { type: [String], default: [] },
    agentPath: { type: [String], default: [] },
    expectedMilestones: { type: [String], default: [] },
    maxToolCalls: Number,
    version: { type: Number, default: EVAL_DEFAULT_VERSION },
    createdBy: { type: String, required: true },
    _v: { type: Number, default: EVAL_DEFAULT_VERSION },
  },
  { timestamps: true, collection: 'eval_scenarios' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

EvalScenarioSchema.plugin(tenantIsolationPlugin);

EvalScenarioSchema.pre('validate', async function scrubInitialMessageOnValidate() {
  if (
    typeof this.initialMessage === 'string' &&
    (this.isNew || this.isModified('initialMessage')) &&
    (await shouldScrubEvalDefinitionsForTenant(this.tenantId))
  ) {
    this.initialMessage = scrubEvalDefinitionPii(this.initialMessage);
  }
});

EvalScenarioSchema.pre('findOneAndUpdate', async function scrubInitialMessageOnUpdate() {
  await scrubEvalDefinitionUpdateIfEnabled(this, 'initialMessage');
});

// ─── Indexes ─────────────────────────────────────────────────────────────

EvalScenarioSchema.index({ tenantId: 1, projectId: 1 });
EvalScenarioSchema.index({ tenantId: 1, projectId: 1, name: 1 }, { unique: true });
EvalScenarioSchema.index({ tenantId: 1, projectId: 1, createdAt: -1, _id: -1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const EvalScenario =
  (mongoose.models.EvalScenario as mongoose.Model<IEvalScenario>) ||
  model<IEvalScenario>('EvalScenario', EvalScenarioSchema);

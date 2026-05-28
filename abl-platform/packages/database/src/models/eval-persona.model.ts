/**
 * EvalPersona Model
 *
 * Simulated users that exercise agents with diverse behaviors.
 * Personas define communication styles, domain knowledge, and behavior traits
 * for evaluation conversations.
 */

import mongoose, { Schema, model } from 'mongoose';
import { EVAL_DEFAULT_VERSION } from '../constants/eval-limits.js';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import {
  scrubEvalDefinitionPii,
  scrubEvalDefinitionUpdateIfEnabled,
  shouldScrubEvalDefinitionsForTenant,
} from '../eval-pii-scrubber.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IEvalPersona {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  description?: string;
  communicationStyle: 'casual' | 'formal' | 'technical' | 'terse' | 'verbose';
  domainKnowledge: 'beginner' | 'intermediate' | 'expert';
  behaviorTraits: string[];
  goals: string;
  constraints: string;
  sessionVariables?: Record<string, unknown>;
  systemPrompt?: string;
  source: 'ai-generated' | 'custom' | 'template' | 'adversarial';
  templateId?: string;
  version: number;
  isAdversarial: boolean;
  adversarialType?:
    | 'prompt_injection'
    | 'social_engineering'
    | 'off_topic'
    | 'abusive'
    | 'edge_case';
  isBuiltIn: boolean;
  createdBy: string;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const EvalPersonaSchema = new Schema<IEvalPersona>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    name: { type: String, required: true },
    description: String,
    communicationStyle: {
      type: String,
      enum: ['casual', 'formal', 'technical', 'terse', 'verbose'],
      default: 'casual',
    },
    domainKnowledge: {
      type: String,
      enum: ['beginner', 'intermediate', 'expert'],
      default: 'intermediate',
    },
    behaviorTraits: { type: [String], default: [] },
    goals: { type: String, default: '' },
    constraints: { type: String, default: '' },
    sessionVariables: { type: Schema.Types.Mixed, default: undefined },
    systemPrompt: String,
    source: {
      type: String,
      enum: ['ai-generated', 'custom', 'template', 'adversarial'],
      default: 'custom',
    },
    templateId: String,
    version: { type: Number, default: EVAL_DEFAULT_VERSION },
    isAdversarial: { type: Boolean, default: false },
    adversarialType: {
      type: String,
      enum: ['prompt_injection', 'social_engineering', 'off_topic', 'abusive', 'edge_case'],
    },
    isBuiltIn: { type: Boolean, default: false },
    createdBy: { type: String, required: true },
    _v: { type: Number, default: EVAL_DEFAULT_VERSION },
  },
  { timestamps: true, collection: 'eval_personas' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

EvalPersonaSchema.plugin(tenantIsolationPlugin);

EvalPersonaSchema.pre('validate', async function scrubSystemPromptOnValidate() {
  if (
    typeof this.systemPrompt === 'string' &&
    (this.isNew || this.isModified('systemPrompt')) &&
    (await shouldScrubEvalDefinitionsForTenant(this.tenantId))
  ) {
    this.systemPrompt = scrubEvalDefinitionPii(this.systemPrompt);
  }
});

EvalPersonaSchema.pre('findOneAndUpdate', async function scrubSystemPromptOnUpdate() {
  await scrubEvalDefinitionUpdateIfEnabled(this, 'systemPrompt');
});

// ─── Indexes ─────────────────────────────────────────────────────────────

EvalPersonaSchema.index({ tenantId: 1, projectId: 1 });
EvalPersonaSchema.index({ tenantId: 1, projectId: 1, name: 1 }, { unique: true });
EvalPersonaSchema.index({ tenantId: 1, projectId: 1, isBuiltIn: 1 });
EvalPersonaSchema.index({ tenantId: 1, projectId: 1, communicationStyle: 1 });
EvalPersonaSchema.index({ tenantId: 1, projectId: 1, createdAt: -1, _id: -1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const EvalPersona =
  (mongoose.models.EvalPersona as mongoose.Model<IEvalPersona>) ||
  model<IEvalPersona>('EvalPersona', EvalPersonaSchema);

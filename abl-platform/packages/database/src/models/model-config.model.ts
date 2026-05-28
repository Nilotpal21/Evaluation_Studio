/**
 * Model Config Model
 *
 * Stores LLM model configurations for projects.
 * Includes provider settings, cost tracking, capability flags, and tiering.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IModelConfig {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  modelId: string;
  provider: string;
  credentialId: string | null;
  /** Auth profile ID — reserved for future project-level credential overrides. Currently credentials resolve via tenantModelId → TenantModel → connection.authProfileId. */
  authProfileId: string | null;
  tenantModelId: string | null;
  temperature: number;
  maxTokens: number;
  topP: number;
  frequencyPenalty: number;
  presencePenalty: number;
  hyperParameters: Record<string, unknown> | null;
  inputCostPer1k: number | null;
  outputCostPer1k: number | null;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  /** OpenAI only: null = inherit from TenantModel/registry, true/false = project-level override */
  useResponsesApi: boolean | null;
  /** null = inherit from TenantModel, true/false = project-level streaming override */
  useStreaming: boolean | null;
  contextWindow: number;
  tier: string;
  isDefault: boolean;
  priority: number;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ModelConfigSchema = new Schema<IModelConfig>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    name: { type: String, required: true },
    modelId: { type: String, required: true },
    provider: { type: String, required: true },
    credentialId: { type: String, default: null },
    authProfileId: { type: String, default: null },
    tenantModelId: { type: String, default: null },
    temperature: { type: Number, required: true },
    maxTokens: { type: Number, required: true },
    topP: { type: Number, required: true },
    frequencyPenalty: { type: Number, required: true },
    presencePenalty: { type: Number, required: true },
    hyperParameters: { type: Schema.Types.Mixed, default: null },
    inputCostPer1k: { type: Number, default: null },
    outputCostPer1k: { type: Number, default: null },
    supportsTools: { type: Boolean, required: true },
    supportsVision: { type: Boolean, required: true },
    supportsStreaming: { type: Boolean, required: true },
    useResponsesApi: { type: Boolean, default: null },
    useStreaming: { type: Boolean, default: null },
    contextWindow: { type: Number, required: true },
    tier: { type: String, required: true },
    isDefault: { type: Boolean, required: true },
    priority: { type: Number, required: true },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'model_configs' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────
ModelConfigSchema.index({ tenantId: 1, projectId: 1, name: 1 }, { unique: true });
ModelConfigSchema.index({ tenantId: 1, projectId: 1 });
ModelConfigSchema.index({ tier: 1 });
// Hot-path: model-resolution Level 2 — resolve agent override by modelId
ModelConfigSchema.index({ tenantId: 1, projectId: 1, modelId: 1 });
// Hot-path: model-resolution Level 3 — default model for tier
ModelConfigSchema.index({ tenantId: 1, projectId: 1, tier: 1, isDefault: 1 });
// Hot-path: find default model without tier filter (isDefault queries averaged 831ms without this)
ModelConfigSchema.index({ tenantId: 1, projectId: 1, isDefault: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const ModelConfig =
  (mongoose.models.ModelConfig as any) || model<IModelConfig>('ModelConfig', ModelConfigSchema);

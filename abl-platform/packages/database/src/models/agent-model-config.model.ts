/**
 * Agent Model Config Model
 *
 * Stores per-agent LLM model overrides within a project.
 * Allows agents to use different models or parameters than the project default.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IAgentModelConfig {
  _id: string;
  tenantId: string;
  projectId: string;
  agentName: string;
  defaultModel: string | null;
  operationModels: any;
  temperature: number | null;
  maxTokens: number | null;
  /** Flexible parameter bag for all hyperparameters (topP, frequencyPenalty, etc.) */
  hyperParameters: Record<string, unknown> | null;
  /** OpenAI only: override for Responses API vs Chat Completions */
  useResponsesApi: boolean | null;
  /** null = inherit, true = force streaming, false = force non-streaming */
  useStreaming: boolean | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const AgentModelConfigSchema = new Schema<IAgentModelConfig>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    agentName: { type: String, required: true },
    defaultModel: { type: String, default: null },
    operationModels: { type: Schema.Types.Mixed, default: null },
    temperature: { type: Number, default: null },
    maxTokens: { type: Number, default: null },
    hyperParameters: { type: Schema.Types.Mixed, default: null },
    useResponsesApi: { type: Boolean, default: null },
    useStreaming: { type: Boolean, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'agent_model_configs' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

AgentModelConfigSchema.index({ tenantId: 1, projectId: 1, agentName: 1 }, { unique: true });
AgentModelConfigSchema.index({ tenantId: 1, projectId: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const AgentModelConfig =
  (mongoose.models.AgentModelConfig as any) ||
  model<IAgentModelConfig>('AgentModelConfig', AgentModelConfigSchema);

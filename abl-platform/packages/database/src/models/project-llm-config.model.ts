/**
 * Project LLM Config Model
 *
 * Stores project-level LLM settings, starting with the opt-in operation routing map.
 * One document per project. Empty or absent routing means the normal
 * project/workspace default model chain is used.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IProjectLLMConfig {
  _id: string;
  tenantId: string;
  projectId: string;
  /** Explicit operation routing map (e.g. { extraction: 'fast', reasoning: 'powerful' }) */
  operationTierOverrides: Map<string, string> | Record<string, string>;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ProjectLLMConfigSchema = new Schema<IProjectLLMConfig>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    operationTierOverrides: { type: Map, of: String, default: new Map() },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'project_llm_configs' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ProjectLLMConfigSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

ProjectLLMConfigSchema.index({ tenantId: 1, projectId: 1 }, { unique: true });

// ─── Model ───────────────────────────────────────────────────────────────

export const ProjectLLMConfig =
  (mongoose.models.ProjectLLMConfig as mongoose.Model<IProjectLLMConfig>) ||
  model<IProjectLLMConfig>('ProjectLLMConfig', ProjectLLMConfigSchema);

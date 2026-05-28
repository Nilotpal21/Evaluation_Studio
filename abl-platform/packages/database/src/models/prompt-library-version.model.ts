/**
 * Prompt Library Version Model
 *
 * Stores versioned snapshots of prompt templates.
 * Each version is immutable once created; promote changes status to 'active'.
 */

import crypto from 'node:crypto';
import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Compute a deterministic hash for a prompt template and its variables.
 * Variables are sorted before hashing to ensure order-independence.
 */
export function computeSourceHash(template: string, variables: string[]): string {
  return crypto
    .createHash('sha256')
    .update(template + JSON.stringify([...variables].sort()))
    .digest('hex');
}

// ─── Document Interface ──────────────────────────────────────────────────

export type PromptLibraryVersionStatus = 'draft' | 'active' | 'archived';

export interface IPromptLibraryVersion {
  _id: string;
  tenantId: string;
  projectId: string;
  promptId: string;
  versionNumber: number;
  template: string;
  variables: string[];
  description?: string;
  status: PromptLibraryVersionStatus;
  sourceHash: string;
  metadata?: Record<string, unknown>;
  createdBy: string;
  createdAt: Date;
  publishedAt?: Date;
  publishedBy?: string;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const PromptLibraryVersionSchema = new Schema<IPromptLibraryVersion>(
  {
    _id: { type: String, default: () => 'plv_' + uuidv7() },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    promptId: { type: String, required: true },
    versionNumber: { type: Number, required: true },
    template: { type: String, required: true, maxlength: 32768 },
    variables: { type: [String], default: [] },
    description: { type: String, maxlength: 512 },
    status: { type: String, enum: ['draft', 'active', 'archived'], default: 'draft' },
    sourceHash: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed, default: null },
    createdBy: { type: String, required: true },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: String, default: null },
  },
  { timestamps: true, collection: 'prompt_library_versions' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

PromptLibraryVersionSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

PromptLibraryVersionSchema.index(
  { tenantId: 1, projectId: 1, promptId: 1, versionNumber: 1 },
  { unique: true },
);
PromptLibraryVersionSchema.index({ tenantId: 1, projectId: 1, promptId: 1, status: 1 });
PromptLibraryVersionSchema.index({ tenantId: 1, projectId: 1, sourceHash: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const PromptLibraryVersion =
  (mongoose.models.PromptLibraryVersion as any) ||
  model<IPromptLibraryVersion>('PromptLibraryVersion', PromptLibraryVersionSchema);
